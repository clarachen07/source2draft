import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { withTaskCancellation } from '../src/lib/task-cancellation.js';
import {
  acquireSourceDocument,
  assertPdfExtractionCoverage,
  assessTranslationUnit,
  assertPdfPageLimit,
  assertPdfResponse,
  assertSafeHttpUrl,
  buildDocumentManifest,
  captureEmbeddedChartFrames,
  hasPdfSignature,
  inspectEmbeddedChartFrames,
  isPrivateIp,
  readResponseBufferWithLimit,
  removeRepeatedSourceMetadata,
  safeFetchResource,
  sourceDocumentFromHtml,
  sourceDocumentFromMarkdown,
  translateDocument,
  renderTranslatedDocument,
  validateEmbeddedChartScreenshot,
  validateTranslationArtifact,
} from '../src/workflows/translation-source-text.js';

const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-source-text-'));
}

function jsonTranslator(assertPayload) {
  return async ({ prompt }) => {
    const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
    assertPayload?.(payload, prompt);
    return JSON.stringify({
      translations: payload.units.map((unit) => ({
        id: unit.id,
        text: translatedFixture(unit),
      })),
    });
  };
}

function translatedFixture(unit) {
  if (unit.id === 'meta:title') return '结构化译文';
  const value = `中文译文：${unit.text}`;
  if (!['paragraph', 'quote', 'list_item'].includes(unit.kind) || value.length < 30) return value;
  const phrases = ['核心观点', '关键机制', '重要结论', '性能瓶颈', '实证结果', '系统能力'];
  const count = Math.max(1, Math.ceil(value.length / 120));
  return `${Array.from({ length: count }, (_, index) => `**${phrases[index % phrases.length]}**`).join('，')}：${value}`;
}

test('流式响应超过大小上限时立即取消', async () => {
  let cancelled = false;
  let reads = 0;
  const response = {
    body: {
      getReader() {
        return {
          async read() { reads += 1; return { done: false, value: new Uint8Array(6) }; },
          async cancel() { cancelled = true; },
          releaseLock() {},
        };
      },
    },
  };
  await assert.rejects(() => readResponseBufferWithLimit(response, 10), /超过大小上限/);
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
});

test('私有文件跨域重定向时不会把 Authorization 带到 CDN', async () => {
  const requests = [];
  const result = await safeFetchResource({
    url: 'https://files.slack.com/private/report.pdf',
    headers: { Authorization: 'Bearer xoxb-secret', 'X-Trace': 'keep' },
    dnsLookup: PUBLIC_DNS,
    fetchFn: async (url, options) => {
      requests.push({ url: String(url), headers: options.headers });
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.com/report.pdf?signature=ok' },
        });
      }
      return new Response('%PDF-test', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    },
    fetchWithRetry: async (fetch, url, options) => fetch(url, options),
  });
  assert.equal(result.buffer.toString(), '%PDF-test');
  assert.equal(requests[0].headers.Authorization, 'Bearer xoxb-secret');
  assert.equal(requests[1].headers.Authorization, undefined);
  assert.equal(requests[1].headers['X-Trace'], 'keep');
});

test('安全下载只允许有界 GET/POST，并把证监会表单原样交给受控 fetch', async () => {
  let request;
  const result = await safeFetchResource({
    url: 'http://eid.csrc.gov.cn/fund/disclose/validate_fund.do',
    method: 'POST',
    body: 'cFundCode=513100',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    dnsLookup: PUBLIC_DNS,
    fetchFn: async (url, options) => {
      request = { url, options };
      return new Response('{"isSuccess":true}', { status: 200 });
    },
  });
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.body, 'cFundCode=513100');
  assert.equal(result.buffer.toString(), '{"isSuccess":true}');
  await assert.rejects(() => safeFetchResource({
    url: 'https://example.com', method: 'PUT', dnsLookup: PUBLIC_DNS,
  }), /不支持请求方法/);
  await assert.rejects(() => safeFetchResource({
    url: 'https://example.com', method: 'POST', body: 'x'.repeat(70 * 1024), dnsLookup: PUBLIC_DNS,
  }), /请求体超过/);
});

test('任务取消包装不会关闭安全下载的 DNS pinning', async () => {
  const controller = new AbortController();
  const wrappedFetch = withTaskCancellation(globalThis.fetch, controller.signal);
  let pinnedAddresses;
  let receivedSignal;
  const result = await safeFetchResource({
    url: 'https://example.com/report.txt',
    dnsLookup: PUBLIC_DNS,
    fetchFn: wrappedFetch,
    pinnedFetchFactory(addresses) {
      pinnedAddresses = addresses;
      return async (_url, options) => {
        receivedSignal = options.signal;
        return new Response('pinned', { status: 200 });
      };
    },
  });
  assert.deepEqual(pinnedAddresses, [{ address: '93.184.216.34', family: 4 }]);
  assert.equal(receivedSignal.aborted, false);
  controller.abort();
  assert.equal(receivedSignal.aborted, true);
  assert.equal(result.buffer.toString(), 'pinned');
});

test('PDF 页数在文字提取前受硬上限保护', async () => {
  const execute = async () => ({ stdout: 'Pages: 121\n', stderr: '' });
  await assert.rejects(() => assertPdfPageLimit('/tmp/source.pdf', 120, { execute }), /121\/120/);
});

