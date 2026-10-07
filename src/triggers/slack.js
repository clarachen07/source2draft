import bolt from '@slack/bolt';
import crypto from 'node:crypto';
import { normalizeFiles } from '../core/sources.js';
import { redact } from '../config/index.js';
const { App, LogLevel, SocketModeReceiver } = bolt;

export async function verifySlackIdentity(client, config) {
  const auth = await client.auth.test();
  if (auth.team_id !== config.slack.team || !auth.bot_id || !auth.user_id) throw new Error('Slack Bot 不属于配置的个人工作区');
  const info = await client.conversations.info({ channel: config.slack.channel });
  if (!info.channel?.is_member || info.channel.is_private || info.channel.is_archived || info.channel.name !== 'general') throw new Error('请将新 Bot 邀请到个人工作区的公开 #general，并检查频道 ID');
  let cursor;
  for (let page = 0; page < 20; page++) {
    const members = await client.conversations.members({ channel: config.slack.channel, limit: 200, ...(cursor ? { cursor } : {}) });
    if (members.members?.includes(config.slack.user)) return auth;
    cursor = members.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  throw new Error('SLACK_USER_ID 不在个人 #general 中，请检查本人用户 ID');
}

export function createEventHandler({ config, store, engine, botId, now = () => Date.now() }) {
  return async function receive(event, body = {}) {
    const team = body.team_id || body.team?.id || event.team;
    if (team !== config.slack.team || event.channel !== config.slack.channel) return;
    const edit = event.subtype === 'message_changed';
    const message = edit ? event.message : event;
    if (!message || message.user !== config.slack.user || message.bot_id || message.bot_profile) return;
    if (message.subtype && message.subtype !== 'file_share') return;
    if (!message.ts) return;
    const root = message.thread_ts || message.ts;
    const key = store.resolveThreadKey?.(event.channel, root) || `${event.channel}:${root}`, previous = store.latest(key);
    const mention = new RegExp(`<@${botId}>`, 'g');
    if ((!message.thread_ts || !previous) && !(message.text || '').includes(`<@${botId}>`)) return;
    if (message.thread_ts && !previous) return;
    const text = String(message.text || '').replace(mention, '').replace(/<(https?:\/\/[^>|]+)(?:\|[^>]*)?>/g, '$1')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    if (!text && !message.files?.length) return;
    // Delivery timestamps can differ between message/app_mention events. The
    // message's edit timestamp is the stable revision identifier across retries.
    const version = Number(message.edited?.ts || (edit ? event.event_ts : null) || message.ts);
    const command = /^(?:停止(?:当前任务|进程)?|取消(?:任务)?|stop(?: the current task)?|cancel(?: task)?|abort)$/i.test(text) ? 'cancel'
      : /^(?:重试|retry)$/i.test(text) ? 'retry' : null;
    if (previous && command) {
      const result = store.control({ threadKey: key, ts: message.ts, version, command });
      if (!result.run) return;
      if (result.error) store.notice(result.run, `${command}:${message.ts}:${version}`, redact(result.error, config));
      else if (command === 'cancel') {
        if (result.applied) { engine.abort(result.run.id); store.notice(result.run, 'cancelled', '任务已取消，保留已有本地文件。'); }
        else store.notice(result.run, `cancel-info:${message.ts}:${version}`, '该任务已结束；已创建的公众号草稿保留。');
      } else store.notice(result.run, `retry:${message.ts}:${version}`, '已安排重试；若上传结果待核对，只核对现有草稿，不重复创建。');
      return;
    }
    // No history polling or replay on reconnect. Slack's live delivery may retry an event; persisted messages dedupe it.
    if (!previous && now() / 1000 - Number(message.ts) > 300) return;
    const result = store.enqueue({ threadKey: key, ts: message.ts, text, files: normalizeFiles(message.files), version,
      dryRun: config.dryRun, debounceMs: config.slack.debounceMs });
    if (result.superseded) engine.abort(result.superseded);
    if (result.busy) store.notice(previous, `busy:${message.ts}`, '上一修订的上传结果尚未确认；请等结果或先重试核对，再发送修改要求。');
    if (result.run) store.notice(result.run, 'accepted', `已收到修订 ${result.run.revision}${config.dryRun ? '（模拟模式）' : ''}。完成后${config.dryRun ? '保存本机预览' : '创建新的公众号草稿'}。\n任务 ${result.run.id}`);
  };
}
export async function createSlack({ config, store, engine, now = () => Date.now(),
  appFactory, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = text => console.error(text) }) {
  // SDK errors may carry request metadata; only emit redacted messages.
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (...args) => {
    if (['warn', 'error'].includes(level)) log(args.map(a => redact(a, config)).join(' '));
  }]));
  Object.assign(logger, { setLevel() {}, getLevel() { return LogLevel.WARN; }, setName() {} });
  // One remote write per recorded operation. WebClient's default retry policy
  // can repeat chat.postMessage after a lost response; it is disabled here.
  const clientOptions = { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 20000 };
  let app, auth, receive, connecting, flushing, stopping = false, connected = false, attempts = 0, nextAttemptAt = 0;
  const reconcileAfter = new Map();
  function construct() {
    const options = { token: config.slack.botToken, appToken: config.slack.appToken,
      socketMode: true, deferInitialization: true, clientOptions, logger };
    // Reconnection belongs to the service's bounded retry loop, including an
    // identity check on every new session, rather than SDK background retries.
    app = appFactory ? appFactory(options) : new App({ ...options, receiver: new SocketModeReceiver({
      appToken: config.slack.appToken, autoReconnectEnabled: false, logger, installerOptions: { clientOptions },
    }) });
    app.message(async ({ message, body }) => { if (connected && receive) await receive(message, body); });
    app.event('app_mention', async ({ event, body }) => { if (connected && receive) await receive(event, body); });
    app.error(async error => log(redact(error, config)));
    for (const event of ['disconnected', 'close', 'error']) app.receiver?.client?.on(event, () => { connected = false; });
  }
  async function connect() {
    if (stopping || connected || connecting || now() < nextAttemptAt) return connecting;
    connecting = (async () => {
      try {
        if (!config.slack.botToken || !config.slack.appToken || !config.slack.team || !config.slack.channel || !config.slack.user) {
          throw new Error('Slack 个人账号配置不完整；日报继续处理，通知等待配置');
        }
        if (!app) construct(); else await app.stop();
        await app.init();
        auth = await verifySlackIdentity(app.client, config);
        if (stopping) return;
        receive = createEventHandler({ config, store, engine, botId: auth.user_id, now });
        let timeout;
        try {
          await Promise.race([app.start(), new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Slack Socket Mode 连接超过时间上限')), 30000);
          })]);
        } finally { clearTimeout(timeout); }
        if (stopping) { await app.stop(); return; }
        connected = true; attempts = 0; nextAttemptAt = 0;
      } catch (error) {
        connected = false; auth = undefined;
        try { await app?.stop(); } catch { /* A failed connection must not stop the daily worker. */ }
        if (!stopping) {
          nextAttemptAt = now() + Math.min(300000, 5000 * 2 ** Math.min(attempts++, 6));
          log(`Slack 连接待重试，日报继续处理：${redact(error, config)}`);
        }
      }
    })();
    try { await connecting; } finally { connecting = undefined; }
  }
  async function reconcileRoot(threadKey, state) {
    if (now() < (reconcileAfter.get(threadKey) || 0)) return false;
    reconcileAfter.set(threadKey, now() + 300000);
    const started = Number(state.started_at ?? state.startedAt);
    // This is an operation receipt lookup, never a source of article context.
    if (!Number.isFinite(started) || started < now() - 48 * 3600000 || state.channel !== config.slack.channel) return false;
    const matches = new Set();
    let cursor, complete = false;
    for (let page = 0; page < 3; page++) {
      const history = await app.client.conversations.history({ channel: config.slack.channel,
        oldest: String((started - 60000) / 1000), latest: String(Math.min(now() + 60000, started + 600000) / 1000),
        inclusive: true, limit: 100, ...(cursor ? { cursor } : {}) });
      for (const message of history.messages || []) {
        if (message.user === auth.user_id && message.bot_id === auth.bot_id && message.ts
          && (!message.thread_ts || message.thread_ts === message.ts) && String(message.text || '').includes(state.marker)) matches.add(message.ts);
      }
      cursor = history.response_metadata?.next_cursor;
      if (!history.has_more) { complete = true; break; }
      if (!cursor) break;
    }
    if (!complete || matches.size !== 1) return false;
    store.completeNoticeRoot(threadKey, config.slack.channel, [...matches][0]);
    return true;
  }
  async function sendDailyRoot(item, run) {
    const marker = noticeMarker(item, run);
    const existing = store.getNoticeRootState(run.thread_key);
    const operation = store.beginNoticeRoot({ threadKey: run.thread_key, channel: config.slack.channel, marker: existing?.marker || marker });
    if (operation.state === 'sent') return true;
    if (operation.started) {
      try {
        const response = await app.client.chat.postMessage({ channel: config.slack.channel,
          text: `${item.text}\n${marker}`, mrkdwn: false, unfurl_links: false, unfurl_media: false });
        if (response.ok === false || !response.ts || (response.channel && response.channel !== config.slack.channel)) throw new Error('Slack 根通知缺少可核对的消息标识');
        store.completeNoticeRoot(run.thread_key, config.slack.channel, response.ts);
        const saved = store.getNoticeRootState(run.thread_key);
        if (saved?.state !== 'sent' || saved.ts !== response.ts) throw new Error('Slack 根通知标识未持久保存');
        return true;
      } catch (error) {
        store.failNoticeRoot(run.thread_key, { uncertain: true, error: redact(error, config) });
        log(`日报通知需要核对；不会重复发送：${redact(error, config)}`);
      }
    }
    try {
      if (await reconcileRoot(run.thread_key, store.getNoticeRootState(run.thread_key))) {
        if (operation.marker !== marker) {
          // A newer terminal revision can arrive while an older root receipt
          // needs reconciliation. Its result belongs in the recovered thread.
          const route = store.noticeRoute(run.thread_key);
          await app.client.chat.postMessage({ channel: route.channel, thread_ts: route.thread_ts,
            text: item.text, mrkdwn: false, unfurl_links: false, unfurl_media: false });
        }
        return true;
      }
    } catch (error) { log(`日报通知核对暂不可用：${redact(error, config)}`); }
    store.failNoticeRoot(run.thread_key, { uncertain: true, error: '无法唯一核对已发送的日报通知；需要人工检查，禁止盲目重发' });
    return false;
  }
  async function deliverNotices() {
    try {
      for (const item of store.notices({ deliverable: true, now: now() })) {
        if (stopping || !connected) break;
        if (item.thread_key.startsWith('local:')) { store.sent(item.id); continue; }
        const run = store.get(item.run_id);
        if (!run || run.status === 'superseded' || (item.kind.startsWith('progress:') && !['running', 'publishing'].includes(run.status))
          || (item.kind.startsWith('failed:') && run.status !== 'failed')
          || (item.kind === 'done' && run.status !== 'done')
          || (item.kind.startsWith('needs_review:') && run.status !== 'needs_review')
          || (item.kind.startsWith('needs_input:') && run.status !== 'needs_input')) { store.sent(item.id); continue; }
        const daily = item.thread_key.startsWith('daily:');
        if (daily && store.latest(item.thread_key)?.id !== run.id) { store.sent(item.id); continue; }
        if (daily && !['done', 'failed', 'needs_review', 'needs_input'].includes(item.kind.split(':')[0])) { store.sent(item.id); continue; }
        if (daily && run.status === 'failed' && store.isDailyRetryPending?.(run.id)) { store.deferNotice?.(item.id, now() + 30000); continue; }
        const route = store.noticeRoute?.(item.thread_key) || (!daily ? (() => {
          const [channel, thread_ts] = item.thread_key.split(':'); return { channel, thread_ts };
        })() : null);
        if (route && route.channel !== config.slack.channel) { log('Slack 通知目标不属于配置的个人频道；保留待处理记录'); store.blockNotice?.(item.id, 'invalid_route'); continue; }
        // A crash between persisting ts and marking the outbox row as sent
        // must consume that row without posting its result again in the thread.
        const rootState = daily && store.getNoticeRootState(run.thread_key);
        if (daily && route && rootState?.state === 'sent' && rootState.marker === noticeMarker(item, run)) {
          store.sent(item.id); continue;
        }
        try {
          if (daily && !route) {
            if (!await sendDailyRoot(item, run)) { store.blockNotice?.(item.id, 'root_needs_review'); continue; }
          } else {
            await app.client.chat.postMessage({ channel: route.channel, thread_ts: route.thread_ts, text: item.text,
              mrkdwn: false, unfurl_links: false, unfurl_media: false });
          }
          store.sent(item.id);
        } catch (error) {
          if (Number(error.retryAfter) > 0) store.deferNotice?.(item.id, now() + Math.min(86400, Number(error.retryAfter)) * 1000);
          else if (!daily || store.getNoticeRootState?.(run.thread_key)?.state !== 'sent') store.deferNotice?.(item.id, now() + 30000);
          log(`Slack 通知待重试：${redact(error, config)}`); break;
        }
        await sleep(1100);
      }
    } finally { flushing = undefined; }
  }
  function flush() {
    if (!connected || stopping || flushing) return flushing;
    flushing = Promise.resolve().then(deliverNotices).finally(() => { flushing = undefined; }); return flushing;
  }
  return {
    get app() { return app; }, get connected() { return connected; },
    get status() { return { connected, nextAttemptAt, needsReview: store.notices().filter(item => item.thread_key.startsWith('daily:')
      && store.getNoticeRootState?.(item.thread_key)?.state === 'needs_review').length }; },
    connect, tick: connect, flush,
    receive: (event, body) => connected && receive ? receive(event, body) : undefined,
    async stop() {
      stopping = true; connected = false;
      const results = await Promise.allSettled([app?.stop(), connecting, flushing]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    },
  };
}

function noticeMarker(item, run) {
  return `[Source2Draft daily:${crypto.createHash('sha256').update(`${run.thread_key}\0${run.id}\0${item.id}`).digest('hex').slice(0, 24)}]`;
}
