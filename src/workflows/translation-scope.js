const URL_RE = /https?:\/\/[^\s<>()，。；：！？】【、】【【】）》〉]+/gi;

export function parseTranslationScope(input) {
  // A follow-up changes scope only when it explicitly names a new one.
  const instructions = String(input || '').split(/\n\n补充指令：\n/);
  for (let index = instructions.length - 1; index >= 0; index--) {
    const scope = parseInstructionScope(instructions[index], { followup: index > 0 });
    if (scope) return scope;
  }
  return { kind: 'auto', requestedText: '' };
}

function parseInstructionScope(input, { followup = false } = {}) {
  const text = String(input || '').replace(URL_RE, ' ').replace(/\s+/g, ' ').trim()
    .replace(/[‘’]/g, '"')
    .replace(/^(?:请\s*)?(?:(?:把|将)?(?:翻译)?范围\s*)?(?:改为|改成|换成|改译|调整为)\s*(.*)$/, (_, rest) =>
      /^(?:只|仅)?(?:翻译|直译)/.test(rest) ? rest : `翻译 ${rest}`)
    .replace(/^(?:只要|仅要)\s*/, '翻译 ');
  // Page references inside terminology/title edits do not select a new scope.
  if (followup && !/^(?:请|帮我|麻烦)?\s*(?:只|仅|全文|完整)?\s*(?:翻译|直译)|^(?:please\s+)?translate\b|^(?:全文|全部|整篇|整个文档)[。.!！]?$|^(?:第?\s*\d+\s*(?:[-–—~～到至]\s*\d+\s*)?页|前\s*\d+\s*页)[。.!！]?$/i.test(text)) return undefined;
  const pageRange = firstMatch(text, [
    /第?\s*(\d{1,4})\s*(?:[-–—~～]|到|至)\s*第?\s*(\d{1,4})\s*页/i,
    /\bpages?\s*(\d{1,4})\s*(?:[-–—~]|to|through)\s*(\d{1,4})\b/i,
  ]);
  if (pageRange) return pageScope(pageRange[1], pageRange[2], pageRange[0]);

  const firstPages = firstMatch(text, [
    /(?:前|头)\s*(\d{1,4})\s*页/i,
    /\bfirst\s+(\d{1,4})\s+pages?\b/i,
  ]);
  if (firstPages) return pageScope(1, firstPages[1], firstPages[0]);

  const singlePage = firstMatch(text, [
    /第\s*(\d{1,4})\s*页/i,
    /\bpage\s*(\d{1,4})\b/i,
  ]);
  if (singlePage) return pageScope(singlePage[1], singlePage[1], singlePage[0]);

  // This selects body translation plus an unchanged bibliography, not the
  // bibliography section itself. Match it before the named-section patterns.
  const beforeReferences = /(?:翻译|直译)\s*(?:范围\s*[:：]?\s*)?[“"'《]?(?:参考文献|引用文献|references?|bibliography)[”"'》]?\s*(?:之前|以前|前)(?:[。.!！]|\s|$)/i.exec(text);
  if (beforeReferences) return { kind: 'paper-main', requestedText: beforeReferences[0].trim() };

  const sectionRange = firstMatch(text, [
    /(?:只\s*)?翻译\s*(?:从\s*)?[“"'《]?([^“”"'《》]{1,80}?)[”"'》]?\s*(?:到|至)\s*[“"'《]?([^“”"'《》]{1,80}?)[”"'》]?(?:\s*(?:章节|部分))?(?:\s|$)/i,
    /\btranslate\s+from\s+(.{1,80}?)\s+(?:to|through)\s+(.{1,80}?)(?:\s+only)?$/i,
  ]);
  if (sectionRange) {
    return {
      kind: 'sections',
      start: cleanSectionTarget(sectionRange[1]),
      end: cleanSectionTarget(sectionRange[2]),
      requestedText: sectionRange[0].trim(),
    };
  }

  const numberedSection = firstMatch(text, [
    /(?:只\s*)?翻译\s*第?\s*(\d+(?:\.\d+)*)\s*(?:章|节|部分)/i,
    /\btranslate\s+section\s+(\d+(?:\.\d+)*)\b/i,
  ]);
  if (numberedSection) {
    const target = cleanSectionTarget(numberedSection[1]);
    return { kind: 'sections', start: target, end: target, requestedText: numberedSection[0].trim() };
  }

  const namedSection = firstMatch(text, [
    /(?:只\s*)?翻译\s*[“"'《]([^“”"'《》]{1,80})[”"'》]\s*(?:章节|部分)?/i,
    /(?:只\s*)?翻译\s*((?:摘要|引言|介绍|结论|局限性|致谢|参考文献|附录|abstract|introduction|conclusion|limitations?|acknowledg(?:e)?ments?|references?|appendix)(?:\s+[A-Za-z0-9 .:_-]+)?)(?:\s*(?:章节|部分))?/i,
    /\btranslate\s+(?:the\s+)?(?:section\s+)?["']?((?:abstract|introduction|conclusion|limitations?|acknowledg(?:e)?ments?|references?|appendix)(?:\s+[A-Za-z0-9 .:_-]+?)?)["']?(?:\s+section)?(?:\s+only)?$/i,
  ]);
  if (namedSection) {
    const target = cleanSectionTarget(namedSection[1]);
    return { kind: 'sections', start: target, end: target, requestedText: namedSection[0].trim() };
  }

  if (/^(?:全文|全部|整篇|整个文档)[。.!！]?$|(?:翻译|直译)\s*(?:全文|全部|整篇|整个文档)|(?:全文|全部|整篇|整个文档)\s*(?:翻译|直译)|\btranslate\s+(?:the\s+)?(?:whole|entire|full)\s+(?:text|article|document|paper)|\btranslate\s+(?:everything|all)\b/i.test(text)) {
    return { kind: 'all', requestedText: text };
  }
  return undefined;
}

export function applyTranslationScope(document, scope) {
  const annotated = annotateBibliography(document.blocks);
  const referenceRanges = bibliographyRanges(annotated);
  const paperDetected = isPaperDocument({ ...document, blocks: annotated }, referenceRanges);
  scope = scope || { kind: 'auto', requestedText: '' };
  const requestedKind = scope.kind;
  if (requestedKind === 'auto') scope = { ...scope, kind: paperDetected ? 'paper-main' : 'all' };
  const resolvedScope = {
    ...scope,
    requestedKind,
    paperDetected,
    referencePolicy: 'preserve-original',
  };
  document = { ...document, blocks: annotated, scope: resolvedScope };
  if (scope.kind === 'paper-main') {
    const boundary = referenceRanges[0];
    if (!boundary) {
      return { ...document, scope: { ...resolvedScope, kind: 'all', referenceBoundaryMissing: true } };
    }
    return {
      ...document,
      blocks: annotated.slice(0, boundary.end).map((block, order) => ({ ...block, order })),
      scope: {
        ...resolvedScope,
        referenceStartBlockId: annotated[boundary.start].id,
        referenceEndBlockId: annotated[boundary.end - 1].id,
        appliedEndHeading: annotated[boundary.start].text || '参考文献',
      },
    };
  }
  if (scope.kind === 'all' || scope.kind === 'pages') return document;
  if (scope.kind !== 'sections') throw new Error(`不支持的翻译范围:${scope.kind}`);
  const headings = document.blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.type === 'heading');
  const start = findHeading(headings, scope.start);
  if (!start) throw sectionNotFound(scope.start, headings);
  const end = sameTarget(scope.start, scope.end) ? start : findHeading(headings, scope.end, start.index);
  if (!end) throw sectionNotFound(scope.end, headings);
  if (end.index < start.index) throw new Error(`翻译章节范围顺序无效:${scope.start} 到 ${scope.end}`);

  const endLevel = Number(end.block.level || 2);
  let stop = document.blocks.length;
  for (const candidate of headings) {
    if (candidate.index <= end.index) continue;
    if (Number(candidate.block.level || 2) <= endLevel) {
      stop = candidate.index;
      break;
    }
  }
  const blocks = document.blocks.slice(start.index, stop).map((block, index) => ({ ...block, order: index }));
  if (!blocks.length) throw new Error('指定章节范围没有可翻译内容');
  return {
    ...document,
    blocks,
    scope: {
      ...resolvedScope,
      appliedStartHeading: start.block.text,
      appliedEndHeading: end.block.text,
    },
  };
}

export function scopeLabel(scope) {
  if (!scope || scope.kind === 'all') return '全文';
  if (scope.kind === 'auto') return '自动识别：论文正文翻译、参考文献原文保留；普通网页全文';
  if (scope.kind === 'paper-main') return '论文正文翻译、参考文献原文保留，文献之后停止';
  if (scope.kind === 'pages') {
    return scope.startPage === scope.endPage
      ? `第 ${scope.startPage} 页`
      : scope.startPage === 1
        ? `前 ${scope.endPage} 页`
        : `第 ${scope.startPage}–${scope.endPage} 页`;
  }
  return sameTarget(scope.start, scope.end)
    ? `章节：${scope.start}`
    : `章节：${scope.start} 至 ${scope.end}`;
}

export function datalabPageRange(scope) {
  if (!scope || scope.kind !== 'pages') return undefined;
  return scope.startPage === scope.endPage
    ? String(scope.startPage - 1)
    : `${scope.startPage - 1}-${scope.endPage - 1}`;
}

function pageScope(start, end, requestedText) {
  const startPage = Number(start);
  const endPage = Number(end);
  if (!Number.isInteger(startPage) || !Number.isInteger(endPage) || startPage < 1 || endPage < startPage) {
    throw new Error(`翻译页码范围无效:${start}-${end}`);
  }
  return { kind: 'pages', startPage, endPage, requestedText: String(requestedText || '').trim() };
}

function findHeading(headings, target, afterIndex = -1) {
  const wanted = normalizeHeading(target);
  const wantedNumber = sectionNumber(target);
  const candidates = headings.filter(({ index }) => index >= afterIndex);
  if (wantedNumber) {
    return candidates.find(({ block }) => sectionNumber(block.text) === wantedNumber);
  }
  if (!wanted) return undefined;
  if (isReferencesHeading(target)) {
    return candidates.find(({ block }) => isReferencesHeading(block.text));
  }
  return candidates.find(({ block }) => {
    const actual = normalizeHeading(block.text);
    return actual && (actual === wanted || actual.includes(wanted) || wanted.includes(actual));
  });
}

function sectionNotFound(target, headings) {
  const available = headings.slice(0, 16).map(({ block }) => block.text).join('；');
  return new Error(`未找到指定翻译章节“${target}”。可用标题:${available || '无'}`);
}

function sectionNumber(value) {
  return /^\s*(?:第\s*)?([A-Z]|\d+(?:\.\d+)*)(?:\s*[章节.]|\s+|$)/i.exec(String(value || ''))?.[1]?.toLowerCase() || '';
}

function normalizeHeading(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^\s*(?:第\s*)?(?:[a-z]|\d+(?:\.\d+)*)(?:\s*[章节.:：-]|\s+|$)/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function isReferencesHeading(value) {
  return /^(?:references?|bibliography|works\s+cited|参考文献|引用文献)$/i.test(
    String(value || '').trim()
      .replace(/^(?:(?:第\s*)?\d+(?:\.\d+)*(?:\s*[章节.:：、-]\s*|\s+)|[A-Z](?:[.:：]\s*|\s+))/i, '')
      .replace(/[.:：。\s]+$/, ''),
  );
}

// Container membership survives HTML extraction, so the same boundary logic
// also works for heading-only PDF and Markdown extraction.
function bibliographyRanges(blocks) {
  const ranges = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.bibliographyId) {
      let end = index + 1;
      while (end < blocks.length && blocks[end].bibliographyId === block.bibliographyId) end++;
      ranges.push({ start: index, end });
      index = end - 1;
    } else if (block.type === 'heading' && isReferencesHeading(block.text)) {
      const container = blocks[index + 1]?.bibliographyId;
      let end = index + 1;
      if (container) {
        while (end < blocks.length && blocks[end].bibliographyId === container) end++;
      } else {
        while (end < blocks.length) {
          const candidate = blocks[end];
          if (candidate.type === 'heading' && Number(candidate.level || 2) <= Number(block.level || 2)) break;
          end++;
        }
      }
      ranges.push({ start: index, end });
      index = end - 1;
    }
  }
  return ranges;
}

