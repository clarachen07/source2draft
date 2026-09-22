import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { raceWithSignal, readLimitedResponse, withDeadline } from '../lib/http-deadline.js';
import { throwIfTaskCancelled } from '../lib/task-cancellation.js';

const DEFAULT_BASE_URL = 'https://www.datalab.to/api/v1';

export async function convertPdfWithDatalab({
  pdfBuffer,
  filename = 'source.pdf',
  pageRange,
  workDir,
  config = {},
  fetchFn = globalThis.fetch,
  onProgress,
  sleepFn = sleep,
  signal,
}) {
  throwIfTaskCancelled(signal);
  const apiKey = String(config.datalabApiKey || '').trim();
  if (!apiKey) {
    throw new Error('PDF 结构化翻译需要 DATALAB_API_KEY；当前运行环境尚未配置');
  }
  const baseUrl = trustedBaseUrl(config.datalabBaseUrl || DEFAULT_BASE_URL);
  const modes = unique([config.datalabMode || 'balanced', 'accurate']);
  const expectedPageIds = pageIdsFromRange(pageRange);
  let result;
  const attempts = [];

  for (const mode of modes) {
    await safeReport(onProgress, {
      stage: 'source',
      message: `正在通过 Datalab 解析 PDF${pageRange ? `（页码 ${pageRange}）` : ''}，模式 ${mode}`,
    });
    result = await submitAndPoll({
      pdfBuffer,
      filename,
      pageRange,
      mode,
      baseUrl,
      apiKey,
      fetchFn,
      sleepFn,
      timeoutMs: positive(config.datalabTimeoutMs, 5 * 60 * 1000),
      pollIntervalMs: positive(config.datalabPollIntervalMs, 2000),
      expectedPageIds,
      maxResponseBytes: positive(config.maxDatalabResponseBytes, 64 * 1024 * 1024),
      signal,
    });
    attempts.push({
      mode,
      requestId: result.requestId,
      parseQualityScore: numberOrUndefined(result.parse_quality_score),
      pageCount: numberOrUndefined(result.page_count),
      completionWaits: result.completionWaits || 0,
      costBreakdown: result.cost_breakdown || undefined,
    });
    const quality = numberOrUndefined(result.parse_quality_score);
    if (quality !== undefined && quality >= 3) break;
  }

  if (!result?.html?.trim()) throw new Error('Datalab PDF 解析完成但 HTML 结果为空');
  const quality = numberOrUndefined(result.parse_quality_score);
  if (quality === undefined || quality < 3) {
    throw new Error(`Datalab PDF 解析质量不足:${quality ?? '缺失'}/5（已尝试 ${attempts.map((item) => item.mode).join('、')}）`);
  }
  const coverage = assertDatalabResultComplete(result, { expectedPageIds });
  const assets = writeExtractedImages(result.images, {
    workDir,
    maxCount: positive(config.maxAssetCount, 80),
    maxTotalBytes: positive(config.maxAssetBytes, 40 * 1024 * 1024),
    maxSingleBytes: positive(config.maxSingleAssetBytes, 10 * 1024 * 1024),
  });
  return {
    html: result.html,
    images: assets,
    metadata: result.metadata || {},
    pageCount: numberOrUndefined(result.page_count),
    parseQualityScore: numberOrUndefined(result.parse_quality_score),
    pageIds: coverage.pageIds,
    htmlTextCharacters: coverage.htmlTextCharacters,
    htmlImageCount: coverage.htmlImageCount,
    resultImageCount: coverage.resultImageCount,
    attempts,
  };
}

async function submitAndPoll({
  pdfBuffer,
  filename,
  pageRange,
  mode,
  baseUrl,
  apiKey,
  fetchFn,
  sleepFn,
  timeoutMs,
  pollIntervalMs,
  expectedPageIds,
  maxResponseBytes,
  signal,
}) {
  // Submission and polling share one absolute budget, including response bodies.
  return withDeadline({ signal, timeoutMs, message: 'Datalab PDF 解析超时' }, async (requestSignal) => {
    const deadline = Date.now() + timeoutMs;
    const form = new FormData();
    form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), safeFilename(filename));
    form.append('output_format', 'html');
    form.append('mode', mode);
    form.append('paginate', 'true');
    form.append('add_block_ids', 'true');
    form.append('disable_image_extraction', 'false');
    form.append('disable_image_captions', 'true');
    form.append('extras', 'extract_links');
    if (pageRange) form.append('page_range', pageRange);

    const submitted = await fetchJson(fetchFn, `${baseUrl}/convert`, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: form,
    }, { timeoutMs, signal: requestSignal, maxResponseBytes });
    if (!submitted?.success || !submitted.request_id || !submitted.request_check_url) {
      throw new Error(`Datalab PDF 解析提交失败:${safeError(submitted?.error || '响应缺少 request_id')}`);
    }
    const checkUrl = validateCheckUrl(submitted.request_check_url, baseUrl, submitted.request_id);
    let completionWaits = 0;
    let lastIncomplete = [];
    for (;;) {
      throwIfTaskCancelled(requestSignal);
      if (Date.now() >= deadline) {
        if (lastIncomplete.length) {
          throw new Error(`Datalab PDF 完成结果不完整:${lastIncomplete.join('; ')}（等待 ${timeoutMs}ms 后仍未稳定）`);
        }
        throw new Error(`Datalab PDF 解析超时:${timeoutMs}ms`);
      }
      const status = await fetchJson(fetchFn, checkUrl, {
        headers: { 'X-API-Key': apiKey },
      }, { timeoutMs: Math.min(30000, Math.max(1, deadline - Date.now())), signal: requestSignal, maxResponseBytes });
      if (status?.status === 'failed' || status?.success === false) {
        throw new Error(`Datalab PDF 解析失败:${safeError(status?.error || status?.status)}`);
      }
      if (status?.status === 'complete' || (status?.success === true && status?.html)) {
        const inspected = inspectDatalabResult(status, { expectedPageIds });
        if (!inspected.issues.length) {
          return {
            ...status,
            requestId: submitted.request_id,
            completionWaits,
          };
        }
        lastIncomplete = inspected.issues;
        completionWaits += 1;
      }
      await raceWithSignal(requestSignal, () => sleepFn(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), requestSignal));
    }
  });
}

