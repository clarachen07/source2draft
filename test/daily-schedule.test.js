import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openStore } from '../src/core/store.js';
import { createDailyScheduler, latestDueDailyIssue, nextDailyTime } from '../src/triggers/daily.js';

const config = enabledAt => ({ dryRun: false, daily: { enabled: true, enabledAt, catchupHours: 24 } });

test('fixed PST boundaries use UTC-8 in summer, winter, and either side of US daylight-saving changes', () => {
  for (const date of ['2026-01-10', '2026-07-10', '2026-03-08', '2026-11-01']) {
    const before = Date.parse(`${date}T00:59:59Z`), due = Date.parse(`${date}T01:00:00Z`);
    assert.equal(nextDailyTime(before), due);
    assert.equal(latestDueDailyIssue(due).scheduledAt, due);
    assert.equal(nextDailyTime(due), due + 86400000);
    assert.equal(latestDueDailyIssue(due).issueDate, new Date(due - 8 * 3600000).toISOString().slice(0, 10));
  }
});

test('first enable starts at next 17:00 and repeated ticks cannot create duplicates', () => {
  const store = openStore(':memory:');
  let at = Date.parse('2026-10-03T00:00:00Z');
  const scheduler = createDailyScheduler({ config: config(), store, now: () => at });
  try {
    scheduler.tick(); assert.equal(store.dailyIssues().length, 0);
    at = Date.parse('2026-10-03T01:00:00Z');
    const run = scheduler.tick().run;
    assert.ok(run); assert.equal(JSON.parse(run.context_json).cutoffAt, null);
    assert.equal(JSON.parse(run.context_json).issueDate, '2026-10-02');
    for (let count = 0; count < 10; count++) scheduler.tick();
    assert.equal(store.dailyIssues().length, 1);
    assert.equal(scheduler.status().schedule, '17:00 UTC-08:00');
    assert.equal(scheduler.status().issues[0].task.id, run.id);
    assert.equal(scheduler.status().issues[0].task.status, 'queued');
    assert.equal(scheduler.status().issues[0].task.dryRun, false);
    store.beginNoticeRoot({ threadKey: run.thread_key, channel: 'C1', marker: 'fixture-root' });
    store.failNoticeRoot(run.thread_key, { error: 'fixture lost response' });
    assert.equal(scheduler.status().issues[0].notification.state, 'needs_review');
  } finally { store.close(); }
});

test('first enable exactly at a boundary does not replay that already-due issue', () => {
  const store = openStore(':memory:');
  const at = Date.parse('2026-10-03T01:00:00Z');
  try {
    createDailyScheduler({ config: config(), store, now: () => at }).tick();
    assert.equal(store.dailyIssues().length, 0);
    createDailyScheduler({ config: config('2026-10-03T01:00:00Z'), store, now: () => at }).tick();
    assert.equal(store.dailyIssues().length, 1);
  } finally { store.close(); }
});

