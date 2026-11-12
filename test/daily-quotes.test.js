import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDailyQuoteCatalog, resolveDailyQuoteReferences } from '../src/research/quotes.js';
import { originalQuote } from '../src/research/evidence.js';
import { dailyItemErrors, writeDailyDraft } from '../src/research/writing.js';
import { createModel, structuredJsonRetryable } from '../src/core/model.js';
import { loadConfig } from '../src/config/index.js';

const table = '|  | CSI 300 | S&P 500\nSetting | Method | AR ↑ | MDD ↓ | SR ↑ | AR ↑ | MDD ↓ | SR ↑\nMarket Index Reference | 17.69 | 15.66 | 0.97 | 20.76 | 18.90 | 1.26\nTradeGrad | 27.99 | 12.19 | 1.63 | 6.05 | 3.93 | 1.07';
const cards = [{ id: 'C2', figures: [], claims: [], locators: [
  { id: 'L8', type: 'paragraph', text: 'A different description of the optimization method.' },
  { id: 'L13', type: 'paragraph', text: 'TradeGrad evaluates strategies across multiple calendar-year windows. The gate uses τ_0 and η_k=η_large.' },
  { id: 'L49', type: 'table', text: table },
] }];
const assigned = { cardId: 'C2', heading: '交易策略优化', importance: 'lead', targetChars: 900, evidenceCardIds: ['C2'] };
const base = { cardId: 'C2', heading: assigned.heading, importance: 'lead', figureIds: [], claims: [], body: '' };

test('excerpt catalog retains contiguous literal source bytes, table columns and Unicode without mutating cards', () => {
  const before = structuredClone(cards), catalog = createDailyQuoteCatalog(cards);
  assert.deepEqual(cards, before);
  assert.deepEqual(createDailyQuoteCatalog(cards).cards, catalog.cards);
  for (const locator of catalog.cards[0].locators) {
    const original = cards[0].locators.find(value => value.id === locator.id);
    assert.equal(locator.excerpts.map(value => value.quote).join(''), original.text);
    for (const excerpt of locator.excerpts) {
      const ref = catalog.byId.get(excerpt.excerptId);
      assert.equal(ref.locatorId, original.id);
      assert.equal(originalQuote(original.text, excerpt.quote), excerpt.quote.trim());
    }
  }
  assert.equal(catalog.byId.get('C2/L49/Q2').quote, table.split('\n')[1] + '\n');
  assert.ok(catalog.byId.get('C2/L13/Q2').quote.includes('τ_0 and η_k=η_large'));
});

test('table claims select separate market header, metric header and row; missing market numbers still fail', () => {
  const catalog = createDailyQuoteCatalog(cards), sentence = '沪深300指数基准的年化收益、最大回撤和夏普比率分别为17.69、15.66和0.97。';
  const response = { ...base, body: sentence, claims: [{ sentence, refs: ['C2/L49/Q1', 'C2/L49/Q2', 'C2/L49/Q3'].map(excerptId => ({ excerptId })) }] };
  const before = structuredClone(response), resolved = resolveDailyQuoteReferences(response, catalog);
  assert.deepEqual(response, before); assert.deepEqual(resolved.errors, []);
  assert.deepEqual(dailyItemErrors(resolved.item, assigned, cards), []);
  assert.equal(resolved.item.claims[0].refs[2].quote, table.split('\n')[2] + '\n');
  response.claims[0].refs = [{ excerptId: 'C2/L49/Q3' }];
  assert.ok(dailyItemErrors(resolveDailyQuoteReferences(response, catalog).item, assigned, cards).some(error => /缺失numbers=.*300/.test(error)));
});

