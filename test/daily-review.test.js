import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewDailyDraft } from '../src/research/review.js';

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
  assert.equal(f.calls.length, 14); assert.equal(f.args.checkpoint.audits.length, 7);
  await reviewDailyDraft(f.args); assert.equal(f.calls.length, 14);
  const latest = Object.values(f.args.checkpoint.reviewPasses).at(-1); latest.items.C1.value.warnings.push('tampered');
  await assert.rejects(reviewDailyDraft(f.args), /断点校验失败/); assert.equal(f.calls.length, 14);
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
