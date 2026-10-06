import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { documentText, readSource } from '../src/core/sources.js';
import { acquireSourceDocument } from '../src/workflows/translation-source-text.js';

test('analysis source text restores PDF inline fragments, table cells, and equations', () => {
  const text = documentText({ blocks: [
    { type: 'paragraph', text: 'top-⟦SL_INLINE_001⟧, Figure ⟦SL_INLINE_002⟧', fragments: [
      { token: '⟦SL_INLINE_001⟧', value: '$p$' },
      { token: '⟦SL_INLINE_002⟧', value: '[2](https://example.com/signed.pdf?token=temporary)' },
    ] },
    { type: 'table', caption: 'Scores', rows: [[{ text: 'Model' }, { text: '92.3' }]] },
    { type: 'equation', tex: '\\mathcal{L}(\\theta)' },
  ] });
  assert.match(text, /top-\$p\$, Figure 2/);
  assert.match(text, /Model \| 92\.3/);
  assert.match(text, /公式：\\mathcal\{L\}/);
  assert.doesNotMatch(text, /SL_INLINE|\[object Object\]|signed\.pdf/);
  assert.throws(() => documentText({ blocks: [{ text: '⟦SL_INLINE_001⟧' }] }), /未能还原/);
});
import { loadConfig } from '../src/config/index.js';

// A valid one-page PDF exercises the real Poppler and structured-PDF path.
function onePagePdf() {
  const stream = 'BT /F1 12 Tf 72 720 Td (A complete source paragraph for PDF acquisition.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

const hasPoppler = ['pdfinfo', 'pdftotext'].every(name => spawnSync(name, ['-v']).status === 0);
test('analysis PDF reader downloads once through the real acquisition and parser path', {
  skip: hasPoppler ? false : 'PDF integration verification requires Poppler (pdfinfo and pdftotext)',
}, async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-source-pdf-'));
  const sourceUrl = 'https://93.184.216.34/paper.pdf'; // Public IP avoids DNS/network in this fixture.
  const pdf = onePagePdf(), requests = [], events = [];
  try {
    const source = await readSource({
      url: sourceUrl, workDir, config: loadConfig({ DATALAB_API_KEY: 'fixture-key' }),
      signal: new AbortController().signal, onTelemetry: event => events.push(event),
      fetchFn: async (url, options = {}) => {
        requests.push(String(url));
        if (url === sourceUrl) return new Response(pdf, { headers: { 'content-type': 'application/pdf' } });
        assert.equal(options.headers['X-API-Key'], 'fixture-key');
        assert.equal(options.redirect, 'error');
        if (url === 'https://www.datalab.to/api/v1/convert') {
          assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()), pdf);
          return Response.json({ success: true, request_id: 'fixture-pdf', request_check_url: 'https://www.datalab.to/api/v1/convert/fixture-pdf' });
        }
        assert.equal(url, 'https://www.datalab.to/api/v1/convert/fixture-pdf');
        return Response.json({ status: 'complete', success: true, page_count: 1, parse_quality_score: 4.5, images: {},
          metadata: { title: 'PDF integration fixture' },
          html: '<div class="page" data-page-id="0"><h1>PDF integration fixture</h1><p>A complete source paragraph for PDF acquisition. All source content is present for this fixture and the real PDF metadata and text extraction paths run successfully.</p></div>',
        });
      },
    });
    assert.equal(requests.filter(url => url === sourceUrl).length, 1);
    assert.equal(requests.length, 3);
    assert.equal(source.title, 'PDF integration fixture');
    assert.match(source.text, /A complete source paragraph/);
    const document = JSON.parse(fs.readFileSync(path.join(workDir, 'source-document.json'), 'utf8'));
    assert.equal(document.sourceType, 'pdf');
    assert.equal(document.pageCount, 1);
    assert.deepEqual(document.pageCoverage.processedPageIds, [0]);
    assert.ok(events.some(event => event.cacheHit && event.count === 1));
  } finally { fs.rmSync(workDir, { recursive: true, force: true }); }
});

test('PDF section selection validates full extraction before cropping and processes only selected assets', {
  skip: hasPoppler ? false : 'PDF integration verification requires Poppler (pdfinfo and pdftotext)',
}, async (t) => {
  const sourceUrl = 'https://93.184.216.34/sections.pdf';
  const intro = 'This introduction explains the requested part of a complete source document. '.repeat(6);
  const methods = 'The remaining methods and experimental results are outside the requested section. '.repeat(180);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  for (const incomplete of [false, true]) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-pdf-section-'));
    t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
    let rasterizations = 0;
    const html = `<div class="page" data-page-id="0"><h1>Section fixture</h1><h2>1 Introduction</h2><p>${intro}</p>
      <figure><img src="inside.png"><figcaption>Introduction chart</figcaption></figure>
      <h2>2 Methods</h2>${incomplete ? `<script>${methods}</script>` : `<p>${methods}</p>`}
      <figure><img src="outside.webp"><figcaption>Methods chart</figcaption></figure>
      <table><tr><th>Unselected table</th><td>Evidence</td></tr></table></div>`;
    const operation = acquireSourceDocument({
      sourceUrl, workDir, scope: { kind: 'sections', start: 'Introduction', end: 'Introduction' },
      config: { datalabApiKey: 'fixture-key', browserEnabled: false,
        imageRasterizer: async () => { rasterizations++; throw new Error('unselected image must not be rasterized'); },
        tableRasterizer: async () => { rasterizations++; throw new Error('unselected table must not be rasterized'); },
      },
      fetchFn: async (url) => {
        if (url === sourceUrl) return new Response(onePagePdf(), { headers: { 'content-type': 'application/pdf' } });
        if (url === 'https://www.datalab.to/api/v1/convert') return Response.json({
          success: true, request_id: 'section-fixture', request_check_url: 'https://www.datalab.to/api/v1/convert/section-fixture',
        });
        assert.equal(url, 'https://www.datalab.to/api/v1/convert/section-fixture', 'no out-of-scope asset download');
        return Response.json({ status: 'complete', success: true, page_count: 1, parse_quality_score: 4.5,
          images: { 'inside.png': png.toString('base64'), 'outside.webp': webp.toString('base64') }, html });
      },
    });
    if (incomplete) {
      await assert.rejects(operation, /PDF 页级完整性校验失败.*结构化正文仅保留 Datalab 文本/);
    } else {
      const document = await operation;
      assert.equal(document.scope.appliedStartHeading, '1 Introduction');
      assert.equal(document.scope.appliedEndHeading, '1 Introduction');
      assert.deepEqual(document.blocks.filter(block => block.type === 'heading').map(block => block.text), ['1 Introduction']);
      assert.equal(document.blocks.some(block => block.type === 'table'), false);
      assert.ok(fs.existsSync(document.blocks.find(block => block.type === 'figure').images[0].localPath));
      assert.ok(document.pageCoverage.extractedCharacters > intro.length * 10, 'coverage describes the complete uncropped extraction');
    }
    assert.equal(rasterizations, 0);
  }
});
