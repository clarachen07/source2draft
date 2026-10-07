import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { translateDocument, splitLongTranslationUnits } from '../src/workflows/translation-inference.js';
import { assessTranslationUnit } from '../src/workflows/translation-validation.js';
import { translationNeedsReview } from '../src/workflows/translation-review.js';
import { readJson } from '../src/lib/io.js';

function fixture(t, texts) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-quality-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  return { workDir, model: 'gpt-6-luna', writer: { modelIdentity: { model: 'gpt-6-luna', effort: 'high' } },
    source: { title: 'Methods', sha256: 'source-fixture', sourceUrl: 'https://example.org/study', sourceType: 'html',
      blocks: texts.map((text, i) => ({ id: `b${i}`, type: 'paragraph', text, order: i })) } };
}
const payload = request => JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n') + 1));
const reply = (units, translate) => JSON.stringify({ translations: units.map(unit => ({ id: unit.id,
  text: unit.id === 'meta:title' ? '研究方法' : translate(unit) })) });
const goodReview = request => JSON.stringify({ reviews: payload(request).units.map(unit => ({ id: unit.id, issues: [] })) });

for (const sample of [
  { name: 'negation', source: 'This result does not prove safety.', bad: '该结果证明了安全性。', correct: '该结果并不能证明安全性。', quote: 'does not prove safety' },
  { name: 'negation', label: 'contracted negation', source: "This isn't evidence of safety.", bad: '这是安全性的证据。', correct: '这并不是安全性的证据。', quote: "isn't evidence" },
  { name: 'attribution', source: 'Model A scores 80; Model B scores 20.', bad: '模型 A 得分 20，模型 B 得分 80。', correct: '模型 A 得分 80，模型 B 得分 20。', quote: 'Model A scores 80' },
  { name: 'omission', source: 'Only synthetic data were used. The test measures forecasting. Trading was not evaluated.',
    bad: '仅使用合成数据。测试衡量预测。', correct: '仅使用合成数据。测试衡量预测。未评估交易。', quote: 'Trading was not evaluated' },
  { name: 'terminology', source: 'Only inference was evaluated.', bad: '仅评估了训练。', correct: '仅评估了推理。', quote: 'inference' },
]) test(`grounded semantic ${sample.label || sample.name} issues repair only the affected block and bind the final approval`, async t => {
  const f = fixture(t, [sample.source, 'Background description.']);
  const phases = []; let corrected = false;
  const completeArticle = async request => {
    phases.push(request.inferenceContext.phase);
    if (request.inferenceContext.phase === 'review') {
      const { units, context } = payload(request);
      assert.ok(context.find(item => item.id === 'b0').neighbors.some(item => item.id === 'b1'));
      return JSON.stringify({ reviews: units.map(unit => ({ id: unit.id, issues: corrected ? [] : [{
        kind: sample.name, reason: '原文含义发生改变', sourceQuote: sample.quote,
        translationQuote: unit.translation, confidence: 'high' }] })) });
    }
    const { units } = payload(request);
    if (request.inferenceContext.phase === 'repair') { assert.deepEqual(units.map(unit => unit.id), ['b0']); corrected = true; }
    return reply(units, unit => unit.id === 'b0' ? corrected ? sample.correct : sample.bad : '背景说明。');
  };
  const translated = await translateDocument({ ...f, completeArticle });
  assert.equal(translated.blocks[0].translatedText, sample.correct);
  assert.deepEqual(phases, ['initial', 'review', 'repair', 'review']);
  const checkpoint = readJson(path.join(f.workDir, 'translation-checkpoint.json'));
  assert.equal(checkpoint.candidates.length, 0);
  assert.equal(checkpoint.translations.find(unit => unit.id === 'b0').round, 1);
  await translateDocument({ ...f, resumeFromCheckpoint: true, completeArticle: () => assert.fail('verified cache must be reused') });
});

test('two shared repair rounds persist across retries and never approve a known semantic error', async t => {
  const f = fixture(t, ['This does not prove safety.', 'Background description.']);
  let calls = 0;
  const completeArticle = async request => {
    calls++;
    if (request.inferenceContext.phase === 'review') return JSON.stringify({ reviews: payload(request).units.map(unit => ({ id: unit.id,
      issues: [{ kind: 'negation', reason: '否定反转', sourceQuote: 'not', translationQuote: unit.translation, confidence: 'high' }] })) });
    return reply(payload(request).units, unit => unit.id === 'b0' ? '该结果证明安全。' : '背景说明。');
  };
  await assert.rejects(translateDocument({ ...f, completeArticle }), error => error.needsReview);
  const saved = readJson(path.join(f.workDir, 'translation-checkpoint.json'));
  assert.deepEqual(saved.translations.map(unit => unit.id).sort(), ['b1', 'meta:title']);
  assert.equal(saved.candidates[0].round, 2);
  const before = calls;
  await assert.rejects(translateDocument({ ...f, completeArticle, resumeFromCheckpoint: true }), error => error.needsReview);
  assert.equal(calls, before, 'retry cannot grant another repair or review an unchanged rejected candidate');
});

