import fs from 'node:fs';
import path from 'node:path';
import { createModel } from './model.js';
import { runAnalysis } from '../workflows/analysis.js';
import { generateStructuredTranslation } from '../workflows/translation-source-text.js';
import { attachmentHeaders, coverUrls, inputUrls, translationConfig } from './sources.js';
import { withTaskCancellation } from '../lib/task-cancellation.js';
import { fetchRetry, parseArticle, readJson, writeAtomic } from '../lib/io.js';
import { prepareArticle } from '../lib/wechat-render.js';
import { createWechat } from '../channels/wechat.js';
import { redact } from '../config/index.js';
import { createTelemetry, measureStage } from '../lib/telemetry.js';
import { withRuntimeResource } from '../config/runtime.js';
import { prepareModelRecovery } from './model-recovery.js';
import { modelIdentity } from './model-identity.js';

export function routeMode(input) {
  for (const instruction of input.split(/\n\n补充指令：\n/).reverse()) {
    const withoutUrls = instruction.replace(/https?:\/\/\S+/g, '');
    if (/(?:不要|无需|不必|不用|不需要)\s*(?:完整)?(?:翻译|直译)|(?:改成|改为|转为)\s*(?:写作|分析)|do not translate|don't translate/i.test(withoutUrls)) return 'analysis';
    if (/直译|(?:请|帮我|全文|完整|逐句|逐段|仅|只|^|\n)\s*翻译|translate\s*:|\btranslate\b|^翻译[：:]/i.test(withoutUrls)) return 'translation';
  }
  return 'analysis';
}
const instructions = input => String(input).split(/\n\n补充指令：\n/);
function needsSource(message) { const error = new Error(message); error.needsInput = true; throw error; }
function namedFiles(part, files) {
  const text = part.replace(/https?:\/\/\S+/g, '');
  const occupied = [], selected = [];
  for (const file of [...files].sort((a, b) => b.name.length - a.name.length)) {
    if (!file.name) continue;
    let index = text.indexOf(file.name);
    while (index >= 0) {
      const end = index + file.name.length;
      if (!occupied.some(([start, stop]) => index < stop && end > start)
        && !/[a-z0-9_.-]/i.test(text[index - 1] || '') && !/[a-z0-9_.-]/i.test(text[end] || '')) {
        occupied.push([index, end]);
        if (!selected.includes(file)) selected.push(file);
      }
      index = text.indexOf(file.name, end);
    }
  }
  return selected;
}

export function chooseTranslationSource(run, config) {
  const files = JSON.parse(run.attachments).filter(f => /pdf/i.test(f.mimetype) || /\.pdf$/i.test(f.name));
  const parts = instructions(run.input);
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index], covers = new Set(coverUrls(part));
    const urls = inputUrls(part).filter(url => !covers.has(url));
    const named = namedFiles(part, files);
    const remainder = part.replace(/https?:\/\/\S+/g, '').trim();
    if (index > 0 && /封面|cover/i.test(remainder) && !/翻译|直译|原文|源文|\bsource\b|\btranslate\b/i.test(remainder)) continue;
    const selectsSource = index === 0 || !remainder
      || /翻译|直译|原文|源文|\bsource\b|\btranslate\b|改(?:成|为|用)|换(?:成|为|用)/i.test(remainder);
    if (!selectsSource && !named.length) continue;
    if (named.length + urls.length > 1) needsSource('请在本线程明确一个要翻译的链接或 PDF 文件名。');
    if (urls.length === 1) return { sourceUrl: urls[0] };
    if (named.length === 1) return { sourceUrl: named[0].url, sourceRequestHeaders: attachmentHeaders(named[0], config) };
    if (index > 0 && /(?:改|换|翻译|直译).*(?:附件|PDF)|(?:translate|use).*(?:attachment|pdf)/i.test(remainder)) {
      if (files.length !== 1) needsSource('请在本线程说明要翻译的 PDF 文件名。');
      return { sourceUrl: files[0].url, sourceRequestHeaders: attachmentHeaders(files[0], config) };
    }
  }
  const chosen = files.length === 1 ? files[0] : null;
  if (!chosen) needsSource(files.length ? '请在本线程说明要翻译的 PDF 文件名。' : '请提供要翻译的网页链接或 PDF 附件。');
  return { sourceUrl: chosen.url, sourceRequestHeaders: attachmentHeaders(chosen, config) };
}
export function chooseCover(run, config) {
  const images = JSON.parse(run.attachments).filter(f => f.mimetype.startsWith('image/'));
  for (const part of instructions(run.input).reverse()) {
    if (!/封面|cover/i.test(part)) continue;
    const urls = coverUrls(part), named = namedFiles(part, images);
    if (urls.length + named.length > 1) needsSource('请在本线程明确一个封面链接或图片文件名。');
    if (urls.length === 1) return { url: urls[0] };
    if (named.length === 1) return { url: named[0].url, headers: attachmentHeaders(named[0], config) };
  }
  const selected = images.length === 1 ? images[0] : null;
  return selected ? { url: selected.url, headers: attachmentHeaders(selected, config) } : undefined;
}

