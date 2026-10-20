import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exposeTranslationLinkText } from '../src/workflows/translation-links.js';
import { translateDocument, splitLongTranslationUnits } from '../src/workflows/translation-inference.js';
import { assessTranslationUnit, translationUnits } from '../src/workflows/translation-validation.js';
import { renderTranslatedDocument, validateTranslationArtifact } from '../src/workflows/source-document.js';

const linkedBlock = () => ({ id: 'b000003', type: 'paragraph', order: 0,
  text: 'I ⟦SL_INLINE_001⟧ ⟦SL_INLINE_002⟧ ⟦SL_INLINE_003⟧ that fears of AI are overhyped.',
  fragments: ['have', 'written', 'frequently'].map((label, i) => ({
    token: `⟦SL_INLINE_00${i + 1}⟧`, value: `[${label}](https://example.org/source-${i + 1})`,
  })) });
const payload = request => JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n') + 1));
const good = '我[曾](⟦SL_INLINE_001⟧)[多次](⟦SL_INLINE_003⟧)[写道](⟦SL_INLINE_002⟧)，人们对 AI 的恐惧被过度渲染了。';
const reply = (units, body) => JSON.stringify({ translations: units.map(unit => ({ id: unit.id,
  text: unit.id === 'meta:title' ? '人工智能' : body(unit) })) });
const reviews = units => JSON.stringify({ reviews: units.map(unit => ({ id: unit.id, issues: [] })) });
function fixture(t) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-links-'));
  t.after(() => fs.rmSync(workDir, { force: true, recursive: true }));
  return { workDir, model: 'fixture', writer: {}, source: { title: 'AI', sha256: 'fixture',
    sourceType: 'html', sourceUrl: 'https://example.org/article', blocks: [linkedBlock()] } };
}

test('b000003: linked auxiliary, verb and adverb translate together and retain each URL after reordering', async t => {
  const f = fixture(t), original = structuredClone(f.source);
  const result = await translateDocument({ ...f, completeArticle: request => {
    const { units } = payload(request);
    if (request.inferenceContext.phase === 'review') {
      assert.equal(units[0].fragments[0].kind, 'link-url');
      assert.equal(units[0].translation, good);
      return reviews(units);
    }
    assert.match(units.find(unit => unit.id === 'b000003').text, /\[have\].*\[written\].*\[frequently\]/);
    return reply(units, () => good);
  } });
  const article = renderTranslatedDocument(result);
  assert.match(article, /我\[曾\]\(https:\/\/example.org\/source-1\)\[多次\]\(https:\/\/example.org\/source-3\)\[写道\]\(https:\/\/example.org\/source-2\)/);
  assert.doesNotMatch(article, /SL_INLINE|\[have\]|\[written\]|\[frequently\]|认为/);
  assert.deepEqual(validateTranslationArtifact({ source: f.source, translated: result, article }).errors, []);
  assert.deepEqual(f.source, original, 'stored original remains untouched');
  await translateDocument({ ...f, resumeFromCheckpoint: true, completeArticle: () => assert.fail('reuse verified translation') });
});

test('repair exposes linked prose, retains its protected destinations and rechecks attribution', async t => {
  const f = fixture(t); let repaired = false;
  const bad = good.replace('写道', '认为');
  const result = await translateDocument({ ...f, completeArticle: request => {
    const { units } = payload(request);
    if (request.inferenceContext.phase === 'review') return JSON.stringify({ reviews: units.map(unit => ({ id: unit.id,
      issues: repaired ? [] : [{ kind: 'attribution', confidence: 'high', reason: '曾写道被误译为认为',
        sourceQuote: '[written](⟦SL_INLINE_002⟧)', translationQuote: '[认为](⟦SL_INLINE_002⟧)' }] })) });
    if (request.inferenceContext.phase === 'repair') {
      assert.match(units[0].text, /\[have\]\(⟦SL_KEEP_1⟧\).*\[written\]\(⟦SL_KEEP_2⟧\)/);
      assert.match(units[0].sourceText, /\[written\]\(⟦SL_INLINE_002⟧\)/);
      assert.equal(units[0].fragments[1].value, 'https://example.org/source-2');
      repaired = true;
      return reply(units, () => good.replaceAll('SL_INLINE_001', 'SL_KEEP_1').replaceAll('SL_INLINE_002', 'SL_KEEP_2').replaceAll('SL_INLINE_003', 'SL_KEEP_3'));
    }
    return reply(units, () => bad);
  } });
  assert.equal(result.blocks[0].translatedText, good);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.workDir, 'translation-checkpoint.json'))).translations.find(unit => unit.id === 'b000003').round, 1);
});