test('PDF 在进入 Poppler/Datalab 前验证真实签名，Slack 登录页返回 files:read 指引', async () => {
  assert.equal(hasPdfSignature(Buffer.from('%PDF-1.7\n')), true);
  assert.equal(hasPdfSignature(Buffer.from('prefix\n%PDF-1.7\n')), true);
  assert.equal(hasPdfSignature(Buffer.from('<!DOCTYPE html>')), false);
  assert.throws(() => assertPdfResponse({
    buffer: Buffer.from('<!DOCTYPE html><html><title>Slack</title></html>'),
    sourceUrl: 'https://files.slack.com/files-pri/T1-F1/download/report.pdf',
    contentType: 'text/html; charset=utf-8',
  }), /files:read.*重新安装 App/);
  assert.throws(() => assertPdfResponse({
    buffer: Buffer.from('not a pdf'),
    sourceUrl: 'https://example.com/report.pdf',
    contentType: 'text/plain',
  }), /不是有效 PDF.*text\/plain/);

  await assert.rejects(() => acquireSourceDocument({
    sourceUrl: 'https://files.slack.com/files-pri/T1-F1/download/report.pdf',
    workDir: tempDir(),
    requestHeaders: { Authorization: 'Bearer xoxb-secret' },
    fetchFn: async () => new Response(
      '<!DOCTYPE html><html><title>Slack</title><body>Sign in</body></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    ),
    fetchWithRetry: async (fetch, url, options) => fetch(url, options),
    config: { browserEnabled: false, datalabApiKey: 'datalab-key' },
    dnsLookup: PUBLIC_DNS,
    scope: { kind: 'all', requestedText: '' },
  }), /files:read.*重新安装 App/);
});

test('arXiv PDF 链接在未指定页码时优先读取官方 HTML', async () => {
  const calls = [];
  const paragraph = 'Structured arXiv HTML preserves headings and paragraphs for faithful translation. '.repeat(5);
  const document = await acquireSourceDocument({
    sourceUrl: 'https://arxiv.org/pdf/2606.26350',
    workDir: tempDir(),
    fetchFn: async (url) => {
      calls.push(String(url));
      return new Response(`<article class="ltx_document"><h1>Paper</h1><p>${paragraph}</p></article>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    },
    fetchWithRetry: async (fetch, url, options) => fetch(url, options),
    config: { browserEnabled: false },
    dnsLookup: PUBLIC_DNS,
    scope: { kind: 'all', requestedText: '' },
  });
  assert.equal(calls[0], 'https://arxiv.org/html/2606.26350');
  assert.equal(document.sourceType, 'html');
  assert.ok(document.acquisition.attempts.includes('arxiv-html'));
});

test('alphaXiv 论文链接映射到同 ID 官方 arXiv，正文讨论 CAPTCHA 时不误判挑战页', async () => {
  const calls = [];
  const paragraph = [
    'This paper studies CAPTCHA systems and records access denied responses as experimental evidence.',
    'The phrase verify you are human appears in the evaluated model trace, not in a browser challenge.',
  ].join(' ').repeat(12);
  const document = await acquireSourceDocument({
    sourceUrl: 'https://www.alphaxiv.org/abs/2608.09867',
    workDir: tempDir(),
    fetchFn: async (url) => {
      calls.push(String(url));
      return new Response(
        `<article class="ltx_document"><h1>CAPTCHA Research Paper</h1><p>${paragraph}</p></article>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    },
    fetchWithRetry: async (fetch, url, options) => fetch(url, options),
    config: { browserEnabled: false },
    dnsLookup: PUBLIC_DNS,
    scope: { kind: 'all', requestedText: '' },
  });

  assert.equal(calls[0], 'https://arxiv.org/html/2608.09867');
  assert.equal(document.sourceUrl, 'https://www.alphaxiv.org/abs/2608.09867');
  assert.ok(document.acquisition.attempts.includes('arxiv-html'));
  assert.match(document.blocks.map((block) => block.text || '').join(' '), /CAPTCHA systems/);
});

test('HTML 保留标题、段落、图片图注、表格、代码和列表结构', async () => {
  const paragraph = 'This is a complete article paragraph with enough body text for deterministic extraction and translation. '.repeat(4);
  const html = `<!doctype html><html><head><title>Text source</title></head><body>
    <article>
      <h1>Text source</h1>
      <p>${paragraph}</p>
      <figure><img src="chart.png" alt="SECRET_IMAGE_ALT"><figcaption>SECRET_FIGURE_CAPTION</figcaption></figure>
      <table><tr><th>SECRET_TABLE_HEADER</th><td>999999</td></tr></table>
      <pre><code>SECRET_CODE_BLOCK</code></pre>
      <ul><li>Body list item</li></ul>
      <h2>Second section</h2>
      <p>${paragraph}</p>
    </article>
  </body></html>`;
  const document = await sourceDocumentFromHtml({
    html,
    sourceUrl: 'https://example.com/article',
  });
  assert.deepEqual(
    [...new Set(document.blocks.map((block) => block.type))].sort(),
    ['code', 'figure', 'heading', 'list_item', 'paragraph', 'table'],
  );
  assert.equal(document.blocks.find((block) => block.type === 'figure').caption, 'SECRET_FIGURE_CAPTION');
  assert.equal(document.blocks.find((block) => block.type === 'table').rows[0][0].text, 'SECRET_TABLE_HEADER');
  assert.equal(document.blocks.find((block) => block.type === 'code').text, 'SECRET_CODE_BLOCK');
  assert.equal(document.contentMode, 'structured-document');
  assert.equal(buildDocumentManifest(document).contentMode, 'structured-document');
});

test('Datalab 分页 HTML 绕过 Readability，按顺序保留全部页面、图表和表格', async () => {
  const html = `<!doctype html><html><body>
    <div class="page" data-page-id="0"><h1>Paper</h1><p>PAGE_ONE ${'body '.repeat(80)}</p></div>
    <div class="page" data-page-id="1"><h2>Results</h2><p>PAGE_TWO ${'results '.repeat(80)}</p>
      <figure><img src="chart.png"><figcaption>Chart caption</figcaption></figure></div>
    <div class="page" data-page-id="2"><h2>Appendix</h2><p>PAGE_THREE ${'appendix '.repeat(80)}</p>
      <table><tr><th>Metric</th><th>Value</th></tr><tr><td>Coverage</td><td>100</td></tr></table></div>
  </body></html>`;
  const document = await sourceDocumentFromHtml({
    html,
    sourceUrl: 'https://example.com/paper.pdf',
    extractor: 'datalab-marker-html',
    scope: { kind: 'pages', startPage: 1, endPage: 3, requestedText: 'first 3 pages' },
  });
  const text = document.blocks.map((block) => block.text || block.caption || '').join('\n');
  assert.match(text, /PAGE_ONE/);
  assert.match(text, /PAGE_TWO/);
  assert.match(text, /PAGE_THREE/);
  assert.deepEqual(document.processedPageIds, [0, 1, 2]);
  assert.equal(document.blocks.filter((block) => block.type === 'heading').length, 3);
  assert.equal(document.blocks.filter((block) => block.type === 'figure').length, 1);
  assert.equal(document.blocks.filter((block) => block.type === 'table').length, 1);
  await assert.rejects(() => sourceDocumentFromHtml({
    html: '<article><h1>Single article</h1><p>Body</p></article>',
    sourceUrl: 'https://example.com/broken.pdf',
    extractor: 'datalab-marker-html',
  }), /缺少分页容器/);
});

test('Datalab ComplexRegion 无类嵌套 div 不丢文本且不重复表格内容', async () => {
  // Production regression: Datalab emits per-record experience sections as
  // classless nested divs inside div[data-block-id], some containing a table.
  // The extractor must keep residual region text while the table stays its own
  // block, otherwise page-level coverage drops below the hard gate.
  const html = `<!doctype html><html><body>
    <div class="page" data-page-id="0"><h1>Report</h1><p>Summary intro with enough text to matter.</p>
      <div data-block-id="/page/0/ComplexRegion/0"><div><div>#1 · Jane Doe</div><div>Chicago, Illinois, United States</div></div>
        <div><div>Strong evidence</div>
          <table><tr><td>CURRENT ROLE<br/>Senior Trader at Example Co</td></tr></table>
          <div>STRATEGY EVIDENCE<br/>Twenty years in volatility trading and team leadership.</div>
          <div>LINKEDIN<br/><a href="https://example.com/in/jane">https://example.com/in/jane</a></div>
        </div></div></div>
  </body></html>`;
  const document = await sourceDocumentFromHtml({
    html,
    sourceUrl: 'https://example.com/report.pdf',
    extractor: 'datalab-marker-html',
    scope: { kind: 'all' },
  });
  const region = document.blocks.find((block) => block.type === 'paragraph' && /Jane Doe/.test(block.text || ''));
  assert.ok(region, 'ComplexRegion 残差文本必须保留为段落块');
  assert.match(region.text, /STRATEGY EVIDENCE\nTwenty years/);
  assert.match(region.text, /Twenty years in volatility trading/);
  assert.doesNotMatch(region.text, /CURRENT ROLE|Senior Trader at Example Co/, '已被表格块覆盖的文本不得重复');
  const table = document.blocks.find((block) => block.type === 'table');
  assert.ok(table);
  assert.equal(table.rows[0][0].text, 'CURRENT ROLE\nSenior Trader at Example Co');
  assert.equal(table.rows.length, 1);
  assert.equal(document.blocks.filter((block) => /Jane Doe/.test(block.text || '')).length, 1);
});

test('PDF 页级完整性门禁拒绝单页正文冒充多页，完整覆盖时记录页码和文本基线', () => {
  const partial = {
    sourceType: 'pdf',
    processedPageCount: 3,
    processedPageIds: [0, 1, 2],
    datalabHtmlTextCharacters: 9000,
    datalabHtmlImageCount: 2,
    datalabResultImageCount: 2,
    blocks: [{ id: 'b000001', type: 'paragraph', text: 'short first page only' }],
  };
  assert.throws(() => assertPdfExtractionCoverage({
    document: partial,
    expectedPageIds: [0, 1, 2],
    popplerTextCharacters: 10000,
  }), /结构化正文仅保留 Datalab 文本/);

  const complete = {
    ...partial,
    blocks: [{ id: 'b000001', type: 'paragraph', text: 'x'.repeat(8000) }],
  };
  const coverage = assertPdfExtractionCoverage({
    document: complete,
    expectedPageIds: [0, 1, 2],
    popplerTextCharacters: 10000,
  });
  assert.deepEqual(coverage.pagesFound, [1, 2, 3]);
  assert.equal(coverage.requestedPages, 3);
  assert.equal(coverage.processedPages, 3);
  assert.equal(coverage.datalabImages, 2);
});

test('多 article 动态页面按标题锚定完整正文，不误选推荐卡片', async () => {
  const body = 'Complete methodology paragraph with enough detail for faithful translation. '.repeat(20);
  const html = `<!doctype html><html><head>
    <title>Agent Arena: Causal Evaluation of Agents in the Real World - Arena.ai</title>
    <meta property="og:title" content="Agent Arena: Causal Evaluation of Agents in the Real World">
    </head><body><main>
      <article><h3>Unrelated AutoEval card</h3><p>Short recommendation.</p></article>
      <section class="post-content">
        <h1 aria-label="Agent Arena: Causal Evaluation of Agents in the Real World">
          <span aria-hidden="true">Agent Arena: Causal Evaluation of Agents in the Real World</span>
        </h1>
        <p>${body}</p>
        <h2 aria-label="Causal evaluation"><span aria-hidden="true">Causal evaluation</span></h2>
        <p>${body}</p>
        <p>${body}</p>
      </section>
      <article><h3>Another recommendation</h3><p>Another short card.</p></article>
    </main></body></html>`;
  const document = await sourceDocumentFromHtml({
    html,
    sourceUrl: 'https://arena.example/blog/agent-arena-methodology',
  });

  assert.ok(document.blocks.length >= 5);
  assert.match(document.blocks.map((block) => block.text || '').join('\n'), /Complete methodology paragraph/);
  assert.deepEqual(
    document.blocks.filter((block) => block.type === 'heading').map((block) => block.text),
    ['Agent Arena: Causal Evaluation of Agents in the Real World', 'Causal evaluation'],
  );
  assert.doesNotMatch(document.blocks.map((block) => block.text || '').join('\n'), /Unrelated AutoEval card|Another recommendation/);
});

test('嵌入图表只从标题锚定正文识别，提取图题并排除 YouTube 和正文外 iframe', () => {
  const body = 'Complete report body with enough evidence and methodological context. '.repeat(20);
  const srcdoc = `<h2 class="table-title">Task Distribution</h2>
    <p class="table-subtitle">Primary intent across 160,480 tasks</p>
    <div class="chart"></div>
    <p class="table-footer">Inner arcs show sub-intents.</p>`;
  const html = `<!doctype html><html><head>
    <meta property="og:title" content="Agent Arena">
    </head><body>
      <iframe data-sl-source-frame="1" sandbox title="Outside chart" srcdoc="<h2>Outside</h2>"></iframe>
      <main><section class="post-content">
        <h1>Agent Arena</h1><p>${body}</p>
        <iframe data-sl-source-frame="2" sandbox="allow-scripts" title="Task Distribution"
          srcdoc="${srcdoc.replaceAll('"', '&quot;')}"></iframe>
        <iframe data-sl-source-frame="3" title="Video" src="https://www.youtube.com/embed/example"></iframe>
        <h2>Methodology</h2><p>${body}</p><p>${body}</p>
      </section></main>
    </body></html>`;

  const result = inspectEmbeddedChartFrames(html);
  assert.equal(result.detected, 1);
  assert.equal(result.excludedExternalFrames, 1);
  assert.equal(result.candidates[0].marker, '2');
  assert.match(result.candidates[0].caption, /Task Distribution/);
  assert.match(result.candidates[0].caption, /Primary intent across 160,480 tasks/);
  assert.match(result.candidates[0].caption, /Inner arcs show sub-intents/);
  assert.doesNotMatch(result.candidates[0].caption, /Outside/);
});

test('嵌入图表截图转成稳定本地资产并在原位置进入结构化翻译', async () => {
  const workDir = tempDir();
  const body = 'Complete report body with enough evidence and methodological context. '.repeat(20);
  const srcdoc = `<h2 class="table-title">Agent Arena Leaderboard</h2>
    <p class="table-subtitle">Net improvement by orchestrator model</p>
    <div class="chart"></div>
    <p class="table-footer">Error bars are 95% confidence intervals.</p>`;
  const html = `<!doctype html><html><head>
    <meta property="og:title" content="Agent Arena">
    </head><body><main><section class="post-content">
      <h1>Agent Arena</h1>
      <p>Before chart. ${body}</p>
      <iframe data-sl-source-frame="7" sandbox="allow-scripts" title="Agent Arena Leaderboard"
        srcdoc="${srcdoc.replaceAll('"', '&quot;')}"></iframe>
      <iframe data-sl-source-frame="8" title="Video" src="https://www.youtube.com/embed/example"></iframe>
      <h2>After chart</h2><p>${body}</p><p>${body}</p>
    </section></main></body></html>`;
  const dom = new JSDOM(html, { url: 'https://arena.example/report' });
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.alloc(5000),
  ]);
  const page = {
    locator(selector) {
      const node = dom.window.document.querySelector(selector);
      return {
        async count() { return node ? 1 : 0; },
        async scrollIntoViewIfNeeded() {},
        async boundingBox() { return { width: 845, height: 691 }; },
        async screenshot() { return png; },
        async evaluate(callback, payload) { return callback(node, payload); },
      };
    },
    async waitForTimeout() {},
  };

  const captured = await captureEmbeddedChartFrames({
    page,
    html,
    workDir,
  });
  assert.deepEqual(captured.embeddedCharts, {
    detected: 1,
    captured: 1,
    excludedExternalFrames: 1,
  });
  assert.ok(fs.existsSync(captured.assetMap['asset:embedded-chart-001.png']));
  assert.equal(dom.window.document.querySelectorAll('[data-sl-embedded-chart]').length, 1);
  assert.equal(dom.window.document.querySelectorAll('iframe[src*="youtube.com"]').length, 1);

  const document = await sourceDocumentFromHtml({
    html: dom.serialize(),
    sourceUrl: 'https://arena.example/report',
    documentUrl: 'https://arena.example/report',
    workDir,
    assetMap: captured.assetMap,
  });
  const figureIndex = document.blocks.findIndex((block) => block.type === 'figure');
  const afterHeadingIndex = document.blocks.findIndex((block) => block.type === 'heading' && block.text === 'After chart');
  assert.ok(figureIndex > document.blocks.findIndex((block) => block.type === 'paragraph'));
  assert.ok(figureIndex < afterHeadingIndex);
  assert.match(document.blocks[figureIndex].caption, /Agent Arena Leaderboard/);
  assert.match(document.blocks[figureIndex].caption, /Net improvement by orchestrator model/);
  assert.match(document.blocks[figureIndex].caption, /95% confidence intervals/);
  assert.match(document.blocks[figureIndex].images[0].localPath, /embedded-chart-001\.png$/);
  assert.ok(document.blocks.some((block) => (
    block.fragments || []
  ).some((fragment) => fragment.value === '[Video](https://www.youtube.com/embed/example)')));
  assert.equal(buildDocumentManifest(document).figures, 1);
});

