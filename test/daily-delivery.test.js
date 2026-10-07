import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openStore } from '../src/core/store.js';
import { loadConfig } from '../src/config/index.js';
import { createSlack } from '../src/triggers/slack.js';

function fixture(overrides = {}) {
  const store = openStore(':memory:');
  const config = loadConfig({ DEEPSEEK_API_KEY: 'fixture-model', SLACK_BOT_TOKEN: 'fixture-bot',
    SLACK_APP_TOKEN: 'fixture-app', SLACK_TEAM_ID: 'T1', SLACK_USER_ID: 'U1', SLACK_CHANNEL_ID: 'C1', SLACK_EDIT_DEBOUNCE_MS: '0' });
  const events = [], writes = [], reads = [], logs = [];
  let clock = Date.now(), initFails = false;
  const app = { receiver: { client: new EventEmitter() },
    client: { auth: { test: async () => ({ team_id: 'T1', user_id: 'UBOT', bot_id: 'B1' }) },
      conversations: { info: async () => ({ channel: { is_member: true, is_private: false, is_archived: false, name: 'general' } }),
        members: async () => ({ members: ['U1'] }), history: async args => { reads.push(args); return { messages: [], has_more: false }; } },
      chat: { postMessage: async args => { writes.push(args); return { ts: String(Date.now() / 1000), channel: 'C1' }; } } },
    init: async () => { events.push('init'); if (initFails) throw new Error('fixture-bot offline'); },
    start: async () => { events.push('start'); }, stop: async () => { events.push('stop'); },
    message() {}, event() {}, error() {},
  };
  Object.assign(app.client, overrides.client || {});
  const factory = options => { events.push(options); return app; };
  const create = () => createSlack({ config, store, engine: { abort() {} }, appFactory: factory,
    now: () => clock, sleep: async () => {}, log: text => logs.push(text) });
  function daily() {
    const run = store.enqueueDaily({ issueDate: '2026-10-02', scheduledAt: Date.now(), dryRun: false, manual: true }).run;
    store.update(run.id, { status: 'done', media_id: 'fixture-draft' });
    store.notice(run, 'accepted', 'accepted'); store.notice(run, 'progress:search', 'searching'); store.notice(run, 'done', '日报已创建');
    return run;
  }
  return { config, store, app, events, writes, reads, logs, create, daily,
    offline: value => { initFails = value; }, advance: ms => { clock += ms; } };
}

test('ordinary thread rate limits persist a delay and do not retry before Retry-After across client restart', async () => {
  const f = fixture(); let attempts = 0;
  f.app.client.chat.postMessage = async () => {
    attempts++; if (attempts === 1) throw Object.assign(new Error('rate limited'), { retryAfter: 120 });
    return { channel: 'C1', ts: '123' };
  };
  const run = f.store.enqueue({ threadKey: 'C1:100', ts: '100', text: 'test', version: 1, dryRun: true }).run;
  f.store.update(run.id, { status: 'done' }); f.store.notice(run, 'done', '完成');
  let slack = await f.create();
  try {
    await slack.tick(); await slack.flush(); assert.equal(attempts, 1);
    const pending = f.store.notices()[0]; assert.ok(pending.due_at > Date.now() + 110000);
    await slack.stop(); slack = await f.create(); f.advance(30000); await slack.tick(); await slack.flush(); assert.equal(attempts, 1);
    f.advance(90001); await slack.tick(); await slack.flush(); assert.equal(attempts, 2); assert.equal(f.store.notices().length, 0);
  } finally { await slack.stop(); f.store.close(); }
});

