import Database from 'better-sqlite3';
import crypto from 'node:crypto';

const ACTIVE = ['queued', 'running', 'publishing'];
export function openStore(filename, { maxQueue = 100 } = {}) {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000'); db.pragma('foreign_keys = ON');
  db.exec(`
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
  const get = id => db.prepare('SELECT * FROM runs WHERE id=?').get(id);
  const latest = key => db.prepare('SELECT * FROM runs WHERE thread_key=? ORDER BY revision DESC LIMIT 1').get(key);
  const update = (id, fields) => {
    const allowed = ['status', 'mode', 'title', 'media_id', 'error', 'result', 'ready_at'];
    const keys = Object.keys(fields); if (keys.some(k => !allowed.includes(k))) throw new Error('非法任务更新字段');
    db.prepare(`UPDATE runs SET ${keys.map(k => `${k}=?`).join(',')},updated_at=? WHERE id=?`)
      .run(...keys.map(k => fields[k]), Date.now(), id);
  };
  const enqueue = db.transaction(({ threadKey, ts, text, files = [], version, dryRun, debounceMs = 0 }) => {
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
    db.prepare(`INSERT INTO runs(id,thread_key,revision,input,attachments,status,dry_run,created_at,ready_at,updated_at,parent_id)
      VALUES(?,?,?,?,?,'queued',?,?,?,?,?)`).run(id, threadKey, (previous?.revision || 0) + 1, input, JSON.stringify(attachments),
      Number(dryRun), now, now + debounceMs, now, previous?.id || null);
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
    update(id, { status: op && op.state !== 'rejected' ? 'publishing' : 'queued', error: null, ready_at: Date.now() });
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
  return {
    db, get, latest, update, enqueue, notice, control, cancel, retry, operation,
    list: () => db.prepare('SELECT id,revision,status,mode,title,media_id,created_at,error,dry_run FROM runs ORDER BY created_at DESC LIMIT 50').all(),
    pending: () => db.prepare("SELECT * FROM runs WHERE status IN ('queued','publishing') AND ready_at<=? ORDER BY created_at LIMIT 1").get(Date.now()),
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
      update(id, { ...fields, status: 'done', error: null });
      notice(get(id), 'done', message);
    }),
    notices: () => db.prepare('SELECT * FROM notices WHERE sent_at IS NULL ORDER BY id LIMIT 30').all(),
    sent: id => db.prepare('UPDATE notices SET sent_at=? WHERE id=?').run(Date.now(), id),
    close: () => db.close(),
  };
}
