import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertDatalabResultComplete,
  convertPdfWithDatalab,
} from '../src/workflows/datalab-parser.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z2S0AAAAASUVORK5CYII=';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zen-datalab-'));
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Datalab 按指定页码解析 PDF，低质量时自动升级 accurate 并落地图片', async () => {
  const submissions = [];
  const polls = new Map();
  const pages = Array.from({ length: 11 }, (_, index) => (
    `<div class="page" data-page-id="${index}">`
      + `${index === 0 ? '<h1>Paper</h1><figure><img src="image.png"></figure>' : ''}`
      + `<p>Body page ${index + 1} with enough source text.</p></div>`
  )).join('');
  const fetchFn = async (url, options = {}) => {
    if (String(url).endsWith('/convert')) {
      const mode = options.body.get('mode');
      submissions.push({
        mode,
        pageRange: options.body.get('page_range'),
        outputFormat: options.body.get('output_format'),
      });
      return jsonResponse({
        success: true,
        request_id: `req-${mode}`,
        request_check_url: `https://www.datalab.to/api/v1/convert/req-${mode}`,
      });
    }
    const accurate = String(url).endsWith('req-accurate');
    const key = accurate ? 'accurate' : 'balanced';
    const poll = (polls.get(key) || 0) + 1;
    polls.set(key, poll);
    if (poll === 1) {
      return jsonResponse({
        status: 'complete',
        success: true,
        html: '<div class="page" data-page-id="0"><p>Result is still hydrating.</p></div>',
        images: {},
        parse_quality_score: null,
        page_count: 11,
      });
    }
    return jsonResponse({
      status: 'complete',
      success: true,
      html: pages,
      images: { 'image.png': PNG },
      parse_quality_score: accurate ? 4.6 : 2.4,
      page_count: 11,
      metadata: { title: 'Paper' },
    });
  };
  const result = await convertPdfWithDatalab({
    pdfBuffer: Buffer.from('%PDF fixture'),
    pageRange: '0-10',
    workDir: tempDir(),
    config: { datalabApiKey: 'secret', datalabMode: 'balanced' },
    fetchFn,
    sleepFn: async () => {},
  });

  assert.deepEqual(submissions, [
    { mode: 'balanced', pageRange: '0-10', outputFormat: 'html' },
    { mode: 'accurate', pageRange: '0-10', outputFormat: 'html' },
  ]);
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(result.attempts.map((attempt) => attempt.completionWaits), [1, 1]);
  assert.equal(result.parseQualityScore, 4.6);
  assert.deepEqual(result.pageIds, Array.from({ length: 11 }, (_, index) => index));
  assert.equal(result.htmlImageCount, 1);
  assert.equal(result.resultImageCount, 1);
  assert.ok(fs.existsSync(result.images['image.png']));
  assert.match(result.html, /data-page-id="10"/);
});

test('Datalab 完成结果硬门禁拒绝缺页、无效质量分和未引用图片', () => {
  assert.throws(() => assertDatalabResultComplete({
    status: 'complete',
    success: true,
    page_count: 3,
    parse_quality_score: null,
    html: '<div class="page" data-page-id="0"><p>Only one page.</p></div>',
    images: { 'orphan.png': PNG },
  }, { expectedPageIds: [0, 1, 2] }), /分页容器数量不一致.*parse_quality_score|parse_quality_score.*分页容器数量不一致/);

  assert.throws(() => assertDatalabResultComplete({
    status: 'complete',
    success: true,
    page_count: 2,
    parse_quality_score: 4.5,
    html: '<div class="page" data-page-id="0"><p>A</p></div><div class="page" data-page-id="1"><p>B</p></div>',
    images: { 'orphan.png': PNG },
  }, { expectedPageIds: [0, 1] }), /返回图片未被 HTML 引用/);

  assert.doesNotThrow(() => assertDatalabResultComplete({
    status: 'complete',
    success: true,
    page_count: 2,
    parse_quality_score: 4.8,
    html: '<div class="page" data-page-id="2"><p>Page 3</p></div><div class="page" data-page-id="3"><p>Page 4</p></div>',
    images: {},
  }, { expectedPageIds: [2, 3] }));
});

test('Datalab 未配置密钥时明确失败', async () => {
  await assert.rejects(() => convertPdfWithDatalab({
    pdfBuffer: Buffer.from('%PDF fixture'),
    workDir: tempDir(),
    config: {},
  }), /DATALAB_API_KEY/);
});

test('Datalab 拒绝非信任结果查询主机', async () => {
  await assert.rejects(() => convertPdfWithDatalab({
    pdfBuffer: Buffer.from('%PDF fixture'),
    workDir: tempDir(),
    config: { datalabApiKey: 'secret' },
    fetchFn: async () => jsonResponse({
      success: true,
      request_id: 'req-1',
      request_check_url: 'https://attacker.example/api/v1/convert/req-1',
    }),
    sleepFn: async () => {},
  }), /非信任主机/);
});

test('Datalab API 基地址不能把密钥发送到非信任主机', async () => {
  await assert.rejects(() => convertPdfWithDatalab({
    pdfBuffer: Buffer.from('%PDF fixture'),
    workDir: tempDir(),
    config: {
      datalabApiKey: 'secret',
      datalabBaseUrl: 'https://attacker.example/api/v1',
    },
  }), /受信任的 HTTPS 主机/);
});

test('Datalab deadline 覆盖提交头部与响应体，超时取消流', async () => {
  for (const phase of ['headers', 'body']) {
    let requestSignal;
    let cancelled = false;
    await assert.rejects(convertPdfWithDatalab({
      pdfBuffer: Buffer.from('%PDF fixture'), workDir: tempDir(),
      config: { datalabApiKey: 'fixture-key', datalabTimeoutMs: 30 },
      fetchFn: async (_url, options) => {
        requestSignal = options.signal;
        assert.equal(options.redirect, 'error');
        if (phase === 'headers') return new Promise(() => {});
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
      },
    }), /超时/);
    assert.equal(requestSignal.aborted, true);
    if (phase === 'body') assert.equal(cancelled, true);
  }
});

test('Datalab JSON 响应有字节上限，任务取消保留原始原因', async () => {
  await assert.rejects(convertPdfWithDatalab({
    pdfBuffer: Buffer.from('%PDF fixture'), workDir: tempDir(),
    config: { datalabApiKey: 'fixture-key', maxDatalabResponseBytes: 32 },
    fetchFn: async () => new Response('x'.repeat(33)),
  }), /超过大小上限/);
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel fixture'), { code: 'TASK_CANCELLED' });
  let cancelled = false;
  const pending = convertPdfWithDatalab({
    pdfBuffer: Buffer.from('%PDF fixture'), workDir: tempDir(), signal: controller.signal,
    config: { datalabApiKey: 'fixture-key' },
    fetchFn: async () => {
      setTimeout(() => controller.abort(reason), 10);
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    },
  });
  await assert.rejects(pending, error => error === reason);
  assert.equal(cancelled, true);
});