function annotateBibliography(blocks) {
  const result = blocks.map(block => ({ ...block }));
  for (const { start, end } of bibliographyRanges(result)) {
    for (let index = start; index < end; index++) {
      const block = result[index];
      block.translationPolicy = 'preserve-original';
      if (['paragraph', 'list_item'].includes(block.type)) block.type = 'reference';
    }
  }
  return result;
}

function isPaperDocument(document, referenceRanges) {
  for (const address of [document.sourceUrl, document.documentUrl]) {
    try {
      const url = new URL(address);
      if (['arxiv.org', 'www.arxiv.org', 'alphaxiv.org', 'www.alphaxiv.org'].includes(url.hostname.toLowerCase())
        && /^\/(?:abs|pdf|html)\/\d{4}\.\d{4,5}(?:v\d+)?(?:\.pdf)?(?:\/|$)/i.test(url.pathname)) return true;
    } catch { /* Not a known paper URL. */ }
  }
  if (document.academicMetadata) return true;
  const headings = document.blocks.filter(block => block.type === 'heading');
  return referenceRanges.length > 0
    && headings.some(block => /^(?:abstract|摘要)$/i.test(normalizeHeading(block.text)))
    && headings.some(block => /^\s*(?:第\s*)?\d+(?:\.\d+)*(?:\s*[章节.:：、-]|\s+)\s*\S/.test(block.text));
}

function cleanSectionTarget(value) {
  return String(value || '')
    .replace(/^(?:第)\s*/i, '')
    .replace(/\s*(?:章节|部分)$/i, '')
    .replace(/\s+(?:section|part)(?:\s+only)?$/i, '')
    .replace(/\s+only$/i, '')
    .trim();
}

function sameTarget(left, right) {
  return normalizeHeading(left) === normalizeHeading(right) && sectionNumber(left) === sectionNumber(right);
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match;
  }
  return undefined;
}
