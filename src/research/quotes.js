import { numericTokens } from './evidence.js';

// The writer selects immutable source excerpts instead of transcribing quotes
// and their locator IDs independently. Canonical saved claims still contain
// literal source bytes and pass the existing evidence and semantic audits.

// Six is the selective-citation cap, not a grounding limit. A seventh real
// excerpt used to fail the writer and ask the model to split the sentence.
// That rewrite must stay a verbatim body substring, so the model resubmits
// the same ids and the three-attempt budget aborts a claim the number check
// would accept. Duplicates are removed here. Refs that add no sentence number
// are dropped only until six remain. A number that occurs in one excerpt stays.
const DAILY_CLAIM_REF_LIMIT = 6;

function numericCover(refs, sentence) {
  const missing = new Set(numericTokens(typeof sentence === 'string' ? sentence : ''));
  const cover = [];
  for (const ref of refs) {
    if (!missing.size) break;
    const quote = typeof ref?.quote === 'string' ? ref.quote : '';
    const found = numericTokens(quote).filter(number => missing.has(number));
    if (!found.length) continue;
    for (const number of found) missing.delete(number);
    cover.push(ref);
  }
  return cover;
}

function selectGroundedRefs(refs, sentence) {
  const cover = numericCover(refs, sentence);
  if (cover.length >= DAILY_CLAIM_REF_LIMIT) return cover;
  const required = new Set(cover);
  const room = DAILY_CLAIM_REF_LIMIT - cover.length;
  let fillers = 0;
  const kept = [];
  for (const ref of refs) {
    if (required.has(ref)) { kept.push(ref); continue; }
    if (fillers >= room) continue;
    fillers += 1;
    kept.push(ref);
  }
  return kept;
}

// More than six refs is allowed only when every ref adds a sentence number
// the earlier refs do not. Anything looser still fails the cap.
export function dailyClaimRefsAllowed(claim) {
  const refs = claim?.refs;
  if (!Array.isArray(refs) || refs.length < 1) return false;
  if (refs.length <= DAILY_CLAIM_REF_LIMIT) return true;
  return numericCover(refs, claim?.sentence).length === refs.length;
}

function excerptSpans(text) {
  const boundaries = [0];
  for (const match of text.matchAll(/\n+|(?<=[.!?。！？])\s+(?=[A-Z“"‘(\[])/g)) boundaries.push(match.index + match[0].length);
  boundaries.push(text.length);
  const spans = [];
  let start = 0;
  for (const end of [...new Set(boundaries)].slice(1)) {
    const quote = text.slice(start, end);
    // Keep short headings/table cells with the next contiguous source span.
    if (quote.replace(/\s+/g, ' ').trim().length < 8 && end < text.length) continue;
    if (quote.trim()) spans.push({ start, end, quote });
    start = end;
  }
  if (spans.length > 1 && spans.at(-1).quote.replace(/\s+/g, ' ').trim().length < 8) {
    const last = spans.pop(), previous = spans.at(-1);
    previous.end = last.end; previous.quote = text.slice(previous.start, previous.end);
  }
  return spans;
}

export function createDailyQuoteCatalog(cards) {
  const byId = new Map();
  const sourceCards = cards.map(card => ({ ...card, locators: card.locators.map(locator => {
    const { text, ...metadata } = locator;
    const excerpts = excerptSpans(text).map((span, index) => {
      const excerptId = `${card.id}/${locator.id}/Q${index + 1}`;
      if (byId.has(excerptId)) throw new Error('原文摘录编号重复，已停止写作');
      byId.set(excerptId, { cardId: card.id, locatorId: locator.id, quote: span.quote });
      return { excerptId, quote: span.quote };
    });
    return { ...metadata, excerpts };
  }) }));
  return { cards: sourceCards, byId };
}

function excerptIdsFor(catalog, prefix) {
  return [...catalog.byId.keys()].filter(key => key.startsWith(prefix))
    .sort((left, right) => Number(left.slice(prefix.length)) - Number(right.slice(prefix.length)));
}

// Tell the model the real Q range. Do not ask it to transcribe a quote: the
// next response may only contain excerptId, and a handwritten quote is rejected.
function excerptSelectionError(ref, index, refIndex, catalog) {
  const where = `claims[${index}].refs[${refIndex}]`;
  const extra = Object.keys(ref).filter(key => key !== 'excerptId');
  if (extra.length) return `${where}必须只含excerptId，不能同时带${extra.join('、')}；按目录选择编号，不自行添加cardId、locatorId或quote。`;
  const id = typeof ref.excerptId === 'string' ? ref.excerptId : '';
  const match = /^([^/\s]+)\/([^/\s]+)\/Q(\d+)$/.exec(id);
  if (match) {
    const [, cardId, locatorId] = match;
    const ids = excerptIdsFor(catalog, `${cardId}/${locatorId}/Q`);
    if (ids.length) {
      const range = ids.length <= 6 ? ids.join('、') : `${ids[0]}–${ids.at(-1)}（共${ids.length}条）`;
      return `${where} excerptId超出范围：${id}。${cardId}/${locatorId}的有效编号为${range}。改用其中一条，不要添加quote、cardId或locatorId。`;
    }
    const locators = [...new Set(excerptIdsFor(catalog, `${cardId}/`).map(key => key.split('/')[1]))];
    if (locators.length) return `${where} excerptId的定位块不存在：${id}。${cardId}可用定位块=${locators.slice(0, 8).join('、')}。不要编造L或Q编号。`;
    return `${where} excerptId不在本条原文目录：${id}。只能选择本次提供的摘录编号。`;
  }
  return `${where}必须只含本条原文目录中存在的excerptId；收到=${JSON.stringify(id).slice(0, 80)}。按目录选择编号，不自行添加cardId、locatorId或quote。`;
}

export function resolveDailyQuoteReferences(value, catalog) {
  const item = structuredClone(value), errors = [];
  if (!Array.isArray(item?.claims)) return { item, errors };
  for (const [index, claim] of item.claims.entries()) {
    if (!Array.isArray(claim?.refs)) continue;
    const next = [];
    const seen = new Set();
    let unresolved = false, catalogOnly = true;
    for (const [refIndex, ref] of claim.refs.entries()) {
      // Existing canonical checkpoints and injected clients retain the same
      // strict literal-quote path. Never relocate or invent a legacy quote.
      if (!ref || typeof ref !== 'object' || !Object.hasOwn(ref, 'excerptId')) {
        catalogOnly = false;
        next.push(ref);
        continue;
      }
      const source = catalog.byId.get(ref.excerptId);
      if (!source || Object.keys(ref).some(key => key !== 'excerptId')) {
        errors.push(excerptSelectionError(ref, index, refIndex, catalog));
        unresolved = true;
        catalogOnly = false;
        next.push(ref);
        continue;
      }
      if (seen.has(ref.excerptId)) continue;
      seen.add(ref.excerptId);
      next.push({ ...source });
    }
    // Trim only a claim whose every ref already resolved. An unknown id keeps
    // its range error so the repair can name the valid excerpt. The sentence
    // and the claim stay; nothing is borrowed from another claim.
    claim.refs = catalogOnly && !unresolved && next.length > DAILY_CLAIM_REF_LIMIT
      ? selectGroundedRefs(next, claim.sentence)
      : next;
  }
  return { item, errors };
}