test('嵌入图表截图门禁拒绝异常尺寸、空白、伪 PNG 和超限文件', () => {
  const validPng = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.alloc(5000),
  ]);
  assert.throws(() => validateEmbeddedChartScreenshot({
    title: 'Tiny chart',
    buffer: validPng,
    width: 100,
    height: 600,
  }), /尺寸异常/);
  assert.throws(() => validateEmbeddedChartScreenshot({
    title: 'Blank chart',
    buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
    width: 800,
    height: 600,
  }), /疑似空白/);
  assert.throws(() => validateEmbeddedChartScreenshot({
    title: 'Fake chart',
    buffer: Buffer.alloc(5000),
    width: 800,
    height: 600,
  }), /不是有效 PNG/);
  assert.throws(() => validateEmbeddedChartScreenshot({
    title: 'Large chart',
    buffer: validPng,
    width: 800,
    height: 600,
    limits: { maxSingleAssetBytes: 1000 },
  }), /超过单文件上限/);
});

test('含嵌入图表的静态 HTML 在浏览器关闭时明确失败，不静默丢图', async () => {
  const body = 'Complete report body with enough evidence and methodological context. '.repeat(20);
  const html = `<article><h1>Embedded report</h1><p>${body}</p>
    <iframe sandbox="allow-scripts" title="Interactive chart"
      srcdoc="<h2 class=&quot;table-title&quot;>Interactive chart</h2>"></iframe>
    <h2>Methodology</h2><p>${body}</p><p>${body}</p></article>`;
  await assert.rejects(() => acquireSourceDocument({
    sourceUrl: 'https://example.com/report',
    workDir: tempDir(),
    fetchFn: async () => new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    config: { browserEnabled: false },
    dnsLookup: PUBLIC_DNS,
  }), /浏览器抓取已关闭.*嵌入图表/);
});

