import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { hash, writeAtomic } from '../lib/io.js';
import { sourceDownloadUrl } from '../lib/secure-http.js';
import { imageType } from '../lib/wechat-render.js';
import { canonicalUrl, parsedDate, temporalStatus } from './candidates.js';
import { crossrefMetadata, providerSettings } from './providers.js';

const execute = promisify(execFile);
export const MAX_DOCUMENT_CHARACTERS = 160000;
const normalized = value => String(value || '').replace(/\s+/g, ' ').trim();
function ineligible(reason) { const error = new Error(reason); error.code = 'DAILY_CANDIDATE_INELIGIBLE'; return error; }

export function permittedFigureLicense(raw) {
  try {
    const url = new URL(raw);
    if (url.hostname !== 'creativecommons.org' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.search) return false;
    return /^\/(?:licenses\/by\/(?:1\.0|2\.0|2\.5|3\.0|4\.0)|publicdomain\/zero\/1\.0)\/?$/.test(url.pathname);
  } catch { return false; }
}

function createLocators(parts) {
  return parts.filter(part => normalized(part.text)).map((part, index) => ({ ...part, id: `L${index + 1}`, text: part.text.trim() }));
}

function mathPresentationText(node) {
  if (node.nodeType === 3) return node.textContent;
  if (['annotation', 'annotation-xml'].includes(node.localName)) return '';
  const child = index => normalized(mathPresentationText(node.children[index] || { childNodes: [] }));
  const atom = value => /^[\p{L}\p{N}]+(?:\.\d+)?$/u.test(value) ? value : `(${value})`;
  if (node.localName === 'msup') return `${atom(child(0))}^${atom(child(1))}`;
  if (node.localName === 'msub') return `${atom(child(0))}_${atom(child(1))}`;
  if (node.localName === 'msubsup') return `${atom(child(0))}_${atom(child(1))}^${atom(child(2))}`;
  if (node.localName === 'mfrac') return `(${child(0)})/(${child(1)})`;
  if (node.localName === 'msqrt') return `√(${[...node.childNodes].map(mathPresentationText).join('')})`;
  if (node.localName === 'mroot') return `root(${child(0)},${child(1)})`;
  return [...node.childNodes].map(mathPresentationText).join('');
}

function jsonObjects(value, result = []) {
  if (Array.isArray(value)) for (const item of value) jsonObjects(item, result);
  else if (value && typeof value === 'object') { result.push(value); if (value['@graph']) jsonObjects(value['@graph'], result); }
  return result;
}

