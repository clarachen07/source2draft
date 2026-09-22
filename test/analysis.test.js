import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAnalysis, renderCitations, validateArticleLinks } from '../src/workflows/analysis.js';
import { inputUrls, coverUrls } from '../src/core/sources.js';
import { marked } from 'marked';
import { JSDOM } from 'jsdom';
import { createModel } from '../src/core/model.js';
import { loadConfig } from '../src/config/index.js';

function fixture(input, { serious = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-analysis-'));
  const calls = [], queries = [];
  const model = { json: async args => {
    calls.push(args);
    if (args.role === 'planner') return { requirements: input, exclusiveSources: false, clarification: '', queries: [
      { query: '最新原始研究', language: 'zh', recent: true }, { query: 'latest primary research', language: 'en', recent: false },
    ] };
    if (args.role === 'writer') return { title: '个人学习中的验证', body: '这篇文章讨论如何以原始资料验证学习中的观点，而不是只依赖摘要。[S1]' };
    return { issues: serious ? [{ sentence: '', severity: 'high', confidence: 'high', reason: '关键结论缺乏支持', replacement: '' }] : [] };
  } };
  const args = { run: { input, attachments: '[]' }, config: loadConfig({}), workDir: dir, model,
    signal: new AbortController().signal, progress() {},
    read: async () => ({ title: '原始资料', url: 'https://example.org/paper', text: '这是完整的用户提供材料，用于验证观点。' }),
    fetchFn: async (_url, req) => {
      queries.push(JSON.parse(req.body));
      return Response.json({ results: [{ title: '原始研究', url: 'https://example.org/research', text: '研究说明，以原始资料核对观点有助于发现错误。' }] });
    },
  };
  return { args, queries, calls, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
test('analysis runs bilingual research, writes, audits, and builds grounded source list', async () => {
  const f = fixture('研究并写一篇个人学习文章');
  try {
    const result = await runAnalysis(f.args);
    assert.equal(f.queries.length, 2); assert.ok(f.queries[0].startPublishedDate); assert.equal(f.queries[1].startPublishedDate, undefined);
    assert.deepEqual(f.calls.map(c => c.role), ['planner', 'writer', 'review']);
    assert.match(result.article, /参考来源/); assert.match(result.article, /https:\/\/example.org\/research/);
    assert.ok(fs.existsSync(path.join(f.args.workDir, 'research-trace.json')));
  } finally { f.close(); }
});
test('explicit only-source instruction overrides planner search and preserves complete supplied material', async () => {
  const f = fixture('只根据这个链接写一篇学习笔记，不额外搜索：https://example.org/paper');
  try {
    const result = await runAnalysis(f.args);
    assert.equal(f.queries.length, 0); assert.match(result.article, /原始资料/);
    assert.match(f.calls.find(c => c.role === 'writer').prompt, /这是完整的用户提供材料/);
  } finally { f.close(); }
});
test('high-confidence core failure stops before render or upload', async () => {
  const f = fixture('分析主题', { serious: true });
  try { await assert.rejects(runAnalysis(f.args), /关键结论缺乏支持/); } finally { f.close(); }
});
test('user-source read failure cannot be replaced with search results', async () => {
  const f = fixture('根据 https://example.org/paper 写分析');
  f.args.read = async () => { throw new Error('原文读取失败'); };
  try { await assert.rejects(runAnalysis(f.args), /原文读取失败/); assert.equal(f.queries.length, 0); } finally { f.close(); }
});
test('duplicate search hit never replaces the complete user-supplied source with a short excerpt', async () => {
  const f = fixture('根据 https://example.org/paper 写分析');
  f.args.fetchFn = async () => Response.json({ results: [{ title: '搜索摘录', url: 'https://example.org/paper', text: '缩短后的内容' }] });
  try {
    await runAnalysis(f.args);
    const sources = JSON.parse(fs.readFileSync(path.join(f.args.workDir, 'research-trace.json'))).sources;
    assert.equal(sources.length, 1); assert.match(sources[0].text, /完整的用户提供材料/);
  } finally { f.close(); }
});
test('latest followup may explicitly permit research after an earlier source-only requirement', async () => {
  const f = fixture('只根据这个链接写文章：https://example.org/paper\n\n补充指令：\n现在可以联网搜索补充背景');
  try { await runAnalysis(f.args); assert.equal(f.queries.length, 2); } finally { f.close(); }
});

test('source URL extraction retains balanced parentheses and removes only surrounding delimiters', () => {
  const url = 'https://example.org/training-(qat)';
  for (const input of [url, `[资料](${url})`, `(${url})。`, `<${url}|资料>`, `[资料](https://example.org/training-\\(qat\\))`]) {
    assert.deepEqual(inputUrls(input), [url]);
  }
  assert.deepEqual(inputUrls('(https://example.org/a_(b(c)))；'), ['https://example.org/a_(b(c))']);
  assert.deepEqual(inputUrls('资料（https://example.org/paper）。'), ['https://example.org/paper']);
  assert.deepEqual(inputUrls('<https://example.org/?a=1&amp;b=2|资料>'), ['https://example.org/?a=1&b=2']);
});

test('citation rendering preserves literal destinations and treats source titles as text', () => {
  const sources = [
    { id: 'S1', title: '[研究] <tag> ![图](https://unverified.example/img)', url: 'https://example.org/training-(qat)' },
    { id: 'S2', title: '资料', url: 'https://example.org/unbalanced)?a=1&copy=2' },
  ];
  const body = renderCitations('正文[S1][S2]', sources);
  validateArticleLinks(body, sources);
  const dom = new JSDOM(marked.parse(body));
  try {
    assert.deepEqual([...dom.window.document.querySelectorAll('a')].map(a => a.getAttribute('href')), sources.map(s => s.url));
    assert.equal(dom.window.document.querySelectorAll('img, tag').length, 0);
    assert.ok(dom.window.document.body.textContent.includes(sources[0].title));
  } finally { dom.window.close(); }
});

test('link validation matches rendered Markdown, reference links, escaped URLs and HTML entities', () => {
  const sources = [{ url: 'https://example.org/a(qat)?x=1&y=2' }];
  for (const body of [
    '[来源](https://example.org/a\\(qat\\)?x=1&y=2)',
    '[来源][ref]\n\n[ref]: <https://example.org/a(qat)?x=1&y=2>',
    '<a href="https://example.org/a(qat)?x=1&amp;y=2">来源</a>',
    '[来源](https://example.org/a%28qat%29?x=1&y=2)',
  ]) assert.doesNotThrow(() => validateArticleLinks(body, sources));
  for (const body of [
    '[伪造](https://example.org/a(qat)?x=1&y=3)',
    '[伪造][ref]\n\n[ref]: https://unverified.example/paper',
    '<a href="https://unverified.example/paper">来源</a>',
    'https://unverified.example/paper',
    '![图](https://unverified.example/image.png)',
    '[截断](https://example.org/a\\(qat?x=1&y=2)',
  ]) assert.throws(() => validateArticleLinks(body, sources), /未经证据验证/);
});

test('retry resumes a saved draft with parenthesized evidence URL without repeating search or writing', async () => {
  const f = fixture('介绍模型量化');
  try {
    const url = 'https://example.org/training-(qat)';
    fs.writeFileSync(path.join(f.args.workDir, 'research-trace.json'), JSON.stringify({
      userSources: [], plan: { exclusiveSources: false, clarification: '', queries: [] },
      searchResults: [{ results: [{ title: '量化研究', url, text: '原始证据' }] }],
      draft: { title: '量化研究', body: '这是已经完成并持久化的文章，包含可核实的研究结论。[S1]' },
    }));
    const result = await runAnalysis(f.args);
    assert.deepEqual(f.calls.map(c => c.role), ['review']);
    assert.equal(f.queries.length, 0);
    assert.ok(result.article.includes(url));
  } finally { f.close(); }
});

test('ambiguous subject requests clarification before requiring queries or starting research', async () => {
  const f = fixture('LLM＋量化');
  f.args.model = { json: async () => ({ requirements: '领域待确认', exclusiveSources: false,
    clarification: '量化投资还是模型量化？', queries: [] }) };
  try {
    await assert.rejects(runAnalysis(f.args), error => error.needsInput === true && /量化投资/.test(error.message));
    assert.equal(f.queries.length, 0);
  } finally { f.close(); }
});

test('real model JSON validation preserves medium audit ratings as warnings while high-confidence core errors block', async () => {
  for (const [severity, confidence, blocked] of [['low', 'medium', false], ['medium', 'high', false], ['high', 'high', true]]) {
    const f = fixture('分析研究');
    try {
      fs.writeFileSync(path.join(f.args.workDir, 'research-trace.json'), JSON.stringify({
        userSources: [], plan: { exclusiveSources: true, clarification: '', queries: [] }, searchResults: [],
        draft: { title: '已保存的研究', body: '这是已保存的研究正文，恢复时只做复核，不重新写作。' },
      }));
      let requests = 0;
      f.args.model = createModel(loadConfig({ DEEPSEEK_API_KEY: 'test-key' }), { fetchFn: async () => {
        requests++;
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ issues: [
          { sentence: '', severity, confidence, reason: '来源结论需要确认', replacement: '' },
        ] }) } }] });
      } });
      if (blocked) await assert.rejects(runAnalysis(f.args), /需要补充证据/);
      else assert.deepEqual((await runAnalysis(f.args)).warnings, ['来源结论需要确认']);
      assert.equal(requests, 1);
    } finally { f.close(); }
  }
});

