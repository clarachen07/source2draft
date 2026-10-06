import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDailyResearch, dailyContext } from '../src/workflows/daily-research.js';
import { normalizeCandidate } from '../src/research/candidates.js';
import { hash, parseArticle } from '../src/lib/io.js';
import { dailyPlainLength, extractEvidenceCard, validateDailyDraft, verifyEvidenceClaims } from '../src/research/evidence.js';
import { DAILY_REVIEW_POLICY } from '../src/research/review.js';

const context = { issueDate: '2026-10-02', scheduledAt: '2026-10-03T00:00:00.000Z', cutoffAt: '2026-10-03T00:00:00.000Z',
  windowStart: '2026-10-02T00:00:00.000Z', supplementStart: '2026-09-26T00:00:00.000Z', isCatchup: false };
const quote = 'The authors report an improvement of 12.5 percent on the held-out financial forecasting benchmark. Transaction costs are not included.';
const sentence = '作者报告在留出的金融预测基准上改善12.5 percent，但未纳入交易成本。';
const prose = '这项研究讨论语言模型如何参与金融预测。读者可以从研究问题、数据构建和评估方式理解其价值。需要先核对训练集和测试集是否按时间划分，再检查基准是否使用相同的信息集。方法能否迁移到实际交易，还取决于输入数据的可用时间、执行方式、交易费用和风险约束。论文报告的是作者实验中的结果，不能直接等同于真实账户的未来收益。实践中应先建立可重复的数据准备流程，保存原始数据和实验参数，再开展小规模的样本外验证。对于尚未披露的设置，应在复现记录中列为待核实事项。读者可根据自身资产类别和研究目标决定是否进一步阅读原文。';

function cardFor(candidate, id) {
  return { id, eventId: candidate.eventId, url: candidate.url, title: candidate.title, sourceId: candidate.sourceId,
    kind: candidate.kind, topic: candidate.topic, publishedAt: candidate.publishedAt, eventAt: candidate.eventAt,
    datePrecision: 'instant', temporalStatus: candidate.supplied ? 'supplied' : 'current', supplied: Boolean(candidate.supplied),
    contentHash: hash(quote), figures: [], locators: [{ id: 'L1', text: quote, type: 'paragraph', page: 2 }], claims: [] };
}

function draft(count) {
  const number = Math.min(count, 4);
  return { title: '语言模型与金融预测研究', intro: '以下研究关注模型方法与金融研究实践，研究结果和可操作判断分别呈现。',
    items: Array.from({ length: number }, (_, index) => ({ cardId: `C${index + 1}`, heading: `金融预测研究${index === 0 ? '主读' : '延伸'}`, importance: index === 0 || count >= 4 && index === 1 ? 'lead' : 'medium',
      body: `${sentence}\n\n${prose.repeat(count >= 4 && index < 2 ? 4 : 2)}`, claims: [{ sentence, refs: [{ cardId: `C${index + 1}`, locatorId: 'L1', quote }] }], figureIds: [] })) };
}

function outline(count) {
  const value = draft(count);
  return { title: value.title, intro: value.intro, items: value.items.map(item => ({ cardId: item.cardId, heading: item.heading,
    importance: item.importance, targetChars: item.importance === 'lead' ? value.items.length >= 4 ? 1200 : 900 : 600, evidenceCardIds: [item.cardId] })) };
}
const assignedItem = args => JSON.parse(/^分配条目：(.*)$/m.exec(args.prompt)[1]);

