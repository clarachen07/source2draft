// The model proposes review issues. Publication blocking is decided here so an
// open-ended list of missing context cannot outlast the correction budget.
// A positive factual defect still blocks on every pass. Ambiguous wording blocks.

const POSITIVE_FACT = /写成了|误写成|误写|误标|误作|说成|写到了|张冠李戴|与原文不符|原文不符|数字不符|并不等于|不等于原文|不得声称|声称未披露|声称实盘|错称实盘|错称实测|并非真实交易|并非实盘|说成真实交易|写成真实交易|混淆了比较组|比较组(?:错误|搞错|对调|写反)|方向(?:写反|相反)|无中生有|虚构|编造|框定为|范围不准确/;

// The draft left out a source condition, or this pass could not verify a detail
// the draft never asserted. Source-side 没有报告/未给出/未说明/未写在 does not
// qualify: reviewers use those words for claims the draft invented.
const DRAFT_GAP = /稿件没有|没有交代|未交代|遗漏|没有在该定位|本次核查未|本次未核实|本次未确认|locators未见|未见各|未见成分|标题用词/;
const DRAFT_PLACEMENT = /没有写在|未写在|没有明确说明/;
const SOURCE_PLACEMENT = /原文[^。\n]{0,16}(?:没有写在|未写在|没有明确说明)/;

// 稿件/标题/正文/导语 asserts (称, 写, 表述为, 框定为) something the source
// lacks (原文没有/未 + 报告/给出/说明/提及/写) or replaces (原文为 another value).
const DRAFT_ASSERTS = /(?:稿件|标题|正文|导语)(?:将[^。\n]{0,40}?)?(?:(?<!没有|未)称|表述为|框定为|(?<!没有|未)写(?!在))/;
const SOURCE_UNSUPPORTED = /原文[^。\n]{0,24}?(?:没有|未)[^。\n]{0,12}?(?:报告|给出|说明|提及|写)|原文为/;

function draftOmittedContext(text) {
  if (DRAFT_ASSERTS.test(text)) return false;
  if (DRAFT_GAP.test(text)) return true;
  return DRAFT_PLACEMENT.test(text) && !SOURCE_PLACEMENT.test(text);
}

export function isPositiveDailyFactError(error) {
  const text = String(error || '');
  return POSITIVE_FACT.test(text) || (DRAFT_ASSERTS.test(text) && SOURCE_UNSUPPORTED.test(text));
}

export function isDailyContextOmission(error) {
  const text = String(error || '');
  return !isPositiveDailyFactError(text) && draftOmittedContext(text);
}

export function dailyDraftText(draft) {
  if (!draft || typeof draft !== 'object') return '';
  const items = Array.isArray(draft.items) ? draft.items : [];
  return [draft.title, draft.intro, ...items.map(item => `${item?.heading || ''}\n${item?.body || ''}`)].join('\n');
}

// A repair that deletes a source date or source sentence already present in the
// previous draft is a regression. A span neither draft contains was never stated.
export function repairDroppedSourceSpan(error, priorText, currentText) {
  if (!priorText || !currentText) return false;
  const spans = [...String(error).matchAll(/\d{4}年\d{1,2}月\d{1,2}日(?:至(?:\d{4}年)?\d{1,2}月\d{1,2}日)?/g)].map(match => match[0]);
  for (const match of String(error).matchAll(/(?:原文|来源)[^。\n]{0,48}[“「『]([^”」』]{8,160})[”」』]/g)) spans.push(match[1]);
  return spans.some(span => priorText.includes(span) && !currentText.includes(span));
}

export function partitionDailyReviewErrors(errors, { passNumber = 0, requested = new Set(), priorText = '', currentText = '' } = {}) {
  const blocking = [], deferred = [];
  for (const error of errors || []) {
    const omission = isDailyContextOmission(error) && !isPositiveDailyFactError(error);
    const dropped = omission && repairDroppedSourceSpan(error, priorText, currentText);
    if (passNumber > 0 && omission && !requested.has(error) && !dropped) deferred.push(error);
    else blocking.push(error);
  }
  return { blocking, deferred };
}

export function deferredReviewNote(errors) {
  const parts = [...new Set(errors)].map(error => {
    const id = /^(HEADER|C\d+)：/.exec(error)?.[1] || '条目';
    const text = String(error).replace(/^(?:HEADER|C\d+)：/, '').replace(/\s+/g, '');
    return `${id}：${text.slice(0, 42)}`;
  });
  return `审稿补充（不阻断）：${parts.join('；')}`;
}
