import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessTranslationUnit, protectInvariantText, translationUnits } from '../src/workflows/translation-validation.js';
import { translateDocument, splitLongTranslationUnits } from '../src/workflows/translation-inference.js';
import { TRANSLATION_REVIEW_POLICY } from '../src/workflows/translation-review.js';
import { approveArtifact, readArtifactCache, TRANSLATION_PRESENTATION_VERSION, QUALITY_POLICY } from '../src/lib/artifact-cache.js';
import { hash } from '../src/lib/io.js';

const payload = request => JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n') + 1));
const translations = (units, body) => JSON.stringify({ translations: units.map(unit => ({
  id: unit.id, text: unit.id === 'meta:title' ? '模型架构' : body(unit),
})) });
const reviews = (units, issues = []) => JSON.stringify({ reviews: units.map(unit => ({ id: unit.id, issues })) });
function fixture(t, block) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-invariant-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  return { workDir, model: 'fixture-model', writer: { modelIdentity: { model: 'fixture-model' } },
    source: { title: 'Architecture', sha256: 'fixture-source', sourceUrl: 'https://example.org/report.pdf', blocks: [block] } };
}

test('hyphenated magnitude modifiers preserve their numeric value and multiplicity', () => {
  for (const hyphen of ['-', '‐', '‑']) {
    for (const [source, target] of [
      [`A 1${hyphen}million${hyphen}token context window.`, '100 万 token 的上下文窗口。'],
      [`A 104${hyphen}billion${hyphen}parameter model.`, '拥有 1040 亿参数的模型。'],
      [`A 2.8${hyphen}trillion${hyphen}parameter model.`, '拥有 2.8 万亿参数的模型。'],
      [`A 50${hyphen}thousand${hyphen}token context window.`, '5 万 token 的上下文窗口。'],
    ]) assert.deepEqual(assessTranslationUnit({ text: source }, target).hardErrors, [], source);
  }
  for (const [source, target] of [
    ['A 1-million-token context window.', '10 万 token 的上下文窗口。'],
    ['A 1-million-token context window and 1 experiment.', '100 万 token 的上下文窗口。'],
    ['Two 1-million-token windows, each 1 million tokens.', '两个窗口，各 100 万 token。'],
    ['The amount is -1 million.', '金额为 100 万。'],
  ]) assert.ok(assessTranslationUnit({ text: source }, target).hardErrors.length, source);
});

test('comparison-before-result ordering keeps formulas and citations and receives grounded review', async t => {
  const block = { id: 'b000028', type: 'paragraph',
    text: 'Scaling efficiency improves by ⟦SL_INLINE_001⟧ over Kimi K2 ⟦SL_INLINE_002⟧.',
    fragments: [{ token: '⟦SL_INLINE_001⟧', value: '$2.5\\times$' },
      { token: '⟦SL_INLINE_002⟧', value: '[59](https://example.org/k2)' }] };
  const f = fixture(t, block), phases = [];
  const translated = await translateDocument({ ...f, completeArticle: async request => {
    phases.push(request.inferenceContext.phase);
    const { units } = payload(request);
    if (request.inferenceContext.phase === 'review') {
      assert.deepEqual(units[0].fragments, block.fragments);
      return reviews(units);
    }
    return translations(units, () => '相比 Kimi K2 ⟦SL_INLINE_002⟧，扩展效率提升了 ⟦SL_INLINE_001⟧。');
  } });
  assert.deepEqual(phases, ['initial', 'review']);
  assert.match(translated.blocks[0].translatedText, /Kimi K2 ⟦SL_INLINE_002⟧/);
  assert.equal(translated.qualityPolicy, TRANSLATION_REVIEW_POLICY);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(f.workDir, 'translation-checkpoint.json')));
  assert.equal(checkpoint.candidates.length, 0);
  assert.deepEqual(checkpoint.repairRounds, [], 'natural reordering must not spend repair calls');
});

test('formula reassignment is rejected by semantic review even when all tokens are present', async t => {
  const f = fixture(t, { id: 'b0', type: 'paragraph',
    text: 'Model A gains ⟦SL_INLINE_001⟧. Model B gains ⟦SL_INLINE_002⟧.',
    fragments: [{ token: '⟦SL_INLINE_001⟧', value: '$2.5\\times$' }, { token: '⟦SL_INLINE_002⟧', value: '$1.5\\times$' }] });
  const bad = '模型 A 提升了 ⟦SL_INLINE_002⟧。模型 B 提升了 ⟦SL_INLINE_001⟧。';
  let calls = 0;
  const completeArticle = async request => {
    calls++;
    const { units } = payload(request);
    if (request.inferenceContext.phase === 'review') return reviews(units, [{ kind: 'attribution', confidence: 'high',
      reason: '两模型的公式被互换', sourceQuote: 'Model A gains ⟦SL_INLINE_001⟧', translationQuote: '模型 A 提升了 ⟦SL_INLINE_002⟧' }]);
    return translations(units, () => bad);
  };
  await assert.rejects(translateDocument({ ...f, completeArticle }), error => error.needsReview);
  const before = calls;
  await assert.rejects(translateDocument({ ...f, completeArticle, resumeFromCheckpoint: true }), error => error.needsReview);
  assert.equal(calls, before, 'unchanged rejected formulas do not get a new repair budget');
});

