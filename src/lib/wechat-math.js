import { assertProjectPath } from './project-path.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { chromium } from 'playwright-core';
import { withRuntimeResource } from '../config/runtime.js';
import { resolveBrowserExecutable } from './browser.js';
import { fileRecord } from './artifact-cache.js';
import { hash, readJson, writeAtomic } from './io.js';
import { emitTelemetry } from './telemetry.js';
import { cancellationErrorFromSignal, throwIfTaskCancelled } from './task-cancellation.js';

// WeChat draft formulas must be rasterized images. The upstream wenyan-core pipeline
// runs MathJax over HTML that marked has already mangled (underscores in TeX become
// <em>), which fragments formulas, leaks raw LaTeX into body copy, and renders CJK
// fallback text that overlaps under WeChat's reader font scaling. This module
// protects math before markdown parsing (placeholders that survive marked intact),
// renders each formula to a high-density transparent PNG via MathJax + Chromium
// used for tables and heading cards, and restores validated <img> nodes afterwards.

export const MATH_TOKEN_RE = /SLMATH\d{4}XSLMATH/g;
const MATH_TOKEN_ONE = /SLMATH\d{4}XSLMATH/;
const MATH_TOKEN_PREFIX = 'SLMATH';
const MATH_TOKEN_SUFFIX = 'XSLMATH';

export const MATH_INK_COLOR = '#2B3645';
// The reader displays images at device pixels on high-density screens. Capture
// at 3x, then declare both logical dimensions on each image. WeChat's reader
// can override a height-only image with height:auto; a width declaration keeps
// the high-density bitmap at its intended reading size.
export const MATH_CAPTURE_SCALE = 3;
const MATH_BASE_FONT_PX = 16;
const MATH_CAPTURE_PADDING = { x: 3, y: 2 };
const MAX_INLINE_TEX_LENGTH = 1000;
const MAX_DISPLAY_TEX_LENGTH = 4000;
// Long aligned derivations legitimately exceed the 40em plausibility gate, so their
// declared width is capped at MATH_DISPLAY_FIT_EM
// instead of failing the render. Past twice the cap the shrunken type would be
// unreadable, so such TeX must be split by a human rather than shrunk silently.
const MATH_DISPLAY_FIT_EM = 38;
const MATH_DISPLAY_MIN_SCALE = 0.5;

const TEX_FEATURE_RE = /\\[a-zA-Z]+|[_^]\s*[{A-Za-z0-9]|\{/;
// Single variables ($t$, $N$, $W$, $x_i$) carry no TeX feature characters but are
// ubiquitous in math-heavy papers; a lone letter between delimiters is virtually
// never prose or currency, so extract it too.
const TEX_SINGLE_VARIABLE_RE = /^[A-Za-z](?:_[A-Za-z0-9])?$/;
const TEX_COMMAND_RE = /\\[a-zA-Z]{2,}/;
const CJK_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const INLINE_CODE_RE = /`[^`\n]*`/g;

function mathToken(index) {
  return `${MATH_TOKEN_PREFIX}${String(index).padStart(4, '0')}${MATH_TOKEN_SUFFIX}`;
}

function isTeXLike(content) {
  return TEX_FEATURE_RE.test(content) || TEX_SINGLE_VARIABLE_RE.test(content);
}

function hasCJK(content) {
  return CJK_RE.test(content);
}

function maskInlineCode(line) {
  const holes = [];
  const masked = line.replace(INLINE_CODE_RE, (span) => {
    holes.push(span);
    return `\u0000${holes.length - 1}\u0000`;
  });
  return { masked, holes };
}

function unmaskInlineCode(text, holes) {
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => holes[Number(index)] ?? '');
}

function fenceState(line) {
  return /^\s{0,3}(?:```|~~~)/.test(line);
}