test('unknown, foreign and overridden IDs fail; canonical legacy quotes keep their exact validation', () => {
  const catalog = createDailyQuoteCatalog(cards), sentence = '该方法按日历年评估策略。';
  for (const ref of [{ excerptId: 'C2/L8/Q99' }, { excerptId: 'C3/L13/Q1' },
    { excerptId: 'C2/L13/Q1', quote: 'invented' }, { excerptId: 'C2/L13/Q1', locatorId: 'L8' }]) {
    const response = { ...base, body: sentence, claims: [{ sentence, refs: [ref] }] };
    assert.ok(resolveDailyQuoteReferences(response, catalog).errors.length);
  }
  const legacy = { ...base, body: sentence, claims: [{ sentence, refs: [{ cardId: 'C2', locatorId: 'L8', quote: cards[0].locators[1].text }] }] };
  const resolved = resolveDailyQuoteReferences(legacy, catalog);
  assert.deepEqual(resolved.item, legacy);
  assert.ok(dailyItemErrors(resolved.item, assigned, cards).some(error => /引用不存在/.test(error)));
});

test('writer resolves IDs before validation and caching, and receives only its own semantic repair requirements', async () => {
  const sentence = '该方法按日历年评估策略。', checkpoint = { correctionCount: 1 };
  const previousDraft = { title: '交易策略研究', intro: '以下讨论优化方法。', items: [{ ...base, body: sentence }] };
  const args = { phase: 'repairWriting', run: { input: '研究分享' }, context: {}, cards, config: { model: {} }, checkpoint,
    persist: () => {}, previousDraft, repair: ['C2：补明市场基准。', 'C4：补明预测验证集。'], model: { json: async request => {
      assert.equal(request.role, 'writer');
      assert.match(request.prompt, /C2：补明市场基准/); assert.doesNotMatch(request.prompt, /C4：补明预测验证集/);
      assert.match(request.prompt, /refs每项只返回excerptId/);
      assert.equal(request.maxAttempts, 3);
      const response = { ...base, body: sentence, claims: [{ sentence, refs: [{ excerptId: 'C2/L13/Q1' }] }] };
      assert.equal(request.validate(response), true); assert.deepEqual(request.validationErrors(response), []);
      return response;
    } } };
  const first = await writeDailyDraft(args);
  assert.deepEqual(first.draft.items[0].claims[0].refs[0], { cardId: 'C2', locatorId: 'L13', quote: 'TradeGrad evaluates strategies across multiple calendar-year windows. ' });
  args.model.json = async () => { throw new Error('Resume must reuse the canonical item'); };
  assert.deepEqual(await writeDailyDraft(args), first); assert.equal(checkpoint.correctionCount, 1);
});

test('the existing two-response adapter corrects a wrong ID without transcribing a new quote', async () => {
  const sentence = '该方法按日历年评估策略。', catalog = createDailyQuoteCatalog(cards), requests = [];
  const response = id => ({ ...base, body: sentence, claims: [{ sentence, refs: [{ excerptId: id }] }] });
  const model = createModel(loadConfig({ DEEPSEEK_API_KEY: 'fixture-key' }), { fetchFn: async (_url, request) => {
    requests.push(JSON.parse(request.body));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response(requests.length === 1 ? 'C2/L13/Q99' : 'C2/L13/Q1')) } }] });
  } });
  const errors = value => { const resolved = resolveDailyQuoteReferences(value, catalog); return [...resolved.errors, ...dailyItemErrors(resolved.item, assigned, cards)]; };
  const result = await model.json({ prompt: '按原文目录选择引用编号。', validate: value => !errors(value).length, validationErrors: errors });
  assert.equal(result.claims[0].refs[0].excerptId, 'C2/L13/Q1'); assert.equal(requests.length, 2);
  assert.match(requests[1].messages[1].content, /excerptId超出范围/);
  assert.match(requests[1].messages[1].content, /C2\/L13\/Q1/);
  assert.doesNotMatch(requests[1].messages[1].content, /从该定位块逐字重取/);
});

