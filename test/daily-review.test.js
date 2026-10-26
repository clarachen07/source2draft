import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAILY_EXPERIMENT_RULES } from '../src/research/evidence.js';
import { buildWholeArticlePrompt, DAILY_REVIEW_POLICY, reviewDailyDraft as reviewIncludingHeader } from '../src/research/review.js';
import { writeDailyDraft } from '../src/research/writing.js';
import { CODEX_JSON_REPAIR_HEADROOM, CODEX_LIMITS, codexCharacterLength, codexPromptBudget, codexStdin } from '../src/core/codex-model.js';

// These legacy tests isolate item-review contracts; global headers have dedicated tests below.
const reviewDailyDraft = args => reviewIncludingHeader({ ...args, model: { json: request =>
  request.prompt.startsWith('只审核整篇标题') ? Promise.resolve({ issues: [], warnings: [] }) : args.model.json(request) } });

function fixture() {
  const context = { issueDate: '2026-10-02', cutoffAt: '2026-10-03T01:00:00Z' };
  const cards = ['C1', 'C2'].map((id, i) => ({ id, title: `Study ${id}`, eventId: `arxiv:2610.0000${i}v2`, url: `https://arxiv.org/abs/2610.0000${i}v2`,
    sourceId: 'arxiv', kind: 'paper', arxiv: { base: `2610.0000${i}`, version: 2 }, eventType: 'paper-revision', temporalStatus: i ? 'supplement' : 'current',
    publishedAt: '2026-09-25T00:00:00Z', updatedAt: '2026-10-02T12:00:00Z', datePrecision: 'instant', figures: [],
    locators: [{ id: 'L1', text: i ? 'Later ranks mean later task arrival, not score ranking.' : 'The agent contains no language model. L1 minus L0 is 0.07; L2 minus L0 is 0.28.' }] }));
  const draft = { title: '研究方法与实践边界', intro: '以下研究关注方法与实践。', items: cards.map(card => ({ cardId: card.id, heading: card.title, body: '作者报告的方法与限制。', importance: 'medium', claims: [], figureIds: [] })) };
  const checkpoint = {}, saved = [], calls = [];
  const args = { draft, cards, context, checkpoint, run: { input: 'LLM与量化日报' }, config: { model: { writerModel: 'chosen-model' } },
    persist: () => saved.push(structuredClone(checkpoint)), model: { json: async request => {
      const id = /^只审核本条事件(C\d+)/.exec(request.prompt)[1]; calls.push(id);
      return { issues: [], warnings: ['原文只支持所述环境中的实验。'] };
    } } };
  return { args, saved, calls };
}

test('review persists completed items across interruption and only sends relevant full source plus rendered dates and links', async () => {
  const f = fixture(), original = f.args.model.json; let fail = true;
  f.args.model.json = async request => {
    const id = /^只审核本条事件(C\d+)/.exec(request.prompt)[1];
    const cards = JSON.parse(/本条相关原文证据卡与完整定位：(.*)\n/.exec(request.prompt)[1]);
    assert.deepEqual(cards.map(card => card.id), [id]); assert.equal(cards[0].locators.length, 1);
    assert.match(request.prompt, /论文版本更新：2026-10-02/); assert.ok(request.prompt.includes(f.args.cards.find(card => card.id === id).url));
    const article = request.prompt.split('本条实际呈现（')[1].split('）：\n')[1].split('\n本条claims映射：')[0];
    assert.doesNotMatch(article, /近期补读|本期|日报|资料截止/);
    assert.equal(article.trim().split('\n').at(-1), f.args.context.issueDate);
    assert.match(request.prompt, /数字能在原文找到并不证明断言正确/); assert.match(request.prompt, /rank若按任务到达顺序/);
    if (id === 'C2' && fail) { fail = false; f.calls.push(id); const error = new Error('temporary'); error.code = 'MODEL_TRANSIENT'; throw error; }
    return original(request);
  };
  await assert.rejects(reviewDailyDraft(f.args), error => error.code === 'MODEL_TRANSIENT');
  assert.deepEqual(Object.values(f.args.checkpoint.reviewPasses).flatMap(pass => Object.keys(pass.items)), ['C1']);
  assert.equal(f.args.checkpoint.correctionCount, undefined);
  const result = await reviewDailyDraft(f.args);
  assert.deepEqual(f.calls, ['C1', 'C2', 'C2']); assert.equal(result.warnings.length, 2);
  await reviewDailyDraft(f.args); assert.deepEqual(f.calls, ['C1', 'C2', 'C2']); assert.equal(f.args.checkpoint.audits.length, 1);
});