export function parseHtmlDocument(html, url) {
  const dom = new JSDOM(html, { url });
  let articleDom;
  try {
    const doc = dom.window.document;
    const metadata = {};
    for (const meta of doc.querySelectorAll('meta[content]')) {
      const key = (meta.getAttribute('property') || meta.getAttribute('name') || '').toLowerCase();
      if (key) metadata[key] ||= meta.getAttribute('content');
    }
    const records = [...doc.querySelectorAll('script[type="application/ld+json"]')].flatMap(script => {
      if (script.textContent.length > 200000) return [];
      try { return jsonObjects(JSON.parse(script.textContent)); } catch { return []; }
    });
    const record = records.find(item => {
      if (!/Article|NewsArticle|BlogPosting|ScholarlyArticle/.test([item['@type']].flat().join(' '))) return false;
      const identity = typeof item.mainEntityOfPage === 'string' ? item.mainEntityOfPage : item.mainEntityOfPage?.['@id'] || item.url || item['@id'];
      if (!identity) return true;
      try { return canonicalUrl(identity) === canonicalUrl(url); } catch { return false; }
    });
    const published = parsedDate(metadata['article:published_time'] || metadata['citation_publication_date']
      || metadata['dc.date.issued'] || record?.datePublished || doc.querySelector('article time[itemprop="datePublished"][datetime],article header .published time[datetime],article header .dateline time[datetime]')?.getAttribute('datetime'));
    const updated = parsedDate(metadata['article:modified_time'] || record?.dateModified);
    const article = new Readability(doc.cloneNode(true)).parse();
    if (!article?.textContent?.trim() || article.textContent.trim().length < 120) throw new Error('网页未返回可读原文');
    if (article.textContent.length > MAX_DOCUMENT_CHARACTERS) throw new Error('原文超过单篇深读上限，未截断充当完整证据');
    articleDom = new JSDOM(article.content, { url });
    const content = articleDom.window.document;
    // MathML annotations are alternate encodings of the visible equation. Keep
    // their explicit TeX separately, then remove them from paragraph text so a
    // displayed 0.55 does not become the nonexistent number 0.550.55.
    const formulas = [...content.querySelectorAll('math[alttext], [data-tex], annotation[encoding="application/x-tex"]')]
      .map(math => (math.getAttribute('alttext') || math.getAttribute('data-tex') || math.textContent)?.trim())
      .filter(Boolean);
    for (const annotation of content.querySelectorAll('math annotation, math annotation-xml')) annotation.remove();
    // textContent flattens exponent/index position: 10^4 becomes 104. Read the
    // presentation tree before replacing math with an unambiguous textual form;
    // explicit TeX remains in its own source locator, without duplicate encoding.
    for (const math of content.querySelectorAll('math')) {
      math.replaceWith(content.createTextNode(mathPresentationText(math).trim() || math.getAttribute('alttext') || ''));
    }
    const visibleText = content.body.textContent.trim();
    let heading = article.title || '';
    const parts = [];
    for (const element of content.querySelectorAll('h1,h2,h3,h4,p,li,table,pre,figcaption')) {
      if (/^H\d$/.test(element.tagName)) { heading = normalized(element.textContent); continue; }
      if (element.parentElement?.closest('table,pre,li') || (element.tagName === 'P' && element.closest('li'))) continue;
      const text = element.tagName === 'TABLE' ? [...element.querySelectorAll('tr')].map(row => [...row.querySelectorAll('th,td')].map(cell => normalized(cell.textContent)).join(' | ')).join('\n')
        : element.textContent;
      parts.push({ type: element.tagName === 'TABLE' ? 'table' : element.tagName === 'FIGCAPTION' ? 'caption' : 'paragraph',
        heading, selector: element.id ? `#${element.id}` : null, text });
    }
    if (!parts.length) parts.push({ type: 'paragraph', heading, text: visibleText });
    // TeX is explicit source text, not OCR or a model's guessed reconstruction.
    for (const tex of new Set(formulas)) parts.push({ type: 'formula', heading, text: tex, tex });
    const licenseLink = doc.querySelector('a[rel~="license"][href]')?.getAttribute('href');
    const license = licenseLink ? new URL(licenseLink, url).href : null;
    const figures = [...content.querySelectorAll('figure')].flatMap((figure, index) => {
      const caption = normalized(figure.querySelector('figcaption')?.textContent);
      // Third-party/permission exceptions take precedence over a paper license.
      if (!caption || /third.party|courtesy|reproduced|used with permission|all rights reserved|copyright|©|转载|经许可/i.test(caption)) return [];
      const image = figure.querySelector('img[src]');
      if (!image) return [];
      const imageUrl = new URL(image.getAttribute('src'), url).href;
      if (!/^https?:/.test(imageUrl)) return [];
      return [{ id: `figure-${index + 1}`, url: imageUrl, caption, alt: image.getAttribute('alt') || caption }];
    });
    return { title: article.title, url, text: visibleText, locators: createLocators(parts),
      publishedAt: published?.value || null, updatedAt: updated?.value || null, datePrecision: published?.precision || null,
      licenseUrl: license, licenseVerified: Boolean(license), figures, metadata };
  } finally { articleDom?.window.close(); dom.window.close(); }
}