test('an out-of-range excerpt id reports the real range and leaves quote grounding unchanged', () => {
  const catalog = createDailyQuoteCatalog(cards), sentence = '该方法按日历年评估策略。';
  const response = { ...base, body: sentence, claims: [{ sentence, refs: [{ excerptId: 'C2/L13/Q9' }] }] };
  const resolved = resolveDailyQuoteReferences(response, catalog);
  assert.match(resolved.errors[0], /excerptId超出范围：C2\/L13\/Q9/);
  assert.match(resolved.errors[0], /有效编号为C2\/L13\/Q1、C2\/L13\/Q2/);
  const errors = [...resolved.errors, ...dailyItemErrors(resolved.item, assigned, cards, { catalog })];
  assert.equal(errors.some(error => /不是原文摘录|quote必须为字符串/.test(error)), false);
  assert.ok(errors.some(error => /引用编号未能解析/.test(error)));
  const grounded = { ...base, body: sentence, claims: [{ sentence, refs: [{ cardId: 'C2', locatorId: 'L13', quote: 'TradeGrad evaluates strategies across multiple calendar-year windows. ' }] }] };
  assert.deepEqual(dailyItemErrors(grounded, assigned, cards, { catalog }), []);
  grounded.claims[0].refs[0].quote = 'TradeGrad evaluates invented calendar-year windows.';
  assert.ok(dailyItemErrors(grounded, assigned, cards, { catalog }).some(error => /不是原文摘录/.test(error)));
});

function overCitedFixture() {
  const fillers = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'].map(name => `${name} vendor tape describes the public market feed.`);
  const sharpe = 'The reported Sharpe ratio is 1.63 on the held-out window.';
  const locators = [...fillers, sharpe].map((text, index) => ({ id: `L${index + 1}`, type: 'paragraph', text }));
  const overCards = [{ id: 'C6', figures: [], claims: [], locators }];
  const catalog = createDailyQuoteCatalog(overCards);
  const ids = locators.map(locator => {
    const excerpts = catalog.cards[0].locators.find(item => item.id === locator.id).excerpts;
    assert.equal(excerpts.length, 1);
    return excerpts[0].excerptId;
  });
  const overAssigned = { cardId: 'C6', heading: '样本外夏普比率', importance: 'medium', targetChars: 450, evidenceCardIds: ['C6'] };
  const overBase = { cardId: 'C6', heading: overAssigned.heading, importance: 'medium', figureIds: [], claims: [], body: '' };
  return { fillers, sharpe, locators, cards: overCards, catalog, ids, assigned: overAssigned, base: overBase,
    sentence: '作者报告样本外夏普比率为1.63。' };
}

test('seven grounded excerpt ids keep the number and do not fail the ref cap', () => {
  const f = overCitedFixture();
  const sentences = ['方法只使用公开行情。', '比较包含基准组合。', '限制写在实验设定中。', f.sentence];
  const response = { ...f.base, body: sentences.join(''), claims: sentences.map((sentence, index) => ({
    sentence, refs: index < 3 ? [{ excerptId: f.ids[0] }] : f.ids.map(excerptId => ({ excerptId })),
  })) };
  const before = structuredClone(response);
  const resolved = resolveDailyQuoteReferences(response, f.catalog);
  assert.deepEqual(response, before);
  assert.deepEqual(resolved.errors, []);
  assert.equal(resolved.item.claims.length, 4);
  assert.equal(resolved.item.claims[0].sentence, sentences[0]);
  assert.deepEqual(resolved.item.claims[0].refs, [{ cardId: 'C6', locatorId: 'L1', quote: f.fillers[0] }]);
  const quotes = resolved.item.claims[3].refs.map(ref => ref.quote);
  assert.equal(quotes.length, 6);
  assert.ok(quotes.some(quote => quote.includes('1.63')));
  assert.equal(quotes.some(quote => quote.startsWith('Zeta')), false);
  assert.deepEqual([...resolved.errors, ...dailyItemErrors(resolved.item, f.assigned, f.cards, { catalog: f.catalog })], []);
});