test('missing-block completion and semantic repair spend the same two-round allowance', async t => {
  const f = fixture(t, ['This does not prove safety.', 'Background.']); const phases = [];
  const completeArticle = async request => {
    phases.push(request.inferenceContext.phase);
    if (request.inferenceContext.phase === 'review') return JSON.stringify({ reviews: payload(request).units.map(unit => ({ id: unit.id,
      issues: [{ kind: 'negation', reason: '否定反转', sourceQuote: 'not', translationQuote: unit.translation, confidence: 'high' }] })) });
    const units = payload(request).units.filter(unit => phases.length > 1 || unit.id !== 'b0');
    return reply(units, unit => unit.id === 'b0' ? '该结果证明安全。' : '背景说明。');
  };
  await assert.rejects(translateDocument({ ...f, completeArticle }), error => error.needsReview);
  assert.deepEqual(phases, ['initial', 'initial', 'review', 'repair', 'review']);
  assert.equal(readJson(path.join(f.workDir, 'translation-checkpoint.json')).candidates[0].round, 2);
});

test('a perpetually missing block retains its repair budget even without a candidate and cannot retry indefinitely', async t => {
  const f = fixture(t, ['Background.', 'Description.']); let calls = 0;
  const completeArticle = request => { calls++; return reply(payload(request).units.filter(unit => unit.id !== 'b1'), () => '背景说明。'); };
  await assert.rejects(translateDocument({ ...f, completeArticle }), error => error.needsReview);
  assert.equal(calls, 3);
  const saved = readJson(path.join(f.workDir, 'translation-checkpoint.json'));
  assert.equal(saved.repairRounds.find(unit => unit.id === 'b1').round, 2);
  await assert.rejects(translateDocument({ ...f, completeArticle, resumeFromCheckpoint: true }), error => error.needsReview);
  assert.equal(calls, 3);
});

test('unlocatable review evidence fails closed; low confidence warnings preserve progress', async t => {
  for (const grounded of [false, true]) {
    const f = fixture(t, ['Only synthetic data were used.']);
    const operation = translateDocument({ ...f, completeArticle: async request => request.inferenceContext.phase === 'review'
      ? JSON.stringify({ reviews: [{ id: 'b0', issues: [{ kind: 'meaning', reason: '需要核对范围', sourceQuote: grounded ? 'synthetic' : 'invented source',
        translationQuote: '合成', confidence: 'low' }] }] }) : reply(payload(request).units, () => '仅使用合成数据。') });
    if (grounded) assert.match((await operation).validationWarnings[0], /核对范围/);
    else await assert.rejects(operation, error => error.needsReview);
  }
});

test('missing IDs alone are requested again; cancellation retains all valid peers', async t => {
  const f = fixture(t, ['Background.', 'Description.']), requests = [];
  const controller = new AbortController();
  const reason = new Error('cancel fixture');
  await assert.rejects(translateDocument({ ...f, signal: controller.signal, completeArticle: async request => {
    const { units } = payload(request); requests.push(units.map(unit => unit.id));
    if (requests.length === 2) { controller.abort(reason); throw reason; }
    return reply(units.filter(unit => unit.id !== 'b1'), () => '背景说明。');
  } }), error => error === reason);
  assert.deepEqual(requests, [['meta:title', 'b0', 'b1'], ['b1']]);
  assert.deepEqual(readJson(path.join(f.workDir, 'translation-checkpoint.json')).translations.map(unit => unit.id).sort(), ['b0', 'meta:title']);
});

test('title and cover edits make zero body calls; terminology edits include only hits and adjacent context', async t => {
  const f = fixture(t, ['Opening.', 'Setup.', 'Inference predicts outcomes.', 'Discussion.', 'Closing.']);
  const initial = async request => request.inferenceContext.phase === 'review' ? goodReview(request) : reply(payload(request).units, () => '研究说明。');
  await translateDocument({ ...f, completeArticle: initial });
  const cached = { ...f, resumeFromCheckpoint: true, completeArticle: () => assert.fail('title/cover must not call the body model') };
  assert.equal((await translateDocument({ ...cached, translationInstructions: '标题改为《新标题》' })).translatedTitle, '新标题');
  await translateDocument({ ...cached, translationInstructions: '标题改为《新标题》\n封面改为 https://example.org/cover.png' });
  const ids = [];
  await translateDocument({ ...f, resumeFromCheckpoint: true, translationInstructions: '标题改为《新标题》\n术语 inference 统一译为推理',
    completeArticle: async request => {
      if (request.inferenceContext.phase === 'review') return goodReview(request);
      ids.push(...payload(request).units.map(unit => unit.id)); return reply(payload(request).units, () => '推理说明。');
    } });
  assert.deepEqual(ids, ['b1', 'b2', 'b3']);
});

