import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseTranslationSource, chooseCover, findPreviousArticle, createEngine } from '../src/core/engine.js';
import { createWechat } from '../src/channels/wechat.js';
import { loadConfig } from '../src/config/index.js';
import { openStore } from '../src/core/store.js';
import { writeAtomic } from '../src/lib/io.js';

const config = loadConfig({ SLACK_BOT_TOKEN: 'fixture-token' });
const follow = (first, next) => `${first}\n\n补充指令：\n${next}`;
const run = (input, files = []) => ({ input, attachments: JSON.stringify(files) });

test('latest explicit source replaces old URL while unrelated editing instructions preserve it', () => {
  const original = '直译 https://example.org/old';
  assert.equal(chooseTranslationSource(run(follow(original, '改为翻译 https://example.org/new')), config).sourceUrl, 'https://example.org/new');
  assert.equal(chooseTranslationSource(run(follow(original, '保留作者原有语气和段落')), config).sourceUrl, 'https://example.org/old');
  assert.equal(chooseTranslationSource(run(follow(original, '封面：https://example.org/cover.png')), config).sourceUrl, 'https://example.org/old');
  assert.equal(chooseTranslationSource(run(follow(original, 'https://example.org/new')), config).sourceUrl, 'https://example.org/new');
});

test('latest named PDF replaces old URL and ambiguous replacement asks instead of using old source', () => {
  const files = ['one.pdf', 'two.pdf'].map((name, i) => ({ id: `F${i}`, name,
    mimetype: 'application/pdf', url: `https://files.slack.com/${name}` }));
  const original = '直译 https://example.org/old';
  const selected = chooseTranslationSource(run(follow(original, '改为翻译 two.pdf'), files), config);
  assert.equal(selected.sourceUrl, files[1].url);
  assert.equal(selected.sourceRequestHeaders.Authorization, 'Bearer fixture-token');
  assert.throws(() => chooseTranslationSource(run(follow(original, '改为翻译附件'), files), config), error => error.needsInput === true);
  assert.throws(() => chooseTranslationSource(run(follow(original, '翻译 https://example.org/a 或 https://example.org/b')), config), error => error.needsInput === true);
});

test('cover revisions select the latest explicit URL or image, with balanced URL punctuation', () => {
  const files = [{ id: 'F1', name: 'new.png', mimetype: 'image/png', url: 'https://files.slack.com/new.png' }];
  const original = '直译 https://example.org/article\n封面：https://example.org/old.png';
  assert.equal(chooseCover(run(follow(original, '封面：https://example.org/new_(cover).png')), config).url, 'https://example.org/new_(cover).png');
  assert.equal(chooseCover(run(follow(original, '封面改用 new.png'), files), config).url, files[0].url);
  assert.equal(chooseCover(run(follow(original, '保留所有图片')), config).url, 'https://example.org/old.png');
  const changed = run(follow(original, '把封面改成 https://example.org/new.png'));
  assert.equal(chooseCover(changed, config).url, 'https://example.org/new.png');
  assert.equal(chooseTranslationSource(changed, config).sourceUrl, 'https://example.org/article');
});

test('file selection does not confuse URL filenames or suffixes of longer filenames', () => {
  const files = ['paper.pdf', 'updated-paper.pdf'].map((name, i) => ({ id: `F${i}`, name,
    mimetype: 'application/pdf', url: `https://files.slack.com/${name}` }));
  assert.equal(chooseTranslationSource(run('直译 https://example.org/paper.pdf', files), config).sourceUrl, 'https://example.org/paper.pdf');
  assert.equal(chooseTranslationSource(run('改用 updated-paper.pdf', files), config).sourceUrl, files[1].url);
  const images = ['cover.png', 'updated-cover.png'].map((name, i) => ({ id: `I${i}`, name,
    mimetype: 'image/png', url: `https://files.slack.com/${name}` }));
  assert.equal(chooseCover(run('封面改用 updated-cover.png', images), config).url, images[1].url);
});

