const FOLLOWUP_SEPARATOR = '\n\n补充指令：\n';

export function sourcePolicy(input, plannedExclusive) {
  let exclusive = plannedExclusive;
  const instructions = input.split(FOLLOWUP_SEPARATOR);
  for (const [index, instruction] of instructions.entries()) {
    const only = /(?:仅|只)(?:能|可)?(?:依据|根据|使用|用|参考|基于|分析|阅读|看)[\s\S]{0,45}(?:材料|链接|原文|附件)|(?:禁止|不要|不得|无需|不必|不允许|不可以|不)(?:进行)?(?:额外|扩展|联网|上网|在线)?(?:搜索|检索)|(?:禁止|不得|不要|不允许|不可以|不)(?:再)?(?:联网|上网)|(?:use|using|based on) only|only (?:use|using|rely on)|do not (?:search|browse)|no (?:web|online) (?:search|browsing)/i.test(instruction);
    const allow = /(?:可以|允许|请|需要)(?:再|进行)?(?:额外|扩展|联网|上网|在线)(?:搜索|检索)|(?:可以|允许)(?:联网|上网)|(?:also|may|can) (?:search|browse)|(?:allow|enable) (?:web|online) (?:search|browsing)/i.test(instruction);
    if (only) exclusive = true;
    // An older permission cannot override a restriction the planner detected in
    // newer wording that this deliberately limited recognizer does not understand.
    else if (allow && (!plannedExclusive || index === instructions.length - 1)) exclusive = false;
  }
  return exclusive;
}
