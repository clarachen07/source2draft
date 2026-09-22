import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { acquireSourceDocument, safeFetchResource, sourceDownloadUrl } from '../workflows/translation-source-text.js';
import { withTaskCancellation } from '../lib/task-cancellation.js';
import { fetchRetry, writeAtomic } from '../lib/io.js';
import { emitTelemetry } from '../lib/telemetry.js';

export const DOWNLOAD_LIMITS = { maxSourceBytes: 50 * 1024 * 1024, maxRedirects: 5, fetchTimeoutMs: 45000 };
export function inputUrls(input) {
  const clean = String(input).replace(/<(https?:\/\/[^>|]+)(?:\|[^>]*)?>/g, '$1').replace(/&amp;/g, '&');
  return [...new Set((clean.match(/https?:\/\/[^\s<>"\u3000]+/gi) || []).map(value => {
    let url = value.replace(/\\([()[\]])/g, '$1');
    // Strip prose/Markdown wrappers, but retain balanced delimiters in the URL.
    for (;;) {
      const before = url;
      url = url.replace(/[。，；！？、,;）】]+$/, '');
      for (const [open, close] of [['(', ')'], ['[', ']']]) {
        if (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1);
      }
      if (url === before) return url;
    }
  }))];
}
// Keep cover URLs separate from source materials in both content workflows.
export function coverUrls(input) {
  const mentions = String(input).matchAll(/(?:封面(?:图片|图)?|\bcover(?:\s*\(?image\)?)?)\s*(?:[:：]|(?:改成|换成|改为|换为|改用|换用|使用|设为|用|to\b|use\b)\s*[:：]?)\s*(<https?:\/\/[^>\r\n]+>|https?:\/\/[^\s<>"\u3000]+)/gi);
  return [...new Set([...mentions].flatMap(match => inputUrls(match[1])))];
}
export function normalizeFiles(files = []) {
  return files.filter(f => f.id && (f.url_private_download || f.url_private)).map(f => ({
    id: f.id, name: f.name || f.title || f.id, mimetype: f.mimetype || '',
    url: f.url_private_download || f.url_private, size: f.size || 0,
  }));
}
export function attachmentHeaders(file, config) {
  const url = new URL(file.url);
  if (url.protocol !== 'https:' || !['files.slack.com', 'files-origin.slack.com'].includes(url.hostname)) throw new Error('附件不是 Slack 官方私有文件地址');
  return { Authorization: `Bearer ${config.slack.botToken}` };
}
export const translationConfig = config => ({
  ...DOWNLOAD_LIMITS, browserEnabled: true, browserExecutablePath: config.browser, batchConcurrency: 2,
  datalabApiKey: config.datalabKey, datalabMode: 'balanced', maxPdfPages: 120,
});
export async function download(url, { signal, headers = {}, fetchFn = globalThis.fetch, limits = DOWNLOAD_LIMITS } = {}) {
  return safeFetchResource({ url, fetchFn: withTaskCancellation(fetchFn, signal), fetchWithRetry: fetchRetry, headers, limits, signal });
}
export { sourceDownloadUrl };
export function documentText(document) {
  const inlineText = (text, fragments = []) => {
    let restored = String(text || '');
    for (const fragment of fragments) {
      const value = String(fragment.value || '');
      // PDF link fragments often point to short-lived signed download URLs.
      // The visible citation text is useful evidence; the temporary URL is not.
      const visible = /^\[([^\]]*)\]\(https?:\/\//.exec(value)?.[1] || value;
      restored = restored.replaceAll(fragment.token, visible);
    }
    if (/⟦SL_INLINE_\d+⟧/.test(restored)) throw new Error('原文内联公式或引用未能还原，已停止写作');
    return restored;
  };
  return document.blocks.map((block) => {
    const parts = [];
    if (block.text) parts.push(inlineText(block.text, block.fragments));
    if (block.caption && block.caption !== block.text) parts.push(inlineText(block.caption, block.captionFragments));
    if (block.tex) parts.push(`公式：${block.tex}`);
    for (const row of block.rows || []) parts.push(row.map((cell) =>
      typeof cell === 'string' ? cell : inlineText(cell?.text, cell?.fragments)).join(' | '));
    parts.push(...(block.images || []).map((image) => image.alt || '').filter(Boolean));
    return parts.join('\n');
  }).filter(Boolean).join('\n\n');
}
async function githubText(rawUrl, signal, fetchFn) {
  const url = new URL(rawUrl), pieces = url.pathname.split('/').filter(Boolean);
  const [owner, repo, kind, ref, ...file] = pieces;
  if (!owner || !repo) throw new Error('请提供具体的 GitHub 仓库或文件链接');
  let endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`;
  if (kind === 'blob' && ref && file.length) endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${file.map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
  else if (kind) throw new Error('GitHub 第一版支持公开仓库首页（README）或 blob 文件链接，请指定所需文件');
  const result = await download(endpoint, { signal, fetchFn, headers: { Accept: 'application/vnd.github+json' } });
  const data = JSON.parse(result.buffer.toString());
  if (data.encoding !== 'base64' || typeof data.content !== 'string' || !data.content) throw new Error('GitHub 文件不可读取，请提供公开文本文件或将文件上传 Slack');
  return { title: `${owner}/${repo} · ${data.path}`, text: Buffer.from(data.content, 'base64').toString('utf8'), url: rawUrl,
    note: kind ? '指定公开文件' : '仅读取仓库 README，不代表已审阅整个代码仓库' };
}
export async function readSource({ url, file, config, workDir, signal, fetchFn = globalThis.fetch, onTelemetry }) {
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const sourceUrl = file?.url || url;
  const headers = file ? attachmentHeaders(file, config) : {};
  if (!file && new URL(sourceUrl).hostname === 'github.com') return githubText(sourceUrl, signal, fetchFn);
  const start = performance.now();
  const downloadUrl = sourceDownloadUrl(sourceUrl);
  const fetched = await download(downloadUrl, { signal, headers, fetchFn });
  emitTelemetry(onTelemetry, { stage: 'source_download', count: 1, cacheHit: false, durationMs: Math.round(performance.now() - start) });
  const isPdf = fetched.buffer.subarray(0, 5).toString() === '%PDF-';
  const pdfHint = /pdf/i.test(file?.mimetype || '') || /\.pdf(?:[?#]|$)/i.test(file?.name || sourceUrl);
  if (isPdf || pdfHint) {
    if (!isPdf) throw new Error(`PDF 签名不正确：${file?.name || sourceUrl}；请检查 Slack files:read 权限`);
    const document = await acquireSourceDocument({ sourceUrl, workDir, requestHeaders: headers,
      config: translationConfig(config), fetchFn: withTaskCancellation(fetchFn, signal), fetchWithRetry: fetchRetry, signal,
      prefetched: { ...fetched, sourceUrl: downloadUrl }, onTelemetry });
    writeAtomic(path.join(workDir, 'source-document.json'), document);
    return { title: document.title || file?.name || sourceUrl, url: file ? '' : sourceUrl, text: documentText(document),
      assets: document.blocks.flatMap(b => [...(b.images || []).map(i => i.localPath), b.localPath].filter(Boolean)) };
  }
  const raw = fetched.buffer.toString('utf8');
  if (file && /^(text\/|application\/(json|xml))/.test(file.mimetype)) {
    if (/<html|<!doctype html/i.test(raw.slice(0, 300)) && !/html/i.test(file.mimetype)) throw new Error('附件返回登录页，未取得文本内容');
    return { title: file.name, url: '', text: raw };
  }
  if (!file && /text\/plain|text\/markdown/.test(fetched.contentType)) return { title: sourceUrl, url: sourceUrl, text: raw };
  if (file && !/html/i.test(file.mimetype)) throw new Error(`不支持附件 ${file.name}，请使用 PDF、TXT、Markdown 或 JSON`);
  const dom = new JSDOM(raw, { url: fetched.finalUrl });
  try {
    const article = new Readability(dom.window.document).parse();
    if (!article?.textContent?.trim() || article.textContent.trim().length < 120) throw new Error(`未取得完整网页正文：${sourceUrl}；请将原文导出 PDF 上传`);
    return { title: article.title || sourceUrl, url: sourceUrl, text: article.textContent.trim() };
  } finally { dom.window.close(); }
}
