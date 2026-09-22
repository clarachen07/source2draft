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

test('article typography is uniformly 15px and reference lists use one ordered sequence', () => {
  const document = new JSDOM('<body><p>Body</p><h2>参考来源</h2><ul><li><p>First source</p></li><li><p>Second source</p></li></ul><table><tr><td>Cell</td></tr></table></body>').window.document;
  applyWechatArticleStyles(document.body);
  for (const element of document.querySelectorAll('p,h2,ol,li,table,td')) {
    const style = element.getAttribute('style') || '';
    assert.match(style, /font-size:15px/);
    assert.match(style, /text-align:left/);
    assert.match(style, /font-family:/);
  }
  const references = document.querySelector('h2 + ol');
  assert.ok(references);
  assert.equal(references.children.length, 2);
  for (const paragraph of references.querySelectorAll('li > p')) assert.match(paragraph.getAttribute('style'), /margin:0/);
});

test('prepared article embeds the uniform 15px layout in its upload HTML', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-layout-'));
  try {
    const prepared = await prepareArticle({
      markdown: '---\ntitle: Layout check\n---\n\nParagraph.\n\n## References\n\n1. First source\n2. Second source',
      workDir: dir,
      config: loadConfig(),
    });
    const document = new JSDOM(prepared.html).window.document;
    const section = document.querySelector('section');
    assert.match(section.getAttribute('style'), /font-size:15px/);
    assert.match(section.getAttribute('style'), /text-align:left/);
    assert.match(section.getAttribute('style'), /font-family:/);
    assert.equal(document.querySelector('h2 + ol')?.children.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
