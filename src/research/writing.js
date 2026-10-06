import { hash } from '../lib/io.js';
import { DAILY_SYSTEM, dailyOutlinePrompt, dailyWriterPrompt, dailyPlainLength, numericTokens, dailyItemEvidenceErrors, dailyStyleErrors } from './evidence.js';
import { modelIdentity } from '../core/model-identity.js';

const plainHeading = value => typeof value === 'string' && value.trim() && value.length <= 120 && !/[\r\n<>\[\]`]|https?:\/\//.test(value);

export function dailyWritingIdentity({ run, context, cards, modelConfig, previousArticle = '', repair = [], previousDraft = null }) {
  return hash({ version: 6, input: run.input, context, cards, modelConfig: modelIdentity(modelConfig), previousArticle, repair, previousDraft });
}

// Unscoped errors (e.g. issue length) require the whole draft. Item-local
// errors must not expose previously valid items to another semantic rewrite.
export function dailyRepairCardIds(errors, draft) {
  const known = new Set(draft.items.map(item => item.cardId)), targets = new Set();
  for (const error of errors) {
    const match = /^(?:条目"(C\d+)"|(C\d+)：)/.exec(error);
    const id = match?.[1] || match?.[2];
    if (!known.has(id)) return known;
    targets.add(id);
  }
  return targets;
}

function repairOutline(previousDraft, originalOutline, cards) {
  const chosen = new Set(previousDraft.items.map(item => item.cardId));
  const outline = { title: previousDraft.title, intro: previousDraft.intro, items: previousDraft.items.map(item => {
    const original = originalOutline?.items?.find(value => value.cardId === item.cardId);
    const evidenceCardIds = [...new Set([item.cardId, ...(original?.evidenceCardIds || []),
      ...item.claims.flatMap(claim => claim.refs.map(ref => ref.cardId))])].filter(id => chosen.has(id));
    return { cardId: item.cardId, heading: item.heading, importance: item.importance,
      targetChars: original?.targetChars || (item.importance === 'lead' ? 1200 : 600), evidenceCardIds };
  }) };
  if (!outlineShape(outline, cards)) throw new Error('日报修正无法保留原提纲，已停止写作');
  return outline;
}

function outlineShape(outline, cards) {
  if (typeof outline?.title !== 'string' || !outline.title.trim() || outline.title.length > 64 || /[\r\n<>]/.test(outline.title)
    || typeof outline.intro !== 'string' || outline.intro.length > 400 || numericTokens(outline.intro).length
    || !Array.isArray(outline.items) || !outline.items.length || outline.items.length > Math.min(7, cards.length)) return false;
  if (dailyStyleErrors(outline.title, { title: true }).length || dailyStyleErrors(outline.intro).length
    || outline.items.some(item => dailyStyleErrors(item?.heading).length)) return false;
  const known = new Set(cards.map(card => card.id)), chosen = new Set(outline.items.map(item => item?.cardId));
  if (chosen.size !== outline.items.length || [...chosen].some(id => !known.has(id))) return false;
  if (!outline.items.every(item => plainHeading(item.heading) && ['lead', 'medium', 'brief'].includes(item.importance)
    && Number.isInteger(item.targetChars) && item.targetChars >= (item.importance === 'lead' ? 900 : 300)
    && item.targetChars <= (item.importance === 'lead' ? 1200 : 600)
    && Array.isArray(item.evidenceCardIds) && item.evidenceCardIds.includes(item.cardId)
    && item.evidenceCardIds.length <= 3 && new Set(item.evidenceCardIds).size === item.evidenceCardIds.length
    && item.evidenceCardIds.every(id => chosen.has(id)))) return false;
  const total = outline.items.reduce((sum, item) => sum + item.targetChars, dailyPlainLength(outline.intro));
  return total >= (outline.items.length < 4 ? 300 * outline.items.length : 3000) && total <= 5000;
}

export function dailyItemErrors(item, assigned, cards) {
  const byId = new Map(cards.map(card => [card.id, card]));
  const errors = [];
  if (!item || typeof item !== 'object' || Array.isArray(item)) return ['必须返回分配条目的单个 JSON 对象。'];
  errors.push(...dailyStyleErrors(item.heading, { where: '条目标题' }), ...dailyStyleErrors(item.body));
  for (const key of ['cardId', 'heading', 'importance']) {
    if (item[key] !== assigned[key]) errors.push(`${key}必须与分配条目一致：${JSON.stringify(assigned[key])}。`);
  }
  const max = Math.floor(assigned.targetChars * 1.15);
  if (typeof item.body !== 'string' || !item.body.trim()) errors.push('body必须是非空正文字符串。');
  else if (dailyPlainLength(item.body) > max) errors.push(`body正文实际${dailyPlainLength(item.body)}字符，超过上限${max}；请压缩正文，保留证据映射。`);
  if (!Array.isArray(item.claims) || item.claims.length > 24) errors.push('claims必须为数组，最多24条。');
  else item.claims.forEach((claim, index) => {
    const prefix = `claims[${index}]`;
    if (typeof claim?.sentence !== 'string' || !claim.sentence.trim() || typeof item.body !== 'string' || !item.body.includes(claim.sentence)) {
      errors.push(`${prefix}.sentence必须逐字复制body中的非空原句，不能改动标点或空格。`);
    }
    if (!Array.isArray(claim?.refs) || !claim.refs.length || claim.refs.length > 6) errors.push(`${prefix}.refs必须含1–6条引用。`);
    else claim.refs.forEach((ref, refIndex) => {
      if (typeof ref?.quote !== 'string' || !byId.get(ref?.cardId)?.locators.some(locator => locator.id === ref?.locatorId)) {
        errors.push(`${prefix}.refs[${refIndex}]引用无效；quote必须为字符串，cardId/locatorId必须存在于本条提供的证据卡。`);
      }
    });
  });
  if (item.figureIds && (!Array.isArray(item.figureIds) || item.figureIds.some(id => !byId.get(assigned.cardId)?.figures?.some(figure => figure.id === id)))) {
    errors.push('figureIds必须只包含主事件已授权图片ID；不使用图片时返回空数组。');
  }
  // Reject wrong excerpts, unmatched numbers and missing mappings before saving
  // an item or moving on. The adapter's bounded JSON correction receives these
  // diagnostics without spending the whole-issue semantic review allowance.
  // Collect evidence failures alongside field/sentence failures so the single
  // adapter correction sees all repairable issues at once. Malformed outer
  // fields still stop here; nested claim/ref errors are handled by the auditor.
  if (typeof item.body === 'string' && Array.isArray(item.claims)) errors.push(...dailyItemEvidenceErrors(item, cards));
  return errors;
}
const itemShape = (item, assigned, cards) => dailyItemErrors(item, assigned, cards).length === 0;

// Only completed, matching items are reusable. Each model response is saved
// before the next item starts; a failed item cannot trigger later requests.
export async function writeDailyDraft({ phase = 'writing', run, context, cards, config, previousArticle = '', repair = [], previousDraft = null,
  checkpoint, persist, model, signal, onTelemetry, progress = () => {} }) {
  const identity = dailyWritingIdentity({ run, context, cards, modelConfig: config.model, previousArticle, repair, previousDraft });
  if (checkpoint[phase]?.identity !== identity) {
    checkpoint[phase] = { version: 1, identity, items: {} };
    persist();
  }
  const writing = checkpoint[phase];
  const targets = repair.length && previousDraft ? dailyRepairCardIds(repair, previousDraft) : null;
  if (!writing.items || typeof writing.items !== 'object' || Array.isArray(writing.items)) { writing.items = {}; persist(); }
  if (!writing.outline || writing.outlineHash !== hash(writing.outline) || !outlineShape(writing.outline, cards)) {
    signal?.throwIfAborted();
    progress(targets ? '正在保留选题并定位待修正条目' : '正在精选事件并分配篇幅');
    const outline = targets ? repairOutline(previousDraft, checkpoint.writing?.outline, cards)
      : await model.json({ role: 'planner', signal, onTelemetry, systemPrompt: DAILY_SYSTEM,
        prompt: dailyOutlinePrompt({ run, context, cards, previousArticle, repair, previousDraft }), validate: value => outlineShape(value, cards) });
    // Adapter validation is also checked here for injected/nonstandard clients.
    if (!outlineShape(outline, cards)) throw new Error('日报分条提纲结构化结果不合格');
    writing.outline = outline; writing.outlineHash = hash(outline); writing.items = {}; persist();
  }
  const items = [];
  for (const [index, assigned] of writing.outline.items.entries()) {
    signal?.throwIfAborted();
    const relevant = cards.filter(card => assigned.evidenceCardIds.includes(card.id));
    const itemIdentity = hash({ identity, outlineHash: writing.outlineHash, assigned, cards: relevant });
    const cached = writing.items[assigned.cardId];
    let item;
    if (targets && !targets.has(assigned.cardId)) {
      item = previousDraft.items.find(value => value.cardId === assigned.cardId);
      if (!itemShape(item, assigned, relevant)) throw new Error('日报未分配修正的条目结构损坏，已停止写作');
      writing.items[assigned.cardId] = { identity: itemIdentity, valueHash: hash(item), value: item, preserved: true }; persist();
    } else if (cached?.identity === itemIdentity && cached.valueHash === hash(cached.value) && itemShape(cached.value, assigned, relevant)) item = cached.value;
    else {
      progress(`正在${repair.length ? '修正' : '撰写'}事件 ${index + 1}/${writing.outline.items.length}`);
      item = await model.json({ role: 'writer', signal, onTelemetry, systemPrompt: DAILY_SYSTEM,
        prompt: dailyWriterPrompt({ run, context, cards: relevant, previousArticle, repair, outline: writing.outline, assigned,
          previousItem: previousDraft?.items.find(value => value.cardId === assigned.cardId) }),
        validate: value => itemShape(value, assigned, relevant),
        validationErrors: value => dailyItemErrors(value, assigned, relevant) });
      if (!itemShape(item, assigned, relevant)) throw new Error(`日报分条正文结构化结果不合格：${dailyItemErrors(item, assigned, relevant).slice(0, 4).join('；')}`);
      writing.items[assigned.cardId] = { identity: itemIdentity, valueHash: hash(item), value: item }; persist();
    }
    items.push(item);
  }
  return { identity, draft: { title: writing.outline.title, intro: writing.outline.intro, items } };
}