export function assertDatalabResultComplete(result, { expectedPageIds } = {}) {
  const inspected = inspectDatalabResult(result, { expectedPageIds });
  if (inspected.issues.length) {
    throw new Error(`Datalab PDF 结果不完整:${inspected.issues.join('; ')}`);
  }
  return inspected;
}

export function inspectDatalabResult(result, { expectedPageIds } = {}) {
  const issues = [];
  const html = String(result?.html || '');
  const pageCount = numberOrUndefined(result?.page_count);
  const quality = numberOrUndefined(result?.parse_quality_score);
  if (!html.trim()) issues.push('HTML 为空');
  if (!Number.isInteger(pageCount) || pageCount < 1) issues.push('page_count 缺失或无效');
  if (quality === undefined || quality < 0 || quality > 5) issues.push('parse_quality_score 缺失或无效');

  let document;
  try { document = new JSDOM(html).window.document; }
  catch { issues.push('HTML 无法解析'); }
  const pageNodes = document ? [...document.querySelectorAll('.page[data-page-id]')] : [];
  const pageIds = pageNodes.map((node) => Number(node.getAttribute('data-page-id')));
  const expected = Array.isArray(expectedPageIds) && expectedPageIds.length
    ? expectedPageIds
    : Number.isInteger(pageCount) && pageCount > 0
      ? Array.from({ length: pageCount }, (_, index) => index)
      : [];
  if (pageNodes.length !== expected.length) {
    issues.push(`分页容器数量不一致:${pageNodes.length}/${expected.length || '未知'}`);
  }
  if (pageIds.some((id) => !Number.isInteger(id)) || new Set(pageIds).size !== pageIds.length) {
    issues.push('分页 ID 缺失、重复或无效');
  } else if (expected.length && pageIds.join(',') !== expected.join(',')) {
    issues.push(`分页 ID 不连续或范围不一致:${pageIds.join(',') || '无'}`);
  }
  if (Number.isInteger(pageCount) && expected.length && pageCount !== expected.length) {
    issues.push(`处理页数不一致:${pageCount}/${expected.length}`);
  }

  const htmlImages = document ? [...document.querySelectorAll('img[src]')] : [];
  const htmlImageKeys = new Set(htmlImages
    .map((image) => normalizeAssetKey(image.getAttribute('src')))
    .filter(Boolean));
  const resultImageKeys = new Set(Object.keys(result?.images || {}).map(normalizeAssetKey).filter(Boolean));
  const htmlImageAliases = new Set([...htmlImageKeys].flatMap((key) => [key, path.basename(key)]));
  const resultImageAliases = new Set([...resultImageKeys].flatMap((key) => [key, path.basename(key)]));
  const missingImages = [...htmlImageKeys].filter((key) => !resultImageAliases.has(key));
  const unreferencedImages = [...resultImageKeys].filter((key) => !htmlImageAliases.has(key));
  if (missingImages.length) issues.push(`HTML 图片缺少返回资产:${missingImages.slice(0, 5).join(',')}`);
  if (unreferencedImages.length) issues.push(`返回图片未被 HTML 引用:${unreferencedImages.slice(0, 5).join(',')}`);

  return {
    issues,
    pageIds,
    htmlTextCharacters: document
      ? String(document.body?.textContent || '').replace(/\s+/g, '').length
      : 0,
    htmlImageCount: htmlImages.length,
    resultImageCount: resultImageKeys.size,
  };
}

