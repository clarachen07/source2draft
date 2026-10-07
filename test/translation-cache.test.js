import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inheritTranslationRevision, saveSourceSnapshot, sourceSnapshotKey, readSourceSnapshot } from '../src/workflows/translation-cache.js';
import { parseTranslationScope } from '../src/workflows/translation-scope.js';
import { DOCUMENT_VERSION } from '../src/workflows/translation-config.js';
import { translationRequirements } from '../src/workflows/translation-requirements.js';
import { fileRecord, readArtifactCache, approveArtifact, preparedIdentity, preparedManifestHash, readPreparedCache, RENDER_VERSION } from '../src/lib/artifact-cache.js';
import { localizeFigureAssets } from '../src/workflows/source-assets.js';
import { hash, writeAtomic, readJson } from '../src/lib/io.js';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082', 'hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workDirFor = id => path.join(root, id);
  for (const id of ['parent', 'child']) fs.mkdirSync(workDirFor(id));
  const sourceUrl = 'https://example.org/study', input = `翻译 ${sourceUrl}`, config = { accountId: 'account' };
  const parentDir = workDirFor('parent'), workDir = workDirFor('child'), file = path.join(parentDir, 'original.png');
  fs.writeFileSync(file, png);
  const document = { version: DOCUMENT_VERSION, sourceUrl, sourceType: 'html', sha256: 'source', title: 'Study', scope: { kind: 'all' },
    blocks: [{ id: 'b0', type: 'paragraph', text: 'Study description. '.repeat(10) }, { id: 'b1', type: 'figure', images: [{ src: `${sourceUrl}.png`, localPath: file }] }] };
  const key = sourceSnapshotKey(sourceUrl, parseTranslationScope(input), config);
  saveSourceSnapshot(path.join(parentDir, 'translation-source-document.json'), key, document, parentDir);
  writeAtomic(path.join(parentDir, 'translation-checkpoint.json'), { version: 8, translations: [{ id: 'b0', text: '已验证正文。' }] });
  writeAtomic(path.join(parentDir, 'upload-receipts.json'), { version: 1, account: hash(config.accountId), uploads: {
    [`body:${hash(png)}`]: { url: 'https://mmbiz.qpic.cn/image/0' }, [`cover:${hash(png)}`]: { media_id: 'cover-id' },
    'body:other': { url: 'https://mmbiz.qpic.cn/other/0' } } });
  writeAtomic(path.join(parentDir, 'prepared.json'), { media_id: 'must-not-inherit' });
  const parent = { id: 'parent', thread_key: 'C1:1', mode: 'translation', media_id: 'draft-id', status: 'done' };
  const run = { id: 'child', parent_id: 'parent', thread_key: 'C1:1', mode: 'translation', input };
  const args = { run, store: { get: id => id === 'parent' ? parent : null }, workDir, workDirFor, sourceUrl, config };
  return { ...args, args, root, parentDir, parent, key, document };
}

test('registered parent chain copies verified source assets and success receipts without operations or draft identity', t => {
  const f = fixture(t); assert.equal(inheritTranslationRevision(f.args), true);
  const saved = readSourceSnapshot(path.join(f.workDir, 'translation-source-document.json'), f.key, f.workDir);
  const copied = saved.blocks[1].images[0].localPath;
  assert.ok(copied.startsWith(f.workDir + path.sep)); assert.deepEqual(fs.readFileSync(copied), png);
  assert.notEqual(fs.statSync(copied).ino, fs.statSync(path.join(f.parentDir, 'original.png')).ino);
  assert.deepEqual(Object.keys(readJson(path.join(f.workDir, 'upload-receipts.json')).uploads).sort(), [`body:${hash(png)}`, `cover:${hash(png)}`]);
  assert.equal(fs.existsSync(path.join(f.workDir, 'prepared.json')), false);
  assert.equal(fs.existsSync(path.join(f.workDir, 'operations.json')), false);
  assert.equal(f.run.media_id, undefined);
});

test('a completed explicit refresh remains reusable on later title edits; a new refresh cannot inherit old source', t => {
  const f = fixture(t);
  f.parent.input = f.run.input + '\n\n补充指令：\n刷新原文';
  const refreshIdentity = hash(translationRequirements(f.parent.input).refreshRequest);
  saveSourceSnapshot(path.join(f.parentDir, 'translation-source-document.json'), f.key, f.document, f.parentDir, refreshIdentity);
  f.run.input = f.parent.input + '\n\n补充指令：\n标题改为新标题';
  assert.equal(inheritTranslationRevision(f.args), true);
  assert.ok(readSourceSnapshot(path.join(f.workDir, 'translation-source-document.json'), f.key, f.workDir, refreshIdentity));
  fs.unlinkSync(path.join(f.workDir, 'translation-source-document.json'));
  f.run.input += '\n\n补充指令：\n刷新原文'; assert.equal(inheritTranslationRevision(f.args), false);
});

