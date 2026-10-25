import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModel, structuredJsonRetryable } from '../src/core/model.js';
import { loadConfig } from '../src/config/index.js';
import { dailyItemErrors } from '../src/research/writing.js';
import { createDailyQuoteCatalog, resolveDailyQuoteReferences } from '../src/research/quotes.js';

const assigned = { cardId: 'C5', heading: '模型能力的证据边界', importance: 'medium', targetChars: 450 };
const cards = [{ id: 'C5', locators: [{ id: 'L1', text: 'Official benchmark report.' }], figures: [] }];
const item = { ...assigned, body: '作者报告了模型能力，实际用途仍需评估。', claims: [], figureIds: [] };

function fixture(t, outputs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source2draft-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [], events = [];
  const config = loadConfig({ DEEPSEEK_API_KEY: 'fixture-secret-key' });
  const model = createModel(config, { workDir: dir, onTelemetry: event => events.push(event), fetchFn: async (_url, request) => {
    requests.push(JSON.parse(request.body));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: outputs[requests.length - 1] } }] });
  } });
  return { dir, model, requests, events };
}

test('daily item repair receives actual character count and prior response, then accepts corrected content', async t => {
  const long = { ...item, body: 'Gemini benchmark'.repeat(40) };
  const f = fixture(t, [JSON.stringify(long), JSON.stringify(item)]);
  const errors = value => dailyItemErrors(value, assigned, cards);
  assert.deepEqual(await f.model.json({ role: 'writer', prompt: '写本条JSON', validate: value => !errors(value).length, validationErrors: errors }), item);
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[1].messages[1].content, /实际600字符.*上限517/);
  assert.ok(f.requests[1].messages[1].content.includes('Gemini benchmark'));
  const filename = path.join(f.dir, 'model-json-failures', fs.readdirSync(path.join(f.dir, 'model-json-failures'))[0]);
  const diagnostic = JSON.parse(fs.readFileSync(filename));
  assert.equal(diagnostic.failures.length, 1);
  assert.equal(diagnostic.failures[0].response, JSON.stringify(long));
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.equal(f.events.filter(event => event.stage === 'model.validation').length, 1);
});

test('a pure length overrun on the final attempt gets one compress-only repair', async t => {
  const narrow = { ...assigned, targetChars: 400 };
  const fit = { ...narrow, body: '测'.repeat(460), claims: [], figureIds: [] };
  const over = { ...fit, body: '测'.repeat(478) };
  const f = fixture(t, [JSON.stringify(over), JSON.stringify(over), JSON.stringify(over), JSON.stringify(fit)]);
  const errors = value => dailyItemErrors(value, narrow, cards);
  assert.deepEqual(await f.model.json({ role: 'writer', prompt: '写本条JSON', maxAttempts: 3, validate: value => !errors(value).length, validationErrors: errors }), fit);
  assert.equal(f.requests.length, 4);
  const feedback = f.requests[3].messages[1].content;
  assert.match(feedback, /正文实际478字符，超过上限460/);
  assert.match(feedback, /本次只压缩正文，不要新增事实、数字或定位编号，已通过的证据映射保持不变/);
  const diagnostic = JSON.parse(fs.readFileSync(path.join(f.dir, 'model-json-failures', fs.readdirSync(path.join(f.dir, 'model-json-failures'))[0])));
  assert.equal(diagnostic.failures.length, 3);
});

test('a second pure length overrun after the compress repair stops', async t => {
  const narrow = { ...assigned, targetChars: 400 };
  const over = { ...narrow, body: '测'.repeat(478), claims: [], figureIds: [] };
  const f = fixture(t, Array.from({ length: 4 }, () => JSON.stringify(over)));
  const errors = value => dailyItemErrors(value, narrow, cards);
  await assert.rejects(f.model.json({ role: 'writer', prompt: '写本条JSON', maxAttempts: 3, validate: value => !errors(value).length, validationErrors: errors }), error => {
    assert.equal(error.code, 'MODEL_JSON_INVALID');
    assert.equal(error.retryable, false);
    assert.match(error.message, /连续四次/);
    assert.match(error.message, /正文实际478字符，超过上限460/);
    return true;
  });
  assert.equal(f.requests.length, 4);
  assert.match(f.requests[3].messages[1].content, /本次只压缩正文/);
  const diagnostic = JSON.parse(fs.readFileSync(path.join(f.dir, 'model-json-failures', fs.readdirSync(path.join(f.dir, 'model-json-failures'))[0])));
  assert.equal(diagnostic.failures.length, 4);
});

