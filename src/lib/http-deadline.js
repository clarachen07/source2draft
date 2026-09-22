import { cancellationErrorFromSignal, throwIfTaskCancelled } from './task-cancellation.js';

// The deadline covers DNS, headers and the complete response body, including injected
// transports that do not themselves reject when an AbortSignal fires.
export async function withDeadline({ signal, timeoutMs, message = '网络请求超时' }, operation) {
  throwIfTaskCancelled(signal);
  const controller = new AbortController();
  const error = Object.assign(new Error(`${message}:${timeoutMs}ms`), { code: 'HTTP_TIMEOUT' });
  const timer = setTimeout(() => controller.abort(error), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try { return await raceWithSignal(combined, () => operation(combined)); }
  finally { clearTimeout(timer); }
}

export async function raceWithSignal(signal, operation) {
  throwIfTaskCancelled(signal);
  if (!signal) return operation();
  let abort;
  const aborted = new Promise((_, reject) => {
    abort = () => reject(cancellationErrorFromSignal(signal));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation), aborted]); }
  finally { signal.removeEventListener('abort', abort); }
}

export async function readLimitedResponse(response, maxBytes, signal) {
  const limit = Number(maxBytes);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('响应大小上限配置无效');
  if (Number(response.headers?.get?.('content-length') || 0) > limit) {
    void response.body?.cancel?.().catch(() => {});
    throw new Error('原文响应超过大小上限');
  }
  const reader = response?.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await raceWithSignal(signal, () => response.arrayBuffer()));
    if (buffer.length > limit) throw new Error(`原文响应超过大小上限:${buffer.length}`);
    return buffer;
  }
  const abortReader = () => { void reader.cancel('response cancelled').catch(() => {}); };
  signal?.addEventListener('abort', abortReader, { once: true });
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await raceWithSignal(signal, () => reader.read());
      throwIfTaskCancelled(signal);
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > limit) throw new Error(`原文响应超过大小上限:${total}`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    void reader.cancel('response failed').catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortReader);
    reader.releaseLock?.();
  }
}