function traceAt(f) { return JSON.parse(fs.readFileSync(path.join(f.args.workDir, 'research-trace.json'), 'utf8')); }
function saveTrace(f, trace) { fs.writeFileSync(path.join(f.args.workDir, 'research-trace.json'), JSON.stringify(trace)); }
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

for (const input of [
  '只能使用附件，禁止联网',
  '只能参考给定材料，不允许上网检索',
  '只可根据附件写，禁止搜索',
  'Only use the provided material. Do not browse.',
  '仅根据附件写\n\n补充指令：\n请调整段落结构\n\n补充指令：\n再把标题改短',
  '可以联网搜索\n\n补充指令：\n改为只能使用附件，禁止联网',
]) test(`source-only policy holds across phrasing and followups: ${input.split('\n')[0]}`, async () => {
  const f = fixture(input);
  f.args.run.attachments = JSON.stringify([{ id: 'F1', name: 'note.txt', mimetype: 'text/plain', url: 'https://files.slack.com/file' }]);
  try { await runAnalysis(f.args); assert.equal(f.queries.length, 0); assert.equal(traceAt(f).plan.exclusiveSources, true); }
  finally { f.close(); }
});

test('planner-recognized source restriction is retained when local phrasing is unfamiliar', async () => {
  const f = fixture('文章范围严格限定在附件里面');
  const original = f.args.model.json;
  f.args.model.json = async args => {
    const value = await original(args);
    if (args.role === 'planner') value.exclusiveSources = true;
    return value;
  };
  f.args.run.attachments = JSON.stringify([{ id: 'F1', mimetype: 'text/plain' }]);
  try { await runAnalysis(f.args); assert.equal(f.queries.length, 0); }
  finally { f.close(); }
});

