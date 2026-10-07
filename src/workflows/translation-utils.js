import { writeAtomic } from '../lib/io.js';

import { safeError } from '../lib/json-output.js';
export { parseJsonPayload, safeError } from '../lib/json-output.js';

export async function report(onProgress, progress) {
  if (!onProgress) return;
  try { await onProgress(progress); }
  catch (error) { console.error(`[translate] 进度通知失败(已忽略): ${safeError(error)}`); }
}

export const writeJsonAtomic = writeAtomic;
