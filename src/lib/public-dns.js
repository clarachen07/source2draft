import net from 'node:net';
import { pinnedHttpFetch } from './pinned-http.js';
import { readLimitedResponse, withDeadline } from './http-deadline.js';
import { throwIfTaskCancelled } from './task-cancellation.js';

// Bootstrap HTTPS without resolving the resolver's own hostname through the
// local DNS proxy. Keep the hostname for TLS verification and never redirect.
// https://developers.cloudflare.com/1.1.1.1/infrastructure/network-operators/
// https://developers.google.com/speed/public-dns/docs/doh/
const RESOLVERS = [
  { endpoint: 'https://cloudflare-dns.com/dns-query', address: '1.1.1.1' },
  { endpoint: 'https://dns.google/resolve', address: '8.8.8.8' },
  { endpoint: 'https://cloudflare-dns.com/dns-query', address: '1.0.0.1' },
  { endpoint: 'https://dns.google/resolve', address: '8.8.4.4' },
];

export async function lookupPublicDns(host, {
  signal,
  pinnedFetchFactory = pinnedHttpFetch,
  timeoutMs = 6000,
} = {}) {
  const failures = [];
  for (const resolver of RESOLVERS) {
    throwIfTaskCancelled(signal);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const fetchPinned = pinnedFetchFactory([{ address: resolver.address, family: 4 }]);
      return await withDeadline({ signal: combined, timeoutMs, message: '公共 DNS 请求超时' }, async (requestSignal) => {
        const answers = await Promise.all([1, 28].map(async (type) => {
          const endpoint = new URL(resolver.endpoint);
          endpoint.searchParams.set('name', host);
          endpoint.searchParams.set('type', type === 1 ? 'A' : 'AAAA');
          const response = await fetchPinned(endpoint, {
            headers: { Accept: 'application/dns-json' },
            redirect: 'error',
            signal: requestSignal,
          });
          if (!response.ok) {
            void response.body?.cancel?.().catch(() => {});
            throw new Error(`HTTP ${response.status}`);
          }
          const data = JSON.parse((await readLimitedResponse(response, 64 * 1024, requestSignal)).toString('utf8'));
          if (data.Status !== 0 || data.TC) throw new Error(`DNS 状态 ${data.Status}${data.TC ? '（截断）' : ''}`);
          if (data.Answer !== undefined && !Array.isArray(data.Answer)) throw new Error('DNS Answer 格式无效');
          return (data.Answer || []).filter(answer => answer.type === type).map(answer => {
            const family = net.isIP(answer.data);
            if (family !== (type === 1 ? 4 : 6)) throw new Error('DNS 地址格式无效');
            return { address: answer.data, family };
          });
        }));
        const addresses = answers.flat();
        if (!addresses.length) throw new Error('DNS 未返回 IP 地址');
        // Private/reserved answers are returned to the caller's safety gate.
        // Do not fall back to another provider to bypass that rejection.
        return addresses;
      });
    } catch (error) {
      throwIfTaskCancelled(signal);
      const code = error.code || error.cause?.code;
      failures.push(`${new URL(resolver.endpoint).hostname}@${resolver.address}: ${code ? `${code} ` : ''}${error.message}`);
    } finally {
      // Also stop the sibling query if one family fails or the deadline expires.
      controller.abort();
    }
  }
  throw new Error(`公共 DNS 服务均不可用（${failures.join('；')}）`);
}