function validateCheckUrl(rawUrl, baseUrl, requestId) {
  let check;
  let base;
  try {
    check = new URL(rawUrl);
    base = new URL(baseUrl);
  } catch {
    throw new Error('Datalab 返回的结果查询 URL 无效');
  }
  if (check.protocol !== 'https:') throw new Error('Datalab 结果查询只允许 HTTPS');
  const allowedHosts = new Set([base.hostname]);
  if (base.hostname === 'www.datalab.to') allowedHosts.add('api.datalab.to');
  if (base.hostname === 'api.datalab.to') allowedHosts.add('www.datalab.to');
  if (!allowedHosts.has(check.hostname)) throw new Error('Datalab 结果查询 URL 指向非信任主机');
  if (!check.pathname.startsWith('/api/v1/')) throw new Error('Datalab 结果查询 URL 路径无效');
  if (!check.pathname.includes(encodeURIComponent(String(requestId)))) {
    throw new Error('Datalab 结果查询 URL 与 request_id 不一致');
  }
  check.username = '';
  check.password = '';
  check.hash = '';
  return check.toString();
}

function writeExtractedImages(images, { workDir, maxCount, maxTotalBytes, maxSingleBytes }) {
  const entries = Object.entries(images || {});
  if (entries.length > maxCount) throw new Error(`Datalab 图片数量超过上限:${entries.length}/${maxCount}`);
  const assetDir = path.join(workDir, 'translation-assets');
  fs.mkdirSync(assetDir, { recursive: true });
  const mapped = {};
  let total = 0;
  for (const [index, [originalName, encoded]] of entries.entries()) {
    const { buffer, extension } = decodeImage(encoded, originalName);
    if (!buffer.length) throw new Error(`Datalab 图片为空:${originalName}`);
    if (buffer.length > maxSingleBytes) {
      throw new Error(`Datalab 单张图片超过上限:${originalName} ${buffer.length}/${maxSingleBytes}`);
    }
    total += buffer.length;
    if (total > maxTotalBytes) throw new Error(`Datalab 图片总量超过上限:${total}/${maxTotalBytes}`);
    const filename = `figure-${String(index + 1).padStart(3, '0')}${extension}`;
    const target = path.join(assetDir, filename);
    fs.writeFileSync(target, buffer, { mode: 0o600 });
    mapped[normalizeAssetKey(originalName)] = target;
    mapped[normalizeAssetKey(path.basename(originalName))] = target;
  }
  return mapped;
}

function decodeImage(value, originalName) {
  const text = typeof value === 'string' ? value : String(value?.base64 || value?.data || '');
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(text);
  const buffer = Buffer.from(match ? match[2] : text, 'base64');
  const detected = imageExtension(buffer);
  if (!detected) throw new Error(`Datalab 返回了不支持的图片格式:${originalName}`);
  return { buffer, extension: detected };
}

function imageExtension(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return '.gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return '';
}

async function fetchJson(fetchFn, url, options, { timeoutMs, signal, maxResponseBytes }) {
  return withDeadline({ signal, timeoutMs, message: 'Datalab 网络请求超时' }, async (requestSignal) => {
    const response = await fetchFn(url, { ...options, redirect: 'error', signal: requestSignal });
    if (requestSignal.aborted) void response.body?.cancel?.().catch(() => {});
    throwIfTaskCancelled(requestSignal);
    const body = await readLimitedResponse(response, response.ok ? maxResponseBytes : 64 * 1024, requestSignal);
    if (!response.ok) throw new Error(`Datalab HTTP ${response.status}:${safeError(body.toString('utf8') || response.statusText)}`);
    try { return JSON.parse(body.toString('utf8')); }
    catch { throw new Error('Datalab 返回了无效 JSON'); }
  });
}

function normalizeAssetKey(value) {
  const raw = String(value || '').split(/[?#]/)[0];
  try { return decodeURIComponent(raw).replace(/^\.?\//, ''); }
  catch { return raw.replace(/^\.?\//, ''); }
}

function safeFilename(value) {
  const name = path.basename(String(value || 'source.pdf')).replace(/[^A-Za-z0-9._-]+/g, '-');
  return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
}

function safeError(value) {
  return String(value?.message || value || '未知错误').replace(/\s+/g, ' ').slice(0, 300);
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function trustedBaseUrl(value) {
  let url;
  try { url = new URL(trimSlash(value)); }
  catch { throw new Error('Datalab API 地址无效'); }
  if (url.protocol !== 'https:' || !['www.datalab.to', 'api.datalab.to'].includes(url.hostname)) {
    throw new Error('Datalab API 地址必须是受信任的 HTTPS 主机');
  }
  if (url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/api/v1')) {
    throw new Error('Datalab API 地址格式无效');
  }
  return url.toString().replace(/\/$/, '');
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function numberOrUndefined(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function pageIdsFromRange(value) {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  const ids = [];
  for (const part of raw.split(',')) {
    const range = /^(\d+)-(\d+)$/.exec(part.trim());
    const single = /^(\d+)$/.exec(part.trim());
    if (single) {
      ids.push(Number(single[1]));
      continue;
    }
    if (!range || Number(range[2]) < Number(range[1])) return undefined;
    for (let id = Number(range[1]); id <= Number(range[2]); id += 1) ids.push(id);
  }
  return ids;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

async function safeReport(onProgress, progress) {
  if (!onProgress) return;
  try { await onProgress(progress); } catch {}
}
