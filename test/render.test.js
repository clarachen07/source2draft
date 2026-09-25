import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { applyWechatArticleStyles, prepareArticle, safeLocalAsset } from '../src/lib/wechat-render.js';
import { loadConfig } from '../src/config/index.js';

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

test('reference links render as stable numbered paragraphs while ordinary lists remain lists', () => {
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
  assert.equal(document.querySelector('p + ul li')?.textContent, 'Ordinary item');
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
