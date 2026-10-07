const SEPARATOR = /\n\n补充指令：\n/;
const isolatedValue = value => !/(?:[，,；;。\s](?:并|同时|然后|再|且)|并(?:将|把|精简|修改|改写|翻译|压缩)|同时|并且|顺便|然后|(?:精简|改写|重译|扩写|删减|增加|缩短|润色)(?:正文|全文|内容))/.test(value);
const unquote = value => value.trim().replace(/^[“”"'「」`《》]+|[“”"'「」`。《》]+$/g, '');

// Recognize only explicit, isolated edits. Everything else stays a global
// content instruction and invalidates the affected translation safely.
export function translationRequirements(input = '') {
  const content = [], terms = new Map();
  let title = null, refresh = false, refreshRequest;
  const parts = String(input).split(SEPARATOR);
  for (const [partIndex, part] of parts.entries()) {
    const lines = part.split('\n');
    for (const [lineIndex, raw] of lines.entries()) {
      const line = raw.trim();
      if (!line) continue;
      if (/^(?:请)?(?:重新获取|重新下载|刷新)(?:一下)?(?:原文|来源|材料)[。！!]?$/i.test(line)) { refresh = true; refreshRequest = { parts: parts.slice(0, partIndex), lines: lines.slice(0, lineIndex + 1) }; continue; }
      const heading = /^(?:请)?(?:把)?(?:文章)?标题\s*(?:改成|改为|设为|换成|[:：])\s*(.+)$/i.exec(line);
      if (heading && isolatedValue(heading[1])) { title = unquote(heading[1]); continue; }
      const cover = /^(?:请)?(?:把)?(?:文章)?封面(?:图片|图)?\s*(?:改成|换成|改为|换为|改用|换用|使用|设为|用|[:：])\s*(.+)$/i.exec(line);
      if (cover && isolatedValue(cover[1])) continue;
      const term = /^(?:请)?(?:术语[:：]?\s*)?(.{1,80}?)\s*(?:统一)?(?:译为|翻译为|翻译成|改译为|统一为|->|→)\s*(.{1,80})$/i.exec(line);
      if (term && isolatedValue(term[2]) && (/术语/.test(line) || !/^(?:文章|正文|全文|内容|整体|这段|这篇|这个|上文|原文)/.test(term[1]))) {
        terms.set(unquote(term[1]), unquote(term[2])); continue;
      }
      content.push(line);
    }
  }
  return { body: content.join('\n'), title, terms: [...terms].map(([from, to]) => ({ from, to })), refresh, refreshRequest };
}
export function instructionsForUnit(requirements, unit, previous = '', neighbors = []) {
  const text = [unit.text, previous, ...neighbors.map(item => item.text)].join('\n').toLowerCase();
  const terms = requirements.terms.filter(term => text.includes(term.from.toLowerCase()) || text.includes(term.to.toLowerCase()));
  return [requirements.body, unit.id === 'meta:title' && requirements.title ? `标题使用：${requirements.title}` : '',
    ...terms.map(term => `术语 ${term.from} 统一译为${term.to}`)].filter(Boolean).join('\n');
}
