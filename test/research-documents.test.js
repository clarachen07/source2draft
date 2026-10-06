import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHtmlDocument, parseLocalPdf, permittedFigureLicense, acquirePermittedFigures, readResearchDocument } from '../src/research/documents.js';
import { normalizeCandidate } from '../src/research/candidates.js';

const paragraph = 'Researchers evaluate financial language models using a chronological training and test split. The authors distinguish reported forecasting results from realized trading performance, and explain the benchmark data and evaluation limitations. '.repeat(5);
function page(extra = '', head = '') {
  return `<html><head><title>Financial language model study</title>${head}</head><body><article><h1>Financial language model study</h1><h2>Introduction</h2><p>${paragraph}</p>${extra}<h2>Results</h2><p>${paragraph}</p></article><footer><time datetime="2026-10-02T12:00:00Z">Site recently updated</time></footer></body></html>`;
}

test('sidebar/footer timestamps cannot make an undated or old article appear newly published', () => {
  const url = 'https://www.federalreserve.gov/econres/article.htm';
  assert.equal(parseHtmlDocument(page(), url).publishedAt, null);
  const old = parseHtmlDocument(page('', '<meta property="article:published_time" content="2020-01-10">'), url);
  assert.equal(old.publishedAt, '2020-01-10'); assert.equal(old.datePrecision, 'day');
  const related = `<script type="application/ld+json">{"@type":"NewsArticle","url":"https://www.federalreserve.gov/different.htm","datePublished":"2026-10-02"}</script>`;
  assert.equal(parseHtmlDocument(page('', related), url).publishedAt, null);
});

test('HTML evidence preserves tables, explicit source TeX and licensed figure provenance', () => {
  const extra = '<table><tr><th>Model</th><th>Score</th></tr><tr><td>Baseline</td><td>12.5</td></tr></table><p>Mathematical definition: <math alttext="R_t = w_t r_t"><mi>R</mi></math></p><figure><img src="figure.png" alt="Test results"><figcaption>Out-of-sample evaluation results.</figcaption></figure>';
  const document = parseHtmlDocument(page(extra, '<a rel="license" href="https://creativecommons.org/licenses/by/4.0/">License</a>'), 'https://arxiv.org/html/2609.12345v1');
  assert.ok(document.locators.some(locator => locator.type === 'table' && locator.text.includes('12.5')));
  assert.ok(document.locators.some(locator => locator.type === 'formula' && locator.tex === 'R_t = w_t r_t'));
  assert.equal(document.figures[0].url, 'https://arxiv.org/html/figure.png');
  assert.equal(document.licenseVerified, true);
});

test('MathML alternate annotations do not duplicate visible numbers; explicit source TeX remains independently locatable', () => {
  const math = '<p>Non-submission earns <math alttext="0.55"><semantics><mn>0.55</mn><annotation encoding="application/x-tex">0.55</annotation></semantics></math> reward.</p>';
  const document = parseHtmlDocument(page(math), 'https://arxiv.org/html/2609.12345v1');
  const locator = document.locators.find(item => item.type === 'paragraph' && item.text.includes('Non-submission'));
  assert.equal(locator.text, 'Non-submission earns 0.55 reward.'); assert.equal(document.text.includes('0.550.55'), false);
  assert.equal(document.locators.filter(item => item.type === 'formula' && item.tex === '0.55').length, 1);
});

test('real FinEvo MathML cost exponents retain their quantity and indices never merge into ordinary numbers', () => {
  const math = '<p>Agent-side costs span <math alttext="21.78\\times 10^{4}"><semantics><mrow><mn>21.78</mn><mo>×</mo><msup><mn>10</mn><mn>4</mn></msup></mrow><annotation encoding="application/x-tex">21.78\\times 10^{4}</annotation></semantics></math>–<math alttext="76.50\\times 10^{4}"><semantics><mrow><mn>76.50</mn><mo>×</mo><msup><mn>10</mn><mn>4</mn></msup></mrow><annotation encoding="application/x-tex">76.50\\times 10^{4}</annotation></semantics></math> tokens per task.</p>';
  const indices = '<p>Definition <math alttext="r_{t}^{2}"><semantics><msubsup><mi>r</mi><mi>t</mi><mn>2</mn></msubsup><annotation encoding="application/x-tex">r_{t}^{2}</annotation></semantics></math> and <math alttext="x_{t+1}"><msub><mi>x</mi><mrow><mi>t</mi><mo>+</mo><mn>1</mn></mrow></msub></math>.</p>';
  const grouped = '<p>Squared error <math alttext="(p-y)^2"><msup><mrow><mi>p</mi><mo>−</mo><mi>y</mi></mrow><mn>2</mn></msup></math>.</p>';
  const document = parseHtmlDocument(page(math + indices + grouped), 'https://arxiv.org/html/2608.06144v2');
  const cost = document.locators.find(item => item.type === 'paragraph' && item.text.includes('Agent-side costs'));
  assert.equal(cost.text, 'Agent-side costs span 21.78×10^4–76.50×10^4 tokens per task.');
  assert.equal(document.text.includes('21.78×104'), false);
  assert.ok(document.locators.some(item => item.type === 'paragraph' && item.text === 'Definition r_t^2 and x_(t+1).'));
  assert.ok(document.locators.some(item => item.type === 'paragraph' && item.text === 'Squared error (p−y)^2.'));
  for (const tex of ['21.78\\times 10^{4}', '76.50\\times 10^{4}', 'r_{t}^{2}', 'x_{t+1}']) {
    assert.equal(document.locators.filter(item => item.type === 'formula' && item.tex === tex).length, 1);
  }
});

