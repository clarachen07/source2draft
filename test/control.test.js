import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/core/store.js';
import { createEventHandler } from '../src/triggers/slack.js';
import { loadConfig } from '../src/config/index.js';

const config = loadConfig({ DEEPSEEK_API_KEY: 'test-only', SLACK_TEAM_ID: 'T1', SLACK_CHANNEL_ID: 'C1', SLACK_USER_ID: 'U1', SLACK_EDIT_DEBOUNCE_MS: '0' });
const message = (ts, text, extra = {}) => ({ channel: 'C1', user: 'U1', ts: String(ts), thread_ts: '100', text, ...extra });
function handler(store, aborted = []) {
  const receive = createEventHandler({ config, store, engine: { abort: id => aborted.push(id) }, botId: 'BOT', now: () => 100000 });
  return event => receive(event, { team_id: 'T1' });
}
const start = receive => receive(message(100, '<@BOT> 写文章', { thread_ts: undefined }));
const edit = (ts, text, version) => ({ channel: 'C1', subtype: 'message_changed',
  message: { user: 'U1', ts: String(ts), thread_ts: '100', text, edited: { ts: String(version) } } });

test('unchanged edits advance the watermark and equal or older versions cannot overwrite content', async () => {
  const store = openStore(':memory:');
  try {
    const receive = handler(store); await start(receive);
    await receive(edit(100, '写文章', 110));
    await receive(edit(100, '过时编辑', 105));
    await receive(edit(100, '同版本冲突', 110));
    assert.equal(store.list().length, 1);
    assert.equal(store.latest('C1:100').input, '写文章');
    assert.equal(store.db.prepare('SELECT version FROM messages').get().version, 110);
    await receive(edit(100, '最新编辑', 111));
    assert.equal(store.latest('C1:100').input, '最新编辑');
  } finally { store.close(); }
});

test('stop is deduped across delivery types and remains bound to its first revision after reopening', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-controls-'));
  const filename = path.join(directory, 'store.sqlite');
  let store = openStore(filename), aborted = [];
  try {
    let receive = handler(store, aborted); await start(receive);
    const original = store.latest('C1:100');
    await receive(message(101, '停止', { event_ts: '102' }));
    await receive(message(101, '停止', { type: 'app_mention', event_ts: '103' }));
    assert.deepEqual(aborted, [original.id]);
    assert.equal(store.get(original.id).status, 'cancelled');
    store.close(); store = openStore(filename); receive = handler(store, aborted);
    await receive(message(104, '请重新写一版'));
    const next = store.latest('C1:100');
    await receive(message(101, '停止'));
    await receive(edit(101, '取消任务', 105));
    assert.equal(store.get(next.id).status, 'queued');
    assert.doesNotMatch(next.input, /停止|取消/);
    assert.equal(store.db.prepare('SELECT run_id FROM control_messages').get().run_id, original.id);
    assert.deepEqual(aborted, [original.id]);
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('retry replay cannot retry a second failure or retry a newer revision', async () => {
  const store = openStore(':memory:');
  try {
    const receive = handler(store); await start(receive);
    const run = store.latest('C1:100'); store.update(run.id, { status: 'failed' });
    await receive(message(101, '重试'));
    assert.equal(store.get(run.id).status, 'queued');
    store.update(run.id, { status: 'failed' });
    await receive(message(101, '重试'));
    await receive(edit(101, '重试', 102));
    assert.equal(store.get(run.id).status, 'failed');
    await receive(message(103, '加上最新背景'));
    const next = store.latest('C1:100'); store.update(next.id, { status: 'failed' });
    await receive(edit(101, 'retry', 104));
    assert.equal(store.get(next.id).status, 'failed');
    await receive(message(105, '重试'));
    assert.equal(store.get(next.id).status, 'queued');
    assert.doesNotMatch(next.input, /重试|retry/);
  } finally { store.close(); }
});

test('out-of-order first delivery of a control cannot affect newer input or a later control', async () => {
  const store = openStore(':memory:');
  try {
    const receive = handler(store); await start(receive);
    await receive(edit(100, '最新要求', 110));
    const run = store.latest('C1:100');
    await receive(message(105, '停止'));
    assert.equal(store.get(run.id).status, 'queued');
    store.update(run.id, { status: 'failed' });
    await receive(message(120, '重试'));
    await receive(message(115, '停止'));
    assert.equal(store.get(run.id).status, 'queued');
  } finally { store.close(); }
});

test('rejected publishing controls are persisted and retry keeps the original remote operation', async () => {
  const store = openStore(':memory:');
  try {
    const receive = handler(store); await start(receive);
    const run = store.latest('C1:100'); store.update(run.id, { status: 'running' });
    store.beginPublish(run, { title: 'article' }, []); store.remoteCreated(run.id, 'known-media');
    await receive(message(101, '停止'));
    const saved = store.db.prepare('SELECT * FROM control_messages').get();
    assert.equal(saved.outcome, 'rejected');
    await receive(message(101, '停止'));
    assert.equal(store.get(run.id).status, 'publishing');
    store.update(run.id, { status: 'needs_review' });
    await receive(message(102, '重试'));
    assert.equal(store.get(run.id).status, 'publishing');
    assert.equal(store.operation(run.id).media_id, 'known-media');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM operations').get().n, 1);
  } finally { store.close(); }
});

test('content and control edits share their message version watermark', async () => {
  const store = openStore(':memory:');
  try {
    const receive = handler(store); await start(receive);
    await receive(message(101, '补充内容'));
    await receive(edit(101, '停止', 110));
    const run = store.latest('C1:100');
    await receive(edit(101, '旧补充内容', 105));
    assert.equal(store.latest('C1:100').id, run.id);
    assert.equal(store.latest('C1:100').status, 'cancelled');
    await receive(edit(101, '修改后的补充内容', 115));
    await receive(edit(101, '取消', 112));
    assert.equal(store.latest('C1:100').status, 'queued');
    assert.match(store.latest('C1:100').input, /修改后的补充内容/);
  } finally { store.close(); }
});

test('adding control persistence preserves an existing store and its known draft operation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-control-migration-'));
  const filename = path.join(directory, 'store.sqlite');
  let store = openStore(filename);
  try {
    const receive = handler(store); await start(receive);
    const run = store.latest('C1:100'); store.update(run.id, { status: 'running' });
    store.beginPublish(run, { title: 'existing' }, ['snapshot']); store.remoteCreated(run.id, 'existing-media');
    store.db.exec('DROP TABLE control_messages'); store.close();
    store = openStore(filename);
    assert.equal(store.latest('C1:100').id, run.id);
    assert.equal(store.operation(run.id).media_id, 'existing-media');
    assert.deepEqual(JSON.parse(store.operation(run.id).snapshot), ['snapshot']);
    store.update(run.id, { status: 'needs_review' });
    await handler(store)(message(101, '重试'));
    assert.equal(store.get(run.id).status, 'publishing');
    assert.equal(store.operation(run.id).media_id, 'existing-media');
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
