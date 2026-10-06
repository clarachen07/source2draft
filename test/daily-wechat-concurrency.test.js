import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWechat } from '../src/channels/wechat.js';
import { openStore } from '../src/core/store.js';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082', 'hex');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function tasks() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source2draft-parallel-wechat-'));
  const store = openStore(':memory:');
  const args = ['first', 'second'].map(name => {
    const run = store.enqueue({ threadKey: `local:${name}`, ts: '1', version: 1, text: name, dryRun: false }).run;
    store.update(run.id, { status: 'running' });
    const workDir = path.join(directory, name); fs.mkdirSync(workDir);
    const coverPath = path.join(workDir, 'cover.png'); fs.writeFileSync(coverPath, png);
    return { run, store, workDir, prepared: { title: name, html: `<p>${name}</p>`, coverPath } };
  });
  return { args, store, close: () => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('parallel task draft snapshots and full upload flows are serialized until readback', { timeout: 3000 }, async () => {
  const f = tasks(), readbackEntered = deferred(), releaseReadback = deferred();
  const drafts = new Map(); let materialUploads = 0;
  const client = createWechat({ dryRun: false, wechat: { appId: 'fixture-app', secret: 'fixture-secret', author: '' } }, {
    fetchFn: async (url, options) => {
      if (url.includes('stable_token')) return Response.json({ access_token: 'fixture-token', expires_in: 7200 });
      if (url.includes('material/add_material')) { materialUploads++; return Response.json({ media_id: 'fixture-cover' }); }
      if (url.includes('draft/batchget')) return Response.json({ total_count: drafts.size,
        item: [...drafts].map(([media_id, article]) => ({ media_id, content: { news_item: [article] } })) });
      if (url.includes('draft/add')) {
        const article = JSON.parse(options.body).articles[0], media_id = `draft-${article.title}`;
        drafts.set(media_id, article); return Response.json({ media_id });
      }
      if (url.includes('draft/get')) {
        const { media_id } = JSON.parse(options.body);
        if (media_id === 'draft-first') { readbackEntered.resolve(); await releaseReadback.promise; }
        return Response.json({ news_item: [drafts.get(media_id)] });
      }
      assert.fail('Unexpected WeChat endpoint');
    },
  });
  try {
    const first = client.publish(f.args[0]); await readbackEntered.promise;
    const second = client.publish(f.args[1]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(materialUploads, 1);
    assert.equal(drafts.size, 1);
    releaseReadback.resolve(); await Promise.all([first, second]);
    assert.equal(drafts.size, 2);
    assert.deepEqual(JSON.parse(f.store.operation(f.args[0].run.id).snapshot), []);
    assert.deepEqual(JSON.parse(f.store.operation(f.args[1].run.id).snapshot), ['draft-first']);
  } finally { releaseReadback.resolve(); f.close(); }
});

test('an unresolved identical task blocks a later create rather than stealing its remote identity', async () => {
  const f = tasks(); let creates = 0;
  f.args[1].prepared.title = f.args[0].prepared.title;
  f.args[1].prepared.html = f.args[0].prepared.html;
  const client = createWechat({ dryRun: false, wechat: { appId: 'fixture-app', secret: 'fixture-secret', author: '' } }, {
    fetchFn: async url => {
      if (url.includes('stable_token')) return Response.json({ access_token: 'fixture-token', expires_in: 7200 });
      if (url.includes('material/add_material')) return Response.json({ media_id: 'fixture-cover' });
      if (url.includes('draft/batchget')) return Response.json({ total_count: 0, item: [] });
      if (url.includes('draft/add')) { creates++; throw new Error('fixture: response lost'); }
      assert.fail('Unexpected WeChat endpoint');
    },
  });
  try {
    await assert.rejects(client.publish(f.args[0]), error => error.needsReview === true);
    await assert.rejects(client.publish(f.args[1]), /相同内容.*尚未确认/);
    assert.equal(creates, 1);
    assert.equal(f.store.operation(f.args[1].run.id), undefined);
  } finally { f.close(); }
});
