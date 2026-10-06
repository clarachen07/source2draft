import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/core/store.js';
import { runDailyCommand, updateDailyEnvironment } from '../scripts/daily.mjs';
import { nextDailyTime } from '../src/triggers/daily.js';

const at = Date.parse('2026-10-03T01:00:00Z');
function fixture() {
  const store = openStore(':memory:'), output = [], runtimes = [], locks = [];
  const config = { root: '/fixture', dbPath: '/fixture/runs.db', dryRun: false, model: { key: '' },
    slack: {}, wechat: {}, daily: { enabled: false } };
  const close = store.close; store.close = () => {};
  const dependencies = { prepareData() {}, assertConfig: (_config, options) => { assert.equal(options.daily, true); },
    acquireInstanceLock: async () => { locks.push('lock'); return async () => locks.push('release'); },
    openStore: () => store,
    createEngine: ({ config: runtime }) => { runtimes.push(runtime); return { execute: async run => {
      store.freezeDailyContext(run.id, at + 1000);
      store.complete(run.id, { title: 'fixture', result: JSON.stringify({ dryRun: Boolean(run.dry_run) }),
        ...(!run.dry_run ? { media_id: 'fixture-media' } : {}) }, 'fixture');
    }, stop: async () => {} }; } };
  return { store, output, runtimes, locks, config, dependencies,
    run: argv => runDailyCommand({ argv, config, dependencies, now: () => at, output: text => output.push(text) }), close };
}

test('daily CLI defaults to an isolated dry-run even when the service is configured for real drafts', async () => {
  const f = fixture();
  try {
    const first = await f.run(['run']), second = await f.run(['run']);
    assert.equal(first.dryRun, true); assert.equal(first.mediaId, null); assert.notEqual(first.id, second.id);
    assert.ok(f.runtimes.every(config => config.dryRun));
    assert.equal(f.store.latest('daily:2026-10-02'), undefined);
    assert.equal(f.store.get(first.id).thread_key.startsWith('local:daily-preview:'), true);
    assert.equal(JSON.parse(f.store.get(first.id).context_json).cutoffAt, new Date(at + 1000).toISOString());
    assert.deepEqual(f.locks, ['lock', 'release', 'lock', 'release']);
  } finally { f.close(); }
});

test('daily CLI requires the explicit publish flag and reuses a completed live issue', async () => {
  const f = fixture();
  try {
    const first = await f.run(['run', '--publish']), second = await f.run(['run', '--publish']);
    assert.equal(first.dryRun, false); assert.equal(first.mediaId, 'fixture-media'); assert.equal(first.id, second.id);
    assert.equal(f.runtimes.length, 1); assert.equal(f.store.get(first.id).thread_key, 'daily:2026-10-02');
  } finally { f.close(); }
});

test('daily status uses a readonly store and no service lock or configuration mutation', async () => {
  const f = fixture();
  f.dependencies.prepareData = () => assert.fail('status must not create a runtime directory');
  f.dependencies.acquireInstanceLock = () => assert.fail('readonly status must work while the service owns its lock');
  f.dependencies.openStore = (_filename, options) => { assert.equal(options.readonly, true); return f.store; };
  f.dependencies.createDailyScheduler = () => ({ status: () => ({ enabled: false }), tick: () => assert.fail('status cannot tick') });
  try { assert.deepEqual(await f.run(['status']), { enabled: false }); }
  finally { f.close(); }
});

test('explicit publish creates a real canonical issue after a same-date scheduled simulation', async () => {
  const f = fixture();
  try {
    const existing = f.store.enqueueDaily({ issueDate: '2026-10-02', scheduledAt: at, dryRun: true, manual: false }).run;
    f.store.complete(existing.id, { title: 'simulation' }, 'fixture');
    const published = await f.run(['run', '--publish']);
    assert.notEqual(published.id, existing.id); assert.equal(published.dryRun, false);
    assert.equal(published.mediaId, 'fixture-media'); assert.equal(f.runtimes.length, 1);
    assert.equal(f.store.get(published.id).thread_key, 'daily:2026-10-02');
    assert.equal(f.store.get(existing.id).media_id, null);
  } finally { f.close(); }
});

test('explicit publish rejects an unexpected existing simulation returned by the store', async () => {
  const f = fixture();
  try {
    const existing = f.store.enqueueDaily({ issueDate: '2026-10-02', scheduledAt: at, dryRun: true, manual: false }).run;
    f.store.complete(existing.id, { title: 'simulation' }, 'fixture');
    f.store.enqueueDaily = () => ({ run: f.store.get(existing.id), duplicate: true });
    await assert.rejects(f.run(['run', '--publish']), /不能把模拟结果当作真实草稿/);
    assert.equal(f.runtimes.length, 0); assert.equal(f.store.get(existing.id).media_id, null);
  } finally { f.close(); }
});

test('enable records the next fixed PST slot, preserves existing config, and writes mode 0600', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source2draft-daily-env-'));
  const filename = path.join(root, '.env'), locks = [];
  fs.writeFileSync(filename, 'DEEPSEEK_API_KEY=fixture\nDAILY_ENABLED=false\nDAILY_ENABLED=false\n# keep this comment\n', { mode: 0o644 });
  const config = { root };
  const dependencies = { acquireInstanceLock: async () => { locks.push('lock'); return async () => locks.push('release'); } };
  try {
    const result = await runDailyCommand({ argv: ['enable'], config, dependencies, now: () => at, output() {} });
    const content = fs.readFileSync(filename, 'utf8');
    assert.equal(result.enabledAt, new Date(nextDailyTime(at)).toISOString());
    assert.ok(Date.parse(result.enabledAt) > at); assert.match(content, /DAILY_ENABLED=true/);
    assert.equal(content.match(/DAILY_ENABLED=/g).length, 1); assert.match(content, /# keep this comment/);
    assert.match(content, /DEEPSEEK_API_KEY=fixture/); assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    await runDailyCommand({ argv: ['disable'], config, dependencies, now: () => at, output() {} });
    assert.match(fs.readFileSync(filename, 'utf8'), /DAILY_ENABLED=false/);
    assert.deepEqual(locks, ['lock', 'release', 'lock', 'release']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('daily env updates reject symlinks and newline injection without changing the target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source2draft-daily-env-'));
  const target = path.join(root, 'original.env'); fs.writeFileSync(target, 'fixture=retained\n');
  try {
    fs.symlinkSync(target, path.join(root, '.env'));
    assert.throws(() => updateDailyEnvironment(root, { DAILY_ENABLED: 'true' }), /符号链接/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'fixture=retained\n');
    fs.unlinkSync(path.join(root, '.env')); fs.writeFileSync(path.join(root, '.env'), 'fixture=retained\n');
    assert.throws(() => updateDailyEnvironment(root, { DAILY_ENABLED: 'true\nUNRELATED=value' }), /非法/);
    assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'fixture=retained\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