function extractFromSegment(segment, equations) {
  // Display math may span lines; extract it first so a later inline pass
  // cannot pair its dollar signs.
  let working = segment.replace(/\$\$([\s\S]+?)\$\$/g, (match, tex) => {
    const trimmed = String(tex).trim();
    if (!trimmed || trimmed.length > MAX_DISPLAY_TEX_LENGTH || !isTeXLike(trimmed)) return match;
    const token = mathToken(equations.length + 1);
    equations.push({ token, tex: trimmed, display: true, hasCjk: CJK_RE.test(trimmed) });
    return `\n\n${token}\n\n`;
  });
  working = working.replace(/\\\[([\s\S]+?)\\\]/g, (match, tex) => {
    const trimmed = String(tex).trim();
    if (!trimmed || trimmed.length > MAX_DISPLAY_TEX_LENGTH) return match;
    const token = mathToken(equations.length + 1);
    equations.push({ token, tex: trimmed, display: true, hasCjk: CJK_RE.test(trimmed) });
    return `\n\n${token}\n\n`;
  });

  // Inline math stays within a single line so a stray dollar can never swallow
  // the next paragraph. Inline code spans are masked before scanning. Remaining
  // dollars and \(\) pairs (currency amounts, prose parens) are neutralized so
  // wenyan's own MathJax pass can never pair them into garbled formulas.
  const lines = working.split('\n').map((line) => {
    const { masked, holes } = maskInlineCode(line);
    const scanned = neutralizeStrayDelimiters(scanInlineMath(masked, equations));
    return unmaskInlineCode(scanned, holes);
  });
  return lines.join('\n');
}

// $...$ and \(...\) inline delimiters share single-line safety; scan the masked
// line for both openers so either syntax is protected.
function scanInlineMath(masked, equations) {
  let scanned = '';
  let cursor = 0;
  while (cursor < masked.length) {
    const dollar = masked.indexOf('$', cursor);
    const paren = masked.indexOf('\\(', cursor);
    const useParen = paren >= 0 && (dollar < 0 || paren < dollar);
    const opener = useParen ? paren : dollar;
    if (opener < 0) {
      scanned += masked.slice(cursor);
      break;
    }
    if (masked[opener - 1] === '\\') {
      scanned += masked.slice(cursor, opener + 1);
      cursor = opener + 1;
      continue;
    }
    let contentStart;
    let nextCursor;
    let closeIndex;
    if (useParen) {
      contentStart = opener + 2; // skip both characters of the \( opener
      closeIndex = masked.indexOf('\\)', contentStart);
      nextCursor = closeIndex < 0 ? -1 : closeIndex + 2;
    } else {
      contentStart = opener + 1;
      closeIndex = masked.indexOf('$', contentStart);
      nextCursor = closeIndex < 0 ? -1 : closeIndex + 1;
    }
    if (closeIndex < 0) {
      scanned += masked.slice(cursor);
      break;
    }
    const content = masked.slice(contentStart, closeIndex);
    const token = content.trim() && content.length <= MAX_INLINE_TEX_LENGTH && isTeXLike(content)
      ? mathToken(equations.length + 1)
      : undefined;
    if (token) {
      equations.push({ token, tex: content.trim(), display: false, hasCjk: CJK_RE.test(content) });
      scanned += masked.slice(cursor, opener) + token;
      cursor = nextCursor;
    } else {
      scanned += masked.slice(cursor, nextCursor);
      cursor = nextCursor;
    }
  }
  return scanned;
}

// MathJax only pairs delimiters within one text node, so each stray body-text
// dollar wrapped in its own span can never join another dollar into a formula.
// Visible output is unchanged. Stray \( \) pairs degrade to plain parentheses.
function neutralizeStrayDelimiters(masked) {
  const span = '<span data-sl-math-currency="true">$</span>';
  return masked
    .replace(/\\\(|\\\)/g, '(')
    .replace(/\\\$/g, span)
    .replace(/\$/g, span);
}

// Extract $...$, $$...$$, \(...\), \[...\] formulas into placeholder tokens that
// survive the markdown renderer untouched. Code fences, inline code spans, and
// frontmatter are never touched; currency-like "$5 ... $10" pairs without TeX
// features keep their visible dollars, neutralized against MathJax pairing, so
// protection never garbles finance copy.
export function protectMathInMarkdown(markdown) {
  const source = String(markdown ?? '');
  const equations = [];
  const lines = source.split('\n');
  const output = [];
  let index = 0;

  // Skip YAML frontmatter; titles and metadata must not trigger math pairing.
  if (lines[0]?.trim() === '---') {
    output.push(lines[0]);
    index = 1;
    while (index < lines.length && lines[index].trim() !== '---') {
      output.push(lines[index]);
      index += 1;
    }
    if (index < lines.length) {
      output.push(lines[index]);
      index += 1;
    }
  }

  let inFence = false;
  const flushSegment = () => {
    if (!segment.length) return;
    output.push(extractFromSegment(segment.join('\n'), equations));
    segment = [];
  };
  let segment = [];
  while (index < lines.length) {
    const line = lines[index];
    if (fenceState(line)) {
      flushSegment();
      inFence = !inFence;
      output.push(line);
      index += 1;
      continue;
    }
    if (inFence) {
      output.push(line);
    } else {
      segment.push(line);
    }
    index += 1;
  }
  flushSegment();

  const protectedMarkdown = dedupeDisplayEquations(output.join('\n'), equations);

  return {
    markdown: protectedMarkdown,
    changed: equations.length > 0,
    equations,
  };
}