test('hyphenated context size passes, but inverted expert counts are reviewed and repaired with visible source values', async t => {
  const text = 'A 1-million-token context window. Stable LatentMoE effectively activates 16 of 896 routed experts per token.';
  const f = fixture(t, { id: 'b000005', type: 'paragraph', text });
  const phases = []; let repaired = false;
  const translated = await translateDocument({ ...f, completeArticle: async request => {
    phases.push(request.inferenceContext.phase);
    const { units } = payload(request);
    if (request.inferenceContext.phase === 'review') return reviews(units, repaired ? [] : [{
      kind: 'attribution', confidence: 'high', reason: '激活数与专家总数颠倒',
      sourceQuote: 'activates 16 of 896 routed experts', translationQuote: '激活 16 个路由专家中的 896 个',
    }]);
    if (request.inferenceContext.phase === 'repair') {
      assert.equal(units[0].sourceText, text);
      assert.deepEqual(units[0].invariants.map(item => item.value), ['1', '16', '896']);
      assert.match(units[0].text, /SL_KEEP/);
      repaired = true;
    }
    return translations(units, () => `100 万 token 的上下文窗口。Stable LatentMoE 每个 token 可有效${repaired
      ? '从 896 个路由专家中激活 16 个' : '激活 16 个路由专家中的 896 个'}。`);
  } });
  assert.deepEqual(phases, ['initial', 'review', 'repair', 'review']);
  assert.match(translated.blocks[0].translatedText, /从 896 个路由专家中激活 16 个/);
});

test('caption fragments reach translation and split units keep only their own fragment bindings', () => {
  const fragments = [{ token: '⟦SL_INLINE_001⟧', value: '$x$' }];
  const units = translationUnits({ title: 'Source', blocks: [
    { id: 'b0', type: 'figure', caption: 'Figure ⟦SL_INLINE_001⟧', captionFragments: fragments },
    { id: 'b1', type: 'table', caption: 'Table ⟦SL_INLINE_001⟧', captionFragments: fragments },
  ] });
  assert.deepEqual(units[1].fragments, fragments);
  assert.deepEqual(units[2].fragments, fragments);
  const source = 'First sentence. '.repeat(20) + '⟦SL_INLINE_001⟧ ' + 'Final sentence. '.repeat(20);
  const parts = splitLongTranslationUnits([{ id: 'b2', kind: 'paragraph', text: source, fragments }], 180);
  for (const part of parts) assert.deepEqual(part.fragments, part.text.includes('⟦SL_INLINE_001⟧') ? fragments : []);
});

test('new review policy rechecks cached candidates without retranslating or resetting spent repairs', async t => {
  const f = fixture(t, { id: 'b0', type: 'paragraph', text: 'The model activates 16 of 896 experts.' });
  const completeArticle = request => request.inferenceContext.phase === 'review' ? reviews(payload(request).units)
    : translations(payload(request).units, () => '模型从 896 个专家中激活 16 个。');
  await translateDocument({ ...f, completeArticle });
  const filename = path.join(f.workDir, 'translation-checkpoint.json');
  const saved = JSON.parse(fs.readFileSync(filename));
  const entry = saved.translations.find(item => item.id === 'b0');
  entry.round = 2;
  entry.review.identity = 'approval-under-old-policy';
  saved.repairRounds.push({ id: 'b0', round: 2, identity: entry.identity });
  fs.writeFileSync(filename, JSON.stringify(saved));
  let count = 0;
  await translateDocument({ ...f, resumeFromCheckpoint: true, completeArticle: request => {
    assert.equal(request.inferenceContext.phase, 'review'); count++;
    return reviews(payload(request).units);
  } });
  assert.equal(count, 1);
  assert.equal(JSON.parse(fs.readFileSync(filename)).translations.find(item => item.id === 'b0').round, 2);
});

test('rung and term ordinals translate, while model identifiers stay exact', () => {
  const source = 'comparable to the rung-1 to rung-3 domains in term-5.';
  assert.deepEqual(assessTranslationUnit({ text: source }, '与第 1 级至第 3 级领域相当，位于第 5 期。', { afterRepair: true }).hardErrors, []);
  assert.deepEqual(assessTranslationUnit({ text: source }, '与第一级至第三级领域相当，位于第五期。', { afterRepair: true }).hardErrors, []);
  assert.match(assessTranslationUnit({ text: source }, '与各级领域相当。', { afterRepair: true }).hardErrors.join(' '), /数字/);
  const protectedText = protectInvariantText('Keep GPT-5, Mamba-2, o3-mini and MetaRSI-v1, but translate rung-1 and term-5.');
  assert.match(protectedText.text, /rung-1/);
  assert.match(protectedText.text, /term-5/);
  assert.deepEqual(protectedText.tokens, ['GPT-5', 'Mamba-2', 'o3-mini', 'MetaRSI-v1']);
  assert.match(assessTranslationUnit({ text: 'GPT-5 and Mamba-2 remain.' }, '这些模型仍然保留。', { afterRepair: true }).hardErrors.join(' '), /型号标识不一致/);
});