test('item review sees its own heading rather than the multi-event issue title', async () => {
  const f = fixture();
  f.args.draft.title = '估值、风险控制交易与宏观预测';
  const original = f.args.model.json;
  f.args.model.json = async request => {
    const id = /^只审核本条事件(C\d+)/.exec(request.prompt)[1];
    const item = f.args.draft.items.find(value => value.cardId === id);
    assert.ok(request.prompt.includes(`title: ${JSON.stringify(item.heading)}`));
    assert.ok(!request.prompt.includes(f.args.draft.title));
    return original(request);
  };
  assert.deepEqual((await reviewDailyDraft(f.args)).issues, []);
});

test('review caches bind current draft, source, input, frozen window, model, policy and correction pass', async () => {
  const f = fixture();
  await reviewDailyDraft(f.args);
  f.args.draft.items[0].body = '作者报告了新的方法与限制。'; await reviewDailyDraft(f.args);
  f.args.cards[0].locators[0].text += ' Additional exact source detail.'; await reviewDailyDraft(f.args);
  f.args.run.input += '保留方法限制'; await reviewDailyDraft(f.args);
  f.args.context.cutoffAt = '2026-10-03T02:00:00Z'; await reviewDailyDraft(f.args);
  f.args.config.model.writerModel = 'changed-model'; await reviewDailyDraft(f.args);
  f.args.checkpoint.correctionCount = 1; await reviewDailyDraft(f.args);
  assert.equal(f.calls.length, 12); assert.equal(f.args.checkpoint.audits.length, 7);
  await reviewDailyDraft(f.args); assert.equal(f.calls.length, 12);
  const latest = Object.values(f.args.checkpoint.reviewPasses).at(-1); latest.items.C1.value.warnings.push('tampered');
  await assert.rejects(reviewDailyDraft(f.args), /断点校验失败/); assert.equal(f.calls.length, 12);
});

test('same-pass draft edits reuse unchanged isolated reviews while binding the aggregate to the current draft', async () => {
  const f = fixture(); f.args.checkpoint.correctionCount = 1;
  const first = await reviewDailyDraft(f.args);
  f.args.draft.items[0].body += ' 新增了已核查的评估条件。';
  const second = await reviewDailyDraft(f.args);
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.deepEqual(f.calls, ['C1', 'C2', 'C1']);
  const latest = Object.values(f.args.checkpoint.reviewPasses).at(-1);
  assert.ok(latest.items.C2.reusedFrom); assert.equal(latest.items.C1.reusedFrom, undefined);
  assert.equal(second.warnings.length, 2); assert.equal(f.args.checkpoint.correctionCount, 1);
});

test('legacy receipts without a context identity are not reused across changed drafts', async () => {
  const f = fixture(); await reviewDailyDraft(f.args);
  delete Object.values(f.args.checkpoint.reviewPasses)[0].contextIdentity;
  f.args.draft.items[0].body += ' 已更新。'; await reviewDailyDraft(f.args);
  assert.deepEqual(f.calls, ['C1', 'C2', 'C1', 'C2']);
});

test('tampered unchanged-item receipts cannot be used to approve a new draft', async () => {
  const f = fixture(); await reviewDailyDraft(f.args);
  Object.values(f.args.checkpoint.reviewPasses)[0].items.C2.value.issues.push({severity: 'high', reason: 'tampered'});
  f.args.draft.items[0].body += ' 已更新。';
  await assert.rejects(reviewDailyDraft(f.args), /断点校验失败/);
  assert.deepEqual(f.calls, ['C1', 'C2', 'C1']);
});

test('reused receipts retain blocking issues instead of granting approval to an unchanged bad item', async () => {
  const f = fixture(); f.args.checkpoint.correctionCount = 1;
  f.args.model.json = async request => {
    const id = /^只审核本条事件(C\d+)/.exec(request.prompt)[1]; f.calls.push(id);
    return { issues: id === 'C2' ? [{severity: 'high', reason: '关键事实未核实'}] : [], warnings: [] };
  };
  await reviewDailyDraft(f.args); f.args.draft.items[0].body += ' 已更新。';
  const result = await reviewDailyDraft(f.args);
  assert.deepEqual(result.issues, [{cardId: 'C2', severity: 'high', reason: '关键事实未核实'}]);
  assert.deepEqual(f.calls, ['C1', 'C2', 'C1']);
});

test('only high semantic facts and grounded warnings are aggregated; style preferences cannot spend a correction', async () => {
  const f = fixture();
  f.args.model.json = async request => /^只审核本条事件C1/.test(request.prompt)
    ? { issues: [{ severity: 'high', reason: 'L1减L0误标为L2减L0' }, { severity: 'low', reason: '小标题偏好' }], warnings: ['原文未评估LLM。'] }
    : { issues: [{ severity: 'medium', reason: '可补充非关键细节' }], warnings: [] };
  const result = await reviewDailyDraft(f.args);
  assert.deepEqual(result.issues, [{ cardId: 'C1', severity: 'high', reason: 'L1减L0误标为L2减L0' }]);
  assert.deepEqual(result.warnings, ['C1：原文未评估LLM。']); assert.equal(f.args.checkpoint.correctionCount, undefined);
});

