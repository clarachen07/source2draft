const URL_RE = /https?:\/\/[^\s<>()，。；：！？】【、】【【】）》〉]+/gi;

export function parseTranslationScope(input) {
  const text = String(input || '').replace(URL_RE, ' ').replace(/\s+/g, ' ').trim();
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

  return { kind: 'all', requestedText: '' };
}

export function applyTranslationScope(document, scope) {
  if (!scope || scope.kind === 'all' || scope.kind === 'pages') return document;
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
      ...scope,
      appliedStartHeading: start.block.text,
      appliedEndHeading: end.block.text,
    },
  };
}

export function scopeLabel(scope) {
  if (!scope || scope.kind === 'all') return '全文';
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
    const numbered = candidates.find(({ block }) => sectionNumber(block.text) === wantedNumber);
    if (numbered) return numbered;
  }
  return candidates.find(({ block }) => {
    const actual = normalizeHeading(block.text);
    return actual === wanted || actual.includes(wanted) || wanted.includes(actual);
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
