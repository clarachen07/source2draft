import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAnalysis } from '../src/workflows/analysis.js';
import { safeFetchResource } from '../src/workflows/translation-source-text.js';
import { loadConfig } from '../src/config/index.js';

const PAPER = 'https://arxiv.org/abs/2106.09685';
function fixture(text, body) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source2draft-material-links-'));
  const traceFile = path.join(workDir, 'research-trace.json');
  fs.writeFileSync(traceFile, JSON.stringify({
    userSources: [{ title: 'README', url: 'https://example.org/material', text, kind: 'user' }],
    plan: { exclusiveSources: true, clarification: '', queries: [] }, searchResults: [],
    draft: { title: '材料原有链接', body, sourceIds: ['S1'] },
  }));
  const inspected = [], roles = [];
  const args = {
    run: { input: '只根据提供材料介绍用法，不额外搜索。', attachments: '[]' }, config: loadConfig({}), workDir,
    progress() {}, signal: new AbortController().signal,
    read: async () => { throw new Error('must reuse material'); },
    fetchFn: async () => { throw new Error('must not search'); },
    model: { json: async ({ role }) => { roles.push(role); assert.equal(role, 'review'); return { issues: [] }; } },
    inspectLink: async request => {
      inspected.push(request.url);
      assert.equal(request.headersOnly, true);
      return { status: 200, finalUrl: request.url, buffer: Buffer.from('TARGET TEXT MUST NOT BECOME EVIDENCE') };
    },
  };
  return { args, inspected, roles,
    read: () => JSON.parse(fs.readFileSync(traceFile)),
    save: trace => fs.writeFileSync(traceFile, JSON.stringify(trace)),
    close: () => fs.rmSync(workDir, { recursive: true, force: true }),
  };
}

test('README 代码示例中的原始网址通过安全访问核验，记录来源并在重试时复用', async () => {
  const f = fixture(`## Usage\n\n\`\`\`text\nHelp me reproduce this paper: ${PAPER}\n\`\`\``,
    `材料说明：新会话输入「Help me reproduce this paper: ${PAPER}」。报告会写入指定目录。`);
  try {
    const first = await runAnalysis(f.args);
    assert.ok(first.article.includes(PAPER));
    assert.deepEqual(f.inspected, [PAPER]);
    const trace = f.read(), receipt = Object.values(trace.linkChecks.checks)[0];
    assert.deepEqual(receipt.sourceIds, ['S1']);
    assert.equal(receipt.status, 200);
    assert.equal(receipt.evidenceUse, 'reference-only');
    assert.ok(Number.isFinite(Date.parse(receipt.checkedAt)));
    assert.equal(trace.sources.length, 1);
    assert.doesNotMatch(JSON.stringify(trace), /TARGET TEXT MUST NOT BECOME EVIDENCE/);
    const second = await runAnalysis(f.args);
    assert.equal(second.article, first.article);
    assert.deepEqual(f.inspected, [PAPER]);
    assert.deepEqual(f.roles, ['review']);
  } finally { f.close(); }
});

test('材料中的显式 Markdown、HTML、正文及内联代码链接按精确目标核验', async () => {
  const url = 'https://example.org/a(qat)?x=1&y=2#section';
  const samples = [
    `[资源](<${url}>)`,
    `[资源][ref]\n\n[ref]: <${url}>`,
    `<a href="${url.replace('&', '&amp;')}">资源</a>`,
    `示例「${url}」。后续说明`,
    `用法：\`${url}\``,
  ];
  for (const text of samples) {
    const f = fixture(text, `材料提供的资源是 [原始资源](<${url}>)，本文仅介绍材料中的用法。`);
    try {
      await runAnalysis(f.args);
      assert.deepEqual(f.inspected, [url]);
    } finally { f.close(); }
  }
});

test('来源正文未给出的链接、标题中的链接及占位符推导在联网前仍拦截', async () => {
  for (const url of [`${PAPER}/extra`, `${PAPER}?new=1`, `${PAPER}#new`, 'https://unverified.example/report', 'https://arxiv.org/abs/2302.13971']) {
    const f = fixture(`材料提供 ${PAPER}；另一个示例占位符 https://arxiv.org/abs/XXXX.XXXXX`,
      `这是一篇根据材料撰写的介绍，错误引用了 [资源](<${url}>)。`);
    try {
      const trace = f.read(); trace.userSources[0].title += ` ${url}`; f.save(trace);
      await assert.rejects(runAnalysis(f.args), /未经证据验证的链接/);
      assert.equal(f.inspected.length, 0);
      assert.equal(f.read().approvedReview, undefined);
    } finally { f.close(); }
  }
});