test('duplicate excerpt ids collapse before the ref cap, and a missing number still fails', () => {
  const f = overCitedFixture();
  const duplicated = { ...f.base, body: f.sentence, claims: [{ sentence: f.sentence, refs: [f.ids[0], f.ids[0], f.ids[1], f.ids[2], f.ids[3], f.ids[4], f.ids[6]].map(excerptId => ({ excerptId })) }] };
  const resolved = resolveDailyQuoteReferences(duplicated, f.catalog);
  assert.equal(resolved.item.claims[0].refs.length, 6);
  assert.ok(resolved.item.claims[0].refs.some(ref => ref.quote.includes('1.63')));
  assert.deepEqual(dailyItemErrors(resolved.item, f.assigned, f.cards, { catalog: f.catalog }), []);
  const missing = { ...f.base, body: '作者报告样本外夏普比率为9.99。', claims: [{ sentence: '作者报告样本外夏普比率为9.99。', refs: f.ids.map(excerptId => ({ excerptId })) }] };
  const missed = resolveDailyQuoteReferences(missing, f.catalog);
  assert.equal(missed.item.claims.length, 1);
  assert.equal(missed.item.claims[0].sentence, missing.claims[0].sentence);
  const errors = [...missed.errors, ...dailyItemErrors(missed.item, f.assigned, f.cards, { catalog: f.catalog })];
  assert.ok(errors.some(error => /缺失numbers=.*9\.99/.test(error)));
  assert.equal(errors.some(error => /refs必须含1–6条引用/.test(error)), false);
});

test('seven excerpts that each ground a distinct number are all kept', () => {
  const markers = [1, 2, 3, 4, 5, 6, 7].map(number => `Isolated result marker equals ${number} in this row only.`);
  const extra = 'Extra context without digits stays available in this note.';
  const locators = [...markers, extra].map((text, index) => ({ id: `L${index + 1}`, type: 'paragraph', text }));
  const markerCards = [{ id: 'C6', figures: [], claims: [], locators }];
  const catalog = createDailyQuoteCatalog(markerCards);
  const ids = locators.map(locator => catalog.cards[0].locators.find(item => item.id === locator.id).excerpts[0].excerptId);
  const sentence = '结果依次为1、2、3、4、5、6、7。';
  const markerAssigned = { cardId: 'C6', heading: '样本外夏普比率', importance: 'medium', targetChars: 450, evidenceCardIds: ['C6'] };
  const response = { cardId: 'C6', heading: markerAssigned.heading, importance: 'medium', figureIds: [], body: sentence,
    claims: [{ sentence, refs: ids.map(excerptId => ({ excerptId })) }] };
  const resolved = resolveDailyQuoteReferences(response, catalog);
  assert.equal(resolved.errors.length, 0);
  assert.equal(resolved.item.claims[0].refs.length, 7);
  assert.equal(resolved.item.claims[0].refs.some(ref => ref.quote === extra), false);
  for (const marker of markers) assert.ok(resolved.item.claims[0].refs.some(ref => ref.quote === marker));
  assert.deepEqual(dailyItemErrors(resolved.item, markerAssigned, markerCards, { catalog }), []);
});

