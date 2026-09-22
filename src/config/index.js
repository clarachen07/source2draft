import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export function loadConfig(env) {
  if (!env) { dotenv.config({ path: path.join(ROOT, '.env'), quiet: true }); env = process.env; }
  const integer = (key, fallback, min, max) => {
    const value = Number(env[key] || fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 必须为 ${min}–${max} 的整数`);
    return value;
  };
  const dataDir = path.resolve(ROOT, env.DATA_DIR || 'runtime');
  if (!dataDir.startsWith(ROOT) || dataDir === ROOT.replace(/\/$/, '')) throw new Error('DATA_DIR 必须在本项目的独立子目录内');
  if (!['true', 'false', undefined, ''].includes(env.HUB_DRY_RUN)) throw new Error('HUB_DRY_RUN 必须为 true 或 false');
  const effort = env.DEEPSEEK_REASONING_EFFORT || 'high';
  if (!['low', 'high', 'max'].includes(effort)) throw new Error('DEEPSEEK_REASONING_EFFORT 必须为 low、high 或 max');
  return {
    root: ROOT, dataDir, dbPath: path.join(dataDir, 'runs.db'), dryRun: env.HUB_DRY_RUN !== 'false',
    browser: env.BROWSER_EXECUTABLE,
    model: { key: env.DEEPSEEK_API_KEY || '', effort,
      maxTokens: integer('DEEPSEEK_MAX_TOKENS', 32768, 1024, 65536),
      models: Object.fromEntries(['planner', 'writer', 'translation', 'review'].map(role =>
        [role, env[`DEEPSEEK_${role.toUpperCase()}_MODEL`] || env.DEEPSEEK_MODEL || 'deepseek-flash'])) },
    exaKey: env.EXA_API_KEY || '', datalabKey: env.DATALAB_API_KEY || '',
    slack: { botToken: env.SLACK_BOT_TOKEN || '', appToken: env.SLACK_APP_TOKEN || '',
      team: env.SLACK_TEAM_ID || '', user: env.SLACK_USER_ID || '', channel: env.SLACK_CHANNEL_ID || '',
      debounceMs: integer('SLACK_EDIT_DEBOUNCE_MS', 5000, 0, 60000) },
    wechat: { appId: env.WECHAT_APP_ID || '', secret: env.WECHAT_APP_SECRET || '', author: env.WECHAT_AUTHOR || '' },
    maxQueue: integer('MAX_QUEUE_SIZE', 100, 1, 1000),
    taskTimeout: integer('TASK_TIMEOUT_MS', 1800000, 10000, 7200000),
  };
}
export function missingConfig(config, { slack = true, wechat = !config.dryRun } = {}) {
  const required = { DEEPSEEK_API_KEY: config.model.key, EXA_API_KEY: config.exaKey, DATALAB_API_KEY: config.datalabKey };
  if (slack) Object.assign(required, { SLACK_BOT_TOKEN: config.slack.botToken, SLACK_APP_TOKEN: config.slack.appToken,
    SLACK_TEAM_ID: config.slack.team, SLACK_USER_ID: config.slack.user, SLACK_CHANNEL_ID: config.slack.channel });
  if (wechat) Object.assign(required, { WECHAT_APP_ID: config.wechat.appId, WECHAT_APP_SECRET: config.wechat.secret });
  return Object.keys(required).filter(key => !required[key]);
}
export function assertConfig(config, options) {
  const missing = missingConfig(config, options);
  if (missing.length) throw new Error(`请在本项目 .env 填写：${missing.join(', ')}`);
}
export function secretValues(config) {
  return [config.model.key, config.exaKey, config.datalabKey, config.slack.botToken,
    config.slack.appToken, config.wechat.secret].filter(Boolean);
}
export function redact(value, config) {
  let text = String(value?.message || value || '');
  for (const secret of secretValues(config)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/(access_token|appsecret|secret|token|key)=([^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/xox[baprs]-[\w-]+|xapp-[\w-]+|sk-[\w-]{12,}/g, '[REDACTED]').slice(0, 1800);
}
export function prepareData(config) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  if (!fs.realpathSync(config.dataDir).startsWith(fs.realpathSync(config.root) + path.sep)) throw new Error('运行目录不能通过符号链接指向其他项目');
}
