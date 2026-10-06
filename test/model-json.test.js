import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModel } from '../src/core/model.js';
import { loadConfig } from '../src/config/index.js';
import { dailyItemErrors } from '../src/research/writing.js';

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

test('exhausted structured repair retains both failures and reports a specific non-retryable error', async t => {
  const invalid = { ...item, claims: [{ sentence: '正文没有这句话。', refs: [{ cardId: 'C99', locatorId: 'L1', quote: 'invented' }] }] };
  const f = fixture(t, [JSON.stringify(invalid), JSON.stringify(invalid)]);
  const errors = value => dailyItemErrors(value, assigned, cards);
  await assert.rejects(f.model.json({ prompt: 'JSON', validate: value => !errors(value).length, validationErrors: errors }), error => {
    assert.equal(error.code, 'MODEL_JSON_INVALID'); assert.equal(error.retryable, false);
    assert.match(error.message, /claims\[0\]\.sentence/); assert.match(error.message, /refs\[0\]/); return true;
  });
  assert.equal(f.requests.length, 2);
  const diagnostic = JSON.parse(fs.readFileSync(path.join(f.dir, 'model-json-failures', fs.readdirSync(path.join(f.dir, 'model-json-failures'))[0])));
  assert.equal(diagnostic.failures.length, 2);
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