test('an unresolved excerpt id is not replaced, and seven redundant legacy quotes still hit the cap', () => {
  const f = overCitedFixture();
  const refs = f.ids.map(excerptId => ({ excerptId }));
  refs[6] = { excerptId: 'C6/L7/Q99' };
  const response = { ...f.base, body: f.sentence, claims: [{ sentence: f.sentence, refs }] };
  const resolved = resolveDailyQuoteReferences(response, f.catalog);
  assert.equal(resolved.item.claims.length, 1);
  assert.equal(resolved.item.claims[0].sentence, f.sentence);
  assert.ok(resolved.item.claims[0].refs.some(ref => ref.excerptId === 'C6/L7/Q99'));
  assert.ok(resolved.errors.some(error => /Q99/.test(error) && /超出范围/.test(error)));
  const sentence = '该方法按日历年评估策略。';
  const quote = 'TradeGrad evaluates strategies across multiple calendar-year windows. ';
  const legacy = { ...base, body: sentence, claims: [{ sentence, refs: Array.from({ length: 7 }, () => ({ cardId: 'C2', locatorId: 'L13', quote })) }] };
  const errors = dailyItemErrors(legacy, assigned, cards);
  assert.ok(errors.some(error => /refs必须含1–6条引用；当前7条/.test(error)));
  assert.equal(structuredJsonRetryable(errors.filter(error => /refs必须含1–6条引用/.test(error))), true);
});

test('the writer saves a seven-ref claim on the first response and reuses that normalized item', async () => {
  const f = overCitedFixture();
  let calls = 0;
  const checkpoint = {};
  const previous = { ...f.base, body: '方法只使用公开行情。', claims: [{ sentence: '方法只使用公开行情。', refs: [{ cardId: 'C6', locatorId: 'L1', quote: f.fillers[0] }] }] };
  const args = { phase: 'repairWriting', run: { input: '研究分享' }, context: {}, cards: f.cards, config: { model: {} }, checkpoint,
    persist: () => {}, previousDraft: { title: '样本外评估方法', intro: '以下讨论样本外评估。', items: [previous] },
    repair: ['C6：补上夏普比率。'], model: { json: async request => {
      calls += 1;
      assert.equal(request.maxAttempts, 3);
      assert.match(request.prompt, /不要为了条数限制改写整句/);
      assert.doesNotMatch(request.prompt, /拆成多个短句/);
      const response = { ...f.base, body: f.sentence, claims: [{ sentence: f.sentence, refs: f.ids.map(excerptId => ({ excerptId })) }] };
      assert.equal(request.validate(response), true);
      assert.deepEqual(request.validationErrors(response), []);
      return response;
    } } };
  const written = await writeDailyDraft(args);
  assert.equal(calls, 1);
  const refs = written.draft.items[0].claims[0].refs;
  assert.equal(refs.length, 6);
  assert.ok(refs.some(ref => ref.quote.includes('1.63')));
  assert.equal(refs.some(ref => ref.quote.startsWith('Zeta')), false);
  args.model.json = async () => { throw new Error('Resume must reuse the normalized item'); };
  assert.deepEqual(await writeDailyDraft(args), written);
});

test('the structured adapter does not retry a grounded seven-ref claim', async () => {
  const f = overCitedFixture();
  const response = { ...f.base, body: f.sentence, claims: [{ sentence: f.sentence, refs: f.ids.map(excerptId => ({ excerptId })) }] };
  const requests = [];
  const model = createModel(loadConfig({ DEEPSEEK_API_KEY: 'fixture-key' }), { fetchFn: async (_url, request) => {
    requests.push(JSON.parse(request.body));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] });
  } });
  const errors = value => {
    const resolved = resolveDailyQuoteReferences(value, f.catalog);
    return [...resolved.errors, ...dailyItemErrors(resolved.item, f.assigned, f.cards, { catalog: f.catalog })];
  };
  const result = await model.json({ prompt: '按原文目录选择引用编号。', maxAttempts: 3, validate: value => !errors(value).length, validationErrors: errors });
  assert.equal(requests.length, 1);
  assert.equal(result.claims[0].refs.length, 7);
  const resolved = resolveDailyQuoteReferences(result, f.catalog);
  assert.equal(resolved.errors.length, 0);
  assert.ok(resolved.item.claims[0].refs.some(ref => ref.quote.includes('1.63')));
  assert.deepEqual(dailyItemErrors(resolved.item, f.assigned, f.cards, { catalog: f.catalog }), []);
});
