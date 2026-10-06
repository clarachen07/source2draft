import { DAILY_PROFILE } from '../core/store.js';

const DAY_MS = 86400000;
const OFFSET_MS = -8 * 3600000;
const START_MS = 17 * 3600000;

function instant(value) {
  const at = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : value;
  if (!Number.isFinite(at)) throw new Error('非法日报时钟');
  return at;
}

// Fixed PST (UTC-8), deliberately independent of the machine's timezone and daylight saving.
export function latestDueDailyIssue(value = Date.now()) {
  const at = instant(value);
  const shifted = at + OFFSET_MS;
  let day = Math.floor(shifted / DAY_MS) * DAY_MS;
  if (shifted - day < START_MS) day -= DAY_MS;
  return { issueDate: new Date(day).toISOString().slice(0, 10), scheduledAt: day + START_MS - OFFSET_MS };
}

export function nextDailyTime(value = Date.now()) {
  return latestDueDailyIssue(value).scheduledAt + DAY_MS;
}

function quotaStatus(config, budgets, at) {
  const stamp = new Date(at).toISOString(), month = stamp.slice(0, 7), day = stamp.slice(0, 10), hour = stamp.slice(0, 13);
  const names = [...new Set(['exa', 'tavily', 'firecrawl', 'openalex', 'github',
    ...budgets.filter(row => [month, day, hour].includes(row.period)).map(row => row.provider)])];
  return names.map(provider => {
    const configured = config.daily?.providers?.[provider] || {};
    const keyConfigured = Boolean(configured.apiKey || (provider === 'exa' ? config.exaKey
      : config.daily?.[provider === 'github' ? 'githubToken' : `${provider}Key`]));
    const requiresKey = ['exa', 'tavily', 'firecrawl'].includes(provider);
    const freeConfirmed = !requiresKey || configured.freeConfirmed === true || config.daily?.[`${provider}FreeConfirmed`] === true;
    const expectedPeriod = ['exa', 'tavily'].includes(provider) ? month : provider === 'github' ? hour : day;
    // Firecrawl scrape reservations use the account's observed billing start;
    // its zero-unit daily balance checks are not a scrape-credit budget.
    const record = provider === 'firecrawl' ? budgets.filter(row => row.provider === provider && row.period.startsWith('billing:')
      && Number.isFinite(Date.parse(row.period.slice(8))) && Date.parse(row.period.slice(8)) <= at)
      .sort((a, b) => Date.parse(b.period.slice(8)) - Date.parse(a.period.slice(8)))[0]
      : budgets.find(row => row.provider === provider && row.period === expectedPeriod);
    const maximum = { exa: 900, tavily: 900, firecrawl: 900, openalex: keyConfigured ? 90 : 9,
      github: keyConfigured ? 4000 : 60 }[provider] ?? record?.limit ?? 150;
    const configuredLimit = Number(configured.periodLimit);
    const capacity = Number.isSafeInteger(configuredLimit) && configuredLimit >= 0 ? Math.min(configuredLimit, maximum) : maximum;
    return { provider, enabled: (!requiresKey || keyConfigured && freeConfirmed) && capacity > 0,
      freeConfirmed, keyConfigured, capacity,
      unit: ['exa', 'openalex'].includes(provider) ? 'cents' : ['tavily', 'firecrawl'].includes(provider) ? 'credits' : 'requests',
      period: record?.period ?? (provider === 'firecrawl' ? null : expectedPeriod),
      used: record?.used ?? null, limit: record?.limit ?? capacity,
      remaining: record ? Math.max(0, Math.min(record.limit, capacity) - record.used) : null,
      state: record ? 'reserved_local' : provider === 'firecrawl' ? 'billing_unconfirmed' : 'no_reservations' };
  });
}