for (const reason of ['other-thread', 'source', 'refresh', 'range', 'version', 'hash', 'account'])
  test(`inheritance rejects incompatible ${reason}`, t => {
    const f = fixture(t);
    if (reason === 'other-thread') f.parent.thread_key = 'C2:1';
    if (reason === 'source') f.args.sourceUrl += '?new';
    if (reason === 'refresh') f.run.input += '\n\n补充指令：\n刷新原文';
    if (reason === 'range') f.run.input += '\n\n补充指令：\n只翻译第2节';
    if (reason === 'version') {
      const filename = path.join(f.parentDir, 'translation-source-document.json'), saved = readJson(filename);
      saved.version--; writeAtomic(filename, saved);
    }
    if (reason === 'hash') fs.writeFileSync(path.join(f.parentDir, 'original.png'), 'damaged');
    if (reason === 'account') f.config.accountId = 'different-account';
    assert.equal(inheritTranslationRevision(f.args), reason === 'account');
    assert.equal(fs.existsSync(path.join(f.workDir, 'upload-receipts.json')), false);
  });

test('converted image paths cannot overwrite original assets when extraction order differs', async t => {
  const f = fixture(t), original = path.join(f.parentDir, 'original.png'), webp = path.join(f.parentDir, 'figure-002.webp');
  fs.writeFileSync(webp, Buffer.from('RIFF0000WEBPfixture'));
  const images = [{ src: 'webp' }, { src: 'png' }];
  await localizeFigureAssets([{ type: 'figure', images }], { workDir: f.parentDir, assetMap: { webp, png: original },
    config: { imageRasterizer: async ({ target }) => fs.writeFileSync(target, Buffer.concat([png, Buffer.from('converted')])) } });
  assert.deepEqual(fs.readFileSync(original), png);
  assert.equal(images[1].localPath, original); assert.match(images[0].localPath, /converted\/image-[a-f0-9]+\.png$/);
  assert.notEqual(hash(fs.readFileSync(images[0].localPath)), hash(png));
});

test('unique source image downloads use at most three concurrent requests and deduplicate repeated URLs', async t => {
  const f = fixture(t); let active = 0, peak = 0, calls = 0;
  const images = Array.from({ length: 9 }, (_, i) => ({ src: `https://example.org/image-${i % 7}.png` }));
  await localizeFigureAssets([{ type: 'figure', images }], { workDir: f.workDir,
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }], fetchFn: async () => {
      calls++; peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 5)); active--;
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    } });
  assert.equal(calls, 7); assert.equal(peak, 3); assert.equal(new Set(images.map(image => image.localPath)).size, 1);
});

test('artifact approvals bind full source evidence and quality/model policy', t => {
  const f = fixture(t), context = { input: f.run.input, mode: 'translation', modelIdentity: { translation: 'gpt-6-luna' } };
  const filename = path.join(f.workDir, 'artifact.json'), artifact = approveArtifact({ article: '# 文章\n\n正文。', manifest: { sha256: 'original' } }, context);
  writeAtomic(filename, artifact); assert.ok(readArtifactCache(f.workDir, context));
  writeAtomic(filename, { ...artifact, manifest: { sha256: 'changed' } }); assert.equal(readArtifactCache(f.workDir, context), null);
  writeAtomic(filename, { ...artifact, approval: { ...artifact.approval, policy: 0 } }); assert.equal(readArtifactCache(f.workDir, context), null);
  writeAtomic(filename, artifact); assert.equal(readArtifactCache(f.workDir, { ...context, modelIdentity: { translation: 'changed' } }), null);
});

test('prepared manifest restores only damaged text outputs; title or image corruption cannot bypass rendering', t => {
  const f = fixture(t), markdown = '# 文章\n\n正文。', config = { browser: '/fixture' }, html = '<p>正文。</p>', preview = '<html>正文。</html>';
  fs.writeFileSync(path.join(f.workDir, 'cover.png'), png); writeAtomic(path.join(f.workDir, 'article.html'), html); writeAtomic(path.join(f.workDir, 'preview.html'), preview);
  const prepared = { title: '文章', html, coverPath: path.join(f.workDir, 'cover.png'), assets: [], version: RENDER_VERSION,
    identity: preparedIdentity(markdown, config, undefined, f.workDir), outputContents: { 'article.html': html, 'preview.html': preview },
    files: ['article.html', 'preview.html', 'cover.png'].map(file => fileRecord(file, f.workDir)) };
  prepared.manifestHash = preparedManifestHash(prepared); writeAtomic(path.join(f.workDir, 'prepared.json'), prepared);
  assert.ok(readPreparedCache(f.workDir, { markdown, config }));
  fs.unlinkSync(path.join(f.workDir, 'preview.html'));
  const before = fs.statSync(path.join(f.workDir, 'cover.png')).mtimeMs;
  assert.ok(readPreparedCache(f.workDir, { markdown, config, repairOutputs: true }));
  assert.equal(fs.readFileSync(path.join(f.workDir, 'preview.html'), 'utf8'), preview);
  assert.equal(fs.statSync(path.join(f.workDir, 'cover.png')).mtimeMs, before);
  writeAtomic(path.join(f.workDir, 'prepared.json'), { ...prepared, title: '错误标题' }); assert.equal(readPreparedCache(f.workDir, { markdown, config }), null);
  writeAtomic(path.join(f.workDir, 'prepared.json'), prepared); fs.writeFileSync(path.join(f.workDir, 'cover.png'), 'bad');
  assert.equal(readPreparedCache(f.workDir, { markdown, config, repairOutputs: true }), null);
});