test('WebP 原图在本地化时转为微信支持的 PNG', async () => {
  const workDir = tempDir();
  const webp = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('WEBPVP8 ', 'ascii'),
    Buffer.alloc(32),
  ]);
  const document = await sourceDocumentFromHtml({
    html: `<article><h1>WebP report</h1>
      <p>${'Body text for a complete source document. '.repeat(10)}</p>
      <figure><img src="/chart.webp" alt="Chart"><figcaption>Chart</figcaption></figure>
      </article>`,
    sourceUrl: 'https://example.com/report',
    workDir,
    dnsLookup: PUBLIC_DNS,
    fetchFn: async () => new Response(webp, {
      status: 200,
      headers: { 'content-type': 'image/webp' },
    }),
    config: {
      imageRasterizer: async ({ contentType, target }) => {
        assert.equal(contentType, 'image/webp');
        fs.writeFileSync(target, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
      },
    },
  });

  const imagePath = document.blocks.find((block) => block.type === 'figure').images[0].localPath;
  assert.match(imagePath, /figure-001\.png$/);
  assert.equal(fs.readFileSync(imagePath).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('映射得到的 WebP 资产也会转为微信支持的 PNG', async () => {
  const workDir = tempDir();
  const mappedWebp = path.join(workDir, 'mapped.webp');
  fs.writeFileSync(mappedWebp, Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('WEBPVP8 ', 'ascii'),
    Buffer.alloc(32),
  ]));
  const document = await sourceDocumentFromHtml({
    html: `<article><h1>Mapped report</h1>
      <p>${'Body text for a complete source document. '.repeat(10)}</p>
      <figure><img src="asset:mapped.webp" alt="Chart"><figcaption>Chart</figcaption></figure>
      </article>`,
    sourceUrl: 'https://example.com/report',
    workDir,
    assetMap: { 'asset:mapped.webp': mappedWebp },
    dnsLookup: PUBLIC_DNS,
    config: {
      imageRasterizer: async ({ contentType, target }) => {
        assert.equal(contentType, 'image/webp');
        fs.writeFileSync(target, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
      },
    },
  });

  const imagePath = document.blocks.find((block) => block.type === 'figure').images[0].localPath;
  assert.match(imagePath, /figure-001\.png$/);
  assert.equal(fs.readFileSync(imagePath).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('图片转换器输出伪装成 PNG 的 SVG 时立即失败', async () => {
  const workDir = tempDir();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
  await assert.rejects(() => sourceDocumentFromHtml({
    html: `<article><h1>SVG report</h1>
      <p>${'Body text for a complete source document. '.repeat(10)}</p>
      <figure><img src="/chart.svg" alt="Chart"><figcaption>Chart</figcaption></figure>
      </article>`,
    sourceUrl: 'https://example.com/report',
    workDir,
    dnsLookup: PUBLIC_DNS,
    fetchFn: async () => new Response(svg, {
      status: 200,
      headers: { 'content-type': 'image/svg+xml' },
    }),
    config: {
      imageRasterizer: async ({ target }) => fs.writeFileSync(target, svg),
    },
  }), /转 PNG 结果格式无效/);
});

test('章节范围先裁剪结构再下载该范围内的图片', async () => {
  const calls = [];
  const html = `<article>
    <h2>Introduction</h2>
    <figure><img src="/outside.png"><figcaption>Outside</figcaption></figure>
    <h2>Results</h2>
    <p>${'Results body with enough structured source text. '.repeat(4)}</p>
    <figure><img src="/inside.png"><figcaption>Inside</figcaption></figure>
    <h2>Conclusion</h2>
    <p>Conclusion body.</p>
  </article>`;
  const document = await sourceDocumentFromHtml({
    html,
    sourceUrl: 'https://example.com/article',
    workDir: tempDir(),
    scope: { kind: 'sections', start: 'Results', end: 'Results' },
    dnsLookup: PUBLIC_DNS,
    fetchFn: async (url) => {
      calls.push(String(url));
      if (!String(url).endsWith('/inside.png')) throw new Error('不应下载范围外图片');
      return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    },
  });
  assert.deepEqual(calls, ['https://example.com/inside.png']);
  assert.deepEqual(document.blocks.map((block) => block.type), ['heading', 'paragraph', 'figure']);
  assert.equal(document.scope.appliedStartHeading, 'Results');
});

test('Markdown/HTML 直译保留有序列表的原始起始值、显式序号和分隔符', async () => {
  const markdown = await sourceDocumentFromMarkdown({
    sourceUrl: 'https://example.com/list.md',
    markdown: '3) Third\n4) Fourth\n',
  });
  assert.deepEqual(
    markdown.blocks.map(({ type, ordered, ordinal, delimiter }) => ({ type, ordered, ordinal, delimiter })),
    [
      { type: 'list_item', ordered: true, ordinal: 3, delimiter: ')' },
      { type: 'list_item', ordered: true, ordinal: 4, delimiter: ')' },
    ],
  );
  markdown.blocks[0].translatedText = '第三项';
  markdown.blocks[1].translatedText = '第四项';
  assert.match(renderTranslatedDocument(markdown), /^3\) 第三项\n\n4\) 第四项$/m);

  const html = await sourceDocumentFromHtml({
    sourceUrl: 'https://example.com/list',
    html: `<main><h1>Ordered configurations</h1><ol start="3">
      <li>Third configuration contains enough explanatory source prose for complete article extraction.</li>
      <li value="7">Seventh configuration contains enough explanatory source prose for complete article extraction.</li>
      <li>Eighth configuration contains enough explanatory source prose for complete article extraction.</li>
    </ol></main>`,
  });
  assert.deepEqual(
    html.blocks.filter((block) => block.type === 'list_item')
      .map(({ ordered, ordinal, delimiter }) => ({ ordered, ordinal, delimiter })),
    [
      { ordered: true, ordinal: 3, delimiter: '.' },
      { ordered: true, ordinal: 7, delimiter: '.' },
      { ordered: true, ordinal: 8, delimiter: '.' },
    ],
  );
});

test('直译参考文献合并为一个连续的有序列表并去除原始重复序号', () => {
  const article = renderTranslatedDocument({
    sourceUrl: 'https://example.com/paper', title: 'Paper', blocks: [
      { type: 'heading', level: 2, text: '参考文献' },
      { type: 'reference', text: '1. First source' },
      { type: 'reference', text: '[2] Second source' },
    ],
  });
  assert.match(article, /## 参考文献\n\n1\. First source\n2\. Second source/);
  assert.doesNotMatch(article, /1\. 1\.|2\. \[2\]/);
});

test('结构化翻译覆盖标题、正文和图表标题，表格正文保留为原文图片', async () => {
  const workDir = tempDir();
  const imagePath = path.join(workDir, 'figure.png');
  const tablePath = path.join(workDir, 'table.png');
  fs.writeFileSync(imagePath, Buffer.from([1, 2, 3]));
  fs.writeFileSync(tablePath, Buffer.from([4, 5, 6]));
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Text source',
    author: '',
    publishedDate: '',
    sha256: 'source-hash',
    blocks: [
      { id: 'b000001', order: 0, type: 'heading', level: 1, text: 'Opening' },
      {
        id: 'b000002', order: 1, type: 'paragraph',
        text: 'See ⟦SL_INLINE_001⟧ now.',
        fragments: [{ token: '⟦SL_INLINE_001⟧', value: '[source](https://example.com/source)' }],
      },
      {
        id: 'b000003', order: 2, type: 'figure',
        images: [{ src: 'https://example.com/figure.png', localPath: imagePath, alt: 'Architecture' }],
        caption: 'System architecture', captionFragments: [],
      },
      {
        id: 'b000004', order: 3, type: 'table', caption: 'Results', captionFragments: [],
        localPath: tablePath,
        rows: [
          [{ text: 'Model', fragments: [] }, { text: 'Score', fragments: [] }],
          [{ text: 'Baseline', fragments: [] }, { text: 'High', fragments: [] }],
        ],
      },
      { id: 'b000005', order: 4, type: 'equation', tex: 'x^2+y^2=z^2' },
      { id: 'b000006', order: 5, type: 'reference', text: 'Author (2026). Paper.' },
    ],
    scope: { kind: 'all', requestedText: '' },
  };
  const translated = await translateDocument({
    source,
    workDir,
    model: 'test-model',
    writer: {},
    completeArticle: jsonTranslator((payload, prompt) => {
      assert.deepEqual(payload.units.map((unit) => unit.kind), [
        'title', 'heading', 'paragraph', 'figure_caption', 'table_caption',
      ]);
      assert.match(prompt, /表格正文直接保留原文截图/);
      assert.doesNotMatch(JSON.stringify(payload), /Model|Score|Baseline|High/);
      assert.doesNotMatch(JSON.stringify(payload), /x\^2|Author \(2026\)/);
    }),
  });
  translated.translatedTitle = '结构化译文（译）';
  const article = renderTranslatedDocument(translated);
  const completeness = validateTranslationArtifact({ source, translated, article });
  assert.deepEqual(completeness.errors, []);
  assert.match(article, /!\[Architecture\]\(/);
  assert.match(article, /\*\*表 1：中文译文：Results\*\*/);
  assert.match(article, /!\[原文表 1\]\(/);
  assert.doesNotMatch(article, /^\|/m);
  assert.match(article, /\$\$\nx\^2\+y\^2=z\^2\n\$\$/);
  assert.match(article, /\[source\]\(https:\/\/example\.com\/source\)/);
  assert.match(article, /## 中文译文：Opening/);
  assert.match(article, /^title: "结构化译文"$/m);
  assert.doesNotMatch(article, /（译）|翻译范围|日期：/);
  assert.equal((article.match(/原文信息/g) || []).length, 1);
});

test('论文标题页的重复标题、作者和机构列表在摘要前被移除', () => {
  const document = removeRepeatedSourceMetadata({
    title: 'Terminal-Bench',
    author: 'Mike Merrill; Alexander Shaw; Nicholas Carlini',
    scope: { kind: 'pages', startPage: 1, endPage: 11 },
    blocks: [
      { id: 'b1', order: 0, type: 'heading', level: 1, text: 'Terminal-Bench' },
      { id: 'b2', order: 1, type: 'paragraph', text: 'Mike Merrill, Alexander Shaw, Nicholas Carlini' },
      { id: 'b3', order: 2, type: 'paragraph', text: '1 Stanford University, 2 Laude Institute' },
      { id: 'b4', order: 3, type: 'figure', images: [{ localPath: '/tmp/title-figure.png' }] },
      { id: 'b5', order: 4, type: 'heading', level: 2, text: 'Abstract' },
      { id: 'b6', order: 5, type: 'paragraph', text: 'Abstract body.' },
    ],
  });
  assert.deepEqual(document.blocks.map((block) => block.id), ['b4', 'b5', 'b6']);
  assert.deepEqual(document.blocks.map((block) => block.order), [0, 1, 2]);
  assert.equal(document.metadataBlocksRemoved, 3);
});

test('正文翻译保持合理高亮，标题或整段异常加粗会安全降级为纯文本', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Title',
    author: '',
    sha256: 'highlight-source',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'The benchmark measures difficult realistic tasks and reveals the central performance bottleneck.',
    }],
  };
  const completeArticle = async ({ prompt }) => {
    const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
    return JSON.stringify({
      translations: payload.units.map((unit) => ({
        id: unit.id,
        text: unit.kind === 'paragraph'
          ? '该基准衡量困难的现实任务，并揭示**核心性能瓶颈**。'
          : '标题',
      })),
    });
  };
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle,
  });
  assert.match(renderTranslatedDocument(translated), /\*\*核心性能瓶颈\*\*/);

  const normalized = await translateDocument({
    source: { ...source, sha256: 'invalid-highlight-source' },
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title' ? '**标题**' : '**整段文字全部被错误加粗**',
        })),
      });
    },
  });
  const normalizedArticle = renderTranslatedDocument(normalized);
  assert.doesNotMatch(normalized.translatedTitle, /\*\*/);
  assert.doesNotMatch(normalized.blocks[0].translatedText, /\*\*/);
  assert.match(normalizedArticle, /整段文字全部被错误加粗/);
});