export function createDailyScheduler({ config, store, now = () => Date.now() }) {
  let initialized = false, settings, ticking = false;
  const daily = config.daily || { enabled: false };
  function initialize(at) {
    if (initialized) return;
    settings = store.configureDailySchedule({ enabled: Boolean(daily.enabled), enabledAt: daily.enabledAt,
      at, profile: daily.profile || DAILY_PROFILE });
    initialized = true;
  }
  function tick() {
    if (ticking) return { busy: true };
    ticking = true;
    try {
      const at = instant(now());
      initialize(at);
      if (!daily.enabled) return { enabled: false };
      const due = latestDueDailyIssue(at);
      // Enabling for the first time cannot replay a pre-enable issue; normal restarts reuse the durable anchor.
      let result = { enabled: true };
      if (due.scheduledAt >= settings.enabledAt && at - due.scheduledAt <= (daily.catchupHours || 24) * 3600000) {
        result = store.enqueueDaily({ ...due, dryRun: config.dryRun,
          isCatchup: at - due.scheduledAt >= 60000 });
      }
      for (const issue of store.dailyIssues()) {
        if (issue.manual || issue.scheduled_at < settings.enabledAt || issue.scheduled_at !== due.scheduledAt
          || at - issue.scheduled_at > (daily.catchupHours || 24) * 3600000) continue;
        if (store.isDailyRetryPending(issue.run_id, at)) store.retryDaily(issue.run_id, at);
      }
      return result;
    } finally { ticking = false; }
  }
  function status() {
    const at = instant(now());
    const anchor = daily.enabledAt ? instant(daily.enabledAt) : settings?.enabledAt
      || store.dailyScheduleSettings(daily.profile || DAILY_PROFILE)?.enabledAt || at + 1;
    const next = Math.max(nextDailyTime(at), nextDailyTime(anchor - 1));
    const issues = store.dailyIssues(1000);
    const budgets = store.providerBudgets?.(), reservations = store.providerReservations?.(20);
    const existing = new Set(issues.filter(issue => issue.issue_id === issue.issue_date).map(issue => issue.issue_date));
    const missing = [], latestDue = latestDueDailyIssue(at);
    for (let index = 0; index < 30; index++) {
      const due = latestDueDailyIssue(latestDue.scheduledAt - index * DAY_MS);
      if (due.scheduledAt < anchor) break;
      if (!existing.has(due.issueDate)) missing.push({ issueDate: due.issueDate,
        scheduledAt: new Date(due.scheduledAt).toISOString(),
        state: at - due.scheduledAt < (daily.catchupHours || 24) * 3600000 ? 'pending_catchup' : 'skipped_expired' });
    }
    return { enabled: Boolean(daily.enabled), profile: daily.profile || DAILY_PROFILE,
      schedule: '17:00 UTC-08:00', enabledAt: new Date(anchor).toISOString(),
      nextRunAt: new Date(next).toISOString(), catchupHours: daily.catchupHours || 24,
      issues: issues.slice(0, 50).map(issue => {
        const run = store.get(issue.run_id);
        const root = run && store.getNoticeRootState(run.thread_key);
        return { ...issue, task: run ? { id: run.id, revision: run.revision, status: run.status, dryRun: Boolean(run.dry_run),
          title: run.title, mediaId: run.media_id, error: run.error, errorCode: run.error_code } : null,
        notification: root ? { state: root.state, ts: root.ts, error: root.error, startedAt: root.started_at } : null };
      }), providers: store.providerHealthList(), quotas: quotaStatus(config, Array.isArray(budgets) ? budgets : [], at),
      recentReservations: (Array.isArray(reservations) ? reservations : []).slice(0, 20).map(row => ({ id: row.id,
        provider: row.provider, period: row.period, units: row.units, allowed: row.allowed, used_after: row.used_after,
        limit_units: row.limit_units, reserved_at: row.reserved_at })), missing,
      skippedCount: missing.filter(issue => issue.state === 'skipped_expired').length,
      missedCount: missing.length, lookbackDays: 30 };
  }
  return { tick, status };
}