test('old trace with incorrectly enabled research is revalidated against the explicit material restriction', async () => {
  const f = fixture('只能使用附件，禁止联网');
  try {
    saveTrace(f, {
      userSources: [{ title: '附件', text: '附件中的完整事实', kind: 'user' }],
      plan: { exclusiveSources: false, clarification: '', queries: [] },
      searchResults: [{ results: [{ title: '外部内容', text: '不合规的外部材料', url: 'https://example.org/external' }] }],
      draft: { title: '旧成稿', body: '这篇成稿来自不合规的外部搜索，需要丢弃重新生成。[S2]' },
    });
    const result = await runAnalysis(f.args);
    assert.equal(f.queries.length, 0);
    assert.deepEqual(f.calls.map(c => c.role), ['writer', 'review']);
    assert.equal(traceAt(f).sources.length, 1);
    assert.doesNotMatch(result.article, /旧成稿/);
  } finally { f.close(); }
});

test('material reads stop claiming work on failure, await active reads, and resume only missing slots in stable order', async () => {
  const links = Array.from({ length: 5 }, (_, i) => `https://example.org/${i}`);
  const f = fixture(`仅根据以下材料写文章：${links.join(' ')}`);
  const started = [], gates = [deferred(), deferred(), deferred()];
  let active = 0, maximum = 0, finished = false;
  f.args.read = async ({ url }) => {
    const i = Number(url.split('/').at(-1));
    started.push(i); maximum = Math.max(maximum, ++active);
    try {
      if (i === 1) { await nextTurn(); throw new Error('材料 1 暂时失败'); }
      await gates[i].promise;
      return { title: `材料${i}`, url, text: `完整材料 ${i}` };
    } finally { active--; }
  };
  try {
    const pending = runAnalysis(f.args).finally(() => { finished = true; });
    await nextTurn(); await nextTurn();
    assert.deepEqual(started, [0, 1, 2]); assert.equal(maximum, 3); assert.equal(finished, false);
    gates[2].resolve(); await nextTurn();
    assert.deepEqual(traceAt(f).userSourceWork.slots.map(Boolean), [false, false, true, false, false]);
    assert.equal(finished, false);
    gates[0].resolve();
    await assert.rejects(pending, /材料 1 暂时失败/);
    assert.equal(active, 0); assert.deepEqual(started, [0, 1, 2]);
    assert.equal(f.calls.length, 0);
    const resumed = [];
    f.args.read = async ({ url }) => { const i = Number(url.split('/').at(-1)); resumed.push(i); return { title: `材料${i}`, url, text: `完整材料 ${i}` }; };
    await runAnalysis(f.args);
    assert.deepEqual(resumed, [1, 3, 4]);
    assert.deepEqual(traceAt(f).sources.map(s => [s.id, s.title]), links.map((_, i) => [`S${i + 1}`, `材料${i}`]));
  } finally { gates.forEach(g => g.resolve()); f.close(); }
});