test('长段落高亮不足不触发重译，也不阻断忠实译文', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Title',
    author: '',
    sha256: 'low-highlight-density',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'The benchmark evaluates realistic agent tasks and identifies the decisive system bottleneck. '.repeat(4),
    }],
  };
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title'
            ? '标题'
            : `这是一段只包含一处**核心观点**、但整体篇幅已经很长的中文译文。${'系统需要在真实任务中持续验证能力边界与性能瓶颈。'.repeat(10)}`,
        })),
      });
    },
  });
  assert.match(renderTranslatedDocument(translated), /\*\*核心观点\*\*/);
});

test('明确数字不一致经两轮修复后进入宽松复核，不丢结构', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Title',
    author: '',
    sha256: 'invariant-mismatch',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'The reported portfolio return was 100 percent.',
    }],
  };
  const workDir = tempDir();
  const translated = await translateDocument({
    source,
    workDir,
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title' ? '标题' : '报告的投资组合回报率为 99%。',
        })),
      });
    },
  });
  assert.equal(translated.validationExceptions.length, 1);
  assert.equal(translated.validationExceptions[0].id, 'b000001');
  assert.match(translated.validationWarnings.join(' '), /两轮聚焦修复后宽松放行/);
  const completeness = validateTranslationArtifact({
    source,
    translated,
    article: renderTranslatedDocument(translated),
  });
  assert.equal(completeness.errors.length, 0);
  assert.equal(completeness.strictEquivalence, false);
  assert.deepEqual(completeness.reviewRequiredUnits, ['b000001']);
});

test('K/M/B/T、中文数量单位、千分位和百分比只要数值等价即可通过', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Model Scale',
    author: '',
    sha256: 'equivalent-number-formats',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'Overall, with about 50k possible tokens, 124M parameters, 8,400 samples, and 100 percent coverage, the baseline is compact.',
    }],
  };
  let calls = 0;
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      calls += 1;
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title'
            ? '模型规模'
            : '总体而言，约 5 万个可能的 token、1.24 亿个参数、8,400 个样本和 100% 的覆盖率构成了**紧凑的基线模型**。',
        })),
      });
    },
  });
  assert.equal(calls, 1);
  assert.match(renderTranslatedDocument(translated), /5 万.*1\.24 亿.*8,400.*100%/);
});

test('金融缩写 bn 与中文亿元金额按数值等价校验', () => {
  const unit = {
    id: 'b000001', kind: 'list_item',
    text: 'Nvidia invested $1.5 bn in SB Energy for an Ohio AI data center.',
  };
  const assessment = assessTranslationUnit(unit, '英伟达向 SB Energy 投资 15 亿美元建设俄亥俄州 AI 数据中心。', { afterRepair: true });
  assert.deepEqual(assessment.hardErrors, []);
});

test('数量级不等价在两轮修复后保留具体复核原因', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Model Scale',
    author: '',
    sha256: 'wrong-shorthand-value',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'The model supports about 50k possible tokens.',
    }],
  };
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title' ? '模型规模' : '该模型支持约 6 万个可能的 token。',
        })),
      });
    },
  });
  assert.equal(translated.validationExceptions.length, 1);
  assert.match(translated.validationExceptions[0].reasons.join(' '), /数字或链接不等价/);
});

test('ProgramBench 回归:百分比不产生 100 误报，未展开宏和引用异常进入复核', async () => {
  const caption = 'Figure 8:\nConfusion matrix of reference vs. model language.\nEach cell shows the percentage (and count) of runs per reference language.';
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://arxiv.org/html/2605.03546v1',
    title: 'ProgramBench',
    author: '',
    sha256: 'programbench-regression',
    blocks: [
      {
        id: 'b000066',
        order: 0,
        type: 'paragraph',
        text: 'While most \\bench repositories lack a dedicated end-to-end test suite, we measure coverage across 100 repositories (§⟦SL_INLINE_001⟧).',
      },
      {
        id: 'b000074',
        order: 1,
        type: 'figure',
        caption,
        captionFragments: [{ token: '⟦SL_INLINE_001⟧', value: '[28](https://example.com/28)' }],
        images: [],
      },
      {
        id: 'b000075',
        order: 2,
        type: 'figure',
        caption,
        captionFragments: [{ token: '⟦SL_INLINE_001⟧', value: '[28](https://example.com/28)' }],
        images: [],
      },
    ],
  };
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title'
            ? 'ProgramBench'
            : unit.id === 'b000066'
              ? '虽然大多数 ⟦SL_INLINE_001⟧ 基准代码库缺乏端到端测试，但我们在 100 个代码库中测量覆盖率（§⟦SL_INLINE_001⟧）。'
              : '图 8：参考语言与模型语言的混淆矩阵。每个单元格显示每种参考语言下运行的百分比（和计数）。',
        })),
      });
    },
  });
  assert.deepEqual(translated.validationExceptions.map((item) => item.id), ['b000066']);
  assert.doesNotMatch(translated.validationWarnings.join(' '), /b000074:caption|b000075:caption|NUM:100/);
  assert.match(translated.validationExceptions[0].reasons.join(' '), /URL、占位符、Ticker 或型号标识不一致/);
});

test('自动修复返回空数组时重试一次并要求完整 ID 集合', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Returns',
    author: '',
    sha256: 'empty-repair-retry',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'The reported portfolio return was 100%.',
    }],
  };
  const requests = [];
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async (request) => {
      requests.push(request);
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(request.prompt)[1]);
      if (requests.length === 1) {
        return JSON.stringify({
          translations: payload.units.map((unit) => ({
            id: unit.id,
            text: unit.kind === 'title' ? '回报率' : '报告的投资组合回报率为 99%。',
          })),
        });
      }
      if (requests.length === 2) return JSON.stringify({ translations: [] });
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: '报告的投资组合回报率为 ⟦SL_KEEP_1⟧。',
        })),
      });
    },
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[1].responseFormat.json_schema.schema.properties.translations.minItems, 1);
  assert.equal(requests[1].responseFormat.json_schema.schema.properties.translations.maxItems, 1);
  assert.match(requests[2].prompt, /上一次修复响应缺少输入块/);
  assert.match(renderTranslatedDocument(translated), /100%/);
});

test('同段多个英文月份可忠实翻译为对应月份数字，其它数字仍保持一致', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'pdf',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a.pdf',
    title: 'Monthly Returns',
    author: '',
    sha256: 'multiple-months',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'The sample runs from January 1995 through December 2009, with a reported return of 8.04%.',
    }],
  };
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title'
            ? '月度回报'
            : '**样本期**从 1995 年 1 月持续到 2009 年 12 月，报告回报率为 8.04%。',
        })),
      });
    },
  });
  assert.match(renderTranslatedDocument(translated), /1995 年 1 月.*2009 年 12 月.*8\.04%/);
});

test('英文分数词组和月份可转换为对应数字且不放宽其它数字', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'pdf',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a.pdf',
    title: 'Assets',
    author: '',
    sha256: 'fraction-and-month-numbers',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'Assets exceeded one and a half trillion dollars from January 1995 through December 2009, based on 8,400 funds.',
    }],
  };
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title'
            ? '资产'
            : '**管理资产**超过 1.5 万亿美元，样本期从 1995 年 1 月持续到 2009 年 12 月，基于 8,400 只基金。',
        })),
      });
    },
  });
  assert.match(renderTranslatedDocument(translated), /1\.5 万亿美元.*1995 年 1 月.*2009 年 12 月.*8,400/);
});

test('英文 billion 与中文亿按数值等价校验，异常高亮只做安全清理', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'pdf',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a.pdf',
    title: 'Assets',
    author: '',
    sha256: 'billion-to-yi',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'In 1990, 530 hedge funds managed about $50 billion, and the industry continued to expand during the sample.',
    }],
  };
  let calls = 0;
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      calls += 1;
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title'
            ? '资产'
            : calls === 1
              ? '**1990 年，530 只对冲基金管理着约 500 亿美元，行业在样本期内继续扩张。**'
              : '1990 年，530 只对冲基金管理着约 $50 0 亿美元，行业在样本期内继续扩张。',
        })),
      });
    },
  });
  assert.equal(calls, 1);
  assert.match(renderTranslatedDocument(translated), /500 亿美元/);
  assert.doesNotMatch(renderTranslatedDocument(translated), /\$50 0 亿美元/);
});

