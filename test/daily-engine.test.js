import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngine } from '../src/core/engine.js';
import { loadConfig } from '../src/config/index.js';
import { openStore } from '../src/core/store.js';
import { writeAtomic } from '../src/lib/io.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source2draft-daily-engine-'));
  const store = openStore(':memory:');
  const config = { ...loadConfig({}), dataDir: directory };
  const engine = createEngine({ config, store, modelFactory: () => ({}),
    prepare: async ({ markdown }) => ({ title: markdown.split('\n')[0].replace(/^# /, ''), html: '<p>正文</p>' }),
    dailyResearch: async () => ({ article: '# 日报\n\n有证据的日报正文。', eventIds: ['fixture-event'] }),
    ...overrides });
  const daily = (dryRun = true) => store.enqueueDaily({ issueDate: '2026-10-02',
    scheduledAt: Date.parse('2026-10-03T01:00:00Z'), cutoffAt: Date.now(), dryRun, manual: true }).run;
  const manual = () => {
    const run = store.enqueue({ threadKey: 'local:manual', ts: '1', version: 1, text: '手动文章', dryRun: true }).run;
    writeAtomic(path.join(engine.workDirFor(run.id), 'artifact.json'), { article: '# 手动文章\n\n完整正文。' });
    return run;
  };
  return { store, config, engine, daily, manual, close: async () => {
    await engine.stop(); store.close(); fs.rmSync(directory, { recursive: true, force: true });
  } };
}

test('a queued daily begins discovery while a manual task occupies its own lane', { timeout: 3000 }, async () => {
  const entered = deferred(), release = deferred(), discovered = deferred();
  const f = fixture({
    prepare: async ({ markdown }) => {
      if (markdown.startsWith('# 手动')) { entered.resolve(); await release.promise; }
      return { title: '完成', html: '<p>正文</p>' };
    },
    dailyResearch: async () => { discovered.resolve(); return { article: '# 日报\n\n正文。', eventIds: ['event'] }; },
  });
  try {
    const manual = f.manual();
    const first = f.engine.tick();
    await entered.promise;
    const daily = f.daily();
    const second = f.engine.tick();
    await discovered.promise;
    assert.deepEqual(new Set(f.engine.activeIds), new Set([manual.id, daily.id]));
    assert.equal(f.store.get(manual.id).status, 'running');
    release.resolve();
    await Promise.all([first, second]);
    assert.equal(f.store.get(manual.id).status, 'done');
    assert.equal(f.store.get(daily.id).status, 'done');
    assert.equal(f.store.wasEventDelivered('event'), false, 'previews must not mark events as delivered');
  } finally { release.resolve(); await f.close(); }
});

test('duplicate execute calls share one task and freeze its source window once', { timeout: 3000 }, async () => {
  const entered = deferred(), release = deferred();
  let discoveries = 0;
  const f = fixture({ dailyResearch: async ({ run }) => {
    discoveries++;
    assert.ok(JSON.parse(run.context_json).cutoffAt);
    entered.resolve(); await release.promise;
    return { article: '# 日报\n\n正文。', eventIds: ['duplicate-event'] };
  } });
  try {
    const run = f.daily();
    const first = f.engine.execute(run), second = f.engine.execute(run);
    assert.equal(first, second);
    await entered.promise;
    const frozen = f.store.get(run.id).context_json;
    f.store.freezeDailyContext(run.id, Date.now() + 100000);
    assert.equal(f.store.get(run.id).context_json, frozen);
    release.resolve(); await first;
    assert.equal(discoveries, 1);
    assert.deepEqual(f.engine.activeIds, []);
  } finally { release.resolve(); await f.close(); }
});

test('cancelling daily discovery does not cancel the manual lane', { timeout: 3000 }, async () => {
  const entered = deferred(), release = deferred(), discovered = deferred();
  const f = fixture({
    prepare: async () => { entered.resolve(); await release.promise; return { title: '手动文章', html: '<p>正文</p>' }; },
    dailyResearch: async ({ signal }) => {
      discovered.resolve();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      assert.fail('Cancelled discovery cannot produce an article');
    },
  });
  try {
    const manual = f.manual(), first = f.engine.execute(manual);
    await entered.promise;
    const daily = f.daily(), second = f.engine.execute(daily);
    await discovered.promise;
    f.store.cancel(daily.id); f.engine.abort(daily.id);
    await second;
    assert.equal(f.store.get(daily.id).status, 'cancelled');
    assert.equal(f.store.get(manual.id).status, 'running');
    release.resolve(); await first;
    assert.equal(f.store.get(manual.id).status, 'done');
  } finally { release.resolve(); await f.close(); }
});

test('daily factual review failure never reaches rendering or draft creation', async () => {
  const f = fixture({
    dailyResearch: async () => { const error = new Error('关键结果缺少原文支持'); error.needsReview = true; throw error; },
    prepare: () => assert.fail('Failed review cannot render'),
    wechat: { publish: () => assert.fail('Failed review cannot write a draft') },
  });
  try {
    const run = f.daily(false); await f.engine.execute(run);
    const result = f.store.get(run.id);
    assert.equal(result.status, 'needs_review');
    assert.equal(result.retryable, 0);
    assert.equal(f.store.operation(run.id), undefined);
  } finally { await f.close(); }
});

test('transient daily errors preserve a retryable code without permitting ambiguous writes', async () => {
  const f = fixture({ dailyResearch: async () => {
    const error = new Error('临时模型不可用'); error.code = 'MODEL_TRANSIENT'; error.retryable = true; throw error;
  } });
  try {
    const run = f.daily(); await f.engine.execute(run);
    assert.equal(f.store.get(run.id).status, 'failed');
    assert.equal(f.store.get(run.id).retryable, 1);
    assert.equal(f.store.get(run.id).error_code, 'MODEL_TRANSIENT');
  } finally { await f.close(); }
});

test('daily events are marked delivered only after a verified live draft', async () => {
  const f = fixture({ wechat: { publish: async ({ run, store, prepared }) => {
    store.beginPublish(run, prepared, []); store.remoteCreated(run.id, 'fixture-live-daily');
    return { mediaId: 'fixture-live-daily', title: prepared.title };
  } } });
  try {
    const run = f.daily(false); await f.engine.execute(run);
    assert.equal(f.store.get(run.id).status, 'done');
    assert.equal(f.store.get(run.id).media_id, 'fixture-live-daily');
    assert.equal(f.store.wasEventDelivered('fixture-event'), true);
  } finally { await f.close(); }
});

test('a cancellation between lane claim and worker start cannot revive its task', async () => {
  const f = fixture({ dailyResearch: () => assert.fail('Cancelled task cannot discover sources') });
  try {
    const run = f.daily();
    const execution = f.engine.execute(run);
    f.store.cancel(run.id); f.engine.abort(run.id);
    await execution;
    assert.equal(f.store.get(run.id).status, 'cancelled');
    assert.deepEqual(f.engine.activeIds, []);
  } finally { await f.close(); }
});

test('stopping immediately after claim preserves queued work for recovery', async () => {
  const f = fixture({ dailyResearch: () => assert.fail('Stopped task cannot discover sources') });
  try {
    const run = f.daily();
    const execution = f.engine.execute(run);
    await Promise.all([execution, f.engine.stop()]);
    assert.equal(f.store.get(run.id).status, 'queued');
  } finally { await f.close(); }
});

test('an existing daily draft operation can recover even with damaged scheduling context', async () => {
  const f = fixture({
    dailyResearch: () => assert.fail('Recovery must not research'),
    prepare: () => assert.fail('Recovery must not render'),
    modelFactory: () => assert.fail('Recovery must not initialize a model'),
    wechat: { publish: async ({ run, store }) => {
      assert.equal(store.operation(run.id).media_id, 'known-daily-draft');
      return { mediaId: 'known-daily-draft', title: '已创建日报' };
    } },
  });
  try {
    const run = f.daily(false);
    f.store.update(run.id, { status: 'running' });
    f.store.beginPublish(run, { title: '已创建日报', content: '<p>完整成稿</p>' }, []);
    f.store.remoteCreated(run.id, 'known-daily-draft');
    f.store.db.prepare('UPDATE runs SET context_json=? WHERE id=?').run('{invalid', run.id);
    await f.engine.execute(f.store.get(run.id));
    assert.equal(f.store.get(run.id).status, 'done');
    assert.equal(f.store.get(run.id).media_id, 'known-daily-draft');
  } finally { await f.close(); }
});