test('a final attempt that is still ungrounded does not gain a compress pass', async t => {
  const narrow = { ...assigned, targetChars: 400 };
  const sentence = '作者报告69次评估。';
  const over = { ...narrow, body: `${'测'.repeat(478)}${sentence}`, claims: [], figureIds: [] };
  const recovered = { ...narrow, body: '测'.repeat(460), claims: [], figureIds: [] };
  const f = fixture(t, [JSON.stringify(over), JSON.stringify(over), JSON.stringify(over), JSON.stringify(recovered)]);
  const errors = value => dailyItemErrors(value, narrow, cards);
  await assert.rejects(f.model.json({ prompt: 'JSON', maxAttempts: 3, validate: value => !errors(value).length, validationErrors: errors }), error => {
    assert.match(error.message, /连续三次/);
    assert.match(error.message, /超过上限/);
    assert.match(error.message, /69/);
    return true;
  });
  assert.equal(f.requests.length, 3);
  const feedback = f.requests[2].messages[1].content;
  assert.equal(feedback.includes('本次只压缩正文'), false);
  assert.ok(feedback.indexOf('缺少逐句证据映射') < feedback.indexOf('超过上限'));
});

test('a body at the inclusive character limit is accepted and an overflow repair names both lengths', async t => {
  const assigned400 = { ...assigned, targetChars: 400 };
  const fit = { ...assigned400, body: '测'.repeat(460), claims: [], figureIds: [] };
  const over = { ...fit, body: `${fit.body}测` };
  assert.deepEqual(dailyItemErrors(fit, assigned400, cards), []);
  const f = fixture(t, [JSON.stringify(over), JSON.stringify(fit)]);
  const errors = value => dailyItemErrors(value, assigned400, cards);
  assert.deepEqual(await f.model.json({ role: 'writer', prompt: '写本条JSON', validate: value => !errors(value).length, validationErrors: errors }), fit);
  assert.equal(f.requests.length, 2);
  const feedback = f.requests[1].messages[1].content;
  assert.match(feedback, /正文实际461字符，超过上限460/);
  assert.match(feedback, /长度等于460可以通过/);
  assert.match(feedback, /字符计数为461，上限为460/);
  assert.match(feedback, /长度等于上限可以通过/);
});

test('exhausted structured repair retains all failures and reports a specific non-retryable error', async t => {
  const invalid = { ...item, claims: [{ sentence: '正文没有这句话。', refs: [{ cardId: 'C99', locatorId: 'L1', quote: 'invented' }] }] };
  const f = fixture(t, [JSON.stringify(invalid), JSON.stringify(invalid), JSON.stringify(invalid)]);
  const errors = value => dailyItemErrors(value, assigned, cards);
  await assert.rejects(f.model.json({ prompt: 'JSON', validate: value => !errors(value).length, validationErrors: errors }), error => {
    assert.equal(error.code, 'MODEL_JSON_INVALID'); assert.equal(error.retryable, false);
    assert.match(error.message, /连续三次/); assert.match(error.message, /claims\[0\]\.sentence/); assert.match(error.message, /refs\[0\]/); return true;
  });
  assert.equal(f.requests.length, 3);
  const diagnostic = JSON.parse(fs.readFileSync(path.join(f.dir, 'model-json-failures', fs.readdirSync(path.join(f.dir, 'model-json-failures'))[0])));
  assert.equal(diagnostic.failures.length, 3);
});

test('JSON syntax diagnostics and repair context redact credentials without storing the original prompt', async t => {
  const raw = '{"token":"fixture-secret-key", access_token=sensitive-value xoxb-fixture-token';
  const f = fixture(t, [raw, '{"ok":true}']);
  await f.model.json({ prompt: 'private-original-prompt JSON', validate: value => value.ok === true });
  const feedback = f.requests[1].messages[1].content;
  assert.match(feedback, /JSON语法|JSON 语法/); assert.doesNotMatch(feedback, /fixture-secret-key|sensitive-value|xoxb-fixture-token/);
  const diagnostic = fs.readFileSync(path.join(f.dir, 'model-json-failures', fs.readdirSync(path.join(f.dir, 'model-json-failures'))[0]), 'utf8');
  assert.doesNotMatch(diagnostic, /fixture-secret-key|sensitive-value|xoxb-fixture-token|private-original-prompt/);
});

