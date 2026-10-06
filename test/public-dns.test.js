import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { lookupPublicDns } from '../src/lib/public-dns.js';
import { pinnedHttpFetch } from '../src/lib/pinned-http.js';
import { safeFetchResource } from '../src/workflows/translation-source-text.js';

const syntheticDns = async () => [{ address: '198.18.0.206', family: 4 }];
function dnsResponse(url, address = '140.82.121.6') {
  const type = new URL(url).searchParams.get('type');
  return Response.json({ Status: 0, TC: false, Answer: type === 'A' ? [{ type: 1, data: address }] : [] });
}

test('DoH 自举固定官方 IP 并保留 HTTPS 主机，不依赖合成 DNS 或携带业务凭据', async () => {
  const calls = [];
  const records = await lookupPublicDns('api.github.com', {
    pinnedFetchFactory: addresses => async (url, options) => {
      calls.push({ addresses, url: new URL(url), options });
      return dnsResponse(url);
    },
  });
  assert.deepEqual(records, [{ address: '140.82.121.6', family: 4 }]);
  assert.equal(calls.length, 2);
  for (const { addresses, url, options } of calls) {
    assert.deepEqual(addresses, [{ address: '1.1.1.1', family: 4 }]);
    assert.equal(url.origin, 'https://cloudflare-dns.com');
    assert.equal(url.pathname, '/dns-query');
    assert.equal(url.searchParams.get('name'), 'api.github.com');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { Accept: 'application/dns-json' });
  }
  assert.deepEqual(calls.map(call => call.url.searchParams.get('type')), ['A', 'AAAA']);
});

test('主解析器 fetch failed 时切换 Google 的正确 JSON 路径，最终下载固定真实公网地址', async () => {
  const queried = [];
  let pinnedDownload;
  const publicDnsLookup = (host, options) => lookupPublicDns(host, {
    ...options,
    pinnedFetchFactory: addresses => async (url) => {
      queried.push(new URL(url));
      if (addresses[0].address === '1.1.1.1') throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
      assert.equal(new URL(url).pathname, '/resolve');
      return dnsResponse(url);
    },
  });
  const result = await safeFetchResource({
    url: 'https://api.github.com/repos/example/skill/readme',
    dnsLookup: syntheticDns, publicDnsLookup,
    pinnedFetchFactory: addresses => {
      pinnedDownload = addresses;
      return async () => new Response('source');
    },
  });
  assert.deepEqual(pinnedDownload, [{ address: '140.82.121.6', family: 4 }]);
  assert.deepEqual(queried.map(url => url.hostname), ['cloudflare-dns.com', 'cloudflare-dns.com', 'dns.google', 'dns.google']);
  assert.equal(result.buffer.toString(), 'source');
});

test('备用自举地址可恢复连接，所有入口失败时保留网络错误原因', async () => {
  const attempted = [];
  assert.deepEqual(await lookupPublicDns('api.github.com', {
    pinnedFetchFactory: addresses => async url => {
      attempted.push(addresses[0].address);
      if (addresses[0].address !== '1.0.0.1') throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
      return dnsResponse(url);
    },
  }), [{ address: '140.82.121.6', family: 4 }]);
  assert.deepEqual([...new Set(attempted)], ['1.1.1.1', '8.8.8.8', '1.0.0.1']);
  await assert.rejects(() => lookupPublicDns('api.github.com', {
    pinnedFetchFactory: () => async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); },
  }), error => /服务均不可用/.test(error.message) && /ECONNRESET/.test(error.message) && /8\.8\.4\.4/.test(error.message));
});

test('成功解析的私网、合成地址和混合 IPv6 结果仍拦截，不能借备用解析器绕过', async () => {
  for (const address of ['10.1.2.3', '198.18.0.206', '169.254.169.254', '140.82.121.6']) {
    let queries = 0, downloaded = false;
    await assert.rejects(() => safeFetchResource({
      url: 'https://api.github.com/a', dnsLookup: syntheticDns,
      publicDnsLookup: (host, options) => lookupPublicDns(host, {
        ...options,
        pinnedFetchFactory: () => async url => {
          queries++;
          if (address === '140.82.121.6' && new URL(url).searchParams.get('type') === 'AAAA') {
            return Response.json({ Status: 0, Answer: [{ type: 28, data: 'fd00::1' }] });
          }
          return dnsResponse(url, address);
        },
      }),
      pinnedFetchFactory: () => async () => { downloaded = true; return new Response('must not download'); },
    }), /公共 DNS 未返回安全公网地址/);
    assert.equal(queries, 2);
    assert.equal(downloaded, false);
  }
});

test('DNS 无地址、错误状态、截断、错误地址和超限响应均不能放行下载', async () => {
  const responses = [
    () => Response.json({ Status: 0, Answer: [] }),
    () => Response.json({ Status: 3 }),
    () => Response.json({ Status: 0, TC: true }),
    () => Response.json({ Status: 0, Answer: [{ type: 1, data: 'not-an-ip' }] }),
    () => Response.json({ Status: 0, Answer: [{ type: 1, data: '2606:4700:4700::1111' }] }),
    () => Response.json({ Status: 0, Answer: {} }),
    () => new Response('x'.repeat(64 * 1024 + 1)),
    () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/' } }),
  ];
  for (const response of responses) await assert.rejects(() => lookupPublicDns('api.github.com', {
    pinnedFetchFactory: () => async () => response(),
  }), /公共 DNS 服务均不可用/);
});

test('DNS 响应体超时会取消两种地址族请求并切换备用入口', async () => {
  const signals = [];
  const records = await lookupPublicDns('api.github.com', {
    timeoutMs: 20,
    pinnedFetchFactory: addresses => async (url, { signal }) => {
      if (addresses[0].address !== '1.1.1.1') return dnsResponse(url);
      signals.push(signal);
      return new Response(new ReadableStream({ start() {} }));
    },
  });
  assert.deepEqual(records, [{ address: '140.82.121.6', family: 4 }]);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
});

test('安全下载整体超时和任务取消均传入 DoH，不继续发起备用请求', async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const reason = new Error('task cancelled');
    let queries = 0;
    const signals = [];
    const pending = safeFetchResource({
      url: 'https://api.github.com/a', dnsLookup: syntheticDns,
      signal: controller.signal, limits: { fetchTimeoutMs: 20 },
      publicDnsLookup: (host, options) => lookupPublicDns(host, {
        ...options,
        pinnedFetchFactory: () => async (_url, { signal }) => {
          queries++;
          signals.push(signal);
          if (cancelled) queueMicrotask(() => controller.abort(reason));
          return new Promise(() => {});
        },
      }),
    });
    if (cancelled) await assert.rejects(pending, error => error === reason);
    else await assert.rejects(pending, /原文下载超时/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queries, 2);
    assert.ok(signals.every(signal => signal.aborted));
  }
});

test('真实 HTTP 传输连接固定地址且保留原始 Host，无需再次解析域名', async t => {
  const server = http.createServer((request, response) => response.end(request.headers.host));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port } = server.address();
  const response = await pinnedHttpFetch([{ address: '127.0.0.1', family: 4 }])(`http://unresolvable.invalid:${port}/`, {
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(await response.text(), `unresolvable.invalid:${port}`);
});
