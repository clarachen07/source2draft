import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
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
  parseTranslationScope,
  scopeLabel,
} from './translation-scope.js';

// Single active translation source: retain document structure and visual assets while replacing only translatable units.
const DOCUMENT_VERSION = 5;
const CHECKPOINT_VERSION = 6;
const TRANSLATION_BATCH_MAX_CHARS = 8000;
const TRANSLATION_BATCH_MAX_ITEMS = 24;
const TRANSLATION_SHORT_UNIT_MAX_ITEMS = 48;
const TRANSLATION_SHORT_UNIT_AVERAGE_CHARS = 120;
const REPAIR_BATCH_MAX_CHARS = 4000;
const REPAIR_BATCH_MAX_ITEMS = 6;
const EMBEDDED_CHART_MIN_WIDTH = 200;
const EMBEDDED_CHART_MIN_HEIGHT = 120;
const EMBEDDED_CHART_MAX_WIDTH = 2400;
const EMBEDDED_CHART_MAX_HEIGHT = 5000;
const EMBEDDED_CHART_MAX_PIXELS = 8_000_000;
const EMBEDDED_CHART_MIN_PNG_BYTES = 4096;
const DEFAULT_LIMITS = {
  maxSourceBytes: 50 * 1024 * 1024,
  maxPdfPages: 120,
  browserTimeoutMs: 45000,
  fetchTimeoutMs: 30000,
  maxRedirects: 5,
  maxAssetCount: 80,
  maxAssetBytes: 40 * 1024 * 1024,
  maxSingleAssetBytes: 10 * 1024 * 1024,
};
const execFileAsync = promisify(execFile);
const DOCUMENT_BLOCK_TYPES = new Set([
  'heading', 'paragraph', 'quote', 'list_item', 'figure', 'table', 'equation', 'code', 'reference',
]);
const EXCLUDED_CONTENT_SELECTOR = [
  'script', 'style', 'noscript', 'nav', 'form', 'aside',
  'body > header', 'body > footer', 'video', 'audio', 'iframe',
  '[aria-hidden="true"]', '[hidden]', '.advertisement', '.advert', '.ads',
  '.related-posts', '.recommended', '.comments', '#comments', '.cookie-banner',
  '.newsletter-signup', '.social-share',
].join(',');

export async function generateStructuredTranslation({
  input,
  sourceUrl: explicitSourceUrl,
  sourceRequestHeaders = {},
  workflow,
  writer,
  fetchFn,
  fetchWithRetry,
  completeArticle,
  onProgress,
  onInferenceTelemetry,
  onTelemetry,
  translationConfig = {},
  documentConfig = {},
  resumeFromCheckpoint = false,
  signal,
}) {
  throwIfTaskCancelled(signal);
  const sourceUrl = explicitSourceUrl || extractInputUrls(input)[0];
  if (!sourceUrl) throw new Error('直译任务缺少可读取的 http(s) 原文链接');
  const scope = parseTranslationScope(input);

  await report(onProgress, {
    stage: 'source',
    message: `正在提取原文结构，翻译范围：${scopeLabel(scope)}`,
    completed: 0,
    total: 1,
  });
  const acquired = await acquireSourceDocument({
    sourceUrl,
    workDir: workflow.workDir,
    fetchFn,
    fetchWithRetry,
    config: { ...translationConfig, onTelemetry },
    documentConfig,
    dnsLookup: translationConfig.dnsLookup,
    scope,
    onProgress,
    requestHeaders: sourceRequestHeaders,
    signal,
  });
  throwIfTaskCancelled(signal);
  let source = acquired.scope?.kind === 'sections' && acquired.scope.appliedStartHeading
    ? acquired
    : applyTranslationScope(acquired, scope);
  source.scope = source.scope || scope;
  source = removeRepeatedSourceMetadata(source);
  assertSourceDocumentComplete(source);
  const manifest = buildDocumentManifest(source);
  await report(onProgress, {
    stage: 'structure',
    message: `已提取 ${manifest.blocks} 个结构块：${manifest.headings} 个标题、${manifest.figures} 张图、${manifest.tables} 个表格${manifest.pageCoverage
      ? `，页级覆盖 ${manifest.pageCoverage.processedPages}/${manifest.pageCoverage.requestedPages}`
      : ''}`,
    completed: 1,
    total: 1,
  });

  const translated = await translateDocument({
    source,
    workDir: workflow.workDir,
    model: workflow.model || writer.model,
    writer,
    fetchFn,
    completeArticle,
    timeoutMs: workflow.timeoutMs,
    onProgress,
    onInferenceTelemetry,
    onTelemetry,
    batchConcurrency: translationConfig.batchConcurrency,
    resumeFromCheckpoint,
    signal,
  });
  throwIfTaskCancelled(signal);
  const article = renderTranslatedDocument(translated);
  const completeness = validateTranslationArtifact({ source, translated, article });
  if (completeness.errors.length) {
    throw new Error(`直译完整性门禁失败:${completeness.errors.join('; ')}`);
  }
  await report(onProgress, {
    stage: 'validation',
    message: completeness.reviewRequiredCount
      ? `结构完整性通过：${completeness.blocks} 个内容块，${completeness.reviewRequiredCount} 个译块需人工复核`
      : `结构化直译严格等价校验通过：${completeness.blocks} 个内容块`,
    completed: 1,
    total: 1,
  });

  return {
    article,
    sourceUrl: source.sourceUrl,
    manifest: {
      ...manifest,
      title: source.title,
      author: source.author,
      publishedDate: source.publishedDate,
      sourceUrl: source.sourceUrl,
      sourceType: source.sourceType,
      extractor: source.extractor,
      sha256: source.sha256,
      acquisition: source.acquisition,
      scope: source.scope,
    },
    completeness,
    warnings: completeness.warnings,
    contentPolicy: {
      allow_code_blocks: source.blocks.some((block) => block.type === 'code'),
      source: source.blocks.some((block) => block.type === 'code')
        ? 'translation-source-code'
        : 'translation-source-no-code',
    },
  };
}

