import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { fetchRetry, hash, readJson, writeAtomic } from '../lib/io.js';
import { imageType, safeLocalAsset } from '../lib/wechat-render.js';
import { emitTelemetry } from '../lib/telemetry.js';

export function contentIdentity(article) {
  const doc = new JSDOM(article.content || '').window.document;
  try {
    return JSON.stringify({ title: article.title, text: doc.body.textContent.replace(/\s+/g, ''),
      images: [...doc.querySelectorAll('img')].map(i => i.getAttribute('src')), thumb: article.thumb_media_id });
  } finally { doc.defaultView.close(); }
}
export function createWechat(config, { fetchFn = globalThis.fetch } = {}) {
  let token, tokenUntil = 0;
  async function accessToken(signal) {
    if (token && tokenUntil > Date.now()) return token;
    if (!config.wechat.appId || !config.wechat.secret) throw new Error('缺少个人公众号 AppID 或 AppSecret');
    const response = await fetchRetry(fetchFn, 'https://api.weixin.qq.com/cgi-bin/stable_token', {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credential', appid: config.wechat.appId, secret: config.wechat.secret, force_refresh: false }),
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) throw new Error(`微信公众号认证失败，错误码 ${data.errcode || response.status}；请检查个人账号凭据与后台接口配置`);
    token = data.access_token; tokenUntil = Date.now() + (data.expires_in - 120) * 1000; return token;
  }
  async function api(endpoint, body, { signal, mutation = false, form = false } = {}) {
    const t = await accessToken(signal);
    const request = { method: 'POST', signal, headers: form ? {} : { 'Content-Type': 'application/json' }, body: form ? body : JSON.stringify(body) };
    const response = await fetchRetry(fetchFn, `https://api.weixin.qq.com/cgi-bin/${endpoint}${endpoint.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(t)}`, request,
      { attempts: mutation ? 1 : 3, timeout: 30000 });
    if (!response.ok) throw new Error(`微信接口 HTTP ${response.status}`);
    const data = await response.json();
    if (data.errcode) {
      if ([40001, 40014, 42001].includes(data.errcode)) { token = null; tokenUntil = 0; }
      const error = new Error(`微信接口 ${endpoint.split('?')[0]} 错误码 ${data.errcode}`);
      error.definiteRejection = true; throw error;
    }
    return data;
  }
  async function upload(file, buffer, permanent, signal) {
    const mime = imageType(buffer);
    const form = new FormData(); form.append('media', new Blob([buffer], { type: mime }), path.basename(file));
    const data = await api(permanent ? 'material/add_material?type=image' : 'media/uploadimg', form, { signal, mutation: true, form: true });
    if (permanent ? !data.media_id : !data.url) throw new Error('微信图片上传未返回有效标识');
    return data;
  }
  async function listDrafts(signal) {
    const entries = [];
    for (let offset = 0; offset < 500; offset += 20) {
      const data = await api('draft/batchget', { offset, count: 20, no_content: 0 }, { signal });
      if (!Array.isArray(data.item) && Number(data.total_count) !== 0) throw new Error('草稿列表返回结构不正确');
      entries.push(...(data.item || []));
      if (entries.length >= Number(data.total_count) || !(data.item || []).length) return entries;
    }
    throw new Error('公众号草稿超过 500 篇，请先整理草稿箱后再进行可靠上传');
  }
  async function getDraft(mediaId, signal) {
    const data = await api('draft/get', { media_id: mediaId }, { signal });
    if (!Array.isArray(data.news_item)) throw new Error('微信草稿回读结构不正确');
    return data.news_item[0];
  }
  async function payload(prepared, workDir, signal, onTelemetry) {
    const doc = new JSDOM(prepared.html).window.document;
    const receiptPath = path.join(workDir, 'upload-receipts.json'), account = hash(config.wechat.appId);
    const saved = readJson(receiptPath);
    const receipts = saved?.version === 1 && saved.account === account && saved.uploads
      ? saved : { version: 1, account, uploads: {} };
    async function uploadedAsset(src, permanent) {
      signal?.throwIfAborted();
      const file = safeLocalAsset(src, workDir), buffer = fs.readFileSync(file);
      imageType(buffer);
      const purpose = permanent ? 'cover' : 'body', key = `${purpose}:${hash(buffer)}`;
      const existing = receipts.uploads[key], field = permanent ? 'media_id' : 'url';
      if (typeof existing?.[field] === 'string' && existing[field]) {
        emitTelemetry(onTelemetry, { stage: 'wechat.asset', cacheHit: true, count: 1 });
        return existing;
      }
      const started = performance.now();
      const data = await upload(file, buffer, permanent, signal);
      // Persist each known successful upload before doing any other remote work.
      receipts.uploads[key] = { [field]: data[field] };
      writeAtomic(receiptPath, receipts);
      emitTelemetry(onTelemetry, { stage: 'wechat.asset', cacheHit: false, count: 1, durationMs: performance.now() - started });
      return receipts.uploads[key];
    }
    try {
      for (const image of doc.querySelectorAll('img')) {
        image.setAttribute('src', (await uploadedAsset(image.getAttribute('src'), false)).url);
      }
      const cover = await uploadedAsset(prepared.coverPath, true);
      return { title: prepared.title, author: config.wechat.author, digest: doc.body.textContent.trim().slice(0, 100),
        content: doc.body.innerHTML, thumb_media_id: cover.media_id, need_open_comment: 0, only_fans_can_comment: 0 };
    } finally { doc.defaultView.close(); }
  }
  async function publish({ run, store, prepared, workDir, signal, onTelemetry }) {
    if (config.dryRun || run.dry_run) throw new Error('模拟模式禁止调用微信写入');
    let op = store.operation(run.id);
    if (!op) {
      const article = await payload(prepared, workDir, signal, onTelemetry);
      const snapshot = (await listDrafts(signal)).map(d => d.media_id);
      signal?.throwIfAborted();
      store.beginPublish(run, article, snapshot);
      // The remote mutation is not cancelled after dispatch; its result must first be persisted.
      try {
        const data = await api('draft/add', { articles: [article] }, { mutation: true });
        if (!data.media_id) throw new Error('微信未返回 media_id，上传结果待核对');
        store.remoteCreated(run.id, data.media_id);
      } catch (error) {
        if (error.definiteRejection) { store.rejectPublish(run.id); throw error; }
        // Response loss: reconcile once, never blindly create again.
      }
      op = store.operation(run.id);
    }
    const expected = JSON.parse(op.payload);
    if (!op.media_id) {
      const before = new Set(JSON.parse(op.snapshot));
      const candidates = (await listDrafts()).filter(d => !before.has(d.media_id)
        && contentIdentity(d.content?.news_item?.[0] || {}) === contentIdentity(expected));
      if (candidates.length !== 1) {
        const error = new Error(`公众号上传结果无法唯一确认（匹配 ${candidates.length} 篇），已暂停；请检查草稿箱后重试核对`);
        error.needsReview = true; throw error;
      }
      store.remoteCreated(run.id, candidates[0].media_id); op = store.operation(run.id);
    }
    const readback = await getDraft(op.media_id);
    if (contentIdentity(readback) !== contentIdentity(expected)) {
      const error = new Error(`草稿已创建，但回读内容不一致；media_id=${op.media_id}，请人工核对`);
      error.needsReview = true; throw error;
    }
    return { mediaId: op.media_id, title: expected.title };
  }
  return { accessToken, listDrafts, getDraft, publish };
}
