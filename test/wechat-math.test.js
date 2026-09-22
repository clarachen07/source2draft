import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import {
  protectMathInMarkdown,
  restoreMathInHtml,
  validateMathRestored,
  compileEquationSvg,
  equationCaptureHtml,
} from '../src/lib/wechat-math.js';
import { validatePreparedWechatHtml } from '../src/lib/wechat-render.js';

const FIXTURE = await fs.readFile('test/fixtures/math-sample.md', 'utf-8');

test('公式保护:提取行内、显示、\\[\\] 与 \\(\\) 公式为占位符', () => {
  const result = protectMathInMarkdown(FIXTURE);
  assert.ok(result.changed);
  const tokens = new Set(result.equations.map((equation) => equation.token));
  assert.equal(result.equations.length, tokens.size, '占位符必须唯一');

  const display = result.equations.filter((equation) => equation.display);
  assert.equal(display.length, 1);
  assert.match(display[0].tex, /\\max_/);

  const inline = result.equations.filter((equation) => !equation.display);
  assert.ok(inline.some((equation) => equation.tex.includes('\\mathbf{X}')));
  assert.ok(inline.some((equation) => equation.tex.includes('\\mathcal{D}')), '\\(...\\) 也应被提取');

  assert.equal(result.equations.filter((equation) => equation.hasCjk).length, 1, '仅中文公式标记 hasCjk');
});

