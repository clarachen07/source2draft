import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/core/store.js';
import { createEventHandler } from '../src/triggers/slack.js';
import { createModel } from '../src/core/model.js';
import { loadConfig, redact } from '../src/config/index.js';
import { routeMode, chooseTranslationSource, createEngine } from '../src/core/engine.js';
import { acquireInstanceLock } from '../src/lib/lock.js';
import { renderCitations } from '../src/workflows/analysis.js';
import { writeAtomic } from '../src/lib/io.js';

const config = () => loadConfig({ DEEPSEEK_API_KEY: 'test-secret', SLACK_TEAM_ID: 'T1', SLACK_USER_ID: 'U1', SLACK_CHANNEL_ID: 'C1', SLACK_EDIT_DEBOUNCE_MS: '0' });
const enqueue = (store, overrides = {}) => store.enqueue({ threadKey: 'C1:1', ts: '1', text: '分析主题', version: 1, dryRun: true, ...overrides });

test('persistent revisions dedupe duplicate delivery and stale edits; completed revision creates a new draft task', () => {
  const store = openStore(':memory:');
  try {
    const a = enqueue(store).run;
    assert.equal(enqueue(store).duplicate, true);
    store.update(a.id, { status: 'running' });
    const b = enqueue(store, { text: '新的指令', version: 2 }).run;
    assert.equal(store.get(a.id).status, 'superseded');
    assert.equal(b.revision, 2);
    assert.equal(enqueue(store, { text: '过时编辑', version: 1.5 }).duplicate, true);
    store.update(b.id, { status: 'done', media_id: 'old-media' });
    const c = enqueue(store, { ts: '3', text: '压缩到 1000 字', version: 3 }).run;
    assert.equal(c.revision, 3);
    assert.match(c.input, /新的指令[\s\S]*压缩/);
    assert.equal(store.get(b.id).media_id, 'old-media');
  } finally { store.close(); }
});

test('publishing revision is immutable; retry reconciles instead of creating another operation', () => {
  const store = openStore(':memory:');
  try {
    const a = enqueue(store).run;
    store.update(a.id, { status: 'running' }); store.beginPublish(a, { title: 'a' }, []);
    assert.equal(enqueue(store, { text: 'new', version: 2 }).busy, true);
    assert.throws(() => store.cancel(a.id), /暂不能取消/);
    store.remoteCreated(a.id, 'media'); store.update(a.id, { status: 'needs_review' }); store.retry(a.id);
    assert.equal(store.get(a.id).status, 'publishing'); assert.equal(store.operation(a.id).media_id, 'media');
  } finally { store.close(); }
});

test('restart recovers only previously queued tasks; terminal notice persists across reopening', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-store-')), db = path.join(dir, 'runs.db');
  let store = openStore(db);
  try {
    const run = enqueue(store).run; store.update(run.id, { status: 'running' }); store.close();
    store = openStore(db); store.recover(); assert.equal(store.pending().id, run.id);
    store.complete(run.id, { title: '完成' }, '完成通知'); store.close();
    store = openStore(db); assert.equal(store.notices()[0].text, '完成通知'); assert.equal(store.get(run.id).status, 'done');
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Slack accepts only allowed user, workspace, channel, top-level mention, and task-thread followups', async () => {
  const store = openStore(':memory:'), aborted = [];
  try {
    const receive = createEventHandler({ config: config(), store, engine: { abort: id => aborted.push(id) }, botId: 'UBOT', now: () => 100000 });
    const event = { channel: 'C1', user: 'U1', ts: '100', text: '<@UBOT> 写一篇文章' };
    for (const patch of [{ user: 'U2' }, { channel: 'C2' }, { text: '普通聊天' }, { bot_id: 'B1' }, { thread_ts: '99' }]) await receive({ ...event, ...patch }, { team_id: 'T1' });
    await receive(event, { team_id: 'T2' }); assert.equal(store.list().length, 0);
    await receive(event, { team_id: 'T1' }); await receive({ ...event, type: 'app_mention' }, { team_id: 'T1' }); assert.equal(store.list().length, 1);
    await receive({ ...event, ts: '101', thread_ts: '100', text: '请加上数据来源' }, { team_id: 'T1' });
    assert.equal(store.list().length, 2); assert.equal(aborted.length, 1);
    await receive({ ...event, ts: '102', thread_ts: '100', text: '取消任务' }, { team_id: 'T1' });
    assert.equal(store.latest('C1:100').status, 'cancelled');
  } finally { store.close(); }
});

