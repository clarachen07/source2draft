import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyPlainLength, numericTokens, auditEvidenceClaims, extractEvidenceCard, validateDailyDraft, narrowDailyDraft } from '../src/research/evidence.js';

test('numeric evidence distinguishes decimal lists and deterministically recognizes small English counts and dated months', () => {
  assert.deepEqual(numericTokens('Prices [0.10,0.90] and liquidity $5,000.'), ['0.10', '0.90', '5000']);
  assert.deepEqual(numericTokens('zero six twenty single August 2026'), ['2026', '0', '6', '20', '1', '8']);
  assert.deepEqual(numericTokens('May increase or march forward; August alone.'), []);
  const audit = auditEvidenceClaims([{ text: '作者覆盖6个领域，采用1轮训练；采用2026年8月价目。', locatorId: 'L1',
    quote: 'The study covers six domains with single epoch training at August 2026 list prices.' }],
  [{ id: 'L1', text: 'The study covers six domains with single epoch training at August 2026 list prices.' }]);
  assert.equal(audit.verified.length, 1); assert.deepEqual(audit.rejected, []);
});

const source = [
  { id: 'L1', text: 'The training dataset contains 265 questions and uses a chronological split.' },
  { id: 'L2', text: 'The main held-out result has Brier score 0.254, with transaction costs excluded.' },
  { id: 'L3', text: 'The policy uses a single training epoch and eight rollouts per question.' },
  { id: 'L4', text: 'The semantic judge is GPT-5.4 and the training requests come from public developer forums.' },
];
const supported = [
  { text: '训练数据包含265个问题。', locatorId: 'L1', quote: source[0].text, kind: 'fact' },
  { text: '作者报告留出结果的Brier为0.254。', locatorId: 'L2', quote: source[1].text, kind: 'fact' },
  { text: '作者未纳入交易成本。', locatorId: 'L2', quote: source[1].text, kind: 'fact' },
];
const bad = [
  { text: '作者采用8次rollout，还报告收益率99%。', locatorId: 'L3', quote: source[2].text, kind: 'fact' },
  { text: '不存在的事实。', locatorId: 'L9', quote: 'There is no such source paragraph.', kind: 'fact' },
];
const document = { title: 'Forecasting research', candidate: { title: 'Forecasting research', eventId: 'study:v1', url: 'https://arxiv.org/abs/2609.12345v1', sourceId: 'arxiv', kind: 'paper' },
  locators: source, temporalStatus: 'current', contentHash: 'trusted', approvedFigures: [] };
const model = claims => ({ json: async () => ({ summary: '无证据的99%收益结论', importance: 'lead', claims, limitations: ['未验证的限制'], practice: '立即买入资产' }) });

const narrowingFixture = (sentences = ['作者报告收益为99%。']) => {
  const card = { ...document.candidate, id: 'C1', locators: source, figures: [] };
  const draft = { title: '研究方法与实践边界', intro: '研究与边界', items: [{ cardId: 'C1', heading: '研究', importance: 'medium',
    body: '这是研究方法、实验条件与局限的说明。'.repeat(24) + sentences.join(''),
    claims: sentences.map(sentence => ({ sentence, refs: [{ cardId: 'C1', locatorId: 'L2', quote: source[1].text }] })) }] };
  return { card, draft };
};
test('narrowing removes an unsupported whole statement without inventing evidence or mutating the original', () => {
  const { card, draft } = narrowingFixture(), before = structuredClone(draft);
  const result = narrowDailyDraft(draft, [card]);
  assert.deepEqual(draft, before); assert.equal(result.removed.length, 1);
  assert.equal(result.draft.items[0].body.includes('99'), false); assert.deepEqual(result.draft.items[0].claims, []);
  assert.deepEqual(validateDailyDraft(result.draft, [card]), []);
  assert.equal(narrowDailyDraft(result.draft, [card]), null);
});
test('narrowing cannot remove too many statements, erase an entire report, or bypass link and size gates', () => {
  for (const sentences of [['作者报告收益为99%。', '作者另报告收益为98%。', '作者还报告收益为97%。']]) {
    const { card, draft } = narrowingFixture(sentences); assert.equal(narrowDailyDraft(draft, [card]), null);
  }
  const { card, draft } = narrowingFixture();
  draft.items[0].body += '[未核验](https://malicious.example/)'; assert.equal(narrowDailyDraft(draft, [card]), null);
  draft.items[0].body = '作者报告收益为99%。'; assert.equal(narrowDailyDraft(draft, [card]), null);
});
test('narrowing preserves supported numbers even when a semantic comparison still needs independent review', () => {
  const { card, draft } = narrowingFixture(['该收益为0.254。']);
  assert.equal(narrowDailyDraft(draft, [card]), null);
});

test('partial cards retain individually verified facts and precise raw locators while excluding failed assertions and editorial inventions', async () => {
  const card = await extractEvidenceCard({ document, id: 'C1', model: model([...supported, ...bad]) });
  assert.equal(card.claims.length, 3); assert.equal(card.claimValidation.partial, true);
  assert.deepEqual(card.claimValidation.rejected.map(failure => [failure.index, failure.code]), [[3, 'NUMERIC_MISMATCH'], [4, 'QUOTE_NOT_FOUND']]);
  assert.ok(card.locators.some(locator => locator.id === 'L3'));
  assert.deepEqual(card.locators, source);
  assert.ok(card.locators.some(locator => locator.id === 'L4' && locator.text.includes('semantic judge')));
  assert.equal(card.claims.some(claim => claim.locatorId === 'L4'), false);
  assert.equal(card.summary.includes('99'), false); assert.equal(card.practice, '');
  assert.equal(JSON.stringify(card).includes('立即买入'), false); assert.equal(JSON.stringify(card).includes('未验证的限制'), false);
});

