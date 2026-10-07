import { throwIfTaskCancelled } from './task-cancellation.js';

export async function mapBounded(values, concurrency, mapper, signal) {
  const results = new Array(values.length);
  let cursor = 0;
  let firstError;
  const worker = async () => {
    while (!firstError) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      try {
        throwIfTaskCancelled(signal);
        results[index] = await mapper(values[index], index);
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
  };
  const workerCount = Math.min(values.length, Math.max(1, Math.floor(Number(concurrency) || 1)));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError) throw firstError;
  return results;
}