export async function acquireSourceDocument({
  sourceUrl,
  workDir,
  fetchFn = globalThis.fetch,
  fetchWithRetry,
  config = {},
  documentConfig = {},
  dnsLookup = dns.lookup,
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
    () => assertSafeHttpUrl(sourceUrl, { dnsLookup }));
  if (/(^|\.)(?:notion\.so|notion\.site|linear\.app)$/.test(new URL(sourceUrl).hostname) || new URL(sourceUrl).hostname === 'docs.google.com') {
    throw new Error('第一版不支持私有文档平台；请导出 PDF 或文本后上传到 Slack');
  }
  fs.mkdirSync(workDir, { recursive: true });
  const acquisition = { attempts: [], fallbacks: [] };
  const arxiv = arxivSourceUrls(sourceUrl);
  let acquisitionUrl = arxiv ? (scope.kind === 'pages' ? arxiv.pdf : arxiv.html) : sourceUrl;
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
      workDir,
      fetchFn,
      fetchWithRetry,
      config,
      dnsLookup,
      scope,
      signal,
    });
    document.acquisition = acquisition;
    const embeddedCharts = inspectEmbeddedChartFrames(html);
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
  scope = { kind: 'all' },
  signal,
}) {
  throwIfTaskCancelled(signal);
  acquisition.attempts.push('playwright-structure');
  const rendered = await renderWithBrowser({
    sourceUrl,
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
  scope = { kind: 'all' },
  signal,
}) {
  const sourceDom = new JSDOM(String(html || ''), { url: documentUrl });
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
  const bodyDom = new JSDOM(`<main>${bodyHtml}</main>`, { url: documentUrl });
  discardExcludedContent(bodyDom.window.document);
  const root = bodyDom.window.document.querySelector('main');
  const extractedBlocks = blocksFromDom(root, documentUrl);
  const scoped = scope.kind === 'sections'
    ? applyTranslationScope({ blocks: extractedBlocks }, scope)
    : { blocks: extractedBlocks, scope };
  const blocks = scoped.blocks;
  if (workDir) {
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
  scope = { kind: 'all' },
  signal,
}) {
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let paragraph = [];
  let blockIndex = 0;
  let inFence = false;
  let fenceLines = [];
  let referencesStarted = false;

  const push = (block) => {
    const hasContent = block.text?.trim()
      || (block.type === 'figure' && block.images?.length)
      || (block.type === 'table' && block.rows?.length)
      || (block.type === 'equation' && block.tex?.trim());
    if (!hasContent) return;
    blocks.push({ ...block, id: `b${String(++blockIndex).padStart(6, '0')}`, order: blocks.length });
  };
  const flushParagraph = () => {
    const text = cleanMarkdownText(paragraph.join(' '));
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
        text: cleanMarkdownText(list[3]),
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

  const scoped = scope.kind === 'sections'
    ? applyTranslationScope({ blocks }, scope)
    : { blocks, scope };
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
  const document = await sourceDocumentFromHtml({
    html: converted.html,
    sourceUrl,
    documentUrl: resolvedSourceUrl || sourceUrl,
    extractor: 'datalab-marker-html',
    workDir,
    fetchFn,
    config,
    assetMap: converted.images,
    scope,
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
  document.scope = scope;
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

export async function translateDocument({
  source,
  workDir,
  model,
  writer,
  fetchFn,
  completeArticle,
  timeoutMs,
  onProgress,
  onInferenceTelemetry,
  onTelemetry,
  batchConcurrency = 2,
  resumeFromCheckpoint = false,
  signal,
}) {
  throwIfTaskCancelled(signal);
  const units = translationUnits(source);
  if (!units.length) throw new Error('原文没有可翻译的结构化文本');
  const checkpointPath = path.join(workDir, 'translation-checkpoint.json');
  const checkpointKey = crypto.createHash('sha256')
    .update(JSON.stringify({ version: CHECKPOINT_VERSION, source: source.sha256, model, units }))
    .digest('hex');
  const completed = new Map();
  const validationWarnings = new Map();
  const validationExceptions = new Map();
  let checkpointInvalidatedUnits = 0;
  if (resumeFromCheckpoint) {
    try {
      const saved = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
      if (saved.key === checkpointKey) {
        for (const item of saved.translations || []) completed.set(item.id, item.text);
        for (const item of saved.warnings || []) {
          if (item?.id && Array.isArray(item.messages)) validationWarnings.set(item.id, item.messages);
        }
        for (const item of saved.validationExceptions || []) {
          if (item?.id) validationExceptions.set(item.id, item);
        }
      }
    } catch {}
  }
  if (completed.size) {
    const unitMap = new Map(units.map((unit) => [unit.id, unit]));
    for (const [id, text] of [...completed]) {
      const unit = unitMap.get(id);
      const assessment = unit
        ? assessTranslationUnit(unit, text, { afterRepair: true })
        : { hardErrors: ['断点含未知文本块'], warnings: [] };
      const blockingErrors = assessment.hardErrors.filter((reason) => !isReviewableEquivalenceError(reason));
      const exception = validationExceptions.get(id);
      const exceptionMatches = Boolean(
        exception
        && exception.source === unit?.text
        && exception.selected === text
        && Array.isArray(exception.candidates)
        && blockingErrors.length === 0
        && assessment.hardErrors.every(isReviewableEquivalenceError),
      );
      if (blockingErrors.length
        || ((assessment.hardErrors.length || assessment.warnings.length) && !exceptionMatches)) {
        completed.delete(id);
        validationWarnings.delete(id);
        validationExceptions.delete(id);
        checkpointInvalidatedUnits += 1;
        continue;
      }
      if (!assessment.hardErrors.length && !assessment.warnings.length) {
        validationWarnings.delete(id);
        validationExceptions.delete(id);
      } else if (!validationWarnings.has(id)) {
        validationWarnings.set(id, [
          ...assessment.hardErrors.map((reason) => `${id}: 两轮聚焦修复后宽松放行:${reason}`),
          ...assessment.warnings.map((reason) => `${id}: ${reason}`),
        ]);
      }
    }
  }
  const writeCheckpoint = () => {
    const started = performance.now();
    writeJsonAtomic(checkpointPath, {
      version: CHECKPOINT_VERSION,
      key: checkpointKey,
      translations: [...completed].map(([id, text]) => ({ id, text })),
      warnings: [...validationWarnings].map(([id, messages]) => ({ id, messages })),
      validationExceptions: [...validationExceptions.values()],
      updatedAt: new Date().toISOString(),
    });
    emitTelemetry(onTelemetry, { stage: 'translation-checkpoint', durationMs: performance.now() - started, count: 1 });
  };
  if (completed.size) emitTelemetry(onTelemetry, { stage: 'translation-checkpoint', count: completed.size, cacheHit: true });
  if (checkpointInvalidatedUnits) writeCheckpoint();

  const pendingUnits = units.filter((unit) => !completed.has(unit.id));
  const initialBatchMaxItems = adaptiveTranslationBatchMaxItems(pendingUnits);
  const batches = batchUnits(
    pendingUnits,
    TRANSLATION_BATCH_MAX_CHARS,
    initialBatchMaxItems,
  );
  await report(onProgress, {
    stage: 'translation',
    message: completed.size
      ? `从结构化断点继续翻译 ${completed.size}/${units.length}${checkpointInvalidatedUnits
        ? `（按新规则重验，${checkpointInvalidatedUnits} 个旧单元需重做）`
        : ''}`
      : `开始翻译标题、正文及图表标题，共 ${units.length} 个文本单元`,
    completed: completed.size,
    total: units.length,
  });

  const effectiveBatchConcurrency = Math.max(1, Math.min(2, Number(batchConcurrency) || 1));
  await mapBounded(batches, effectiveBatchConcurrency, async (batch, batchIndex) => {
    throwIfTaskCancelled(signal);
    const initialContext = inferenceContextFor({
      phase: 'initial', batch, batchIndex, batchTotal: batches.length,
    });
    let translations = await requestTranslationBatch({
      batch, source, model, writer, fetchFn, completeArticle, timeoutMs,
      onInferenceTelemetry, inferenceContext: initialContext, signal,
    });
    const originalTranslations = translations;
    const repairedTranslations = [];
    const candidateHistory = new Map(batch.map((unit) => [unit.id, []]));
    for (const item of originalTranslations) {
      if (candidateHistory.has(item.id)) candidateHistory.get(item.id).push({ ...item, round: 0 });
    }
    let assessments = assessBatchTranslations(batch, translations);
    for (let repairRound = 1; repairRound <= 2; repairRound++) {
      const repairTargets = assessments
        .map((item) => {
          const issues = repairIssuesForAssessment(item);
          return issues.length ? {
            ...item.unit,
            currentTranslation: item.text || '',
            issues,
          } : null;
        })
        .filter(Boolean);
      if (!repairTargets.length) break;
      const repairBatches = batchUnits(
        repairTargets,
        REPAIR_BATCH_MAX_CHARS,
        REPAIR_BATCH_MAX_ITEMS,
      );
      const repairedGroups = await mapBounded(
        repairBatches,
        effectiveBatchConcurrency,
        async (repairBatch, repairBatchIndex) => requestTranslationBatch({
          batch: repairBatch,
          source,
          model,
          writer,
          fetchFn,
          completeArticle,
          timeoutMs,
          repair: true,
          onInferenceTelemetry,
          inferenceContext: inferenceContextFor({
            phase: 'repair',
            batch: repairBatch,
            batchIndex: repairBatchIndex,
            batchTotal: repairBatches.length,
            parentBatchIndex: batchIndex,
            repairRound,
          }),
          signal,
        }),
        signal,
      );
      const repaired = repairedGroups.flat();
      repairedTranslations.push(...repaired.map((item) => ({ ...item, round: repairRound })));
      for (const item of repaired) {
        if (candidateHistory.has(item.id)) {
          candidateHistory.get(item.id).push({ ...item, round: repairRound });
        }
      }
      translations = batch.map((unit) => {
        return preferredTranslation(unit, ...(candidateHistory.get(unit.id) || []));
      }).filter(Boolean);
      assessments = assessBatchTranslations(batch, translations, { afterRepair: true });
    }

    translations = normalizeBatchHighlights(batch, translations);
    assessments = assessBatchTranslations(batch, translations, { afterRepair: true });
    const acceptedIds = new Set();
    for (const assessment of assessments) {
      const reviewableErrors = assessment.hardErrors.filter(isReviewableEquivalenceError);
      const blockingErrors = assessment.hardErrors.filter((reason) => !isReviewableEquivalenceError(reason));
      if (blockingErrors.length) continue;
      const text = String(assessment.text || '').trim();
      if (!text) continue;
      completed.set(assessment.unit.id, text);
      acceptedIds.add(assessment.unit.id);
      if (reviewableErrors.length || assessment.warnings.length) {
        const messages = [
          ...reviewableErrors.map((reason) => `两轮聚焦修复后宽松放行:${reason}`),
          ...assessment.warnings,
        ].map((warning) => `${assessment.unit.id}: ${warning}`);
        validationWarnings.set(
          assessment.unit.id,
          messages,
        );
        validationExceptions.set(assessment.unit.id, {
          id: assessment.unit.id,
          source: assessment.unit.text,
          selected: text,
          reasons: reviewableErrors,
          warnings: assessment.warnings,
          candidates: candidateHistory.get(assessment.unit.id) || [],
        });
      } else {
        validationWarnings.delete(assessment.unit.id);
        validationExceptions.delete(assessment.unit.id);
      }
    }

    // One durable write per batch, before rejecting invalid peers, preserves accepted
    // units without repeatedly serializing the entire growing checkpoint.
    if (acceptedIds.size) writeCheckpoint();

    const invalid = assessments.filter((item) => item.hardErrors
      .some((reason) => !isReviewableEquivalenceError(reason)));
    if (invalid.length) {
      const validation = invalid.map((item) => ({
        id: item.unit.id,
        reasons: item.hardErrors.filter((reason) => !isReviewableEquivalenceError(reason)),
        warnings: item.warnings,
      }));
      writeJsonAtomic(path.join(workDir, 'translation-invalid.json'), {
        failedAt: new Date().toISOString(),
        units: invalid.map((item) => ({ id: item.unit.id, source: item.unit.text })),
        validation,
        received: translations.map((item) => ({ id: item.id, text: item.text })),
        originalReceived: originalTranslations.map((item) => ({ id: item.id, text: item.text })),
        repairReceived: repairedTranslations,
        checkpointed: [...acceptedIds],
      });
      throw new Error(`结构化翻译校验失败:${validation
        .map((item) => `${item.id}(${item.reasons.join('+')})`)
        .join(',')}`);
    }
    if (validationExceptions.size) {
      writeJsonAtomic(path.join(workDir, 'translation-review.json'), {
        updatedAt: new Date().toISOString(),
        reviewRequired: [...validationExceptions.values()],
      });
    }
    await report(onProgress, {
      stage: 'translation',
      message: `结构化翻译进度 ${completed.size}/${units.length}`,
      completed: completed.size,
      total: units.length,
    });
  }, signal);
  throwIfTaskCancelled(signal);
  if (completed.size !== units.length) {
    const error = new Error(`结构化翻译缺块:${completed.size}/${units.length}`);
    error.retryableTranslationResponse = true;
    throw error;
  }
  try { fs.rmSync(path.join(workDir, 'translation-invalid.json'), { force: true }); } catch {}
  const translated = applyTranslations(source, completed);
  translated.validationWarnings = [...validationWarnings.values()].flat();
  translated.validationExceptions = [...validationExceptions.values()];
  return translated;
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
    const text = restoreFragments(block.translatedText ?? block.text ?? '', block.fragments);
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
      const caption = restoreFragments(block.translatedCaption ?? block.caption ?? '', block.captionFragments);
      if (caption) lines.push(captionLine(`图 ${figureNumber}`, caption), '');
    } else if (block.type === 'table') {
      tableNumber += 1;
      const caption = restoreFragments(block.translatedCaption ?? block.caption ?? '', block.captionFragments);
      if (caption) lines.push(`**表 ${tableNumber}：${caption}**`, '');
      if (block.localPath) {
        lines.push(`![原文表 ${tableNumber}](${block.localPath})`, '');
      }
    } else if (block.type === 'equation') {
      lines.push('$$', block.tex, '$$', '');
    } else if (block.type === 'code') {
      lines.push(`<pre><code>${escapeHtml(block.text || '')}</code></pre>`, '');
    } else if (block.type === 'reference') {
      referenceNumber += 1;
      previousWasReference = true;
      const reference = String(text).replace(/^\s*(?:\[\s*\d+\s*\]|\d+[.)、])\s+/, '');
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
  const exceptionIds = new Set(validationExceptions.map((item) => item.id));
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
  for (const unit of translationUnits(source)) {
    const target = translatedUnitText(translated, unit.id);
    const assessment = assessTranslationUnit(unit, target, { afterRepair: true });
    for (const reason of assessment.hardErrors) {
      if (exceptionIds.has(unit.id) && isReviewableEquivalenceError(reason)) {
        warnings.push(`${unit.id}: 两轮聚焦修复后宽松放行:${reason}`);
      } else {
        errors.push(`${reason}:${unit.id}`);
      }
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

export async function assertSafeHttpUrl(rawUrl, { dnsLookup = dns.lookup } = {}) {
  return (await resolveSafeHttpUrl(rawUrl, { dnsLookup })).url;
}

async function resolveSafeHttpUrl(rawUrl, { dnsLookup = dns.lookup } = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('原文链接格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http(s) 原文链接');
  if (url.username || url.password) throw new Error('原文链接不得包含用户名或密码');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('原文链接指向本机或内部地址');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('原文链接指向私网或保留地址');
    return { url, addresses: [{ address: host, family: net.isIPv4(host) ? 4 : 6 }] };
  }
  let records;
  try { records = await dnsLookup(host, { all: true, verbatim: true }); }
  catch (error) { throw new Error(`原文域名解析失败:${safeError(error)}`); }
  const addresses = (records || []).map((record) => ({
    address: String(record?.address || ''),
    family: Number(record?.family) || net.isIP(record?.address),
  }));
  if (!addresses.length || addresses.some((record) => !record.family || isPrivateIp(record.address))) {
    throw new Error('原文域名解析到私网或保留地址');
  }
  return { url, addresses };
}

export function isPrivateIp(address) {
  const value = String(address || '').toLowerCase();
  if (net.isIPv4(value)) {
    const [a, b, c] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }
  if (net.isIPv6(value)) {
    const bytes = ipv6Bytes(value);
    if (!bytes) return true;
    if (matchesIpv6Prefix(bytes, '::', 128) || matchesIpv6Prefix(bytes, '::1', 128)) return true;
    if (matchesIpv6Prefix(bytes, '::ffff:0:0', 96)) {
      return isPrivateIp(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
    }
    if (matchesIpv6Prefix(bytes, '64:ff9b:1::', 48)
      || matchesIpv6Prefix(bytes, '100::', 64)
      || matchesIpv6Prefix(bytes, '2001::', 23)
      || matchesIpv6Prefix(bytes, '2001:db8::', 32)
      || matchesIpv6Prefix(bytes, '3fff::', 20)
      || matchesIpv6Prefix(bytes, '5f00::', 16)
      || matchesIpv6Prefix(bytes, 'fc00::', 7)
      || matchesIpv6Prefix(bytes, 'fe80::', 10)
      || matchesIpv6Prefix(bytes, 'ff00::', 8)) return true;
    if (matchesIpv6Prefix(bytes, '2002::', 16)) {
      return isPrivateIp(`${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`);
    }
    return false;
  }
  return true;
}

function ipv6Bytes(address) {
  let value = String(address || '').split('%')[0].toLowerCase();
  if (!net.isIPv6(value)) return undefined;
  const dotted = value.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const octets = dotted.split('.').map(Number);
    value = value.slice(0, -dotted.length)
      + `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const sides = value.split('::');
  if (sides.length > 2) return undefined;
  const left = sides[0] ? sides[0].split(':').filter(Boolean) : [];
  const right = sides[1] ? sides[1].split(':').filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if ((sides.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = [...left, ...Array(sides.length === 2 ? missing : 0).fill('0'), ...right];
  if (groups.length !== 8) return undefined;
  const bytes = Buffer.alloc(16);
  for (let index = 0; index < groups.length; index += 1) {
    const group = Number.parseInt(groups[index], 16);
    if (!Number.isInteger(group) || group < 0 || group > 0xffff) return undefined;
    bytes.writeUInt16BE(group, index * 2);
  }
  return bytes;
}

function matchesIpv6Prefix(bytes, prefix, bits) {
  const prefixBytes = ipv6Bytes(prefix);
  if (!prefixBytes) return false;
  const whole = Math.floor(bits / 8);
  for (let index = 0; index < whole; index += 1) {
    if (bytes[index] !== prefixBytes[index]) return false;
  }
  const remainder = bits % 8;
  if (!remainder) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (bytes[whole] & mask) === (prefixBytes[whole] & mask);
}

export async function safeFetchResource({
  url,
  fetchFn = globalThis.fetch,
  fetchWithRetry,
  limits = DEFAULT_LIMITS,
  dnsLookup = dns.lookup,
  accept,
  headers = {},
  maxBytes = limits.maxSourceBytes,
  method = 'GET',
  body,
  pinnedFetchFactory = pinnedHttpFetch,
  signal,
}) {
  limits = { ...DEFAULT_LIMITS, ...limits };
  maxBytes ??= limits.maxSourceBytes;
  return withDeadline({ signal, timeoutMs: limits.fetchTimeoutMs, message: '原文下载超时' }, async (requestSignal) => {
    const requestMethod = String(method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(requestMethod)) throw new Error(`安全下载不支持请求方法:${requestMethod}`);
    const requestBody = body === undefined || body === null ? undefined : String(body);
    if (requestBody && Buffer.byteLength(requestBody) > 64 * 1024) throw new Error('安全下载请求体超过 64KB 上限');
    let current = url;
    let currentHeaders = { ...headers };
    for (let redirects = 0; redirects <= limits.maxRedirects; redirects += 1) {
      const resolved = await resolveSafeHttpUrl(current, { dnsLookup });
      throwIfTaskCancelled(requestSignal);
      const requestFetch = fetchUsesGlobalTransport(fetchFn)
        ? rebindFetchTransport(fetchFn, pinnedFetchFactory(resolved.addresses))
        : fetchFn;
      const response = await callFetch(fetchWithRetry, requestFetch, current, {
        redirect: 'manual',
        signal: requestSignal,
        method: requestMethod,
        body: requestBody,
        headers: {
          Accept: accept || '*/*',
          'User-Agent': 'Mozilla/5.0 Source2DraftBot/1.0',
          ...currentHeaders,
        },
      }, limits.fetchTimeoutMs);
      if (requestSignal.aborted) {
        void cancelResponseBody(response);
        throwIfTaskCancelled(requestSignal);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await cancelResponseBody(response);
        if (!location) throw new Error(`原文重定向缺少 Location:${response.status}`);
        const next = new URL(location, current).toString();
        if (new URL(next).origin !== new URL(current).origin) {
          currentHeaders = stripSensitiveRequestHeaders(currentHeaders);
        }
        current = next;
        continue;
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new Error(`原文获取失败:${response.status} ${response.statusText}`);
      }
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > maxBytes) {
        await cancelResponseBody(response);
        throw new Error(`原文响应超过大小上限:${declared}`);
      }
      const buffer = await readResponseBufferWithLimit(response, maxBytes, requestSignal);
      if (!buffer.length) throw new Error('原文响应为空');
      return {
        sourceUrl: url,
        finalUrl: current,
        contentType: response.headers.get('content-type') || '',
        buffer,
        status: response.status,
      };
    }
    throw new Error(`原文重定向超过 ${limits.maxRedirects} 次`);
  });
}

function stripSensitiveRequestHeaders(headers) {
  const sensitive = new Set(['authorization', 'cookie', 'proxy-authorization']);
  return Object.fromEntries(
    Object.entries(headers || {}).filter(([name]) => !sensitive.has(name.toLowerCase())),
  );
}

export async function readResponseBufferWithLimit(response, maxBytes, signal) {
  return readLimitedResponse(response, maxBytes, signal);
}

async function cancelResponseBody(response) {
  try { await response?.body?.cancel?.(); } catch {}
}

async function callFetch(fetchWithRetry, fetchFn, url, options, timeoutMs) {
  if (fetchWithRetry) return fetchWithRetry(fetchFn, url, options, { timeout: timeoutMs, attempts: 2 });
  return fetchFn(url, options);
}

function pinnedHttpFetch(addresses) {
  const safeAddresses = addresses.map((record) => ({ address: record.address, family: record.family }));
  return async function fetchPinned(rawUrl, options = {}) {
    const target = new URL(rawUrl);
    const transport = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request(target, {
        method: options.method || 'GET',
        headers: options.headers,
        signal: options.signal,
        lookup(_hostname, lookupOptions, callback) {
          const wantedFamily = Number(lookupOptions?.family) || 0;
          const candidates = wantedFamily
            ? safeAddresses.filter((record) => record.family === wantedFamily)
            : safeAddresses;
          const selected = candidates[0] || safeAddresses[0];
          if (!selected) {
            callback(Object.assign(new Error('安全 DNS 结果为空'), { code: 'ENOTFOUND' }));
            return;
          }
          if (lookupOptions?.all) callback(null, candidates.length ? candidates : safeAddresses);
          else callback(null, selected.address, selected.family);
        },
      }, (incoming) => {
        try {
          const responseHeaders = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
          }
          resolve(new Response(Readable.toWeb(incoming), {
            status: incoming.statusCode,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
          }));
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      });
      request.once('error', reject);
      request.end(options.body);
    });
  };
}

async function renderWithBrowser({
  sourceUrl,
  workDir,
  config,
  limits,
  dnsLookup,
  signal,
}) {
  throwIfTaskCancelled(signal);
  const resolved = await withDeadline({ signal, timeoutMs: limits.fetchTimeoutMs },
    () => resolveSafeHttpUrl(sourceUrl, { dnsLookup }));
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
    const page = await browser.newPage();
    page.setDefaultTimeout(limits.browserTimeoutMs);
    await page.route('**/*', async (route) => {
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
      workDir,
      config,
      limits,
      signal,
    });
    throwIfTaskCancelled(signal);
    const finalUrl = page.url();
    await withDeadline({ signal, timeoutMs: limits.fetchTimeoutMs },
      () => assertSafeHttpUrl(finalUrl, { dnsLookup }));
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

export function inspectEmbeddedChartFrames(html, { documentUrl = 'https://example.com/' } = {}) {
  const dom = new JSDOM(String(html || ''), { url: documentUrl });
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
  const candidates = frames
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
  return {
    detected: candidates.length,
    excludedExternalFrames: frames.filter((frame) => cleanText(frame.getAttribute('src') || '')).length,
    candidates,
  };
}

export async function captureEmbeddedChartFrames({
  page,
  html,
  workDir,
  config = {},
  limits = DEFAULT_LIMITS,
  signal,
}) {
  const inspection = inspectEmbeddedChartFrames(html);
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
  let document;
  try { document = new JSDOM(String(srcdoc || '')).window.document; }
  catch { return cleanText(title); }
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
}

async function requestTranslationBatch({
  batch,
  source,
  model,
  writer,
  fetchFn,
  completeArticle,
  timeoutMs,
  repair = false,
  allowSplit = true,
  onInferenceTelemetry,
  inferenceContext = {},
  signal,
}) {
  const protections = new Map();
  const units = batch.map((unit) => {
    if (!repair) return unit;
    const protectedText = protectInvariantText(unit.text);
    protections.set(unit.id, protectedText.tokens);
    return {
      id: unit.id,
      kind: unit.kind,
      text: protectedText.text,
      currentTranslation: String(unit.currentTranslation || ''),
      issues: Array.isArray(unit.issues) ? unit.issues : [],
    };
  });
  const request = {
    prompt: `${repair
      ? '只修复下面 JSON 中 currentTranslation 明确列出的问题；以 text 原文为准，返回完整的修复后简体中文译文。'
      : '将下面 JSON 中每个 text 完整、忠实、逐句翻译为简体中文。'}

硬性规则:
- 只返回合法 JSON，格式严格为 {"translations":[{"id":"原 ID","text":"完整译文"}]}。
- translations 必须与输入数量相同，ID 必须逐字相同且不得重复、遗漏或新增。
- 按 kind 翻译标题、正文、标题层级、图注和表题，不总结、不改写、不删减。表格正文直接保留原文截图，不进入翻译输入。
- 不添加输入中不存在的图、表、公式、引用、分析或内容概括。
- 不改变任何数值含义、Ticker、型号、占位符和正文中原有的 URL。数字词可译成等价阿拉伯数字，K/M/B/T、千分位、百分比、万/亿等可使用等价中文写法，但严禁把数值改成不等价值。
- 金融语境中的 pre-fee 必须译为“费前”或“费用前”，不得译为“税前”；after-fee 或 net of fees 译为“费后”或“扣除费用后”。
- 所有 ⟦SL_INLINE_NNN⟧ 都是公式、链接或引用占位符，必须原样、原位置、各保留一次。
- 专有名词首次出现可保留英文，普通叙述必须翻译成中文。
- 段落保持朴素排版；仅在原文强调或用户要求时使用适量加粗，不规定高亮密度。
- 每处使用 Markdown **加粗**，可包住 2–64 个字符的关键短语或短句，不能把整段全部加粗，也不能改动原意。
- title、heading、figure_caption、table_caption 禁止添加 **加粗**；除正文高亮外不得添加其它 Markdown 格式。
${repair ? `- 输入中的 ⟦SL_KEEP_N⟧ 是不可翻译占位符，必须原样、原位置、各保留一次。
- 每个单元都包含 currentTranslation 和 issues。只修复 issues 指出的块内问题，不重新发挥、总结或扩写。
- 即使 currentTranslation 为空，也必须根据 text 返回该 ID 的完整译文。` : ''}

文档标题:${source.title}
来源:${source.sourceUrl}

输入 JSON:
${JSON.stringify({ units })}`,
    model,
    writer: { ...writer, temperature: 0 },
    fetchFn,
    timeoutMs,
    onTelemetry: onInferenceTelemetry,
    inferenceContext,
    systemPrompt: '你是严谨的结构化文档翻译器。忠实翻译输入的标题、正文及图表标题，采用朴素排版。数字可采用等价中文格式，但数值含义、占位符、链接、型号和结构绝不能改变。只输出合法 JSON。',
  };
  const responseFormat = {
    type: 'json_schema',
    json_schema: {
      name: 'translation_blocks',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['translations'],
        properties: {
          translations: {
            type: 'array',
            minItems: units.length,
            maxItems: units.length,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'text'],
              properties: {
                id: { type: 'string', enum: units.map((unit) => unit.id) },
                text: { type: 'string', minLength: 1 },
              },
            },
          },
        },
      },
    },
  };
  const complete = async (nextRequest) => {
    try {
      return await completeArticle({ ...nextRequest, responseFormat });
    } catch (error) {
      if (!/(?:response[_ -]?format|json[_ -]?schema|structured output|HTTP 400|OpenRouter 400)/i.test(safeError(error))) throw error;
      return completeArticle({
        ...nextRequest,
        inferenceContext: { ...nextRequest.inferenceContext, schemaFallback: true },
      });
    }
  };
  const parseTranslations = (raw) => {
    const parsed = parseJsonPayload(raw);
    if (!Array.isArray(parsed?.translations)) return [];
    return parsed.translations
      .filter((item) => item && typeof item.id === 'string' && typeof item.text === 'string')
      .map((item) => ({
        id: item.id,
        text: repair ? restoreInvariantText(item.text, protections.get(item.id) || []) : item.text,
      }));
  };
  let bestTranslations = [];
  let lastResponseError;
  for (let attempt = 0; attempt < 2; attempt++) {
    throwIfTaskCancelled(signal);
    const retryInstruction = attempt === 0
      ? ''
      : `${repair ? '上一次修复响应缺少输入块' : '上一次响应不是完整合法 JSON 或缺少输入块'}。请重新返回全部 ${batch.length} 个块；只允许使用这些 ID：${batch.map((unit) => unit.id).join('、')}。`;
    try {
      const translations = parseTranslations(await complete({
        ...request,
        inferenceContext: { ...inferenceContext, translationResponseAttempt: attempt + 1 },
        prompt: retryInstruction
          ? request.prompt.replace(
            '\n\n输入 JSON:\n',
            `\n\n${retryInstruction}\n\n输入 JSON:\n`,
          )
          : request.prompt,
      }));
      if (translations.length > bestTranslations.length) bestTranslations = translations;
      if (hasExpectedTranslationSet(batch, translations)) return translations;
    } catch (error) {
      if (error?.retryableTranslationResponse !== true) throw error;
      lastResponseError = error;
    }
  }

  // Large structured output is more likely to truncate at the provider or gateway. After two incomplete attempts,
  // deterministically reduce to repair-batch size without losing previously persisted checkpoints.
  if (allowSplit && batch.length > 1) {
    const smallerBatches = batchUnits(batch, REPAIR_BATCH_MAX_CHARS, REPAIR_BATCH_MAX_ITEMS);
    if (smallerBatches.length > 1) {
      const recovered = [];
      for (const [splitIndex, smallerBatch] of smallerBatches.entries()) {
        throwIfTaskCancelled(signal);
        recovered.push(...await requestTranslationBatch({
          batch: smallerBatch,
          source,
          model,
          writer,
          fetchFn,
          completeArticle,
          timeoutMs,
          repair,
          allowSplit: false,
          onInferenceTelemetry,
          inferenceContext: {
            ...inferenceContext,
            itemCount: smallerBatch.length,
            inputCharacters: smallerBatch.reduce((total, unit) => total + String(unit.text || '').length, 0),
            splitBatchIndex: splitIndex + 1,
            splitBatchTotal: smallerBatches.length,
          },
          signal,
        }));
      }
      if (recovered.length > bestTranslations.length) bestTranslations = recovered;
      if (hasExpectedTranslationSet(batch, recovered)) return recovered;
    }
  }
  if (lastResponseError && bestTranslations.length === 0) throw lastResponseError;
  return bestTranslations;
}

function hasExpectedTranslationSet(batch, translations) {
  if (translations.length !== batch.length) return false;
  const expected = new Set(batch.map((unit) => unit.id));
  const received = new Set(translations.map((item) => item.id));
  return received.size === expected.size && [...expected].every((id) => received.has(id));
}

function assessBatchTranslations(batch, translations, { afterRepair = false } = {}) {
  const byId = new Map();
  const duplicateIds = new Set();
  for (const item of translations || []) {
    if (!item?.id) continue;
    if (byId.has(item.id)) duplicateIds.add(item.id);
    else byId.set(item.id, item.text);
  }
  return batch.map((unit) => {
    const assessment = assessTranslationUnit(unit, byId.get(unit.id), { afterRepair });
    if (duplicateIds.has(unit.id)) {
      assessment.hardErrors.unshift('重复文本块');
      assessment.repairableIssues.unshift('重复文本块');
    }
    return { unit, text: byId.get(unit.id), ...assessment };
  });
}

export function assessTranslationUnit(unit, text, { afterRepair = false } = {}) {
  const hardErrors = [];
  const repairableIssues = [];
  const warnings = [];
  if (!text?.trim()) {
    hardErrors.push('缺失译文');
    repairableIssues.push('缺失译文');
    return { hardErrors, repairableIssues, warnings };
  }

  const exactMismatch = compareExactInvariantTokens(unit.text, text);
  if (exactMismatch) {
    hardErrors.push(exactMismatch);
    repairableIssues.push(exactMismatch);
  }

  const numeric = assessNumericEquivalence(unit.text, text);
  hardErrors.push(...numeric.hardErrors);
  warnings.push(...numeric.warnings);
  if (!afterRepair) repairableIssues.push(...numeric.hardErrors, ...numeric.warnings);

  if (isClearlyUntranslated(unit.text, text)) {
    hardErrors.push('疑似未完成翻译');
    repairableIssues.push('疑似未完成翻译');
  }
  return {
    hardErrors: [...new Set(hardErrors)],
    repairableIssues: [...new Set(repairableIssues)],
    warnings: [...new Set(warnings)],
  };
}

function preferredTranslation(unit, ...items) {
  const candidates = items.filter((item) => item?.id === unit.id && item.text?.trim());
  if (!candidates.length) return undefined;
  return candidates.reduce((best, item) => {
    return compareCandidateScore(translationCandidateScore(unit, item), translationCandidateScore(unit, best)) < 0
      ? item
      : best;
  });
}

function translationCandidateScore(unit, item) {
  if (!item?.text?.trim()) return [1, 1, 1, 1, 1, Number.POSITIVE_INFINITY];
  const assessment = assessTranslationUnit(unit, item.text, { afterRepair: true });
  const errors = assessment.hardErrors;
  return [
    errors.some((reason) => /缺失译文|重复文本块|疑似未完成翻译/.test(reason)) ? 1 : 0,
    errors.some((reason) => /URL、占位符、Ticker 或型号标识不一致/.test(reason)) ? 1 : 0,
    errors.some((reason) => /明确阿拉伯数字缺失或改变/.test(reason)) ? 1 : 0,
    errors.some((reason) => /译文新增不等值数字/.test(reason)) ? 1 : 0,
    assessment.warnings.length,
    Number(item.round || 0),
  ];
}

function compareCandidateScore(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isReviewableEquivalenceError(reason) {
  return /URL、占位符、Ticker 或型号标识不一致|数字或链接不等价/.test(String(reason || ''));
}

function hasSafeSelectiveHighlights(unit, translated) {
  const value = String(translated || '');
  const markers = value.match(/\*\*/g) || [];
  const highlights = [...value.matchAll(/\*\*([^*\n]+)\*\*/g)].map((match) => match[1].trim());
  if (markers.length !== highlights.length * 2) return false;
  const allowed = ['paragraph', 'quote', 'list_item'].includes(unit.kind);
  if (!allowed) return highlights.length === 0;
  const visibleCharacters = Math.max(1, value.replace(/\*\*/g, '').length);
  const maxHighlights = visibleCharacters < 30 ? 1 : Math.max(1, Math.ceil(visibleCharacters / 65));
  if (highlights.length > maxHighlights) return false;
  if (highlights.some((text) => text.length < 2 || text.length > 64)) return false;
  const highlightedCharacters = highlights.reduce((sum, text) => sum + text.length, 0);
  return highlightedCharacters / visibleCharacters <= 0.45;
}

function normalizeBatchHighlights(batch, translations) {
  const unitsById = new Map(batch.map((unit) => [unit.id, unit]));
  return translations.map((item) => {
    const unit = unitsById.get(item.id);
    if (!unit || hasSafeSelectiveHighlights(unit, item.text)) return item;
    return { ...item, text: String(item.text).replaceAll('**', '') };
  });
}

function protectInvariantText(value) {
  const tokens = [];
  const text = String(value).replace(
    /⟦SL_INLINE_\d{3}⟧|https?:\/\/[^\s)\]}>"']+|\\[A-Za-z]+|\$[A-Z]{1,6}\b|\b(?:NASDAQ|NYSE|AMEX|OTC)\s*:\s*[A-Z]{1,6}\b|\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b|\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z][A-Za-z0-9]{2,}\b|[$€£¥]?[-+]?\d+(?:[,.]\d+)*(?:%|‰|[KMBT](?=\b))?/gi,
    (token) => `⟦SL_KEEP_${tokens.push(token)}⟧`,
  );
  return { text, tokens };
}

function restoreInvariantText(value, tokens) {
  let text = String(value);
  tokens.forEach((token, index) => { text = text.replaceAll(`⟦SL_KEEP_${index + 1}⟧`, token); });
  return text;
}

function translationUnits(document) {
  const units = [{ id: 'meta:title', text: document.title || '原文直译', kind: 'title' }];
  for (const block of document.blocks) {
    if (['heading', 'paragraph', 'quote', 'list_item'].includes(block.type) && block.text?.trim()) {
      units.push({ id: block.id, text: block.text, kind: block.type });
    }
    if (block.type === 'figure' && block.caption?.trim()) {
      units.push({ id: `${block.id}:caption`, text: block.caption, kind: 'figure_caption' });
    }
    if (block.type === 'table') {
      if (block.caption?.trim()) units.push({ id: `${block.id}:caption`, text: block.caption, kind: 'table_caption' });
    }
  }
  return units;
}

function applyTranslations(source, completed) {
  const document = structuredClone(source);
  document.translatedTitle = completed.get('meta:title') || source.title;
  for (const block of document.blocks) {
    if (completed.has(block.id)) {
      block.translatedText = normalizeKnownFinancialTerms(block.text, completed.get(block.id));
    }
    if (completed.has(`${block.id}:caption`)) {
      block.translatedCaption = normalizeKnownFinancialTerms(
        block.caption,
        completed.get(`${block.id}:caption`),
      );
    }
  }
  return document;
}

function normalizeKnownFinancialTerms(source, translated) {
  let value = String(translated || '');
  if (/\bpre-fee\b/i.test(String(source || ''))) {
    value = value.replace(/税前(?=(?:回报|收益))/g, '费用前');
  }
  return value;
}

function translatedUnitText(document, id) {
  if (id === 'meta:title') return document.translatedTitle;
  const direct = document.blocks.find((block) => block.id === id);
  if (direct) return direct.translatedText;
  const caption = /^(b\d+):caption$/.exec(id);
  if (caption) return document.blocks.find((block) => block.id === caption[1])?.translatedCaption;
  return undefined;
}

function adaptiveTranslationBatchMaxItems(units) {
  if (!units.length) return TRANSLATION_BATCH_MAX_ITEMS;
  const averageChars = units.reduce((total, unit) => total + String(unit.text || '').length, 0) / units.length;
  return averageChars <= TRANSLATION_SHORT_UNIT_AVERAGE_CHARS
    ? TRANSLATION_SHORT_UNIT_MAX_ITEMS
    : TRANSLATION_BATCH_MAX_ITEMS;
}

function repairIssuesForAssessment(assessment) {
  const warningOnly = new Set(assessment.warnings || []);
  return [...new Set([
    ...(assessment.hardErrors || []),
    ...(assessment.repairableIssues || []).filter((reason) => !warningOnly.has(reason)),
  ])];
}

function inferenceContextFor({
  phase,
  batch,
  batchIndex,
  batchTotal,
  parentBatchIndex,
  repairRound,
}) {
  return {
    phase,
    batchIndex: batchIndex + 1,
    batchTotal,
    itemCount: batch.length,
    inputCharacters: batch.reduce((total, unit) => total + String(unit.text || '').length, 0),
    ...(parentBatchIndex === undefined ? {} : { parentBatchIndex: parentBatchIndex + 1 }),
    ...(repairRound === undefined ? {} : { repairRound }),
  };
}

async function mapBounded(values, concurrency, mapper, signal) {
  const results = new Array(values.length);
  let cursor = 0;
  let firstError;
  const worker = async () => {
    while (!firstError) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      try {
        throwIfTaskCancelled(signal);
        results[index] = await mapper(values[index], index);
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
  };
  const workerCount = Math.min(values.length, Math.max(1, Math.floor(Number(concurrency) || 1)));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

function batchUnits(units, maxChars, maxItems) {
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const unit of units) {
    if (batch.length && (batch.length >= maxItems || chars + unit.text.length > maxChars)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(unit);
    chars += unit.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function exactInvariantTokens(value) {
  const text = String(value || '');
  const tokens = [
    ...(text.match(/⟦SL_INLINE_\d{3}⟧/g) || []),
    ...exactInvariantUrls(text),
    ...(text.match(/\\[A-Za-z]+/g) || []),
    ...(text.match(/\$[A-Z]{1,6}\b|\b(?:NASDAQ|NYSE|AMEX|OTC)\s*:\s*[A-Z]{1,6}\b/g) || []),
    ...(text.match(/\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b/g) || []),
    ...(text.match(/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z][A-Za-z0-9]{2,}\b/g) || []),
  ];
  return tokens.sort();
}

function exactInvariantUrls(value) {
  return (String(value || '').match(/https?:\/\/[^\s)\]}>"'】。，；！？]+/gi) || [])
    .map((token) => token.replace(/[】）.,;:!?。，；：！？]+$/gu, ''))
    .filter(Boolean);
}

function compareExactInvariantTokens(source, translated) {
  const sourceTokens = exactInvariantTokens(source);
  const targetTokens = exactInvariantTokens(translated);
  return JSON.stringify(sourceTokens) === JSON.stringify(targetTokens)
    ? null
    : 'URL、占位符、Ticker 或型号标识不一致';
}

function maskExactInvariantTokens(value) {
  let text = String(value || '');
  for (const token of exactInvariantTokens(text).sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(token, ' '.repeat(token.length));
  }
  return text;
}

function explicitNumericSignature(value) {
  const masked = maskExactInvariantTokens(value);
  return [
    ...invariantNumericSignature(masked, {
      expandShorthand: true,
      normalizePercentWords: true,
    }),
    ...chineseWrittenNumbers(masked),
  ].sort();
}

function assessNumericEquivalence(source, translated) {
  const sourceNumbers = explicitNumericSignature(source);
  const targetNumbers = explicitNumericSignature(translated);
  if (JSON.stringify(sourceNumbers) === JSON.stringify(targetNumbers)) {
    return { hardErrors: [], warnings: [] };
  }

  const sourceCounts = countTokens(sourceNumbers);
  const targetCounts = countTokens(targetNumbers);
  const allowanceCounts = countTokens([
    ...englishMonthNumbers(maskExactInvariantTokens(source)),
    ...englishNumberPhraseNumbers(maskExactInvariantTokens(source)),
  ]);
  const missing = [];
  const unexplained = [];
  for (const [token, count] of sourceCounts) {
    const missingCount = count - (targetCounts.get(token) || 0);
    if (missingCount > 0) missing.push(`${token}×${missingCount}`);
  }
  for (const [token, count] of targetCounts) {
    const extra = count - (sourceCounts.get(token) || 0);
    if (extra > (allowanceCounts.get(token) || 0)) {
      unexplained.push(`${token}×${extra - (allowanceCounts.get(token) || 0)}`);
    }
  }
  if (missing.length) {
    return {
      hardErrors: [`数字或链接不等价（明确阿拉伯数字缺失或改变：${missing.join('、')}）`],
      warnings: [],
    };
  }
  if (!unexplained.length) return { hardErrors: [], warnings: [] };
  if (containsNumericLanguage(source)) {
    return {
      hardErrors: [],
      warnings: [`低置信度数字格式差异（请人工抽查：${unexplained.join('、')}）`],
    };
  }
  return {
    hardErrors: [`数字或链接不等价（译文新增不等值数字：${unexplained.join('、')}）`],
    warnings: [],
  };
}

function invariantNumbers(value) {
  return (String(value).match(/(?<![A-Za-z0-9])[-+]?\d+(?:[,.]\d+)*(?:%|‰)?/g) || [])
    .map((token) => canonicalInvariantNumber(token))
    .filter(Boolean)
    .sort();
}

function invariantNumericSignature(
  value,
  { expandShorthand = false, normalizePercentWords = false } = {},
) {
  const magnitudeMultipliers = {
    thousand: 1_000n,
    million: 1_000_000n,
    billion: 1_000_000_000n,
    trillion: 1_000_000_000_000n,
    万: 10_000n,
    十万: 100_000n,
    百万: 1_000_000n,
    千万: 10_000_000n,
    亿: 100_000_000n,
    十亿: 1_000_000_000n,
    百亿: 10_000_000_000n,
    千亿: 100_000_000_000n,
    万亿: 1_000_000_000_000n,
  };
  const magnitudeTokens = [];
  let masked = String(value).replaceAll('**', '').replaceAll('−', '-');
  if (normalizePercentWords) {
    masked = masked.replace(
      /(?<![A-Za-z0-9])([-+]?\d+(?:[,.]\d+)*)\s*(?:percent|per\s+cent)\b/gi,
      (match, amount) => {
        const normalized = normalizeMagnitudeAmount(amount, 1n);
        if (normalized) magnitudeTokens.push(`PCT:${normalized}`);
        return ' '.repeat(match.length);
      },
    );
  }
  if (expandShorthand) {
    const shorthandMultipliers = {
      k: 1_000n,
      m: 1_000_000n,
      b: 1_000_000_000n,
      bn: 1_000_000_000n,
      t: 1_000_000_000_000n,
    };
    masked = masked.replace(
      /(?<![A-Za-z0-9])(?:[$€£¥]\s*)?([-+]?\d+(?:[,.]\d+)*)\s*(bn|[KMBT])\b/gi,
      (match, amount, unit) => {
        const normalized = normalizeMagnitudeAmount(
          amount,
          shorthandMultipliers[unit.toLowerCase()],
        );
        if (normalized) magnitudeTokens.push(`NUM:${normalized}`);
        return ' '.repeat(match.length);
      },
    );
  }
  masked = masked.replace(
    /(?<![A-Za-z0-9])(?:[$€£¥]\s*)?(one\s+and\s+(?:a|one)\s+half|[-+]?\d+(?:[,.]\d+)*)\s*(thousand|million|billion|trillion)\b(?:\s+(?:U\.?S\.?\s+)?dollars?)?/gi,
    (match, amount, unit) => {
      const normalized = normalizeMagnitudeAmount(amount, magnitudeMultipliers[unit.toLowerCase()]);
      if (normalized) magnitudeTokens.push(`NUM:${normalized}`);
      return ' '.repeat(match.length);
    },
  );
  masked = masked.replace(
    /(?<![A-Za-z0-9])(?:[$€£¥]\s*)?([-+]?\d+(?:[,.]\d+)*)\s*(万亿|千亿|百亿|十亿|千万|百万|十万|亿|万)(?:\s*(?:美元|美金|人民币|欧元|英镑|日元|元))?/g,
    (match, amount, unit) => {
      const normalized = normalizeMagnitudeAmount(amount, magnitudeMultipliers[unit]);
      if (normalized) magnitudeTokens.push(`NUM:${normalized}`);
      return ' '.repeat(match.length);
    },
  );
  return [...invariantNumbers(masked), ...magnitudeTokens].sort();
}

function canonicalInvariantNumber(token) {
  const value = String(token);
  const suffix = value.endsWith('%') ? 'PCT' : value.endsWith('‰') ? 'PERMILLE' : 'NUM';
  const amount = suffix === 'NUM' ? value : value.slice(0, -1);
  const normalized = normalizeMagnitudeAmount(amount, 1n);
  return normalized ? `${suffix}:${normalized}` : null;
}

function normalizeMagnitudeAmount(value, multiplier) {
  if (!multiplier) return null;
  const wholeNumbers = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  const phrase = String(value).trim().toLowerCase();
  const fraction = /^(one|two|three|four|five|six|seven|eight|nine|ten)\s+and\s+(?:a|one)\s+half$/.exec(phrase);
  const decimal = fraction ? `${wholeNumbers[fraction[1]]}.5` : phrase.replaceAll(',', '');
  const parsed = /^([-+]?)(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (!parsed) return null;
  const sign = parsed[1] === '-' ? -1n : 1n;
  const fractionDigits = parsed[3] || '';
  const denominator = 10n ** BigInt(fractionDigits.length);
  const numerator = BigInt(`${parsed[2]}${fractionDigits}`) * multiplier;
  const whole = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return `${sign * whole}`;
  const decimals = remainder.toString().padStart(fractionDigits.length, '0').replace(/0+$/, '');
  return `${sign < 0n ? '-' : ''}${whole}.${decimals}`;
}

function countTokens(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
}

function isClearlyUntranslated(source, translated) {
  // Protected formulas, citations, links, model IDs and similar immutable
  // tokens are intentionally identical in source and target. Do not count
  // their Latin marker text (for example SL_INLINE) as untranslated prose.
  const visibleSource = maskExactInvariantTokens(source);
  const visibleTranslated = maskExactInvariantTokens(translated);
  const sourceEnglish = (visibleSource.match(/[A-Za-z]/g) || []).length;
  if (sourceEnglish < 40) return false;
  const sourceWords = visibleSource.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const capitalized = sourceWords.filter((word) => /^[A-Z]/.test(word)).length;
  if (/[,;]/.test(visibleSource) && sourceWords.length >= 4 && capitalized / sourceWords.length >= 0.7) return false;
  const words = visibleTranslated.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const han = (visibleTranslated.match(/\p{Script=Han}/gu) || []).length;
  return words.length >= 10 && han < 4;
}

function englishMonthNumbers(value) {
  const months = {
    jan: '1', january: '1', feb: '2', february: '2', mar: '3', march: '3',
    apr: '4', april: '4', may: '5', jun: '6', june: '6', jul: '7', july: '7',
    aug: '8', august: '8', sep: '9', sept: '9', september: '9', oct: '10',
    october: '10', nov: '11', november: '11', dec: '12', december: '12',
  };
  const matches = String(value).matchAll(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/gi,
  );
  return [...matches]
    .map((match) => months[match[1].toLowerCase()])
    .filter(Boolean)
    .map((number) => `NUM:${number}`);
}

function englishNumberPhraseNumbers(value) {
  const word = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty',
    'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'hundreds', 'thousand',
    'thousands', 'million', 'millions', 'billion', 'billions', 'trillion',
    'trillions', 'and', 'first', 'second', 'third', 'fourth', 'fifth',
    'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth',
    'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth',
    'eighteenth', 'nineteenth', 'twentieth', 'thirtieth', 'fortieth', 'fiftieth',
    'sixtieth', 'seventieth', 'eightieth', 'ninetieth', 'single', 'both',
    'double', 'triple', 'dozen', 'dozens',
  ].join('|');
  const matches = String(value).matchAll(new RegExp(`\\b(?:${word})(?:[\\s-]+(?:${word}))*\\b`, 'gi'));
  return [...matches]
    .flatMap((match) => {
      const phrase = match[0];
      if (/\band\b/i.test(phrase) && !/\b(?:hundred|thousand|million|billion|trillion)\b/i.test(phrase)) {
        return phrase.split(/\band\b/i).map((part) => parseEnglishNumberPhrase(part.trim()));
      }
      return [parseEnglishNumberPhrase(phrase)];
    })
    .filter((number) => number !== null)
    .map((number) => `NUM:${number}`);
}

function parseEnglishNumberPhrase(value) {
  const small = {
    zero: 0n, one: 1n, two: 2n, three: 3n, four: 4n, five: 5n,
    six: 6n, seven: 7n, eight: 8n, nine: 9n, ten: 10n, eleven: 11n,
    twelve: 12n, thirteen: 13n, fourteen: 14n, fifteen: 15n, sixteen: 16n,
    seventeen: 17n, eighteen: 18n, nineteen: 19n, twenty: 20n, thirty: 30n,
    forty: 40n, fifty: 50n, sixty: 60n, seventy: 70n, eighty: 80n, ninety: 90n,
    first: 1n, second: 2n, third: 3n, fourth: 4n, fifth: 5n, sixth: 6n,
    seventh: 7n, eighth: 8n, ninth: 9n, tenth: 10n, eleventh: 11n,
    twelfth: 12n, thirteenth: 13n, fourteenth: 14n, fifteenth: 15n,
    sixteenth: 16n, seventeenth: 17n, eighteenth: 18n, nineteenth: 19n,
    twentieth: 20n, thirtieth: 30n, fortieth: 40n, fiftieth: 50n,
    sixtieth: 60n, seventieth: 70n, eightieth: 80n, ninetieth: 90n,
    single: 1n, both: 2n, double: 2n, triple: 3n, dozen: 12n, dozens: 10n,
  };
  const scales = {
    hundred: 100n,
    hundreds: 100n,
    thousand: 1_000n,
    thousands: 1_000n,
    million: 1_000_000n,
    millions: 1_000_000n,
    billion: 1_000_000_000n,
    billions: 1_000_000_000n,
    trillion: 1_000_000_000_000n,
    trillions: 1_000_000_000_000n,
  };
  const words = String(value).toLowerCase().split(/[\s-]+/).filter((item) => item !== 'and');
  if (!words.length || !words.some((item) => Object.hasOwn(small, item) || Object.hasOwn(scales, item))) {
    return null;
  }
  let total = 0n;
  let current = 0n;
  for (const item of words) {
    if (Object.hasOwn(small, item)) {
      current += small[item];
      continue;
    }
    const scale = scales[item];
    if (!scale) return null;
    if (scale === 100n) {
      current = (current || 1n) * scale;
    } else {
      total += (current || 1n) * scale;
      current = 0n;
    }
  }
  return `${total + current}`;
}

function chineseWrittenNumbers(value) {
  let text = String(value || '');
  const tokens = [];
  text = text.replace(/百分之([负零〇一二两三四五六七八九十百千万亿兆点]+)/g, (match, amount) => {
    const parsed = parseChineseNumber(amount);
    if (parsed !== null) tokens.push(`PCT:${parsed}`);
    return ' '.repeat(match.length);
  });
  // The Han character in percentage terms is a morpheme, not an independent number 100.
  text = text.replace(/百分(?:比|点|率)/g, (match) => ' '.repeat(match.length));
  for (const match of text.matchAll(/[负零〇一二两三四五六七八九十百千万亿兆点]+/g)) {
    const raw = match[0];
    const before = text[match.index - 1] || '';
    const after = text[(match.index || 0) + raw.length] || '';
    const prefixText = text.slice(0, match.index).trimEnd();
    const prefix = prefixText.at(-1) || '';
    if (/[0-9.]$/.test(prefix) && /^[十百千万亿兆]/.test(raw)) continue;
    const boundaryAfter = !/\p{Script=Han}/u.test(after);
    const counterAfter = /[个项次名位份套种只家台条点倍成年月日时分秒周季届级章页组轮期步方侧端类笔股档架件者人]/.test(after);
    const ordinal = prefix === '第';
    const standalone = raw.length === 1
      && (ordinal || (/(?:为|等于|设为|共|约|近|达|至|到)$/.test(prefixText)
        && (boundaryAfter || counterAfter)))
      && !/[零〇一二两三四五六七八九]/.test(before)
      && !/[零〇一二两三四五六七八九]/.test(after);
    if (raw.length < 2 && !/[十百千万亿兆点]/.test(raw) && !standalone) continue;
    const parsed = parseChineseNumber(raw);
    if (parsed !== null) tokens.push(`NUM:${parsed}`);
  }
  return tokens;
}

function parseChineseNumber(value) {
  const digits = { 零: 0n, 〇: 0n, 一: 1n, 二: 2n, 两: 2n, 三: 3n, 四: 4n, 五: 5n, 六: 6n, 七: 7n, 八: 8n, 九: 9n };
  const raw = String(value);
  const negative = raw.startsWith('负');
  const unsigned = (negative ? raw.slice(1) : raw).replaceAll('万亿', '兆');
  if (!unsigned) return null;
  if (unsigned.includes('点')) {
    const [wholeRaw, fractionRaw, ...rest] = unsigned.split('点');
    if (rest.length || !fractionRaw || [...fractionRaw].some((char) => !Object.hasOwn(digits, char))) return null;
    const whole = parseChineseNumber(wholeRaw || '零');
    if (whole === null) return null;
    const decimal = `${whole}.${[...fractionRaw].map((char) => digits[char]).join('')}`;
    return negative ? `-${decimal}` : decimal;
  }
  if ([...unsigned].every((char) => Object.hasOwn(digits, char))) {
    const number = [...unsigned].map((char) => digits[char]).join('').replace(/^0+(?=\d)/, '');
    return `${negative ? '-' : ''}${number || '0'}`;
  }
  const units = { 十: 10n, 百: 100n, 千: 1_000n, 万: 10_000n, 亿: 100_000_000n, 兆: 1_000_000_000_000n };
  let total = 0n;
  let section = 0n;
  let number = 0n;
  for (const char of unsigned) {
    if (Object.hasOwn(digits, char)) {
      number = digits[char];
      continue;
    }
    const unit = units[char];
    if (!unit) return null;
    if (unit < 10_000n) {
      section += (number || 1n) * unit;
    } else {
      section += number;
      total += (section || 1n) * unit;
      section = 0n;
    }
    number = 0n;
  }
  const parsed = total + section + number;
  return `${negative ? -parsed : parsed}`;
}

function containsNumericLanguage(value) {
  return /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|single|double|triple|dozen|percent|percentage|percentages|per\s+cent|january|february|march|april|may|june|july|august|september|october|november|december)\b/i
    .test(String(value || ''));
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
  let referencesStarted = false;
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
      blocks.push({
        id: `b${String(++blockIndex).padStart(6, '0')}`,
        order: blocks.length,
        type: 'paragraph',
        text: region.text,
        fragments: region.fragments,
      });
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
      blocks.push({ id, order: blocks.length, type: 'figure', ...figure });
      continue;
    }
    if (node.matches('table')) {
      const table = tableFromNode(node, documentUrl);
      if (!table.rows.length) {
        blockIndex -= 1;
        continue;
      }
      blocks.push({ id, order: blocks.length, type: 'table', ...table });
      continue;
    }
    if (node.matches('pre')) {
      const code = String(node.textContent || '').replace(/^\n+|\n+$/g, '');
      if (!code) {
        blockIndex -= 1;
        continue;
      }
      blocks.push({ id, order: blocks.length, type: 'code', text: code });
      continue;
    }
    if (node.matches('.ltx_equationgroup,.ltx_equation,math[display="block"]')) {
      const tex = mathTex(node);
      if (!tex) {
        blockIndex -= 1;
        continue;
      }
      blocks.push({ id, order: blocks.length, type: 'equation', tex });
      continue;
    }
    if (node.matches('.ltx_bibitem')) {
      const rich = richTextFromNode(node, documentUrl);
      if (!rich.text) {
        blockIndex -= 1;
        continue;
      }
      blocks.push({ id, order: blocks.length, type: 'reference', text: rich.text, fragments: rich.fragments });
      continue;
    }

    const rich = richTextFromNode(node, documentUrl);
    const text = rich.text;
    if (!text) {
      blockIndex -= 1;
      continue;
    }
    if (/^H[1-6]$/.test(node.tagName) && isReferencesHeading(text)) {
      referencesStarted = true;
    }
    let type = referencesStarted ? 'reference' : 'paragraph';
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
    blocks.push({
      id,
      order: blocks.length,
      type,
      ...block,
      text,
      fragments: rich.fragments,
    });
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
  const protect = (value) => {
    const token = `⟦SL_INLINE_${String(fragments.length + 1).padStart(3, '0')}⟧`;
    fragments.push({ token, value });
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
    link.replaceWith(clone.ownerDocument.createTextNode(protect(value)));
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

async function localizeFigureAssets(blocks, {
  workDir,
  fetchFn,
  fetchWithRetry,
  config,
  dnsLookup,
  assetMap,
  signal,
}) {
  const figures = blocks.filter((block) => block.type === 'figure');
  const images = figures.flatMap((block) => block.images || []);
  const limits = limitsFor(config);
  if (images.length > limits.maxAssetCount) {
    throw new Error(`原文图片数量超过上限:${images.length}/${limits.maxAssetCount}`);
  }
  const assetDir = path.join(workDir, 'translation-assets');
  fs.mkdirSync(assetDir, { recursive: true });
  const cache = new Map();
  let totalBytes = 0;
  const browserSession = createRasterBrowserSession(config, signal);

  try {
    for (const [index, image] of images.entries()) {
      throwIfTaskCancelled(signal);
      const mapped = mappedAssetPath(image.src, assetMap);
      if (cache.has(image.src)) {
        image.localPath = cache.get(image.src);
        continue;
      }

      let buffer;
      let contentType = '';
      if (mapped) {
        const mappedSize = fs.statSync(mapped).size;
        if (mappedSize > limits.maxSingleAssetBytes) {
          throw new Error(`原文单张图片超过上限:${mappedSize}/${limits.maxSingleAssetBytes}`);
        }
        buffer = fs.readFileSync(mapped);
      } else if (/^data:image\//i.test(image.src)) {
        const decoded = decodeDataImage(image.src);
        buffer = decoded.buffer;
        contentType = decoded.contentType;
      } else {
        const fetched = await safeFetchResource({
          url: image.src,
          fetchFn,
          fetchWithRetry,
          limits,
          dnsLookup,
          headers: {},
          accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml;q=0.9,*/*;q=0.1',
          maxBytes: limits.maxSingleAssetBytes,
          signal,
        });
        buffer = fetched.buffer;
        contentType = fetched.contentType;
      }
      if (buffer.length > limits.maxSingleAssetBytes) {
        throw new Error(`原文单张图片超过上限:${buffer.length}/${limits.maxSingleAssetBytes}`);
      }
      const kind = detectImageKind(buffer, contentType);
      if (!kind) throw new Error(`原文图片格式不受支持:${image.src}`);
      const basename = `figure-${String(index + 1).padStart(3, '0')}`;
      let target;
      if (['.svg', '.webp'].includes(kind.extension)) {
        target = path.join(assetDir, `${basename}.png`);
        const rasterize = config.imageRasterizer || rasterizeImageToPng;
        await rasterize({
          buffer,
          contentType: kind.contentType,
          target,
          config,
          signal,
          browserSession,
        });
        throwIfTaskCancelled(signal);
        if (!fs.existsSync(target) || fs.statSync(target).size <= 0) {
          throw new Error(`原文图片转 PNG 失败:${image.src}`);
        }
        const rasterized = fs.readFileSync(target);
        if (detectImageKind(rasterized, '')?.extension !== '.png') {
          throw new Error(`原文图片转 PNG 结果格式无效:${image.src}`);
        }
      } else if (mapped) {
        target = mapped;
      } else {
        target = path.join(assetDir, `${basename}${kind.extension}`);
        fs.writeFileSync(target, buffer, { mode: 0o600 });
      }
      const finalSize = fs.statSync(target).size;
      if (finalSize > limits.maxSingleAssetBytes) {
        throw new Error(`原文图片处理后超过上限:${finalSize}/${limits.maxSingleAssetBytes}`);
      }
      totalBytes += finalSize;
      if (totalBytes > limits.maxAssetBytes) {
        throw new Error(`原文图片总量超过上限:${totalBytes}/${limits.maxAssetBytes}`);
      }
      image.localPath = target;
      cache.set(image.src, target);
    }
  } finally { await browserSession.close(); }
}

async function localizeTableAssets(blocks, {
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
      const target = path.join(assetDir, `table-${String(index + 1).padStart(3, '0')}.png`);
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
      const context = await browser.newContext(options);
      const started = performance.now();
      try {
        return await withDeadline({ signal, timeoutMs: positive(config.browserTimeoutMs, DEFAULT_LIMITS.browserTimeoutMs), message: '原文图片转换超时' }, async (operationSignal) => {
          const abortContext = () => { void context.close().catch(() => {}); };
          operationSignal.addEventListener('abort', abortContext, { once: true });
          try {
            await context.route('**/*', (route) => route.abort('blockedbyclient'));
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

function browserExecutable(config = {}) {
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

function tableHtmlFromRows(rows = []) {
  const body = rows.map((row, rowIndex) => {
    const tag = rowIndex === 0 ? 'th' : 'td';
    return `<tr>${row.map((cell) => `<${tag}>${escapeHtml(cell?.text || '')}</${tag}>`).join('')}</tr>`;
  }).join('');
  return `<table>${body}</table>`;
}

function mappedAssetPath(rawSrc, assetMap) {
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

function detectImageKind(buffer, contentType) {
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

function assertSourceDocumentComplete(document) {
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

function isReferencesHeading(text) {
  return /^(?:references|bibliography|works cited|参考文献|引用文献)\s*[:：]?$/i.test(cleanText(text));
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

function cleanMarkdownText(value) {
  return cleanText(String(value || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/<[^>]+>/g, ' '));
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

function restoreFragments(value, fragments = []) {
  let text = String(value || '');
  for (const fragment of fragments || []) text = text.replaceAll(fragment.token, fragment.value);
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
  let document;
  try { document = new JSDOM(raw).window.document; } catch {}
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

function parseJsonPayload(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/gi, '');
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return undefined;
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

function limitsFor(config) {
  return {
    maxSourceBytes: positive(config.maxSourceBytes, DEFAULT_LIMITS.maxSourceBytes),
    maxPdfPages: positive(config.maxPdfPages, DEFAULT_LIMITS.maxPdfPages),
    browserTimeoutMs: positive(config.browserTimeoutMs, DEFAULT_LIMITS.browserTimeoutMs),
    fetchTimeoutMs: positive(config.fetchTimeoutMs, DEFAULT_LIMITS.fetchTimeoutMs),
    maxRedirects: nonNegative(config.maxRedirects, DEFAULT_LIMITS.maxRedirects),
    maxAssetCount: positive(config.maxAssetCount, DEFAULT_LIMITS.maxAssetCount),
    maxAssetBytes: positive(config.maxAssetBytes, DEFAULT_LIMITS.maxAssetBytes),
    maxSingleAssetBytes: positive(config.maxSingleAssetBytes, DEFAULT_LIMITS.maxSingleAssetBytes),
  };
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegative(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
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

function safeError(error) {
  return String(error?.message || error || '未知错误').slice(0, 300);
}

async function report(onProgress, progress) {
  if (!onProgress) return;
  try { await onProgress(progress); }
  catch (error) { console.error(`[translate] 进度通知失败(已忽略): ${safeError(error)}`); }
}

function writeJsonAtomic(target, value) {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
    fs.renameSync(temporary, target);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}