function fixture(count = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-research-'));
  const stats = { collect: 0, read: 0, extract: 0, outline: 0, writer: 0, review: 0 };
  const candidates = Array.from({ length: count }, (_, index) => normalizeCandidate({ eventId: `event:${index + 1}`, title: `Financial LLM research ${index + 1}`,
    url: `https://www.federalreserve.gov/econres/notes/study-${index + 1}.htm`, publishedAt: '2026-10-02T12:00:00Z', dateVerified: true,
    kind: 'paper', topic: 'paper', official: true, sourceId: 'fed', provider: 'rss' }));
  const model = { json: async args => {
    if (args.role === 'planner') { stats.outline++; return outline(Math.min(count, 12)); }
    if (args.role === 'writer') { stats.writer++; return draft(Math.min(count, 12)).items.find(item => item.cardId === assignedItem(args).cardId); }
    if (args.role === 'review') { stats.review++; return { issues: [], warnings: [] }; }
    throw new Error('unexpected model role');
  } };
  const args = { run: { id: 'issue', thread_key: 'daily:2026-10-02', profile: 'llm-quant-daily', input: '写LLM与量化金融日报', attachments: '[]', context_json: JSON.stringify(context) },
    config: { dataDir: dir, daily: { limits: { maxCandidates: 80, maxDeepReads: 12 } }, model: {} }, store: { wasEventDelivered: () => false }, workDir: path.join(dir, 'runs', 'issue'), model,
    clientFactory: () => ({}),
    collect: async () => { stats.collect++; return { candidates, warnings: [], health: { healthy: true, sections: { papers: true, llm: true, practice: true, finance: true } } }; },
    read: async ({ candidate }) => { stats.read++; return { candidate, title: candidate.title, text: quote, locators: [{ id: 'L1', text: quote }], temporalStatus: candidate.supplied ? 'supplied' : 'current', figures: [], contentHash: hash(quote) }; },
    extract: async ({ document, id }) => { stats.extract++; return cardFor(document.candidate, id); },
  };
  return { dir, args, stats, candidates, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('daily context must already be frozen; malformed dates fail before research', () => {
  assert.throws(() => dailyContext({ context_json: '{}' }), /尚未冻结/);
  assert.deepEqual(dailyContext({ context_json: JSON.stringify(context) }), context);
});

test('pipeline freezes at most twelve deep reads, grounds reported events, and resumes approved artifact without models', async () => {
  const f = fixture(80);
  try {
    const artifact = await runDailyResearch(f.args);
    assert.equal(f.stats.read, 12); assert.equal(f.stats.extract, 12);
    assert.equal(artifact.sourceStats.deepReads, 12); assert.equal(artifact.eventIds.length, 4);
    assert.match(artifact.article, /作者报告/); assert.match(artifact.article, /来源发布日期/);
    assert.equal(parseArticle(artifact.article).title, '语言模型与金融预测研究');
    assert.doesNotMatch(artifact.article, /本期|日报|编辑|笔者|我们|近期补读|资料截止/);
    assert.equal(parseArticle(artifact.article).body.split('\n').at(-1), context.issueDate);
    const before = { ...f.stats };
    await runDailyResearch(f.args); assert.deepEqual(f.stats, before);
  } finally { f.close(); }
});

test('changed review policy rechecks stale failures and approvals without granting another rewrite; current failures still block', async () => {
  const f = fixture(2), original = f.args.model.json;
  let initialIssue = true;
  f.args.model.json = async request => {
    const result = await original(request);
    if (request.role === 'review' && initialIssue) {
      initialIssue = false;
      return { issues: [{ severity: 'high', reason: '需要限定比较范围' }], warnings: [] };
    }
    return result;
  };
  try {
    await runDailyResearch(f.args);
    const filename = path.join(f.args.workDir, 'research-trace.json');
    let trace = JSON.parse(fs.readFileSync(filename));
    assert.equal(trace.correctionCount, 1);
    const fingerprint = trace.approval.fingerprint;
    trace.approval.policy = DAILY_REVIEW_POLICY - 1;
    trace.reviewFailure = { fingerprint, policy: DAILY_REVIEW_POLICY - 1, errors: ['旧版审稿把整期标题误认为单条主张'] };
    trace.reviewPasses = Object.fromEntries(Object.values(trace.reviewPasses).map(pass => {
      pass.policy = DAILY_REVIEW_POLICY - 1;
      return [hash({ policy: pass.policy, passNumber: pass.passNumber, fingerprint: pass.fingerprint }), pass];
    }));
    for (const audit of trace.audits) audit.policy = DAILY_REVIEW_POLICY - 1;
    fs.writeFileSync(filename, JSON.stringify(trace));
    const before = { ...f.stats };
    await runDailyResearch(f.args);
    assert.equal(f.stats.writer, before.writer);
    assert.equal(f.stats.outline, before.outline);
    assert.equal(f.stats.review, before.review + 2);
    trace = JSON.parse(fs.readFileSync(filename));
    assert.equal(trace.correctionCount, 1);
    assert.equal(trace.approval.policy, DAILY_REVIEW_POLICY);
    trace.reviewFailure = { fingerprint, policy: DAILY_REVIEW_POLICY, errors: ['当前版本事实仍未核实'] };
    delete trace.approval;
    fs.writeFileSync(filename, JSON.stringify(trace));
    const current = { ...f.stats };
    await assert.rejects(runDailyResearch(f.args), /当前版本事实仍未核实/);
    assert.deepEqual(f.stats, current);
  } finally { f.close(); }
});

test('only supplied material bypasses collection and accepts an undated original without claiming news freshness', async () => {
  const f = fixture();
  f.args.run.input = '只根据这个链接写，不额外搜索：https://www.federalreserve.gov/econres/notes/original.htm';
  try {
    const artifact = await runDailyResearch(f.args);
    assert.equal(f.stats.collect, 0); assert.equal(f.stats.read, 1); assert.deepEqual(artifact.eventIds, []);
    assert.match(artifact.article, /用户供给材料/);
  } finally { f.close(); }
});

test('empty healthy window creates a short renderable draft; broad source outage cannot masquerade as no news', async () => {
  const f = fixture(0);
  try {
    const artifact = await runDailyResearch(f.args); assert.equal(artifact.noUpdates, true);
    assert.match(parseArticle(artifact.article).body, /尚未找到/); assert.equal(f.stats.writer, 0);
    assert.doesNotMatch(artifact.article, /本期|日报|编辑|近期补读|资料截止/);
    assert.equal(parseArticle(artifact.article).body.split('\n').at(-1), context.issueDate);
    const next = fixture(0); next.args.collect = async () => ({ candidates: [], warnings: [], health: { healthy: false } });
    try { await assert.rejects(runDailyResearch(next.args), error => error.code === 'DAILY_SOURCES_UNAVAILABLE' && error.retryable); }
    finally { next.close(); }
  } finally { f.close(); }
});

test('all readable but ineligible old/undated candidates yield a healthy short draft; network errors fail', async () => {
  const f = fixture();
  f.args.read = async () => { const error = new Error('原文日期未通过本期窗口核验（old）'); error.code = 'DAILY_CANDIDATE_INELIGIBLE'; throw error; };
  try { assert.equal((await runDailyResearch(f.args)).noUpdates, true); assert.equal(f.stats.writer, 0); }
  finally { f.close(); }
  const failed = fixture(); failed.args.read = async () => { throw new Error('network unavailable'); };
  try { await assert.rejects(runDailyResearch(failed.args), error => error.code === 'DAILY_SOURCES_UNAVAILABLE' && error.retryable); }
  finally { failed.close(); }
});

test('temporary model interruption preserves raw documents and resumes remaining frozen evidence slots', async () => {
  const f = fixture(2), initialExtract = f.args.extract; let fail = true;
  f.args.extract = async args => {
    if (args.id === 'C2' && fail) { fail = false; const error = new Error('temporary'); error.code = 'MODEL_TRANSIENT'; throw error; }
    return initialExtract(args);
  };
  try {
    await assert.rejects(runDailyResearch(f.args), error => error.retryable === true);
    const saved = JSON.parse(fs.readFileSync(path.join(f.args.workDir, 'research-trace.json')));
    assert.equal(saved.cards.length, 1); assert.equal(Object.values(saved.documents).some(value => value.factFailure), false);
    const artifact = await runDailyResearch(f.args);
    assert.equal(f.stats.collect, 1); assert.equal(f.stats.read, 2); assert.equal(artifact.evidenceCards.length, 2);
  } finally { f.close(); }
});

test('fact audit grants only one rewrite, then blocks a still unsupported article', async () => {
  const f = fixture();
  f.args.model.json = async args => {
    if (args.role === 'planner') { f.stats.outline++; return outline(1); }
    if (args.role === 'writer') { f.stats.writer++; return draft(1).items[0]; }
    f.stats.review++; return { issues: [{ severity: 'high', reason: '关键结论与原文不符' }] };
  };
  try {
    await assert.rejects(runDailyResearch(f.args), error => error.needsReview && !error.retryable);
    assert.equal(f.stats.writer, 2); assert.equal(f.stats.review, 2);
    await assert.rejects(runDailyResearch(f.args), /关键结论/); assert.equal(f.stats.writer, 2); assert.equal(f.stats.review, 2);
  } finally { f.close(); }
});

test('a legacy repaired draft can narrow an unsupported statement without granting another rewrite after interruption', async () => {
  const f = fixture(), unsupported = '作者另报告收益99%。'; let pause = true;
  f.args.model.json = async args => {
    if (args.role === 'planner') { f.stats.outline++; return outline(1); }
    if (args.role === 'writer') { f.stats.writer++; return draft(1).items[0]; }
    f.stats.review++;
    if (f.stats.review === 2 && pause) { pause = false; throw new Error('review interrupted'); }
    return f.stats.review === 1 ? { issues: [{ severity: 'high', reason: '评估口径需要明确' }] } : { issues: [], warnings: [] };
  };
  try {
    await assert.rejects(runDailyResearch(f.args), /review interrupted/);
    const filename = path.join(f.args.workDir, 'research-trace.json');
    const legacy = JSON.parse(fs.readFileSync(filename));
    assert.equal(legacy.correctionCount, 1);
    // Older versions accepted this item before numerical evidence validation.
    legacy.draft.items[0].body += unsupported;
    legacy.draft.items[0].claims.push({ sentence: unsupported, refs: [{ cardId: 'C1', locatorId: 'L1', quote }] });
    fs.writeFileSync(filename, JSON.stringify(legacy));
    const artifact = await runDailyResearch(f.args);
    const trace = JSON.parse(fs.readFileSync(filename));
    assert.equal(trace.correctionCount, 1); assert.equal(trace.narrowing.removed.length, 1);
    assert.ok(trace.narrowing.before.items[0].body.includes(unsupported)); assert.equal(trace.draft.items[0].body.includes(unsupported), false);
    assert.equal(f.stats.writer, 2); assert.equal(f.stats.outline, 1); assert.equal(f.stats.review, 3);
    assert.equal(artifact.article.includes(unsupported), false);
    const before = { ...f.stats }; await runDailyResearch(f.args); assert.deepEqual(f.stats, before);
  } finally { f.close(); }
});

test('writer schema rejects splitting one evidence card into multiple news items before factual review', async () => {
  const f = fixture(2), originalJson = f.args.model.json;
  f.args.model.json = async args => {
    if (args.role === 'planner') {
      const duplicate = outline(2); duplicate.items[1].cardId = 'C1';
      assert.equal(args.validate(duplicate), false);
      const tooMany = outline(2); tooMany.items.push({ ...tooMany.items[0], cardId: 'C3' });
      assert.equal(args.validate(tooMany), false);
      const unknown = outline(2); unknown.items[1].cardId = 'unknown';
      assert.equal(args.validate(unknown), false);
      assert.equal(args.validate(outline(2)), true);
    }
    return originalJson(args);
  };
  try { assert.equal((await runDailyResearch(f.args)).evidenceCards.length, 2); }
  finally { f.close(); }
});

test('item writer stops at interruption and resumes only missing items after its matching outline and completed item', async () => {
  const f = fixture(4), original = f.args.model.json, attempts = []; let fail = true;
  f.args.model.json = async args => {
    if (args.role === 'writer') {
      const { cardId } = assignedItem(args); attempts.push(cardId);
      if (cardId === 'C2' && fail) { fail = false; const error = new Error('temporary'); error.code = 'MODEL_TRANSIENT'; error.retryable = true; throw error; }
    }
    return original(args);
  };
  try {
    await assert.rejects(runDailyResearch(f.args), error => error.code === 'MODEL_TRANSIENT');
    const saved = JSON.parse(fs.readFileSync(path.join(f.args.workDir, 'research-trace.json')));
    assert.deepEqual(Object.keys(saved.writing.items), ['C1']); assert.equal(saved.draft, undefined);
    assert.deepEqual(attempts, ['C1', 'C2']);
    const artifact = await runDailyResearch(f.args);
    assert.equal(artifact.evidenceCards.length, 4); assert.equal(f.stats.outline, 1); assert.equal(f.stats.read, 4);
    assert.deepEqual(attempts, ['C1', 'C2', 'C2', 'C3', 'C4']);
  } finally { f.close(); }
});

test('a partially completed semantic correction resumes with its spent allowance and never writes later slots early', async () => {
  const f = fixture(2), original = f.args.model.json, repairs = []; let review = 0, fail = true;
  f.args.model.json = async args => {
    if (args.role === 'review') return ++review <= 2 ? { issues: [{ severity: 'high', reason: '明确作者报告的限制' }] } : { issues: [] };
    if (args.role === 'writer' && args.prompt.includes('这是唯一一次修正机会')) {
      const { cardId } = assignedItem(args); repairs.push(cardId);
      if (cardId === 'C2' && fail) { fail = false; const error = new Error('temporary'); error.code = 'MODEL_TRANSIENT'; throw error; }
    }
    return original(args);
  };
  try {
    await assert.rejects(runDailyResearch(f.args), /temporary/);
    const saved = JSON.parse(fs.readFileSync(path.join(f.args.workDir, 'research-trace.json')));
    assert.equal(saved.correctionCount, 1); assert.equal(saved.repairRequest.complete, false);
    assert.deepEqual(Object.keys(saved.repairWriting.items), ['C1']); assert.equal(saved.approval, undefined);
    const artifact = await runDailyResearch(f.args);
    assert.equal(artifact.evidenceCards.length, 2); assert.deepEqual(repairs, ['C1', 'C2', 'C2']); assert.equal(review, 4);
    const final = JSON.parse(fs.readFileSync(path.join(f.args.workDir, 'research-trace.json')));
    assert.equal(final.correctionCount, 1); assert.equal(final.repairRequest.complete, true);
  } finally { f.close(); }
});

test('length failure and semantic high issues are audited together and reach the same single repair', async () => {
  const f = fixture(), original = f.args.model.json; let review = 0, writer = 0;
  f.args.model.json = async args => {
    if (args.role === 'review') return ++review === 1 ? { issues: [{ severity: 'high', reason: '原文已经明确说明判分器，不得声称未披露' }] } : { issues: [] };
    if (args.role === 'writer') {
      writer++;
      if (writer === 1) return { ...draft(1).items[0], body: sentence };
      assert.match(args.prompt, /正文长度/); assert.match(args.prompt, /原文已经明确说明判分器/);
    }
    return original(args);
  };
  try {
    const artifact = await runDailyResearch(f.args);
    assert.equal(artifact.evidenceCards.length, 1); assert.equal(review, 2); assert.equal(writer, 2);
    const saved = JSON.parse(fs.readFileSync(path.join(f.args.workDir, 'research-trace.json')));
    assert.equal(saved.correctionCount, 1);
    assert.ok(saved.repairRequest.errors.some(error => /正文长度/.test(error)));
    assert.ok(saved.repairRequest.errors.some(error => /判分器/.test(error)));
  } finally { f.close(); }
});

test('a semantic repair preserves other items, selection and intro and rechecks the complete draft', async () => {
  const f = fixture(2), original = f.args.model.json, writers = [], reviewed = [];
  let first = true;
  f.args.model.json = async args => {
    if (args.role === 'writer') {
      const id = assignedItem(args).cardId; writers.push(id);
      const item = await original(args);
      // A second request for the valid item would create the reported regression.
      if (id === 'C2' && writers.filter(value => value === id).length > 1) item.body = 'Invalid replacement.';
      return item;
    }
    if (args.role === 'review') {
      const id = /^只审核本条事件(C\d+)/.exec(args.prompt)[1]; reviewed.push(id);
      if (id === 'C1' && first) { first = false; return { issues: [{ severity: 'high', reason: '比较组口径需要明确' }] }; }
    }
    return original(args);
  };
  try {
    await runDailyResearch(f.args);
    const trace = JSON.parse(fs.readFileSync(path.join(f.args.workDir, 'research-trace.json')));
    assert.deepEqual(writers, ['C1', 'C2', 'C1']);
    assert.deepEqual(reviewed, ['C1', 'C2', 'C1', 'C2']);
    assert.equal(f.stats.outline, 1);
    assert.equal(trace.correctionCount, 1);
    assert.equal(trace.repairWriting.items.C2.preserved, true);
    assert.deepEqual(trace.draft.items[1], trace.repairRequest.baseDraft.items[1]);
    assert.equal(trace.draft.title, trace.repairRequest.baseDraft.title);
    assert.equal(trace.draft.intro, trace.repairRequest.baseDraft.intro);
    assert.ok(trace.approval);
    const before = { ...f.stats }; await runDailyResearch(f.args); assert.deepEqual(f.stats, before);
  } finally { f.close(); }
});

test('an unscoped issue repairs all selected items while preserving the outline without another selection', async () => {
  const f = fixture(2), original = f.args.model.json;
  let writers = 0;
  f.args.model.json = async args => {
    const value = await original(args);
    if (args.role === 'writer' && ++writers <= 2) value.body = sentence;
    return value;
  };
  try {
    await runDailyResearch(f.args);
    assert.equal(writers, 4); assert.equal(f.stats.outline, 1);
    const trace = JSON.parse(fs.readFileSync(path.join(f.args.workDir, 'research-trace.json')));
    assert.equal(trace.correctionCount, 1);
    assert.ok(trace.repairRequest.errors.some(error => error.startsWith('正文长度')));
    assert.ok(trace.approval);
  } finally { f.close(); }
});

test('each item enforces its assigned plain-character allowance, including ASCII while excluding Markdown wrappers', async () => {
  const f = fixture(2), original = f.args.model.json; let checked = false;
  f.args.model.json = async args => {
    if (args.role === 'writer' && assignedItem(args).cardId === 'C2') {
      const assigned = assignedItem(args), base = draft(2).items[1], limit = Math.floor(assigned.targetChars * 1.15);
      assert.equal(limit, 690);
      const fit = { ...base, body: `**${'a'.repeat(limit)}**\n\n`, claims: [] };
      assert.equal(dailyPlainLength(fit.body), limit); assert.equal(args.validate(fit), true);
      assert.equal(args.validate({ ...fit, body: `${fit.body}a` }), false);
      assert.match(args.prompt, /上限690字/); checked = true;
    }
    return original(args);
  };
  try { await runDailyResearch(f.args); assert.equal(checked, true); }
  finally { f.close(); }
});

test('semantic review receives complete selected source text even when a fact was absent from curated claims', async () => {
  const f = fixture(5), original = f.args.model.json, extract = f.args.extract, seen = [];
  f.args.extract = async args => {
    const card = await extract(args);
    card.locators.push({ id: 'L2', text: card.id === 'C1' ? 'The semantic judge is GPT-5.4, with temperature 0.' : `Unselected source detail ${card.id}` });
    return card;
  };
  f.args.model.json = async args => {
    if (args.role === 'review') {
      const id = /^只审核本条事件(C\d+)/.exec(args.prompt)[1];
      const source = JSON.parse(/本条相关原文证据卡与完整定位：(.*)\n/.exec(args.prompt)[1]);
      assert.deepEqual(source.map(card => card.id), [id]);
      if (id === 'C1') assert.ok(source[0].locators.some(locator => locator.id === 'L2' && locator.text.includes('GPT-5.4')));
      assert.equal(source[0].claims.length, 0); assert.equal(args.prompt.includes('Unselected source detail C5'), false);
      assert.match(args.prompt, /来源发布日期：2026-10-02/); seen.push(id);
    }
    return original(args);
  };
  try { await runDailyResearch(f.args); assert.deepEqual(seen, ['C1', 'C2', 'C3', 'C4']); }
  finally { f.close(); }
});

test('item cache is invalidated by changed model, previous article, or evidence; only explicit cross cards reach each writer', async () => {
  const f = fixture(4), original = f.args.model.json;
  f.args.model.json = async args => {
    if (args.role === 'planner') {
      const plan = await original(args); plan.items[0].evidenceCardIds.push('C2'); return plan;
    }
    if (args.role === 'writer') {
      const { cardId } = assignedItem(args), received = JSON.parse(/已核实证据卡：(.*)\n/.exec(args.prompt)[1]);
      assert.deepEqual(received.map(card => card.id), cardId === 'C1' ? ['C1', 'C2'] : [cardId]);
      const inventedRef = structuredClone(draft(4).items.find(item => item.cardId === cardId));
      inventedRef.claims[0].refs[0].cardId = cardId === 'C4' ? 'C3' : 'C4';
      assert.equal(args.validate(inventedRef), false);
    }
    return original(args);
  };
  try {
    await runDailyResearch(f.args); assert.equal(f.stats.writer, 4);
    f.args.config.model.maxTokens = 32000;
    await runDailyResearch(f.args); assert.equal(f.stats.writer, 8);
    f.args.previousArticle = '上一修订明确要求保留金融方法与限制。';
    await runDailyResearch(f.args); assert.equal(f.stats.writer, 12);
    const file = path.join(f.args.workDir, 'research-trace.json'), trace = JSON.parse(fs.readFileSync(file));
    trace.cards[0].locators[0].text += ' Further source context remains attached.';
    fs.writeFileSync(file, JSON.stringify(trace));
    await runDailyResearch(f.args); assert.equal(f.stats.writer, 16); assert.equal(f.stats.outline, 4);
    assert.equal(f.stats.collect, 1); assert.equal(f.stats.read, 4);
  } finally { f.close(); }
});

test('card extraction projects editorial fields; model cannot replace verified provenance, locators or licenses', async () => {
  const candidate = normalizeCandidate({ title: 'Financial forecasting', url: 'https://arxiv.org/abs/2609.12345v1', publishedAt: '2026-10-02T12:00:00Z', dateVerified: true,
    hfSubmittedOnDailyAt: '2026-10-02T00:00:00Z', hfRecordPublishedAt: '2026-09-29T20:00:00Z', discoveryPublishedAt: '2026-10-01' });
  const secondQuote = 'The financial evaluation uses a chronological train and test split and excludes transaction costs.';
  const document = { candidate, title: candidate.title, locators: [{ id: 'L1', text: quote, page: 2 }, { id: 'L2', text: secondQuote, page: 3 }], contentHash: 'trusted', temporalStatus: 'current', approvedFigures: [] };
  const model = { json: async () => ({ summary: '作者报告预测改善', importance: 'lead', limitations: [], practice: '进一步样本外验证',
    claims: [{ text: '作者报告改善12.5 percent。', locatorId: 'L1', quote, kind: 'fact' },
      { text: '作者未纳入交易成本。', locatorId: 'L1', quote, kind: 'fact' },
      { text: '评估使用按时间划分的训练与测试集。', locatorId: 'L2', quote: secondQuote, kind: 'fact' }],
    id: 'malicious', url: 'https://evil.example/fake', locators: [{ id: 'fake', text: 'invented' }], supplied: true, figures: ['unauthorized'], licenseUrl: 'https://evil.example/license' }) };
  const card = await extractEvidenceCard({ document, id: 'C1', model });
  assert.equal(card.id, 'C1'); assert.equal(card.url, candidate.url); assert.equal(card.supplied, false);
  assert.equal(card.locators[0].text, quote); assert.deepEqual(card.figures, []); assert.notEqual(card.licenseUrl, 'https://evil.example/license');
  assert.equal(card.hfSubmittedOnDailyAt, '2026-10-02T00:00:00.000Z'); assert.equal(card.hfRecordPublishedAt, '2026-09-29T20:00:00.000Z');
  assert.equal(card.discoveryPublishedAt, '2026-10-01'); assert.equal(card.eventAt, '2026-10-02T12:00:00.000Z');
});

test('failed extraction records only safe deterministic reasons and claim indices', async () => {
  const f = fixture();
  f.args.extract = async () => {
    const error = new Error('证据卡有效定位事实不足（至少3条事实、2个定位块）'); error.code = 'DAILY_EVIDENCE_INVALID';
    error.claimFailures = [{ index: 2, code: 'NUMERIC_MISMATCH', locatorId: 'L4', reason: 'untrusted api_key=do-not-store' }]; throw error;
  };
  try {
    await assert.rejects(runDailyResearch(f.args), error => error.needsReview && !error.retryable);
    const raw = fs.readFileSync(path.join(f.args.workDir, 'research-trace.json'), 'utf8');
    const saved = Object.values(JSON.parse(raw).documents)[0];
    assert.match(saved.reason, /至少3条事实/); assert.equal(saved.claimFailures[0].index, 2);
    assert.equal(saved.claimFailures[0].locatorId, 'L4'); assert.equal(raw.includes('do-not-store'), false);
  } finally { f.close(); }
});

test('numeric claims, injected headings, unapproved images and invented formulas fail deterministic evidence gates', () => {
  const candidate = normalizeCandidate({ title: 'Research', url: 'https://arxiv.org/abs/2609.12345', publishedAt: '2026-10-02T12:00:00Z', dateVerified: true });
  const cards = [cardFor(candidate, 'C1')], value = draft(1);
  assert.deepEqual(validateDailyDraft(value, cards), []);
  for (const title of ['研究分享｜2026-10-02', '研究分享｜2026年10月2日', '研究分享｜10月2日', '研究分享｜第十二期', '研究日报']) {
    assert.ok(validateDailyDraft({ ...value, title }, cards).some(error => /标题/.test(error)), title);
  }
  assert.deepEqual(validateDailyDraft({ ...value, title: 'Qwen3.6与金融预测研究' }, cards), []);
  for (const phrase of ['本期关注模型方法。', '近期补读。', '编辑判断：需要进一步验证。', '笔者建议：先核对数据。', '我们建议先开展验证。']) {
    const styled = structuredClone(value); styled.items[0].body += `\n${phrase}`;
    assert.ok(validateDailyDraft(styled, cards).some(error => /措辞|表达主体/.test(error)), phrase);
  }
  const samplePeriod = structuredClone(value); samplePeriod.items[0].body += '\n论文提出新的方法，实验样本期仍须核查。\n判断：尚不足以证明真实收益。\n建议：先核对数据划分。';
  assert.deepEqual(validateDailyDraft(samplePeriod, cards), []);
  const number = structuredClone(value); number.items[0].claims[0].sentence = number.items[0].body = sentence.replace('12.5', '99.9') + prose.repeat(2);
  assert.ok(validateDailyDraft(number, cards).some(error => /数字|数值/.test(error)));
  const heading = structuredClone(value); heading.items[0].heading = '标题\n\n![图](https://evil.example/private.png)';
  assert.ok(validateDailyDraft(heading, cards).some(error => /标题/.test(error)));
  const image = structuredClone(value); image.items[0].body += '\n![图](research/assets/0123456789abcdef.png)';
  cards[0].figures = [{ localPath: 'research/assets/0123456789abcdef.png' }];
  assert.ok(validateDailyDraft(image, cards).some(error => /figureIds/.test(error)));
  const formula = structuredClone(value); formula.items[0].body += '\n$$\nR = 100\n$$';
  assert.ok(validateDailyDraft(formula, cards).some(error => /公式/.test(error)));
  const inference = structuredClone(value); inference.items[0].body += '\n建议：可用Qwen3.6-35B-A3B做对照。';
  assert.ok(validateDailyDraft(inference, cards).some(error => /逐句证据映射/.test(error)));
  const metadata = structuredClone(value); metadata.items[0].body += '\n该论文为v1版本。';
  assert.ok(validateDailyDraft(metadata, cards).some(error => /逐句证据映射/.test(error)));
  assert.throws(() => verifyEvidenceClaims([{ text: '改善99.9 percent', locatorId: 'L1', quote }], cards[0].locators), /数值/);
});

test('invalid exact evidence stops an injected writer before saving the item, requesting later items or consuming semantic repair', async () => {
  const f = fixture(2), original = f.args.model.json, writers = [];
  f.args.model.json = async args => {
    const value = await original(args);
    if (args.role === 'writer') {
      writers.push(assignedItem(args).cardId);
      value.claims[0].refs[0].quote = 'An invented excerpt that is absent from the source.';
      assert.equal(args.validate(value), false);
      assert.ok(args.validationErrors(value).some(error => /引用不存在或不是原文摘录/.test(error)));
    }
    return value;
  };
  try {
    await assert.rejects(runDailyResearch(f.args), /引用不存在或不是原文摘录/);
    const trace = JSON.parse(fs.readFileSync(path.join(f.args.workDir, 'research-trace.json')));
    assert.deepEqual(writers, ['C1']); assert.deepEqual(trace.writing.items, {});
    assert.equal(f.stats.review, 0); assert.equal(trace.correctionCount, undefined);
    assert.equal(trace.repairRequest, undefined); assert.equal(trace.approval, undefined);
  } finally { f.close(); }
});
