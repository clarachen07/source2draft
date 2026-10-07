import fs from 'node:fs';
import path from 'node:path';
import { hash, readJson, writeAtomic } from '../lib/io.js';
import { emitTelemetry } from '../lib/telemetry.js';
import { sourcePolicy } from '../core/source-policy.js';
import { attachmentHeaders, inputUrls, coverUrls } from '../core/sources.js';
import { OFFICIAL_PROFILES, OFFICIAL_REPOSITORIES } from '../research/catalog.js';
import { normalizeCandidate, deduplicateCandidates, selectDeepReads, temporalStatus } from '../research/candidates.js';
import { createResearchClient, collectCandidates, publicFailure } from '../research/providers.js';
import { readResearchDocument, acquirePermittedFigures, githubReadme } from '../research/documents.js';
import { extractEvidenceCard, isCompleteDailyDraft, validateDailyDraft, narrowDailyDraft, reviewFingerprint, renderDailyArticle } from '../research/evidence.js';
import { writeDailyDraft, dailyWritingIdentity } from '../research/writing.js';
import { reviewDailyDraft, DAILY_REVIEW_POLICY } from '../research/review.js';

export function dailyContext(run) {
  let context;
  try { context = typeof run.context_json === 'string' ? JSON.parse(run.context_json) : run.context_json; } catch { /* checked below */ }
  if (!context || !/^\d{4}-\d{2}-\d{2}$/.test(context.issueDate)
    || !['scheduledAt', 'cutoffAt', 'windowStart', 'supplementStart'].every(key => Number.isFinite(Date.parse(context[key])))
    || Date.parse(context.windowStart) > Date.parse(context.cutoffAt) || Date.parse(context.supplementStart) > Date.parse(context.windowStart)) {
    const error = new Error('日报时间窗口尚未冻结，已停止研究'); error.code = 'DAILY_CONTEXT_INVALID'; throw error;
  }
  return { issueDate: context.issueDate, scheduledAt: context.scheduledAt, cutoffAt: context.cutoffAt,
    windowStart: context.windowStart, supplementStart: context.supplementStart, isCatchup: Boolean(context.isCatchup) };
}

function blocked(message, { sources = false, needsInput = false } = {}) {
  const error = new Error(message);
  error.code = sources ? 'DAILY_SOURCES_UNAVAILABLE' : 'DAILY_FACTS_UNVERIFIED';
  error.retryable = sources;
  if (needsInput) error.needsInput = true; else if (!sources) error.needsReview = true;
  return error;
}

function modelTransient(error) {
  return ['MODEL_TRANSIENT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(error.code)
    || error.name === 'TimeoutError' || /DeepSeek HTTP (?:429|500|502|503|504)|请求超时|下载超时|fetch failed|socket hang up/i.test(error.message || '');
}

function noUpdatesArticle(context, health) {
  const sections = Object.entries(health.sections || {}).filter(([, ok]) => ok).map(([name]) => ({ papers: '论文', llm: '模型官方公告', practice: '开源实践', finance: '金融研究', officialSearch: '官方域检索' })[name]).filter(Boolean);
  return `---\ntitle: ${JSON.stringify('语言模型与量化研究进展检查')}\n---\n\n以下领域已完成资料检查：${sections.join('、')}。尚未找到同时满足资料窗口、原文可读性和证据核验要求的新增事件。已分享的同一事件不重复列入。\n\n${context.issueDate}\n`;
}

function parentEvidence(run, config, store, context, workDir) {
  if (!run.parent_id || !config.dataDir) return [];
  const parent = store.get?.(run.parent_id);
  if (!parent || parent.thread_key !== run.thread_key || parent.profile !== 'llm-quant-daily') return [];
  const parentDir = path.join(config.dataDir, 'runs', parent.id);
  const trace = readJson(path.join(parentDir, 'research-trace.json'));
  if (trace?.profile !== 'llm-quant-daily' || hash(trace.context) !== hash(context) || !Array.isArray(trace.cards)) return [];
  const cards = structuredClone(trace.cards);
  for (const card of cards) card.figures = (card.figures || []).filter(figure => {
    if (!/^research\/assets\/[a-f\d]{16}\.(?:png|jpeg|gif)$/.test(figure.localPath || '')) return false;
    const source = path.join(parentDir, figure.localPath), destination = path.join(workDir, figure.localPath);
    if (!fs.existsSync(source)) return false;
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination); fs.chmodSync(destination, 0o600);
    return true;
  });
  return cards;
}

