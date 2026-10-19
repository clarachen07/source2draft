// The writer selects immutable source excerpts instead of transcribing quotes
// and their locator IDs independently. Canonical saved claims still contain
// literal source bytes and pass the existing evidence and semantic audits.
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
    claim.refs = claim.refs.map((ref, refIndex) => {
      // Existing canonical checkpoints and injected clients retain the same
      // strict literal-quote path. Never relocate or invent a legacy quote.
      if (!ref || typeof ref !== 'object' || !Object.hasOwn(ref, 'excerptId')) return ref;
      const source = catalog.byId.get(ref.excerptId);
      if (!source || Object.keys(ref).some(key => key !== 'excerptId')) {
        errors.push(excerptSelectionError(ref, index, refIndex, catalog));
        return ref;
      }
      return { ...source };
    });
  }
  return { item, errors };
}
