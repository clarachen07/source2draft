import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDailyQuoteCatalog, resolveDailyQuoteReferences } from '../src/research/quotes.js';
import { originalQuote } from '../src/research/evidence.js';
import { dailyItemErrors, writeDailyDraft } from '../src/research/writing.js';
import { createModel } from '../src/core/model.js';
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
  assert.match(requests[1].messages[1].content, /excerptId/);
});