function suppliedCandidates(run, context, config) {
  const covers = new Set(coverUrls(run.input));
  const urls = inputUrls(run.input).filter(url => !covers.has(url));
  let files;
  try { files = typeof run.attachments === 'string' ? JSON.parse(run.attachments) : run.attachments || []; }
  catch { throw blocked('供给材料列表损坏，未扩展搜索替代', { needsInput: true }); }
  const candidates = urls.map(url => normalizeCandidate({ title: url, url, supplied: true, kind: 'supplied',
    topic: 'supplied', sourceId: 'user', provider: 'supplied', official: true, fetchedAt: context.cutoffAt }));
  for (const file of files.filter(file => !String(file.mimetype || '').startsWith('image/'))) {
    const url = file.url || file.url_private_download || file.url_private;
    if (!url) throw blocked('供给附件缺少可读取地址', { needsInput: true });
    candidates.push(normalizeCandidate({ title: file.name || file.title || '用户附件', url, supplied: true,
      kind: 'supplied', topic: 'supplied', sourceId: 'user-file', provider: 'supplied', official: true,
      requestHeaders: attachmentHeaders({ ...file, url }, config), fetchedAt: context.cutoffAt }));
  }
  if (candidates.some(candidate => !candidate)) throw blocked('供给材料包含无效链接', { needsInput: true });
  if (candidates.length > 12) throw blocked('一次最多深读12份供给材料，请指定范围', { needsInput: true });
  return candidates;
}

// Persist only source descriptors; Slack authentication remains in memory.
const withoutHeaders = candidate => { const { requestHeaders, ...rest } = candidate; return rest; };

