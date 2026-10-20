// Prose inside an anchor is source text. Protect only its destination; hiding
// the whole anchor makes a faithful translation impossible for linked verbs.
// Normalize snapshots too, without fetching or changing the stored original.
export function exposeTranslationLinkText(source) {
  const document = structuredClone(source);
  for (const block of document.blocks) {
    if (block.translationPolicy === 'preserve-original' || block.type === 'reference') continue;
    for (const [field, fragmentsField] of [['text', 'fragments'], ['caption', 'captionFragments']]) {
      if (field === 'text' && !['heading', 'paragraph', 'quote', 'list_item'].includes(block.type)) continue;
      if (field === 'caption' && !['figure', 'table'].includes(block.type)) continue;
      if (typeof block[field] !== 'string') continue;
      for (const fragment of block[fragmentsField] || []) {
        if (fragment.kind || !block[field].includes(fragment.token)) continue;
        const link = /^\[([^\[\]\n]+)\]\((https?:\/\/[^\s]+)\)$/.exec(fragment.value);
        if (!link || !/\p{L}/u.test(link[1]) || /^https?:\/\//i.test(link[1])) continue;
        block[field] = block[field].replaceAll(fragment.token, `[${link[1]}](${fragment.token})`);
        fragment.value = link[2];
        fragment.kind = 'link-url';
      }
    }
  }
  return document;
}
