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
import { emitTelemetry } from './telemetry.js';
import { cancellationErrorFromSignal, throwIfTaskCancelled } from './task-cancellation.js';

// WeChat draft formulas must be rasterized images. The upstream wenyan-core pipeline
// runs MathJax over HTML that marked has already mangled (underscores in TeX become
// <em>), which fragments formulas, leaks raw LaTeX into body copy, and renders CJK
// fallback text that overlaps under WeChat's reader font scaling. This module
// protects math before markdown parsing (placeholders that survive marked intact),
// renders each formula to a 3x transparent PNG via the same MathJax + Chromium stack
// used for tables and heading cards, and restores validated <img> nodes afterwards.

export const MATH_TOKEN_RE = /SLMATH\d{4}XSLMATH/g;
const MATH_TOKEN_ONE = /SLMATH\d{4}XSLMATH/;
const MATH_TOKEN_PREFIX = 'SLMATH';
const MATH_TOKEN_SUFFIX = 'XSLMATH';

export const MATH_INK_COLOR = '#2B3645';
export const MATH_CAPTURE_SCALE = 3;
const MATH_BASE_FONT_PX = 16;
const MATH_CAPTURE_PADDING = { x: 3, y: 2 };
const MAX_INLINE_TEX_LENGTH = 1000;
const MAX_DISPLAY_TEX_LENGTH = 4000;

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
  // image.width/height are CSS pixels measured at MATH_BASE_FONT_PX in the capture
  // page, so dividing by the base font alone yields reader-font-relative em sizing.
  const style = equation.display
    ? `width:${(image.width / MATH_BASE_FONT_PX).toFixed(4)}em;max-width:100%;height:auto;margin:1em auto;display:block;`
    : `height:${(image.height / MATH_BASE_FONT_PX).toFixed(4)}em;vertical-align:middle;max-width:100%;`;
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
        section.setAttribute('style', 'text-align:center;margin:1em 0;');
        section.appendChild(buildEquationImage(window.document, equation));
        fragment.appendChild(section);
      } else {
        fragment.appendChild(buildEquationImage(window.document, equation));
      }
    }
    node.parentNode.replaceChild(fragment, node);
  }
  return window.document.body.innerHTML;
}

// Hard gate: every protected formula must come back as exactly one image, and no
// placeholder, MathJax artifact, or raw TeX command may remain in body copy.
export function validateMathRestored(html, { equations = [] } = {}) {
  const errors = [];
  const document = new JSDOM(`<body>${String(html ?? '')}</body>`).window.document;
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
  const readEm = (image) => parseFloat(/([\d.]+)em/.exec(image.getAttribute('style') || '')?.[1] ?? 'NaN');
  for (const [index, image] of images.entries()) {
    const em = readEm(image);
    if (Number.isNaN(em)) {
      errors.push(`第 ${index + 1} 张公式图片缺少 em 尺寸`);
    } else if (image.getAttribute('data-sl-math-display') || image.closest('[data-sl-math-display]')) {
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
}

// ---- Offline MathJax TeX -> SVG compilation (same packages as wenyan-core) ----

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
    packages: AllPackages,
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
  // Unknown macros render as red mtext (fill="red") in SVG output; merror covers
  // other compile failures. Either means the formula would publish broken glyphs.
  const error = /data-mjx-error="([^"]*)"/.exec(html);
  if (error || html.includes('<merror') || /fill="red"/.test(html)) {
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

async function captureEquationsWithBrowser(items, { outDir, executablePath, color, signal }) {
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
    const page = await browser.newPage({
      viewport: { width: 2400, height: 400 },
      deviceScaleFactor: MATH_CAPTURE_SCALE,
    });
    await page.route('**/*', (route) => route.abort('blockedbyclient'));
    const results = [];
    for (const [index, item] of items.entries()) {
      throwIfTaskCancelled(signal);
      const src = `math-${String(index + 1).padStart(3, '0')}.png`;
      const outPath = path.join(outDir, src);
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
      throwIfTaskCancelled(signal);
      results.push({
        src,
        path: outPath,
        width: Math.ceil(box.width - MATH_CAPTURE_PADDING.x * 2),
        height: Math.ceil(box.height - MATH_CAPTURE_PADDING.y * 2),
      });
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

// Render every unique formula to a 3x transparent PNG under the run directory.
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

  const compiled = [];
  for (const group of groups.values()) {
    const { svg } = compileEquationSvg(group.tex, group.display);
    compiled.push({ ...group, svg });
  }

  const captured = await withRuntimeResource(
    'browser',
    () => capture(compiled, { outDir, executablePath, signal, color }),
    signal,
  );
  throwIfTaskCancelled(signal);
  emitTelemetry(onTelemetry, { stage: 'math-rasterize', count: compiled.length, durationMs: performance.now() - started });
  if (!Array.isArray(captured) || captured.length !== compiled.length) {
    throw new Error('公式截图数量与公式数量不一致');
  }
  compiled.forEach((group, index) => {
    const image = captured[index];
    if (!image?.src || !(image.width > 0) || !(image.height > 0)) {
      throw new Error(`公式 ${index + 1} 截图结果无效`);
    }
    for (const member of group.members) {
      member.image = { src: image.src, width: image.width, height: image.height };
    }
  });
  return list;
}
