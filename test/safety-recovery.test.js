import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { prepareData, loadConfig } from '../src/config/index.js';
import { acquireInstanceLock } from '../src/lib/lock.js';
import { openStore } from '../src/core/store.js';
import { createEngine } from '../src/core/engine.js';
import { createModel } from '../src/core/model.js';
import { acquireRuntimeResource } from '../src/config/runtime.js';
import { hash } from '../src/lib/io.js';

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source2draft-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}

test('run directory symlinks are rejected before creating descendants or timing logs', async t => {
  const root = directory(t), outside = directory(t), store = openStore(':memory:'); t.after(() => store.close());
  const dataDir = path.join(root, 'runtime'); fs.mkdirSync(dataDir);
  fs.symlinkSync(outside, path.join(dataDir, 'runs'));
  const run = store.enqueue({ threadKey: 'local:safety', ts: '1', version: 1, text: '测试', dryRun: true }).run;
  const engine = createEngine({ config: { ...loadConfig({}), root, dataDir }, store,
    modelFactory: () => assert.fail('invalid task directory must stop before model creation') });
  await engine.execute(run); assert.equal(store.get(run.id).status, 'failed');
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('directory preparation and lock symlinks fail before touching external content', async t => {
  const root = directory(t), outside = directory(t);
  fs.symlinkSync(outside, path.join(root, 'linked'));
  assert.throws(() => prepareData({ root, dataDir: path.join(root, 'linked', 'new-directory') }), /符号链接/);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.mkdirSync(path.join(root, '.local'));
  const content = path.join(outside, 'unique-file'); fs.writeFileSync(content, 'user content');
  fs.symlinkSync(content, path.join(root, '.local', 'instance-lock.sqlite'));
  await assert.rejects(acquireInstanceLock(root), /符号链接/);
  assert.equal(fs.readFileSync(content, 'utf8'), 'user content');
});

test('newer database version is rejected without initialization, schema changes or lingering connection', t => {
  const root = directory(t), filename = path.join(root, 'future.sqlite');
  let db = new Database(filename); db.exec("CREATE TABLE unique_content (value TEXT); INSERT INTO unique_content VALUES ('preserve'); PRAGMA user_version=99;"); db.close();
  const before = hash(fs.readFileSync(filename));
  assert.throws(() => openStore(filename), /版本较新/);
  assert.equal(hash(fs.readFileSync(filename)), before); assert.equal(fs.existsSync(filename + '-wal'), false);
  db = new Database(filename); assert.equal(db.prepare('SELECT value FROM unique_content').get().value, 'preserve');
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), [{ name: 'unique_content' }]); db.close();
});

test('outbox excludes blocked and deferred records before applying its thirty-row limit', t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  const run = store.enqueue({ threadKey: 'C1:1', ts: '1', version: 1, text: 'test', dryRun: true }).run;
  for (let i = 0; i < 40; i++) store.notice(run, `blocked-${i}`, 'blocked');
  for (const item of store.db.prepare('SELECT id FROM notices').all()) store.blockNotice(item.id, 'needs_review');
  store.notice(run, 'delayed', 'delayed');
  const delayed = store.db.prepare("SELECT id FROM notices WHERE kind='delayed'").get(); store.deferNotice(delayed.id, Date.now() + 120000);
  store.notice(run, 'ready', 'ready'); assert.deepEqual(store.notices({ deliverable: true }).map(item => item.kind), ['ready']);
  assert.equal(store.notices().length, 30);
});

test('model total deadline stops hanging response headers and bodies and releases the model slot', async () => {
  for (const stage of ['headers', 'body']) {
    let signal;
    const model = createModel(loadConfig({ DEEPSEEK_API_KEY: 'fixture-key' }), { fetchFn: async (_url, options) => {
      signal = options.signal;
      if (stage === 'headers') return new Promise(() => {});
      return { ok: true, json: () => new Promise(() => {}) };
    } });
    await assert.rejects(model.complete({ prompt: 'fixture', timeoutMs: 20 }), error => error.code === 'MODEL_TIMEOUT');
    assert.equal(signal.aborted, true);
  }
  const release = await acquireRuntimeResource('model'); release();
});

test('the bounded JSON correction shares the original total deadline', async () => {
  let calls = 0;
  const model = createModel(loadConfig({ DEEPSEEK_API_KEY: 'fixture-key' }), { fetchFn: async () => {
    calls++; if (calls > 1) return new Promise(() => {});
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] });
  } });
  const started = performance.now();
  await assert.rejects(model.json({ prompt: 'fixture', timeoutMs: 25, validate: value => value.ok === true }), error => error.code === 'MODEL_TIMEOUT');
  assert.equal(calls, 2); assert.ok(performance.now() - started < 250);
});

test('JSON validation cannot start another model request after the original deadline has expired', async () => {
  let calls = 0;
  const model = createModel(loadConfig({ DEEPSEEK_API_KEY: 'fixture-key' }), { fetchFn: async () => {
    calls++; return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] });
  } });
  await assert.rejects(model.json({ prompt: 'fixture', timeoutMs: 10, validate: () => {
    const until = performance.now() + 15; while (performance.now() < until) { /* Deterministic CPU-bound validation delay. */ }
    return false;
  } }), error => error.code === 'MODEL_TIMEOUT');
  assert.equal(calls, 1);
});