test('malformed nested model fields retain the bounded repair even with a legacy validator', async t => {
  const f = fixture(t, ['{"claims":[null]}', '{"claims":[{"text":"有效事实"}]}']);
  const result = await f.model.json({ prompt: 'JSON', validate: value => value.claims.every(claim => typeof claim.text === 'string') });
  assert.equal(result.claims[0].text, '有效事实');
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[1].messages[1].content, /嵌套结构不合格/);
});

test('daily diagnostics handle malformed nested claims without throwing or accepting them', () => {
  for (const value of [null, [], { ...item, body: 3 }, { ...item, claims: [null] }, { ...item, claims: [{ sentence: item.body, refs: [null] }] }]) {
    assert.ok(dailyItemErrors(value, assigned, cards).length);
  }
  assert.deepEqual(dailyItemErrors(item, assigned, cards), []);
});

test('technical code editing does not waste the single JSON correction needed for an invalid quote', async t => {
  const source = 'The model revises strategies through local code edits.';
  const evidence = [{ id: 'C5', locators: [{ id: 'L1', text: source }], figures: [] }];
  const sentence = '大模型通过局部代码编辑修改策略。';
  const invalid = { ...item, body: sentence, claims: [{ sentence, refs: [{ cardId: 'C5', locatorId: 'L1', quote: 'A fabricated code editing result.' }] }] };
  const corrected = structuredClone(invalid); corrected.claims[0].refs[0].quote = source;
  const f = fixture(t, [JSON.stringify(invalid), JSON.stringify(corrected)]);
  const errors = value => dailyItemErrors(value, assigned, evidence);
  assert.deepEqual(await f.model.json({ prompt: '写本条JSON', validate: value => !errors(value).length, validationErrors: errors }), corrected);
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[1].messages[1].content, /引用不存在或不是原文摘录/);
  assert.doesNotMatch(f.requests[1].messages[1].content, /表达主体/);
  assert.equal(corrected.body, sentence);
});

test('persistent narrator roles still stop after three responses and receive actionable style feedback', async t => {
  const invalid = { ...item, body: '编辑认为需要验证，代码编辑本身不足以证明收益。' };
  const f = fixture(t, [JSON.stringify(invalid), JSON.stringify(invalid), JSON.stringify(invalid)]);
  const errors = value => dailyItemErrors(value, assigned, cards);
  await assert.rejects(f.model.json({ prompt: '写本条JSON', validate: value => !errors(value).length, validationErrors: errors }),
    error => error.code === 'MODEL_JSON_INVALID' && error.retryable === false && /命中表达=.*编辑认为/.test(error.message) && /连续三次/.test(error.message));
  assert.equal(f.requests.length, 3);
  assert.match(f.requests[1].messages[1].content, /保留技术术语和研究事实/);
  assert.equal(structuredJsonRetryable(['正文不得带“编辑”“笔者”“我们”等表达主体']), false);
});

test('per-item adapter repair checks exact locator quotes and every numeric sentence before accepting a response', async t => {
  const source = 'We optimize the mean of the lowest 30% of window scores.';
  const evidence = [{ id: 'C5', locators: [{ id: 'L39', text: 'The formula and its coefficients.' }, { id: 'L40', text: source }], figures: [] }];
  const sentence = '作者以最低表现的30%窗口均值为目标。';
  const invalid = { ...item, body: sentence, claims: [{ sentence, refs: [{ cardId: 'C5', locatorId: 'L39', quote: source }] }] };
  const corrected = structuredClone(invalid); corrected.claims[0].refs[0].locatorId = 'L40';
  const f = fixture(t, [JSON.stringify(invalid), JSON.stringify(corrected)]);
  const errors = value => dailyItemErrors(value, assigned, evidence);
  assert.deepEqual(await f.model.json({ prompt: '写本条JSON', validate: value => !errors(value).length, validationErrors: errors }), corrected);
  assert.equal(f.requests.length, 2);
  const feedback = f.requests[1].messages[1].content;
  assert.match(feedback, /引用不存在或不是原文摘录/); assert.match(feedback, /该摘录实际位于.*C5\/L40/);
  assert.match(feedback, /正文数值句缺少逐句证据映射/);
  const missing = { ...corrected, body: `${sentence}作者还报告69次评估。` };
  assert.ok(errors(missing).some(error => error.includes('作者还报告69次评估。')));
  const fabricated = structuredClone(corrected); fabricated.claims[0].refs[0].quote = 'We maximize the mean of the lowest 30% of window scores.';
  assert.ok(errors(fabricated).some(error => /引用不存在或不是原文摘录/.test(error)));
  const noSign = { ...item, body: '作者报告−35.1%收益。', claims: [{ sentence: '作者报告−35.1%收益。', refs: [{ cardId: 'C5', locatorId: 'L40', quote: source }] }] };
  assert.ok(errors(noSign).some(error => /缺失numbers=.*-35.1/.test(error)));
});

