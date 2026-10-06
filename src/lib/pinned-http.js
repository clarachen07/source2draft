import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

// Callers must validate addresses before constructing this transport. The URL
// hostname remains intact for Host, TLS SNI and certificate verification.
export function pinnedHttpFetch(addresses) {
  const safeAddresses = addresses.map((record) => ({ address: record.address, family: record.family }));
  return async function fetchPinned(rawUrl, options = {}) {
    const target = new URL(rawUrl);
    const transport = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request(target, {
        method: options.method || 'GET',
        headers: options.headers,
        signal: options.signal,
        lookup(_hostname, lookupOptions, callback) {
          const wantedFamily = Number(lookupOptions?.family) || 0;
          const candidates = wantedFamily
            ? safeAddresses.filter((record) => record.family === wantedFamily)
            : safeAddresses;
          const selected = candidates[0] || safeAddresses[0];
          if (!selected) {
            callback(Object.assign(new Error('安全 DNS 结果为空'), { code: 'ENOTFOUND' }));
            return;
          }
          if (lookupOptions?.all) callback(null, candidates.length ? candidates : safeAddresses);
          else callback(null, selected.address, selected.family);
        },
      }, (incoming) => {
        try {
          const responseHeaders = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
          }
          resolve(new Response(Readable.toWeb(incoming), {
            status: incoming.statusCode,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
          }));
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      });
      request.once('error', reject);
      request.end(options.body);
    });
  };
}