test('HTTP 核验失败时不批准成稿；部分成功结果立即保存且后续只补缺失链接', async () => {
  const second = 'https://example.org/second';
  const f = fixture(`${PAPER}\n\n${second}`, `材料列出了 ${PAPER}。另一个资源是 ${second}。二者均用于示例。`);
  let failing = true;
  const inspect = f.args.inspectLink;
  f.args.inspectLink = async request => {
    if (request.url === second && failing) { f.inspected.push(second); throw new Error('HTTP 404'); }
    return inspect(request);
  };
  try {
    await assert.rejects(runAnalysis(f.args), /HTTP 404/);
    assert.equal(f.read().approvedReview, undefined);
    assert.equal(Object.values(f.read().linkChecks.checks).length, 1);
    failing = false;
    await runAnalysis(f.args);
    assert.deepEqual(f.inspected, [PAPER, second, second]);
    assert.equal(Object.values(f.read().linkChecks.checks).length, 2);
  } finally { f.close(); }
});

test('证据变化和损坏核验记录不能复用旧批准；缺失材料原有链接重新拦截', async () => {
  const f = fixture(`示例：${PAPER}`, `README 的用法示例引用 ${PAPER}。本文原样说明这个示例。`);
  try {
    await runAnalysis(f.args);
    let trace = f.read(); trace.userSources[0].text += ' 新版本说明。'; f.save(trace);
    await runAnalysis(f.args);
    assert.deepEqual(f.inspected, [PAPER, PAPER]);
    trace = f.read(); for (const receipt of Object.values(trace.linkChecks.checks)) receipt.status = 404; f.save(trace);
    await runAnalysis(f.args);
    assert.deepEqual(f.inspected, [PAPER, PAPER, PAPER]);
    trace = f.read(); trace.userSources[0].text = '新材料没有示例网址。'; f.save(trace);
    await assert.rejects(runAnalysis(f.args), /未经证据验证的链接/);
    assert.deepEqual(f.inspected, [PAPER, PAPER, PAPER]);
    assert.equal(f.read().approvedReview, undefined);
  } finally { f.close(); }
});

test('网络已成功但任务取消时不保存核验成功或批准成稿', async () => {
  const f = fixture(`用法：${PAPER}`, `材料给出的原始示例是 ${PAPER}。这里只介绍使用方式。`);
  const controller = new AbortController(); f.args.signal = controller.signal;
  f.args.inspectLink = async request => {
    controller.abort(new Error('用户停止任务'));
    return { status: 200, finalUrl: request.url };
  };
  try {
    await assert.rejects(runAnalysis(f.args), /用户停止任务/);
    assert.equal(f.read().approvedReview, undefined);
    assert.equal(Object.values(f.read().linkChecks?.checks || {}).length, 0);
  } finally { f.close(); }
});

test('只核验响应头时取消大响应正文，不读取或保存目标文件', async () => {
  let cancelled = false, read = false;
  const result = await safeFetchResource({
    url: 'https://example.org/large-model', headersOnly: true,
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchFn: async () => ({ status: 200, ok: true, headers: new Headers({ 'content-length': '5000000000' }),
      body: { cancel: async () => { cancelled = true; } }, arrayBuffer() { read = true; throw new Error('must not read'); } }),
  });
  assert.equal(cancelled, true);
  assert.equal(read, false);
  assert.equal(result.status, 200);
  assert.equal(result.buffer, undefined);
});

test('响应头核验仍拒绝私网、私网重定向和失败状态，跨域重定向去掉认证', async () => {
  const dnsLookup = async host => [{ address: host === 'private.example' ? '10.0.0.1' : '93.184.216.34', family: 4 }];
  const requests = [];
  const request = { url: 'https://example.org/source', headersOnly: true, dnsLookup,
    headers: { Authorization: 'fixture-token' }, fetchFn: async (url, options) => {
      requests.push({ url, headers: options.headers });
      return url.endsWith('/source') ? new Response(null, { status: 302, headers: { Location: 'https://cdn.example/final' } }) : new Response('unused');
    } };
  assert.equal((await safeFetchResource(request)).finalUrl, 'https://cdn.example/final');
  assert.equal(requests[0].headers.Authorization, 'fixture-token');
  assert.equal(requests[1].headers.Authorization, undefined);
  for (const url of ['https://private.example/source', 'http://127.0.0.1/source']) {
    await assert.rejects(safeFetchResource({ ...request, url }), /私网或保留地址/);
  }
  await assert.rejects(safeFetchResource({ ...request, fetchFn: async () => new Response(null, {
    status: 302, headers: { Location: 'http://169.254.169.254/' },
  }) }), /私网或保留地址/);
  await assert.rejects(safeFetchResource({ ...request, fetchFn: async () => new Response(null, { status: 404 }) }), /原文获取失败:404/);
});