export function findPreviousArticle(run, store, workDirFor) {
  const visited = new Set([run.id]);
  let id = run.parent_id;
  while (id && !visited.has(id)) {
    visited.add(id);
    const parent = store.get(id);
    if (!parent || parent.thread_key !== run.thread_key) break;
    const artifact = readJson(path.join(workDirFor(id), 'artifact.json'));
    if (artifact?.article) return artifact.article;
    id = parent.parent_id;
  }
  return '';
}
export function createEngine({ config, store, modelFactory = createModel, wechat = createWechat(config), prepare = prepareArticle,
  dailyResearch = async args => (await import('../workflows/daily-research.js')).runDailyResearch(args) }) {
  const activeRuns = new Map();
  let stopped = false, scheduling = false;
  const laneFor = run => run.profile === 'llm-quant-daily' ? 'daily' : 'manual';
  const workDirFor = id => path.join(config.dataDir, 'runs', id);
  function progress(run, text) {
    const current = store.get(run.id);
    if (!['running', 'publishing'].includes(current?.status)) return;
    store.notice(run, `progress:${text}`, text);
  }
  async function processRun(initialRun, controller) {
    let run = initialRun;
    const timeout = AbortSignal.timeout(run.profile === 'llm-quant-daily'
      ? (config.daily?.taskTimeout || 3600000) : config.taskTimeout);
    const signal = AbortSignal.any([controller.signal, timeout]);
    const workDir = workDirFor(run.id);
    const onTelemetry = createTelemetry(workDir), started = performance.now();
    function complete(result, title, warnings = []) {
      const preview = path.join(workDir, 'preview.html');
      store.complete(run.id, { result: JSON.stringify(result), title, ...(result.mediaId ? { media_id: result.mediaId } : {}) },
        `${run.dry_run ? '模拟完成（未上传公众号）' : '公众号草稿已创建并核对'}：${title}\n修订 ${run.revision} · 任务 ${run.id}${result.mediaId ? `\nmedia_id：${result.mediaId}` : ''}${fs.existsSync(preview) ? `\n本机预览：${preview}` : ''}${warnings.length ? `\n待复核：${warnings.slice(0, 5).join('；')}` : ''}`);
    }
    try {
      const current = store.get(run.id);
      if (!current || ['cancelled', 'superseded', 'done'].includes(current.status)) return;
      run = current;
      const operation = store.operation(run.id);
      if (operation && operation.state !== 'rejected') {
        // Once dispatched, the persisted operation is sufficient for readback;
        // missing or damaged generation caches must not block recovery.
        store.update(run.id, { status: 'publishing' });
        progress(run, '正在回读核对已有公众号草稿');
        const result = await measureStage(onTelemetry, 'wechat', () => wechat.publish({ run, store, workDir, signal, onTelemetry }));
        let warnings;
        try { warnings = readJson(path.join(workDir, 'artifact.json'))?.warnings; }
        catch { /* Optional review notes cannot block a verified remote result. */ }
        complete(result, result.title || JSON.parse(operation.payload).title, Array.isArray(warnings) ? warnings : []);
        return;
      }
      signal.throwIfAborted();
      if (run.profile === 'llm-quant-daily') {
        store.freezeDailyContext(run.id);
        run = store.get(run.id);
      }
      fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
      prepareModelRecovery({ workDir, modelConfig: config.model, profile: run.profile });
      const recoveringPublish = run.status === 'publishing';
      if (!recoveringPublish) store.update(run.id, { status: 'running' });
      const mode = run.profile === 'llm-quant-daily' ? 'analysis' : run.mode || routeMode(run.input);
      store.update(run.id, { mode });
      const events = readJson(path.join(workDir, 'usage.json'), []);
      const model = modelFactory(config, { onTelemetry, workDir,
        onUsage: data => { events.push(data); writeAtomic(path.join(workDir, 'usage.json'), events); } });
      let artifact = readJson(path.join(workDir, 'artifact.json'));
      onTelemetry({ stage: 'artifact', cacheHit: Boolean(artifact) });
      if (!artifact && !recoveringPublish) {
        if (mode === 'translation') {
          const source = chooseTranslationSource(run, config);
          artifact = await measureStage(onTelemetry, 'translation', () => generateStructuredTranslation({ input: run.input, ...source,
            workflow: { workDir, model: config.model.models.translation, timeoutMs: 300000 },
            writer: { model: config.model.models.translation, modelIdentity: modelIdentity(config.model) },
            fetchFn: withTaskCancellation(globalThis.fetch, signal), fetchWithRetry: fetchRetry,
            completeArticle: args => model.complete({ ...args, role: 'translation', signal }),
            onProgress: event => progress(run, event.message),
            onTelemetry, onInferenceTelemetry: onTelemetry,
            translationConfig: { ...translationConfig(config), onTelemetry }, resumeFromCheckpoint: true, signal,
          }));
          writeAtomic(path.join(workDir, 'research-trace.json'), { prompt: run.input, manifest: artifact.manifest, completeness: artifact.completeness, warnings: artifact.warnings });
        } else if (run.profile === 'llm-quant-daily') {
          artifact = await measureStage(onTelemetry, 'daily', () => dailyResearch({ run, config, store, workDir, model, signal,
            onTelemetry, previousArticle: findPreviousArticle(run, store, workDirFor), progress: text => progress(run, text) }));
          store.recordDailyEvents(run.id, artifact.eventIds || []);
        } else {
          artifact = await measureStage(onTelemetry, 'analysis', () => runAnalysis({ run, config, workDir, model, signal, onTelemetry,
            previousArticle: findPreviousArticle(run, store, workDirFor), progress: text => progress(run, text) }));
        }
        signal.throwIfAborted();
        writeAtomic(path.join(workDir, 'article.md'), artifact.article);
        writeAtomic(path.join(workDir, 'artifact.json'), artifact);
      }
      if (!artifact) throw new Error('恢复任务缺少完整文章文件');
      const { title } = parseArticle(artifact.article);
      store.update(run.id, { title });
      let prepared = readJson(path.join(workDir, 'prepared.json'));
      onTelemetry({ stage: 'prepared', cacheHit: Boolean(prepared) });
      if (!prepared && !recoveringPublish) {
        progress(run, '正在准备朴素排版、原图表和封面');
        prepared = await measureStage(onTelemetry, 'render', () => withRuntimeResource('render', () => prepare({
          markdown: artifact.article, workDir, config, signal, onTelemetry, cover: chooseCover(run, config) }), signal));
      }
      if (!prepared) throw new Error('恢复任务缺少排版文件');
      if (!recoveringPublish) signal.throwIfAborted();
      if (!recoveringPublish && store.get(run.id)?.status !== 'running') return;
      let result;
      if (run.dry_run) result = { title, preview: path.join(workDir, 'preview.html'), dryRun: true };
      else {
        progress(run, '正在上传公众号草稿并回读核对');
        result = await measureStage(onTelemetry, 'wechat', () => wechat.publish({ run, store, prepared, workDir, signal, onTelemetry }));
      }
      complete(result, title, artifact.warnings || []);
    } catch (error) {
      const current = store.get(run.id);
      if (['cancelled', 'superseded'].includes(current?.status)) return;
      if (stopped && !timeout.aborted) {
        store.update(run.id, { status: current.status === 'publishing' ? 'publishing' : 'queued' }); return;
      }
      const operation = store.operation(run.id);
      const status = error.needsInput ? 'needs_input' : error.needsReview || (operation && operation.state !== 'rejected') ? 'needs_review' : 'failed';
      const message = timeout.aborted ? '任务超过时间上限，已保存已有进度，可在本线程发送“重试”' : redact(error, config);
      const errorCode = timeout.aborted ? 'TASK_TIMEOUT' : String(error.code || error.cause?.code || 'TASK_FAILED').slice(0, 80);
      const retryable = run.profile === 'llm-quant-daily' && status === 'failed'
        && !operation
        && (error.retryable === true || timeout.aborted
          || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED'].includes(errorCode));
      store.update(run.id, { status, error: message, error_code: errorCode, retryable: Number(retryable) });
      store.notice(run, `${status}:${Date.now()}`, `${status === 'needs_input' ? '需要补充' : status === 'needs_review' ? '需要核对' : '任务失败'}：${message}\n任务 ${run.id}`);
    } finally {
      if (fs.existsSync(workDir)) onTelemetry({ stage: 'task', durationMs: performance.now() - started,
        outcome: store.get(run.id)?.status || 'unknown' });
    }
  }
  function execute(run) {
    if (activeRuns.has(run.id)) return activeRuns.get(run.id).promise;
    const lane = laneFor(run);
    if (stopped || [...activeRuns.values()].some(active => active.lane === lane)) return Promise.resolve();
    // Claim the lane synchronously. A second timer tick cannot dispatch the
    // same task while its first source or model request is still awaiting.
    const active = { id: run.id, lane, controller: new AbortController(), promise: null };
    activeRuns.set(run.id, active);
    active.promise = Promise.resolve().then(() => processRun(run, active.controller))
      .finally(() => activeRuns.delete(run.id));
    return active.promise;
  }
  return {
    workDirFor, execute,
    async tick() {
      if (stopped || scheduling) return;
      scheduling = true;
      const started = [];
      try {
        for (const lane of ['daily', 'manual']) {
          if ([...activeRuns.values()].some(active => active.lane === lane)) continue;
          const run = store.pending(lane);
          if (run) started.push(execute(run));
        }
      } finally { scheduling = false; }
      await Promise.all(started);
    },
    abort(id) { activeRuns.get(id)?.controller.abort(new Error('任务已取消或由最新修订替换')); },
    async stop() {
      stopped = true;
      for (const active of activeRuns.values()) {
        if (store.get(active.id)?.status !== 'publishing') active.controller.abort(new Error('服务正在停止，任务稍后恢复'));
      }
      await Promise.allSettled([...activeRuns.values()].map(active => active.promise));
    },
    get activeId() { return activeRuns.keys().next().value; },
    get activeIds() { return [...activeRuns.keys()]; },
  };
}
