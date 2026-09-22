import { loadConfig, assertConfig, prepareData, redact } from './config/index.js';
import { acquireInstanceLock } from './lib/lock.js';
import { openStore } from './core/store.js';
import { createEngine } from './core/engine.js';
import { createSlack } from './triggers/slack.js';

process.umask(0o077);
const config = loadConfig();
let release, store, engine, slack, queueTimer, noticeTimer, closing = false;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  clearInterval(queueTimer); clearInterval(noticeTimer);
  await engine?.stop();
  await slack?.app.stop();
  // Notification deliveries already in flight may settle after app.stop; retain DB until process exits.
  await release?.();
  process.exit(code);
}
try {
  assertConfig(config); prepareData(config);
  release = await acquireInstanceLock(config.root);
  store = openStore(config.dbPath, { maxQueue: config.maxQueue }); store.recover();
  engine = createEngine({ config, store });
  slack = await createSlack({ config, store, engine });
  await slack.app.start();
  queueTimer = setInterval(() => engine.tick().catch(error => console.error(redact(error, config))), 500);
  noticeTimer = setInterval(() => slack.flush().catch(error => console.error(redact(error, config))), 2000);
  process.on('SIGINT', () => shutdown()); process.on('SIGTERM', () => shutdown());
  console.log(`个人内容服务已启动：${config.dryRun ? '模拟模式，不写入微信' : '公众号草稿模式'}，仅响应个人 #general。`);
} catch (error) {
  console.error(redact(error, config)); await shutdown(1);
}
