// The model proposes review issues. Publication blocking is decided here so an
// open-ended list of missing context cannot outlast the correction budget.
// A positive factual defect still blocks on every pass.

const POSITIVE_FACT = /写成了|误写成|误写|误标|误作|说成|写到了|张冠李戴|与原文不符|原文不符|数字不符|并不等于|不等于原文|不得声称|声称未披露|声称实盘|错称实盘|错称实测|并非真实交易|并非实盘|说成真实交易|写成真实交易|混淆了比较组|比较组(?:错误|搞错|对调|写反)|方向(?:写反|相反)|无中生有|虚构|编造/;

// The draft did not state a condition, or this pass could not verify a detail
// the draft never asserted. That is not, by itself, a contradiction.
const CONTEXT_OMISSION = /没有交代|未交代|没有说明|未说明|没有给出|未给出|没有写|未写在|遗漏|没有明确说明|本次核查未|本次未核实|本次未确认|没有在该定位|没有报告|未报告|locators未见|未见各|未见成分|范围不准确|框定为|回撤改善|标题用词/;

export function isPositiveDailyFactError(error) {
  return POSITIVE_FACT.test(String(error || ''));
}

export function isDailyContextOmission(error) {
  return CONTEXT_OMISSION.test(String(error || ''));
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