// Models often emit a numbered display equation twice: once as an inline-only
// paragraph and once as a $$ block with identical TeX. Dropping the inline copy
// keeps the centered display form without any content loss (直译不增不减).
function dedupeDisplayEquations(markdown, equations) {
  const byToken = new Map(equations.map((equation) => [equation.token, equation]));
  const normalize = (tex) => String(tex).replace(/\s+/g, '');
  let result = markdown.replace(/(SLMATH\d{4}XSLMATH)\n{2,}(SLMATH\d{4}XSLMATH)/g,
    (pair, inlineToken, displayToken) => {
      const inline = byToken.get(inlineToken);
      const display = byToken.get(displayToken);
      if (!inline || !display || inline.display || !display.display) return pair;
      if (normalize(inline.tex) !== normalize(display.tex)) return pair;
      byToken.delete(inlineToken);
      inline.deduped = true;
      return displayToken;
    });
  for (let index = equations.length - 1; index >= 0; index -= 1) {
    if (equations[index].deduped) equations.splice(index, 1);
  }
  return result;
}

function buildEquationImage(document, equation) {
  const image = equation.image;
  if (!image?.src) throw new Error(`公式 ${equation.token} 缺少渲染图片`);
  const node = document.createElement('img');
  node.setAttribute('src', image.src);
  node.setAttribute('data-sl-math', 'true');
  node.setAttribute('alt', '');
  // Captured dimensions exclude transparent padding; include it in the logical
  // dimensions so width and height match the bitmap's aspect ratio exactly.
  const logicalWidth = image.width + MATH_CAPTURE_PADDING.x * 2;
  const logicalHeight = image.height + MATH_CAPTURE_PADDING.y * 2;
  const naturalEm = logicalWidth / MATH_BASE_FONT_PX;
  if (equation.display && naturalEm > MATH_DISPLAY_FIT_EM / MATH_DISPLAY_MIN_SCALE) {
    throw new Error(`公式 ${equation.token} 自然宽度 ${naturalEm.toFixed(1)}em 过宽，等比缩小后不可读，请拆分该公式`);
  }
  const em = equation.display ? Math.min(naturalEm, MATH_DISPLAY_FIT_EM)
    : logicalHeight / MATH_BASE_FONT_PX;
  node.setAttribute('width', String(Math.ceil(equation.display ? Math.min(logicalWidth, MATH_DISPLAY_FIT_EM * MATH_BASE_FONT_PX) : logicalWidth)));
  if (!equation.display) node.setAttribute('height', String(Math.ceil(logicalHeight)));
  const style = equation.display
    ? `width:${em.toFixed(4)}em!important;max-width:100%!important;height:auto!important;margin:1em auto;display:block;`
    : `width:${naturalEm.toFixed(4)}em!important;height:${em.toFixed(4)}em!important;vertical-align:middle;max-width:100%;`;
  node.setAttribute('style', style);
  return node;
}

