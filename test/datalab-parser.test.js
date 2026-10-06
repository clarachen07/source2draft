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

function completeResult(pageIds = [0], quality = 4.5) {
  return {
    success: true, status: 'complete', page_count: pageIds.length, parse_quality_score: quality,
    html: pageIds.map(id => `<div class="page" data-page-id="${id}"><p>Source page ${id}.</p></div>`).join(''),
    images: {},
  };
}

function submission(requestId) {
  return jsonResponse({ success: true, request_id: requestId,
    request_check_url: `https://www.datalab.to/api/v1/convert/${requestId}` });
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

test('Datalab 轮询断网后复用已付费任务，完整结果在后续重试中无需联网', async t => {
  const workDir = tempDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const args = { pdfBuffer: Buffer.from('%PDF resume fixture'), workDir,
    config: { datalabApiKey: 'fixture-resume-key' }, sleepFn: async () => {} };
  let submissions = 0, polls = 0;
  const fetchFn = async (url, options = {}) => {
    if (options.method === 'POST') { submissions++; return submission('req-resume'); }
    polls++;
    const saved = fs.readdirSync(path.join(workDir, 'datalab-requests')).map(name =>
      fs.readFileSync(path.join(workDir, 'datalab-requests', name), 'utf8'));
    assert.equal(saved.length, 1);
    assert.equal(JSON.parse(saved[0]).requestId, 'req-resume');
    assert.equal(JSON.parse(saved[0]).status, 'pending');
    assert.ok(!saved[0].includes(args.config.datalabApiKey));
    if (polls === 1) throw new Error('fixture connection reset');
    assert.match(String(url), /req-resume$/);
    return jsonResponse(completeResult());
  };
  await assert.rejects(convertPdfWithDatalab({ ...args, fetchFn }), /connection reset/);
  const resumed = await convertPdfWithDatalab({ ...args, fetchFn });
  const cached = await convertPdfWithDatalab({ ...args, fetchFn: async () => { throw new Error('unexpected request'); } });
  assert.equal(submissions, 1);
  assert.equal(polls, 2);
  assert.deepEqual(cached, resumed);
  await assert.rejects(convertPdfWithDatalab({ ...args, config: { ...args.config, maxDatalabResponseBytes: 32 },
    fetchFn: async () => { throw new Error('unexpected request'); } }), /缓存结果超过大小上限/);
});

test('Datalab 轮询超时保留任务，未完整的返回结果不会当成已完成缓存', async t => {
  const workDir = tempDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const args = { pdfBuffer: Buffer.from('%PDF timeout fixture'), workDir,
    config: { datalabApiKey: 'fixture-key', datalabTimeoutMs: 30 }, sleepFn: async () => {} };
  let submissions = 0, polls = 0;
  await assert.rejects(convertPdfWithDatalab({ ...args, fetchFn: async (_url, options = {}) => {
    if (options.method === 'POST') { submissions++; return submission('req-timeout'); }
    if (++polls === 1) return jsonResponse({ ...completeResult(), parse_quality_score: null });
    return new Promise(() => {});
  } }), /超时/);
  const result = await convertPdfWithDatalab({ ...args, config: { ...args.config, datalabTimeoutMs: 1000 },
    fetchFn: async (url, options = {}) => {
      assert.notEqual(options.method, 'POST');
      assert.match(String(url), /req-timeout$/);
      return jsonResponse(completeResult());
    } });
  assert.equal(submissions, 1);
  assert.equal(result.parseQualityScore, 4.5);
});

test('Datalab 缓存分别匹配 PDF 内容、页码和解析模式', async t => {
  const workDir = tempDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  let submissions = 0;
  const pages = new Map();
  const fetchFn = async (url, options = {}) => {
    if (options.method === 'POST') {
      const id = `req-key-${++submissions}`;
      pages.set(id, Number(options.body.get('page_range') || 0));
      return submission(id);
    }
    return jsonResponse(completeResult([pages.get(String(url).split('/').at(-1))]));
  };
  const args = { pdfBuffer: Buffer.from('%PDF key fixture A'), pageRange: '0', workDir,
    config: { datalabApiKey: 'fixture-key' }, fetchFn };
  await convertPdfWithDatalab(args);
  await convertPdfWithDatalab(args);
  await convertPdfWithDatalab({ ...args, pdfBuffer: Buffer.from('%PDF key fixture B') });
  const selected = await convertPdfWithDatalab({ ...args, pageRange: '1' });
  await convertPdfWithDatalab({ ...args, config: { ...args.config, datalabMode: 'accurate' } });
  assert.equal(submissions, 4);
  assert.deepEqual(selected.pageIds, [1]);
});

test('Datalab balanced 升级 accurate 中断后分别复用完成结果与待处理任务', async t => {
  const workDir = tempDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const submissions = [], polls = [];
  let interrupted = false;
  const args = { pdfBuffer: Buffer.from('%PDF quality fixture'), workDir,
    config: { datalabApiKey: 'fixture-key' }, fetchFn: async (url, options = {}) => {
      if (options.method === 'POST') {
        const mode = options.body.get('mode'); submissions.push(mode);
        return submission(`req-${mode}`);
      }
      const mode = String(url).endsWith('req-accurate') ? 'accurate' : 'balanced';
      polls.push(mode);
      if (mode === 'accurate' && !interrupted) { interrupted = true; throw new Error('fixture interrupted accurate'); }
      const result = completeResult([0], mode === 'accurate' ? 4.8 : 2.4);
      if (mode === 'balanced') {
        result.html = result.html.replace('</div>', '<img src="unfinished.png"></div>');
        result.images = { 'unfinished.png': '' };
      }
      return jsonResponse(result);
    } };
  await assert.rejects(convertPdfWithDatalab(args), /interrupted accurate/);
  const result = await convertPdfWithDatalab(args);
  assert.deepEqual(submissions, ['balanced', 'accurate']);
  assert.deepEqual(polls, ['balanced', 'accurate', 'accurate']);
  assert.equal(result.parseQualityScore, 4.8);
  assert.deepEqual(result.attempts.map(attempt => attempt.mode), ['balanced', 'accurate']);
});

test('Datalab 高质量结果的图片未齐时保留原任务，补齐后才缓存完整结果', async t => {
  const workDir = tempDir();
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  let submissions = 0, polls = 0;
  const args = { pdfBuffer: Buffer.from('%PDF delayed image fixture'), workDir,
    config: { datalabApiKey: 'fixture-key' }, fetchFn: async (_url, options = {}) => {
      if (options.method === 'POST') return submission(`req-images-${++submissions}`);
      const result = completeResult();
      result.html = result.html.replace('</div>', '<img src="figure.png"></div>');
      result.images = { 'figure.png': ++polls === 1 ? '' : PNG };
      return jsonResponse(result);
    } };
  await assert.rejects(convertPdfWithDatalab(args), /图片格式/);
  const cacheFile = path.join(workDir, 'datalab-requests', fs.readdirSync(path.join(workDir, 'datalab-requests'))[0]);
  assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).status, 'pending');
  const recovered = await convertPdfWithDatalab(args);
  assert.equal(submissions, 1);
  assert.equal(polls, 2);
  assert.ok(fs.existsSync(recovered.images['figure.png']));
  assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).status, 'complete');
  await convertPdfWithDatalab({ ...args, fetchFn: async () => { throw new Error('unexpected request'); } });
});

test('Datalab 仅明确失败或任务不存在才允许下次重试重新提交', async t => {
  for (const failure of [404, 410, 'failed', 401, 500]) {
    const workDir = tempDir();
    t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
    let submissions = 0, polls = 0;
    const args = { pdfBuffer: Buffer.from('%PDF terminal fixture'), workDir,
      config: { datalabApiKey: 'fixture-key' }, fetchFn: async (_url, options = {}) => {
        if (options.method === 'POST') return submission(`req-terminal-${++submissions}`);
        if (++polls === 1) return failure === 'failed'
          ? jsonResponse({ status: 'failed', success: false, error: 'fixture failed' })
          : jsonResponse({ error: 'fixture HTTP error' }, failure);
        return jsonResponse(completeResult());
      } };
    await assert.rejects(convertPdfWithDatalab(args), /Datalab/);
    assert.equal(submissions, 1, '本次调用不会因失败立即重复付费提交');
    await convertPdfWithDatalab(args);
    assert.equal(submissions, [404, 410, 'failed'].includes(failure) ? 2 : 1);
  }
});