test('Slack defers initialization, disables SDK write retries, and reconnects after identity verification', async () => {
  const f = fixture(); const slack = await f.create();
  try {
    assert.equal(f.events.length, 0); assert.equal(slack.connected, false);
    f.offline(true); await slack.tick();
    assert.equal(slack.connected, false); assert.equal(f.writes.length, 0);
    assert.ok(f.logs.some(text => text.includes('[REDACTED]')));
    const options = f.events[0];
    assert.equal(options.deferInitialization, true);
    assert.deepEqual(options.clientOptions.retryConfig, { retries: 0 });
    assert.equal(options.clientOptions.rejectRateLimitedCalls, true);
    f.offline(false); await slack.tick(); assert.equal(slack.connected, false);
    f.advance(5001); await slack.tick(); assert.equal(slack.connected, true);
    f.app.receiver.client.emit('disconnected'); assert.equal(slack.connected, false);
    await slack.tick(); assert.equal(slack.connected, true);
  } finally { await slack.stop(); f.store.close(); }
});

test('daily terminal root persists before dispatch, saves ts immediately, and suppresses progress', async () => {
  const f = fixture(), run = f.daily();
  const post = f.app.client.chat.postMessage;
  f.app.client.chat.postMessage = async args => {
    const operation = f.store.getNoticeRootState(run.thread_key);
    assert.equal(operation.state, 'requesting'); assert.ok(args.text.includes(operation.marker));
    assert.equal(args.thread_ts, undefined); return post(args);
  };
  const slack = await f.create();
  try {
    await slack.tick(); await slack.flush();
    assert.equal(f.writes.length, 1); assert.match(f.writes[0].text, /日报已创建/);
    const root = f.store.getNoticeRootState(run.thread_key);
    assert.equal(root.state, 'sent'); assert.equal(f.store.noticeRoute(run.thread_key).thread_ts, root.ts);
    assert.equal(f.store.notices().length, 0);
    await slack.flush(); assert.equal(f.writes.length, 1);
  } finally { await slack.stop(); f.store.close(); }
});

test('lost root response recovers only its bot marker and never dispatches a second request', async () => {
  const f = fixture(), run = f.daily(); let delivered;
  f.app.client.chat.postMessage = async args => { f.writes.push(args); delivered = args; throw new Error('lost response'); };
  f.app.client.conversations.history = async args => {
    f.reads.push(args);
    return { has_more: false, messages: [
      { ts: '123.1', user: 'U1', bot_id: 'B1', text: delivered.text },
      { ts: '123.2', user: 'UBOT', bot_id: 'B2', text: delivered.text },
      { ts: '123.3', user: 'UBOT', bot_id: 'B1', thread_ts: '100.1', text: delivered.text },
      { ts: '123.4', user: 'UBOT', bot_id: 'B1', text: delivered.text },
    ] };
  };
  const slack = await f.create();
  try {
    await slack.tick(); await slack.flush(); await slack.flush();
    assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 1);
    assert.equal(f.reads[0].channel, 'C1'); assert.equal(f.reads[0].limit, 100);
    assert.ok(Number(f.reads[0].latest) - Number(f.reads[0].oldest) <= 660);
    assert.equal(f.store.getNoticeRootState(run.thread_key).state, 'sent');
    assert.equal(f.store.noticeRoute(run.thread_key).thread_ts, '123.4');
    assert.equal(f.store.get(run.id).status, 'done');
  } finally { await slack.stop(); f.store.close(); }
});

test('ambiguous root recovery remains needs_review and preserves an accepted draft', async () => {
  const f = fixture(), run = f.daily(); let delivered;
  f.app.client.chat.postMessage = async args => { f.writes.push(args); delivered = args; throw new Error('lost response'); };
  f.app.client.conversations.history = async args => {
    f.reads.push(args); return { has_more: false, messages: ['123.1', '123.2'].map(ts => ({ ts, user: 'UBOT', bot_id: 'B1', text: delivered.text })) };
  };
  const slack = await f.create();
  try {
    await slack.tick(); await slack.flush();
    assert.equal(f.store.getNoticeRootState(run.thread_key).state, 'needs_review');
    assert.equal(f.store.noticeRoute(run.thread_key), null);
    f.advance(300001); await slack.flush();
    assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 1);
    assert.equal(f.store.get(run.id).status, 'done'); assert.equal(f.store.get(run.id).media_id, 'fixture-draft');
    assert.equal(f.store.notices().length, 1);
  } finally { await slack.stop(); f.store.close(); }
});

