import bolt from '@slack/bolt';
import { normalizeFiles } from '../core/sources.js';
import { redact } from '../config/index.js';
const { App, LogLevel } = bolt;

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
    const key = `${event.channel}:${root}`, previous = store.latest(key);
    const mention = new RegExp(`<@${botId}>`, 'g');
    if (!previous && !(message.text || '').includes(`<@${botId}>`)) return;
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
export async function createSlack({ config, store, engine }) {
  // SDK errors may carry request metadata; only emit redacted messages.
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (...args) => {
    if (['warn', 'error'].includes(level)) console.error(args.map(a => redact(a, config)).join(' '));
  }]));
  Object.assign(logger, { setLevel() {}, getLevel() { return LogLevel.WARN; }, setName() {} });
  const app = new App({ token: config.slack.botToken, appToken: config.slack.appToken, socketMode: true, logger });
  const auth = await verifySlackIdentity(app.client, config);
  const receive = createEventHandler({ config, store, engine, botId: auth.user_id });
  app.message(async ({ message, body }) => receive(message, body));
  app.event('app_mention', async ({ event, body }) => receive(event, body));
  app.error(async error => console.error(redact(error, config)));
  let flushing = false;
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      for (const item of store.notices()) {
        if (item.thread_key.startsWith('local:')) { store.sent(item.id); continue; }
        const run = store.get(item.run_id);
        if (run.status === 'superseded' || (item.kind.startsWith('progress:') && !['running', 'publishing'].includes(run.status))
          || (item.kind.startsWith('failed:') && run.status !== 'failed')
          || (item.kind.startsWith('needs_review:') && run.status !== 'needs_review')
          || (item.kind.startsWith('needs_input:') && run.status !== 'needs_input')) { store.sent(item.id); continue; }
        const [channel, ts] = item.thread_key.split(':');
        try {
          await app.client.chat.postMessage({ channel, thread_ts: ts, text: item.text,
            mrkdwn: false, unfurl_links: false, unfurl_media: false });
          store.sent(item.id);
        } catch (error) { console.error(`Slack 通知待重试：${redact(error, config)}`); break; }
        await new Promise(resolve => setTimeout(resolve, 1100));
      }
    } finally { flushing = false; }
  }
  return { app, flush, receive };
}
