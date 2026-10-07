import { assertProjectPath } from '../lib/project-path.js';
import { localizeFigureAssets, localizeTableAssets, browserExecutable, tableHtmlFromRows, mappedAssetPath, detectImageKind } from './source-assets.js';
import { limitsFor, positive } from './translation-config.js';
import { DOCUMENT_VERSION, DEFAULT_LIMITS, DOCUMENT_BLOCK_TYPES } from './translation-config.js';
import { safeFetchResource, assertSafeHttpUrl, resolveSafeHttpUrl, readResponseBufferWithLimit, sourceDownloadUrl } from '../lib/secure-http.js';
import { translationUnits, translatedUnitText, assessTranslationUnit } from './translation-validation.js';
import { report, safeError, writeJsonAtomic } from './translation-utils.js';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { acquireRuntimeResource } from '../config/runtime.js';
import { promisify } from 'node:util';
import { readLimitedResponse, withDeadline } from '../lib/http-deadline.js';
import { emitTelemetry } from '../lib/telemetry.js';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import {
  cancellationErrorFromSignal,
  fetchUsesGlobalTransport,
  rebindFetchTransport,
  throwIfTaskCancelled,
} from '../lib/task-cancellation.js';
import { convertPdfWithDatalab } from './datalab-parser.js';
import {
  applyTranslationScope,
  datalabPageRange,
  isReferencesHeading,
  parseTranslationScope,
  scopeLabel,
} from './translation-scope.js';

// Single active translation source: retain document structure and visual assets while replacing only translatable units.
const EMBEDDED_CHART_MIN_WIDTH = 200;
const EMBEDDED_CHART_MIN_HEIGHT = 120;
const EMBEDDED_CHART_MAX_WIDTH = 2400;
const EMBEDDED_CHART_MAX_HEIGHT = 5000;
const EMBEDDED_CHART_MAX_PIXELS = 8_000_000;
const EMBEDDED_CHART_MIN_PNG_BYTES = 4096;
const execFileAsync = promisify(execFile);
const EXCLUDED_CONTENT_SELECTOR = [
  'script', 'style', 'noscript', 'nav', 'form', 'aside',
  'body > header', 'body > footer', 'video', 'audio', 'iframe',
  '[aria-hidden="true"]', '[hidden]', '.advertisement', '.advert', '.ads',
  '.related-posts', '.recommended', '.comments', '#comments', '.cookie-banner',
  '.newsletter-signup', '.social-share',
].join(',');

