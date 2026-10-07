import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyStyleErrors, validateDailyDraft } from '../src/research/evidence.js';
import { dailyItemErrors, writeDailyDraft } from '../src/research/writing.js';

const body = '它保存已评估策略及其回测表现，定期将经验压缩为全局记忆；每轮抽取一组历史策略作比较，由大模型提出修改方向，再以结构性重写或局部代码编辑实现。';
const assigned = { cardId: 'C2', heading: '策略的代码编辑与验证', importance: 'lead', targetChars: 900, evidenceCardIds: ['C2'] };
const cards = [{ id: 'C2', title: 'Strategy optimization', url: 'https://example.org/strategy', summary: '', claims: [], locators: [], figures: [] }];
const item = { cardId: assigned.cardId, heading: assigned.heading, importance: assigned.importance, body, claims: [], figureIds: [] };

test('technical editing terms pass style checks in titles, intro, headings and body', () => {
  for (const text of [body, '文本编辑与编辑器的研究', '编辑距离用于比较字符串。',
    '代码编辑建议由模型生成。', '编辑代码后核对结果。', '编辑器认为代码存在语法错误。',
    '作为编辑工具，该模型仍需评估。', '论文提出新的方法，研究团队发现差异，作者报告结果。']) {
    assert.deepEqual(dailyStyleErrors(text, { title: true }), [], text);
  }
  assert.deepEqual(dailyItemErrors(item, assigned, cards), []);
  assert.deepEqual(validateDailyDraft({ title: '代码编辑与策略优化', intro: '以下讨论文本编辑方法。', items: [item] }, cards, { minimum: 0 }), []);
});

test('narrator roles remain rejected with exact context, including Markdown and technical terms nearby', () => {
  for (const text of ['编辑判断：需要进一步验证。', '编辑建议先核对数据。', '编辑认为结论不充分。',
    '编辑的观点是谨慎验证。', '**编辑**在此提醒：结果仍需核查。', '编辑：建议进行验证。',
    '作为编辑，建议先开展验证。', '笔者建议先核对数据。', '我们建议先开展验证。',
    '小编认为需要谨慎。', '编者按：仍需核验。', '代码编辑完成后，编辑认为策略已验证。']) {
    const errors = dailyStyleErrors(text);
    assert.equal(errors.length, 1, text);
    assert.match(errors[0], /表达主体.*命中表达=.*上下文=/);
  }
  for (const field of ['title', 'intro', 'heading', 'body']) {
    const draft = { title: '策略优化研究', intro: '以下讨论研究方法。', items: [structuredClone(item)] };
    if (['title', 'intro'].includes(field)) draft[field] = '编辑认为需要核查';
    else draft.items[0][field] = '编辑认为需要核查';
    assert.ok(validateDailyDraft(draft, cards, { minimum: 0 }).some(error => /表达主体/.test(error)), field);
  }
});

test('resuming a technical-editing item preserves the frozen outline and does not spend a semantic rewrite', async () => {
  const checkpoint = {}, args = { run: { input: '研究分享' }, context: {}, cards, config: { model: {} }, checkpoint,
    persist: () => {}, model: { json: async request => {
      if (request.role === 'planner') return { title: '代码编辑与策略优化', intro: '以下讨论研究方法。', items: [assigned] };
      assert.equal(request.validate(item), true);
      return item;
    } } };
  const first = await writeDailyDraft(args);
  args.model.json = async () => { throw new Error('A valid cached item must not be regenerated'); };
  assert.deepEqual(await writeDailyDraft(args), first);
  assert.equal(checkpoint.correctionCount, undefined);
});
