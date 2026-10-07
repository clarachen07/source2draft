import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openStore, DAILY_PROFILE } from '../src/core/store.js';
import { loadConfig, missingConfig, redact } from '../src/config/index.js';

const issue = (store, extra = {}) => store.enqueueDaily({ issueDate: '2026-10-02',
  scheduledAt: Date.parse('2026-10-03T01:00:00Z'), dryRun: false, ...extra }).run;
const tempStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source2draft-daily-store-'));
  const filename = path.join(dir, 'runs.db');
  return { dir, filename, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test('daily migration preserves an existing revision and runs once after reopening', () => {
  const fixture = tempStore();
  let db = new Database(fixture.filename), store;
  try {
    db.exec(`CREATE TABLE runs (
      id TEXT PRIMARY KEY,thread_key TEXT NOT NULL,revision INTEGER NOT NULL,input TEXT NOT NULL,
      attachments TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL,mode TEXT,dry_run INTEGER NOT NULL,
      created_at INTEGER NOT NULL,ready_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      title TEXT,media_id TEXT,error TEXT,result TEXT,parent_id TEXT,UNIQUE(thread_key,revision)
    )`);
    db.prepare(`INSERT INTO runs(id,thread_key,revision,input,status,dry_run,created_at,ready_at,updated_at,media_id)
      VALUES('preserved','C1:1',7,'user content','done',0,1,1,1,'known-draft')`).run();
    db.close();
    store = openStore(fixture.filename);
    assert.equal(store.db.pragma('user_version', { simple: true }), 3);
    assert.equal(store.get('preserved').input, 'user content');
    assert.equal(store.get('preserved').media_id, 'known-draft');
    assert.equal(store.get('preserved').context_json, '{}');
    const daily = issue(store); store.close();
    store = openStore(fixture.filename);
    assert.equal(store.get(daily.id).profile, DAILY_PROFILE);
    assert.equal(store.get('preserved').revision, 7);
  } finally { if (db.open) db.close(); store?.close(); fixture.close(); }
});

test('daily issue enqueue is durable and unique; preview never consumes the live issue', () => {
  const fixture = tempStore();
  let store = openStore(fixture.filename);
  try {
    const preview = issue(store, { manual: true, dryRun: true });
    assert.match(preview.thread_key, /^local:daily-preview:/);
    const initial = issue(store);
    assert.equal(initial.revision, 1);
    const duplicate = store.enqueueDaily({ issueDate: '2026-10-02', scheduledAt: '2026-10-03T01:00:00Z', dryRun: false });
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.run.id, initial.id);
    store.close(); store = openStore(fixture.filename);
    assert.equal(issue(store).id, initial.id);
    assert.equal(store.dailyIssues().length, 2);
    assert.throws(() => issue(store, { issueDate: '2026-02-30' }), /非法日报期号/);
  } finally { store.close(); fixture.close(); }
});

test('automatic simulation is unique within its namespace and cannot occupy the real issue date', () => {
  const store = openStore(':memory:');
  try {
    const simulated = issue(store, { dryRun: true });
    assert.equal(simulated.thread_key, 'local:daily-preview:2026-10-02');
    assert.equal(issue(store, { dryRun: true }).id, simulated.id);
    store.complete(simulated.id, { title: 'simulation' }, 'simulation complete');
    const real = issue(store, { dryRun: false });
    assert.notEqual(real.id, simulated.id);
    assert.equal(real.thread_key, 'daily:2026-10-02');
    assert.equal(real.dry_run, 0);
    assert.equal(real.status, 'queued');
    assert.equal(store.dailyIssues().length, 2);
  } finally { store.close(); }
});

