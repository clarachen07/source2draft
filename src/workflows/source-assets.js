import { assertProjectPath } from '../lib/project-path.js';
import { mapBounded } from '../lib/bounded-map.js';
import fs from 'node:fs';
import path from 'node:path';
import { acquireRuntimeResource } from '../config/runtime.js';
import { withDeadline } from '../lib/http-deadline.js';
import { emitTelemetry } from '../lib/telemetry.js';
import { safeFetchResource } from '../lib/secure-http.js';
import { throwIfTaskCancelled } from '../lib/task-cancellation.js';
import { hash, escapeHtml } from '../lib/io.js';
import { DEFAULT_LIMITS, limitsFor, positive } from './translation-config.js';


export async function localizeFigureAssets(blocks, {
  workDir, fetchFn, fetchWithRetry, config = {}, dnsLookup, assetMap, signal,
}) {
  const images = blocks.filter(block => block.type === 'figure').flatMap(block => block.images || []);
  const limits = limitsFor(config);
  if (images.length > limits.maxAssetCount) throw new Error(`原文图片数量超过上限:${images.length}/${limits.maxAssetCount}`);
  const assetDir = path.join(workDir, 'translation-assets', 'converted');
  assertProjectPath(workDir, assetDir);
  fs.mkdirSync(assetDir, { recursive: true, mode: 0o700 });
  let downloadedBytes = 0;
  const unique = [...new Set(images.map(image => image.src))];
  // Fetch first, without holding the browser permit during network waits.
  const downloaded = await mapBounded(unique, 3, async src => {
    const mapped = mappedAssetPath(src, assetMap);
    let buffer, contentType = '';
    if (mapped) {
      const file = fs.realpathSync(mapped);
      if (!file.startsWith(fs.realpathSync(workDir) + path.sep) || fs.lstatSync(mapped).isSymbolicLink()) {
        throw new Error('原文资产不能位于任务目录之外或是符号链接');
      }
      if (fs.statSync(file).size > limits.maxSingleAssetBytes) throw new Error('原文单张图片超过上限');
      buffer = fs.readFileSync(file);
    } else if (/^data:image\//i.test(src)) {
      ({ buffer, contentType } = decodeDataImage(src));
    } else {
      const fetched = await safeFetchResource({ url: src, fetchFn, fetchWithRetry, limits, dnsLookup,
        headers: {}, accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml;q=0.9,*/*;q=0.1',
        maxBytes: limits.maxSingleAssetBytes, signal });
      ({ buffer, contentType } = fetched);
    }
    throwIfTaskCancelled(signal);
    if (buffer.length > limits.maxSingleAssetBytes) throw new Error('原文单张图片超过上限');
    downloadedBytes += buffer.length;
    if (downloadedBytes > limits.maxAssetBytes) throw new Error('原文图片总量超过上限');
    const kind = detectImageKind(buffer, contentType);
    if (!kind) throw new Error(`原文图片格式不受支持:${src}`);
    return { src, mapped, buffer, kind };
  }, signal);
  const cache = new Map(), contentCache = new Map();
  let totalBytes = 0;
  const browserSession = createRasterBrowserSession(config, signal);
  try {
    for (const { src, mapped, buffer, kind } of downloaded) {
      throwIfTaskCancelled(signal);
      const digest = hash(buffer);
      if (contentCache.has(digest)) { cache.set(src, contentCache.get(digest)); continue; }
      let target;
      if (['.svg', '.webp'].includes(kind.extension)) {
        target = path.join(assetDir, `image-${hash({ digest, rasterVersion: 1 })}.png`);
        assertProjectPath(workDir, target);
        await (config.imageRasterizer || rasterizeImageToPng)({ buffer, contentType: kind.contentType,
          target, config, signal, browserSession });
        throwIfTaskCancelled(signal);
        if (!fs.existsSync(target) || detectImageKind(fs.readFileSync(target), '')?.extension !== '.png') {
          throw new Error(`原文图片转 PNG 结果格式无效:${src}`);
        }
      } else {
        target = mapped || path.join(assetDir, `${digest}${kind.extension}`);
        if (!mapped) { assertProjectPath(workDir, target); fs.writeFileSync(target, buffer, { mode: 0o600 }); }
      }
      const size = fs.statSync(target).size;
      if (!size || size > limits.maxSingleAssetBytes) throw new Error('原文图片处理后超过上限或为空');
      totalBytes += size;
      if (totalBytes > limits.maxAssetBytes) throw new Error('原文图片总量超过上限');
      contentCache.set(digest, target); cache.set(src, target);
    }
    for (const image of images) image.localPath = cache.get(image.src);
  } finally { await browserSession.close(); }
}

export async function localizeTableAssets(blocks, {
  workDir,
  config = {},
  signal,
}) {
  const tables = blocks.filter((block) => block.type === 'table');
  if (!tables.length) return;
  const figures = blocks.filter((block) => block.type === 'figure')
    .flatMap((block) => block.images || []);
  const limits = limitsFor(config);
  if (figures.length + tables.length > limits.maxAssetCount) {
    throw new Error(`原文图表数量超过上限:${figures.length + tables.length}/${limits.maxAssetCount}`);
  }
  const rasterize = config.tableRasterizer || rasterizeTableHtml;
  const assetDir = path.join(workDir, 'translation-assets');
  assertProjectPath(workDir, assetDir);
  fs.mkdirSync(assetDir, { recursive: true });
  const uniqueFigurePaths = new Set(figures.map((image) => image.localPath).filter(Boolean));
  let totalBytes = [...uniqueFigurePaths].reduce((sum, file) => {
    try { return sum + fs.statSync(file).size; }
    catch { return sum; }
  }, 0);

  const browserSession = createRasterBrowserSession(config, signal);
  try {
    for (const [index, table] of tables.entries()) {
      throwIfTaskCancelled(signal);
      const target = path.join(assetDir, `table-${hash({ html: table.sourceHtml || tableHtmlFromRows(table.rows), rasterVersion: 1 })}.png`);
      assertProjectPath(workDir, target);
      await rasterize({
        html: table.sourceHtml || tableHtmlFromRows(table.rows),
        target,
        config,
        signal,
        browserSession,
      });
      throwIfTaskCancelled(signal);
      if (!fs.existsSync(target) || fs.statSync(target).size <= 0) {
        throw new Error(`原文表格图片生成失败:${table.id}`);
      }
      const size = fs.statSync(target).size;
      if (size > limits.maxSingleAssetBytes) {
        throw new Error(`原文单个表格图片超过上限:${size}/${limits.maxSingleAssetBytes}`);
      }
      totalBytes += size;
      if (totalBytes > limits.maxAssetBytes) {
        throw new Error(`原文图表总量超过上限:${totalBytes}/${limits.maxAssetBytes}`);
      }
      const kind = detectImageKind(fs.readFileSync(target), '');
      if (kind?.extension !== '.png') throw new Error(`原文表格图片不是有效 PNG:${table.id}`);
      table.localPath = target;
    }
  } finally { await browserSession.close(); }
}

async function rasterizeTableHtml({ html, target, config = {}, signal, browserSession }) {
  if (config.browserEnabled === false) {
    throw new Error('原文表格转图片需要启用 TRANSLATION_BROWSER_ENABLED');
  }
  return browserSession.withPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    javaScriptEnabled: false,
  }, async (page) => {
    await page.setContent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#fff}
#shallow-table-shell{display:inline-block;box-sizing:border-box;max-width:1560px;padding:20px;background:#fff}
#shallow-table-shell table{border-collapse:collapse;table-layout:auto;width:auto;max-width:1520px;color:#263445;background:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:22px;line-height:1.45}
#shallow-table-shell th,#shallow-table-shell td{border:1px solid #d7dce2;padding:10px 14px;vertical-align:middle;text-align:left;white-space:normal;overflow-wrap:normal;word-break:normal}
#shallow-table-shell th{font-weight:650;background:#f3f6f8}
#shallow-table-shell img{max-width:100%;height:auto}
</style></head><body><div id="shallow-table-shell">${String(html || '')}</div></body></html>`, {
      waitUntil: 'domcontentloaded',
      timeout: positive(config.browserTimeoutMs, DEFAULT_LIMITS.browserTimeoutMs),
    });
    throwIfTaskCancelled(signal);
    const table = page.locator('#shallow-table-shell table').first();
    if (await table.count() !== 1) throw new Error('原文表格 HTML 缺少 table 元素');
    await page.locator('#shallow-table-shell').screenshot({
      path: target,
      type: 'png',
      animations: 'disabled',
      caret: 'hide',
      omitBackground: false,
      timeout: positive(config.browserTimeoutMs, DEFAULT_LIMITS.browserTimeoutMs),
    });
  });
}

// One browser per localization batch; each untrusted item gets a fresh context.
// Keep network denial in the context so new pages cannot bypass it.
function createRasterBrowserSession(config, signal) {
  let browser;
  let releaseBrowser;
  const abortBrowser = () => { void browser?.close().catch(() => {}); };
  return {
    async withPage(options, operation) {
      throwIfTaskCancelled(signal);
      if (!browser) {
        const { chromium } = await import('playwright-core');
        const executablePath = browserExecutable(config);
        if (!executablePath) throw new Error('找不到用于原文图片转换的 Chrome/Chromium');
        releaseBrowser = await acquireRuntimeResource('browser', signal);
        browser = await chromium.launch({ executablePath, headless: true,
          args: ['--disable-background-networking', '--disable-default-apps', '--disable-extensions'] });
        emitTelemetry(config.onTelemetry, { stage: 'raster-browser-launch', count: 1 });
        signal?.addEventListener('abort', abortBrowser, { once: true });
        throwIfTaskCancelled(signal);
      }
      const context = await browser.newContext({ ...options, serviceWorkers: 'block' });
      const started = performance.now();
      try {
        return await withDeadline({ signal, timeoutMs: positive(config.browserTimeoutMs, DEFAULT_LIMITS.browserTimeoutMs), message: '原文图片转换超时' }, async (operationSignal) => {
          const abortContext = () => { void context.close().catch(() => {}); };
          operationSignal.addEventListener('abort', abortContext, { once: true });
          try {
            await context.route('**/*', (route) => route.abort('blockedbyclient'));
            await context.routeWebSocket('**/*', socket => socket.close());
            const page = await context.newPage();
            page.setDefaultTimeout(positive(config.browserTimeoutMs, DEFAULT_LIMITS.browserTimeoutMs));
            const result = await operation(page);
            throwIfTaskCancelled(operationSignal);
            return result;
          } finally { operationSignal.removeEventListener('abort', abortContext); }
        });
      } finally {
        await context.close().catch(() => {});
        emitTelemetry(config.onTelemetry, { stage: 'raster-item', count: 1, durationMs: performance.now() - started });
      }
    },
    async close() {
      signal?.removeEventListener('abort', abortBrowser);
      try { await browser?.close().catch(() => {}); }
      finally { releaseBrowser?.(); }
    },
  };
}