test('global header review catches unsupported titles, caches unchanged receipts and reuses isolated item reviews on title edits', async () => {
  const f = fixture(), original = f.args.model.json; let headers = 0;
  f.args.model.json = async request => {
    if (!request.prompt.startsWith('只审核整篇标题')) return original(request);
    headers++;
    assert.ok(request.prompt.includes(f.args.cards[0].locators[0].text));
    return { issues: f.args.draft.title.includes('实盘') ? [{ severity: 'high', reason: '标题声称实盘；C1原文仅为合成实验' }] : [], warnings: [] };
  };
  f.args.draft.title = '实盘收益得到验证';
  const first = await reviewIncludingHeader(f.args);
  assert.equal(first.issues[0].scope, 'header');
  await reviewIncludingHeader(f.args); assert.equal(headers, 1);
  f.args.draft.title = '研究方法与实验边界';
  assert.deepEqual((await reviewIncludingHeader(f.args)).issues, []);
  assert.equal(headers, 2); assert.deepEqual(f.calls, ['C1', 'C2']);
});

test('whole-article prompt keeps a short draft verbatim and clips evidence before the draft body', () => {
  const instruction = '只审核整篇标题';
  const payload = { title: '标题', intro: '导语', items: [{ cardId: 'C1', body: '条目正文必须保留。', claims: [{ sentence: '条目正文必须保留。', refs: [{ quote: 'Q'.repeat(500), cardId: 'C1', locatorId: 'L1' }] }] }],
    cards: [{ id: 'C1', locators: [{ id: 'L1', type: 'paragraph', text: 'RAW'.repeat(3000) }], receipt: { raw: 'R'.repeat(3000) }, claims: [{ quote: 'C'.repeat(500), locatorId: 'L1' }] }],
    context: { issueDate: '2026-10-02' } };
  assert.equal(buildWholeArticlePrompt({ instruction, payload, budget: 100000 }), `${instruction}\n${JSON.stringify(payload)}`);
  const tight = buildWholeArticlePrompt({ instruction, payload, budget: 900 });
  assert.ok(tight.includes('条目正文必须保留。'));
  assert.equal(tight.includes('RAWRAW'), false);
  assert.equal(tight.includes('RRRR'), false);
  assert.ok(tight.includes('"textOmitted":true'));
  assert.ok(tight.includes('摘录截断'));
  assert.ok(codexCharacterLength(tight) <= 900);
  assert.equal(payload.cards[0].locators[0].text.startsWith('RAW'), true);
  assert.equal(payload.items[0].claims[0].refs[0].quote, 'Q'.repeat(500));
  assert.throws(() => buildWholeArticlePrompt({ instruction, payload: { ...payload, items: [{ body: '正文'.repeat(500) }] }, budget: 180 }), error => {
    assert.equal(error.code, 'CODEX_INPUT_LIMIT');
    assert.equal(error.retryable, false);
    assert.match(error.message, /不是网络故障/);
    assert.match(error.message, /不会自动重试/);
    return true;
  });
});

test('whole-article review keeps every item body and omits combined raw sources that exceed Codex', async () => {
  const f = fixture();
  const marker = 'UNIQUE_SOURCE_SENTINEL_';
  f.args.cards[0].locators[0].text = marker + 'x'.repeat(600_000);
  f.args.cards[1].locators[0].text = `OTHER_SOURCE_SENTINEL_${'y'.repeat(600_000)}`;
  const original = f.args.model.json;
  let header = '';
  f.args.model.json = async request => {
    if (!request.prompt.startsWith('只审核整篇标题')) return original(request);
    header = request.prompt;
    return { issues: [], warnings: [] };
  };
  const result = await reviewIncludingHeader(f.args);
  assert.deepEqual(result.issues, []);
  for (const item of f.args.draft.items) assert.ok(header.includes(item.body));
  assert.equal(header.includes(marker), false);
  assert.equal(header.includes('y'.repeat(200)), false);
  assert.ok(header.includes('"textOmitted":true'));
  assert.equal(f.args.cards[0].locators[0].text.startsWith(marker), true);
  assert.ok(codexCharacterLength(header) <= codexPromptBudget({ headroom: CODEX_JSON_REPAIR_HEADROOM }));
  assert.ok(codexCharacterLength(codexStdin(header, { responseFormat: { type: 'json_object' } })) <= CODEX_LIMITS.inputChars);
});