test('search uses three workers, retains successful in-flight results, and retries only missing queries', async () => {
  const f = fixture('研究一个主题');
  const queries = Array.from({ length: 5 }, (_, i) => ({ query: `query-${i}`, language: i % 2 ? 'en' : 'zh' }));
  const original = f.args.model.json, started = [], gates = [deferred(), deferred(), deferred()];
  f.args.model.json = async args => { const value = await original(args); if (args.role === 'planner') value.queries = queries; return value; };
  let active = 0, maximum = 0;
  f.args.fetchFn = async (_url, req) => {
    const i = Number(JSON.parse(req.body).query.split('-').at(-1));
    started.push(i); maximum = Math.max(maximum, ++active);
    try {
      if (i === 1) { await nextTurn(); return new Response('', { status: 400 }); }
      await gates[i].promise;
      return Response.json({ results: [{ title: `研究${i}`, url: `https://example.org/${i}`, text: `独立证据 ${i}` }] });
    } finally { active--; }
  };
  try {
    const pending = runAnalysis(f.args);
    await nextTurn(); await nextTurn();
    assert.deepEqual(started, [0, 1, 2]); assert.equal(maximum, 3);
    gates[2].resolve(); await nextTurn(); gates[0].resolve();
    await assert.rejects(pending, /Exa 搜索失败 HTTP 400/);
    assert.equal(active, 0); assert.deepEqual(started, [0, 1, 2]);
    assert.deepEqual(traceAt(f).searchWork.slots.map(Boolean), [true, false, true, false, false]);
    const resumed = [];
    f.args.fetchFn = async (_url, req) => {
      const i = Number(JSON.parse(req.body).query.split('-').at(-1)); resumed.push(i);
      return Response.json({ results: [{ title: `研究${i}`, url: `https://example.org/${i}`, text: `独立证据 ${i}` }] });
    };
    await runAnalysis(f.args);
    assert.deepEqual(resumed, [1, 3, 4]);
    assert.deepEqual(traceAt(f).sources.map(s => [s.id, s.title]), queries.map((_, i) => [`S${i + 1}`, `研究${i}`]));
  } finally { gates.forEach(g => g.resolve()); f.close(); }
});

test('approved audit is reused after restart with stable evidence and preserves warnings', async () => {
  const f = fixture('研究主题'), events = [];
  const original = f.args.model.json;
  f.args.model.json = async args => args.role === 'review'
    ? (f.calls.push(args), { issues: [{ sentence: '', severity: 'low', confidence: 'medium', reason: '保留限定条件', replacement: '' }] })
    : original(args);
  f.args.onTelemetry = event => events.push(event);
  try {
    const first = await runAnalysis(f.args);
    const approved = traceAt(f).approvedReview;
    assert.ok(approved.fingerprint);
    f.calls.length = 0;
    const second = await runAnalysis(f.args);
    assert.deepEqual(second, first); assert.deepEqual(second.warnings, ['保留限定条件']);
    assert.equal(f.calls.length, 0); assert.equal(f.queries.length, 2);
    assert.ok(events.some(event => event.stage === 'review' && event.cacheHit && event.count === 1));
    assert.ok(events.every(event => !Object.hasOwn(event, 'prompt') && !Object.hasOwn(event, 'url') && !Object.hasOwn(event, 'body')));
  } finally { f.close(); }
});

for (const changed of ['input', 'evidence', 'draft', 'model', 'validation version']) test(`approved audit is invalidated by changed ${changed}`, async () => {
  const f = fixture('研究主题');
  try {
    await runAnalysis(f.args);
    const trace = traceAt(f);
    if (changed === 'input') f.args.run.input += '，更强调限制';
    if (changed === 'evidence') trace.searchResults[0].results[0].text += ' 新补充证据。';
    if (changed === 'draft') trace.draft.body += ' 新补充结论。';
    if (changed === 'model') f.args.config.model.effort = 'max';
    if (changed === 'validation version') trace.approvedReview.version = 1;
    saveTrace(f, trace); f.calls.length = 0;
    await runAnalysis(f.args);
    assert.deepEqual(f.calls.map(c => c.role), ['review']);
  } finally { f.close(); }
});

