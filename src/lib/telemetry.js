import fs from 'node:fs';
import path from 'node:path';

// Keep diagnostics useful without storing prompts, URLs, credentials or provider responses.
const LABELS = new Set(['stage', 'role', 'outcome', 'finishReason']);
const NUMBERS = new Set(['durationMs', 'waitMs', 'attempt', 'attempts', 'status', 'count', 'bytes',
  'completed', 'total', 'cacheHits', 'browserLaunches', 'checkpointWrites', 'batchIndex', 'batchTotal',
  'itemCount', 'inputCharacters']);
const FLAGS = new Set(['cacheHit', 'retrying', 'fromCheckpoint']);

export function emitTelemetry(callback, event) {
  try {
    const result = callback?.(event);
    if (result && typeof result.catch === 'function') void result.catch(() => {});
  } catch { /* Observability must never retry a successful request or fail an article. */ }
}

export function createTelemetry(workDir) {
  const filename = path.join(workDir, 'metrics.jsonl');
  let warned = false;
  return event => {
    const safe = { at: new Date().toISOString() };
    for (const [key, value] of Object.entries(event || {})) {
      if (LABELS.has(key) && typeof value === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(value)) safe[key] = value;
      else if (NUMBERS.has(key) && Number.isFinite(value) && value >= 0) safe[key] = value;
      else if (FLAGS.has(key) && typeof value === 'boolean') safe[key] = value;
    }
    if (!safe.stage) return;
    try { fs.appendFileSync(filename, `${JSON.stringify(safe)}\n`, { mode: 0o600 }); }
    catch (error) {
      // A diagnostic failure must not change the result of a remote operation.
      if (!warned) console.warn(`任务计时记录暂不可写入（${error.code || 'IO_ERROR'}）`);
      warned = true;
    }
  };
}

export async function measureStage(onTelemetry, stage, fn) {
  const started = performance.now();
  let outcome = 'error';
  try { const result = await fn(); outcome = 'success'; return result; }
  finally { emitTelemetry(onTelemetry, { stage, durationMs: performance.now() - started, outcome }); }
}
