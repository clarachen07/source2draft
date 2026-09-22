import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { JSDOM } from 'jsdom';
import { protectMathInMarkdown, renderEquationPngs, restoreMathInHtml, validateMathRestored } from './wechat-math.js';
import { escapeHtml, hash, parseArticle, writeAtomic } from './io.js';
import { screenshotHtml } from './browser.js';
import { download } from '../core/sources.js';
import { secretValues } from '../config/index.js';

const ARTICLE_FONT = '-apple-system,BlinkMacSystemFont,Segoe UI,PingFang SC,Microsoft YaHei,Arial,sans-serif';
const TEXT_STYLE = `font-family:${ARTICLE_FONT};font-size:15px;text-align:left;`;
const STYLES = {
  p: `${TEXT_STYLE}margin:1em 0;line-height:1.8;`,
  h1: `${TEXT_STYLE}font-weight:600;line-height:1.5;margin:1.5em 0 .8em;`,
  h2: `${TEXT_STYLE}font-weight:600;line-height:1.5;margin:1.5em 0 .8em;`,
  h3: `${TEXT_STYLE}font-weight:600;line-height:1.5;margin:1.3em 0 .7em;`,
  h4: `${TEXT_STYLE}font-weight:600;line-height:1.5;margin:1em 0;`,
  blockquote: `${TEXT_STYLE}margin:1em 0;padding-left:12px;border-left:3px solid #d0d5dd;color:#667085;line-height:1.8;`,
  img: 'max-width:100%;height:auto;',
  table: `${TEXT_STYLE}border-collapse:collapse;width:100%;word-break:break-word;`,
  th: `${TEXT_STYLE}border:1px solid #d0d5dd;padding:6px;`,
  td: `${TEXT_STYLE}border:1px solid #d0d5dd;padding:6px;`,
  pre: `${TEXT_STYLE}white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f5;padding:12px;line-height:1.8;`,
  code: `${TEXT_STYLE}`, a: 'color:#344054;text-decoration:underline;',
  ol: `${TEXT_STYLE}margin:.75em 0;padding-left:1.5em;list-style-position:outside;`,
  ul: `${TEXT_STYLE}margin:.75em 0;padding-left:1.5em;list-style-position:outside;`,
  li: `${TEXT_STYLE}margin:.5em 0;padding-left:.25em;line-height:1.8;`,
};
const ALLOWED = new Set('section div p h1 h2 h3 h4 h5 h6 strong b em i s del u a img ul ol li blockquote pre code table thead tbody tr th td hr br sup sub span'.split(' '));
export function validatePreparedWechatHtml(html) {
  const doc = new JSDOM(html).window.document;
  const errors = [];
  if (doc.querySelector('script,iframe,object,embed,form,input,style,link,video,audio')) errors.push('存在危险或不支持的 HTML');
  for (const el of doc.querySelectorAll('*')) for (const attr of el.attributes) {
    if (/^on/i.test(attr.name) || /javascript:|file:|vbscript:/i.test(attr.value)) errors.push('存在危险属性');
  }
  if (!doc.body.textContent.trim()) errors.push('正文为空');
  if (/SLMATH\d+XSLMATH/.test(doc.body.textContent)) errors.push('公式占位符未恢复');
  return { errors, warnings: [] };
}
export function assertSafeArticle(markdown, config) {
  for (const secret of secretValues(config)) if (secret.length >= 8 && markdown.includes(secret)) throw new Error('成稿含有运行凭据，禁止上传');
  if (/xox[baprs]-[\w-]{12,}|xapp-[\w-]{12,}|sk-[\w-]{16,}/.test(markdown)) throw new Error('成稿含疑似凭据，禁止上传');
}
export function imageType(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(buffer.subarray(0, 6).toString())) return 'image/gif';
  throw new Error('图片必须为有效的 PNG、JPEG 或 GIF');
}
export function safeLocalAsset(src, workDir) {
  const full = fs.realpathSync(path.resolve(workDir, src));
  if (!full.startsWith(fs.realpathSync(workDir) + path.sep)) throw new Error('图片不能读取任务目录以外的文件');
  return full;
}
function referencesHeading(element) {
  return /^(?:references|bibliography|works cited|参考来源|参考文献|引用文献)\s*[:：]?$/i.test(element.textContent.trim());
}
function renderReferenceParagraphs(list) {
  const document = list.ownerDocument;
  const paragraphs = document.createDocumentFragment();
  for (const [index, item] of [...list.children].entries()) {
    if (item.tagName !== 'LI') continue;
    const paragraph = document.createElement('p');
    paragraph.setAttribute('style', `${STYLES.p}margin:.35em 0;`);
    paragraph.append(`${index + 1}. `);
    for (const child of [...item.childNodes]) {
      if (child.nodeType === 1 && child.tagName === 'P') {
        while (child.firstChild) paragraph.appendChild(child.firstChild);
      } else paragraph.appendChild(child);
    }
    paragraphs.appendChild(paragraph);
  }
  list.replaceWith(paragraphs);
}
// Apply typography only after the Markdown DOM exists. This makes research and
// faithful-translation output share one presentation contract. Fixed numbers in
// ordinary paragraphs survive WeChat's editor and remain stable after editing.
export function applyWechatArticleStyles(body) {
  for (const el of [...body.querySelectorAll('*')]) {
    const originalStyle = el.hasAttribute('data-sl-math') ? el.getAttribute('style') : '';
    if (originalStyle && /url\s*\(|expression|@import|javascript|\\/i.test(originalStyle)) throw new Error('公式样式含不安全内容');
    el.setAttribute('style', originalStyle || STYLES[el.tagName.toLowerCase()] || '');
    if (el.hasAttribute('href') && !/^https?:\/\//i.test(el.getAttribute('href'))) el.removeAttribute('href');
  }
  for (const paragraph of body.querySelectorAll('li > p')) paragraph.setAttribute('style', `${STYLES.p}margin:0;`);
  for (const heading of body.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    if (!referencesHeading(heading)) continue;
    const list = heading.nextElementSibling;
    if (!list || !['OL', 'UL'].includes(list.tagName)) continue;
    renderReferenceParagraphs(list);
  }
}
export async function prepareArticle({ markdown, workDir, config, signal, cover, onTelemetry }) {
  signal?.throwIfAborted();
  assertSafeArticle(markdown, config);
  const { title, body } = parseArticle(markdown);
  const protectedMath = protectMathInMarkdown(body);
  if (protectedMath.equations.length) await renderEquationPngs(protectedMath.equations, {
    outDir: workDir, executablePath: config.browser, signal, onTelemetry,
  });
  let html = marked.parse(protectedMath.markdown, { gfm: true });
  html = restoreMathInHtml(html, protectedMath);
  const mathErrors = validateMathRestored(html, protectedMath);
  if (mathErrors?.errors?.length) throw new Error(mathErrors.errors.join('；'));
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  for (const el of [...doc.body.querySelectorAll('*')]) {
    if (!ALLOWED.has(el.tagName.toLowerCase())) throw new Error(`不支持的 HTML 元素 ${el.tagName}`);
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) throw new Error('正文含事件处理属性');
      if (!['href', 'src', 'alt', 'style', 'colspan', 'rowspan'].includes(attr.name) && !attr.name.startsWith('data-sl-math')) el.removeAttribute(attr.name);
    }
  }
  applyWechatArticleStyles(doc.body);
  const assets = [];
  let assetBytes = 0;
  for (const img of doc.querySelectorAll('img')) {
    signal?.throwIfAborted();
    let src = img.getAttribute('src');
    if (!src) throw new Error('正文图片缺少地址');
    if (/^https?:\/\//i.test(src)) {
      const fetched = await download(src, { signal, limits: { maxSourceBytes: 10 * 1024 * 1024, maxRedirects: 5, fetchTimeoutMs: 45000 } });
      const mime = imageType(fetched.buffer);
      src = path.join(workDir, `image-${hash(fetched.buffer).slice(0, 16)}.${mime.split('/')[1]}`);
      fs.writeFileSync(src, fetched.buffer, { mode: 0o600 });
    }
    const local = safeLocalAsset(src, workDir);
    imageType(fs.readFileSync(local));
    if (fs.statSync(local).size > 10 * 1024 * 1024) throw new Error('正文单张图片超过 10 MB');
    if (!assets.includes(local)) assets.push(local);
    assetBytes += fs.statSync(local).size;
    if (assets.length > 80 || assetBytes > 40 * 1024 * 1024) throw new Error('正文图片总量超过单篇上限');
    img.setAttribute('src', path.relative(workDir, local));
  }
  if (/\/(?:Users|home|private|var|srv)\/|[A-Z]:\\Users\\/.test(doc.body.textContent)) throw new Error('正文泄漏本机路径，禁止上传');
  html = `<section style="font-family:${ARTICLE_FONT};font-size:15px;line-height:1.8;color:#222;text-align:left;overflow-wrap:break-word;">${doc.body.innerHTML}</section>`;
  const check = validatePreparedWechatHtml(html);
  if (check.errors.length) throw new Error(check.errors.join('；'));
  const coverPath = path.join(workDir, 'cover.png');
  if (cover) {
    let buffer;
    if (cover.url) buffer = (await download(cover.url, { signal, headers: cover.headers || {}, limits: { maxSourceBytes: 10 * 1024 * 1024, maxRedirects: 5, fetchTimeoutMs: 45000 } })).buffer;
    else buffer = fs.readFileSync(safeLocalAsset(cover.path, workDir));
    const mime = imageType(buffer);
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    await screenshotHtml(`<html><body style="margin:0"><img src="${dataUrl}" style="width:900px;height:383px;object-fit:cover"></body></html>`, coverPath, config, { signal, onTelemetry });
  } else {
    await screenshotHtml(`<html lang="zh"><meta charset="utf-8"><body style="margin:0;background:#fff;color:#252525;display:flex;align-items:center;height:383px"><div style="padding:48px 64px;font:600 48px/1.4 -apple-system,sans-serif;word-break:break-word">${escapeHtml(title)}</div></body></html>`, coverPath, config, { signal, onTelemetry });
  }
  signal?.throwIfAborted();
  writeAtomic(path.join(workDir, 'article.html'), html);
  writeAtomic(path.join(workDir, 'preview.html'), `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="max-width:680px;margin:36px auto;padding:0 20px;font-family:-apple-system,sans-serif"><h1>${escapeHtml(title)}</h1>${html}</body></html>`);
  const prepared = { title, html, assets, coverPath };
  writeAtomic(path.join(workDir, 'prepared.json'), prepared);
  return prepared;
}