test('failed review never creates a reusable approval and a resumed attempt still blocks', async () => {
  const f = fixture('研究主题', { serious: true });
  try {
    await assert.rejects(runAnalysis(f.args), /关键结论缺乏支持/);
    assert.equal(traceAt(f).approvedReview, undefined);
    f.calls.length = 0;
    await assert.rejects(runAnalysis(f.args), /关键结论缺乏支持/);
    assert.deepEqual(f.calls.map(c => c.role), ['review']);
  } finally { f.close(); }
});

test('local link validation failure cannot be cached as an approved review', async () => {
  const f = fixture('研究主题');
  const original = f.args.model.json;
  f.args.model.json = async args => {
    const result = await original(args);
    if (args.role === 'writer') result.body += '\n[无证据链接](https://unverified.example/report)';
    return result;
  };
  try {
    await assert.rejects(runAnalysis(f.args), /未经证据验证的链接/);
    assert.equal(traceAt(f).approvedReview, undefined);
    f.calls.length = 0;
    await assert.rejects(runAnalysis(f.args), /未经证据验证的链接/);
    assert.deepEqual(f.calls.map(c => c.role), ['review']);
  } finally { f.close(); }
});

test('cancellation prevents cached work from returning as a newly completed analysis', async () => {
  const f = fixture('研究主题');
  try {
    await runAnalysis(f.args);
    f.calls.length = 0;
    f.args.signal = AbortSignal.abort(new Error('用户已取消'));
    await assert.rejects(runAnalysis(f.args), /用户已取消/);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('in-flight source completion is checkpointed on cancellation without moving to planning', async () => {
  const f = fixture('仅根据链接写：https://example.org/paper');
  const controller = new AbortController();
  f.args.signal = controller.signal;
  f.args.read = async () => {
    controller.abort(new Error('用户已取消'));
    return { title: '已取得材料', text: '读取已经完成，但取消后不得继续写作。' };
  };
  try {
    await assert.rejects(runAnalysis(f.args), /用户已取消/);
    assert.equal(f.calls.length, 0);
    assert.equal(traceAt(f).userSourceWork.slots[0].title, '已取得材料');
  } finally { f.close(); }
});


test('an earlier permission cannot lift a planner-recognized restriction in a newer unfamiliar followup', async () => {
  const f = fixture('可以联网搜索\n\n补充指令：\n文章范围严格限定在附件里面');
  const original = f.args.model.json;
  f.args.model.json = async args => {
    const value = await original(args);
    if (args.role === 'planner') value.exclusiveSources = true;
    return value;
  };
  f.args.run.attachments = JSON.stringify([{ id: 'F1', mimetype: 'text/plain' }]);
  try { await runAnalysis(f.args); assert.equal(f.queries.length, 0); }
  finally { f.close(); }
});


test('explicit natural-language cover replacements are excluded from research materials', async () => {
  const f = fixture('根据 https://example.org/paper 写文章\n\n补充指令：\n把封面改成 https://example.org/cover-(new).png');
  const materials = [];
  f.args.read = async ({ url }) => { materials.push(url); return { title: '原文', url, text: '完整的原文材料。' }; };
  try {
    await runAnalysis(f.args);
    assert.deepEqual(materials, ['https://example.org/paper']);
  } finally { f.close(); }
});

test('shared cover URL extraction supports explicit Chinese and English choices and Slack links', () => {
  const url = 'https://example.org/cover-(new).png';
  for (const instruction of [
    `封面：${url}`, `把封面改成 ${url}`, `封面图换成：${url}`, `封面改为 ${url}`,
    `封面换为 ${url}`, `封面改用 ${url}`, `封面换用 ${url}`, `封面使用 ${url}`,
    `封面设为 ${url}`, `封面用 ${url}`, `cover: ${url}`, `cover image to ${url}`,
    `cover(image) use ${url}`, `封面：<${url}|指定封面>`,
  ]) assert.deepEqual(coverUrls(instruction), [url], instruction);
  assert.deepEqual(coverUrls(`封面：${url}\n原文：https://example.org/paper`), [url]);
  assert.deepEqual(coverUrls('请解释如何设计封面。根据 https://example.org/paper 写文章'), []);
});