test('英文数字词可选择性译为阿拉伯数字，但原有数字仍必须全部保留', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'pdf',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a.pdf',
    title: 'Constraints',
    author: '',
    sha256: 'selective-word-number-expansion',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'Sharpe (1992) requires all weights to sum to one and allows each weight to be above one. The S&P 500 benchmark is retained.',
    }],
  };
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title'
            ? '约束'
            : 'Sharpe（1992）的**权重约束**要求全部权重之和为 1，并允许单项权重大于 1，同时保留 S&P 500 基准。',
        })),
      });
    },
  });
  assert.match(renderTranslatedDocument(translated), /1992.*为 1.*大于 1.*500/);
});

test('b000067 回归：zero/one 可忠实译为 0/1，型号中的数字保持独立', () => {
  const assessment = assessTranslationUnit({
    id: 'b000067',
    kind: 'paragraph',
    text: 'The Mamba-2 state is set to one, reset to zero, and remains between zero and one.',
  }, 'Mamba-2 状态设为 1、重置为 0，并保持在 0 和 1 之间。', { afterRepair: true });
  assert.deepEqual(assessment.hardErrors, []);
  assert.deepEqual(assessment.warnings, []);
});

test('Opening Digest 回归：一致预期中的一不得误判为新增数字', () => {
  const source = {
    id: 'body-11',
    kind: 'paragraph',
    text: 'EPS was -$0.68 against a consensus estimate of -$0.86, a 21% beat.',
  };
  const equivalent = assessTranslationUnit(
    source,
    'EPS 为 -$0.68，而一致预期为 -$0.86，超出预期 21%。',
    { afterRepair: true },
  );
  assert.deepEqual(equivalent.hardErrors, []);

  const actualNumber = assessTranslationUnit(
    source,
    'EPS 为 -$0.68，而一致预期为 -$0.86，超出预期 21%，记为 1。',
    { afterRepair: true },
  );
  assert.match(actualNumber.hardErrors.join(' '), /译文新增不等值数字/);
});

test('b000036 回归：纯公式与引用占位符不被 SL_INLINE 名称误判为未翻译', () => {
  const assessment = assessTranslationUnit({
    id: 'b000036',
    kind: 'paragraph',
    text: '⟦SL_INLINE_001⟧\n⟦SL_INLINE_002⟧\n⟦SL_INLINE_003⟧\n⟦SL_INLINE_004⟧\n⟦SL_INLINE_005⟧\n⟦SL_INLINE_006⟧\n.',
  }, '⟦SL_INLINE_001⟧ ⟦SL_INLINE_002⟧ ⟦SL_INLINE_003⟧ ⟦SL_INLINE_004⟧ ⟦SL_INLINE_005⟧ ⟦SL_INLINE_006⟧ 。', {
    afterRepair: true,
  });
  assert.deepEqual(assessment.hardErrors, []);
  assert.deepEqual(assessment.warnings, []);
});

test('b000011 回归：分号分隔的作者机构专名列表不误判为未翻译', () => {
  const assessment = assessTranslationUnit({
    id: 'b000011',
    kind: 'paragraph',
    text: 'Affiliations:\nTom Cunningham (METR); Lukas Althoff (Stanford University); Basil Halperin (University of Virginia); Brian Jabarian (Carnegie Mellon University and Google AI); Andrew Koh (Columbia University); Arjun Ramani (MIT); Phil Trammell (Stanford DEL and Epoch AI); Parker Whitfill (METR); Cheryl Wu (Yale University).',
  }, '机构：Tom Cunningham（METR）；Lukas Althoff（Stanford University）；Basil Halperin（University of Virginia）；Brian Jabarian（Carnegie Mellon University and Google AI）；Andrew Koh（Columbia University）；Arjun Ramani（MIT）；Phil Trammell（Stanford DEL and Epoch AI）；Parker Whitfill（METR）；Cheryl Wu（Yale University）。', {
    afterRepair: true,
  });
  assert.deepEqual(assessment.hardErrors, []);
  assert.deepEqual(assessment.warnings, []);

  const untranslatedProse = assessTranslationUnit({
    id: 'b000012',
    kind: 'paragraph',
    text: 'The first model estimates demand; the second model estimates supply; the final model combines both results for policy analysis.',
  }, 'The first model estimates demand; the second model estimates supply; the final model combines both results for policy analysis.', {
    afterRepair: true,
  });
  assert.match(untranslatedProse.hardErrors.join(' '), /疑似未完成翻译/);
});

test('复合英文数字词、序数和中文数字表达按数值等价通过', () => {
  const complex = assessTranslationUnit({
    id: 'b000001',
    kind: 'paragraph',
    text: 'Twenty-two thousand five hundred and eighty samples were split into first, second, and fourth groups.',
  }, '22,580 个样本被分成第 1、第 2 和第 4 组。', { afterRepair: true });
  assert.deepEqual(complex.hardErrors, []);
  assert.deepEqual(complex.warnings, []);

  const chinesePercent = assessTranslationUnit({
    id: 'b000002',
    kind: 'paragraph',
    text: 'The reported value was 100%.',
  }, '报告值为百分之百。', { afterRepair: true });
  assert.deepEqual(chinesePercent.hardErrors, []);
});

test('英文复数数量级可忠实译为中文概数，但不同数量级仍被拒绝', () => {
  const unit = {
    id: 'b000034:caption',
    kind: 'figure_caption',
    text: 'A long tail runs into the hundreds.',
  };
  const equivalent = assessTranslationUnit(unit, '长尾延伸至数百次。', { afterRepair: true });
  assert.deepEqual(equivalent.hardErrors, []);
  assert.deepEqual(equivalent.warnings, []);

  const changed = assessTranslationUnit(unit, '长尾延伸至数千次。', { afterRepair: true });
  assert.match(changed.hardErrors.join(' '), /译文新增不等值数字/);

  const dozens = assessTranslationUnit({
    id: 'opening-digest-body-5',
    kind: 'paragraph',
    text: 'Dozens of AI-infrastructure companies fell more than 5%.',
  }, '数十家 AI 基础设施公司跌幅超过 5%。', { afterRepair: true });
  assert.deepEqual(dozens.hardErrors, []);
  assert.deepEqual(dozens.warnings, []);
});

test('英文 both 可忠实译为中文“两者”，但不得扩成三者', () => {
  const unit = {
    id: 'b000128',
    kind: 'paragraph',
    text: 'This covers both training and inference because we don’t think there is a meaningful difference.',
  };
  const equivalent = assessTranslationUnit(
    unit,
    '这涵盖了训练和推理，因为我们认为两者之间没有实质性区别。',
    { afterRepair: true },
  );
  assert.deepEqual(equivalent.hardErrors, []);
  assert.deepEqual(equivalent.warnings, []);

  const changed = assessTranslationUnit(
    unit,
    '这涵盖了训练、推理和部署，因为我们认为三者之间没有实质性区别。',
    { afterRepair: true },
  );
  assert.match(changed.hardErrors.join(' '), /译文新增不等值数字/);
});

test('低置信度数字差异不消耗修复请求，只告警并写入 checkpoint', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Phases',
    author: '',
    sha256: 'numeric-warning',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'The first phase uses a pair of branches.',
    }],
  };
  const workDir = tempDir();
  let calls = 0;
  const translated = await translateDocument({
    source,
    workDir,
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      calls += 1;
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title' ? '阶段' : '第 1 阶段使用 2 个分支。',
        })),
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(translated.validationWarnings.length, 1);
  assert.match(translated.validationWarnings[0], /低置信度数字格式差异/);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(workDir, 'translation-checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.warnings.length, 1);
  assert.equal(checkpoint.validationExceptions.length, 1);
});

test('同批缺失译文仍硬失败，已通过单元立即保留到 checkpoint', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Batch',
    author: '',
    sha256: 'partial-batch-checkpoint',
    blocks: [
      { id: 'b000001', order: 0, type: 'paragraph', text: 'The first value is 100.' },
      { id: 'b000002', order: 1, type: 'paragraph', text: 'The second value is 200.' },
    ],
  };
  const workDir = tempDir();
  await assert.rejects(() => translateDocument({
    source,
    workDir,
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.filter((unit) => unit.id !== 'b000002').map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title'
            ? '批次'
            : '第一个值是 100。',
        })),
      });
    },
  }), /b000002/);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(workDir, 'translation-checkpoint.json'), 'utf8'));
  assert.deepEqual(
    checkpoint.translations.map((item) => item.id).sort(),
    ['b000001', 'meta:title'],
  );
});

test('金融语境 pre-fee 不得误译为税前，历史断点译文也会确定性纠正', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'pdf',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a.pdf',
    title: 'Returns',
    author: '',
    sha256: 'pre-fee-terminology',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'We estimate a pre-fee return of 11.42% for the complete sample.',
    }],
  };
  const workDir = tempDir();
  await translateDocument({
    source,
    workDir,
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title' ? '回报' : '我们估计完整样本的**税前回报**为 11.42%。',
        })),
      });
    },
  });
  const checkpoint = JSON.parse(fs.readFileSync(path.join(workDir, 'translation-checkpoint.json'), 'utf8'));
  assert.match(checkpoint.translations.find((item) => item.id === 'b000001').text, /税前回报/);
  const translated = await translateDocument({
    source,
    workDir,
    model: 'test-model',
    writer: {},
    resumeFromCheckpoint: true,
    completeArticle: async () => {
      throw new Error('有效断点不应重新调用模型');
    },
  });
  const article = renderTranslatedDocument(translated);
  assert.match(article, /费用前回报/);
  assert.doesNotMatch(article, /税前回报/);
});

