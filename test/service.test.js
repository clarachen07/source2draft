import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { startService } from '../src/index.js';

function dependencies() {
  const events = [], intervals = new Map(); let index = 0, resolveConnection;
  const connection = new Promise(resolve => { resolveConnection = resolve; });
  const store = { recover: () => events.push('recover'), close: () => events.push('store-close') };
  const engine = { tick: async () => { events.push('engine-tick'); }, stop: async () => { events.push('engine-stop'); } };
  const scheduler = { tick: () => events.push('scheduler-tick') };
  const slack = { tick: async () => { events.push('slack-connect'); await connection; },
    flush: async () => events.push('slack-flush'), stop: async () => { events.push('slack-stop'); resolveConnection(); } };
  return { events, timers: { setInterval: (fn, ms) => { const id = ++index; intervals.set(id, { fn, ms }); return id; },
    clearInterval: id => intervals.delete(id) }, intervals,
    deps: { assertConfig: (_config, options) => { assert.equal(options.slack, false); }, prepareData() {},
      acquireInstanceLock: async () => { events.push('lock'); return async () => events.push('release'); },
      openStore: () => store, createEngine: () => engine, createDailyScheduler: () => scheduler, createSlack: async () => slack } };
}
const config = { root: '/fixture', dbPath: '/fixture/runs.db', model: { key: '' }, slack: {}, wechat: {} };

test('service starts scheduler and worker while Slack connection remains unavailable', async () => {
  const f = dependencies();
  const service = await startService({ config, dependencies: f.deps, timers: f.timers, log() {} });
  try {
    await settle();
    assert.ok(f.events.includes('scheduler-tick')); assert.ok(f.events.includes('engine-tick'));
    assert.ok(f.events.indexOf('scheduler-tick') < f.events.indexOf('slack-connect'));
    assert.equal(f.events.includes('slack-flush'), false);
    service.tick(); await settle(); assert.equal(f.events.filter(event => event === 'engine-tick').length, 2);
  } finally { await service.close(); }
  assert.equal(f.intervals.size, 0); assert.equal(f.events.filter(event => event === 'release').length, 1);
  assert.ok(f.events.indexOf('slack-stop') < f.events.indexOf('store-close'));
  assert.ok(f.events.indexOf('store-close') < f.events.indexOf('release'));
  await service.close(); assert.equal(f.events.filter(event => event === 'release').length, 1);
});

test('startup failure releases the instance lock without exiting the importing process', async () => {
  const f = dependencies(); f.deps.openStore = () => { throw new Error('fixture database unavailable'); };
  await assert.rejects(startService({ config, dependencies: f.deps, timers: f.timers, log() {} }), /database unavailable/);
  assert.equal(f.events.filter(event => event === 'release').length, 1); assert.equal(f.intervals.size, 0);
});

test('an immediately closed service prevents scheduled startup callbacks from touching the store', async () => {
  const f = dependencies();
  const service = await startService({ config, dependencies: f.deps, timers: f.timers, log() {} });
  await service.close(); await settle();
  assert.equal(f.events.at(-1), 'release'); assert.equal(f.intervals.size, 0);
});