test('normalization is idempotent, covers captions and leaves citations, formulas and preserved references intact', () => {
  const block = linkedBlock();
  block.fragments.push({ token: '⟦SL_INLINE_004⟧', kind: 'citation', value: '[Author](https://example.org/ref)' },
    { token: '⟦SL_INLINE_005⟧', value: '$x$' }, { token: '⟦SL_INLINE_006⟧', value: '[59](https://example.org/ref)' });
  block.text += ' ⟦SL_INLINE_004⟧ ⟦SL_INLINE_005⟧ ⟦SL_INLINE_006⟧';
  const reference = { ...linkedBlock(), id: 'ref', type: 'reference', translationPolicy: 'preserve-original' };
  const figure = { id: 'figure', type: 'figure', caption: 'The ⟦SL_INLINE_001⟧', captionFragments: [linkedBlock().fragments[0]] };
  const code = { ...linkedBlock(), id: 'code', type: 'code' };
  const document = exposeTranslationLinkText({ blocks: [block, reference, figure, code] });
  assert.deepEqual(exposeTranslationLinkText(document), document);
  assert.deepEqual(document.blocks[1], reference);
  assert.deepEqual(document.blocks[3], code);
  assert.deepEqual(document.blocks[0].fragments.slice(3), block.fragments.slice(3));
  assert.equal(document.blocks[2].caption, 'The [have](⟦SL_INLINE_001⟧)');
  assert.equal(translationUnits(document)[2].fragments[0].kind, 'link-url');
});

test('linked figure captions render translated labels as links and escape literal source HTML', () => {
  const source = exposeTranslationLinkText({ title: 'Illustration', sourceUrl: 'https://example.org', blocks: [{
    id: 'figure', type: 'figure', images: [], caption: 'See ⟦SL_INLINE_001⟧ <script>alert(1)</script>',
    captionFragments: [{ token: '⟦SL_INLINE_001⟧', value: '[diagram](https://example.org/diagram)' }],
  }] });
  source.blocks[0].translatedCaption = '参见[示意图](⟦SL_INLINE_001⟧) <script>alert(1)</script>';
  const article = renderTranslatedDocument(source);
  assert.match(article, /<a href="https:\/\/example.org\/diagram">示意图<\/a>/);
  assert.doesNotMatch(article, /<script>/);
  assert.match(article, /&lt;script&gt;/);
});

test('retaining a URL marker alone cannot approve missing or empty linked prose', () => {
  const unit = translationUnits(exposeTranslationLinkText({ blocks: [linkedBlock()] }))[1];
  assert.deepEqual(assessTranslationUnit(unit, good).hardErrors, []);
  for (const text of [good.replace('[曾](⟦SL_INLINE_001⟧)', '⟦SL_INLINE_001⟧'),
    good.replace('[曾]', '[]'), good.replace('[曾]', '[ ]')]) {
    assert.ok(assessTranslationUnit(unit, text).hardErrors.some(error => error.includes('链接文字')));
  }
});

test('long-unit boundaries cannot split a linked phrase from its destination', () => {
  const link = '[a long linked phrase with spaces](⟦SL_INLINE_001⟧)';
  const text = 'Sentence. '.repeat(14) + link + ' End.'.repeat(40);
  const parts = splitLongTranslationUnits([{ id: 'b0', kind: 'paragraph', text,
    fragments: [{ token: '⟦SL_INLINE_001⟧', kind: 'link-url', value: 'https://example.org/link' }] }], 160);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.equal(parts.filter(part => part.text.includes(link)).length, 1);
  assert.throws(() => splitLongTranslationUnits([{ id: 'b0', text: '[very long text '.repeat(1) + 'x'.repeat(170) + '](⟦SL_INLINE_001⟧)' }], 160), /无法安全拆分/);
});

test('cached opaque links are retranslatable under corrected source representation, while unaffected peers reuse approvals', async t => {
  const f = fixture(t);
  f.source.blocks.push(...['Background.', 'Setup.', 'Closing.'].map((text, i) => ({ id: `plain${i}`, type: 'paragraph', text })));
  const opaque = structuredClone(f.source);
  opaque.blocks[0].fragments.forEach(fragment => { fragment.kind = 'opaque'; });
  await translateDocument({ ...f, source: opaque, completeArticle: request => request.inferenceContext.phase === 'review'
    ? reviews(payload(request).units) : reply(payload(request).units, unit => unit.id === 'b000003'
      ? '我⟦SL_INLINE_001⟧ ⟦SL_INLINE_002⟧ ⟦SL_INLINE_003⟧认为，恐惧被过度渲染了。' : '背景说明。') });
  const requested = [];
  await translateDocument({ ...f, resumeFromCheckpoint: true, completeArticle: request => {
    const { units } = payload(request);
    if (request.inferenceContext.phase === 'review') return reviews(units);
    requested.push(...units.map(unit => unit.id));
    return reply(units, unit => unit.id === 'b000003' ? good : '背景说明。');
  } });
  assert.deepEqual(requested.sort(), ['b000003', 'meta:title', 'plain0']);
});