// Replace protection tokens in the styled HTML with rasterized equation images.
// Inline formulas scale with the reader's font setting via em heights; display
// formulas stay centered and clamp to the article width.
export function restoreMathInHtml(html, { equations = [] } = {}) {
  if (!equations.length) return String(html ?? '');
  const byToken = new Map(equations.map((equation) => [equation.token, equation]));
  const dom = new JSDOM(`<body>${String(html ?? '')}</body>`);
  try {
    const window = dom.window;
    const walker = window.document.createTreeWalker(window.document.body, window.NodeFilter.SHOW_TEXT);
    const targets = [];
    while (walker.nextNode()) {
      if (MATH_TOKEN_ONE.test(walker.currentNode.nodeValue)) targets.push(walker.currentNode);
    }
    for (const node of targets) {
      const parts = node.nodeValue.split(/(SLMATH\d{4}XSLMATH)/);
      const fragment = window.document.createDocumentFragment();
      for (const part of parts) {
        const equation = byToken.get(part);
        if (!equation) {
          if (part) fragment.appendChild(window.document.createTextNode(part));
          continue;
        }
        if (equation.display) {
          const section = window.document.createElement('section');
          section.setAttribute('data-sl-math-display', 'true');
          section.setAttribute('style', 'text-align:left;margin:1em 0;');
          section.appendChild(buildEquationImage(window.document, equation));
          fragment.appendChild(section);
        } else {
          fragment.appendChild(buildEquationImage(window.document, equation));
        }
      }
      node.parentNode.replaceChild(fragment, node);
    }
    return window.document.body.innerHTML;
  } finally { dom.window.close(); }
}

// Hard gate: every protected formula must come back as exactly one image, and no
// placeholder, MathJax artifact, or raw TeX command may remain in body copy.
export function validateMathRestored(html, { equations = [] } = {}) {
  const errors = [];
  const document = new JSDOM(`<body>${String(html ?? '')}</body>`).window.document;
  try {
    const residue = document.body.textContent.match(MATH_TOKEN_RE);
    if (residue?.length) {
      errors.push(`最终 HTML 残留 ${new Set(residue).size} 个未恢复的公式占位符`);
    }
    const images = [...document.querySelectorAll('img[data-sl-math="true"]')];
    if (images.length !== equations.length) {
      errors.push(`公式图片恢复数量不符:提取 ${equations.length} 个,恢复 ${images.length} 个`);
    }
    // Plausible rendered-size bounds catch sizing regressions (e.g. em divisors)
    // before a draft with invisible formulas can be published.
    const readEm = (image, property) => parseFloat(new RegExp(`${property}:([\\d.]+)em`).exec(image.getAttribute('style') || '')?.[1] ?? 'NaN');
    for (const [index, image] of images.entries()) {
      const display = image.getAttribute('data-sl-math-display') || image.closest('[data-sl-math-display]');
      const em = readEm(image, display ? 'width' : 'height');
      if (Number.isNaN(em)) {
        errors.push(`第 ${index + 1} 张公式图片缺少 em 尺寸`);
      } else if (display) {
        if (em < 1 || em > 40) errors.push(`第 ${index + 1} 张显示公式宽度 ${em}em 超出合理范围`);
      } else if (em < 0.4 || em > 8) {
        errors.push(`第 ${index + 1} 张行内公式高度 ${em}em 超出合理范围`);
      }
    }
    for (const [index, image] of images.entries()) {
      if (!image.getAttribute('src')) errors.push(`第 ${index + 1} 张公式图片缺少 src`);
    }
    if (document.querySelector('mjx-container')) {
      errors.push('最终 HTML 残留 MathJax 渲染容器,公式必须为图片');
    }
    if ([...document.querySelectorAll('svg')].some((svg) => svg.querySelector('[data-mml-node="math"]'))) {
      errors.push('最终 HTML 残留 MathJax 公式 SVG,公式必须为图片');
    }
    const texResidue = [];
    const walker = document.createTreeWalker(document.body, 4 /* NodeFilter.SHOW_TEXT */);
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (parent?.closest('pre,code,[data-sl-math]')) continue;
      const match = TEX_COMMAND_RE.exec(walker.currentNode.nodeValue || '');
      if (match) texResidue.push(match[0]);
    }
    if (texResidue.length) {
      errors.push(`正文残留未渲染的 TeX 命令:${[...new Set(texResidue)].slice(0, 5).join(' ')}`);
    }
    if (errors.length) throw new Error(`公式渲染完整性校验失败:${errors.join('; ')}`);
    return { equations: equations.length, images: images.length };
  } finally { document.defaultView.close(); }
}

// ---- Offline MathJax TeX -> SVG compilation ----

