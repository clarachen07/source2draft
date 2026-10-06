import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import os from 'node:os';

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
  const provider = env.MODEL_PROVIDER || 'deepseek';
  if (!['deepseek', 'codex-cli'].includes(provider)) throw new Error('MODEL_PROVIDER 必须为 deepseek 或 codex-cli');
  const codexEffort = env.CODEX_REASONING_EFFORT || 'high';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(codexEffort)) throw new Error('CODEX_REASONING_EFFORT 不受支持');
  const codexModel = env.CODEX_MODEL || 'gpt-6-luna';
  if (!/^[a-z0-9][a-z0-9_.-]{0,100}$/i.test(codexModel)) throw new Error('CODEX_MODEL 必须为模型标识');
  const cliPath = env.CODEX_CLI_PATH || path.join(os.homedir(), '.local/bin/codex');
  if (!path.isAbsolute(cliPath)) throw new Error('CODEX_CLI_PATH 必须为绝对路径');
  const flag = key => {
    if (!['true', 'false', undefined, ''].includes(env[key])) throw new Error(`${key} 必须为 true 或 false`);
    return env[key] === 'true';
  };
  const enabledAt = env.DAILY_ENABLED_AT || null;
  const enabledParts = enabledAt && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(enabledAt);
  const enabledDay = enabledParts && new Date(`${enabledParts[1]}-${enabledParts[2]}-${enabledParts[3]}T00:00:00Z`);
  if (enabledAt && (!enabledParts || !Number.isFinite(Date.parse(enabledAt))
    || enabledDay.getUTCFullYear() !== Number(enabledParts[1]) || enabledDay.getUTCMonth() + 1 !== Number(enabledParts[2])
    || enabledDay.getUTCDate() !== Number(enabledParts[3]) || Number(enabledParts[4]) > 23
    || Number(enabledParts[5]) > 59 || Number(enabledParts[6]) > 59)) throw new Error('DAILY_ENABLED_AT 必须为含时区的有效 ISO 日期时间');
  const dailyProviders = {
    exa: { apiKey: env.EXA_API_KEY || '', freeConfirmed: flag('DAILY_EXA_FREE_CONFIRMED'), periodLimit: integer('DAILY_EXA_MONTHLY_CENTS', 900, 0, 1000) },
    tavily: { apiKey: env.TAVILY_API_KEY || '', freeConfirmed: flag('DAILY_TAVILY_FREE_CONFIRMED'), periodLimit: integer('DAILY_TAVILY_MONTHLY_CREDITS', 900, 0, 1000) },
    firecrawl: { apiKey: env.FIRECRAWL_API_KEY || '', freeConfirmed: flag('DAILY_FIRECRAWL_FREE_CONFIRMED'), periodLimit: integer('DAILY_FIRECRAWL_MONTHLY_CREDITS', 900, 0, 1000) },
    openalex: { apiKey: env.OPENALEX_API_KEY || '', freeConfirmed: true, periodLimit: integer('DAILY_OPENALEX_DAILY_CENTS', 90, 0, 100) },
    github: { apiKey: env.GITHUB_TOKEN || '', freeConfirmed: true, periodLimit: integer('DAILY_GITHUB_HOURLY_REQUESTS', env.GITHUB_TOKEN ? 4000 : 60, 0, env.GITHUB_TOKEN ? 5000 : 60) },
  };
  return {
    root: ROOT, dataDir, dbPath: path.join(dataDir, 'runs.db'), dryRun: env.HUB_DRY_RUN !== 'false',
    browser: env.BROWSER_EXECUTABLE,
    model: { provider, key: env.DEEPSEEK_API_KEY || '', effort: provider === 'codex-cli' ? codexEffort : effort, cliPath,
      maxTokens: integer('DEEPSEEK_MAX_TOKENS', 32768, 1024, 65536),
      models: Object.fromEntries(['planner', 'writer', 'translation', 'review'].map(role =>
        [role, provider === 'codex-cli' ? codexModel : env[`DEEPSEEK_${role.toUpperCase()}_MODEL`] || env.DEEPSEEK_MODEL || 'deepseek-flash'])) },
    exaKey: env.EXA_API_KEY || '', datalabKey: env.DATALAB_API_KEY || '',
    slack: { botToken: env.SLACK_BOT_TOKEN || '', appToken: env.SLACK_APP_TOKEN || '',
      team: env.SLACK_TEAM_ID || '', user: env.SLACK_USER_ID || '', channel: env.SLACK_CHANNEL_ID || '',
      debounceMs: integer('SLACK_EDIT_DEBOUNCE_MS', 5000, 0, 60000) },
    wechat: { appId: env.WECHAT_APP_ID || '', secret: env.WECHAT_APP_SECRET || '', author: env.WECHAT_AUTHOR || '' },
    maxQueue: integer('MAX_QUEUE_SIZE', 100, 1, 1000),
    taskTimeout: integer('TASK_TIMEOUT_MS', 1800000, 10000, 7200000),
    daily: {
      enabled: flag('DAILY_ENABLED'), enabledAt, profile: 'llm-quant-daily',
      schedule: { utcOffsetMinutes: -480, hour: 17, minute: 0 }, catchupHours: 24,
      taskTimeout: integer('DAILY_TASK_TIMEOUT_MS', 3600000, 60000, 7200000),
      exaFreeConfirmed: dailyProviders.exa.freeConfirmed, tavilyFreeConfirmed: dailyProviders.tavily.freeConfirmed,
      firecrawlFreeConfirmed: dailyProviders.firecrawl.freeConfirmed,
      tavilyKey: dailyProviders.tavily.apiKey, firecrawlKey: dailyProviders.firecrawl.apiKey,
      openalexKey: dailyProviders.openalex.apiKey, githubToken: dailyProviders.github.apiKey,
      providers: dailyProviders,
      limits: { maxCandidates: integer('DAILY_MAX_CANDIDATES', 80, 7, 200),
        maxDeepReads: integer('DAILY_MAX_DEEP_READS', 12, 4, 12), maxQueries: integer('DAILY_MAX_QUERIES', 12, 2, 24) },
    },
  };
}
export function missingConfig(config, { daily = config.daily?.enabled, slack = !daily, wechat = !config.dryRun } = {}) {
  const required = config.model.provider === 'codex-cli' ? {} : { DEEPSEEK_API_KEY: config.model.key };
  if (!daily) Object.assign(required, { EXA_API_KEY: config.exaKey, DATALAB_API_KEY: config.datalabKey });
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
    config.slack.appToken, config.wechat.secret, config.daily?.tavilyKey, config.daily?.firecrawlKey,
    config.daily?.openalexKey, config.daily?.githubToken,
    ...Object.values(config.daily?.providers || {}).map(provider => provider.apiKey)].filter(Boolean);
}
export function redact(value, config, { maxLength = 1800 } = {}) {
  let text = String(value?.message || value || '');
  for (const secret of secretValues(config)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/(access_token|appsecret|secret|token|key)=([^&\s]+)/gi, '$1=[REDACTED]')
    // Use the same prefix boundary as the article guard; preserve source slugs.
    .replace(/(?<![a-zA-Z0-9_])(?:xox[baprs]-[\w-]+|xapp-[\w-]+|sk-[\w-]{12,})/g, '[REDACTED]').slice(0, maxLength);
}
export function prepareData(config) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  if (!fs.realpathSync(config.dataDir).startsWith(fs.realpathSync(config.root) + path.sep)) throw new Error('运行目录不能通过符号链接指向其他项目');
}