test('旧 checkpoint 按新 token 规则重验，只重做异常单元并保留其它进度', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/macro',
    title: 'Macro benchmark',
    author: '',
    sha256: 'checkpoint-token-migration',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: String.raw`The \bench score is 10%.`,
    }],
  };
  const workDir = tempDir();
  const validResponse = ({ prompt }) => {
    const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
    return JSON.stringify({
      translations: payload.units.map((unit) => ({
        id: unit.id,
        text: unit.kind === 'title' ? '宏基准' : String.raw`\bench 分数是 10%。`,
      })),
    });
  };
  await translateDocument({
    source,
    workDir,
    model: 'test-model',
    writer: {},
    completeArticle: validResponse,
  });

  const checkpointPath = path.join(workDir, 'translation-checkpoint.json');
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  checkpoint.translations.find((item) => item.id === 'b000001').text = 'ProgramBench 分数是 10%。';
  checkpoint.warnings = [];
  checkpoint.validationExceptions = [];
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint));

  let calls = 0;
  const progress = [];
  const translated = await translateDocument({
    source,
    workDir,
    model: 'test-model',
    writer: {},
    resumeFromCheckpoint: true,
    onProgress: async (event) => progress.push(event.message),
    completeArticle: async (request) => {
      calls += 1;
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(request.prompt)[1]);
      assert.deepEqual(payload.units.map((unit) => unit.id), ['b000001']);
      return validResponse(request);
    },
  });
  assert.equal(calls, 1);
  assert.match(progress[0], /1 个旧单元需重做/);
  assert.match(translated.blocks[0].translatedText, /\\bench/);
});

test('短碎片文档自适应到每批最多 48 个单元，尽早写入分块 checkpoint', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'pdf',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a.pdf',
    title: 'Batch Test',
    author: '',
    sha256: 'bounded-translation-batches',
    blocks: Array.from({ length: 49 }, (_, index) => ({
      id: `b${String(index + 1).padStart(6, '0')}`,
      order: index,
      type: 'paragraph',
      text: `Source item ${index + 1}.`,
    })),
  };
  const batchSizes = [];
  const workDir = tempDir();
  await translateDocument({
    source,
    workDir,
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      batchSizes.push(payload.units.length);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title' ? '批次测试' : `译文条目 ${unit.text.match(/\d+/)[0]}。`,
        })),
      });
    },
  });
  const checkpoint = JSON.parse(fs.readFileSync(path.join(workDir, 'translation-checkpoint.json'), 'utf8'));
  assert.deepEqual(batchSizes, [48, 2]);
  assert.equal(checkpoint.translations.length, 50);
});

test('单个长翻译最多并行两个初译批次并记录批次 telemetry 上下文', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/concurrent',
    title: 'Concurrent translation',
    author: '',
    sha256: 'concurrent-translation-batches',
    blocks: Array.from({ length: 72 }, (_, index) => ({
      id: `b${String(index + 1).padStart(6, '0')}`,
      order: index,
      type: 'paragraph',
      text: 'This deliberately long source paragraph contains enough ordinary prose to keep adaptive batching on the conservative document path while preserving faithful translation behavior.',
    })),
  };
  let active = 0;
  let maxActive = 0;
  const contexts = [];
  await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    batchConcurrency: 2,
    completeArticle: async ({ prompt, inferenceContext }) => {
      contexts.push(inferenceContext);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title' ? '并发翻译' : '这是一段完整、忠实且清晰的中文译文，用于验证受限并发不会破坏结构化翻译结果。',
        })),
      });
    },
  });
  assert.equal(maxActive, 2);
  assert.equal(contexts.length, 4);
  assert.deepEqual(contexts.map((item) => item.batchIndex).sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.ok(contexts.every((item) => item.phase === 'initial' && item.batchTotal === 4));
});

test('并发批次首错后停止领取新批次，并等待已启动请求结束再失败', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/concurrent-failure',
    title: 'Concurrent failure',
    author: '',
    sha256: 'concurrent-failure-settles',
    blocks: Array.from({ length: 72 }, (_, index) => ({
      id: `b${String(index + 1).padStart(6, '0')}`,
      order: index,
      type: 'paragraph',
      text: 'This deliberately long source paragraph keeps the conservative batch limit active while testing deterministic failure settlement across workers.',
    })),
  };
  const started = [];
  let secondSettled = false;
  await assert.rejects(() => translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    batchConcurrency: 2,
    completeArticle: async ({ inferenceContext }) => {
      started.push(inferenceContext.batchIndex);
      if (inferenceContext.batchIndex === 1) throw new Error('first batch failed');
      await new Promise((resolve) => setTimeout(resolve, 20));
      secondSettled = true;
      throw new Error('second batch stopped');
    },
  }), /first batch failed/);
  assert.equal(secondSettled, true);
  assert.deepEqual(started.sort((a, b) => a - b), [1, 2]);
});

test('结构化响应连续截断时自动缩小批次并完成翻译', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/split-recovery',
    title: 'Split recovery',
    author: '',
    sha256: 'split-recovery-after-truncated-json',
    blocks: Array.from({ length: 8 }, (_, index) => ({
      id: `b${String(index + 1).padStart(6, '0')}`,
      order: index,
      type: 'paragraph',
      text: `Source item ${index + 1}.`,
    })),
  };
  const batchSizes = [];
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      batchSizes.push(payload.units.length);
      if (payload.units.length > 6) return '{"translations":[';
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title' ? '分批恢复' : `译文条目 ${unit.text.match(/\d+/)[0]}。`,
        })),
      });
    },
  });

  assert.deepEqual(batchSizes, [9, 9, 6, 3]);
  assert.equal(translated.translatedTitle, '分批恢复');
  assert.equal(translated.blocks.length, 8);
  assert.equal(translated.blocks.at(-1).translatedText, '译文条目 8。');
});

test('异常高亮不会触发内容重译，安全清理后保留完整数字', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'pdf',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a.pdf',
    title: 'Returns',
    author: '',
    sha256: 'prefer-hard-valid-original',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'The reported portfolio return was 100% and remained stable across the complete sample.',
    }],
  };
  let calls = 0;
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      calls += 1;
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title'
            ? '回报'
            : calls === 1
              ? '**报告的投资组合回报率为 100%，并在整个完整样本期间持续保持稳定且没有明显变化。**'
              : '报告的投资组合回报率为 99%，并在整个完整样本期间持续保持稳定且没有明显变化。',
        })),
      });
    },
  });
  assert.equal(calls, 1);
  assert.match(renderTranslatedDocument(translated), /100%/);
  assert.doesNotMatch(renderTranslatedDocument(translated), /99%/);
});

test('完整性门禁拒绝额外添加或遗漏图片、表格和公式', () => {
  const tablePath = path.join(tempDir(), 'table.png');
  fs.writeFileSync(tablePath, Buffer.from([1]));
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Title',
    sha256: 'hash',
    blocks: [
      { id: 'b000001', order: 0, type: 'paragraph', text: 'Body.' },
      {
        id: 'b000002',
        order: 1,
        type: 'table',
        caption: '',
        captionFragments: [],
        rows: [[{ text: 'A', fragments: [] }]],
        localPath: tablePath,
      },
    ],
  };
  const translated = {
    ...source,
    translatedTitle: '标题',
    blocks: [{ ...source.blocks[0], translatedText: '正文。' }, source.blocks[1]],
  };
  const result = validateTranslationArtifact({
    source,
    translated,
    article: '---\ntitle: 标题\n---\n![图](x.png)\n| A | B |\n| --- | --- |\n',
  });
  assert.match(result.errors.join(';'), /原文图片数量不一致/);
  assert.match(result.errors.join(';'), /原文表格图片数量不一致/);
});

test('URL 安全拦截 localhost、私网和保留地址', async () => {
  for (const value of [
    '127.0.0.1', '10.0.0.1', '192.168.1.2', '169.254.1.2',
    '192.0.2.1', '198.51.100.2', '203.0.113.3', '::1', 'fd00::1', '2001:db8::1',
  ]) assert.equal(isPrivateIp(value), true);
  assert.equal(isPrivateIp('93.184.216.34'), false);
  await assert.rejects(() => assertSafeHttpUrl('http://localhost/a'), /本机或内部地址/);
  await assert.rejects(() => assertSafeHttpUrl('https://public.example/a', {
    dnsLookup: async () => [{ address: '10.1.2.3', family: 4 }],
  }), /私网或保留地址/);
  await assert.doesNotReject(() => assertSafeHttpUrl('https://public.example/a', { dnsLookup: PUBLIC_DNS }));
});