test('draft and item counters include letters and digits but exclude whitespace and Markdown wrappers', () => {
  const body = '**中 A12**\n\n[文](https://example.com/long-address)';
  assert.equal(dailyPlainLength(body), 5);
  const card = { id: 'C1', eventId: 'e1', url: 'https://example.com/long-address', title: 'Study', locators: [], figures: [] };
  const draft = { title: '研究方法与实践边界', intro: '导语', items: [{ cardId: 'C1', heading: '研究', importance: 'medium', body: '**AA**', claims: [] }] };
  assert.deepEqual(validateDailyDraft(draft, [card], { minimum: 4, maximum: 4 }), []);
  assert.ok(validateDailyDraft(draft, [card], { minimum: 1, maximum: 3 }).some(error => error.startsWith('正文长度4')));
});

test('a card requires three independent checked assertions spanning at least two original blocks', async () => {
  await assert.rejects(extractEvidenceCard({ document, id: 'C1', model: model([...supported.slice(0, 2), ...bad]) }), error => {
    assert.equal(error.code, 'DAILY_EVIDENCE_INVALID'); assert.equal(error.claimFailures[0].index, 2); return true;
  });
  const repeated = supported.map(claim => ({ ...claim, text: '训练集包含265个问题。', locatorId: 'L1', quote: source[0].text }));
  await assert.rejects(extractEvidenceCard({ document, id: 'C1', model: model(repeated) }), /2个定位块/);
});

test('a writer can combine separately quoted blocks; a single quote cannot support a merged numerical assertion', () => {
  const card = { ...document.candidate, id: 'C1', title: document.title, locators: source, figures: [] };
  const sentence = '训练集包含265个问题，作者报告留出集Brier为0.254。';
  const draft = { title: '金融预测研究', intro: '以下研究关注数据划分与预测表现。', items: [{ cardId: 'C1', importance: 'lead', heading: '金融预测研究', body: sentence,
    claims: [{ sentence, refs: [{ cardId: 'C1', locatorId: 'L2', quote: source[1].text }] }], figureIds: [] }] };
  assert.ok(validateDailyDraft(draft, [card], { minimum: 1 }).some(error => /数字/.test(error)));
  draft.items[0].claims[0].refs.push({ cardId: 'C1', locatorId: 'L1', quote: source[0].text });
  assert.deepEqual(validateDailyDraft(draft, [card], { minimum: 1 }), []);
});

test('failed draft diagnostics identify the item, exact sentence, quote locator, missing numbers and formula without unbounded source dumps', () => {
  const card = { ...document.candidate, id: 'C1', title: document.title, locators: source, figures: [] };
  const sentence = '作者报告99个问题；';
  const draft = { title: '研究方法与实践边界', intro: '研究方法', items: [{ cardId: 'C1', heading: '研究', importance: 'lead', body: `${sentence}\n\n成本$0.24对$0.011。`,
    claims: [{ sentence, refs: [{ cardId: 'C1', locatorId: 'L1', quote: `${'x'.repeat(1000)} api_key=do-not-log` }] },
      { sentence: '作者报告99个问题。', refs: [{ cardId: 'C1', locatorId: 'L1', quote: source[0].text }] }], figureIds: [] }] };
  const errors = validateDailyDraft(draft, [card], { minimum: 1 });
  assert.ok(errors.some(error => error.includes('C1') && error.includes('claims[0]') && error.includes('C1/L1') && error.includes('quote=')));
  assert.ok(errors.some(error => error.includes('缺失numbers=') && error.includes('99')));
  assert.ok(errors.some(error => error.includes('claims[1]') && error.includes('逐字匹配body')));
  assert.ok(errors.some(error => error.includes('片段=') && error.includes('美元')));
  assert.ok(errors.every(error => error.length < 800)); assert.equal(errors.join('').includes('do-not-log'), false);
});

test('Unicode minus and ASCII minus are equal numeric evidence without losing the sign or altering quote bytes', () => {
  const quote = 'The median loses -35.1%; with zero fees the median is -0.6%, with 47.8% profitable.';
  const locators = [{ id: 'L14', text: quote }];
  assert.deepEqual(numericTokens('−35.1% −0.6% 3e−05'), ['-35.1', '-0.6', '3e-05']);
  const good = auditEvidenceClaims([{ text: '作者报告中位数为−35.1%，零成本时为−0.6%，盈利占47.8%。', locatorId: 'L14', quote }], locators);
  assert.equal(good.verified.length, 1); assert.equal(good.verified[0].quote, quote);
  for (const text of ['作者报告正收益35.1%。', '作者报告收益−47.8%。']) {
    assert.equal(auditEvidenceClaims([{ text, locatorId: 'L14', quote }], locators).rejected[0].code, 'NUMERIC_MISMATCH');
  }
});