test('status opens old databases readonly without migration, and new schemas remain readonly', () => {
  const fixture = tempStore();
  let db = new Database(fixture.filename), store;
  try {
    db.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY,revision INTEGER,status TEXT,mode TEXT,title TEXT,media_id TEXT,
      created_at INTEGER,error TEXT,dry_run INTEGER)`);
    db.prepare("INSERT INTO runs VALUES('legacy',1,'done','analysis','old','known',1,NULL,0)").run();
    db.close();
    store = openStore(fixture.filename, { readonly: true });
    assert.equal(store.list()[0].id, 'legacy');
    assert.deepEqual(store.dailyIssues(), []);
    assert.deepEqual(store.providerHealthList(), []);
    assert.deepEqual(store.providerReservations(), []);
    assert.equal(store.db.pragma('user_version', { simple: true }), 0);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='daily_issues'").get().n, 0);
    store.close(); store = undefined;
    fs.rmSync(fixture.filename);
    store = openStore(fixture.filename); issue(store); store.close();
    store = openStore(fixture.filename, { readonly: true });
    assert.equal(store.dailyIssues().length, 1);
    assert.throws(() => store.reserveProviderBudget({ provider: 'tavily', period: '2026-10', units: 1, limit: 2 }), /readonly/);
  } finally { if (db.open) db.close(); store?.close(); fixture.close(); }
});

test('manual and daily queues partition tasks without losing publishing recovery', () => {
  const store = openStore(':memory:');
  try {
    const manual = store.enqueue({ threadKey: 'C1:1', ts: '1', version: 1, text: 'translate', dryRun: true }).run;
    const daily = issue(store);
    assert.equal(store.pending('manual').id, manual.id);
    assert.equal(store.pending('daily').id, daily.id);
    store.update(daily.id, { status: 'running' }); store.beginPublish(daily, { title: 'daily' }, []);
    assert.equal(store.pending('daily').id, daily.id);
    assert.throws(() => store.pending('other'), /非法任务队列/);
    store.recover(); assert.equal(store.get(daily.id).status, 'publishing');
  } finally { store.close(); }
});

test('first worker freezes cutoff and revisions inherit evidence windows', () => {
  const store = openStore(':memory:');
  try {
    const run = issue(store, { isCatchup: true });
    assert.equal(JSON.parse(run.context_json).cutoffAt, null);
    const first = store.freezeDailyContext(run.id, '2026-10-03T06:00:00Z');
    assert.equal(first.cutoffAt, '2026-10-03T06:00:00.000Z');
    assert.equal(first.windowStart, '2026-10-02T06:00:00.000Z');
    assert.equal(first.supplementStart, '2026-09-26T06:00:00.000Z');
    assert.deepEqual(store.freezeDailyContext(run.id, '2026-10-03T12:00:00Z'), first);
    store.update(run.id, { status: 'done' });
    const next = store.enqueue({ threadKey: run.thread_key, ts: '1900000001', version: 1900000001,
      text: '请缩短', dryRun: true }).run;
    assert.equal(next.profile, DAILY_PROFILE);
    assert.deepEqual(store.freezeDailyContext(next.id, '2026-10-04T01:00:00Z'), first);
    assert.equal(store.dailyIssueForRun(run.id).runId, next.id);
    assert.throws(() => store.update(run.id, { context_json: '{}' }), /不能修改/);
  } finally { store.close(); }
});

test('cross-issue dedup only marks events after real verified completion', () => {
  const store = openStore(':memory:');
  try {
    const dry = issue(store, { dryRun: true });
    store.recordDailyEvents(dry.id, ['arxiv:1234', 'arxiv:1234']);
    store.complete(dry.id, { title: 'preview' }, 'preview');
    assert.equal(store.wasEventDelivered('arxiv:1234'), false);
    const real = issue(store, { issueDate: '2026-10-03', scheduledAt: '2026-10-04T01:00:00Z', dryRun: false });
    store.recordDailyEvents(real.id, ['arxiv:1234']);
    assert.equal(store.wasEventDelivered('arxiv:1234'), false);
    store.update(real.id, { status: 'needs_review' });
    assert.equal(store.wasEventDelivered('arxiv:1234'), false);
    store.complete(real.id, { title: 'unverified' }, 'unverified');
    assert.equal(store.wasEventDelivered('arxiv:1234'), false);
    store.complete(real.id, { title: 'verified', media_id: 'fixture-draft' }, 'verified');
    assert.equal(store.wasEventDelivered('arxiv:1234'), true);
    assert.equal(store.wasEventDelivered('arxiv:1234', real.thread_key), false);
    assert.equal(store.wasEventDelivered('arxiv:1234', 'daily:2026-10-04'), true);
  } finally { store.close(); }
});

test('free budgets persist conservative reservations, share across callers, and separate periods', () => {
  const fixture = tempStore();
  let store = openStore(fixture.filename);
  const reserve = overrides => store.reserveProviderBudget({ provider: 'tavily', period: '2026-10', units: 1, limit: 2, ...overrides });
  try {
    assert.deepEqual(reserve(), { allowed: true, used: 1, remaining: 1, limit: 2 });
    assert.equal(reserve().allowed, true);
    assert.deepEqual(reserve(), { allowed: false, used: 2, remaining: 0, limit: 2 });
    store.close(); store = openStore(fixture.filename);
    assert.equal(reserve().allowed, false);
    assert.equal(reserve({ period: '2026-11' }).used, 1);
    assert.equal(reserve({ units: 0 }).used, 2);
    const reservations = store.providerReservations();
    assert.equal(reservations.length, 6);
    assert.deepEqual(reservations.map(row => [row.period, row.units, row.allowed, row.used_after]),
      [['2026-10', 0, 1, 2], ['2026-11', 1, 1, 1], ['2026-10', 1, 0, 2],
        ['2026-10', 1, 0, 2], ['2026-10', 1, 1, 2], ['2026-10', 1, 1, 1]]);
    assert.ok(reservations.every(row => Number.isFinite(row.reserved_at) && row.limit_units === 2));
    assert.throws(() => store.db.prepare('UPDATE provider_reservations SET units=0 WHERE id=?').run(reservations[0].id), /append-only/);
    assert.throws(() => store.db.prepare('DELETE FROM provider_reservations WHERE id=?').run(reservations[0].id), /append-only/);
    assert.throws(() => store.providerReservations(101), /非法供应商额度审计范围/);
    assert.throws(() => reserve({ units: -1 }), /非法供应商预算/);
    assert.throws(() => reserve({ units: 0.1 }), /非法供应商预算/);
    store.providerHealth('tavily', { state: 'quota_exhausted', remaining: 0 });
    assert.equal(store.providerHealth('tavily').state, 'quota_exhausted');
    assert.equal(store.providerHealthList()[0].provider, 'tavily');
    store.providerHealth('github:microsoft/qlib', { ok: true });
    store.providerHealth('rss:openai:0', { ok: true });
    assert.equal(store.providerHealth('github:microsoft/qlib').ok, true);
    assert.equal(store.providerHealth('rss:openai:0').ok, true);
  } finally { store.close(); fixture.close(); }
});

test('version two adds request audit without changing an existing version-one quota', () => {
  const fixture = tempStore();
  let store = openStore(fixture.filename);
  try {
    store.reserveProviderBudget({ provider: 'tavily', period: '2026-10', units: 2, limit: 3 });
    // Reconstruct the previous schema, whose aggregate quota was durable but
    // which had no per-request audit table.
    store.db.exec(`DROP TRIGGER provider_reservations_no_update;
      DROP TRIGGER provider_reservations_no_delete;
      DROP TABLE provider_reservations;
      PRAGMA user_version = 1;`);
    store.close();
    store = openStore(fixture.filename, { readonly: true });
    assert.equal(store.db.pragma('user_version', { simple: true }), 1);
    assert.equal(store.providerBudgets()[0].used, 2);
    assert.deepEqual(store.providerReservations(), []);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='provider_reservations'").get().n, 0);
    store.close();
    store = openStore(fixture.filename);
    assert.equal(store.db.pragma('user_version', { simple: true }), 3);
    assert.equal(store.providerBudgets()[0].used, 2);
    assert.deepEqual(store.providerReservations(), []);
    assert.equal(store.reserveProviderBudget({ provider: 'tavily', period: '2026-10', units: 1, limit: 3 }).used, 3);
    store.close(); store = openStore(fixture.filename);
    assert.equal(store.providerBudgets()[0].used, 3);
    assert.equal(store.providerReservations().length, 1);
    assert.equal(store.providerReservations()[0].used_after, 3);
  } finally { store.close(); fixture.close(); }
});

test('registered daily aliases preserve revisions and root ambiguity cannot redispatch', () => {
  const fixture = tempStore();
  let store = openStore(fixture.filename);
  try {
    const run = issue(store);
    assert.equal(store.noticeRoute(run.thread_key), null);
    assert.equal(store.resolveThreadKey('C1', '10.001'), 'C1:10.001');
    const request = { threadKey: run.thread_key, channel: 'C1', marker: 'issue-fixture-marker' };
    const initial = store.beginNoticeRoot(request);
    assert.equal(initial.started, true); assert.equal(initial.state, 'requesting');
    assert.ok(Number.isFinite(initial.started_at));
    store.failNoticeRoot(run.thread_key, { uncertain: true, error: 'response lost' });
    store.close(); store = openStore(fixture.filename);
    assert.equal(store.beginNoticeRoot(request).started, false);
    assert.equal(store.getNoticeRootState(run.thread_key).state, 'needs_review');
    store.completeNoticeRoot(run.thread_key, 'C1', '10.001');
    assert.equal(store.resolveThreadKey('C1', '10.001'), run.thread_key);
    assert.deepEqual(store.noticeRoute(run.thread_key), { channel: 'C1', thread_ts: '10.001' });
    assert.equal(store.getNoticeRootState(run.thread_key).state, 'sent');
    store.failNoticeRoot(run.thread_key, { error: 'late failure' });
    assert.equal(store.getNoticeRootState(run.thread_key).state, 'sent');
    assert.throws(() => store.registerDailyThread(run.thread_key, 'C1', '10.002'), /禁止覆盖/);
    assert.deepEqual(store.noticeRoute('C1:10.001'), { channel: 'C1', thread_ts: '10.001' });
    assert.equal(store.noticeRoute('local:preview'), null);
  } finally { store.close(); fixture.close(); }
});

test('daily retry is bounded, delays one and five minutes, and never redispatches an operation', () => {
  const store = openStore(':memory:');
  const scheduled = Date.now();
  try {
    const run = issue(store, { scheduledAt: scheduled, dryRun: false });
    store.update(run.id, { status: 'failed', error: 'temporary', error_code: 'MODEL_TRANSIENT', retryable: 1 });
    assert.equal(store.isDailyRetryPending(run.id, scheduled), true);
    assert.equal(store.retryDaily(run.id, scheduled), true);
    assert.equal(store.get(run.id).ready_at, scheduled + 60000);
    store.update(run.id, { status: 'failed', retryable: 1 });
    assert.equal(store.retryDaily(run.id, scheduled + 60000), true);
    assert.equal(store.get(run.id).ready_at, scheduled + 360000);
    store.update(run.id, { status: 'failed', retryable: 1 });
    assert.equal(store.isDailyRetryPending(run.id, scheduled + 360000), false);
    const another = issue(store, { issueDate: '2026-10-03', scheduledAt: scheduled, dryRun: false });
    store.update(another.id, { status: 'running' }); store.beginPublish(another, { title: 'fixture' }, []);
    store.update(another.id, { status: 'failed', retryable: 1 });
    assert.equal(store.retryDaily(another.id, scheduled), false);
    assert.equal(store.operation(another.id).state, 'requesting');
    const orphan = issue(store, { issueDate: '2026-10-04', scheduledAt: scheduled, dryRun: false });
    store.update(orphan.id, { status: 'failed', retryable: 1, media_id: 'known-orphan-draft' });
    assert.equal(store.retryDaily(orphan.id, scheduled), false);
  } finally { store.close(); }
});

test('daily config allows anonymous data sources and unavailable Slack, retains manual requirements, and redacts new keys', () => {
  const config = loadConfig({ DAILY_ENABLED: 'true', DEEPSEEK_API_KEY: 'fixture-model', HUB_DRY_RUN: 'false',
    WECHAT_APP_ID: 'fixture-app', WECHAT_APP_SECRET: 'fixture-wechat', TAVILY_API_KEY: 'fixture-tavily',
    FIRECRAWL_API_KEY: 'fixture-firecrawl', OPENALEX_API_KEY: 'fixture-openalex', GITHUB_TOKEN: 'fixture-github' });
  assert.deepEqual(missingConfig(config), []);
  assert.equal(config.daily.providers.exa.freeConfirmed, false);
  assert.equal(config.daily.providers.firecrawl.periodLimit, 900);
  assert.equal(config.daily.limits.maxQueries, 12);
  assert.ok(missingConfig(config, { daily: false }).includes('EXA_API_KEY'));
  assert.ok(missingConfig(config, { daily: false }).includes('SLACK_BOT_TOKEN'));
  assert.equal(redact('fixture-tavily fixture-firecrawl fixture-openalex fixture-github', config), '[REDACTED] [REDACTED] [REDACTED] [REDACTED]');
  assert.throws(() => loadConfig({ DAILY_ENABLED_AT: '2026-10-02T17:00:00' }), /含时区/);
  for (const date of ['2026-02-30T17:00:00Z', '2026-02-29T17:00:00-08:00', '2026-10-02T24:00:00Z']) {
    assert.throws(() => loadConfig({ DAILY_ENABLED_AT: date }), /有效 ISO/);
  }
  assert.equal(loadConfig({ DAILY_ENABLED_AT: '2028-02-29T17:00:00-08:00' }).daily.enabledAt, '2028-02-29T17:00:00-08:00');
  assert.throws(() => loadConfig({ DAILY_TAVILY_MONTHLY_CREDITS: '1001' }), /必须为/);
});
