import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { emitTelemetry } from './telemetry.js';

export const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function fetchRetry(fetchFn, url, options = {}, { attempts = 3, timeout = 45000, onAttempt = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(timeout)]);
    const started = performance.now();
    try {
      const response = await fetchFn(url, { ...options, signal });
      const retrying = [429, 500, 502, 503, 504].includes(response.status) && attempt + 1 < attempts;
      emitTelemetry(onAttempt, { attempt: attempt + 1, status: response.status, durationMs: performance.now() - started,
        retrying, outcome: response.ok ? 'success' : 'http_error' });
      if (!retrying) return response;
      const retryAfter = response.headers.get('retry-after');
      await response.body?.cancel();
      const seconds = /^\d+$/.test(retryAfter || '') ? Number(retryAfter) : 2 ** attempt;
      await delay(Math.min(60000, seconds * 1000), undefined, { signal: options.signal });
    } catch (error) {
      const retrying = !options.signal?.aborted && attempt + 1 < attempts;
      emitTelemetry(onAttempt, { attempt: attempt + 1, durationMs: performance.now() - started,
        retrying, outcome: options.signal?.aborted ? 'cancelled' : 'network_error' });
      if (!retrying) throw error;
      await delay(1000 * 2 ** attempt, undefined, { signal: options.signal });
    }
  }
}
export function escapeHtml(text) { return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
export function parseArticle(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\s*\n/.exec(markdown);
  let title = match ? /^title:\s*(.+)$/m.exec(match[1])?.[1]?.trim() : /^#\s+(.+)$/m.exec(markdown)?.[1];
  if (title?.startsWith('"')) { try { title = JSON.parse(title); } catch { /* retain literal title */ } }
  if (!title || title.length > 64 || /[\r\n]/.test(title)) throw new Error('文章标题缺失或超过 64 个字符');
  let body = match ? markdown.slice(match[0].length) : markdown.replace(/^#\s+.+\n?/, '');
  return { title, body: body.trim() };
}
