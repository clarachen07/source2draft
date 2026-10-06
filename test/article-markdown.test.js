import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderArticleMarkdown } from '../src/lib/article-markdown.js';
import { validateArticleLinks } from '../src/workflows/analysis.js';

test('中文引号和句末标点不进入裸链接，核验与最终呈现使用同一目标', () => {
  const url = 'https://arxiv.org/abs/2106.09685';
  for (const punctuation of ['」。报告写到', '』继续阅读', '】可以查看', '。正文', '，正文', '；正文', '！正文', '？正文', '、正文']) {
    const body = `例如「${url}${punctuation}`;
    assert.doesNotThrow(() => validateArticleLinks(body, [{ url }]));
    const dom = new JSDOM(renderArticleMarkdown(body));
    try {
      assert.equal(dom.window.document.querySelector('a').getAttribute('href'), url);
      assert.equal(dom.window.document.body.textContent.trim(), body);
    } finally { dom.window.close(); }
  }
});

test('中文边界前的括号和英文标点保留原有 GFM 规则，查询参数和片段不丢失', () => {
  const url = 'https://example.org/a(qat)?x=1&y=2#section';
  const body = `(${url}).。正文`;
  assert.doesNotThrow(() => validateArticleLinks(body, [{ url }]));
  const dom = new JSDOM(renderArticleMarkdown(body));
  try { assert.equal(dom.window.document.querySelector('a').getAttribute('href'), url); }
  finally { dom.window.close(); }
});

test('显式链接、HTML 目标和代码不截断，未核验链接及同前缀的其他目标仍拒绝', () => {
  const url = 'https://example.org/a';
  for (const body of [
    `[链接](${url}」。正文)`,
    `[链接][ref]\n\n[ref]: <${url}。正文>`,
    `<a href="${url}。正文">链接</a>`,
    `${url}/other」。正文`, `${url}?other=1。正文`, `${url}#other。正文`,
    'https://unverified.example/paper」。正文',
  ]) assert.throws(() => validateArticleLinks(body, [{ url }]), /未经证据验证/);
  const body = `\`${url}」。正文\`\n\n\`\`\`text\n${url}」。正文\n\`\`\``;
  const dom = new JSDOM(renderArticleMarkdown(body));
  try {
    assert.equal(dom.window.document.querySelectorAll('a').length, 0);
    assert.ok([...dom.window.document.querySelectorAll('code')].every(code => code.textContent.includes('」。正文')));
  } finally { dom.window.close(); }
  const explicit = 'https://example.org/中文。路径';
  assert.doesNotThrow(() => validateArticleLinks(`[中文路径](<${explicit}>)`, [{ url: explicit }]));
});