test('Slack message edits replace pending revision and offline old top-level messages are ignored', async () => {
  const store = openStore(':memory:');
  try {
    const receive = createEventHandler({ config: config(), store, engine: { abort() {} }, botId: 'UBOT', now: () => 1000000 });
    await receive({ channel: 'C1', user: 'U1', ts: '1', text: '<@UBOT> old' }, { team_id: 'T1' });
    assert.equal(store.list().length, 0);
    await receive({ channel: 'C1', user: 'U1', ts: '1000', text: '<@UBOT> original' }, { team_id: 'T1' });
    await receive({ channel: 'C1', subtype: 'message_changed', message: { user: 'U1', ts: '1000', text: 'edited', edited: { ts: '1001' } } }, { team_id: 'T1' });
    assert.equal(store.latest('C1:1000').input, 'edited');
  } finally { store.close(); }
});

test('DeepSeek uses official thinking parameters and rejects truncation before publishing', async () => {
  const calls = [];
  const model = createModel(config(), { fetchFn: async (url, request) => {
    calls.push({ url, body: JSON.parse(request.body) });
    return Response.json({ choices: [{ finish_reason: 'length', message: { content: '部分内容' } }] });
  } });
  await assert.rejects(model.complete({ prompt: 'test', responseFormat: { type: 'json_schema' } }), /未完整结束/);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.deepEqual(calls[0].body.thinking, { type: 'enabled' });
  assert.equal(calls[0].body.reasoning, undefined); assert.equal(calls[0].body.reasoning_effort, 'high');
  assert.equal(calls[0].body.response_format.type, 'json_object');
});

test('model repairs invalid JSON once, then fails closed', async () => {
  let count = 0;
  const model = createModel(config(), { fetchFn: async () => { count++; return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }); } });
  await assert.rejects(model.json({ prompt: 'return JSON', validate: o => !!o.title }), /连续两次/); assert.equal(count, 2);
});

test('translation is explicit, URLs do not route; ambiguous PDF attachments request clarification', () => {
  assert.equal(routeMode('分析 https://example.com/translate/paper'), 'analysis');
  assert.equal(routeMode('不要翻译，写分析'), 'analysis');
  assert.equal(routeMode('请翻译第 2–5 页'), 'translation');
  assert.equal(routeMode('不要翻译，写分析\n\n补充指令：\n现在请翻译全文'), 'translation');
  assert.equal(routeMode('直译这个链接\n\n补充指令：\n改成分析文章'), 'analysis');
  const files = ['a.pdf', 'b.pdf'].map((name, i) => ({ id: `F${i}`, name, mimetype: 'application/pdf', url: `https://files.slack.com/${i}.pdf` }));
  assert.throws(() => chooseTranslationSource({ input: '直译附件', attachments: JSON.stringify(files) }, config()), /文件名/);
  assert.equal(chooseTranslationSource({ input: '直译 b.pdf', attachments: JSON.stringify(files) }, config()).sourceUrl, files[1].url);
});

test('citations use actual source IDs and secrets are redacted', () => {
  assert.throws(() => renderCitations('观点[S99]', [{ id: 'S1', title: 'a' }]), /不存在/);
  assert.match(renderCitations('观点[S1]', [{ id: 'S1', title: '论文', url: 'https://example.org/paper' }]), /参考来源/);
  assert.equal(redact('test-secret access_token=secret', config()), '[REDACTED] access_token=[REDACTED]');
});

test('single instance lock rejects concurrent process ownership', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-lock-'));
  const release = await acquireInstanceLock(root);
  try {
    await assert.rejects(acquireInstanceLock(root), /已有实例/);
    await release();
    const again = await acquireInstanceLock(root); await again();
  } finally { await release(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('dry-run engine never invokes WeChat and retains complete preview result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-engine-'));
  const store = openStore(':memory:');
  try {
    const run = enqueue(store).run, runDir = path.join(dir, 'runs', run.id);
    writeAtomic(path.join(runDir, 'artifact.json'), { article: '---\ntitle: 测试\n---\n\n完整正文。', warnings: [] });
    const engine = createEngine({ config: { ...config(), dataDir: dir }, store,
      wechat: { publish: () => { throw new Error('MUST NOT CALL'); } },
      prepare: async () => ({ title: '测试', html: '<p>完整正文</p>' }),
    });
    await engine.execute(run);
    assert.equal(store.get(run.id).status, 'done'); assert.match(store.notices().at(-1).text, /未上传公众号/);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
