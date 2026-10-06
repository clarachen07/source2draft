import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { applyWechatArticleStyles, assertSafeArticle, normalizeWechatLists, prepareArticle, safeLocalAsset } from '../src/lib/wechat-render.js';
import { loadConfig } from '../src/config/index.js';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082', 'hex');

test('credential guard preserves article source slugs while rejecting standalone and URL-borne tokens', () => {
  const config = loadConfig({ DEEPSEEK_API_KEY: 'fixture-configured-key-123456' });
  for (const slug of ['elon-musk-power-shortage-data-centers', 'task-infrastructure-and-electricity',
    'mask-generation-and-processing', 'identifier_xoxb-infrastructure-report', 'identifier_xapp-infrastructure-report']) {
    assert.doesNotThrow(() => assertSafeArticle(`[参考来源](https://example.org/technology/${slug}.htm)`, config));
  }
  for (const token of ['sk-fixture1234567890', 'sk-proj-fixture1234567890', 'sk-ant-fixture1234567890',
    ...['b', 'a', 'p', 'r', 's'].map(kind => `xox${kind}-fixture1234567890`), 'xapp-fixture1234567890']) {
    for (const text of [`密钥${token}`, `Authorization: Bearer ${token}`, `"${token}"`,
      `[引用](https://example.org/${token}/article)`, `[引用](https://example.org/?auth=${token})`]) {
      assert.throws(() => assertSafeArticle(text, config), /疑似凭据/);
    }
  }
  // Exact configured secrets remain blocked even when embedded in an identifier.
  assert.throws(() => assertSafeArticle('prefixfixture-configured-key-123456suffix', config), /运行凭据/);
});