test('a frozen rung label can be repaired, and an exhausted checkpoint is released once', async t => {
  const text = 'The domains are comparable to the rung-1 to rung-3 domains, unlike GPT-5.';
  const issue = { kind: 'terminology', confidence: 'high', reason: '“rung”在全文其他位置译为“级”，此处却保留英文并与“级”混用，导致阶梯级别术语翻译不一致。',
    sourceQuote: 'rung-1 to rung-3', translationQuote: '第 rung-1 至第 rung-3 级' };
  const f = fixture(t, { id: 'b000022', type: 'paragraph', text });
  let repairFixed = false;
  let repairs = 0;
  const completeArticle = async request => {
    const { units } = payload(request);
    if (request.inferenceContext.phase === 'review') {
      return JSON.stringify({ reviews: units.map(unit => ({ id: unit.id, issues: unit.translation?.includes(issue.translationQuote) ? [issue] : [] })) });
    }
    if (request.inferenceContext.phase === 'repair') {
      repairs += 1;
      assert.match(units[0].text, /rung-1 to rung-3/);
      assert.doesNotMatch(units[0].text, /GPT-5/);
      const token = units[0].invariants.find(item => item.value === 'GPT-5').token;
      const body = repairFixed
        ? `这些领域与第 1 级至第 3 级领域相当，不同于 ${token}。`
        : `这些领域与第 rung-1 至第 rung-3 级领域相当，不同于 ${token}。`;
      return translations(units, () => body);
    }
    return translations(units, unit => unit.id === 'b000022'
      ? '这些领域与第 rung-1 至第 rung-3 级领域相当，不同于 GPT-5。'
      : '模型架构');
  };
  await assert.rejects(translateDocument({ ...f, completeArticle }), error => error.needsReview && /b000022/.test(error.message));
  assert.equal(repairs, 2);
  repairFixed = true;
  const translated = await translateDocument({ ...f, completeArticle, resumeFromCheckpoint: true });
  assert.equal(repairs, 3);
  assert.match(translated.blocks[0].translatedText, /第 1 级至第 3 级/);
  assert.doesNotMatch(translated.blocks[0].translatedText, /rung-/);
  assert.match(translated.blocks[0].translatedText, /GPT-5/);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(f.workDir, 'translation-checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.translations.find(item => item.id === 'b000022').ordinalRelease, 'spent');

  repairFixed = false;
  const stuck = fixture(t, { id: 'b000022', type: 'paragraph', text });
  let stuckRepairs = 0;
  const stuckComplete = async request => {
    const { units } = payload(request);
    if (request.inferenceContext.phase === 'review') {
      return JSON.stringify({ reviews: units.map(unit => ({ id: unit.id, issues: unit.translation?.includes(issue.translationQuote) ? [issue] : [] })) });
    }
    if (request.inferenceContext.phase === 'repair') {
      stuckRepairs += 1;
      const token = units[0].invariants.find(item => item.value === 'GPT-5').token;
      return translations(units, () => `这些领域与第 rung-1 至第 rung-3 级领域相当，不同于 ${token}。`);
    }
    return translations(units, unit => unit.id === 'b000022'
      ? '这些领域与第 rung-1 至第 rung-3 级领域相当，不同于 GPT-5。'
      : '模型架构');
  };
  await assert.rejects(translateDocument({ ...stuck, completeArticle: stuckComplete }), error => error.needsReview);
  assert.equal(stuckRepairs, 2);
  await assert.rejects(translateDocument({ ...stuck, completeArticle: stuckComplete, resumeFromCheckpoint: true }), error => error.needsReview);
  assert.equal(stuckRepairs, 3);
  await assert.rejects(translateDocument({ ...stuck, completeArticle: stuckComplete, resumeFromCheckpoint: true }), error => error.needsReview);
  assert.equal(stuckRepairs, 3);
});

test('old translation article approvals cannot bypass the new semantic review policy; research cache remains reusable', t => {
  const f = fixture(t, { id: 'b0', type: 'paragraph', text: 'Source.' });
  const content = { article: '---\ntitle: Translation\n---\n译文。' };
  const context = { input: '直译', mode: 'translation', modelIdentity: { model: 'fixture-model' } };
  const filename = path.join(f.workDir, 'artifact.json');
  fs.writeFileSync(filename, JSON.stringify({ ...content, approval: { policy: QUALITY_POLICY,
    identity: hash({ content, ...context, translationPresentationVersion: TRANSLATION_PRESENTATION_VERSION }) } }));
  assert.equal(readArtifactCache(f.workDir, context), null);
  fs.writeFileSync(filename, JSON.stringify(approveArtifact(content, context)));
  assert.ok(readArtifactCache(f.workDir, context));
  const research = { ...context, mode: 'analysis' };
  fs.writeFileSync(filename, JSON.stringify({ ...content, approval: { policy: QUALITY_POLICY,
    identity: hash({ content, ...research }) } }));
  assert.ok(readArtifactCache(f.workDir, research));
});