test('the sole item correction receives sentence mismatches and short metric citations together without relaxing source gates', async t => {
  const source = 'MAE: Evaluates the mean absolute error, providing a linear penalty for forecast deviations.';
  const evidence = [{ id: 'C5', locators: [{ id: 'L87', text: source }], figures: [] }];
  const sentence = '论文使用MAE评估预测误差。';
  const invalid = { ...item, body: sentence, claims: [
    { sentence: '正文不存在的句子。', refs: [{ cardId: 'C5', locatorId: 'L87', quote: source }] },
    { sentence, refs: [{ cardId: 'C5', locatorId: 'L87', quote: 'MAE:' }] },
  ] };
  const corrected = { ...invalid, claims: [{ sentence, refs: [{ cardId: 'C5', locatorId: 'L87', quote: source }] }] };
  const f = fixture(t, [JSON.stringify(invalid), JSON.stringify(corrected)]);
  const errors = value => dailyItemErrors(value, assigned, evidence);
  const firstErrors = errors(invalid);
  assert.ok(firstErrors.some(error => /claims\[0\]\.sentence/.test(error)));
  assert.ok(firstErrors.some(error => /claims\[1\].*原文摘录过短.*至少8字符/.test(error)));
  assert.deepEqual(await f.model.json({ prompt: '写本条JSON', validate: value => !errors(value).length, validationErrors: errors }), corrected);
  assert.equal(f.requests.length, 2);
  const feedback = f.requests[1].messages[1].content;
  assert.match(feedback, /claims\[0\]\.sentence/);
  assert.match(feedback, /原文摘录过短.*至少8字符/);
  assert.ok(feedback.includes(source.slice(0, 70)));
  const fabricated = structuredClone(corrected); fabricated.claims[0].refs[0].quote = 'MAE: Evaluates profitable trading strategies.';
  assert.ok(errors(fabricated).some(error => /不是原文摘录/.test(error)));
});

test('FinQA repair feedback names the valid excerpt and exact AUROC tokens without accepting a rounded number', async t => {
  const finqa = [{ id: 'C5', figures: [], locators: [
    { id: 'L2', text: 'The baseline FinQA accuracy is 0.61 on the public split.' },
    { id: 'L8', text: 'On FinQA the model reaches an AUROC of 0.872 and an F1 of 0.91.' },
  ] }];
  const catalog = createDailyQuoteCatalog(finqa);
  const sentence = '作者报告FinQA的AUROC为0.872，F1为0.91。';
  const finAssigned = { cardId: 'C5', heading: 'FinQA评测', importance: 'medium', targetChars: 450, evidenceCardIds: ['C5'] };
  const baseItem = { cardId: 'C5', heading: finAssigned.heading, importance: 'medium', figureIds: [], body: sentence, claims: [] };
  const wrong = { ...baseItem, claims: [{ sentence, refs: [{ excerptId: 'C5/L8/Q9' }, { excerptId: 'C5/L2/Q1' }] }] };
  const rightId = [...catalog.byId.keys()].find(id => id.startsWith('C5/L8/Q'));
  const corrected = { ...baseItem, claims: [{ sentence, refs: [{ excerptId: rightId }] }] };
  const errors = value => {
    const resolved = resolveDailyQuoteReferences(value, catalog);
    return [...resolved.errors, ...dailyItemErrors(resolved.item, finAssigned, finqa, { catalog })];
  };
  const first = errors(wrong);
  assert.ok(first.some(error => /C5\/L8\/Q9/.test(error) && /有效编号为C5\/L8\/Q1/.test(error)));
  assert.equal(first.some(error => /不是原文摘录|quote必须为字符串/.test(error)), false);
  assert.ok(first.some(error => /缺失numbers=.*0\.872/.test(error) && /候选摘录=.*C5\/L8\/Q1/.test(error) && /已引用摘录中的numbers=/.test(error)));
  assert.ok(first.every(error => error.length < 800));
  const f = fixture(t, [JSON.stringify(wrong), JSON.stringify(corrected)]);
  assert.deepEqual(await f.model.json({ prompt: '写本条JSON', maxAttempts: 3, validate: value => !errors(value).length, validationErrors: errors }), corrected);
  assert.equal(f.requests.length, 2);
  const feedback = f.requests[1].messages[1].content;
  assert.match(feedback, /excerptId超出范围/);
  assert.match(feedback, /0\.872不能写成0\.87或87\.2%/);
  assert.match(feedback, /候选摘录=/);
  assert.doesNotMatch(feedback, /从该定位块逐字重取/);
  const rounded = { ...baseItem, body: '作者报告FinQA的AUROC为0.87，F1为0.91。', claims: [{ sentence: '作者报告FinQA的AUROC为0.87，F1为0.91。', refs: [{ excerptId: rightId }] }] };
  assert.ok(errors(rounded).some(error => /缺失numbers=.*0\.87/.test(error)));
  assert.ok(errors(rounded).some(error => /提供的证据摘录中不存在这些数字/.test(error)));
  const punctuation = { ...baseItem, claims: [{ sentence: '作者报告FinQA的AUROC为0.872，F1为0.91；', refs: [{ excerptId: rightId }] }] };
  const punctuationErrors = errors(punctuation);
  assert.ok(punctuationErrors.some(error => /最接近正文=/.test(error) && /相同前缀后正文为/.test(error)));
  assert.equal(structuredJsonRetryable(punctuationErrors), true);
});