test('articles above 300 distinct images preserve every figure, formula and repeated occurrence', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-many-images-')));
  try {
    const images = Array.from({ length: 301 }, (_, index) => {
      const name = `figure-${index}.png`;
      fs.writeFileSync(path.join(dir, name), Buffer.concat([png, Buffer.from(String(index))]));
      return `![原图 ${index}](${name})`;
    });
    const prepared = await prepareArticle({
      markdown: `---\ntitle: 公式密集论文\n---\n\n保留公式 $x_i$ 与重复公式 $x_i$。\n\n${images.join('\n\n')}\n\n![重复原图](figure-0.png)`,
      workDir: dir, config: loadConfig(),
    });
    const dom = new JSDOM(prepared.html);
    try {
      const all = [...dom.window.document.querySelectorAll('img')];
      assert.equal(all.length, 304);
      assert.equal(prepared.assets.length, 302);
      assert.equal(all.filter(img => img.hasAttribute('data-sl-math')).length, 2);
      assert.equal(all[0].getAttribute('src'), all[1].getAttribute('src'));
      assert.deepEqual(all.slice(2).map(img => img.getAttribute('src')),
        [...images.map((_, index) => `figure-${index}.png`), 'figure-0.png']);
      assert.ok(prepared.assets.every(asset => fs.existsSync(asset)));
      assert.ok(fs.existsSync(path.join(dir, 'prepared.json')));
    } finally { dom.window.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('image byte budget counts reusable content once, including files with different names', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-image-budget-')));
  try {
    const large = Buffer.concat([png, Buffer.alloc(1024 * 1024)]);
    fs.writeFileSync(path.join(dir, 'same.png'), large);
    fs.writeFileSync(path.join(dir, 'copy.png'), large);
    const prepared = await prepareArticle({
      markdown: `---\ntitle: 重复图片\n---\n\n保留所有图片引用。\n\n${Array.from({ length: 45 }, (_, index) => `![图片](${index % 2 ? 'same' : 'copy'}.png)`).join('\n\n')}`,
      workDir: dir, config: loadConfig(),
    });
    assert.equal(prepared.assets.length, 2);
    const dom = new JSDOM(prepared.html);
    try { assert.equal(dom.window.document.querySelectorAll('img').length, 45); }
    finally { dom.window.close(); }
    const distinct = Array.from({ length: 5 }, (_, index) => {
      fs.writeFileSync(path.join(dir, `large-${index}.png`), Buffer.concat([png, Buffer.alloc(9 * 1024 * 1024, index)]));
      return `![图片](large-${index}.png)`;
    });
    await assert.rejects(prepareArticle({ markdown: `# 体积检查\n\n正文\n\n${distinct.join('\n\n')}`, workDir: dir, config: loadConfig() }), /本地处理预算 40 MB/);
    fs.writeFileSync(path.join(dir, 'oversize.png'), Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]));
    await assert.rejects(prepareArticle({ markdown: '# 体积检查\n\n正文\n\n![图片](oversize.png)', workDir: dir, config: loadConfig() }), /单张图片超过 10 MB/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('render refuses dangerous HTML, injected math CSS and secret leakage before browser or upload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-render-'));
  try {
    const run = body => prepareArticle({ markdown: `---\ntitle: 测试\n---\n\n${body}`, workDir: dir, config: loadConfig({ DEEPSEEK_API_KEY: 'SECRET_LONG_VALUE' }) });
    await assert.rejects(run('<script>alert(1)</script>'), /不支持/);
    await assert.rejects(run('<span data-sl-math="true" style="background:url(https://example.org/a)">text</span>'), /不安全/);
    await assert.rejects(run('不能泄漏 SECRET_LONG_VALUE'), /凭据/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('image lookup cannot escape task directory, including symbolic links', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-assets-'));
  try {
    fs.mkdirSync(path.join(dir, 'run')); fs.writeFileSync(path.join(dir, 'private'), 'PRIVATE');
    fs.symlinkSync(path.join(dir, 'private'), path.join(dir, 'run', 'image.png'));
    assert.throws(() => safeLocalAsset('../private', path.join(dir, 'run')), /目录以外/);
    assert.throws(() => safeLocalAsset('image.png', path.join(dir, 'run')), /目录以外/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('references and ordinary bullets render as stable paragraphs', () => {
  const document = new JSDOM('<body><p>Body</p><ul><li>Ordinary item</li></ul><h2>参考来源</h2><ul><li><p><a href="https://example.org/first">First source</a></p></li><li><p>Second source</p></li></ul><table><tr><td>Cell</td></tr></table></body>').window.document;
  applyWechatArticleStyles(document.body);
  for (const element of document.querySelectorAll('p,h2,li,table,td')) {
    const style = element.getAttribute('style') || '';
    assert.match(style, /font-size:15px/);
    assert.match(style, /text-align:left/);
    assert.match(style, /font-family:/);
  }
  const heading = document.querySelector('h2');
  assert.deepEqual([heading.nextElementSibling, heading.nextElementSibling.nextElementSibling]
    .map(element => element.textContent), ['1. First source', '2. Second source']);
  assert.equal(document.querySelector('h2 + ol, h2 + ul'), null);
  assert.equal(heading.nextElementSibling.querySelector('a')?.getAttribute('href'), 'https://example.org/first');
  assert.equal(document.querySelector('p + p')?.textContent, '• Ordinary item');
  assert.equal(document.querySelector('ul,ol,li'), null);
});

test('bullet normalization removes empty editor items and preserves mixed nesting, inline assets and content order', () => {
  const document = new JSDOM(`<body><ul>
    <li><br></li><li><p>&nbsp;</p></li><li><span>\u200b</span></li>
    <li><p>DPO 阶段：<code>allenai/Llama-3.1-Tulu-3-8B-DPO</code>，其模型卡写明由 SFT 检查点微调而来</p>
      <ul><li><strong>子条目</strong> <a href="https://example.org">链接</a></li><li><br></li></ul>
      <p>子列表后的说明</p><ol start="3"><li>编号子条目</li></ol>
    </li>
    <li><p>第一段</p><p>第二段</p></li>
    <li><img src="image.png" alt="保留图片"></li>
    <li><ul><li>仅包含子列表</li></ul></li>
  </ul><ol reversed><li><br></li><li>倒序二</li><li>倒序一</li></ol></body>`).window.document;
  applyWechatArticleStyles(document.body);
  assert.equal(document.querySelector('ul,ol,li'), null);
  assert.deepEqual([...document.querySelectorAll('p')].map(p => p.textContent), [
    '• DPO 阶段：allenai/Llama-3.1-Tulu-3-8B-DPO，其模型卡写明由 SFT 检查点微调而来',
    '• 子条目 链接', '子列表后的说明', '3. 编号子条目', '• 第一段第二段',
    '• ', '• 仅包含子列表', '2. 倒序二', '1. 倒序一',
  ]);
  assert.match(document.querySelector('p + p').getAttribute('style'), /padding-left:1.5em/);
  assert.equal(document.querySelectorAll('p br').length, 1);
  assert.equal(document.querySelector('img')?.getAttribute('src'), 'image.png');
  assert.equal(document.querySelector('a')?.getAttribute('href'), 'https://example.org');
  const firstPass = document.body.innerHTML;
  normalizeWechatLists(document.body);
  assert.equal(document.body.innerHTML, firstPass);
});

test('ordered content and references produce one fixed number per nonempty item', () => {
  const document = new JSDOM(`<body><p>一个符号系统是：</p><ol>
    ${Array.from({ length: 8 }, (_, index) => `<li><p>原文第 ${index + 1} 项</p></li>${index === 2 ? '<li><br></li>' : ''}`).join('')}
    </ol><h2>参考文献</h2><ol><li><p>Chomsky, N. (1980)</p></li><li>  Davis, M. (1958)</li></ol>
    <ol start="3"><li>Third</li><li value="7">Seventh</li><li>Eighth</li></ol></body>`).window.document;
  applyWechatArticleStyles(document.body);
  assert.equal(document.querySelectorAll('ol').length, 0);
  assert.equal(document.querySelectorAll('li').length, 0);
  assert.deepEqual([...document.querySelectorAll('p')].slice(1, 9).map(p => p.textContent),
    Array.from({ length: 8 }, (_, index) => `${index + 1}. 原文第 ${index + 1} 项`));
  const references = document.querySelector('h2');
  assert.deepEqual([references.nextElementSibling, references.nextElementSibling.nextElementSibling]
    .map(p => p.textContent), ['1. Chomsky, N. (1980)', '2. Davis, M. (1958)']);
  assert.deepEqual([...document.querySelectorAll('p')].slice(-3).map(p => p.textContent),
    ['3. Third', '7. Seventh', '8. Eighth']);
});

test('prepared article embeds the uniform 15px layout in its upload HTML', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-layout-'));
  try {
    const prepared = await prepareArticle({
      markdown: '---\ntitle: Layout check\n---\n\nParagraph.\n\n3. Third item\n4. Fourth item\n\n## References\n\n1. First source\n2. Second source',
      workDir: dir,
      config: loadConfig(),
    });
    const document = new JSDOM(prepared.html).window.document;
    const section = document.querySelector('section');
    assert.match(section.getAttribute('style'), /font-size:15px/);
    assert.match(section.getAttribute('style'), /text-align:left/);
    assert.match(section.getAttribute('style'), /font-family:/);
    const heading = document.querySelector('h2');
    assert.deepEqual([heading.nextElementSibling, heading.nextElementSibling.nextElementSibling]
      .map(element => element.textContent), ['1. First source', '2. Second source']);
    assert.equal(document.querySelector('h2 + ol'), null);
    assert.equal(document.querySelector('ol'), null);
    assert.deepEqual([...document.querySelectorAll('section > p')].map(element => element.textContent),
      ['Paragraph.', '3. Third item', '4. Fourth item', '1. First source', '2. Second source']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