test('代理合成 DNS 仅在公共 DNS 返回安全公网地址时放行，下载仍固定到公网地址', async () => {
  const syntheticDns = async () => [{ address: '198.18.1.82', family: 4 }];
  const publicDnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  await assert.doesNotReject(() => assertSafeHttpUrl('https://public.example/a', {
    dnsLookup: syntheticDns, publicDnsLookup,
  }));
  await assert.rejects(() => assertSafeHttpUrl('https://public.example/a', {
    dnsLookup: syntheticDns,
    publicDnsLookup: async () => [{ address: '10.1.2.3', family: 4 }],
  }), /公共 DNS 未返回安全公网地址/);
  await assert.rejects(() => assertSafeHttpUrl('https://public.example/a', {
    dnsLookup: async () => [{ address: '198.18.1.82', family: 4 }, { address: '10.1.2.3', family: 4 }],
    publicDnsLookup: async () => { throw new Error('不应调用公共 DNS'); },
  }), /私网或保留地址/);
  let pinnedAddresses;
  const result = await safeFetchResource({
    url: 'https://public.example/paper.pdf', dnsLookup: syntheticDns, publicDnsLookup,
    pinnedFetchFactory: addresses => {
      pinnedAddresses = addresses;
      return async () => new Response('%PDF-fixture', { headers: { 'content-type': 'application/pdf' } });
    },
  });
  assert.deepEqual(pinnedAddresses, [{ address: '93.184.216.34', family: 4 }]);
  assert.equal(result.buffer.toString(), '%PDF-fixture');
});

test('忠实翻译读取 Hugging Face PDF 时使用原文件地址并保留原链接', async () => {
  const sourceUrl = 'https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL/blob/main/MiMo_V2_6_technical_report.pdf';
  const requested = [];
  await assert.rejects(() => acquireSourceDocument({
    sourceUrl, workDir: tempDir(), dnsLookup: PUBLIC_DNS, config: { browserEnabled: false },
    fetchFn: async (url) => {
      requested.push(String(url));
      return new Response('missing', { status: 404 });
    },
  }), /原文获取失败:404/);
  assert.deepEqual(requested, [sourceUrl.replace('/blob/', '/resolve/')]);
});

test('验证码页面拒绝产稿', async () => {
  await assert.rejects(() => acquireSourceDocument({
    sourceUrl: 'https://example.com/captcha',
    workDir: tempDir(),
    fetchFn: async () => new Response('<html><body>Verify you are human captcha</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    fetchWithRetry: async (fetch, url, options) => fetch(url, options),
    config: { browserEnabled: false },
    dnsLookup: PUBLIC_DNS,
  }), /验证码或反机器人/);

  await assert.rejects(() => acquireSourceDocument({
    sourceUrl: 'https://example.com/cloudflare-challenge',
    workDir: tempDir(),
    fetchFn: async () => new Response(
      `<html><head><title>Just a moment...</title></head><body>
        <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>
        <div>${'challenge bootstrap '.repeat(200)}</div>
      </body></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    ),
    fetchWithRetry: async (fetch, url, options) => fetch(url, options),
    config: { browserEnabled: false },
    dnsLookup: PUBLIC_DNS,
  }), /验证码或反机器人/);
});

test('安全下载 deadline 同时覆盖 DNS、响应头和卡住的响应体', async () => {
  const limits = { fetchTimeoutMs: 30, maxSourceBytes: 1024 };
  let lateFetches = 0;
  await assert.rejects(safeFetchResource({
    url: 'https://example.com/dns', limits,
    dnsLookup: () => new Promise((resolve) => setTimeout(() => resolve([{ address: '93.184.216.34', family: 4 }]), 50)),
    fetchFn: async () => { lateFetches++; return new Response('ok'); },
  }), /下载超时/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(lateFetches, 0);
  let headerSignal;
  await assert.rejects(safeFetchResource({
    url: 'https://example.com/headers', limits, dnsLookup: PUBLIC_DNS,
    fetchFn: (_url, { signal }) => { headerSignal = signal; return new Promise(() => {}); },
  }), /下载超时/);
  assert.equal(headerSignal.aborted, true);
  let bodyCancelled = false;
  await assert.rejects(safeFetchResource({
    url: 'https://example.com/body', limits, dnsLookup: PUBLIC_DNS,
    fetchFn: async () => new Response(new ReadableStream({ cancel() { bodyCancelled = true; } })),
  }), /下载超时/);
  assert.equal(bodyCancelled, true);
});

test('安全下载向 retry 传统一 timeout 参数，并保留调用者取消原因', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('fixture cancelled'), { code: 'TASK_CANCELLED' });
  let cancelled = false;
  const pending = safeFetchResource({
    url: 'https://example.com/stream', signal: controller.signal, dnsLookup: PUBLIC_DNS,
    limits: { fetchTimeoutMs: 500, maxSourceBytes: 1024 },
    fetchFn: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })),
    fetchWithRetry: async (fetchFn, url, options, retry) => {
      assert.equal(retry.timeout, 500);
      assert.equal(retry.timeoutMs, undefined);
      setTimeout(() => controller.abort(reason), 20);
      return fetchFn(url, options);
    },
  });
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(cancelled, true);
});

test('预下载响应只在请求 URL 匹配时复用，arxiv 仍优先官方 HTML', async () => {
  const html = `<html><head><title>Example</title></head><body><article><h1>Example</h1><p>${'Long source text. '.repeat(60)}</p></article></body></html>`;
  const prefetched = { sourceUrl: 'https://example.com/article', finalUrl: 'https://example.com/article', contentType: 'text/html', buffer: Buffer.from(html) };
  let requests = 0;
  const acquire = (extra) => acquireSourceDocument({
    workDir: tempDir(), config: { browserEnabled: false }, dnsLookup: PUBLIC_DNS,
    fetchFn: async (url) => { requests++; assert.equal(String(url), 'https://arxiv.org/html/2401.12345'); return new Response(html); },
    ...extra,
  });
  const source = await acquire({ sourceUrl: prefetched.sourceUrl, prefetched });
  assert.equal(source.title, 'Example');
  assert.equal(requests, 0);
  await acquire({ sourceUrl: 'https://arxiv.org/pdf/2401.12345', prefetched: {
    ...prefetched, sourceUrl: 'https://arxiv.org/pdf/2401.12345', finalUrl: 'https://arxiv.org/pdf/2401.12345',
  } });
  assert.equal(requests, 1);
});

test('checkpoint 每个成功批次只写一次，恢复时复用全部已验证单元', async () => {
  const events = [];
  const workDir = tempDir();
  const source = {
    version: 5, sourceType: 'html', sourceUrl: 'https://example.com/checkpoint', title: 'Batch', sha256: 'batch-write-fixture',
    blocks: Array.from({ length: 7 }, (_, index) => ({ id: `b${index}`, type: 'paragraph', order: index, text: `Item ${index + 1}.` })),
  };
  const args = { source, workDir, model: 'fixture', writer: {}, completeArticle: jsonTranslator(), onTelemetry: event => events.push(event) };
  await translateDocument(args);
  assert.equal(events.filter(event => event.stage === 'translation-checkpoint' && !event.cacheHit).length, 1);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(workDir, 'translation-checkpoint.json')));
  assert.equal(checkpoint.translations.length, 8);
  await translateDocument({ ...args, resumeFromCheckpoint: true, completeArticle: () => { throw new Error('cache miss'); } });
  assert.equal(events.filter(event => event.cacheHit).at(-1).count, 8);
});

test('真实 DeepSeek 适配器 length 响应触发有界拆批，持续截断仍硬失败', async () => {
  const { createModel } = await import('../src/core/model.js');
  const { loadConfig } = await import('../src/config/index.js');
  const source = {
    version: 5, sourceType: 'html', sourceUrl: 'https://example.com/split', title: 'Split', sha256: 'real-adapter-split',
    blocks: Array.from({ length: 8 }, (_, index) => ({ id: `b${index}`, type: 'paragraph', order: index, text: `Item ${index + 1}.` })),
  };
  for (const alwaysTruncate of [false, true]) {
    const sizes = [];
    const model = createModel(loadConfig({ DEEPSEEK_API_KEY: 'fixture-key' }), { fetchFn: async (_url, request) => {
      const prompt = JSON.parse(request.body).messages.at(-1).content;
      const { units } = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      sizes.push(units.length);
      const truncated = alwaysTruncate || units.length > 6;
      const content = truncated ? '{"translations":[' : JSON.stringify({ translations: units.map(unit => ({
        id: unit.id, text: unit.kind === 'title' ? '分批译文' : `条目 ${unit.text.match(/\d+/)[0]}。`,
      })) });
      return Response.json({ choices: [{ finish_reason: truncated ? 'length' : 'stop', message: { content } }] });
    } });
    const operation = translateDocument({ source, workDir: tempDir(), model: 'fixture', writer: {}, completeArticle: args => model.complete(args) });
    if (alwaysTruncate) {
      await assert.rejects(operation, error => error.code === 'MODEL_TRUNCATED' && error.retryableTranslationResponse);
      assert.deepEqual(sizes, [9, 9, 6, 6]);
    } else {
      const translated = await operation;
      assert.deepEqual(sizes, [9, 9, 6, 3]);
      assert.equal(translated.blocks.at(-1).translatedText, '条目 8。');
    }
  }
});