test('restart catches up only the most recent due issue and preserves the first-enable anchor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source2draft-daily-clock-'));
  const filename = path.join(dir, 'runs.db');
  let store = openStore(filename), at = Date.parse('2026-10-03T00:00:00Z');
  try {
    createDailyScheduler({ config: config(), store, now: () => at }).tick();
    store.close(); store = openStore(filename);
    at = Date.parse('2026-10-06T20:00:00Z');
    const scheduler = createDailyScheduler({ config: config(), store, now: () => at });
    const catchup = scheduler.tick();
    assert.equal(catchup.issue.issueDate, '2026-10-05');
    assert.equal(JSON.parse(catchup.run.context_json).isCatchup, true);
    assert.equal(store.dailyIssues().length, 1);
    assert.equal(scheduler.tick().duplicate, true);
    const status = scheduler.status();
    assert.equal(status.skippedCount, 3);
    assert.equal(status.missing.length, 3);
    assert.ok(status.missing.every(issue => issue.state === 'skipped_expired'));
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('disabled scheduler creates no issue and reenabling establishes a fresh first-run boundary', () => {
  const store = openStore(':memory:');
  let at = Date.parse('2026-10-03T20:00:00Z');
  try {
    createDailyScheduler({ config: { daily: { enabled: false } }, store, now: () => at }).tick();
    const scheduler = createDailyScheduler({ config: config(), store, now: () => at });
    scheduler.tick(); assert.equal(store.dailyIssues().length, 0);
    at = Date.parse('2026-10-04T01:00:00Z');
    assert.equal(scheduler.tick().issue.issueDate, '2026-10-03');
  } finally { store.close(); }
});

test('scheduler requeues only explicit transient failures before remote dispatch', () => {
  const store = openStore(':memory:');
  let at = Date.parse('2026-10-03T01:00:00Z');
  const scheduler = createDailyScheduler({ config: config('2026-10-03T01:00:00Z'), store, now: () => at });
  try {
    const run = scheduler.tick().run;
    store.update(run.id, { status: 'failed', retryable: 1, error_code: 'MODEL_TRANSIENT' });
    at += 1000; scheduler.tick();
    assert.equal(store.get(run.id).status, 'queued');
    assert.equal(store.get(run.id).ready_at, at + 60000);
    assert.equal(store.dailyIssueForRun(run.id).retryCount, 1);
    store.update(run.id, { status: 'failed', retryable: 0, error_code: 'FACT_AUDIT' });
    scheduler.tick(); assert.equal(store.get(run.id).status, 'failed');
  } finally { store.close(); }
});

test('reenabling and the next issue boundary cannot retry a prior issue', () => {
  const store = openStore(':memory:');
  let at = Date.parse('2026-10-03T01:00:00Z');
  try {
    const old = createDailyScheduler({ config: config('2026-10-03T01:00:00Z'), store, now: () => at }).tick().run;
    store.update(old.id, { status: 'failed', retryable: 1, error_code: 'MODEL_TRANSIENT' });
    at = Date.parse('2026-10-03T20:00:00Z');
    createDailyScheduler({ config: { daily: { enabled: false } }, store, now: () => at }).tick();
    const reenabled = createDailyScheduler({ config: config(), store, now: () => at });
    reenabled.tick();
    assert.equal(store.get(old.id).status, 'failed');
    assert.equal(store.dailyIssueForRun(old.id).retryCount, 0);
    assert.equal(store.isDailyRetryPending(old.id, at), false);
    at = Date.parse('2026-10-04T01:00:00Z');
    const latest = reenabled.tick().run;
    assert.equal(JSON.parse(latest.context_json).issueDate, '2026-10-03');
    assert.equal(store.get(old.id).status, 'failed');
    assert.equal(store.dailyIssueForRun(old.id).retryCount, 0);
    // An original enable anchor also cannot revive the previous issue when it
    // reaches exactly 24 hours old at the new 17:00 boundary.
    createDailyScheduler({ config: config('2026-10-03T01:00:00Z'), store, now: () => at }).tick();
    assert.equal(store.get(old.id).status, 'failed');
    assert.equal(store.dailyIssueForRun(old.id).retryCount, 0);
    assert.equal(store.isDailyRetryPending(old.id, at), false);
  } finally { store.close(); }
});

test('status shows current local quotas, observed Firecrawl billing and bounded credential-free audit', () => {
  const store = openStore(':memory:');
  const at = Date.parse('2026-10-03T01:00:00Z');
  const runtime = { daily: { enabled: false, providers: {
    exa: { apiKey: 'fixture-exa-key', freeConfirmed: true, periodLimit: 20 },
    tavily: { apiKey: 'fixture-tavily-key', freeConfirmed: false, periodLimit: 9 },
    firecrawl: { apiKey: 'fixture-firecrawl-key', freeConfirmed: true, periodLimit: 9 },
    openalex: { periodLimit: 90 }, github: { apiKey: 'fixture-github-key', periodLimit: 20 },
  } } };
  const reserve = (provider, period, units, limit) => store.reserveProviderBudget({ provider, period, units, limit });
  try {
    reserve('exa', '2026-09', 18, 20); reserve('exa', '2026-10', 6, 20);
    reserve('tavily', '2026-10', 2, 9);
    reserve('firecrawl', 'billing:2026-09-15T00:00:00.000Z', 3, 9);
    reserve('firecrawl', '2026-10-03', 0, 9);
    reserve('openalex', '2026-10-03', 1, 9);
    reserve('github', '2026-10-03T00', 19, 20); reserve('github', '2026-10-03T01', 7, 20);
    reserve('arxiv', '2026-10-03', 2, 150);
    for (let index = 0; index < 25; index++) reserve('exa', '2026-10', 0, 20);
    reserve('exa', '2026-10', 30, 20);
    const status = createDailyScheduler({ config: runtime, store, now: () => at }).status();
    const quota = Object.fromEntries(status.quotas.map(value => [value.provider, value]));
    assert.deepEqual([quota.exa.period, quota.exa.used, quota.exa.limit, quota.exa.remaining, quota.exa.unit],
      ['2026-10', 6, 20, 14, 'cents']);
    assert.equal(quota.exa.enabled, true); assert.equal(quota.exa.keyConfigured, true);
    assert.equal(quota.tavily.enabled, false); assert.equal(quota.tavily.freeConfirmed, false);
    assert.equal(quota.tavily.unit, 'credits'); assert.equal(quota.tavily.remaining, 7);
    assert.deepEqual([quota.firecrawl.period, quota.firecrawl.used, quota.firecrawl.remaining],
      ['billing:2026-09-15T00:00:00.000Z', 3, 6]);
    assert.equal(quota.openalex.capacity, 9); assert.equal(quota.openalex.remaining, 8);
    assert.equal(quota.github.period, '2026-10-03T01'); assert.equal(quota.github.remaining, 13);
    assert.equal(quota.arxiv.remaining, 148); assert.equal(quota.arxiv.unit, 'requests');
    assert.equal(status.recentReservations.length, 20);
    assert.equal(status.recentReservations[0].allowed, 0);
    assert.equal(status.recentReservations[0].used_after, 6);
    assert.equal(JSON.stringify(status).includes('fixture-'), false);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM daily_settings').get().n, 0);
  } finally { store.close(); }
});

test('status explicitly disables unconfigured providers and keeps unknown balances unknown', () => {
  const store = openStore(':memory:');
  try {
    const status = createDailyScheduler({ config: { daily: { enabled: false } }, store,
      now: () => Date.parse('2026-10-03T01:00:00Z') }).status();
    for (const provider of ['exa', 'tavily', 'firecrawl']) {
      const quota = status.quotas.find(value => value.provider === provider);
      assert.equal(quota.enabled, false); assert.equal(quota.keyConfigured, false); assert.equal(quota.freeConfirmed, false);
      assert.equal(quota.capacity, 900); assert.equal(quota.used, null); assert.equal(quota.remaining, null);
      assert.equal(quota.state, provider === 'firecrawl' ? 'billing_unconfirmed' : 'no_reservations');
    }
    assert.equal(status.quotas.find(value => value.provider === 'firecrawl').period, null);
    assert.deepEqual(status.recentReservations, []);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM provider_budgets').get().n, 0);
  } finally { store.close(); }
});

test('status remains compatible with injected stores that omit optional quota methods', () => {
  const store = { dailyScheduleSettings: () => undefined, dailyIssues: () => [], providerHealthList: () => [] };
  const status = createDailyScheduler({ config: { daily: { enabled: false } }, store,
    now: () => Date.parse('2026-10-03T01:00:00Z') }).status();
  assert.equal(status.quotas.length, 5); assert.deepEqual(status.recentReservations, []);
});

for (const version of [0, 1]) {
  test(`quota status reads schema version ${version} without migration or writes`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source2draft-daily-status-'));
    const filename = path.join(dir, 'runs.db');
    let store;
    try {
      if (version === 0) {
        const db = new Database(filename); db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY)'); db.close();
      } else {
        store = openStore(filename);
        store.reserveProviderBudget({ provider: 'exa', period: '2026-10', units: 4, limit: 900 });
        store.db.exec(`DROP TRIGGER provider_reservations_no_update;
          DROP TRIGGER provider_reservations_no_delete;
          DROP TABLE provider_reservations;
          PRAGMA user_version = 1;`);
        store.close();
      }
      store = openStore(filename, { readonly: true });
      const status = createDailyScheduler({ config: { daily: { enabled: false } }, store,
        now: () => Date.parse('2026-10-03T01:00:00Z') }).status();
      assert.equal(store.db.pragma('user_version', { simple: true }), version);
      assert.equal(status.quotas.find(value => value.provider === 'exa').used, version === 1 ? 4 : null);
      assert.deepEqual(status.recentReservations, []);
      assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='provider_reservations'").get().n, 0);
    } finally { store?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