test('公式保护:代码块、行内代码与货币样式不被触碰', () => {
  const result = protectMathInMarkdown(FIXTURE);
  assert.ok(result.markdown.includes('prices.shift(W + 1)'), '代码块内容必须原样保留');
  const visible = result.markdown.replace(/<span data-sl-math-currency="true">\$<\/span>/g, '$');
  assert.ok(visible.includes('$5.2 与 $6.8'), '货币样式的可见文本不变');
  assert.ok(!result.markdown.includes('momentum = SLMATH'), '代码块内不得出现占位符');
  // 行内代码中的 $\mathbf{v}$ 必须保持原样
  const inlineCode = result.markdown.match(/`[^`]*`/g) || [];
  assert.ok(inlineCode.some((span) => span.includes('\\mathbf{v}')), '行内代码中的公式记号必须原样保留');
  assert.ok(!inlineCode.some((span) => /SLMATH\d{4}XSLMATH/.test(span)), '行内代码不得含占位符');
  // 正文剩余美元必须全部被中性化包裹,wenyan 的 MathJax 无法再配对
  const bodyLines = result.markdown
    .split('\n')
    .filter((line) => !line.includes('prices.shift') && !line.includes('不是公式') && !line.includes('`$\\mathbf{v}$`'));
  assert.ok(
    bodyLines.every((line) => !line.includes('$') || line.includes('data-sl-math-currency')),
    '正文剩余美元必须全部被中性化包裹',
  );
});

test('公式保护:frontmatter 与孤立 $ 不受数学提取影响', () => {
  const source = '---\ntitle: 报告 $100 汇总\n---\n\n成本在 $5 与 $10 之间。孤立 $ 符号。\n';
  const result = protectMathInMarkdown(source);
  assert.equal(result.equations.length, 0);
  // frontmatter 原样;正文的美元被中性化包裹但可见文本不变
  assert.ok(result.markdown.startsWith('---\ntitle: 报告 $100 汇总\n---'));
  const visible = result.markdown.replace(/<span data-sl-math-currency="true">\$<\/span>/g, '$');
  assert.ok(visible.includes('成本在 $5 与 $10 之间。孤立 $ 符号。'));
});

test('公式保护:单字母变量也被提取为公式', () => {
  const result = protectMathInMarkdown('截至第 $t$ 天的 $N$ 只股票,信号 $x_i$ 与 $x_{i}$ 有效。\n');
  const texes = result.equations.map((equation) => equation.tex);
  assert.deepEqual(texes, ['t', 'N', 'x_i', 'x_{i}']);
});

test('公式保护:不配对的孤立 $ 不被提取为公式', () => {
  const source = '这一段只有单个 $ 符号，没有公式。\n';
  const result = protectMathInMarkdown(source);
  assert.equal(result.equations.length, 0);
  const visible = result.markdown.replace(/<span data-sl-math-currency="true">\$<\/span>/g, '$');
  assert.ok(visible.includes('单个 $ 符号'));
});

test('公式保护:显示公式独占段落(避开 marked 段落级 $$ 检查)', () => {
  const result = protectMathInMarkdown(FIXTURE);
  const token = result.equations.find((equation) => equation.display).token;
  assert.ok(new RegExp(`\\n\\n${token}\\n\\n`).test(result.markdown), '显示公式占位符必须独立成段');
});

test('TeX 编译:合法公式产出 SVG,非法公式抛错', () => {
  const ok = compileEquationSvg('\\mathbf{X}_{\\leq t}\\in\\mathbb{R}^{N\\times t}', false);
  assert.match(ok.svg, /^<svg[\s\S]*<\/svg>$/);

  assert.throws(() => compileEquationSvg('\\notARealCommand{1}', false), /公式编译失败/);
});

test('公式截图 HTML:使用主题墨色且背景透明', () => {
  const { svg } = compileEquationSvg('x_t', false);
  const html = equationCaptureHtml(svg);
  assert.ok(html.includes('background:transparent'));
  assert.ok(html.includes('#2B3645'));
});

function fakeEquationImage(equation) {
  return { src: `math-${equation.token}.png`, width: 96, height: 24 };
}

function withImages(equations) {
  for (const equation of equations) {
    equation.image = { src: `math-${equation.token}.png`, width: 96, height: 32 };
  }
}

test('恢复与校验:占位符替换为图片且通过硬门禁', () => {
  const protection = protectMathInMarkdown(FIXTURE);
  withImages(protection.equations);
  const inlineEquation = protection.equations.find((equation) => !equation.display);
  const html = `<div id="wenyan"><p>设 X 与 ${inlineEquation.token} 相关。</p></div>`;
  const restored = restoreMathInHtml(html, { equations: [inlineEquation] });
  const document = new JSDOM(restored).window.document;
  const images = [...document.querySelectorAll('img[data-sl-math="true"]')];
  assert.equal(images.length, 1);
  const style = images[0].getAttribute('style');
  assert.ok(style.includes('em'), '行内公式必须用 em 高度随字号缩放');
  assert.ok(style.includes('vertical-align:middle'));

  // 全量恢复场景:所有占位符都在
  const fullHtml = restoreMathInHtml(
    `<p>${protection.equations.map((equation) => equation.token).join(' 和 ')}</p>`,
    { equations: protection.equations },
  );
  const fullDocument = new JSDOM(fullHtml).window.document;
  assert.equal(fullDocument.querySelectorAll('img[data-sl-math="true"]').length, protection.equations.length);
  const displaySections = [...fullDocument.querySelectorAll('section[data-sl-math-display="true"]')];
  assert.equal(displaySections.length, 1);
  assert.ok(displaySections[0].getAttribute('style').includes('text-align:left'));
  assert.doesNotThrow(() => validateMathRestored(fullHtml, { equations: protection.equations }));
});

test('恢复与校验:残留占位符或 TeX 必须硬失败', () => {
  const equations = [{ token: 'SLMATH0001XSLMATH', tex: 'x_t', display: false, hasCjk: false, image: { src: 'm.png', width: 96, height: 32 } }];
  assert.throws(
    () => validateMathRestored('<p>SLMATH0001XSLMATH</p>', { equations }),
    /公式图片恢复数量不符|残留/,
  );
  assert.throws(
    () => validateMathRestored('<p>正文里有 \\mathbf{X} 残留</p>', { equations: [] }),
    /TeX 命令/,
  );
  assert.throws(
    () => validateMathRestored('<p><mjx-container></mjx-container></p>', { equations: [] }),
    /MathJax/,
  );
  // 代码块中的 TeX 命令不算残留
  assert.doesNotThrow(() => validateMathRestored('<pre><code>\\mathbf{X}</code></pre>', { equations: [] }));
});

test('恢复与校验:公式 em 尺寸 = 像素 / 16(随读者字号缩放,不得缩小)', () => {
  const protection = protectMathInMarkdown('设 $\\mathbf{X}_{\\leq t}$ 与显示公式\n\n$$\\max f$$\n\n结束。\n');
  withImages(protection.equations);
  const html = restoreMathInHtml(
    protection.equations.map((equation) => equation.token).join('\n\n'),
    { equations: protection.equations },
  );
  const document = new JSDOM(html).window.document;
  for (const image of document.querySelectorAll('img[data-sl-math="true"]')) {
    const style = image.getAttribute('style');
    const em = parseFloat(/([\d.]+)em/.exec(style)[1]);
    const isDisplay = Boolean(image.closest('[data-sl-math-display]'));
    if (isDisplay) assert.equal(em, 96 / 16, '显示宽度应为 px/16');
    else assert.equal(em, 32 / 16, '行内高度应为 px/16');
  }
});

test('恢复与校验:公式尺寸超出合理范围必须硬失败', () => {
  const tiny = [{ token: 'SLMATH0001XSLMATH', tex: 'x_t', display: false, hasCjk: false, image: { src: 'm.png', width: 96, height: 6 } }];
  const restoredTiny = restoreMathInHtml('<p>A SLMATH0001XSLMATH B</p>', { equations: tiny });
  assert.throws(() => validateMathRestored(restoredTiny, { equations: tiny }), /超出合理范围/);
});

test('公式去重:行内段落与相同 TeX 的显示块只保留显示版', () => {
  const source = '该框架求解\n\n$\\max_{\\_1}$\n\n$$\\max_{\\_1}$$\n\n其中 $x_i$ 有效。\n';
  const result = protectMathInMarkdown(source);
  assert.equal(result.equations.length, 2, '重复的行内版被删除,仅剩显示版与无关行内公式');
  assert.ok(result.equations.some((equation) => equation.display));
  assert.ok(!result.markdown.match(/SLMATH\d{4}XSLMATH\n\nSLMATH\d{4}XSLMATH/));
  // 重复对被移除后,显示占位符仍在自己的段落里
  const displayToken = result.equations.find((equation) => equation.display).token;
  assert.ok(new RegExp(`\n\n${displayToken}\n\n`).test(result.markdown));
});

test('公式去重:TeX 不同或顺序不同时不去重', () => {
  const different = protectMathInMarkdown('$\\max a$\n\n$$\\max b$$\n\n');
  assert.equal(different.equations.length, 2);
  const reverse = protectMathInMarkdown('$$\\max a$$\n\n$\\max a$\n\n');
  assert.equal(reverse.equations.length, 2, '显示在前、行内在后不去重');
});

test('恢复:公式图片校验通过 validatePreparedWechatHtml 的本地图片检查', async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), 'test', '.tmp-math-'));
  try {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
      'hex',
    );
    await fs.writeFile(path.join(dir, 'math-0001.png'), png);
    const equations = [{
      token: 'SLMATH0001XSLMATH',
      tex: 'x_t',
      display: false,
      hasCjk: false,
      image: { src: 'math-0001.png', width: 96, height: 32 },
    }];
    const html = restoreMathInHtml(`<p>值 ${equations[0].token} 如上。</p>`, { equations });
    assert.doesNotThrow(() => {
      validateMathRestored(html, { equations });
      validatePreparedWechatHtml(html, { absoluteDirPath: dir });
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
