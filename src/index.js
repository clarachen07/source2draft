import { pathToFileURL } from 'node:url';
import { loadConfig, assertConfig, prepareData, redact } from './config/index.js';
import { acquireInstanceLock } from './lib/lock.js';
import { openStore } from './core/store.js';
import { createEngine } from './core/engine.js';
import { createSlack } from './triggers/slack.js';
import { createDailyScheduler } from './triggers/daily.js';

// Importing this module does not load credentials, acquire a lock, or connect
// to accounts. Startup dependencies are injectable for offline lifecycle tests.
export async function startService({ config = loadConfig(), dependencies = {},
  log = text => console.error(text), timers = { setInterval, clearInterval } } = {}) {
  const deps = { assertConfig, prepareData, acquireInstanceLock, openStore, createEngine,
    createSlack, createDailyScheduler, ...dependencies };
  let release, store, engine, scheduler, slack, queueTimer, slackTimer, slackWork, closing = false, closingPromise;
  const report = error => log(redact(error, config));
  async function close() {
    if (closingPromise) return closingPromise;
    closing = true;
    timers.clearInterval(queueTimer); timers.clearInterval(slackTimer);
    closingPromise = (async () => {
      const results = await Promise.allSettled([engine?.stop(), slack?.stop(), slackWork]);
      for (const result of results) if (result.status === 'rejected') report(result.reason);
      try { store?.close(); } finally { await release?.(); }
    })();
    return closingPromise;
  }
  function tick() {
    if (closing) return;
    // Scheduler and workers run before Slack and do not wait for its network.
    Promise.resolve().then(() => !closing && scheduler.tick()).catch(report);
    Promise.resolve().then(() => !closing && engine.tick()).catch(report);
  }
  function tickSlack() {
    if (closing || slackWork) return slackWork;
    slackWork = Promise.resolve().then(async () => {
      if (!slack) slack = await deps.createSlack({ config, store, engine, log });
      if (closing) { await slack.stop(); return; }
      await slack.tick();
      if (!closing) await slack.flush();
    }).catch(report).finally(() => { slackWork = undefined; });
    return slackWork;
  }
  try {
    deps.assertConfig(config, { slack: false }); deps.prepareData(config);
    release = await deps.acquireInstanceLock(config.root);
    store = deps.openStore(config.dbPath, { maxQueue: config.maxQueue }); store.recover();
    engine = deps.createEngine({ config, store });
    scheduler = deps.createDailyScheduler({ config, store });
    queueTimer = timers.setInterval(tick, 500);
    slackTimer = timers.setInterval(tickSlack, 2000);
    tick(); tickSlack();
    return { config, store, engine, scheduler, get slack() { return slack; }, tick, tickSlack, close };
  } catch (error) { await close(); throw error; }
}

async function main() {
  process.umask(0o077);
  const config = loadConfig();
  let service;
  const shutdown = async () => { await service?.close(); };
  try {
    service = await startService({ config });
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    console.log(`个人内容服务已启动：${config.dryRun ? '模拟模式，不写入微信' : '公众号草稿模式'}；日报调度已独立启动，Slack 连接会自动重试。`);
  } catch (error) { console.error(redact(error, config)); await shutdown(); process.exitCode = 1; }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