test('whole-article review fails clearly when the draft itself still exceeds Codex', async () => {
  const f = fixture();
  f.args.draft.items[0].body = '正文保持'.repeat(300_000);
  f.args.draft.items[1].body = '另一正文'.repeat(300_000);
  let headers = 0, items = 0;
  f.args.model.json = async request => {
    if (request.prompt.startsWith('只审核整篇标题')) headers += 1;
    if (request.prompt.startsWith('只审核本条事件')) items += 1;
    return { issues: [], warnings: [] };
  };
  await assert.rejects(reviewIncludingHeader(f.args), error => {
    assert.equal(error.code, 'CODEX_INPUT_LIMIT');
    assert.equal(error.retryable, false);
    assert.match(error.message, /1048576/);
    assert.match(error.message, /不是网络故障/);
    assert.match(error.message, /不会自动重试/);
    return true;
  });
  assert.equal(headers, 0);
  assert.equal(items, 2);
  assert.deepEqual(Object.keys(Object.values(f.args.checkpoint.reviewPasses)[0].items), ['C1', 'C2']);
});

test('header repair keeps the draft body and drops raw locator dumps above the Codex budget', async () => {
  const quote = 'The authors report an improvement of 12.5 percent on the held-out financial forecasting benchmark.';
  const sentence = '作者报告在留出的金融预测基准上改善12.5 percent。';
  const sentinel = 'UNIQUE_RAW_LOCATOR_';
  const body = `${sentence}这项研究讨论方法与限制。`;
  const cards = [{ id: 'C1', title: 'Study', url: 'https://example.com/study', claims: [],
    locators: [{ id: 'L1', type: 'paragraph', text: `${quote}${sentinel}${'x'.repeat(1_100_000)}` }] }];
  const previousDraft = { title: '研究方法与实践边界', intro: '以下研究关注方法与限制。', items: [{
    cardId: 'C1', heading: '研究方法', importance: 'lead', body, figureIds: [],
    claims: [{ sentence, refs: [{ cardId: 'C1', locatorId: 'L1', quote }] }],
  }] };
  let repairPrompt = '';
  await writeDailyDraft({
    run: { input: 'LLM与量化日报' }, context: { issueDate: '2026-10-02' }, cards,
    config: { model: { writerModel: 'chosen-model' } }, repair: ['HEADER：标题越界'], previousDraft,
    checkpoint: {}, persist: () => {}, progress: () => {},
    model: { json: async request => { repairPrompt = request.prompt; return { title: previousDraft.title, intro: previousDraft.intro }; } },
  });
  assert.ok(repairPrompt.startsWith('只修正标题和导语'));
  assert.ok(repairPrompt.includes(body));
  assert.ok(repairPrompt.includes(quote));
  assert.equal(repairPrompt.includes(sentinel), false);
  assert.equal(repairPrompt.includes('x'.repeat(200)), false);
  assert.ok(codexCharacterLength(codexStdin(repairPrompt, { responseFormat: { type: 'json_object' } })) <= CODEX_LIMITS.inputChars);
});

test('first review sends omissions to warnings; a later pass rechecks earlier findings for that scope', async () => {
  const f = fixture();
  let first = '';
  f.args.model.json = async request => {
    if (request.prompt.startsWith('只审核本条事件C1')) first = request.prompt;
    if (request.prompt.startsWith('只审核整篇标题')) assert.doesNotMatch(request.prompt, /修正后的复核/);
    return { issues: [], warnings: [] };
  };
  await reviewIncludingHeader(f.args);
  assert.match(first, /评估窗口起止日期/);
  assert.match(first, /不要给high/);
  assert.ok(first.includes(DAILY_EXPERIMENT_RULES.slice(0, 24)));
  assert.doesNotMatch(first, /未核实则写本次未核实/);
  assert.doesNotMatch(first, /修正后的复核/);

  const later = fixture();
  later.args.checkpoint.correctionCount = 1;
  later.args.checkpoint.audits = [{
    policy: DAILY_REVIEW_POLICY, fingerprint: 'older-draft', passNumber: 0,
    issues: [
      { cardId: 'C1', severity: 'high', reason: '样本区间未写在结果旁边' },
      { scope: 'header', severity: 'high', reason: '标题声称实盘；C1原文仅为合成实验' },
    ],
    warnings: [],
  }];
  let item = '', header = '';
  later.args.model.json = async request => {
    if (request.prompt.startsWith('只审核整篇标题')) header = request.prompt;
    else if (request.prompt.includes('事件C1')) item = request.prompt;
    return { issues: [], warnings: [] };
  };
  await reviewIncludingHeader(later.args);
  assert.match(item, /修正后的复核/);
  assert.match(item, /样本区间未写在结果旁边/);
  assert.doesNotMatch(item, /标题声称实盘/);
  assert.match(header, /修正后的复核/);
  assert.match(header, /标题声称实盘/);
  assert.match(header, /不要列high/);
});
