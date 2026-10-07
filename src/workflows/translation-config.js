export const DOCUMENT_VERSION = 7;
export const CHECKPOINT_VERSION = 8;
export const SOURCE_SNAPSHOT_VERSION = 3;
export const TRANSLATION_BATCH_MAX_CHARS = 8000;
export const TRANSLATION_BATCH_MAX_ITEMS = 24;
export const TRANSLATION_SHORT_UNIT_MAX_ITEMS = 48;
export const TRANSLATION_SHORT_UNIT_AVERAGE_CHARS = 120;
export const REPAIR_BATCH_MAX_CHARS = 4000;
export const REPAIR_BATCH_MAX_ITEMS = 6;
export const DEFAULT_LIMITS = {
  maxSourceBytes: 50 * 1024 * 1024,
  maxPdfPages: 120,
  browserTimeoutMs: 45000,
  fetchTimeoutMs: 30000,
  maxRedirects: 5,
  maxAssetCount: 80,
  maxAssetBytes: 40 * 1024 * 1024,
  maxSingleAssetBytes: 10 * 1024 * 1024,
};
export const DOCUMENT_BLOCK_TYPES = new Set([
  'heading', 'paragraph', 'quote', 'list_item', 'figure', 'table', 'equation', 'code', 'reference',
]);
export function limitsFor(config) {
  return {
    maxSourceBytes: positive(config.maxSourceBytes, DEFAULT_LIMITS.maxSourceBytes),
    maxPdfPages: positive(config.maxPdfPages, DEFAULT_LIMITS.maxPdfPages),
    browserTimeoutMs: positive(config.browserTimeoutMs, DEFAULT_LIMITS.browserTimeoutMs),
    fetchTimeoutMs: positive(config.fetchTimeoutMs, DEFAULT_LIMITS.fetchTimeoutMs),
    maxRedirects: nonNegative(config.maxRedirects, DEFAULT_LIMITS.maxRedirects),
    maxAssetCount: positive(config.maxAssetCount, DEFAULT_LIMITS.maxAssetCount),
    maxAssetBytes: positive(config.maxAssetBytes, DEFAULT_LIMITS.maxAssetBytes),
    maxSingleAssetBytes: positive(config.maxSingleAssetBytes, DEFAULT_LIMITS.maxSingleAssetBytes),
  };
}

export function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function nonNegative(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}