export async function parseLocalPdf({ buffer, url, workDir, signal, executeFn = execute }) {
  if (buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('论文下载不是有效 PDF');
  const file = path.join(workDir, `paper-${hash(buffer).slice(0, 16)}.pdf`);
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, buffer, { mode: 0o600 });
  let info, output;
  try {
    info = await executeFn('pdfinfo', [file], { signal, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    const pages = Number(/^Pages:\s*(\d+)/m.exec(info.stdout)?.[1]);
    if (!(pages > 0 && pages <= 100)) throw new Error('论文页数不在免费本地深读范围内（最多100页）');
    if (/^Encrypted:\s*yes/m.test(info.stdout)) throw new Error('论文 PDF 已加密');
    output = await executeFn('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], { signal, timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'ENOENT') throw new Error('本机缺少免费 PDF 正文工具（pdfinfo / pdftotext）');
    throw new Error('免费本地 PDF 正文解析失败；未调用付费解析服务');
  }
  const text = output.stdout.trim();
  if (text.length < 1200 || text.length > MAX_DOCUMENT_CHARACTERS || /\u0000/.test(text)) throw ineligible('PDF 没有足够可读正文或超过深读上限；未用摘要代替');
  const pages = output.stdout.split('\f');
  if (!pages.at(-1)?.trim()) pages.pop();
  if (pages.length !== Number(/^Pages:\s*(\d+)/m.exec(info.stdout)?.[1])) throw new Error('PDF 文本页数与原文件页数不符，未作为完整正文');
  const bodyMarkers = [...text.matchAll(/\b(?:Introduction|Method(?:s|ology)?|Results|Experiments?|Conclusion|References|Background)\b|引言|方法|实验|结果|参考文献/gi)];
  if (bodyMarkers.length < 2) throw ineligible('PDF 缺少可确认的论文正文，未以摘要代替');
  const parts = pages.flatMap((page, index) => page.split(/\n\s*\n/).filter(value => value.trim()).map(value => ({ type: 'paragraph', page: index + 1, text: value.trim() })));
  return { title: /^Title:\s*(.+)$/m.exec(info.stdout)?.[1]?.trim() || '', url, text, locators: createLocators(parts),
    pages: pages.length, localPdf: file, figures: [],
    pageCoverage: { expected: pages.length, extracted: pages.length, textlessPages: pages.flatMap((page, index) => page.trim() ? [] : [index + 1]) },
    // PDF creation/modification times are not publication dates.
    publishedAt: null, updatedAt: null, datePrecision: null, extraction: 'local-pdftotext' };
}

function sourceTextDocument(candidate) {
  const text = candidate.sourceText.trim();
  if (!text || text.length < 80) throw new Error('官方发布说明正文不足以深读');
  if (text.length > MAX_DOCUMENT_CHARACTERS) throw new Error('官方发布说明超过深读上限');
  return { title: candidate.title, url: candidate.url, text,
    locators: createLocators(text.split(/\n\s*\n/).map(text => ({ type: 'release-note', text }))),
    publishedAt: candidate.publishedAt, updatedAt: candidate.updatedAt, figures: [], extraction: 'official-github-api' };
}

export async function readResearchDocument({ candidate, client, config, context, workDir, signal }) {
  let document, fetched;
  if (candidate.sourceTextVerified) document = sourceTextDocument(candidate);
  else {
    const primaryUrl = candidate.arxiv ? `https://arxiv.org/html/${candidate.arxiv.id}` : sourceDownloadUrl(candidate.url);
    try {
      fetched = await client.request({ provider: 'source', url: primaryUrl, sourceId: `document:${candidate.sourceId}`, maxBytes: 25 * 1024 * 1024, cacheMs: 6 * 3600000,
        headers: candidate.requestHeaders || {} });
      if (fetched.buffer.subarray(0, 5).toString() === '%PDF-') document = await parseLocalPdf({ buffer: fetched.buffer, url: candidate.url, workDir, signal });
      else if (/html/.test(fetched.contentType) || /<html|<!doctype/i.test(fetched.buffer.toString('utf8', 0, 300))) {
        document = parseHtmlDocument(fetched.buffer.toString('utf8'), fetched.finalUrl);
        if (candidate.kind === 'paper') {
          const headings = [...new Set(document.locators.map(locator => locator.heading).filter(Boolean))].join(' ');
          const bodyMarkers = headings.match(/Introduction|Method(?:s|ology)?|Results|Experiments?|Conclusion|References|Background|引言|方法|实验|结果|参考文献/gi) || [];
          if (document.text.length < 1500 || bodyMarkers.length < 2) throw ineligible('论文页面只有摘要或缺少明确正文，需读取公开 PDF');
        }
      }
      else {
        const text = fetched.buffer.toString('utf8').trim();
        if (text.length < 120 || text.length > MAX_DOCUMENT_CHARACTERS) throw new Error('公开文本正文不完整或过长');
        document = { title: candidate.title, url: candidate.url, text,
          locators: createLocators(text.split(/\n\s*\n/).map(text => ({ type: 'paragraph', text }))), figures: [] };
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (/私网|保留地址|内部地址|本机|安全公网|用户名或密码|只允许|格式无效/.test(error.message)) throw error;
      if (error.code === 'DAILY_CANDIDATE_INELIGIBLE' && (!candidate.pdfUrl || fetched?.buffer.subarray(0, 5).toString() === '%PDF-')) throw error;
      if (candidate.pdfUrl) {
        fetched = await client.request({ provider: 'source', url: sourceDownloadUrl(candidate.pdfUrl), sourceId: `pdf:${candidate.sourceId}`,
          maxBytes: 25 * 1024 * 1024, cacheMs: 24 * 3600000 });
        document = await parseLocalPdf({ buffer: fetched.buffer, url: candidate.url, workDir, signal });
      } else {
        if (candidate.requestHeaders && Object.keys(candidate.requestHeaders).length) throw new Error('私有供给材料不发送到外部备用提取服务');
        const alternative = await client.firecrawl(candidate.url);
        const text = alternative.markdown;
        if (text.length > MAX_DOCUMENT_CHARACTERS) throw new Error('备用原文超过深读上限，未截断');
        document = { title: alternative.metadata.title || candidate.title, url: candidate.url, text,
          locators: createLocators(text.split(/\n\s*\n/).map(text => ({ type: 'paragraph', text }))), figures: [],
          publishedAt: parsedDate(alternative.metadata.publishedTime || alternative.metadata['article:published_time'])?.value || null,
          updatedAt: parsedDate(alternative.metadata.modifiedTime)?.value || null, extraction: 'firecrawl', receipt: alternative.receipt };
      }
    }
  }
  if (candidate.doi) {
    try {
      document.crossref = await crossrefMetadata(candidate.doi, client);
      if (document.crossref?.corrections?.some(update => /retract|withdraw/i.test(update.type))) throw new Error('论文 DOI 记录存在撤回或撤稿标记');
    } catch (error) {
      signal?.throwIfAborted();
      if (/撤回|撤稿/.test(error.message)) throw error;
      document.metadataWarnings = ['Crossref 补充元数据本次不可用'];
    }
  }
  // A source's own article date wins over search hints. Preserve the explicitly
  // announced updated-version event for arXiv revisions.
  const publishedAt = document.publishedAt || candidate.publishedAt || document.crossref?.publicationDate || null;
  const verifiedCandidate = { ...candidate, publishedAt,
    updatedAt: document.updatedAt || candidate.updatedAt,
    eventAt: candidate.eventType === 'paper-revision' ? candidate.eventAt : publishedAt,
    dateVerified: Boolean(document.publishedAt || candidate.dateVerified || document.crossref?.publicationDate),
    datePrecision: parsedDate(publishedAt)?.precision || null };
  const status = candidate.supplied ? 'supplied' : temporalStatus(verifiedCandidate, context);
  if (!candidate.supplied && !['current', 'supplement'].includes(status)) throw ineligible(`原文日期未通过本期窗口核验（${status}）`);
  const licenseUrl = candidate.licenseVerified ? candidate.licenseUrl : document.licenseUrl;
  return { ...document, title: document.title || candidate.title, candidate: verifiedCandidate, temporalStatus: status,
    licenseUrl, licenseVerified: Boolean(candidate.licenseVerified || document.licenseVerified),
    receipt: document.receipt || (fetched ? { ...fetched, buffer: undefined } : candidate.receipt),
    contentHash: hash(document.text), fetchedAt: new Date().toISOString() };
}

export async function acquirePermittedFigures({ document, client, workDir, maximum = 1, signal }) {
  if (!document.licenseVerified || !permittedFigureLicense(document.licenseUrl)) return [];
  const results = [];
  for (const figure of (document.figures || []).slice(0, maximum)) {
    signal?.throwIfAborted();
    try {
      const fetched = await client.request({ provider: 'source', url: figure.url, sourceId: 'licensed-figure', maxBytes: 5 * 1024 * 1024, cacheMs: 24 * 3600000 });
      const mime = imageType(fetched.buffer);
      const relativePath = `research/assets/${hash(fetched.buffer).slice(0, 16)}.${mime.split('/')[1]}`;
      const file = path.join(workDir, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, fetched.buffer, { mode: 0o600 });
      results.push({ ...figure, localPath: relativePath, sourceUrl: document.candidate.url,
        licenseUrl: document.licenseUrl, authors: document.candidate.authors || [], modified: false,
        receipt: { ...fetched, buffer: undefined } });
    } catch (error) { signal?.throwIfAborted(); /* An optional image never replaces text evidence. */ }
  }
  return results;
}

export async function githubReadme(candidate, client, config) {
  const parts = new URL(candidate.url).pathname.split('/').filter(Boolean);
  const repository = parts.slice(0, 2).join('/');
  if (!repository || parts.length !== 2) throw new Error('供给的 GitHub 材料须为公开仓库首页');
  const settings = providerSettings(config, 'github');
  const { data: repositoryData } = await client.json({ provider: 'github', url: `https://api.github.com/repos/${repository}`,
    auth: Boolean(settings.apiKey), headers: { ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) } });
  if (repositoryData.private !== false) throw new Error('仅支持公开 GitHub 仓库');
  const { data, receipt } = await client.json({ provider: 'github', url: `https://api.github.com/repos/${repository}/readme`,
    auth: Boolean(settings.apiKey), headers: { ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) } });
  if (data.encoding !== 'base64' || !data.content) throw new Error('公开仓库 README 不可读');
  return { ...candidate, sourceText: Buffer.from(data.content, 'base64').toString('utf8'), sourceTextVerified: true, receipt };
}