test('only explicit reusable licenses allow originals; restrictive and unknown licenses perform zero image fetches', async () => {
  assert.equal(permittedFigureLicense('http://creativecommons.org/licenses/by/4.0/'), true);
  assert.equal(permittedFigureLicense('https://creativecommons.org/publicdomain/zero/1.0/'), true);
  for (const license of ['https://creativecommons.org/licenses/by-nc/4.0/', 'https://creativecommons.org/licenses/by-nd/4.0/',
    'https://creativecommons.org/licenses/by-sa/4.0/', 'https://evil.example/licenses/by/4.0/', 'https://user:password@creativecommons.org/licenses/by/4.0/']) assert.equal(permittedFigureLicense(license), false);
  let calls = 0;
  const client = { request: async () => { calls++; throw new Error('unexpected image read'); } };
  await acquirePermittedFigures({ document: { licenseVerified: false, licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', figures: [{ url: 'https://example.com/image.png' }] }, client, workDir: '/unused' });
  await acquirePermittedFigures({ document: { licenseVerified: true, licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/', figures: [{ url: 'https://example.com/image.png' }] }, client, workDir: '/unused' });
  assert.equal(calls, 0);
});

test('PDF extraction uses only free local tools and verifies page coverage before exposing locators', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-pdf-'));
  const commands = [], buffer = Buffer.from('%PDF-1.7\nfixture');
  const executeFn = async (command, args) => {
    commands.push({ command, args });
    return { stdout: command === 'pdfinfo' ? 'Title: Financial research\nPages: 2\nEncrypted: no\n' : `Introduction\n\n${paragraph}\fResults and References\n\n${paragraph}\f` };
  };
  try {
    const document = await parseLocalPdf({ buffer, url: 'https://arxiv.org/abs/2609.12345', workDir: dir, executeFn });
    assert.deepEqual(commands.map(call => call.command), ['pdfinfo', 'pdftotext']);
    assert.equal(document.pageCoverage.extracted, 2); assert.ok(document.locators.some(locator => locator.page === 2));
    assert.equal(document.publishedAt, null);
    assert.equal(fs.statSync(document.localPdf).mode & 0o777, 0o600);
    const incomplete = async command => ({ stdout: command === 'pdfinfo' ? 'Pages: 2\nEncrypted: no\n' : `Introduction and References\n${paragraph.repeat(2)}` });
    await assert.rejects(parseLocalPdf({ buffer, url: 'https://arxiv.org/abs/2609.12345', workDir: dir, executeFn: incomplete }), /页数/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an abstract-only scholarly landing page never becomes a full paper or falls through to text-summary extraction', async () => {
  const candidate = normalizeCandidate({ title: 'Financial language models', url: 'https://www.federalreserve.gov/econres/paper.htm', kind: 'paper', publishedAt: '2026-10-02', dateVerified: true });
  let fallback = 0;
  const html = '<html><head><title>Financial language models</title></head><body><article><h1>Abstract</h1><p>' + paragraph.slice(0, 350) + '</p></article></body></html>';
  const client = { request: async () => ({ status: 200, finalUrl: candidate.url, contentType: 'text/html', buffer: Buffer.from(html) }),
    firecrawl: async () => { fallback++; return { markdown: 'abstract' }; } };
  await assert.rejects(readResearchDocument({ candidate, client, config: {}, context: { cutoffAt: '2026-10-03T00:00:00Z', windowStart: '2026-10-02T00:00:00Z', supplementStart: '2026-09-26T00:00:00Z' }, workDir: '/unused' }),
    error => error.code === 'DAILY_CANDIDATE_INELIGIBLE');
  assert.equal(fallback, 0);
});
