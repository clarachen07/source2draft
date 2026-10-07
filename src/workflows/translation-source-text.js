import { sourceSnapshotKey, readSourceSnapshot, saveSourceSnapshot } from './translation-cache.js';
import { translationRequirements } from './translation-requirements.js';
import { hash } from '../lib/io.js';
import path from 'node:path';
import { throwIfTaskCancelled } from '../lib/task-cancellation.js';
import { emitTelemetry } from '../lib/telemetry.js';
import { parseTranslationScope, scopeLabel } from './translation-scope.js';
import { qualityFailure } from './translation-review.js';
import { translateDocument } from './translation-inference.js';
import { acquireSourceDocument, removeRepeatedSourceMetadata, assertSourceDocumentComplete,
  buildDocumentManifest, renderTranslatedDocument, validateTranslationArtifact } from './source-document.js';
import { report, writeJsonAtomic } from './translation-utils.js';
export * from './source-document.js';
export * from './translation-inference.js';
export * from '../lib/secure-http.js';

export async function generateStructuredTranslation({
  input,
  sourceUrl: explicitSourceUrl,
  sourceRequestHeaders = {},
  workflow,
  writer,
  fetchFn,
  fetchWithRetry,
  completeArticle,
  onProgress,
  onInferenceTelemetry,
  onTelemetry,
  translationConfig = {},
  documentConfig = {},
  resumeFromCheckpoint = false,
  signal,
}) {
  throwIfTaskCancelled(signal);
  const sourceUrl = explicitSourceUrl || extractInputUrls(input)[0];
  if (!sourceUrl) throw new Error('直译任务缺少可读取的 http(s) 原文链接');
  const scope = parseTranslationScope(input);

  await report(onProgress, {
    stage: 'source',
    message: `正在提取原文结构，翻译范围：${scopeLabel(scope)}`,
    completed: 0,
    total: 1,
  });
  const snapshotPath = path.join(workflow.workDir, 'translation-source-document.json');
  const snapshotKey = sourceSnapshotKey(sourceUrl, scope, translationConfig);
  const requirements = translationRequirements(input);
  const refreshIdentity = requirements.refresh ? hash(requirements.refreshRequest) : undefined;
  const cachedSource = resumeFromCheckpoint
    ? readSourceSnapshot(snapshotPath, snapshotKey, workflow.workDir, refreshIdentity)
    : undefined;
  const acquired = cachedSource || await acquireSourceDocument({
    sourceUrl,
    workDir: workflow.workDir,
    fetchFn,
    fetchWithRetry,
    config: { ...translationConfig, onTelemetry },
    documentConfig,
    dnsLookup: translationConfig.dnsLookup,
    scope,
    onProgress,
    requestHeaders: sourceRequestHeaders,
    signal,
  });
  throwIfTaskCancelled(signal);
  if (!cachedSource) {
    saveSourceSnapshot(snapshotPath, snapshotKey, acquired, workflow.workDir, refreshIdentity);
  }
  emitTelemetry(onTelemetry, { stage: 'source-document', cacheHit: Boolean(cachedSource), count: 1 });
  // Every acquisition path resolves the scope before localizing its assets.
  let source = acquired;
  source = removeRepeatedSourceMetadata(source);
  assertSourceDocumentComplete(source);
  const manifest = buildDocumentManifest(source);
  await report(onProgress, {
    stage: 'scope',
    message: source.scope.referenceBoundaryMissing
      ? '未能可靠定位参考文献，按要求翻译到文末'
      : `已确定翻译范围：${scopeLabel(source.scope)}`,
    completed: 1,
    total: 1,
  });
  await report(onProgress, {
    stage: 'structure',
    message: `已提取 ${manifest.blocks} 个结构块：${manifest.headings} 个标题、${manifest.figures} 张图、${manifest.tables} 个表格${manifest.pageCoverage
      ? `，页级覆盖 ${manifest.pageCoverage.processedPages}/${manifest.pageCoverage.requestedPages}`
      : ''}`,
    completed: 1,
    total: 1,
  });

  const translated = await translateDocument({
    source,
    workDir: workflow.workDir,
    model: workflow.model || writer.model,
    writer,
    fetchFn,
    completeArticle,
    timeoutMs: workflow.timeoutMs,
    onProgress,
    onInferenceTelemetry,
    onTelemetry,
    batchConcurrency: translationConfig.batchConcurrency,
    resumeFromCheckpoint,
    translationInstructions: String(input || '').trim(),
    semanticReview: translationConfig.semanticReview !== false,
    signal,
  });
  throwIfTaskCancelled(signal);
  const article = renderTranslatedDocument(translated);
  const completeness = validateTranslationArtifact({ source, translated, article });
  if (completeness.errors.length) {
    throw qualityFailure(`直译完整性门禁失败:${completeness.errors.join('; ')}`);
  }
  await report(onProgress, {
    stage: 'validation',
    message: completeness.reviewRequiredCount
      ? `结构完整性通过：${completeness.blocks} 个内容块，${completeness.reviewRequiredCount} 个译块需人工复核`
      : `原文结构、标识与风险块复核通过：${completeness.blocks} 个内容块`,
    completed: 1,
    total: 1,
  });

  return {
    article,
    sourceUrl: source.sourceUrl,
    manifest: {
      ...manifest,
      title: source.title,
      author: source.author,
      publishedDate: source.publishedDate,
      sourceUrl: source.sourceUrl,
      sourceType: source.sourceType,
      extractor: source.extractor,
      sha256: source.sha256,
      acquisition: source.acquisition,
      scope: source.scope,
    },
    completeness,
    warnings: completeness.warnings,
    contentPolicy: {
      allow_code_blocks: source.blocks.some((block) => block.type === 'code'),
      source: source.blocks.some((block) => block.type === 'code')
        ? 'translation-source-code'
        : 'translation-source-no-code',
    },
  };
}

function extractInputUrls(text) {
  return (String(text || '').match(/https?:\/\/[^\s<>()，。；：！？】【、】【【】）》〉]+/g) || [])
    .map((url) => url.replace(/[.,;:!?)\]}>，。；：！？】【、】【【】）》〉]+$/, ''));
}
