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
        errors.push(`claims[${index}].refs[${refIndex}]必须只含本条原文目录中存在的excerptId；按目录选择编号，不自行添加cardId、locatorId或quote。`);
        return ref;
      }
      return { ...source };
    });
  }
  return { item, errors };
}