test('unknown content changes and translation model changes invalidate body approvals', async t => {
  const f = fixture(t, ['Background.', 'Description.']);
  await translateDocument({ ...f, completeArticle: request => reply(payload(request).units, () => '研究说明。') });
  for (const options of [{ translationInstructions: '重新调整全部正文的表达' }, { writer: { modelIdentity: { model: 'other' } } }]) {
    const ids = [];
    await translateDocument({ ...f, resumeFromCheckpoint: true, ...options, completeArticle: async request => {
      ids.push(...payload(request).units.map(unit => unit.id)); return reply(payload(request).units, () => '研究说明。');
    } });
    assert.deepEqual(ids, ['meta:title', 'b0', 'b1']);
  }
});

test('compound cover/title requests and general translation style instructions safely retranslate the complete body', async t => {
  const f = fixture(t, ['Background.', 'Description.']);
  await translateDocument({ ...f, completeArticle: request => reply(payload(request).units, () => '研究说明。') });
  for (const translationInstructions of ['封面改为 https://example.org/image.png，同时精简正文', '标题改为新标题并精简正文', '正文翻译为通俗中文']) {
    const ids = [];
    await translateDocument({ ...f, resumeFromCheckpoint: true, translationInstructions, completeArticle: request => {
      ids.push(...payload(request).units.map(unit => unit.id)); return reply(payload(request).units, () => '研究说明。');
    } });
    assert.deepEqual(ids, ['meta:title', 'b0', 'b1']);
  }
});

test('damaged semantic receipts require a fresh review and cannot silently approve cached translations', async t => {
  const f = fixture(t, ['Only synthetic data were used.']);
  const completeArticle = request => request.inferenceContext.phase === 'review' ? goodReview(request) : reply(payload(request).units, () => '仅使用合成数据。');
  await translateDocument({ ...f, completeArticle });
  const filename = path.join(f.workDir, 'translation-checkpoint.json'), saved = readJson(filename);
  saved.translations.find(item => item.id === 'b0').review.issues.push({ confidence: 'high', reason: 'tampered' });
  fs.writeFileSync(filename, JSON.stringify(saved));
  let reviews = 0;
  await translateDocument({ ...f, resumeFromCheckpoint: true, completeArticle: request => {
    assert.equal(request.inferenceContext.phase, 'review'); reviews++; return goodReview(request);
  } });
  assert.equal(reviews, 1);
});

test('long blocks use stable sentence chunks, preserve placeholders, and resume only missing chunks', async t => {
  const text = `${'The source describes an experiment. '.repeat(280)} ⟦SL_INLINE_001⟧ ${'Additional methodology. '.repeat(190)}`;
  const parts = splitLongTranslationUnits([{ id: 'b0', kind: 'paragraph', text }]);
  assert.ok(parts.length > 1); assert.equal(parts.map(unit => unit.text).join(''), text);
  assert.deepEqual(parts, splitLongTranslationUnits([{ id: 'b0', kind: 'paragraph', text }]));
  assert.equal(parts.filter(unit => unit.text.includes('⟦SL_INLINE_001⟧')).length, 1);
  const f = fixture(t, [text]); let fail = true; const seen = [];
  const completeArticle = async request => {
    if (request.inferenceContext.phase === 'review') return goodReview(request);
    const { units } = payload(request); seen.push(...units.map(unit => unit.id));
    if (fail && units.some(unit => unit.id === parts.at(-1).id)) throw new Error('interrupted');
    return reply(units, unit => `${'方法说明。'.repeat(200)}${unit.text.includes('⟦SL_INLINE_001⟧') ? '⟦SL_INLINE_001⟧' : ''}`);
  };
  await assert.rejects(translateDocument({ ...f, completeArticle }), /interrupted/);
  const approved = readJson(path.join(f.workDir, 'translation-checkpoint.json')).translations.map(unit => unit.id);
  fail = false; seen.length = 0;
  const translated = await translateDocument({ ...f, completeArticle, resumeFromCheckpoint: true });
  assert.ok(approved.every(id => !seen.includes(id)));
  assert.equal((translated.blocks[0].translatedText.match(/⟦SL_INLINE_001⟧/g) || []).length, 1);
});

test('equivalent numeric formats are accepted, ordered placeholders are gated, omissions trigger review', () => {
  assert.deepEqual(assessTranslationUnit({ text: '50k tokens; 124M parameters; 8,400 samples; 100 percent.' },
    '5 万个 token、1.24 亿个参数、8400 个样本、100%。').hardErrors, []);
  assert.ok(assessTranslationUnit({ text: 'A ⟦SL_INLINE_001⟧ then B ⟦SL_INLINE_002⟧.' },
    'A ⟦SL_INLINE_002⟧，B ⟦SL_INLINE_001⟧。').hardErrors.some(error => /顺序/.test(error)));
  assert.ok(translationNeedsReview({ text: 'A describes a method. B describes a test. C describes a model. D describes data.' }, '这里介绍方法。'));
  for (const text of ['The method is faster.', "This isn't supported.", 'This suggests a possible improvement.', '这并不是实盘证据。']) {
    assert.ok(translationNeedsReview({ text }, '原文语义需核对。'));
  }
});
