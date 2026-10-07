import Database from 'better-sqlite3';
import crypto from 'node:crypto';

const ACTIVE = ['queued', 'running', 'publishing'];
export const DAILY_PROFILE = 'llm-quant-daily';
const stamp = value => {
  const at = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(at)) throw new Error('非法日报时间');
  return at;
};
export function openStore(filename, { maxQueue = 100, readonly = false } = {}) {
  const db = new Database(filename, { readonly, fileMustExist: readonly });
  try { return initializeStore(db, { maxQueue, readonly }); }
  catch (error) { if (db.open) db.close(); throw error; }
}

function initializeStore(db, { maxQueue, readonly }) {
  const schemaVersion = db.pragma('user_version', { simple: true });
  if (schemaVersion > 3) throw new Error('任务数据库版本较新，请使用匹配的程序版本');
  if (!readonly) db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000'); db.pragma('foreign_keys = ON');
  if (!readonly) db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, thread_key TEXT NOT NULL, revision INTEGER NOT NULL, input TEXT NOT NULL,
      attachments TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, mode TEXT, dry_run INTEGER NOT NULL,
      created_at INTEGER NOT NULL, ready_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      title TEXT, media_id TEXT, error TEXT, result TEXT, parent_id TEXT,
      UNIQUE(thread_key, revision)
    );
    CREATE TABLE IF NOT EXISTS messages (
      thread_key TEXT NOT NULL, ts TEXT NOT NULL, text TEXT NOT NULL, files TEXT NOT NULL, version REAL NOT NULL,
      PRIMARY KEY(thread_key, ts)
    );
    CREATE TABLE IF NOT EXISTS control_messages (
      thread_key TEXT NOT NULL, ts TEXT NOT NULL, version REAL NOT NULL, command TEXT NOT NULL,
      run_id TEXT REFERENCES runs(id), outcome TEXT NOT NULL, error TEXT,
      PRIMARY KEY(thread_key, ts)
    );
    CREATE TABLE IF NOT EXISTS operations (run_id TEXT PRIMARY KEY REFERENCES runs(id), payload TEXT NOT NULL,
      snapshot TEXT NOT NULL, state TEXT NOT NULL, media_id TEXT, started_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY, run_id TEXT REFERENCES runs(id),
      thread_key TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, sent_at INTEGER,
      UNIQUE(run_id, kind));
    CREATE INDEX IF NOT EXISTS queue ON runs(status, ready_at);
  `);
  if (!readonly && schemaVersion < 1) db.transaction(() => {
    const columns = new Set(db.prepare('PRAGMA table_info(runs)').all().map(column => column.name));
    for (const [name, definition] of Object.entries({ profile: 'TEXT', context_json: "TEXT NOT NULL DEFAULT '{}'",
      error_code: 'TEXT', retryable: 'INTEGER NOT NULL DEFAULT 0' })) {
      if (!columns.has(name)) db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS daily_issues (
        issue_id TEXT PRIMARY KEY, issue_date TEXT NOT NULL, scheduled_at INTEGER NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id), manual INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS daily_events (
        run_id TEXT NOT NULL REFERENCES runs(id), event_id TEXT NOT NULL, PRIMARY KEY(run_id,event_id)
      );
      CREATE INDEX IF NOT EXISTS daily_events_lookup ON daily_events(event_id);
      CREATE TABLE IF NOT EXISTS provider_budgets (
        provider TEXT NOT NULL, period TEXT NOT NULL, used INTEGER NOT NULL, limit_units INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY(provider,period)
      );
      CREATE TABLE IF NOT EXISTS provider_health (
        provider TEXT PRIMARY KEY, details TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS daily_threads (
        thread_key TEXT PRIMARY KEY, channel TEXT NOT NULL, ts TEXT NOT NULL, UNIQUE(channel,ts)
      );
      CREATE TABLE IF NOT EXISTS notice_roots (
        thread_key TEXT PRIMARY KEY, channel TEXT NOT NULL, marker TEXT NOT NULL, state TEXT NOT NULL,
        ts TEXT, error TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS daily_settings (
        profile TEXT PRIMARY KEY, enabled INTEGER NOT NULL, enabled_at INTEGER NOT NULL
      );
      PRAGMA user_version = 1;
    `);
  })();
  if (!readonly && schemaVersion < 2) db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_reservations (
        id INTEGER PRIMARY KEY, provider TEXT NOT NULL, period TEXT NOT NULL,
        units INTEGER NOT NULL, allowed INTEGER NOT NULL, used_after INTEGER NOT NULL,
        limit_units INTEGER NOT NULL, reserved_at INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS provider_reservations_no_update BEFORE UPDATE ON provider_reservations
        BEGIN SELECT RAISE(ABORT, 'provider reservations are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS provider_reservations_no_delete BEFORE DELETE ON provider_reservations
        BEGIN SELECT RAISE(ABORT, 'provider reservations are append-only'); END;
      PRAGMA user_version = 2;
    `);
  })();
  if (!readonly && schemaVersion < 3) db.transaction(() => {
    const columns = new Set(db.prepare('PRAGMA table_info(notices)').all().map(column => column.name));
    if (!columns.has('due_at')) db.exec('ALTER TABLE notices ADD COLUMN due_at INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('blocked_reason')) db.exec('ALTER TABLE notices ADD COLUMN blocked_reason TEXT');
    db.exec('PRAGMA user_version = 3');
  })();
  const outboxReady = !readonly || schemaVersion >= 3;
  const dailySchemaReady = !readonly || schemaVersion >= 1;
  const reservationsSchemaReady = !readonly || schemaVersion >= 2;
  const get = id => db.prepare('SELECT * FROM runs WHERE id=?').get(id);
  const latest = key => db.prepare('SELECT * FROM runs WHERE thread_key=? ORDER BY revision DESC LIMIT 1').get(key);
  const update = (id, fields) => {
    const allowed = ['status', 'mode', 'title', 'media_id', 'error', 'result', 'ready_at', 'profile', 'context_json', 'error_code', 'retryable'];
    const keys = Object.keys(fields); if (keys.some(k => !allowed.includes(k))) throw new Error('非法任务更新字段');
    if (keys.some(key => ['profile', 'context_json'].includes(key))) {
      const current = get(id);
      if (['publishing', 'done'].includes(current?.status) || db.prepare('SELECT 1 FROM operations WHERE run_id=?').get(id)) throw new Error('已上传操作的任务元数据不能修改');
      if (fields.context_json !== undefined) {
        const context = JSON.parse(fields.context_json);
        if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('非法任务上下文');
      }
    }
    db.prepare(`UPDATE runs SET ${keys.map(k => `${k}=?`).join(',')},updated_at=? WHERE id=?`)
      .run(...keys.map(k => fields[k]), Date.now(), id);
  };
  const enqueue = db.transaction(({ threadKey, ts, text, files = [], version, dryRun, debounceMs = 0, profile, context }) => {
    const prior = db.prepare('SELECT * FROM messages WHERE thread_key=? AND ts=?').get(threadKey, ts);
    const control = db.prepare('SELECT * FROM control_messages WHERE thread_key=? AND ts=?').get(threadKey, ts);
    version = Number(version);
    if (!Number.isFinite(version)) throw new Error('非法消息版本');
    const encoded = JSON.stringify(files);
    if ((prior && version <= prior.version) || (control && version <= control.version)) return { duplicate: true };
    if (prior && prior.text === text && prior.files === encoded) {
      db.prepare('UPDATE messages SET version=? WHERE thread_key=? AND ts=?').run(version, threadKey, ts);
      return { duplicate: true };
    }
    const previous = latest(threadKey);
    if (previous?.status === 'publishing' || (previous?.status === 'needs_review' && db.prepare('SELECT 1 FROM operations WHERE run_id=?').get(previous.id))) {
      return { busy: true, id: previous.id };
    }
    if (db.prepare("SELECT count(*) AS n FROM runs WHERE status IN ('queued','running','publishing')").get().n >= maxQueue && !ACTIVE.includes(previous?.status)) throw new Error('任务队列已满，请稍后再试');
    db.prepare(`INSERT INTO messages VALUES(?,?,?,?,?) ON CONFLICT(thread_key,ts) DO UPDATE SET text=excluded.text,files=excluded.files,version=excluded.version`)
      .run(threadKey, ts, text, encoded, Number(version));
    const messages = db.prepare('SELECT * FROM messages WHERE thread_key=? ORDER BY CAST(ts AS REAL)').all(threadKey);
    const input = messages.map((m, i) => i ? `补充指令：\n${m.text}` : m.text).join('\n\n');
    const attachments = [...new Map(messages.flatMap(m => JSON.parse(m.files)).map(f => [f.id, f])).values()];
    const id = crypto.randomUUID(), now = Date.now();
    if (previous && ['queued', 'running', 'needs_input'].includes(previous.status)) update(previous.id, { status: 'superseded' });
    const inheritedProfile = profile === undefined ? previous?.profile || null : profile;
    const inheritedContext = context === undefined ? previous?.context_json || '{}' : JSON.stringify(context);
    db.prepare(`INSERT INTO runs(id,thread_key,revision,input,attachments,status,dry_run,created_at,ready_at,updated_at,parent_id,profile,context_json)
      VALUES(?,?,?,?,?,'queued',?,?,?,?,?,?,?)`).run(id, threadKey, (previous?.revision || 0) + 1, input, JSON.stringify(attachments),
      Number(dryRun), now, now + debounceMs, now, previous?.id || null, inheritedProfile, inheritedContext);
    if (inheritedProfile === DAILY_PROFILE) {
      const issueId = JSON.parse(inheritedContext).issueId;
      if (issueId) db.prepare('UPDATE daily_issues SET run_id=? WHERE issue_id=?').run(id, issueId);
    }
    return { run: get(id), superseded: previous && ['queued', 'running'].includes(previous.status) ? previous.id : null };
  });
  function notice(run, kind, text) {
    db.prepare('INSERT INTO notices(run_id,thread_key,kind,text) VALUES(?,?,?,?) ON CONFLICT(run_id,kind) DO NOTHING')
      .run(run.id, run.thread_key, kind, text);
  }
  const operation = id => db.prepare('SELECT * FROM operations WHERE run_id=?').get(id);
  function cancel(id) {
    const run = get(id); if (!run) throw new Error('任务不存在');
    if (run.status === 'publishing') throw new Error('正在确认公众号上传结果，暂不能取消；请等待结果');
    if (!['queued', 'running', 'needs_input'].includes(run.status)) return false;
    update(id, { status: 'cancelled' }); return true;
  }
  function retry(id) {
    const run = get(id); if (!run) throw new Error('任务不存在');
    if (!['failed', 'needs_review'].includes(run.status)) throw new Error('仅允许重试失败或待核对的任务');
    if (latest(run.thread_key)?.id !== id) throw new Error('已有更新修订，不能重试旧版本');
    const op = operation(id);
    if (run.media_id && !op) throw new Error('已有草稿标识但缺少操作记录，禁止重新创建');
    if (op?.state === 'rejected') db.prepare('DELETE FROM operations WHERE run_id=?').run(id);
    update(id, { status: op && op.state !== 'rejected' ? 'publishing' : 'queued', error: null,
      error_code: null, retryable: 0, ready_at: Date.now() });
    db.prepare('DELETE FROM notices WHERE run_id=? AND sent_at IS NULL').run(id);
  }
  const control = db.transaction(({ threadKey, ts, version, command }) => {
    version = Number(version);
    if (!Number.isFinite(version) || !['cancel', 'retry'].includes(command)) throw new Error('非法控制指令');
    const prior = db.prepare('SELECT * FROM control_messages WHERE thread_key=? AND ts=?').get(threadKey, ts);
    const message = db.prepare('SELECT version FROM messages WHERE thread_key=? AND ts=?').get(threadKey, ts);
    if ((prior && version <= prior.version) || (message && version <= message.version)) return { duplicate: true };
    const current = latest(threadKey);
    if (!current) return { ignored: true };
    // An edit or replay of a control message stays bound to its original revision.
    const run = prior ? get(prior.run_id) : current;
    const watermark = db.prepare(`SELECT MAX(version) AS version FROM (
      SELECT version FROM messages WHERE thread_key=?
      UNION ALL SELECT version FROM control_messages WHERE run_id=?
    )`).get(threadKey, current.id).version;
    const save = (outcome, error = null) => db.prepare(`INSERT INTO control_messages VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(thread_key,ts) DO UPDATE SET version=excluded.version,command=excluded.command,
      outcome=excluded.outcome,error=excluded.error`)
      .run(threadKey, ts, version, command, run.id, outcome, error);
    if (run.id !== current.id || version < watermark || (prior && prior.command === command)) {
      save('ignored'); return { duplicate: true };
    }
    try {
      const applied = db.transaction(() => command === 'cancel' ? cancel(run.id) : (retry(run.id), true))();
      save(applied ? 'applied' : 'ignored');
      return { run, applied };
    } catch (error) {
      save('rejected', error.message);
      return { run, applied: false, error: error.message };
    }
  });
  const dailyIssueForRun = runId => {
    const run = get(runId);
    if (run?.profile !== DAILY_PROFILE) return undefined;
    const context = JSON.parse(run.context_json || '{}');
    if (!dailySchemaReady) return undefined;
    const issue = db.prepare('SELECT * FROM daily_issues WHERE issue_id=?').get(context.issueId || context.issueDate);
    return issue ? { ...issue, issueId: issue.issue_id, issueDate: issue.issue_date, scheduledAt: issue.scheduled_at,
      runId: issue.run_id, retryCount: issue.retry_count } : undefined;
  };
  const enqueueDaily = db.transaction(({ issueDate, scheduledAt, cutoffAt, dryRun, manual = false, isCatchup = false }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate || '') || !Number.isFinite(Date.parse(`${issueDate}T00:00:00Z`))
      || new Date(`${issueDate}T00:00:00Z`).toISOString().slice(0, 10) !== issueDate) throw new Error('非法日报期号');
    const scheduled = stamp(scheduledAt);
    const preview = Boolean(dryRun);
    const issueId = preview ? `preview:${manual ? crypto.randomUUID() : issueDate}` : issueDate;
    const existing = db.prepare('SELECT * FROM daily_issues WHERE issue_id=?').get(issueId);
    if (existing) return { duplicate: true, run: get(existing.run_id), issue: dailyIssueForRun(existing.run_id) };
    const cutoff = cutoffAt === undefined || cutoffAt === null ? null : stamp(cutoffAt);
    const context = { issueId, issueDate, scheduledAt: new Date(scheduled).toISOString(),
      cutoffAt: cutoff === null ? null : new Date(cutoff).toISOString(),
      windowStart: cutoff === null ? null : new Date(cutoff - 86400000).toISOString(),
      supplementStart: cutoff === null ? null : new Date(cutoff - 7 * 86400000).toISOString(),
      isCatchup: Boolean(isCatchup), manual: Boolean(manual) };
    const threadKey = preview ? `local:daily-preview:${issueId.slice(8)}` : `daily:${issueDate}`;
    const result = enqueue({ threadKey, ts: String(scheduled / 1000), version: scheduled / 1000, dryRun,
      profile: DAILY_PROFILE, context,
      text: `撰写 ${issueDate} 期 LLM+量化日报，简体中文，面向懂技术与量化金融的读者。重点为大模型与量化投资/交易的交叉研究、工具、新闻和实践，同时兼顾重要 LLM 与量化金融进展。以检索开始前24小时为主，最多补充过去7天未报道的重要事件。写4–7条、约3000–5000中文字符，按重要性分配深度；一手证据优先，核验日期、数字、版本、实验和代码公开状态；事实与推断分开，不凑数、不把旧闻当新消息，不冒充实测。仅创建微信公众号草稿。` });
    if (!result.run) throw new Error('日报初次入队未创建任务');
    db.prepare('INSERT INTO daily_issues(issue_id,issue_date,scheduled_at,run_id,manual,created_at) VALUES(?,?,?,?,?,?)')
      .run(issueId, issueDate, scheduled, result.run.id, Number(manual), Date.now());
    return { ...result, issue: dailyIssueForRun(result.run.id) };
  });
  const freezeDailyContext = db.transaction((runId, at = Date.now()) => {
    const run = get(runId);
    if (!run || run.profile !== DAILY_PROFILE) throw new Error('不是日报任务');
    const context = JSON.parse(run.context_json || '{}');
    if (context.cutoffAt) { stamp(context.cutoffAt); return context; }
    const cutoff = stamp(at);
    Object.assign(context, { cutoffAt: new Date(cutoff).toISOString(),
      windowStart: new Date(cutoff - 86400000).toISOString(), supplementStart: new Date(cutoff - 7 * 86400000).toISOString() });
    update(runId, { context_json: JSON.stringify(context) });
    return context;
  });
  function recordDailyEvents(runId, eventIds = []) {
    if (get(runId)?.profile !== DAILY_PROFILE || !Array.isArray(eventIds)) throw new Error('非法日报事件记录');
    const insert = db.prepare('INSERT OR IGNORE INTO daily_events(run_id,event_id) VALUES(?,?)');
    db.transaction(() => {
      for (const eventId of new Set(eventIds)) {
        if (typeof eventId !== 'string' || !eventId.trim() || eventId.length > 2048) throw new Error('非法事件标识');
        insert.run(runId, eventId);
      }
    })();
  }
  const wasEventDelivered = (eventId, excludeThreadKey) => Boolean(db.prepare(`SELECT 1 FROM daily_events e JOIN runs r ON r.id=e.run_id
    WHERE e.event_id=? AND r.status='done' AND r.dry_run=0 AND r.media_id IS NOT NULL AND r.media_id!=''
    ${excludeThreadKey ? 'AND r.thread_key!=?' : ''} LIMIT 1`).get(eventId, ...(excludeThreadKey ? [excludeThreadKey] : [])));
  const reserveProviderBudget = db.transaction(({ provider, period, units = 1, limit }) => {
    if (!/^[a-z0-9_.-]{1,40}$/i.test(provider || '') || typeof period !== 'string' || !period || period.length > 128
      || !Number.isSafeInteger(units) || units < 0 || !Number.isSafeInteger(limit) || limit < 0) throw new Error('非法供应商预算');
    const existing = db.prepare('SELECT used FROM provider_budgets WHERE provider=? AND period=?').get(provider, period);
    const prior = existing?.used || 0, allowed = prior + units <= limit, used = allowed ? prior + units : prior;
    const at = Date.now();
    db.prepare(`INSERT INTO provider_budgets VALUES(?,?,?,?,?) ON CONFLICT(provider,period)
      DO UPDATE SET used=excluded.used,limit_units=excluded.limit_units,updated_at=excluded.updated_at`)
      .run(provider, period, used, limit, at);
    db.prepare(`INSERT INTO provider_reservations(provider,period,units,allowed,used_after,limit_units,reserved_at)
      VALUES(?,?,?,?,?,?,?)`).run(provider, period, units, Number(allowed), used, limit, at);
    return { allowed, used, remaining: Math.max(0, limit - used), limit };
  });
  function providerHealth(provider, details) {
    if (!/^[a-z0-9_.:/-]{1,160}$/i.test(provider || '')) throw new Error('非法供应商名称');
    if (!dailySchemaReady && details === undefined) return undefined;
    if (details !== undefined) {
      if (!details || typeof details !== 'object' || Array.isArray(details)) throw new Error('非法供应商状态');
      db.prepare(`INSERT INTO provider_health VALUES(?,?,?) ON CONFLICT(provider)
        DO UPDATE SET details=excluded.details,updated_at=excluded.updated_at`).run(provider, JSON.stringify(details), Date.now());
    }
    const row = db.prepare('SELECT * FROM provider_health WHERE provider=?').get(provider);
    return row ? { ...JSON.parse(row.details), provider, updatedAt: row.updated_at } : undefined;
  }
  const resolveThreadKey = (channel, ts) => db.prepare('SELECT thread_key FROM daily_threads WHERE channel=? AND ts=?').get(channel, ts)?.thread_key || `${channel}:${ts}`;
  function noticeRoute(threadKey) {
    const daily = db.prepare('SELECT channel,ts FROM daily_threads WHERE thread_key=?').get(threadKey);
    if (daily) return { channel: daily.channel, thread_ts: daily.ts };
    const match = /^([CG][A-Z0-9]+):(\d+(?:\.\d+)?)$/i.exec(threadKey);
    return match ? { channel: match[1], thread_ts: match[2] } : null;
  }
  const registerDailyThread = db.transaction((threadKey, channel, ts) => {
    if (!threadKey.startsWith('daily:') || !latest(threadKey) || !/^[CG][A-Z0-9]+$/i.test(channel) || !/^\d+(?:\.\d+)?$/.test(ts)) throw new Error('非法日报 Slack 线程');
    const existing = db.prepare('SELECT channel,ts FROM daily_threads WHERE thread_key=?').get(threadKey);
    const other = db.prepare('SELECT thread_key FROM daily_threads WHERE channel=? AND ts=?').get(channel, ts);
    if ((existing && (existing.channel !== channel || existing.ts !== ts)) || (other && other.thread_key !== threadKey)) throw new Error('日报线程已关联其他任务，禁止覆盖');
    db.prepare('INSERT OR IGNORE INTO daily_threads VALUES(?,?,?)').run(threadKey, channel, ts);
    return noticeRoute(threadKey);
  });
  const getNoticeRootState = threadKey => {
    const row = db.prepare('SELECT * FROM notice_roots WHERE thread_key=?').get(threadKey);
    return row ? { ...row, threadKey: row.thread_key, startedAt: row.started_at } : undefined;
  };
  const beginNoticeRoot = db.transaction(({ threadKey, channel, marker }) => {
    if (!threadKey.startsWith('daily:') || !latest(threadKey) || !/^[CG][A-Z0-9]+$/i.test(channel)
      || typeof marker !== 'string' || !marker || marker.length > 300) throw new Error('非法日报通知操作');
    const existing = getNoticeRootState(threadKey);
    if (existing) {
      if (existing.channel !== channel || existing.marker !== marker) throw new Error('日报通知操作不能修改目标或标识');
      return { ...existing, started: false };
    }
    const at = Date.now();
    db.prepare("INSERT INTO notice_roots(thread_key,channel,marker,state,started_at,updated_at) VALUES(?,?,?,'requesting',?,?)")
      .run(threadKey, channel, marker, at, at);
    return { ...getNoticeRootState(threadKey), started: true };
  });
  const completeNoticeRoot = db.transaction((threadKey, channel, ts) => {
    const operation = getNoticeRootState(threadKey);
    if (!operation || operation.channel !== channel) throw new Error('日报通知缺少匹配的操作记录');
    const route = registerDailyThread(threadKey, channel, ts);
    db.prepare("UPDATE notice_roots SET state='sent',ts=?,error=NULL,updated_at=? WHERE thread_key=?")
      .run(ts, Date.now(), threadKey);
    return route;
  });
  function failNoticeRoot(threadKey, { uncertain = true, error = '' } = {}) {
    db.prepare("UPDATE notice_roots SET state=?,error=?,updated_at=? WHERE thread_key=? AND state!='sent'")
      .run(uncertain ? 'needs_review' : 'rejected', String(error).slice(0, 1800), Date.now(), threadKey);
    return getNoticeRootState(threadKey);
  }
  const configureDailySchedule = db.transaction(({ enabled, enabledAt, at = Date.now(), profile = DAILY_PROFILE }) => {
    const existing = db.prepare('SELECT * FROM daily_settings WHERE profile=?').get(profile);
    const anchor = enabledAt ? stamp(enabledAt) : existing?.enabled && enabled ? existing.enabled_at : stamp(at) + 1;
    db.prepare(`INSERT INTO daily_settings VALUES(?,?,?) ON CONFLICT(profile)
      DO UPDATE SET enabled=excluded.enabled,enabled_at=excluded.enabled_at`).run(profile, Number(enabled), anchor);
    return { enabled: Boolean(enabled), enabledAt: anchor };
  });
  const dailyScheduleSettings = (profile = DAILY_PROFILE) => {
    if (!dailySchemaReady) return undefined;
    const row = db.prepare('SELECT * FROM daily_settings WHERE profile=?').get(profile);
    return row ? { enabled: Boolean(row.enabled), enabledAt: row.enabled_at } : undefined;
  };
  const isDailyRetryPending = (runId, at = Date.now()) => {
    const run = get(runId), issue = dailyIssueForRun(runId);
    const settings = dailyScheduleSettings(run?.profile || DAILY_PROFILE);
    return Boolean(issue && !issue.manual && run.status === 'failed' && run.retryable && !run.media_id && !operation(runId)
      && (!settings || settings.enabled && issue.scheduled_at >= settings.enabledAt)
      && issue.run_id === runId && issue.retry_count < 2 && stamp(at) - issue.scheduled_at < 86400000);
  };
  const retryDaily = db.transaction((runId, at = Date.now()) => {
    if (!isDailyRetryPending(runId, at)) return false;
    const issue = dailyIssueForRun(runId);
    const delay = issue.retry_count === 0 ? 60000 : 300000;
    retry(runId);
    update(runId, { ready_at: stamp(at) + delay });
    db.prepare('UPDATE daily_issues SET retry_count=retry_count+1 WHERE issue_id=?').run(issue.issue_id);
    return true;
  });
  return {
    db, get, latest, update, enqueue, notice, control, cancel, retry, operation,
    list: () => db.prepare('SELECT id,revision,status,mode,title,media_id,created_at,error,dry_run FROM runs ORDER BY created_at DESC LIMIT 50').all(),
    pending: lane => {
      if (![undefined, 'manual', 'daily'].includes(lane)) throw new Error('非法任务队列');
      const condition = lane === 'daily' ? ' AND profile=?' : lane === 'manual' ? ' AND (profile IS NULL OR profile!=?)' : '';
      return db.prepare(`SELECT * FROM runs WHERE status IN ('queued','publishing') AND ready_at<=?${condition} ORDER BY created_at LIMIT 1`)
        .get(Date.now(), ...(lane ? [DAILY_PROFILE] : []));
    },
    enqueueDaily, dailyIssueForRun, freezeDailyContext, recordDailyEvents, wasEventDelivered,
    reserveProviderBudget, providerHealth, providerHealthList: () => dailySchemaReady ? db.prepare('SELECT provider FROM provider_health ORDER BY provider').all().map(row => providerHealth(row.provider)) : [],
    providerBudgets: () => dailySchemaReady ? db.prepare('SELECT provider,period,used,limit_units AS "limit",updated_at FROM provider_budgets ORDER BY provider,period').all() : [],
    providerReservations: (limit = 50) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('非法供应商额度审计范围');
      return reservationsSchemaReady ? db.prepare('SELECT * FROM provider_reservations ORDER BY id DESC LIMIT ?').all(limit) : [];
    },
    resolveThreadKey, noticeRoute, registerDailyThread, beginNoticeRoot, getNoticeRootState, completeNoticeRoot, failNoticeRoot,
    configureDailySchedule, dailyScheduleSettings, isDailyRetryPending, retryDaily,
    dailyIssues: (limit = 50) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('非法日报列表范围');
      return dailySchemaReady ? db.prepare('SELECT * FROM daily_issues ORDER BY scheduled_at DESC LIMIT ?').all(limit) : [];
    },
    recover: () => db.prepare("UPDATE runs SET status='queued' WHERE status='running'").run(),
    beginPublish: db.transaction((run, payload, snapshot) => {
      if (get(run.id)?.status !== 'running') throw new Error('任务已被取消或替换');
      db.prepare("INSERT INTO operations VALUES(?,?,?,'requesting',NULL,?)")
        .run(run.id, JSON.stringify(payload), JSON.stringify(snapshot), Date.now());
      update(run.id, { status: 'publishing' });
    }),
    remoteCreated: db.transaction((id, mediaId) => {
      db.prepare("UPDATE operations SET media_id=?,state='created' WHERE run_id=?").run(mediaId, id);
      update(id, { media_id: mediaId });
    }),
    rejectPublish: id => db.prepare("UPDATE operations SET state='rejected' WHERE run_id=?").run(id),
    complete: db.transaction((id, fields, message) => {
      update(id, { ...fields, status: 'done', error: null, error_code: null, retryable: 0 });
      notice(get(id), 'done', message);
    }),
    notices: ({ deliverable = false, now = Date.now() } = {}) => db.prepare(`SELECT * FROM notices WHERE sent_at IS NULL
      ${deliverable && outboxReady ? 'AND blocked_reason IS NULL AND due_at<=?' : ''} ORDER BY id LIMIT 30`)
      .all(...(deliverable && outboxReady ? [now] : [])),
    deferNotice: (id, dueAt) => db.prepare('UPDATE notices SET due_at=? WHERE id=?').run(dueAt, id),
    blockNotice: (id, reason) => db.prepare('UPDATE notices SET blocked_reason=? WHERE id=?').run(reason, id),
    sent: id => db.prepare('UPDATE notices SET sent_at=? WHERE id=?').run(Date.now(), id),
    close: () => db.close(),
  };
}
