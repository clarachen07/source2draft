import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTranslationScope,
  datalabPageRange,
  parseTranslationScope,
  scopeLabel,
} from '../src/workflows/translation-scope.js';

test('识别中文和英文页码范围并转换为 Datalab 的零基页码', () => {
  const first = parseTranslationScope('直译前11页 https://arxiv.org/pdf/2606.26350');
  assert.deepEqual(first, { kind: 'pages', startPage: 1, endPage: 11, requestedText: '前11页' });
  assert.equal(datalabPageRange(first), '0-10');
  assert.equal(scopeLabel(first), '前 11 页');

  const range = parseTranslationScope('translate pages 4-9 https://example.com/paper.pdf');
  assert.equal(range.startPage, 4);
  assert.equal(range.endPage, 9);
  assert.equal(datalabPageRange(range), '3-8');

  const single = parseTranslationScope('只翻译第7页 https://example.com/paper.pdf');
  assert.equal(datalabPageRange(single), '6');
});

test('识别单章节和章节区间，未指定范围时返回全文', () => {
  assert.deepEqual(parseTranslationScope('直译 https://example.com/a'), { kind: 'all', requestedText: '' });
  assert.deepEqual(parseTranslationScope('只翻译第3.2节 https://example.com/a'), {
    kind: 'sections',
    start: '3.2',
    end: '3.2',
    requestedText: '只翻译第3.2节',
  });
  const range = parseTranslationScope('翻译从“Introduction”到“Methodology” https://example.com/a');
  assert.equal(range.kind, 'sections');
  assert.equal(range.start, 'Introduction');
  assert.equal(range.end, 'Methodology');
});

test('英文 translate 指令识别页码与命名章节范围', () => {
  assert.deepEqual(
    parseTranslationScope('Please translate the first 11 pages of https://example.com/a.pdf'),
    { kind: 'pages', startPage: 1, endPage: 11, requestedText: 'first 11 pages' },
  );
  const introduction = parseTranslationScope('Translate the Introduction section only https://example.com/a');
  assert.equal(introduction.kind, 'sections');
  assert.equal(introduction.start.toLowerCase(), 'introduction');
  assert.equal(introduction.end.toLowerCase(), 'introduction');
});

test('章节范围按标题边界截取并保留内部子标题', () => {
  const source = {
    blocks: [
      { id: 'b1', order: 0, type: 'heading', level: 2, text: '1 Introduction' },
      { id: 'b2', order: 1, type: 'paragraph', text: 'Intro body' },
      { id: 'b3', order: 2, type: 'heading', level: 3, text: '1.1 Background' },
      { id: 'b4', order: 3, type: 'paragraph', text: 'Background body' },
      { id: 'b5', order: 4, type: 'heading', level: 2, text: '2 Methodology' },
      { id: 'b6', order: 5, type: 'paragraph', text: 'Method body' },
      { id: 'b7', order: 6, type: 'heading', level: 2, text: '3 Results' },
      { id: 'b8', order: 7, type: 'paragraph', text: 'Results body' },
    ],
  };
  const scoped = applyTranslationScope(source, {
    kind: 'sections',
    start: '1 Introduction',
    end: '2 Methodology',
    requestedText: 'Introduction 到 Methodology',
  });
  assert.deepEqual(scoped.blocks.map((block) => block.id), ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']);
  assert.deepEqual(scoped.blocks.map((block) => block.order), [0, 1, 2, 3, 4, 5]);
  assert.equal(scoped.scope.appliedStartHeading, '1 Introduction');
  assert.equal(scoped.scope.appliedEndHeading, '2 Methodology');
});

test('数字章节请求可匹配带名称的同编号标题', () => {
  const scoped = applyTranslationScope({
    blocks: [
      { id: 'b1', order: 0, type: 'heading', level: 2, text: '3.1 Setup' },
      { id: 'b2', order: 1, type: 'paragraph', text: 'Setup body' },
      { id: 'b3', order: 2, type: 'heading', level: 2, text: '3.2 Evaluation' },
      { id: 'b4', order: 3, type: 'paragraph', text: 'Evaluation body' },
      { id: 'b5', order: 4, type: 'heading', level: 2, text: '3.3 Results' },
    ],
  }, {
    kind: 'sections',
    start: '3.2',
    end: '3.2',
  });
  assert.deepEqual(scoped.blocks.map((block) => block.id), ['b3', 'b4']);
});

test('指定章节不存在时列出可用标题并失败', () => {
  assert.throws(() => applyTranslationScope({
    blocks: [{ id: 'b1', order: 0, type: 'heading', level: 2, text: '1 Introduction' }],
  }, {
    kind: 'sections',
    start: 'Results',
    end: 'Results',
  }), /未找到指定翻译章节.*Introduction/);
});

test('补充范围覆盖旧范围，全文重置，无关补充继承范围', () => {
  const original = '翻译前3页 https://example.com/paper.pdf';
  const followup = (text) => `${original}\n\n补充指令：\n${text}`;
  assert.equal(parseTranslationScope(followup('改为翻译前5页')).endPage, 5);
  assert.equal(parseTranslationScope(followup('改为只翻译“Introduction”')).start, 'Introduction');
  assert.equal(parseTranslationScope(followup('改为全文')).kind, 'all');
  assert.equal(parseTranslationScope(followup('Translate the entire document')).kind, 'all');
  assert.equal(parseTranslationScope(followup('术语 inference 统一译为推理')).endPage, 3);
  assert.equal(parseTranslationScope(followup('改为第2节')).start, '2');
  assert.equal(parseTranslationScope(followup('改成‘Introduction’章节')).start, 'Introduction');
  assert.equal(parseTranslationScope(followup('全文')).kind, 'all');
  assert.equal(parseTranslationScope(followup('第2页里的 inference 统一译为推理，其他保持不变')).endPage, 3);
  assert.equal(parseTranslationScope(followup('标题保留原文第1页的写法')).endPage, 3);
  assert.equal(parseTranslationScope(followup('改为只翻译第2页')).startPage, 2);
  assert.equal(parseTranslationScope(`${followup('改为全文')}\n\n补充指令：\n标题改短一些`).kind, 'all');
});

test('缺失数字章节不得回退到第一标题，空标题不参加模糊匹配', () => {
  const document = { blocks: [
    { id: 'b1', type: 'heading', level: 2, text: '1 Introduction' },
    { id: 'b2', type: 'paragraph', text: 'Introduction body' },
    { id: 'b3', type: 'heading', level: 2, text: '2' },
  ] };
  assert.throws(() => applyTranslationScope(document, parseTranslationScope('翻译第9节')), /未找到指定翻译章节.*9/);
  assert.throws(() => applyTranslationScope(document, { kind: 'sections', start: '9 Introduction', end: '9 Introduction' }), /未找到指定翻译章节/);
  assert.throws(() => applyTranslationScope(document, { kind: 'sections', start: 'Methods', end: 'Methods' }), /未找到指定翻译章节/);
});
