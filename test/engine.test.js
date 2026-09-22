import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseTranslationSource, chooseCover, findPreviousArticle } from '../src/core/engine.js';
import { loadConfig } from '../src/config/index.js';
import { openStore } from '../src/core/store.js';
import { writeAtomic } from '../src/lib/io.js';

const config = loadConfig({ SLACK_BOT_TOKEN: 'fixture-token' });
const follow = (first, next) => `${first}\n\n补充指令：\n${next}`;
const run = (input, files = []) => ({ input, attachments: JSON.stringify(files) });

test('latest explicit source replaces old URL while unrelated editing instructions preserve it', () => {
  const original = '直译 https://example.org/old';
  assert.equal(chooseTranslationSource(run(follow(original, '改为翻译 https://example.org/new')), config).sourceUrl, 'https://example.org/new');
  assert.equal(chooseTranslationSource(run(follow(original, '保留作者原有语气和段落')), config).sourceUrl, 'https://example.org/old');
  assert.equal(chooseTranslationSource(run(follow(original, '封面：https://example.org/cover.png')), config).sourceUrl, 'https://example.org/old');
  assert.equal(chooseTranslationSource(run(follow(original, 'https://example.org/new')), config).sourceUrl, 'https://example.org/new');
});

test('latest named PDF replaces old URL and ambiguous replacement asks instead of using old source', () => {
  const files = ['one.pdf', 'two.pdf'].map((name, i) => ({ id: `F${i}`, name,
    mimetype: 'application/pdf', url: `https://files.slack.com/${name}` }));
  const original = '直译 https://example.org/old';
  const selected = chooseTranslationSource(run(follow(original, '改为翻译 two.pdf'), files), config);
  assert.equal(selected.sourceUrl, files[1].url);
  assert.equal(selected.sourceRequestHeaders.Authorization, 'Bearer fixture-token');
  assert.throws(() => chooseTranslationSource(run(follow(original, '改为翻译附件'), files), config), error => error.needsInput === true);
  assert.throws(() => chooseTranslationSource(run(follow(original, '翻译 https://example.org/a 或 https://example.org/b')), config), error => error.needsInput === true);
});

test('cover revisions select the latest explicit URL or image, with balanced URL punctuation', () => {
  const files = [{ id: 'F1', name: 'new.png', mimetype: 'image/png', url: 'https://files.slack.com/new.png' }];
  const original = '直译 https://example.org/article\n封面：https://example.org/old.png';
  assert.equal(chooseCover(run(follow(original, '封面：https://example.org/new_(cover).png')), config).url, 'https://example.org/new_(cover).png');
  assert.equal(chooseCover(run(follow(original, '封面改用 new.png'), files), config).url, files[0].url);
  assert.equal(chooseCover(run(follow(original, '保留所有图片')), config).url, 'https://example.org/old.png');
  const changed = run(follow(original, '把封面改成 https://example.org/new.png'));
  assert.equal(chooseCover(changed, config).url, 'https://example.org/new.png');
  assert.equal(chooseTranslationSource(changed, config).sourceUrl, 'https://example.org/article');
});

test('file selection does not confuse URL filenames or suffixes of longer filenames', () => {
  const files = ['paper.pdf', 'updated-paper.pdf'].map((name, i) => ({ id: `F${i}`, name,
    mimetype: 'application/pdf', url: `https://files.slack.com/${name}` }));
  assert.equal(chooseTranslationSource(run('直译 https://example.org/paper.pdf', files), config).sourceUrl, 'https://example.org/paper.pdf');
  assert.equal(chooseTranslationSource(run('改用 updated-paper.pdf', files), config).sourceUrl, files[1].url);
  const images = ['cover.png', 'updated-cover.png'].map((name, i) => ({ id: `I${i}`, name,
    mimetype: 'image/png', url: `https://files.slack.com/${name}` }));
  assert.equal(chooseCover(run('封面改用 updated-cover.png', images), config).url, images[1].url);
});

test('consecutive revisions find the nearest ancestor article and never cross task threads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-ancestor-'));
  const store = openStore(':memory:');
  const workDirFor = id => path.join(dir, id);
  const enqueue = (ts, text) => store.enqueue({ threadKey: 'C:1', ts, version: Number(ts), text, dryRun: true }).run;
  try {
    const first = enqueue('1', '第一篇');
    store.update(first.id, { status: 'done' });
    writeAtomic(path.join(workDirFor(first.id), 'artifact.json'), { article: '完整旧成稿' });
    const second = enqueue('2', '增加解释');
    const third = enqueue('3', '再修改结尾');
    assert.equal(findPreviousArticle(third, store, workDirFor), '完整旧成稿');
    writeAtomic(path.join(workDirFor(second.id), 'artifact.json'), { article: '较新完整成稿' });
    assert.equal(findPreviousArticle(third, store, workDirFor), '较新完整成稿');
    assert.equal(findPreviousArticle({ ...third, thread_key: 'C:other' }, store, workDirFor), '');
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