export async function acquireSourceDocument({
  sourceUrl,
  workDir,
  fetchFn = globalThis.fetch,
  fetchWithRetry,
  config = {},
  documentConfig = {},
  dnsLookup = dns.lookup,
  // Research readers share this downloader and still require the full source.
  // Translation supplies its explicit or automatic scope at the entrypoint.
  scope = { kind: 'all' },
  onProgress,
  requestHeaders = {},
  onTelemetry,
  prefetched,
  signal,
}) {
  throwIfTaskCancelled(signal);
  config = { ...config, onTelemetry: onTelemetry || config.onTelemetry };
  const limits = limitsFor(config);
  await withDeadline({ signal, timeoutMs: limits.fetchTimeoutMs },
    requestSignal => assertSafeHttpUrl(sourceUrl, { dnsLookup, signal: requestSignal }));
  if (/(^|\.)(?:notion\.so|notion\.site|linear\.app)$/.test(new URL(sourceUrl).hostname) || new URL(sourceUrl).hostname === 'docs.google.com') {
    throw new Error('第一版不支持私有文档平台；请导出 PDF 或文本后上传到 Slack');
  }
  fs.mkdirSync(workDir, { recursive: true });
  const acquisition = { attempts: [], fallbacks: [] };
  const arxiv = arxivSourceUrls(sourceUrl);
  let acquisitionUrl = arxiv ? (scope.kind === 'pages' ? arxiv.pdf : arxiv.html) : sourceDownloadUrl(sourceUrl);
  if (acquisitionUrl !== sourceUrl) acquisition.attempts.push(scope.kind === 'pages' ? 'arxiv-pdf' : 'arxiv-html');
  const acquisitionHeaders = requestHeaders;
  const reusableResponse = (url) => {
    if (!prefetched || prefetched.sourceUrl !== url || !Buffer.isBuffer(prefetched.buffer)) return undefined;
    if (!prefetched.buffer.length || prefetched.buffer.length > limits.maxSourceBytes) {
      throw new Error('预下载原文为空或超过大小上限');
    }
    emitTelemetry(config.onTelemetry, { stage: 'source-download', count: 1, cacheHit: true });
    return prefetched;
  };
  acquisition.attempts.push('static-http');
  let fetched;
  try {
    fetched = reusableResponse(acquisitionUrl) || await safeFetchResource({
      url: acquisitionUrl,
      fetchFn,
      fetchWithRetry,
      limits,
      dnsLookup,
      accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5',
      headers: acquisitionHeaders,
      signal,
    });
  } catch (error) {
    throwIfTaskCancelled(signal);
    if (arxiv && acquisitionUrl === arxiv.html) {
      acquisition.fallbacks.push(`arxiv-html:${safeError(error)}`);
      acquisitionUrl = arxiv.pdf;
      acquisition.attempts.push('arxiv-pdf-fallback');
      fetched = reusableResponse(acquisitionUrl) || await safeFetchResource({
        url: acquisitionUrl,
        fetchFn,
        fetchWithRetry,
        limits,
        dnsLookup,
        accept: 'application/pdf,*/*;q=0.5',
        headers: acquisitionHeaders,
        signal,
      });
    } else {
      if (scope.kind === 'pages' && !/\.pdf(?:$|[?#])/i.test(acquisitionUrl)) {
        throw new Error('该网页没有可验证的 PDF 分页；请提供 PDF 链接或改用章节范围');
      }
      if (config.browserEnabled === false || /\.pdf(?:$|[?#])/i.test(acquisitionUrl)) throw error;
      acquisition.fallbacks.push(`browser:静态请求失败:${safeError(error)}`);
      return acquireWithBrowser({
        sourceUrl: acquisitionUrl,
        attributionUrl: sourceUrl,
        workDir,
        config,
        limits,
        dnsLookup,
        acquisition,
        fetchFn,
        fetchWithRetry,
        scope,
        signal,
      });
    }
  }

  const contentType = String(fetched.contentType || '').toLowerCase();
  const pdfHint = contentType.includes('application/pdf')
    || /\.pdf(?:$|[?#])/i.test(fetched.finalUrl)
    || /\.pdf(?:$|[?#])/i.test(acquisitionUrl);
  const isPdf = hasPdfSignature(fetched.buffer);
  if (pdfHint && !isPdf) {
    assertPdfResponse({
      buffer: fetched.buffer,
      sourceUrl,
      finalUrl: fetched.finalUrl,
      contentType: fetched.contentType,
    });
  }
  if (isPdf) {
    acquisition.attempts.push('datalab-pdf');
    const document = await sourceDocumentFromPdf({
      pdfBuffer: fetched.buffer,
      sourceUrl,
      resolvedSourceUrl: fetched.finalUrl,
      workDir,
      limits,
      config,
      fetchFn,
      scope,
      onProgress,
      signal,
    });
    throwIfTaskCancelled(signal);
    document.acquisition = acquisition;
    return document;
  }
  if (scope.kind === 'pages') {
    throw new Error('该网页没有可验证的 PDF 分页；请提供 PDF 链接或改用章节范围');
  }

  const html = decodeHtmlBuffer(fetched.buffer, fetched.contentType);
  assertUsableArticleResponse(html, fetched.finalUrl);
  try {
    const document = await sourceDocumentFromHtml({
      html,
      sourceUrl,
      documentUrl: fetched.finalUrl,
      extractor: 'readability-static',
      deferAssets: true,
      workDir,
      fetchFn,
      fetchWithRetry,
      config,
      dnsLookup,
      scope,
      signal,
    });
    document.acquisition = acquisition;
    const embeddedCharts = inspectEmbeddedChartFrames(html, { documentUrl: fetched.finalUrl, sourceUrl, scope });
    const browserReason = embeddedCharts.detected > 0
      ? `静态 HTML 含 ${embeddedCharts.detected} 个需截图的嵌入图表`
      : '静态正文过短或疑似客户端渲染';
    if ((embeddedCharts.detected > 0 || shouldUseBrowser(document, html))
      && config.browserEnabled === false) {
      throw new Error(`网页含动态内容但浏览器抓取已关闭:${browserReason}`);
    }
    if ((embeddedCharts.detected > 0 || shouldUseBrowser(document, html))
      && config.browserEnabled !== false) {
      acquisition.fallbacks.push(`browser:${browserReason}`);
      return acquireWithBrowser({
        sourceUrl: fetched.finalUrl,
        attributionUrl: sourceUrl,
        workDir,
        config,
        limits,
        dnsLookup,
        acquisition,
        fetchFn,
        fetchWithRetry,
        scope,
        signal,
      });
    }
    await localizeFigureAssets(document.blocks, { workDir, fetchFn, fetchWithRetry, config, dnsLookup, signal });
    await localizeTableAssets(document.blocks, { workDir, config, signal });
    return document;
  } catch (error) {
    throwIfTaskCancelled(signal);
    if (config.browserEnabled === false) throw error;
    acquisition.fallbacks.push(`browser:${safeError(error)}`);
    return acquireWithBrowser({
      sourceUrl: fetched.finalUrl,
      attributionUrl: sourceUrl,
      workDir,
      config,
      limits,
      dnsLookup,
      acquisition,
      fetchFn,
      fetchWithRetry,
      scope,
      signal,
    });
  }
}

async function acquireWithBrowser({
  sourceUrl,
  attributionUrl = sourceUrl,
  workDir,
  config,
  limits,
  dnsLookup,
  acquisition,
  fetchFn,
  fetchWithRetry,
  scope = { kind: 'auto' },
  signal,
}) {
  throwIfTaskCancelled(signal);
  acquisition.attempts.push('playwright-structure');
  const rendered = await renderWithBrowser({
    sourceUrl,
    attributionUrl,
    scope,
    workDir,
    config,
    limits,
    dnsLookup,
    signal,
  });
  throwIfTaskCancelled(signal);
  assertUsableArticleResponse(rendered.html, rendered.finalUrl);
  acquisition.embeddedCharts = rendered.embeddedCharts;
  const document = await sourceDocumentFromHtml({
    html: rendered.html,
    sourceUrl: attributionUrl,
    documentUrl: rendered.finalUrl,
    extractor: 'readability-playwright',
    workDir,
    fetchFn,
    fetchWithRetry,
    config,
    dnsLookup,
    assetMap: rendered.assetMap,
    scope,
    signal,
  });
  document.acquisition = acquisition;
  return document;
}

export async function sourceDocumentFromHtml({
  html,
  sourceUrl,
  documentUrl = sourceUrl,
  extractor = 'readability-static',
  workDir,
  fetchFn = globalThis.fetch,
  fetchWithRetry,
  config = {},
  dnsLookup = dns.lookup,
  assetMap = {},
  scope = { kind: 'auto' },
  deferAssets = false,
  signal,
}) {
  const sourceDom = new JSDOM(String(html || ''), { url: documentUrl });
  let bodyDom;
  try {
    const sourceDocument = sourceDom.window.document;
    const title = metadata(sourceDocument, [
      'meta[property="og:title"]', 'meta[name="twitter:title"]', 'title', 'h1',
    ], 'content');
    const author = metadata(sourceDocument, [
      'meta[name="author"]', 'meta[property="article:author"]', '[rel="author"]', '.author',
    ], 'content');
    const publishedDate = metadata(sourceDocument, [
      'meta[property="article:published_time"]', 'meta[name="date"]', 'time[datetime]',
    ], 'content', 'datetime');
    const academicMetadata = academicMetadataFromDom(sourceDocument);

    discardExcludedContent(sourceDocument);
    const datalabPages = extractor === 'datalab-marker-html'
      ? [...sourceDocument.querySelectorAll('.page[data-page-id]')]
      : [];
    if (extractor === 'datalab-marker-html' && !datalabPages.length) {
      throw new Error('Datalab HTML 缺少分页容器，拒绝按普通网页正文解析');
    }
    let readable;
    const structured = sourceDocument.querySelector('article.ltx_document,.ltx_document');
    const titleRoot = structured || datalabPages.length ? undefined : titleAnchoredContentRoot(sourceDocument, title);
    const articles = [...sourceDocument.querySelectorAll('article')];
    const singleArticle = articles.length === 1 ? articles[0] : undefined;
    if (!structured && !datalabPages.length && !titleRoot && !singleArticle) {
      try {
        readable = new Readability(sourceDocument.cloneNode(true), { charThreshold: 80, keepClasses: true }).parse();
      } catch {}
    }
    const fallback = sourceDocument.querySelector('main,[role="main"]')
      || richestArticle(articles)
      || sourceDocument.body;
    const selectedRoot = structured || titleRoot || singleArticle;
    const bodyHtml = datalabPages.length
      ? datalabPages.map((page) => page.outerHTML).join('\n')
      : selectedRoot?.outerHTML || readable?.content || fallback?.innerHTML || '';
    bodyDom = new JSDOM(`<main>${bodyHtml}</main>`, { url: documentUrl });
    discardExcludedContent(bodyDom.window.document);
    const root = bodyDom.window.document.querySelector('main');
    const extractedBlocks = blocksFromDom(root, documentUrl);
    const scoped = applyTranslationScope({
      blocks: extractedBlocks, sourceUrl, documentUrl, academicMetadata,
    }, scope);
    const blocks = scoped.blocks;
    if (workDir && !deferAssets) {
      await localizeFigureAssets(blocks, {
        workDir,
        fetchFn,
        fetchWithRetry,
        config,
        dnsLookup,
        assetMap,
        signal,
      });
      await localizeTableAssets(blocks, {
        workDir,
        config,
        signal,
      });
    }
    const document = createSourceDocument({
      sourceType: 'html',
      extractor,
      sourceUrl,
      title: cleanText(readable?.title || title || new URL(sourceUrl).hostname),
      author,
      publishedDate,
      blocks,
      rawHashInput: String(html || ''),
    });
    document.scope = scoped.scope || scope;
    document.academicMetadata = academicMetadata;
    if (datalabPages.length) {
      document.processedPageIds = datalabPages.map((page) => Number(page.getAttribute('data-page-id')));
      document.datalabHtmlTextCharacters = datalabPages
        .map((page) => String(page.textContent || '').replace(/\s+/g, '').length)
        .reduce((sum, length) => sum + length, 0);
      document.datalabHtmlImageCount = datalabPages
        .reduce((sum, page) => sum + page.querySelectorAll('img[src]').length, 0);
    }
    assertSourceDocumentComplete(document);
    return document;
  } finally { bodyDom?.window.close(); sourceDom.window.close(); }
}

export async function sourceDocumentFromMarkdown({
  markdown,
  sourceUrl,
  title,
  author,
  publishedDate,
  extractor = 'notion-markdown-api',
  sourceType = 'notion',
  workDir,
  fetchFn = globalThis.fetch,
  fetchWithRetry,
  config = {},
  dnsLookup = dns.lookup,
  scope = { kind: 'auto' },
  signal,
}) {
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let paragraph = [];
  let blockIndex = 0;
  let inFence = false;
  let fenceLines = [];
  let referencesStarted = false;
  let referencesLevel = 0;

  const push = (block) => {
    const hasContent = block.text?.trim()
      || (block.type === 'figure' && block.images?.length)
      || (block.type === 'table' && block.rows?.length)
      || (block.type === 'equation' && block.tex?.trim());
    if (!hasContent) return;
    blocks.push({ ...block, id: `b${String(++blockIndex).padStart(6, '0')}`, order: blocks.length });
  };
  const flushParagraph = () => {
    const text = cleanMarkdownText(paragraph.join(' '), {
      omitCitations: !referencesStarted, preserveLinks: referencesStarted,
    });
    paragraph = [];
    if (text) push({ type: referencesStarted ? 'reference' : 'paragraph', text });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (/^```/.test(trimmed)) {
      flushParagraph();
      if (inFence) {
        push({ type: 'code', text: fenceLines.join('\n') });
        fenceLines = [];
        inFence = false;
      } else {
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(raw);
      continue;
    }
    if (isMarkdownTableStart(lines, index)) {
      flushParagraph();
      const tableLines = [raw, lines[index + 1]];
      index += 2;
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        tableLines.push(lines[index]);
        index += 1;
      }
      index -= 1;
      const rows = tableLines
        .filter((_, rowIndex) => rowIndex !== 1)
        .map((line) => splitMarkdownTableRow(line).map((text) => ({ text: cleanMarkdownText(text), fragments: [] })));
      push({
        type: 'table',
        caption: '',
        captionFragments: [],
        rows,
        sourceHtml: tableHtmlFromRows(rows),
      });
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      continue;
    }
    const image = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/.exec(trimmed);
    if (image) {
      flushParagraph();
      push({
        type: 'figure',
        images: [{ src: resolveAssetUrl(image[2], sourceUrl), alt: cleanText(image[1]) }],
        caption: cleanText(image[3] || image[1]),
        captionFragments: [],
      });
      continue;
    }
    if (/^\$\$/.test(trimmed)) {
      flushParagraph();
      const equation = [trimmed.replace(/^\$\$/, '')];
      while (index + 1 < lines.length && !/\$\$\s*$/.test(equation.at(-1))) equation.push(lines[++index]);
      const tex = equation.join('\n').replace(/\$\$\s*$/, '').trim();
      if (tex) push({ type: 'equation', tex });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      const text = cleanMarkdownText(heading[2]);
      if (isReferencesHeading(text)) {
        referencesStarted = true;
        referencesLevel = heading[1].length;
      } else if (referencesStarted && heading[1].length <= referencesLevel) {
        referencesStarted = false;
      }
      push({ type: 'heading', level: heading[1].length, text });
      continue;
    }
    const list = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(raw);
    if (list) {
      flushParagraph();
      const ordered = /^\d/.test(list[2]);
      push({
        type: referencesStarted ? 'reference' : 'list_item',
        ordered,
        ...(ordered ? {
          ordinal: Number.parseInt(list[2], 10),
          delimiter: list[2].endsWith(')') ? ')' : '.',
        } : {}),
        depth: Math.floor(list[1].length / 2),
        text: cleanMarkdownText(list[3], { omitCitations: !referencesStarted, preserveLinks: referencesStarted }),
      });
      continue;
    }
    const quote = /^>\s?(.+)$/.exec(trimmed);
    if (quote) {
      flushParagraph();
      push({ type: 'quote', text: cleanMarkdownText(quote[1]) });
      continue;
    }
    paragraph.push(raw);
  }
  flushParagraph();
  if (inFence && fenceLines.length) push({ type: 'code', text: fenceLines.join('\n') });

  const scoped = applyTranslationScope({ blocks, sourceUrl }, scope);
  if (workDir) {
    await localizeFigureAssets(scoped.blocks, {
      workDir,
      fetchFn,
      fetchWithRetry,
      config,
      dnsLookup,
      assetMap: {},
      signal,
    });
    await localizeTableAssets(scoped.blocks, {
      workDir,
      config,
      signal,
    });
  }

  const firstHeading = scoped.blocks.find((block) => block.type === 'heading');
  const document = createSourceDocument({
    sourceType,
    extractor,
    sourceUrl,
    title: cleanText(title || firstHeading?.text || new URL(sourceUrl).hostname),
    author,
    publishedDate,
    blocks: scoped.blocks,
    rawHashInput: String(markdown || ''),
  });
  document.scope = scoped.scope || scope;
  assertSourceDocumentComplete(document);
  return document;
}

async function sourceDocumentFromPdf({
  pdfBuffer,
  sourceUrl,
  resolvedSourceUrl,
  workDir,
  limits,
  config,
  fetchFn,
  scope,
  onProgress,
  signal,
}) {
  assertPdfResponse({
    buffer: pdfBuffer,
    sourceUrl,
    finalUrl: resolvedSourceUrl,
    contentType: 'application/pdf',
  });
  const pdfPath = path.join(workDir, 'translation-source.pdf');
  await fs.promises.writeFile(pdfPath, pdfBuffer);
  const { pages, output: info } = await readPdfInfo(pdfPath, limits.maxPdfPages, { signal });
  if (scope?.kind === 'pages' && scope.endPage > pages) {
    throw new Error(`指定翻译范围超过 PDF 页数:${scope.endPage}/${pages}`);
  }
  const title = cleanPdfMeta(/^Title:\s+(.+)$/mi.exec(info)?.[1])
    || path.basename(new URL(sourceUrl).pathname, '.pdf')
    || 'PDF 原文';
  const author = cleanPdfMeta(/^Author:\s+(.+)$/mi.exec(info)?.[1]);
  const publishedDate = cleanPdfMeta(/^CreationDate:\s+(.+)$/mi.exec(info)?.[1]);
  const converted = await convertPdfWithDatalab({
    pdfBuffer,
    filename: path.basename(new URL(resolvedSourceUrl || sourceUrl).pathname) || 'source.pdf',
    pageRange: datalabPageRange(scope),
    workDir,
    config,
    fetchFn,
    onProgress,
    signal,
  });
  const expectedPageIds = pdfPageIds(scope, pages);
  const popplerTextCharacters = await pdfTextCharacters(pdfPath, scope, pages, { signal });
  let document = await sourceDocumentFromHtml({
    html: converted.html,
    sourceUrl,
    documentUrl: resolvedSourceUrl || sourceUrl,
    extractor: 'datalab-marker-html',
    workDir,
    fetchFn,
    config,
    assetMap: converted.images,
    // Validate full parser/page coverage before applying semantic boundaries.
    scope: scope?.kind === 'pages' ? scope : { kind: 'all' },
    deferAssets: true,
    signal,
  });
  document.sourceType = 'pdf';
  document.title = cleanText(converted.metadata?.title || document.title || title);
  document.author = cleanText(converted.metadata?.author || document.author || author);
  document.publishedDate = cleanText(converted.metadata?.date || document.publishedDate || publishedDate);
  document.sha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
  document.pageCount = pages;
  document.processedPageCount = converted.pageCount;
  document.processedPageIds = converted.pageIds;
  document.parseQualityScore = converted.parseQualityScore;
  document.parserAttempts = converted.attempts;
  document.datalabHtmlTextCharacters = converted.htmlTextCharacters;
  document.datalabHtmlImageCount = converted.htmlImageCount;
  document.datalabResultImageCount = converted.resultImageCount;
  document.popplerTextCharacters = popplerTextCharacters;
  document.pageCoverage = assertPdfExtractionCoverage({
    document,
    expectedPageIds,
    popplerTextCharacters,
  });
  document = applyTranslationScope(document, scope);
  await localizeFigureAssets(document.blocks, {
    workDir, fetchFn, config, assetMap: converted.images, signal,
  });
  await localizeTableAssets(document.blocks, { workDir, config, signal });
  assertSourceDocumentComplete(document);
  return document;
}

export function assertPdfExtractionCoverage({
  document,
  expectedPageIds,
  popplerTextCharacters = 0,
}) {
  const expected = Array.isArray(expectedPageIds) ? expectedPageIds : [];
  const found = Array.isArray(document?.processedPageIds) ? document.processedPageIds : [];
  const datalabCharacters = Number(document?.datalabHtmlTextCharacters) || 0;
  const extractedCharacters = sourceDocumentCharacters(document);
  const errors = [];
  if (!expected.length) errors.push('没有可验证的请求页码');
  if (found.join(',') !== expected.join(',')) {
    errors.push(`页码覆盖不一致:${found.join(',') || '无'}/${expected.join(',') || '无'}`);
  }
  if (Number(document?.processedPageCount) !== expected.length) {
    errors.push(`处理页数不一致:${Number(document?.processedPageCount) || 0}/${expected.length}`);
  }
  if (datalabCharacters >= 1000 && extractedCharacters < datalabCharacters * 0.5) {
    errors.push(`结构化正文仅保留 Datalab 文本的 ${percentage(extractedCharacters, datalabCharacters)}`);
  }
  const textRichBaseline = expected.length * 200;
  if (popplerTextCharacters >= textRichBaseline
    && datalabCharacters < popplerTextCharacters * 0.35) {
    errors.push(`Datalab 文本仅覆盖 PDF 文本层的 ${percentage(datalabCharacters, popplerTextCharacters)}`);
  }
  if (popplerTextCharacters >= textRichBaseline
    && extractedCharacters < popplerTextCharacters * 0.25) {
    errors.push(`结构化正文仅覆盖 PDF 文本层的 ${percentage(extractedCharacters, popplerTextCharacters)}`);
  }
  if (errors.length) throw new Error(`PDF 页级完整性校验失败:${errors.join('; ')}`);
  return {
    requestedPages: expected.length,
    processedPages: found.length,
    expectedPageIds: expected,
    processedPageIds: found,
    pagesFound: found.map((id) => id + 1),
    popplerTextCharacters,
    datalabTextCharacters: datalabCharacters,
    extractedCharacters,
    datalabImages: Number(document?.datalabResultImageCount) || 0,
    referencedImages: Number(document?.datalabHtmlImageCount) || 0,
  };
}

function pdfPageIds(scope, totalPages) {
  const start = scope?.kind === 'pages' ? scope.startPage - 1 : 0;
  const end = scope?.kind === 'pages' ? scope.endPage - 1 : totalPages - 1;
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

async function pdfTextCharacters(pdfPath, scope, totalPages, { signal } = {}) {
  const firstPage = scope?.kind === 'pages' ? scope.startPage : 1;
  const lastPage = scope?.kind === 'pages' ? scope.endPage : totalPages;
  const text = await runCommand('pdftotext', [
    '-f', String(firstPage),
    '-l', String(lastPage),
    pdfPath,
    '-',
  ], { timeout: 60000, signal });
  return text.replace(/\s+/g, '').length;
}

function sourceDocumentCharacters(document) {
  return (document?.blocks || []).reduce((total, block) => {
    const tableText = (block.rows || [])
      .flatMap((row) => row || [])
      .map((cell) => cell?.text || '')
      .join(' ');
    return total + [block.text, block.caption, block.tex, tableText]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, '').length;
  }, 0);
}

function percentage(value, total) {
  if (!total) return '0.0%';
  return `${((value / total) * 100).toFixed(1)}%`;
}

export function renderTranslatedDocument(document) {
  const translatedTitle = normalizeTranslatedTitle(document.translatedTitle || document.title || '原文直译');
  const lines = [
    '---',
    `title: ${JSON.stringify(translatedTitle)}`,
    '---',
    '',
    sourceAttribution(document),
    '',
  ];
  let figureNumber = 0;
  let tableNumber = 0;
  let previousWasReference = false;
  let referenceNumber = 0;
  for (const block of document.blocks) {
    const preserveOriginal = block.translationPolicy === 'preserve-original';
    const text = restoreFragments((preserveOriginal ? block.text : block.translatedText ?? block.text) ?? '', block.fragments, {
      omitCitations: !preserveOriginal && block.type !== 'reference',
    });
    if (block.type !== 'reference' && previousWasReference) lines.push('');
    if (block.type !== 'reference') {
      previousWasReference = false;
      referenceNumber = 0;
    }
    if (block.type === 'heading') {
      if (block.level === 1 && sameLooseText(text, translatedTitle)) continue;
      lines.push(`${'#'.repeat(clamp(block.level || 2, 2, 4))} ${text}`, '');
    }
    else if (block.type === 'paragraph') lines.push(text, '');
    else if (block.type === 'quote') lines.push(...String(text).split('\n').map((line) => `> ${line}`), '');
    else if (block.type === 'list_item') {
      const ordinal = Number.isInteger(block.ordinal) ? block.ordinal : 1;
      const marker = block.ordered ? `${ordinal}${block.delimiter === ')' ? ')' : '.'}` : '-';
      lines.push(`${'  '.repeat(block.depth || 0)}${marker} ${text}`, '');
    } else if (block.type === 'figure') {
      figureNumber += 1;
      for (const image of block.images || []) {
        if (!image.localPath) continue;
        lines.push(`![${escapeMarkdownAlt(image.alt || `原文图 ${figureNumber}`)}](${image.localPath})`, '');
      }
      const caption = restoreFragments((preserveOriginal ? block.caption : block.translatedCaption ?? block.caption) ?? '', block.captionFragments, { omitCitations: !preserveOriginal });
      if (caption) lines.push(captionLine(`图 ${figureNumber}`, caption), '');
    } else if (block.type === 'table') {
      tableNumber += 1;
      const caption = restoreFragments((preserveOriginal ? block.caption : block.translatedCaption ?? block.caption) ?? '', block.captionFragments, { omitCitations: !preserveOriginal });
      if (caption) lines.push(`**表 ${tableNumber}：${caption}**`, '');
      if (block.localPath) {
        lines.push(`![原文表 ${tableNumber}](${block.localPath})`, '');
      }
    } else if (block.type === 'equation') {
      lines.push('$$', block.tex, '$$', '');
    } else if (block.type === 'code') {
      lines.push(`<pre><code>${escapeHtml(block.text || '')}</code></pre>`, '');
    } else if (block.type === 'reference') {
      const reference = String(text).replace(/^\s*(?:\[\s*\d{1,3}\s*\]|\d{1,3}[.)、])\s*/, '')
        .replace(/\s*\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
      if (!reference) continue;
      referenceNumber += 1;
      previousWasReference = true;
      lines.push(`${referenceNumber}. ${reference}`);
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export function validateTranslationArtifact({ source, translated, article }) {
  const errors = [];
  const warnings = [...new Set(translated.validationWarnings || [])];
  const validationExceptions = Array.isArray(translated.validationExceptions)
    ? translated.validationExceptions
    : [];
  const pageCoverage = source.sourceType === 'pdf' ? source.pageCoverage : undefined;
  if (source.sourceType === 'pdf') {
    if (!pageCoverage) {
      errors.push('PDF 缺少页级覆盖记录');
    } else if (pageCoverage.processedPages !== pageCoverage.requestedPages
      || pageCoverage.pagesFound?.length !== pageCoverage.requestedPages) {
      errors.push(`PDF 页级覆盖不完整:${pageCoverage.processedPages || 0}/${pageCoverage.requestedPages || 0}`);
    }
  }
  const sourceIds = source.blocks.map((block) => block.id);
  const translatedIds = translated.blocks.map((block) => block.id);
  if (sourceIds.join('|') !== translatedIds.join('|')) errors.push('结构块 ID 或顺序发生变化');
  if (source.blocks.some((block) => !DOCUMENT_BLOCK_TYPES.has(block.type))) errors.push('原文含未知结构块');
  if (translated.blocks.some((block) => !DOCUMENT_BLOCK_TYPES.has(block.type))) errors.push('译文含未知结构块');
  const translatedById = new Map(translated.blocks.map(block => [block.id, block]));
  for (const block of source.blocks.filter(item => item.translationPolicy === 'preserve-original')) {
    if (JSON.stringify(block) !== JSON.stringify(translatedById.get(block.id))) {
      errors.push(`原文参考文献内容发生变化:${block.id}`);
    }
  }
  for (const unit of translationUnits(source)) {
    const target = translatedUnitText(translated, unit.id);
    const checked = unit.id === 'meta:title' && translated.requestedTitle ? { ...unit, text: translated.requestedTitle } : unit;
    const assessment = assessTranslationUnit(checked, target, { afterRepair: true });
    for (const reason of assessment.hardErrors) {
      errors.push(`${reason}:${unit.id}`);
    }
    warnings.push(...assessment.warnings.map((reason) => `${unit.id}: ${reason}`));
  }
  const value = String(article || '');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) errors.push('译文含控制字符');
  const sourceFigures = source.blocks.filter((block) => block.type === 'figure')
    .reduce((sum, block) => sum + block.images.length, 0);
  const renderedFigures = (value.match(/^!\[[^\]]*\]\([^)]*\)$/gm) || []).length;
  const sourceTables = source.blocks.filter((block) => block.type === 'table').length;
  const renderedTableImages = (value.match(/^!\[原文表 \d+\]\([^)]*\)$/gm) || []).length;
  if (renderedTableImages !== sourceTables) {
    errors.push(`原文表格图片数量不一致:${renderedTableImages}/${sourceTables}`);
  }
  if (renderedFigures - renderedTableImages !== sourceFigures) {
    errors.push(`原文图片数量不一致:${renderedFigures - renderedTableImages}/${sourceFigures}`);
  }
  const sourceEquations = source.blocks.filter((block) => block.type === 'equation').length;
  const renderedEquations = (value.match(/^\$\$$/gm) || []).length / 2;
  if (renderedEquations !== sourceEquations) errors.push(`公式数量不一致:${renderedEquations}/${sourceEquations}`);
  for (const block of source.blocks.filter((item) => item.type === 'figure')) {
    for (const image of block.images) {
      if (!image.localPath || !fs.existsSync(image.localPath) || fs.statSync(image.localPath).size <= 0) {
        errors.push(`图片资产缺失:${block.id}`);
      }
    }
  }
  for (const block of source.blocks.filter((item) => item.type === 'table')) {
    if (!block.localPath || !fs.existsSync(block.localPath) || fs.statSync(block.localPath).size <= 0) {
      errors.push(`原文表格图片缺失:${block.id}`);
    }
  }
  return {
    errors,
    warnings: [...new Set(warnings)],
    strictEquivalence: validationExceptions.length === 0 && warnings.length === 0,
    reviewRequiredCount: validationExceptions.length,
    reviewRequiredUnits: validationExceptions.map((item) => item.id),
    validationExceptions,
    blocks: source.blocks.length,
    headings: source.blocks.filter((block) => block.type === 'heading').length,
    paragraphs: source.blocks.filter((block) => ['paragraph', 'quote', 'list_item'].includes(block.type)).length,
    figures: sourceFigures,
    tables: sourceTables,
    equations: sourceEquations,
    sourceCharacters: translationUnits(source).reduce((sum, unit) => sum + unit.text.length, 0),
    contentMode: 'structured-document',
    scope: source.scope,
    ...(pageCoverage ? {
      pagesRequested: pageCoverage.requestedPages,
      pagesProcessed: pageCoverage.processedPages,
      pagesFound: pageCoverage.pagesFound,
      pageCoverage,
    } : {}),
  };
}

export function buildDocumentManifest(document) {
  return {
    version: document.version,
    contentMode: 'structured-document',
    blocks: document.blocks.length,
    headings: document.blocks.filter((block) => block.type === 'heading').length,
    paragraphs: document.blocks.filter((block) => ['paragraph', 'quote', 'list_item'].includes(block.type)).length,
    figures: document.blocks.filter((block) => block.type === 'figure').reduce((sum, block) => sum + block.images.length, 0),
    tables: document.blocks.filter((block) => block.type === 'table').length,
    equations: document.blocks.filter((block) => block.type === 'equation').length,
    blockOrder: document.blocks.map((block) => `${block.id}:${block.type}`),
    pageCount: document.pageCount || undefined,
    processedPageCount: document.processedPageCount || undefined,
    pageCoverage: document.pageCoverage,
    parseQualityScore: document.parseQualityScore,
    parserAttempts: document.parserAttempts,
    scope: document.scope,
  };
}

export function removeRepeatedSourceMetadata(document) {
  const scope = document.scope || { kind: 'all' };
  if (scope.kind === 'sections' || (scope.kind === 'pages' && scope.startPage > 1)) return document;
  const blocks = document.blocks || [];
  const boundary = blocks.findIndex((block) => block.type === 'heading' && isAcademicBodyStart(block.text));
  if (boundary <= 0) return document;

  const preamble = blocks.slice(0, boundary);
  const titleRepeated = preamble.some((block) => (
    ['heading', 'paragraph'].includes(block.type)
      && sameLooseText(block.text, document.title)
  ));
  const preambleText = normalizeComparableText(preamble.map((block) => block.text || '').join(' '));
  const authorMatches = String(document.author || '')
    .split(/[;,，；]/)
    .map((name) => normalizeComparableText(name))
    .filter((name) => name.length >= 4)
    .slice(0, 20)
    .filter((name) => preambleText.includes(name))
    .length;
  if (!titleRepeated && authorMatches < 2) return document;

  const visualTypes = new Set(['figure', 'table', 'equation']);
  const filtered = [
    ...preamble.filter((block) => visualTypes.has(block.type)),
    ...blocks.slice(boundary),
  ].map((block, index) => ({ ...block, order: index }));
  return {
    ...document,
    blocks: filtered,
    metadataBlocksRemoved: blocks.length - filtered.length,
  };
}

async function renderWithBrowser({
  sourceUrl,
  attributionUrl = sourceUrl,
  scope = { kind: 'all' },
  workDir,
  config,
  limits,
  dnsLookup,
  signal,
}) {
  throwIfTaskCancelled(signal);
  const resolved = await withDeadline({ signal, timeoutMs: limits.fetchTimeoutMs },
    requestSignal => resolveSafeHttpUrl(sourceUrl, { dnsLookup, signal: requestSignal }));
  const sourceHost = resolved.url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const pinnedAddress = resolved.addresses[0].address;
  const resolverTarget = net.isIPv6(pinnedAddress) ? `[${pinnedAddress}]` : pinnedAddress;
  let playwright;
  try { playwright = await import('playwright-core'); }
  catch { throw new Error('动态网页需要 playwright-core'); }
  const executablePath = config.browserExecutablePath
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!fs.existsSync(executablePath)) throw new Error(`找不到浏览器:${executablePath}`);
  const releaseBrowser = await acquireRuntimeResource('browser', signal);
  let browser;
  try {
    browser = await playwright.chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      `--host-resolver-rules=MAP ${sourceHost} ${resolverTarget}, MAP * ~NOTFOUND`,
    ],
    });
  } catch (error) {
    releaseBrowser();
    throw error;
  }
  const abortBrowser = () => { void browser.close().catch(() => {}); };
  signal?.addEventListener('abort', abortBrowser, { once: true });
  try {
    throwIfTaskCancelled(signal);
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    page.setDefaultTimeout(limits.browserTimeoutMs);
    await context.route('**/*', async (route) => {
      let parsed;
      try { parsed = new URL(route.request().url()); } catch { await route.abort('blockedbyclient'); return; }
      if (!['http:', 'https:'].includes(parsed.protocol)
        || parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase() !== sourceHost) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: limits.browserTimeoutMs });
    throwIfTaskCancelled(signal);
    try { await page.waitForLoadState('networkidle', { timeout: Math.min(15000, limits.browserTimeoutMs) }); } catch {}
    throwIfTaskCancelled(signal);
    await progressivelyRevealPage(page, { signal });
    await page.locator('iframe').evaluateAll((frames) => {
      frames.forEach((frame, index) => {
        frame.setAttribute('data-sl-source-frame', String(index + 1));
      });
    });
    const hydratedHtml = await page.content();
    if (Buffer.byteLength(hydratedHtml) > limits.maxSourceBytes) {
      throw new Error(`动态网页渲染结果超过上限:${Buffer.byteLength(hydratedHtml)}/${limits.maxSourceBytes}`);
    }
    const captured = await captureEmbeddedChartFrames({
      page,
      html: hydratedHtml,
      documentUrl: page.url(),
      sourceUrl: attributionUrl,
      scope,
      workDir,
      config,
      limits,
      signal,
    });
    throwIfTaskCancelled(signal);
    const finalUrl = page.url();
    await withDeadline({ signal, timeoutMs: limits.fetchTimeoutMs },
      requestSignal => assertSafeHttpUrl(finalUrl, { dnsLookup, signal: requestSignal }));
    const html = await page.content();
    if (Buffer.byteLength(html) > limits.maxSourceBytes) {
      throw new Error(`动态网页结构化结果超过上限:${Buffer.byteLength(html)}/${limits.maxSourceBytes}`);
    }
    return {
      html,
      finalUrl,
      assetMap: captured.assetMap,
      embeddedCharts: captured.embeddedCharts,
    };
  } catch (error) {
    if (signal?.aborted) throw cancellationErrorFromSignal(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortBrowser);
    try { await browser.close(); }
    finally { releaseBrowser(); }
  }
}

export function inspectEmbeddedChartFrames(html, {
  documentUrl = 'https://example.com/', sourceUrl = documentUrl, scope = { kind: 'all' },
} = {}) {
  const dom = new JSDOM(String(html || ''), { url: documentUrl });
  try {
    const document = dom.window.document;
    const title = metadata(document, [
      'meta[property="og:title"]', 'meta[name="twitter:title"]', 'title', 'h1',
    ], 'content');
    const structured = document.querySelector('article.ltx_document,.ltx_document');
    const titleRoot = structured ? undefined : titleAnchoredContentRoot(document, title);
    const articles = [...document.querySelectorAll('article')];
    const singleArticle = articles.length === 1 ? articles[0] : undefined;
    const root = structured
      || titleRoot
      || singleArticle
      || document.querySelector('main,[role="main"]')
      || richestArticle(articles)
      || document.body;
    const frames = [...(root?.querySelectorAll('iframe') || [])];
    let candidates = frames
      .map((frame, index) => {
        const srcdoc = String(frame.getAttribute('srcdoc') || '');
        const src = cleanText(frame.getAttribute('src') || '');
        const frameTitle = cleanText(frame.getAttribute('title') || '');
        if (!srcdoc.trim() || src || !frame.hasAttribute('sandbox') || !frameTitle) return undefined;
        return {
          marker: frame.getAttribute('data-sl-source-frame') || String(index + 1),
          title: frameTitle,
          caption: embeddedChartCaption(srcdoc, frameTitle),
          srcdocChars: srcdoc.length,
        };
      })
      .filter(Boolean);
    if (scope.kind !== 'all' && scope.kind !== 'pages' && candidates.length) {
      const academicMetadata = academicMetadataFromDom(document);
      // Model an iframe as the figure it becomes after capture. Scope can then
      // discard appendix charts before any screenshot or asset-budget accounting.
      const placeholders = new Map();
      for (const [index, frame] of frames.entries()) {
        const marker = frame.getAttribute('data-sl-source-frame') || String(index + 1);
        if (!candidates.some(candidate => candidate.marker === marker)) continue;
        const src = `https://embedded-chart.invalid/${encodeURIComponent(marker)}.png`;
        placeholders.set(src, marker);
        const figure = document.createElement('figure');
        const image = document.createElement('img');
        image.setAttribute('src', src);
        figure.appendChild(image);
        frame.replaceWith(figure);
      }
      const selected = applyTranslationScope({ blocks: blocksFromDom(root, documentUrl), sourceUrl, documentUrl, academicMetadata }, scope);
      const selectedMarkers = new Set(selected.blocks.flatMap(block => (block.images || []).map(image => placeholders.get(image.src))));
      candidates = candidates.filter(candidate => selectedMarkers.has(candidate.marker));
    }
    return {
      detected: candidates.length,
      excludedExternalFrames: frames.filter((frame) => cleanText(frame.getAttribute('src') || '')).length,
      candidates,
    };
  } finally { dom.window.close(); }
}

export async function captureEmbeddedChartFrames({
  page,
  html,
  workDir,
  config = {},
  limits = DEFAULT_LIMITS,
  documentUrl,
  sourceUrl,
  scope,
  signal,
}) {
  const inspection = inspectEmbeddedChartFrames(html, { documentUrl, sourceUrl, scope });
  if (!inspection.detected) {
    return {
      assetMap: {},
      embeddedCharts: {
        detected: 0,
        captured: 0,
        excludedExternalFrames: inspection.excludedExternalFrames,
      },
    };
  }
  if (!workDir) throw new Error('嵌入图表截图缺少任务工作目录');
  if (inspection.detected > limits.maxAssetCount) {
    throw new Error(`原文嵌入图表数量超过上限:${inspection.detected}/${limits.maxAssetCount}`);
  }

  const assetDir = path.join(workDir, 'translation-assets');
  assertProjectPath(workDir, assetDir);
  fs.mkdirSync(assetDir, { recursive: true });
  const assetMap = {};
  const captureScreenshot = config.embeddedChartScreenshot
    || (async ({ locator, options }) => locator.screenshot(options));
  let totalBytes = 0;
  let captured = 0;

  for (const [index, descriptor] of inspection.candidates.entries()) {
    throwIfTaskCancelled(signal);
    const locator = page.locator(`[data-sl-source-frame="${descriptor.marker}"]`);
    if (await locator.count() !== 1) {
      throw new Error(`原文嵌入图表定位失败:${descriptor.title}`);
    }

    let buffer;
    let box;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await locator.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250 * (attempt + 1));
      throwIfTaskCancelled(signal);
      box = await locator.boundingBox();
      buffer = Buffer.from(await captureScreenshot({
        locator,
        descriptor,
        attempt,
        options: {
          type: 'png',
          animations: 'disabled',
          caret: 'hide',
          omitBackground: false,
          timeout: limits.browserTimeoutMs,
        },
      }));
      if (buffer.length >= EMBEDDED_CHART_MIN_PNG_BYTES) break;
    }

    validateEmbeddedChartScreenshot({
      title: descriptor.title,
      buffer,
      width: box?.width || 0,
      height: box?.height || 0,
      limits,
    });
    totalBytes += buffer.length;
    if (totalBytes > limits.maxAssetBytes) {
      throw new Error(`原文嵌入图表总量超过上限:${totalBytes}/${limits.maxAssetBytes}`);
    }

    const basename = `embedded-chart-${String(index + 1).padStart(3, '0')}.png`;
    const target = path.join(assetDir, basename);
    assertProjectPath(workDir, target);
    fs.writeFileSync(target, buffer, { mode: 0o600 });
    const placeholder = `asset:${basename}`;
    assetMap[placeholder] = target;
    assetMap[basename] = target;
    await locator.evaluate((frame, payload) => {
      const document = frame.ownerDocument;
      const figure = document.createElement('figure');
      figure.setAttribute('data-sl-embedded-chart', payload.index);
      const image = document.createElement('img');
      image.setAttribute('src', payload.placeholder);
      image.setAttribute('alt', payload.title);
      figure.appendChild(image);
      if (payload.caption) {
        const caption = document.createElement('figcaption');
        caption.textContent = payload.caption;
        figure.appendChild(caption);
      }
      frame.replaceWith(figure);
    }, {
      index: String(index + 1),
      placeholder,
      title: descriptor.title,
      caption: descriptor.caption,
    });
    captured += 1;
  }

  return {
    assetMap,
    embeddedCharts: {
      detected: inspection.detected,
      captured,
      excludedExternalFrames: inspection.excludedExternalFrames,
    },
  };
}

export function validateEmbeddedChartScreenshot({
  title,
  buffer,
  width,
  height,
  limits = DEFAULT_LIMITS,
}) {
  const label = cleanText(title || '未命名图表');
  if (width < EMBEDDED_CHART_MIN_WIDTH || height < EMBEDDED_CHART_MIN_HEIGHT
    || width > EMBEDDED_CHART_MAX_WIDTH || height > EMBEDDED_CHART_MAX_HEIGHT
    || width * height > EMBEDDED_CHART_MAX_PIXELS) {
    throw new Error(`原文嵌入图表尺寸异常:${label} ${Math.round(width)}x${Math.round(height)}`);
  }
  if (!Buffer.isBuffer(buffer) || buffer.length < EMBEDDED_CHART_MIN_PNG_BYTES) {
    throw new Error(`原文嵌入图表截图疑似空白:${label}`);
  }
  if (buffer.length > limits.maxSingleAssetBytes) {
    throw new Error(`原文嵌入图表超过单文件上限:${label} ${buffer.length}/${limits.maxSingleAssetBytes}`);
  }
  if (!buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error(`原文嵌入图表不是有效 PNG:${label}`);
  }
}

async function progressivelyRevealPage(page, { signal } = {}) {
  for (let step = 0; step < 60; step += 1) {
    throwIfTaskCancelled(signal);
    const complete = await page.evaluate(() => {
      const before = window.scrollY;
      window.scrollBy(0, Math.max(600, window.innerHeight * 0.85));
      return window.scrollY === before
        || window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    });
    await page.waitForTimeout(75);
    if (complete) break;
  }
  await page.waitForTimeout(1200);
  throwIfTaskCancelled(signal);
}

function embeddedChartCaption(srcdoc, title) {
  let dom, document;
  try { dom = new JSDOM(String(srcdoc || '')); document = dom.window.document; }
  catch { return cleanText(title); }
  try {
    const values = [
      title,
      document.querySelector('.table-title,h1,h2')?.textContent,
      document.querySelector('.table-subtitle,[class*="subtitle"]')?.textContent,
      document.querySelector('.table-footer,figcaption,[class*="caption"]')?.textContent,
    ].map(cleanText).filter(Boolean);
    const seen = new Set();
    return values.filter((value) => {
      const key = normalizedHeading(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).join('\n').slice(0, 4000);
  } finally { dom.window.close(); }
}

function createSourceDocument({
  sourceType,
  extractor,
  sourceUrl,
  title,
  author = '',
  publishedDate = '',
  blocks,
  rawHashInput,
  pageCount,
}) {
  return {
    version: DOCUMENT_VERSION,
    contentMode: 'structured-document',
    sourceType,
    extractor,
    sourceUrl,
    title: cleanText(title),
    author: cleanText(author),
    publishedDate: cleanText(publishedDate),
    sha256: crypto.createHash('sha256').update(rawHashInput).digest('hex'),
    blocks,
    ...(pageCount ? { pageCount } : {}),
  };
}

function blocksFromDom(root, documentUrl) {
  if (!root) return [];
  const blocks = [];
  let blockIndex = 0;
  const bibliographyIds = new Map();
  const push = (block, node) => {
    const selector = '.ltx_bibliography,[role="doc-bibliography"],section.bibliography,section.references';
    let container = node.closest(selector);
    for (let parent = container?.parentElement?.closest(selector); parent; parent = parent.parentElement?.closest(selector)) container = parent;
    if (container) {
      if (!bibliographyIds.has(container)) bibliographyIds.set(container, `bibliography${bibliographyIds.size + 1}`);
      block.bibliographyId = bibliographyIds.get(container);
    }
    blocks.push(block);
  };
  const selector = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'li',
    'figure', 'table', 'pre', 'img', '.ltx_equationgroup', '.ltx_equation',
    'math[display="block"]', '.ltx_bibitem',
    // Datalab emits ComplexRegion and similar content as classless nested divs
    // carrying only data-block-id. Without this leaf-level branch, text-heavy
    // regions (e.g. per-record experience details) vanish from the structured
    // document while the raw page text remains, tripping the coverage gate.
    'div[data-block-id]',
  ].join(',');
  for (const node of root.querySelectorAll(selector)) {
    if (node.closest(EXCLUDED_CONTENT_SELECTOR)) continue;
    if (node.tagName === 'DIV') {
      if (node.closest('p,li,blockquote,h1,h2,h3,h4,h5,h6,table,figure,pre')) continue;
      // Keep residual text of Datalab regions: children matching the semantic
      // or data-block-id selector are captured by their own iteration, so the
      // region block must retain only the text they do not already cover.
      const residual = node.cloneNode(true);
      for (const child of [...residual.querySelectorAll(selector)]) child.remove();
      const region = datalabRegionRichText(residual, documentUrl);
      if (!region.text) continue;
      push({
        id: `b${String(++blockIndex).padStart(6, '0')}`,
        order: blocks.length,
        type: 'paragraph',
        text: region.text,
        fragments: region.fragments,
      }, node);
      continue;
    }
    if (node.matches('img') && node.closest('figure')) continue;
    if (node.matches('.ltx_equation,math') && node.parentElement?.closest('.ltx_equation,.ltx_equationgroup')) continue;
    if (node.matches('.ltx_bibitem') && node.parentElement?.closest('.ltx_bibitem')) continue;
    if (!node.matches('figure,table,pre,.ltx_equationgroup,.ltx_equation,math[display="block"],.ltx_bibitem')
      && node.closest('figure,table,pre,.ltx_equationgroup,.ltx_equation,.ltx_bibitem')) continue;
    if (node.tagName === 'P' && node.closest('blockquote,li')) continue;
    if (node.tagName === 'BLOCKQUOTE' && node.closest('li')) continue;
    const id = `b${String(++blockIndex).padStart(6, '0')}`;

    if (node.matches('figure,img')) {
      const figure = figureFromNode(node, documentUrl);
      if (!figure.images.length) {
        blockIndex -= 1;
        continue;
      }
      push({ id, order: blocks.length, type: 'figure', ...figure }, node);
      continue;
    }
    if (node.matches('table')) {
      const table = tableFromNode(node, documentUrl);
      if (!table.rows.length) {
        blockIndex -= 1;
        continue;
      }
      push({ id, order: blocks.length, type: 'table', ...table }, node);
      continue;
    }
    if (node.matches('pre')) {
      const code = String(node.textContent || '').replace(/^\n+|\n+$/g, '');
      if (!code) {
        blockIndex -= 1;
        continue;
      }
      push({ id, order: blocks.length, type: 'code', text: code }, node);
      continue;
    }
    if (node.matches('.ltx_equationgroup,.ltx_equation,math[display="block"]')) {
      const tex = mathTex(node);
      if (!tex) {
        blockIndex -= 1;
        continue;
      }
      push({ id, order: blocks.length, type: 'equation', tex }, node);
      continue;
    }
    if (node.matches('.ltx_bibitem')) {
      const rich = richTextFromNode(node, documentUrl);
      if (!rich.text) {
        blockIndex -= 1;
        continue;
      }
      push({ id, order: blocks.length, type: 'reference', translationPolicy: 'preserve-original', text: rich.text, fragments: rich.fragments }, node);
      continue;
    }

    const rich = richTextFromNode(node, documentUrl);
    const text = rich.text;
    if (!text) {
      blockIndex -= 1;
      continue;
    }
    let type = 'paragraph';
    const block = {};
    if (/^H[1-6]$/.test(node.tagName)) {
      type = 'heading';
      block.level = Number(node.tagName.slice(1));
    } else if (node.tagName === 'BLOCKQUOTE') type = 'quote';
    else if (node.tagName === 'LI') {
      type = 'list_item';
      block.ordered = node.parentElement?.tagName === 'OL';
      if (block.ordered) {
        block.ordinal = orderedListItemOrdinal(node);
        block.delimiter = '.';
      }
      let depth = 0;
      for (let parent = node.parentElement?.closest('li'); parent; parent = parent.parentElement?.closest('li')) depth += 1;
      block.depth = depth;
    }
    push({
      id,
      order: blocks.length,
      type,
      ...block,
      text,
      fragments: rich.fragments,
    }, node);
  }
  return blocks;
}

function orderedListItemOrdinal(node) {
  const list = node.parentElement;
  if (list?.tagName !== 'OL') return undefined;
  const items = [...list.children].filter((child) => child.tagName === 'LI');
  const reversed = list.hasAttribute('reversed');
  const parsedStart = Number.parseInt(list.getAttribute('start') || '', 10);
  let ordinal = Number.isInteger(parsedStart) ? parsedStart : (reversed ? items.length : 1);
  for (const item of items) {
    const explicitValue = Number.parseInt(item.getAttribute('value') || '', 10);
    if (Number.isInteger(explicitValue)) ordinal = explicitValue;
    if (item === node) return ordinal;
    ordinal += reversed ? -1 : 1;
  }
  return undefined;
}

function richTextFromNode(node, documentUrl) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll(EXCLUDED_CONTENT_SELECTOR).forEach((child) => child.remove());
  if (node.tagName === 'LI') clone.querySelectorAll('ol,ul').forEach((child) => child.remove());
  const fragments = [];
  const protect = (value, kind) => {
    const token = `⟦SL_INLINE_${String(fragments.length + 1).padStart(3, '0')}⟧`;
    fragments.push({ token, value, ...(kind ? { kind } : {}) });
    return token;
  };
  for (const math of [...clone.querySelectorAll('math,.MathJax,.katex,.ltx_Math')]) {
    const tex = mathTex(math);
    math.replaceWith(clone.ownerDocument.createTextNode(protect(tex ? `$${tex}$` : cleanText(math.textContent))));
  }
  for (const link of [...clone.querySelectorAll('a[href]')]) {
    const label = cleanText(link.textContent);
    let value = label;
    try {
      const resolved = new URL(link.getAttribute('href'), documentUrl);
      if (['http:', 'https:'].includes(resolved.protocol)) value = `[${label || resolved.href}](${resolved.href})`;
    } catch {}
    link.replaceWith(clone.ownerDocument.createTextNode(protect(value,
      isReferenceCitationLink(label, link.getAttribute('href')) ? 'citation' : undefined)));
  }
  for (const br of [...clone.querySelectorAll('br')]) br.replaceWith(clone.ownerDocument.createTextNode('\n'));
  return { text: cleanTextPreservingLines(clone.textContent), fragments };
}

function datalabRegionRichText(node, documentUrl) {
  const clone = node.cloneNode(true);
  // Nested classless divs in Datalab ComplexRegion blocks act as line
  // containers; textContent alone would concatenate neighboring fields.
  for (const div of [...clone.querySelectorAll('div')]) {
    if (!div.querySelector('div')) div.append(clone.ownerDocument.createTextNode('\n'));
  }
  return richTextFromNode(clone, documentUrl);
}

function figureFromNode(node, documentUrl) {
  const images = node.matches('img') ? [node] : [...node.querySelectorAll('img')];
  const captionNode = node.matches('figure')
    ? node.querySelector('figcaption,.ltx_caption,[class*="caption"]')
    : undefined;
  const caption = captionNode ? richTextFromNode(captionNode, documentUrl) : { text: '', fragments: [] };
  return {
    images: images.map((image) => ({
      src: resolveAssetUrl(image.getAttribute('src') || image.getAttribute('data-src'), documentUrl),
      alt: cleanText(image.getAttribute('alt') || ''),
    })).filter((image) => image.src),
    caption: caption.text,
    captionFragments: caption.fragments,
  };
}

function tableFromNode(node, documentUrl) {
  const captionNode = node.querySelector('caption') || node.closest('figure')?.querySelector('figcaption,.ltx_caption');
  const caption = captionNode ? richTextFromNode(captionNode, documentUrl) : { text: '', fragments: [] };
  const rows = [];
  const pendingRowspans = new Map();
  for (const row of node.querySelectorAll('tr')) {
    const cells = [];
    let column = 0;
    const placePending = () => {
      while (pendingRowspans.has(column)) {
        const pending = pendingRowspans.get(column);
        cells[column] = { text: pending.text, fragments: structuredClone(pending.fragments || []) };
        pending.remaining -= 1;
        if (pending.remaining <= 0) pendingRowspans.delete(column);
        column += 1;
      }
    };
    placePending();
    for (const cell of row.querySelectorAll(':scope > th,:scope > td')) {
      placePending();
      const rich = richTextFromNode(cell, documentUrl);
      const colspan = clamp(cell.getAttribute('colspan') || 1, 1, 50);
      const rowspan = clamp(cell.getAttribute('rowspan') || 1, 1, 200);
      for (let span = 0; span < colspan; span += 1) {
        const value = span === 0 ? rich : { text: '', fragments: [] };
        cells[column] = { text: value.text, fragments: value.fragments };
        if (rowspan > 1) {
          pendingRowspans.set(column, {
            text: value.text,
            fragments: structuredClone(value.fragments || []),
            remaining: rowspan - 1,
          });
        }
        column += 1;
      }
    }
    placePending();
    if (cells.some((cell) => cell?.text)) rows.push(cells.map((cell) => cell || { text: '', fragments: [] }));
  }
  const width = Math.max(0, ...rows.map((row) => row.length));
  for (const row of rows) while (row.length < width) row.push({ text: '', fragments: [] });
  return {
    caption: caption.text,
    captionFragments: caption.fragments,
    rows,
    sourceHtml: node.outerHTML,
  };
}

function mathTex(node) {
  const math = node.matches?.('math') ? node : node.querySelector?.('math');
  return cleanMath(
    math?.getAttribute('alttext')
      || math?.querySelector?.('annotation[encoding*="tex" i]')?.textContent
      || node.getAttribute?.('data-tex')
      || node.getAttribute?.('aria-label')
      || math?.textContent
      || node.textContent,
  );
}

function cleanMath(value) {
  return String(value || '').trim()
    .replace(/^\\\(|\\\)$/g, '')
    .replace(/^\\\[|\\\]$/g, '')
    .replace(/^\$\$?|\$\$?$/g, '')
    .trim();
}

function resolveAssetUrl(value, documentUrl) {
  if (!value) return '';
  if (/^data:/i.test(value)) return value;
  try { return new URL(value, documentUrl).toString(); }
  catch { return String(value); }
}

function discardExcludedContent(document) {
  for (const frame of [...document.querySelectorAll('iframe[src]')]) {
    const rawSrc = cleanText(frame.getAttribute('src') || '');
    let url;
    try { url = new URL(rawSrc, document.URL); } catch { continue; }
    const hostname = url.hostname.replace(/^www\./, '').toLowerCase();
    if (!['youtube.com', 'youtu.be', 'vimeo.com', 'player.vimeo.com'].includes(hostname)) continue;
    const paragraph = document.createElement('p');
    const link = document.createElement('a');
    link.setAttribute('href', url.href);
    link.textContent = cleanText(frame.getAttribute('title') || '') || '原文视频';
    paragraph.appendChild(link);
    frame.replaceWith(paragraph);
  }
  for (const heading of document.querySelectorAll('h1[aria-label],h2[aria-label],h3[aria-label],h4[aria-label],h5[aria-label],h6[aria-label]')) {
    if (!heading.querySelector('[aria-hidden="true"]')) continue;
    const accessibleText = cleanText(heading.getAttribute('aria-label') || '');
    if (accessibleText) heading.textContent = accessibleText;
  }
  document.querySelectorAll(EXCLUDED_CONTENT_SELECTOR).forEach((node) => node.remove());
}

function titleAnchoredContentRoot(document, title) {
  const normalizedTitle = normalizedHeading(title);
  const headings = [...document.querySelectorAll('h1')];
  const heading = headings.find((candidate) => {
    const value = normalizedHeading(candidate.textContent);
    return value && normalizedTitle
      && (normalizedTitle.includes(value) || value.includes(normalizedTitle));
  }) || (headings.length === 1 ? headings[0] : undefined);
  if (!heading) return undefined;

  for (let candidate = heading.parentElement;
    candidate && !['BODY', 'HTML'].includes(candidate.tagName);
    candidate = candidate.parentElement) {
    const textLength = cleanText(candidate.textContent).length;
    const paragraphs = candidate.querySelectorAll('p').length;
    const headingsCount = candidate.querySelectorAll('h1,h2,h3,h4,h5,h6').length;
    if (textLength >= 800 && paragraphs >= 3 && (headingsCount >= 2 || paragraphs >= 6)) {
      return candidate;
    }
  }
  return undefined;
}

function richestArticle(articles = []) {
  return [...articles].sort((left, right) => {
    const score = (node) => cleanText(node.textContent).length
      + node.querySelectorAll('h1,h2,h3,h4,h5,h6,p,figure,table,pre').length * 80;
    return score(right) - score(left);
  })[0];
}

function normalizedHeading(value) {
  return cleanText(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function assertSourceDocumentComplete(document) {
  if (!document.blocks?.length) throw new Error('原文结构化提取结果为空');
  if (document.blocks.some((block) => !DOCUMENT_BLOCK_TYPES.has(block.type))) {
    throw new Error('原文提取结果含未知结构内容');
  }
  const textLength = translationUnits(document).reduce((sum, unit) => sum + unit.text.length, 0);
  const visualBlocks = document.blocks.filter((block) => ['figure', 'table', 'equation'].includes(block.type)).length;
  if (document.sourceType === 'html' && textLength < 120 && visualBlocks === 0) {
    throw new Error(`网页正文过短:${textLength} 字符`);
  }
}

function shouldUseBrowser(document, html) {
  const textLength = translationUnits(document).reduce((sum, unit) => sum + unit.text.length, 0);
  return (textLength < 500 || document.blocks.length < 3)
    && /<(?:script|div)[^>]+id=["'](?:__next|__nuxt|app|root)["']/i.test(html);
}

function academicMetadataFromDom(document) {
  return Boolean(document.querySelector('meta[name="citation_title" i],meta[name="citation_doi" i],.ltx_document'))
    || [...document.querySelectorAll('script[type="application/ld+json"]')].some(node => {
      try { return containsScholarlyArticle(JSON.parse(node.textContent)); } catch { return false; }
    });
}

function containsScholarlyArticle(value) {
  if (!value || typeof value !== 'object') return false;
  if ([value['@type']].flat().includes('ScholarlyArticle')) return true;
  return Object.values(value).some(item => item && typeof item === 'object' && containsScholarlyArticle(item));
}

function isMarkdownTableStart(lines, index) {
  return /^\s*\|.*\|\s*$/.test(lines[index] || '')
    && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || '');
}

function splitMarkdownTableRow(line) {
  const value = String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let current = '';
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isReferenceCitationLink(label, href) {
  if (!/^(?:\[\s*\d+\s*\]|【\s*\d+\s*】|\(\s*\d+\s*\)|（\s*\d+\s*）|\d+)$/u.test(String(label || '').trim())) return false;
  let fragment;
  try { fragment = decodeURIComponent(new URL(String(href || ''), 'https://source.invalid/').hash.slice(1)); }
  catch { return false; }
  return /^(?:fn|footnote|bib|ref|cite|citation|b)[._:-]?(?:bib)?\d+(?:[._:-].*)?$/i.test(fragment);
}

function cleanMarkdownText(value, { omitCitations = true, preserveLinks = false } = {}) {
  const links = [];
  const protectedValue = preserveLinks
    ? String(value || '').replace(/(?<!!)\[(?:\[[^\]]*\]|[^\]]*)\]\([^)]+\)/g, link => {
      links.push(link);
      return `⟦SLBIBLINK${links.length}⟧`;
    })
    : String(value || '');
  const text = cleanText(protectedValue
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[(\[\s*\d+\s*\]|【\s*\d+\s*】|\(\s*\d+\s*\)|（\s*\d+\s*）)\]\(([^)]*)\)/gu,
      (_, label, href) => omitCitations && isReferenceCitationLink(label, href) ? '' : label)
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, (_, label, href) => omitCitations && isReferenceCitationLink(label, href) ? '' : label)
    .replace(/[*_~`]/g, '')
    .replace(/<[^>]+>/g, ' '));
  return text.replace(/⟦SLBIBLINK(\d+)⟧/g, (token, number) => links[Number(number) - 1] || token);
}

function sourceAttribution(document) {
  const site = (() => { try { return new URL(document.sourceUrl).hostname; } catch { return '未知'; } })();
  return [
    '> **原文信息**',
    `> 原文：《${document.title || '未知标题'}》`,
    `> 作者：${document.author || '未知'}`,
    `> 来源：[${site}](${document.sourceUrl})`,
  ].join('\n');
}

function normalizeTranslatedTitle(value) {
  return cleanText(value)
    .replace(/\s*(?:（\s*译(?:文)?\s*）|\(\s*译(?:文)?\s*\)|【\s*译(?:文)?\s*】|\[\s*译(?:文)?\s*\]|译文|翻译)\s*$/i, '')
    .trim();
}

function restoreFragments(value, fragments = [], { omitCitations = false } = {}) {
  let text = String(value || '');
  for (const fragment of fragments || []) {
    text = text.replaceAll(fragment.token, omitCitations && fragment.kind === 'citation' ? '' : fragment.value);
  }
  if (omitCitations && fragments?.some(fragment => fragment.kind === 'citation')) {
    text = text.replace(/[ \t]+(?=[，。；、,.!?！？;:：])/g, '').replace(/[ \t]{2,}/g, ' ').trim();
  }
  return text;
}

function captionLine(label, caption) {
  return `<p style="font-size:15px;text-align:left;color:#7b8490;line-height:1.8;margin:.35em 0 1.2em">${escapeHtml(label)}：${escapeHtml(caption)}</p>`;
}

function escapeMarkdownAlt(value) {
  return String(value || '').replace(/[[\]\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sameLooseText(left, right) {
  const normalize = (value) => cleanText(value).replace(/[（(]译[）)]$/, '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function normalizeComparableText(value) {
  return cleanText(value).replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
}

function isAcademicBodyStart(value) {
  const normalized = normalizeComparableText(value)
    .replace(/^(?:section)?\d+(?:\d+)*/, '');
  return /^(?:abstract|摘要|introduction|引言|executivesummary|执行摘要)$/.test(normalized);
}

export async function readPdfInfo(pdfPath, maxPdfPages, { signal, execute } = {}) {
  const output = await runCommand('pdfinfo', [pdfPath], {
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    signal,
    execute,
    missingMessage: 'PDF 页数校验缺少 Poppler 命令 pdfinfo',
    failureLabel: 'PDF 页数检查失败',
  });
  const pages = Number(/^Pages:\s+(\d+)/mi.exec(output)?.[1] || 0);
  if (!pages) throw new Error('PDF 页数识别失败');
  if (pages > maxPdfPages) throw new Error(`PDF 页数超过上限:${pages}/${maxPdfPages}`);
  return { pages, output };
}

export async function assertPdfPageLimit(pdfPath, maxPdfPages, options) {
  return (await readPdfInfo(pdfPath, maxPdfPages, options)).pages;
}

export function assertPdfResponse({
  buffer,
  sourceUrl = '',
  finalUrl = '',
  contentType = '',
}) {
  if (hasPdfSignature(buffer)) return true;
  const sample = Buffer.isBuffer(buffer)
    ? buffer.subarray(0, 4096).toString('utf8')
    : '';
  if (isSlackPrivateFileUrl(sourceUrl || finalUrl)
    && /<!doctype\s+html|<html\b|slack/i.test(sample)) {
    throw new Error(
      'Slack PDF 下载返回了登录页面而不是文件。Slack App 的 Bot Token 缺少 files:read 权限，'
      + '请在 OAuth & Permissions 中添加 files:read、重新安装 App 到工作区，然后重试原任务。',
    );
  }
  const type = String(contentType || '').split(';')[0].trim() || '未知';
  throw new Error(`PDF 下载响应不是有效 PDF（Content-Type: ${type}）`);
}

export function hasPdfSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) return false;
  const searchWindow = buffer.subarray(0, Math.min(buffer.length, 1024));
  return searchWindow.indexOf(Buffer.from('%PDF-')) >= 0;
}

function isSlackPrivateFileUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /(?:^|\.)slack\.com$/i.test(url.hostname)
      && /\/files-pri\//i.test(url.pathname);
  } catch {
    return false;
  }
}

async function runCommand(command, args, {
  timeout = 30000,
  maxBuffer = 32 * 1024 * 1024,
  signal,
  execute = execFileAsync,
  missingMessage = `PDF 元数据校验缺少 Poppler 命令 ${command}`,
  failureLabel = `${command} 执行失败`,
} = {}) {
  try {
    const result = await execute(command, args, {
      encoding: 'utf8', timeout, maxBuffer, signal, killSignal: 'SIGKILL',
    });
    return String(result?.stdout ?? result ?? '');
  } catch (error) {
    if (signal?.aborted) throw cancellationErrorFromSignal(signal);
    if (error?.code === 'ENOENT') throw new Error(missingMessage);
    const detail = error?.stderr ? String(error.stderr).slice(0, 300) : safeError(error);
    throw new Error(`${failureLabel}:${detail}`);
  }
}

function assertUsableArticleResponse(html, url) {
  const text = cleanText(html).slice(0, 12000);
  if (!text) throw new Error('网页响应为空');
  if (looksLikeAntiBotPage(html)) {
    throw new Error('网页需要验证码或反机器人验证');
  }
  if (/(?:subscribe to continue|sign in to continue|log in to continue|订阅后继续|登录后查看全文)/i.test(text)
    && text.length < 5000) {
    throw new Error('网页正文受登录或付费墙限制');
  }
  if (/\/(?:login|signin)(?:[/?#]|$)/i.test(new URL(url).pathname) && text.length < 5000) {
    throw new Error('原文链接重定向到登录页');
  }
}

function looksLikeAntiBotPage(html) {
  const raw = String(html || '');
  const challengeWords = /(?:captcha|verify (?:you are|that you are) human|checking your browser|access denied|just a moment|attention required|security check|请输入验证码)/i;
  const challengeInfrastructureHint = /(?:challenges\.cloudflare\.com|google\.com\/recaptcha|recaptcha\.net|hcaptcha\.com\/1\/api\.js|cf-chl-[a-z_-]+|__cf_chl_)/i;
  if (!challengeWords.test(raw) && !challengeInfrastructureHint.test(raw)) return false;
  let dom, document;
  try { dom = new JSDOM(raw); document = dom.window.document; } catch {}
  try {
    const title = cleanText(document?.title || '');
    const visibleText = cleanText(document?.body?.textContent || raw);
    const articleText = cleanText(document?.querySelector(
      'article,main,[role="main"],.ltx_document',
    )?.textContent || '');
    const challengeInfrastructure = Boolean(document?.querySelector([
      'script[src*="challenges.cloudflare.com"]',
      'script[src*="recaptcha"]',
      'script[src*="hcaptcha.com"]',
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha.com"]',
      '[id^="cf-chl-"]',
      'form[action*="challenge"]',
    ].join(','))) || /__cf_chl_/i.test(raw);
    const challengeTitle = /^(?:just a moment(?:\.{1,3})?|attention required!?|access denied!?|verify (?:you are|that you are) human!?|security check|captcha)$/i
      .test(title);
    const shortChallengePrompt = challengeWords.test(`${title} ${visibleText}`)
      && visibleText.length < 1500
      && articleText.length < 500;
    return challengeInfrastructure || challengeTitle || shortChallengePrompt;
  } finally { dom?.window.close(); }
}

function metadata(document, selectors, ...attributes) {
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (!node) continue;
    for (const attribute of attributes) {
      const value = node.getAttribute(attribute);
      if (value) return value;
    }
    if (node.textContent?.trim()) return node.textContent.trim();
  }
  return '';
}

function decodeHtmlBuffer(buffer, contentType) {
  const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('ascii');
  const declared = /charset\s*=\s*["']?\s*([A-Za-z0-9._-]+)/i.exec(String(contentType || ''))?.[1]
    || /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9._-]+)/i.exec(head)?.[1]
    || 'utf-8';
  try {
    return new TextDecoder(declared, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}

function notionIdFromText(value) {
  const compactMatches = [...value.matchAll(/(?<![a-f0-9])([a-f0-9]{32})(?![a-f0-9])/ig)];
  const dashedMatches = [...value.matchAll(
    /(?<![a-f0-9])([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?![a-f0-9])/ig,
  )];
  const rawId = [...compactMatches, ...dashedMatches]
    .sort((left, right) => left.index - right.index)
    .at(-1)?.[1];
  if (!rawId) return undefined;
  const id = rawId.replace(/-/g, '').toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}


function extractInputUrls(text) {
  return (String(text || '').match(/https?:\/\/[^\s<>()，。；：！？】【、】【【】）》〉]+/g) || [])
    .map((url) => url.replace(/[.,;:!?)\]}>，。；：！？】【、】【【】）》〉]+$/, ''));
}

function arxivSourceUrls(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return undefined; }
  if (![
    'arxiv.org',
    'www.arxiv.org',
    'alphaxiv.org',
    'www.alphaxiv.org',
  ].includes(url.hostname.toLowerCase())) return undefined;
  const match = /^\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}(?:v\d+)?)(?:\.pdf)?(?:\/|$)/i.exec(url.pathname);
  if (!match) return undefined;
  const id = match[1];
  return {
    id,
    html: `https://arxiv.org/html/${id}`,
    pdf: `https://arxiv.org/pdf/${id}`,
  };
}

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTextPreservingLines(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanPdfMeta(value) {
  const text = cleanText(value);
  return /^(?:none|unknown|untitled)$/i.test(text) ? '' : text;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}