export function browserExecutable(config = {}) {
  const candidates = [
    config.browserExecutablePath,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

export function tableHtmlFromRows(rows = []) {
  const body = rows.map((row, rowIndex) => {
    const tag = rowIndex === 0 ? 'th' : 'td';
    return `<tr>${row.map((cell) => `<${tag}>${escapeHtml(cell?.text || '')}</${tag}>`).join('')}</tr>`;
  }).join('');
  return `<table>${body}</table>`;
}

export function mappedAssetPath(rawSrc, assetMap) {
  let pathname = '';
  try { pathname = decodeURIComponent(new URL(rawSrc).pathname).replace(/^\/+/, ''); }
  catch { pathname = decodeURIComponent(String(rawSrc || '').split(/[?#]/)[0]).replace(/^\.?\//, ''); }
  const candidates = [pathname, path.basename(pathname), String(rawSrc || '')];
  for (const candidate of candidates) {
    const mapped = assetMap?.[candidate];
    if (mapped && fs.existsSync(mapped) && fs.statSync(mapped).size > 0) return mapped;
  }
  return '';
}

function decodeDataImage(value) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(String(value || ''));
  if (!match) throw new Error('原文内嵌图片不是受支持的 base64 格式');
  return { contentType: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') };
}

export function detectImageKind(buffer, contentType) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: '.png', contentType: 'image/png' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { extension: '.jpg', contentType: 'image/jpeg' };
  if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return { extension: '.gif', contentType: 'image/gif' };
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { extension: '.webp', contentType: 'image/webp' };
  }
  const head = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('utf8').trimStart();
  if (/image\/svg\+xml/i.test(contentType) || /^<\?xml[\s\S]*?<svg\b/i.test(head) || /^<svg\b/i.test(head)) {
    return { extension: '.svg', contentType: 'image/svg+xml' };
  }
  return undefined;
}

async function rasterizeImageToPng({ buffer, contentType, target, config, signal, browserSession }) {
  throwIfTaskCancelled(signal);
  return browserSession.withPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2, javaScriptEnabled: false }, async (page) => {
    const dataUrl = `data:${contentType};base64,${buffer.toString('base64')}`;
    await page.setContent(`<style>html,body{margin:0;background:white}img{display:block;max-width:1400px;height:auto}</style><img id="asset" src="${dataUrl}">`);
    await page.locator('#asset').evaluate((image) => {
      if (image.complete && image.naturalWidth > 0) return;
      return new Promise((resolve, reject) => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', () => reject(new Error('图片解码失败')), { once: true });
      });
    });
    await page.locator('#asset').screenshot({ path: target, type: 'png', omitBackground: false });
  });
}
