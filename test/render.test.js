import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareArticle, safeLocalAsset } from '../src/lib/wechat-render.js';
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