let mathJaxState;
function ensureMathJax() {
  if (mathJaxState) return mathJaxState;
  const adaptor = liteAdaptor({ fontSize: MATH_BASE_FONT_PX });
  try {
    RegisterHTMLHandler(adaptor);
  } catch {
    // wenyan-core registers its own lite adaptor per process; either instance
    // serializes identically, so a duplicate registration is harmless.
  }
  const texJax = new TeX({
    inlineMath: [['\\(', '\\)']],
    displayMath: [['\\[', '\\]']],
    processEscapes: false,
    // Undefined commands must produce a real MathJax error, rather than red text.
    packages: AllPackages.filter((name) => name !== 'noundefined'),
    // AllPackages contains MathJax extensions, not every LaTeX package or
    // author-defined operator used in papers. Keep source TeX intact and define
    // these common commands in the compiler. Boldsymbol preserves bold Greek
    // and italic vectors; mathbf would silently change their notation.
    macros: {
      bm: ['\\boldsymbol{#1}', 1],
      argmax: '\\operatorname*{arg\\,max}',
      argmin: '\\operatorname*{arg\\,min}',
    },
  });
  const svgJax = new SVG({ fontCache: 'none' });
  mathJaxState = { texJax, svgJax };
  return mathJaxState;
}

export function compileEquationSvg(tex, display) {
  const { texJax, svgJax } = ensureMathJax();
  const source = display ? `\\[${tex}\\]` : `\\(${tex}\\)`;
  const doc = mathjax.document(source, { InputJax: texJax, OutputJax: svgJax });
  doc.render();
  const adaptor = doc.adaptor;
  const html = adaptor.innerHTML(adaptor.body(doc.document));
  // Explicit equation colors are valid; only compiler errors block rendering.
  const error = /data-mjx-error="([^"]*)"/.exec(html);
  if (error || html.includes('<merror')) {
    throw new Error(`公式编译失败:${error?.[1] || 'MathJax 无法识别的命令或语法错误'}`);
  }
  const svg = /<svg[\s\S]*?<\/svg>/.exec(html)?.[0];
  if (!svg) throw new Error('公式编译未产出 SVG');
  return { svg };
}

