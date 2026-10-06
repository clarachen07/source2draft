import { Marked, Tokenizer } from 'marked';

// GFM bare URLs otherwise swallow Chinese sentence punctuation and everything
// after it. Share this tokenizer between the evidence gate and final rendering.
// Explicit Markdown/HTML links and code retain their original destinations.
const parser = new Marked({ gfm: true }, {
  tokenizer: {
    url(src) {
      const token = Tokenizer.prototype.url.call(this, src);
      if (!token || !/^https?:/i.test(token.raw)) return false;
      const boundary = token.raw.search(/[」』】。，；！？、]/u);
      if (boundary < 0) return false;
      // Run the original tokenizer again to retain its handling of unmatched
      // parentheses and ASCII punctuation immediately before the boundary.
      return Tokenizer.prototype.url.call(this, token.raw.slice(0, boundary));
    },
  },
});

export function renderArticleMarkdown(markdown) {
  return parser.parse(markdown);
}