export async function runDailyResearch({ run, config, store, workDir, model, signal, onTelemetry, progress = () => {},
  fetchFn = globalThis.fetch, previousArticle = '', collect = collectCandidates, read = readResearchDocument,
  extract = extractEvidenceCard, clientFactory = createResearchClient }) {
  signal?.throwIfAborted();
  const context = dailyContext(run), exclusive = sourcePolicy(run.input, false);
  fs.mkdirSync(path.join(workDir, 'research'), { recursive: true, mode: 0o700 });
  const checkpointFile = path.join(workDir, 'research-trace.json');
  const identity = hash({ version: 1, input: run.input, context, exclusive });
  let checkpoint = readJson(checkpointFile);
  if (!checkpoint || checkpoint.identity !== identity) checkpoint = { version: 1, identity, profile: 'llm-quant-daily', context,
    createdAt: new Date().toISOString(), collection: {}, documents: {}, cards: [], warnings: [] };
  const persist = () => writeAtomic(checkpointFile, checkpoint);
  const emit = event => emitTelemetry(onTelemetry, event);
  const client = clientFactory({ config, store, workDir, signal, fetchFn, onTelemetry });
  const supplied = suppliedCandidates(run, context, config);
  const inherited = parentEvidence(run, config, store, context, workDir);
  if (exclusive && !supplied.length && !inherited.length) throw blocked('仅用供给材料的日报需要原文链接、附件或本线程上一版已核实证据', { needsInput: true });
  if (!checkpoint.cards.length && inherited.length && !supplied.length) {
    checkpoint.cards = inherited;
    checkpoint.inheritedFrom = run.parent_id;
    checkpoint.health = { healthy: true, inherited: true };
    persist();
    progress('正在沿用本期已核实证据修改日报');
  }
  if (!checkpoint.cards.length || supplied.length || checkpoint.selected) {
    if (!checkpoint.selected) {
      let collection = { candidates: [], warnings: [], health: { healthy: true, suppliedOnly: true } };
      if (!exclusive) collection = await collect({ context, config, client, checkpoint, persist, signal, progress });
      checkpoint.health = collection.health;
      checkpoint.warnings = [...new Set([...checkpoint.warnings, ...collection.warnings])];
      const unique = deduplicateCandidates(collection.candidates, context, {
        limit: config.daily?.limits?.maxCandidates || 80,
        delivered: eventId => Boolean(store.wasEventDelivered?.(eventId, run.thread_key)),
      });
      checkpoint.candidateCount = unique.length;
      const selected = exclusive ? supplied : [...supplied, ...selectDeepReads(unique.filter(candidate => !supplied.some(material => material.url === candidate.url)), context,
        Math.max(0, Math.min(12, config.daily?.limits?.maxDeepReads || 12) - supplied.length))];
      if (!selected.length) {
        persist();
        if (collection.health.healthy) return { article: noUpdatesArticle(context, collection.health), noUpdates: true, eventIds: [], warnings: checkpoint.warnings,
          context, sourceStats: { profiles: OFFICIAL_PROFILES.length, repositories: OFFICIAL_REPOSITORIES.length, candidates: 0, deepReads: 0, coverage: collection.health } };
        throw blocked('基础信源检查未通过，无法确认本期确实没有更新；已保留进度供重试', { sources: true });
      }
      // Freeze the work list before reading. A restart cannot silently consume
      // another twelve documents or change the issue's cutoff.
      checkpoint.selected = selected.slice(0, 12).map(withoutHeaders);
      persist();
    }
    const credentials = new Map(supplied.map(candidate => [candidate.eventId, candidate.requestHeaders]));
    for (const [index, descriptor] of checkpoint.selected.entries()) {
      signal?.throwIfAborted();
      const key = hash(descriptor.eventId);
      if (checkpoint.cards.some(card => card.eventId === descriptor.eventId)) continue;
      if (checkpoint.documents[key]?.factFailure || checkpoint.documents[key]?.ineligible) continue;
      let document = checkpoint.documents[key]?.document;
      if (!document) {
        progress(`正在深读原文 ${index + 1}/${checkpoint.selected.length}`);
        try {
          let candidate = { ...descriptor, ...(credentials.get(descriptor.eventId) ? { requestHeaders: credentials.get(descriptor.eventId) } : {}) };
          if (new URL(candidate.url).hostname === 'github.com' && !candidate.sourceTextVerified) candidate = await githubReadme(candidate, client, config);
          document = await read({ candidate, client, config, context, workDir: path.join(workDir, 'research', 'documents', key), signal });
          // Authentication headers never enter checkpoints, prompts or traces.
          document.candidate = withoutHeaders(document.candidate || candidate);
          const count = checkpoint.cards.flatMap(card => card.figures || []).length;
          document.approvedFigures = count < 3 ? await acquirePermittedFigures({ document, client, workDir, maximum: 1, signal }) : [];
          checkpoint.documents[key] = { document };
          persist();
        } catch (error) {
          signal?.throwIfAborted();
          if (descriptor.supplied) throw blocked('供给原文读取失败，未用扩大搜索替代', { sources: true });
          checkpoint.documents[key] = error.code === 'DAILY_CANDIDATE_INELIGIBLE' ? { ineligible: true, reason: error.message } : { failure: publicFailure(error) };
          checkpoint.warnings.push(`${descriptor.sourceId} 的一个候选未取得本期可读原文，已省略`);
          persist();
          continue;
        }
      } else emit({ stage: 'daily.deep-read', cacheHit: true, count: 1 });
      try {
        const card = await extract({ document, id: `C${index + 1}`, model, signal, onTelemetry });
        checkpoint.cards.push(card);
        if (card.claimValidation?.partial) checkpoint.warnings.push(`${descriptor.sourceId} 的部分候选断言未通过定位核验，已仅保留逐条核实的事实`);
        persist();
        emit({ stage: 'daily.evidence-card', cacheHit: false, count: 1 });
      } catch (error) {
        signal?.throwIfAborted();
        if (modelTransient(error)) throw blocked('证据提取模型暂时不可用，已保存原文等待重试', { sources: true });
        if (!/证据卡引用无法|证据卡数值|证据卡有效定位事实不足|结构化结果|定位核验/.test(error.message || '')) throw blocked('证据提取未完成，已保存原文；需要检查模型连接或响应');
        checkpoint.documents[key].factFailure = true;
        // Store only fixed deterministic gate diagnostics, never model JSON or
        // arbitrary network error messages that may contain credentials.
        checkpoint.documents[key].reason = /证据卡有效定位事实不足/.test(error.message) ? '证据卡有效定位事实不足（至少3条事实、2个定位块）'
          : /证据卡数值/.test(error.message) ? '证据卡数值与原文摘录不匹配'
            : /证据卡引用无法/.test(error.message) ? '证据卡引用无法精确定位到原文' : '证据卡结构或定位核验失败';
        checkpoint.documents[key].claimFailures = Array.isArray(error.claimFailures) ? error.claimFailures.map(failure => ({
          index: Number.isInteger(failure.index) ? failure.index : null,
          code: failure.code === 'QUOTE_NOT_FOUND' ? 'QUOTE_NOT_FOUND' : 'NUMERIC_MISMATCH',
          reason: failure.code === 'QUOTE_NOT_FOUND' ? '证据卡引用无法精确定位到原文' : '证据卡数值与原文摘录不匹配',
          locatorId: /^L\d+$/.test(failure.locatorId || '') ? failure.locatorId : null,
        })) : [];
        checkpoint.warnings.push(`${descriptor.sourceId} 的证据摘录未通过定位核验，已省略`);
        persist();
        if (descriptor.supplied) throw blocked('供给原文的关键事实无法通过证据定位核验');
      }
    }
  }
  const cards = checkpoint.cards.filter(card => card.supplied || ['current', 'supplement'].includes(temporalStatus({ ...card, dateVerified: true }, context)));
  if (!cards.length) {
    if (checkpoint.health?.healthy && checkpoint.selected?.length
      && checkpoint.selected.every(candidate => checkpoint.documents[hash(candidate.eventId)]?.ineligible)) {
      persist();
      return { article: noUpdatesArticle(context, checkpoint.health), noUpdates: true, eventIds: [], warnings: [...new Set(checkpoint.warnings)], context,
        sourceStats: { profiles: OFFICIAL_PROFILES.length, repositories: OFFICIAL_REPOSITORIES.length, candidates: checkpoint.candidateCount,
          deepReads: checkpoint.selected.length, ineligible: checkpoint.selected.length, coverage: checkpoint.health } };
    }
    const factsFailed = Object.values(checkpoint.documents).some(document => document.factFailure);
    throw blocked(factsFailed ? '原文证据卡未通过核验，未生成日报' : '候选原文无法读取或缺少可核验日期，未生成日报', { sources: !factsFailed });
  }
  checkpoint.cards = cards;
  const writingArgs = { run, context, cards, config, previousArticle, checkpoint, persist, model, signal, onTelemetry, progress };
  const completeWriting = async (phase, request = {}) => {
    const expected = dailyWritingIdentity({ run, context, cards, modelConfig: config.model, previousArticle,
      repair: request.errors || [], previousDraft: request.baseDraft || null });
    if (!checkpoint.draft || checkpoint.draftWritingIdentity !== expected) {
      delete checkpoint.approval; persist();
      const result = await writeDailyDraft({ ...writingArgs, phase, repair: request.errors || [], previousDraft: request.baseDraft || null });
      checkpoint.draft = result.draft; checkpoint.draftWritingIdentity = result.identity;
      if (phase === 'repairWriting') checkpoint.repairRequest.complete = true;
      persist();
    }
  };
  // Resume an already-spent semantic correction before reviewing. A partial
  // repair must never fall back to its old draft or receive a new allowance.
  if (checkpoint.repairRequest) {
    if (!Array.isArray(checkpoint.repairRequest.errors) || checkpoint.repairRequest.errors.some(error => typeof error !== 'string')
      || !Array.isArray(checkpoint.repairRequest.baseDraft?.items) || checkpoint.correctionCount !== 1) throw blocked('日报修正断点结构损坏，已停止写作');
    await completeWriting('repairWriting', checkpoint.repairRequest);
  } else await completeWriting('writing');
  const narrow = () => {
    if (checkpoint.correctionCount !== 1 || checkpoint.narrowing) return;
    const result = narrowDailyDraft(checkpoint.draft, cards);
    if (!result) return;
    checkpoint.narrowing = { version: 1, before: structuredClone(checkpoint.draft), removed: result.removed,
      afterHash: hash(result.draft), at: new Date().toISOString() };
    checkpoint.draft = result.draft;
    delete checkpoint.approval;
    checkpoint.warnings.push('唯一修正后少量事实句仍缺完整证据映射，已删除并重新终审；未补造证据或增加修正次数。');
    persist();
  };
  narrow();
  const fingerprint = () => reviewFingerprint({ draft: checkpoint.draft, cards, input: run.input, context, modelConfig: config.model });
  if (checkpoint.approval?.fingerprint !== fingerprint() || checkpoint.approval?.policy !== DAILY_REVIEW_POLICY) delete checkpoint.approval;
  if (checkpoint.reviewFailure?.fingerprint === fingerprint() && checkpoint.reviewFailure.policy === DAILY_REVIEW_POLICY) {
    throw blocked(`日报事实或结构核验未通过：${checkpoint.reviewFailure.errors.slice(0, 4).join('；')}`);
  }
  let corrections = checkpoint.correctionCount || 0;
  for (let pass = 0; !checkpoint.approval && pass < 2; pass++) {
    narrow();
    if (!isCompleteDailyDraft(checkpoint.draft, cards)) throw blocked('日报写作结构未完整，已停止审稿与上传');
    let errors = validateDailyDraft(checkpoint.draft, cards);
    {
      progress(corrections ? '正在复核唯一一次修正' : '正在逐条核验原文、数字与日期');
      const audit = await reviewDailyDraft({ draft: checkpoint.draft, cards, run, context, config, checkpoint, persist, model, signal, onTelemetry, progress });
      checkpoint.warnings.push(...audit.warnings);
      errors = [...new Set([...errors, ...audit.issues.filter(issue => issue.severity === 'high').map(issue => `${issue.scope === 'header' ? 'HEADER' : issue.cardId}：${issue.reason}`)])];
      persist();
    }
    if (!errors.length) { checkpoint.approval = { version: 1, policy: DAILY_REVIEW_POLICY, fingerprint: fingerprint(), checkedAt: new Date().toISOString() }; persist(); break; }
    if (corrections >= 1) {
      checkpoint.reviewFailure = { policy: DAILY_REVIEW_POLICY, fingerprint: fingerprint(), errors }; persist();
      throw blocked(`日报事实或结构核验未通过：${errors.slice(0, 4).join('；')}`);
    }
    // Persist the spent repair allowance before the model request. A crash must
    // not grant an additional semantic rewrite on every retry.
    corrections++; checkpoint.correctionCount = corrections;
    checkpoint.repairRequest = { errors, baseDraft: structuredClone(checkpoint.draft), complete: false };
    delete checkpoint.approval; persist();
    await completeWriting('repairWriting', checkpoint.repairRequest);
  }
  if (!checkpoint.approval || checkpoint.approval.fingerprint !== fingerprint()) throw blocked('日报缺少当前版本的核验通过记录');
  const usedIds = new Set(checkpoint.draft.items.flatMap(item => [item.cardId, ...item.claims.flatMap(claim => claim.refs.map(ref => ref.cardId))]));
  const usedCards = cards.filter(card => usedIds.has(card.id));
  const eventIds = [...new Set(usedCards.filter(card => !card.supplied).map(card => card.eventId))];
  checkpoint.warnings = [...new Set(checkpoint.warnings)];
  persist();
  return { article: renderDailyArticle(checkpoint.draft, cards, context), warnings: checkpoint.warnings, eventIds,
    noUpdates: false, profile: 'llm-quant-daily', context, evidenceCards: usedCards,
    sourceStats: { profiles: OFFICIAL_PROFILES.length, repositories: OFFICIAL_REPOSITORIES.length,
      candidates: checkpoint.candidateCount || supplied.length, deepReads: checkpoint.selected?.length || 0,
      verified: cards.length, selected: usedCards.length, coverage: checkpoint.health, degraded: !checkpoint.health?.healthy } };
}