export function equationCaptureHtml(svg, color = MATH_INK_COLOR) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;font-size:${MATH_BASE_FONT_PX}px}
body{font-family:Georgia,"Times New Roman","Songti SC",serif}
.wrap{display:inline-block;padding:${MATH_CAPTURE_PADDING.y}px ${MATH_CAPTURE_PADDING.x}px;color:${color}}
.wrap svg{display:block}
</style></head><body><div class="wrap">${svg}</div></body></html>`;
}

async function captureEquationsWithBrowser(items, { outDir, executablePath, color, signal, onCaptured = () => {} }) {
  throwIfTaskCancelled(signal);
  const browserPath = executablePath || resolveBrowserExecutable();
  await fs.mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-dev-shm-usage'],
  });
  const abortBrowser = () => { void browser.close().catch(() => {}); };
  signal?.addEventListener('abort', abortBrowser, { once: true });
  try {
    throwIfTaskCancelled(signal);
    const context = await browser.newContext({ serviceWorkers: 'block',
      viewport: { width: 2400, height: 400 },
      deviceScaleFactor: MATH_CAPTURE_SCALE,
    });
    await context.route('**/*', (route) => route.abort('blockedbyclient'));
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    const results = [];
    for (const [index, item] of items.entries()) {
      throwIfTaskCancelled(signal);
      const src = `math-${item.cacheKey || String(index + 1).padStart(3, '0')}.png`;
      const outPath = path.join(outDir, src);
      assertProjectPath(outDir, outPath);
      await page.setContent(equationCaptureHtml(item.svg, color), { waitUntil: 'load' });
      const box = await page.locator('.wrap').boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) {
        throw new Error(`公式 ${index + 1} 截图尺寸无效`);
      }
      await page.locator('.wrap').screenshot({
        path: outPath,
        type: 'png',
        omitBackground: true,
        animations: 'disabled',
      });
      results.push({
        src,
        path: outPath,
        width: Math.ceil(box.width - MATH_CAPTURE_PADDING.x * 2),
        height: Math.ceil(box.height - MATH_CAPTURE_PADDING.y * 2),
      });
      onCaptured(item, results.at(-1));
      throwIfTaskCancelled(signal);
    }
    return results;
  } catch (error) {
    if (signal?.aborted) throw cancellationErrorFromSignal(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortBrowser);
    await browser.close().catch(() => {});
  }
}

// Render every unique formula to a transparent PNG under the run directory.
// Identical TeX reuses one file. MathJax compilation errors hard-fail the task.
export async function renderEquationPngs(equations, {
  outDir,
  executablePath,
  signal,
  onTelemetry,
  color = MATH_INK_COLOR,
  capture = captureEquationsWithBrowser,
} = {}) {
  throwIfTaskCancelled(signal);
  const started = performance.now();
  const list = Array.isArray(equations) ? equations.filter(Boolean) : [];
  if (!list.length) return [];
  if (!outDir) throw new Error('公式图片渲染缺少输出目录');

  const groups = new Map();
  for (const equation of list) {
    if (!equation?.token || typeof equation.tex !== 'string' || !equation.tex.trim()) {
      throw new Error(`公式 ${equation?.token || '?'} 缺少 TeX 内容`);
    }
    const key = `${equation.display ? 'block' : 'inline'}::${equation.tex}`;
    let group = groups.get(key);
    if (!group) {
      group = { tex: equation.tex, display: Boolean(equation.display), members: [] };
      groups.set(key, group);
    }
    group.members.push(equation);
  }

  const filename = path.join(outDir, 'math-cache.json');
  let saved;
  try { saved = readJson(filename); } catch { /* Rebuild damaged derived cache. */ }
  const records = saved?.version === 1 ? saved.records || {} : {};
  const compiled = [], captured = [], pending = [], positions = [];
  for (const group of groups.values()) {
    const cacheKey = hash({ version: 1, tex: group.tex, display: group.display, color,
      font: MATH_BASE_FONT_PX, scale: MATH_CAPTURE_SCALE, padding: MATH_CAPTURE_PADDING });
    let cached = records[cacheKey];
    try {
      if (!cached || cached.image.width <= 0 || cached.image.height <= 0
        || hash(fileRecord(cached.image.src, outDir)) !== hash(cached.file)) cached = null;
      if (cached) {
        const buffer = await fs.readFile(path.join(outDir, cached.image.src));
        if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
          || Math.abs(buffer.readUInt32BE(16) - (cached.image.width + MATH_CAPTURE_PADDING.x * 2) * MATH_CAPTURE_SCALE) > MATH_CAPTURE_SCALE
          || Math.abs(buffer.readUInt32BE(20) - (cached.image.height + MATH_CAPTURE_PADDING.y * 2) * MATH_CAPTURE_SCALE) > MATH_CAPTURE_SCALE) cached = null;
      }
    } catch (error) { if (error.needsReview) throw error; cached = null; }
    compiled.push(group);
    if (cached) captured.push(cached.image);
    else {
      const { svg } = compileEquationSvg(group.tex, group.display);
      pending.push({ ...group, svg, cacheKey }); positions.push(compiled.length - 1); captured.push(null);
    }
  }
  const persistImage = (key, image) => {
    if (!image?.src || !(image.width > 0) || !(image.height > 0)) throw new Error('公式截图尺寸无效');
    try {
      records[key] = { image: { src: image.src, width: image.width, height: image.height }, file: fileRecord(image.src, outDir) };
      writeAtomic(filename, { version: 1, records });
    } catch (error) { if (error.needsReview) throw error; /* Injected captures may omit files. */ }
  };
  if (pending.length) {
    const fresh = await withRuntimeResource('browser', () => capture(pending, { outDir, executablePath, signal, color, onCaptured: (item, image) => persistImage(item.cacheKey, image) }), signal);
    throwIfTaskCancelled(signal);
    if (!Array.isArray(fresh) || fresh.length !== pending.length) throw new Error('公式截图数量与公式数量不一致');
    for (const [index, image] of fresh.entries()) {
      captured[positions[index]] = image;
      persistImage(pending[index].cacheKey, image);
    }
  }
  let fitted = 0;
  compiled.forEach((group, index) => {
    const image = captured[index];
    if (!image?.src || !(image.width > 0) || !(image.height > 0)) {
      throw new Error(`公式 ${index + 1} 截图结果无效`);
    }
    if (group.display && image.width / MATH_BASE_FONT_PX > MATH_DISPLAY_FIT_EM) fitted += 1;
    for (const member of group.members) {
      member.image = { src: image.src, width: image.width, height: image.height };
    }
  });
  emitTelemetry(onTelemetry, { stage: 'math-rasterize', count: compiled.length, fitted, durationMs: performance.now() - started });
  return list;
}