test('exhausted in-catalog citation misses stay retryable, while invented numbers and broken quotes do not', async t => {
  const finqa = [{ id: 'C5', figures: [], locators: [
    { id: 'L2', text: 'The baseline FinQA accuracy is 0.61 on the public split.' },
    { id: 'L8', text: 'On FinQA the model reaches an AUROC of 0.872 and an F1 of 0.91.' },
  ] }];
  const catalog = createDailyQuoteCatalog(finqa);
  const sentence = '作者报告FinQA的AUROC为0.872，F1为0.91。';
  const finAssigned = { cardId: 'C5', heading: 'FinQA评测', importance: 'medium', targetChars: 450, evidenceCardIds: ['C5'] };
  const wrong = { cardId: 'C5', heading: finAssigned.heading, importance: 'medium', figureIds: [], body: sentence,
    claims: [{ sentence, refs: [{ excerptId: 'C5/L2/Q1' }] }] };
  const errors = value => {
    const resolved = resolveDailyQuoteReferences(value, catalog);
    return [...resolved.errors, ...dailyItemErrors(resolved.item, finAssigned, finqa, { catalog })];
  };
  assert.equal(structuredJsonRetryable(errors(wrong)), true);
  const missed = fixture(t, [JSON.stringify(wrong), JSON.stringify(wrong), JSON.stringify(wrong)]);
  await assert.rejects(missed.model.json({ prompt: '写本条JSON', maxAttempts: 3, validate: value => !errors(value).length, validationErrors: errors }), error => {
    assert.equal(error.code, 'MODEL_JSON_INVALID'); assert.equal(error.retryable, true);
    assert.match(error.message, /连续三次/); assert.match(error.message, /0\.872/); return true;
  });
  assert.equal(missed.requests.length, 3);
  const diagnostic = JSON.parse(fs.readFileSync(path.join(missed.dir, 'model-json-failures', fs.readdirSync(path.join(missed.dir, 'model-json-failures'))[0])));
  assert.equal(diagnostic.failures.length, 3);
  const invented = { ...wrong, body: '作者报告FinQA的AUROC为0.999。', claims: [{ sentence: '作者报告FinQA的AUROC为0.999。', refs: [{ excerptId: 'C5/L8/Q1' }] }] };
  assert.equal(structuredJsonRetryable(errors(invented)), false);
  assert.ok(errors(invented).some(error => /不存在这些数字：.*0\.999/.test(error)));
  const syntax = fixture(t, ['{', '{', '{']);
  await assert.rejects(syntax.model.json({ prompt: 'JSON', validate: value => value.ok === true }), error => error.code === 'MODEL_JSON_INVALID' && error.retryable === true);
  assert.equal(structuredJsonRetryable(['字段、类型或取值未通过任务校验。']), false);
});