test('root receipt survives an outbox acknowledgement failure without repeating a root or thread message', async () => {
  const f = fixture(), run = f.daily(), sent = f.store.sent;
  let failAck = true;
  f.store.sent = id => {
    if (f.store.notices().find(item => item.id === id)?.kind === 'done' && failAck) { failAck = false; throw new Error('outbox interrupted'); }
    return sent(id);
  };
  const slack = await f.create();
  try {
    await slack.tick(); await slack.flush();
    assert.equal(f.store.getNoticeRootState(run.thread_key).state, 'sent'); assert.equal(f.store.notices().length, 1);
    await slack.flush(); assert.equal(f.writes.length, 1); assert.equal(f.store.notices().length, 0);
  } finally { await slack.stop(); f.store.close(); }
});

test('registered daily roots accept only personal thread followups and resolve to the canonical issue', async () => {
  const f = fixture(), run = f.daily(), slack = await f.create();
  try {
    await slack.tick(); await slack.flush();
    const ts = f.store.noticeRoute(run.thread_key).thread_ts;
    const event = { channel: 'C1', user: 'U1', thread_ts: ts, ts: String(Date.now() / 1000 + 1), text: '补充实验限制和代码地址' };
    for (const patch of [{ user: 'U2' }, { channel: 'C2' }, { thread_ts: '999.1' }, { bot_id: 'B1' }]) {
      await slack.receive({ ...event, ...patch }, { team_id: 'T1' });
    }
    await slack.receive(event, { team_id: 'T2' }); assert.equal(f.store.list().length, 1);
    await slack.receive(event, { team_id: 'T1' });
    const revised = f.store.latest(run.thread_key);
    assert.equal(revised.revision, 2); assert.equal(revised.thread_key, run.thread_key);
    assert.match(revised.input, /补充实验限制和代码地址/);
  } finally { await slack.stop(); f.store.close(); }
});

test('a first root created for a revised issue is not repeated when its outbox acknowledgement fails', async () => {
  const f = fixture(), initial = f.daily();
  const revised = f.store.enqueue({ threadKey: initial.thread_key, ts: String(Date.now() / 1000 + 1), version: Date.now() / 1000 + 1,
    text: '修订内容', dryRun: false }).run;
  f.store.complete(revised.id, { title: '修订日报' }, '修订完成');
  const sent = f.store.sent; let failAck = true;
  f.store.sent = id => {
    if (f.store.notices().find(item => item.id === id)?.run_id === revised.id && failAck) { failAck = false; throw new Error('outbox interrupted'); }
    return sent(id);
  };
  const slack = await f.create();
  try {
    await slack.tick(); await slack.flush(); await slack.flush();
    assert.equal(f.writes.length, 1); assert.match(f.writes[0].text, /修订完成/); assert.equal(f.store.notices().length, 0);
  } finally { await slack.stop(); f.store.close(); }
});

test('daily automatic-retry failures wait for a final outcome before the root notification', async () => {
  const f = fixture(), run = f.daily();
  f.store.update(run.id, { status: 'failed' });
  f.store.notice(run, 'failed:final', '最终失败');
  let pending = true; f.store.isDailyRetryPending = () => pending;
  const slack = await f.create();
  try {
    await slack.tick(); await slack.flush(); assert.equal(f.writes.length, 0);
    pending = false; f.advance(30001); await slack.flush(); assert.equal(f.writes.length, 1);
    assert.match(f.writes[0].text, /最终失败/);
  } finally { await slack.stop(); f.store.close(); }
});

test('failed Slack identity verification authorizes neither receiving nor notification writes', async () => {
  const f = fixture(); f.daily();
  f.app.client.auth.test = async () => ({ team_id: 'T2', user_id: 'UBOT', bot_id: 'B1' });
  const slack = await f.create();
  try { await slack.tick(); await slack.flush(); assert.equal(slack.connected, false); assert.equal(f.writes.length, 0); }
  finally { await slack.stop(); f.store.close(); }
});
