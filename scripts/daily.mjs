import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, assertConfig, prepareData, redact } from '../src/config/index.js';
import { acquireInstanceLock } from '../src/lib/lock.js';
import { writeAtomic } from '../src/lib/io.js';
import { openStore } from '../src/core/store.js';
import { createEngine } from '../src/core/engine.js';
import { createDailyScheduler, latestDueDailyIssue, nextDailyTime } from '../src/triggers/daily.js';

export function updateDailyEnvironment(root, fields) {
  const filename = path.join(fs.realpathSync(root), '.env');
  if (!fs.existsSync(filename)) throw new Error('请先运行 npm run setup，准备本项目的 .env');
  if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('本项目 .env 不能是指向其他文件的符号链接');
  const entries = Object.entries(fields);
  if (entries.some(([name, value]) => !['DAILY_ENABLED', 'DAILY_ENABLED_AT'].includes(name)
    || /[\r\n]/.test(String(value)))) throw new Error('非法日报配置更新');
  const names = new Set(entries.map(([name]) => name));
  const lines = fs.readFileSync(filename, 'utf8').split(/\r?\n/).filter(line => {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(line);
    return !match || !names.has(match[1]);
  });
  while (lines.at(-1) === '') lines.pop();
  writeAtomic(filename, `${[...lines, ...entries.map(([name, value]) => `${name}=${value}`)].join('\n')}\n`);
  fs.chmodSync(filename, 0o600);
}

export async function runDailyCommand({ argv = process.argv.slice(2), config = loadConfig(),
  dependencies = {}, now = () => Date.now(), output = text => console.log(text) } = {}) {
  const deps = { assertConfig, prepareData, acquireInstanceLock, openStore, createEngine,
    createDailyScheduler, latestDueDailyIssue, nextDailyTime, updateDailyEnvironment, ...dependencies };
  const [action = 'status', ...args] = argv;
  if (!['run', 'status', 'enable', 'disable'].includes(action)
    || args.some(arg => action !== 'run' || arg !== '--publish') || new Set(args).size !== args.length) {
    throw new Error('用法：npm run daily:run [-- --publish]、daily:status、daily:enable、daily:disable；run 默认仅本地预览');
  }
  let release, store, engine;
  try {
    // Mutating maintenance shares the service lock. Status opens SQLite in
    // readonly mode and never migrates or configures a running service's DB.
    if (action !== 'status') release = await deps.acquireInstanceLock(config.root);
    if (action === 'enable' || action === 'disable') {
      const enabledAt = new Date(deps.nextDailyTime(now())).toISOString();
      deps.updateDailyEnvironment(config.root, action === 'enable'
        ? { DAILY_ENABLED: 'true', DAILY_ENABLED_AT: enabledAt } : { DAILY_ENABLED: 'false' });
      const result = action === 'enable' ? { enabled: true, enabledAt, schedule: '17:00 PST (UTC-08:00), fixed offset' } : { enabled: false };
      output(JSON.stringify(result, null, 2)); return result;
    }
    if (action !== 'status') deps.prepareData(config);
    store = deps.openStore(config.dbPath, { maxQueue: config.maxQueue, readonly: action === 'status' });
    if (action === 'status') {
      const result = deps.createDailyScheduler({ config, store, now }).status();
      output(JSON.stringify(result, null, 2)); return result;
    }
    const publish = args.includes('--publish'), runtime = { ...config, dryRun: !publish };
    deps.assertConfig(runtime, { slack: false, wechat: publish, daily: true });
    const issue = deps.latestDueDailyIssue(now());
    const { run } = store.enqueueDaily({ ...issue, dryRun: !publish, manual: true });
    if (!run) throw new Error('本期日报未能入队；请检查 daily:status 中的现有任务');
    if (publish && run.dry_run) throw new Error('本期已登记为模拟日报，不能把模拟结果当作真实草稿；请先检查本期任务状态');
    if (['queued', 'running', 'publishing'].includes(run.status)) {
      engine = deps.createEngine({ config: runtime, store });
      await engine.execute(run);
    }
    const current = store.get(run.id);
    const result = { id: current.id, status: current.status, title: current.title,
      dryRun: Boolean(current.dry_run), mediaId: current.media_id || null, error: current.error || null,
      result: current.result ? JSON.parse(current.result) : null };
    output(JSON.stringify(result, null, 2));
    return result;
  } finally {
    try { await engine?.stop(); } finally { try { store?.close(); } finally { await release?.(); } }
  }
}

async function main() {
  process.umask(0o077);
  let config;
  try {
    config = loadConfig();
    const result = await runDailyCommand({ config });
    if (result.status && result.status !== 'done') process.exitCode = 1;
  } catch (error) {
    console.error(config ? redact(error, config) : String(error?.message || error)); process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
