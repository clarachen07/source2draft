import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readSource } from '../src/core/sources.js';
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