test('consecutive revisions find the nearest ancestor article and never cross task threads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-ancestor-'));
  const store = openStore(':memory:');
  const workDirFor = id => path.join(dir, id);
  const enqueue = (ts, text) => store.enqueue({ threadKey: 'C:1', ts, version: Number(ts), text, dryRun: true }).run;
  try {
    const first = enqueue('1', '第一篇');
    store.update(first.id, { status: 'done' });
    writeAtomic(path.join(workDirFor(first.id), 'artifact.json'), { article: '完整旧成稿' });
    const second = enqueue('2', '增加解释');
    const third = enqueue('3', '再修改结尾');
    assert.equal(findPreviousArticle(third, store, workDirFor), '完整旧成稿');
    writeAtomic(path.join(workDirFor(second.id), 'artifact.json'), { article: '较新完整成稿' });
    assert.equal(findPreviousArticle(third, store, workDirFor), '较新完整成稿');
    assert.equal(findPreviousArticle({ ...third, thread_key: 'C:other' }, store, workDirFor), '');
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

function recoveringEngine({ knownMediaId = false, matchingDraft = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source2draft-engine-recovery-'));
  const store = openStore(':memory:'), calls = [];
  const task = store.enqueue({ threadKey: 'local:recovery', ts: '1', version: 1, text: 'fixture', dryRun: false }).run;
  const article = { title: '数据库中的完整成稿', content: '<p>远端完整正文</p>', thumb_media_id: 'fixture-cover' };
  store.update(task.id, { status: 'running', title: '过时标题' });
  store.beginPublish(task, article, ['older-draft']);
  if (knownMediaId) store.remoteCreated(task.id, 'fixture-draft');
  const runtime = { ...config, dataDir: dir, dryRun: false,
    wechat: { appId: 'fixture-app', secret: 'fixture-secret', author: '' } };
  const wechat = createWechat(runtime, { fetchFn: async (url, request) => {
    const endpoint = new URL(url).pathname.split('/cgi-bin/')[1];
    calls.push(endpoint);
    if (endpoint === 'stable_token') return Response.json({ access_token: 'fixture-token', expires_in: 7200 });
    if (endpoint === 'draft/batchget') return Response.json({ total_count: matchingDraft ? 1 : 0,
      item: matchingDraft ? [{ media_id: 'fixture-draft', content: { news_item: [article] } }] : [] });
    if (endpoint === 'draft/get') {
      assert.equal(JSON.parse(request.body).media_id, 'fixture-draft');
      return Response.json({ news_item: [article] });
    }
    assert.fail(`Recovery must not call ${endpoint}`);
  } });
  const engine = createEngine({ config: runtime, store, wechat,
    modelFactory: () => assert.fail('Recovery must not initialize a model'),
    prepare: () => assert.fail('Recovery must not render the article') });
  const workDir = engine.workDirFor(task.id);
  fs.mkdirSync(workDir, { recursive: true });
  return { store, task, calls, engine, workDir,
    close: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

for (const knownMediaId of [false, true]) {
  for (const cache of ['missing', 'damaged']) {
    test(`draft recovery with ${knownMediaId ? 'known' : 'unknown'} media ID ignores ${cache} generation caches`, async () => {
      const f = recoveringEngine({ knownMediaId });
      try {
        if (cache === 'damaged') {
          for (const filename of ['artifact.json', 'prepared.json', 'usage.json']) {
            fs.writeFileSync(path.join(f.workDir, filename), '{invalid-json');
          }
          fs.writeFileSync(path.join(f.workDir, 'preview.html'), '<p>Existing preview</p>');
        }
        await f.engine.execute(f.store.get(f.task.id));
        const current = f.store.get(f.task.id);
        assert.equal(current.status, 'done');
        assert.equal(current.media_id, 'fixture-draft');
        assert.equal(current.title, '数据库中的完整成稿');
        assert.equal(f.engine.activeId, undefined);
        assert.deepEqual(f.calls, knownMediaId ? ['stable_token', 'draft/get'] : ['stable_token', 'draft/batchget', 'draft/get']);
        const notice = f.store.notices().find(item => item.kind === 'done');
        assert.equal(notice.text.includes('本机预览：'), cache === 'damaged');
        if (cache === 'damaged') assert.equal(fs.readFileSync(path.join(f.workDir, 'artifact.json'), 'utf8'), '{invalid-json');
      } finally { f.close(); }
    });
  }
}

test('unresolved draft recovery remains review-only across retries without generation caches', async () => {
  const f = recoveringEngine({ matchingDraft: false });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) f.store.retry(f.task.id);
      await f.engine.execute(f.store.get(f.task.id));
      assert.equal(f.store.get(f.task.id).status, 'needs_review');
      assert.equal(f.store.operation(f.task.id).state, 'requesting');
      assert.equal(f.store.operation(f.task.id).media_id, null);
    }
    assert.deepEqual(f.calls, ['stable_token', 'draft/batchget', 'draft/batchget']);
  } finally { f.close(); }
});

test('verified recovery preserves available review warnings without validating the cached article', async () => {
  const f = recoveringEngine({ knownMediaId: true });
  try {
    writeAtomic(path.join(f.workDir, 'artifact.json'), { article: 'An unusable article cache', warnings: ['请复核统计口径'] });
    await f.engine.execute(f.store.get(f.task.id));
    assert.equal(f.store.get(f.task.id).status, 'done');
    assert.match(f.store.notices().find(item => item.kind === 'done').text, /待复核：请复核统计口径/);
    assert.deepEqual(f.calls, ['stable_token', 'draft/get']);
  } finally { f.close(); }
});

test('graceful shutdown lets an existing draft recovery finish', { timeout: 3000 }, async () => {
  const f = recoveringEngine({ knownMediaId: true });
  try {
    const running = f.engine.execute(f.store.get(f.task.id));
    await Promise.all([running, f.engine.stop()]);
    assert.equal(f.store.get(f.task.id).status, 'done');
    assert.equal(f.engine.activeId, undefined);
    assert.deepEqual(f.calls, ['stable_token', 'draft/get']);
  } finally { f.close(); }
});

test('retry after a definite rejection can still create a new operation from the saved article', async () => {
  const f = recoveringEngine();
  try {
    f.store.rejectPublish(f.task.id);
    f.store.update(f.task.id, { status: 'failed' });
    f.store.retry(f.task.id);
    assert.equal(f.store.operation(f.task.id), undefined);
    writeAtomic(path.join(f.workDir, 'artifact.json'), { article: '# 已拒绝后重试\n\n完整正文。' });
    writeAtomic(path.join(f.workDir, 'prepared.json'), { title: '已拒绝后重试', html: '<p>完整正文。</p>' });
    let creates = 0;
    const engine = createEngine({ config: { ...config, dataDir: path.dirname(path.dirname(f.workDir)) }, store: f.store,
      modelFactory: () => ({}), prepare: () => assert.fail('Saved formatting should be reused'),
      wechat: { publish: async ({ run, store, prepared }) => {
        creates++;
        store.beginPublish(run, prepared, []);
        store.remoteCreated(run.id, 'retried-draft');
        return { mediaId: 'retried-draft', title: prepared.title };
      } } });
    await engine.execute(f.store.get(f.task.id));
    assert.equal(creates, 1);
    assert.equal(f.store.get(f.task.id).status, 'done');
    assert.equal(f.store.operation(f.task.id).media_id, 'retried-draft');
  } finally { f.close(); }
});

test('directory initialization failure records a failure, releases the task, and permits shutdown', { timeout: 3000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source2draft-engine-init-'));
  const store = openStore(':memory:');
  const task = store.enqueue({ threadKey: 'local:init', ts: '1', version: 1, text: 'fixture', dryRun: true }).run;
  const engine = createEngine({ config: { ...config, dataDir: dir }, store,
    modelFactory: () => assert.fail('A directory failure must happen before model initialization') });
  const mkdir = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', (directory, options) => {
    if (directory === engine.workDirFor(task.id)) throw Object.assign(new Error('fixture: task directory denied'), { code: 'EACCES' });
    return mkdir(directory, options);
  });
  t.mock.method(console, 'warn', () => {});
  try {
    await engine.tick();
    assert.equal(store.get(task.id).status, 'failed');
    assert.match(store.get(task.id).error, /task directory denied/);
    assert.equal(store.pending(), undefined);
    assert.equal(engine.activeId, undefined);
    assert.ok(store.notices().some(item => item.kind.startsWith('failed:')));
    await engine.stop();
  } finally { t.mock.restoreAll(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
