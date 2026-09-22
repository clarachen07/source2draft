import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWechat } from '../src/channels/wechat.js';
import { openStore } from '../src/core/store.js';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082', 'hex');
function fixture(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-wechat-'));
  fs.writeFileSync(path.join(dir, 'cover.png'), png);
  const store = openStore(':memory:');
  const run = store.enqueue({ threadKey: 'C1:1', ts: '1', text: 'test', version: 1, dryRun: false }).run;
  store.update(run.id, { status: 'running' });
  let created = 0, article, mismatch = mode === 'mismatch';
  const client = createWechat({ dryRun: false, wechat: { appId: 'personal', secret: 'secret', author: '' } }, {
    fetchFn: async (url, request) => {
      if (url.includes('stable_token')) return Response.json({ access_token: 'TOKEN', expires_in: 7200 });
      if (url.includes('material/add_material')) return Response.json({ media_id: 'cover-id' });
      if (url.includes('draft/batchget')) return Response.json({ total_count: created ? 1 : 0, item: created && mode !== 'unknown' ? [{ media_id: 'draft-id', content: { news_item: [article] } }] : [] });
      if (url.includes('draft/add')) {
        created++; article = JSON.parse(request.body).articles[0];
        if (mode === 'lost' || mode === 'unknown') throw new Error('response lost');
        if (mode === 'reject') return Response.json({ errcode: 48001 });
        return Response.json({ media_id: 'draft-id' });
      }
      if (url.includes('draft/get')) return Response.json({ news_item: [{ ...article, ...(mismatch ? { content: '<p>changed</p>' } : {}) }] });
      throw new Error('Unexpected endpoint');
    },
  });
  const args = { run, store, workDir: dir, prepared: { title: '个人文章', html: '<p>真实正文</p>', coverPath: path.join(dir, 'cover.png') } };
  return { client, args, store, run, get created() { return created; }, fix: () => { mismatch = false; }, close: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
test('successful draft persists media ID before readback and does not duplicate on resume', async () => {
  const f = fixture('success');
  try {
    const result = await f.client.publish(f.args); assert.equal(result.mediaId, 'draft-id');
    assert.equal(f.store.get(f.run.id).media_id, 'draft-id');
    await f.client.publish(f.args); assert.equal(f.created, 1);
  } finally { f.close(); }
});
test('lost create response reconciles uniquely by snapshot and full content', async () => {
  const f = fixture('lost');
  try { assert.equal((await f.client.publish(f.args)).mediaId, 'draft-id'); assert.equal(f.created, 1); } finally { f.close(); }
});
test('ambiguous create never blindly retries even after resume', async () => {
  const f = fixture('unknown');
  try {
    await assert.rejects(f.client.publish(f.args), /无法唯一确认/);
    await assert.rejects(f.client.publish(f.args), /无法唯一确认/); assert.equal(f.created, 1);
  } finally { f.close(); }
});
test('readback mismatch preserves known media ID and recovers without recreation', async () => {
  const f = fixture('mismatch');
  try {
    await assert.rejects(f.client.publish(f.args), /回读内容不一致/); assert.equal(f.store.get(f.run.id).media_id, 'draft-id');
    f.fix(); await f.client.publish(f.args); assert.equal(f.created, 1);
  } finally { f.close(); }
});
test('definite platform rejection is distinguished from uncertain network failure', async () => {
  const f = fixture('reject');
  try {
    await assert.rejects(f.client.publish(f.args), /48001/); assert.equal(f.store.operation(f.run.id).state, 'rejected');
  } finally { f.close(); }
});

test('asset receipts survive interrupted uploads and client restart without changing draft idempotency', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-upload-resume-'));
  const store = openStore(':memory:');
  fs.writeFileSync(path.join(dir, 'body.png'), png);
  fs.writeFileSync(path.join(dir, 'cover.png'), png);
  const run = store.enqueue({ threadKey: 'C1:1', ts: '1', text: 'test', version: 1, dryRun: false }).run;
  store.update(run.id, { status: 'running' });
  const counts = { body: 0, cover: 0, drafts: 0 };
  let article;
  const config = { dryRun: false, wechat: { appId: 'fixture-account', secret: 'fixture-secret', author: '' } };
  const fetchFn = async (url, request) => {
    if (url.includes('stable_token')) return Response.json({ access_token: 'fixture-token', expires_in: 7200 });
    if (url.includes('media/uploadimg')) { counts.body++; return Response.json({ url: 'https://mmbiz.qpic.cn/fixture-body' }); }
    if (url.includes('material/add_material')) {
      counts.cover++;
      return Response.json(counts.cover === 1 ? { errcode: 48001 } : { media_id: 'fixture-cover' });
    }
    if (url.includes('draft/batchget')) return Response.json({ total_count: 0, item: [] });
    if (url.includes('draft/add')) {
      counts.drafts++; article = JSON.parse(request.body).articles[0]; return Response.json({ media_id: 'fixture-draft' });
    }
    if (url.includes('draft/get')) return Response.json({ news_item: [article] });
    throw new Error('unexpected fixture endpoint');
  };
  const args = { run, store, workDir: dir, prepared: { title: '回执恢复',
    html: '<p>完整文章</p><img src="body.png"><img src="body.png">', coverPath: path.join(dir, 'cover.png') },
    onTelemetry() { throw new Error('diagnostic failure must not change publishing'); } };
  try {
    await assert.rejects(createWechat(config, { fetchFn }).publish(args), /48001/);
    assert.deepEqual(counts, { body: 1, cover: 1, drafts: 0 });
    assert.equal(store.operation(run.id), undefined);
    assert.ok(fs.existsSync(path.join(dir, 'upload-receipts.json')));
    const restarted = createWechat(config, { fetchFn });
    assert.equal((await restarted.publish(args)).mediaId, 'fixture-draft');
    assert.deepEqual(counts, { body: 1, cover: 2, drafts: 1 });
    await restarted.publish(args);
    assert.deepEqual(counts, { body: 1, cover: 2, drafts: 1 });
    assert.equal(fs.statSync(path.join(dir, 'upload-receipts.json')).mode & 0o777, 0o600);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('asset receipt cache keys include account, file content and upload purpose', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-upload-scope-'));
  const store = openStore(':memory:');
  fs.writeFileSync(path.join(dir, 'image.png'), png);
  const run = store.enqueue({ threadKey: 'C1:1', ts: '1', text: 'test', version: 1, dryRun: false }).run;
  store.update(run.id, { status: 'running' });
  let uploads = 0;
  const fetchFn = async url => {
    if (url.includes('stable_token')) return Response.json({ access_token: 'fixture', expires_in: 7200 });
    if (url.includes('material/add_material')) { uploads++; return Response.json({ media_id: `cover-${uploads}` }); }
    if (url.includes('media/uploadimg')) { uploads++; return Response.json({ url: `https://mmbiz.qpic.cn/fixture-${uploads}` }); }
    if (url.includes('draft/batchget')) return Response.json({ errcode: 48001 });
    throw new Error('draft creation must not run after rejected snapshot');
  };
  const args = { run, store, workDir: dir, prepared: { title: '缓存隔离', html: '<p>正文</p><img src="image.png">', coverPath: path.join(dir, 'image.png') } };
  const client = appId => createWechat({ dryRun: false, wechat: { appId, secret: 'fixture', author: '' } }, { fetchFn });
  try {
    await assert.rejects(client('first').publish(args), /48001/); assert.equal(uploads, 2);
    await assert.rejects(client('first').publish(args), /48001/); assert.equal(uploads, 2);
    fs.writeFileSync(path.join(dir, 'image.png'), Buffer.concat([png, Buffer.from('changed-fixture-content')]));
    await assert.rejects(client('first').publish(args), /48001/); assert.equal(uploads, 4);
    await assert.rejects(client('second').publish(args), /48001/); assert.equal(uploads, 6);
    assert.equal(store.operation(run.id), undefined);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
