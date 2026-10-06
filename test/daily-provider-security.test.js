import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/core/store.js';
import { createResearchClient } from '../src/research/providers.js';
import { arxivIdentity } from '../src/research/candidates.js';
import { readResearchDocument } from '../src/research/documents.js';
import { safeFetchResource } from '../src/workflows/translation-source-text.js';

const PUBLIC_ADDRESS = { address: '93.184.216.34', family: 4 };
const NOW = '2026-10-03T01:00:00.000Z';

function fixture(t, providers = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source2draft-daily-provider-'));
  const store = openStore(':memory:');
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, workDir: dir, config: { dataDir: dir, daily: { providers } }, clock: () => NOW };
}

// Exercise the production downloader without using real DNS or HTTP. A test
// using globalThis.fetch still gets a mock transport through DNS pinning.
function mockDownload(transport, overrides = {}) {
  return options => safeFetchResource({ ...options,
    dnsLookup: async () => [PUBLIC_ADDRESS],
    publicDnsLookup: async () => [PUBLIC_ADDRESS],
    pinnedFetchFactory: () => transport,
    ...overrides,
  });
}

test('an explicit zero free-provider budget prevents any HTTP attempt', async t => {
  let calls = 0;
  const transport = async () => { calls++; return Response.json({ results: [] }); };
  const settings = fixture(t, { tavily: { apiKey: 'fixture-only-key', freeConfirmed: true, periodLimit: 0 } });
  const client = createResearchClient({ ...settings, fetchFn: transport, download: mockDownload(transport) });
  await assert.rejects(client.json({ provider: 'tavily', url: 'https://api.tavily.com/search', method: 'POST',
    json: { api_key: 'fixture-only-key', query: 'LLM finance' }, auth: true, cacheMs: 0 }),
  error => error.code === 'PROVIDER_BUDGET_EXHAUSTED');
  assert.equal(calls, 0);
  assert.equal(settings.store.providerBudgets()[0].used, 0);
  assert.equal(settings.store.providerReservations()[0].allowed, 0);
  assert.equal(settings.store.providerReservations()[0].units, 1);
  assert.equal(client.health.tavily.attempts, 0);
});

test('each physical HTTP retry has a durable reservation and a cache hit adds none', async t => {
  let calls = 0;
  const transport = async () => {
    calls++;
    return calls === 1 ? new Response(null, { status: 503, headers: { 'Retry-After': '0.001' } })
      : Response.json({ results: [] });
  };
  const settings = fixture(t, { tavily: { apiKey: 'fixture-only-key', freeConfirmed: true, periodLimit: 10 } });
  const client = createResearchClient({ ...settings, fetchFn: transport, download: mockDownload(transport) });
  const request = { provider: 'tavily', url: 'https://api.tavily.com/search', method: 'POST', auth: true,
    json: { query: 'LLM finance' } };
  const first = await client.json(request);
  assert.equal(first.receipt.attempts, 2);
  assert.equal(calls, 2);
  assert.equal(settings.store.providerBudgets()[0].used, 2);
  const reservations = settings.store.providerReservations();
  assert.deepEqual(reservations.map(row => [row.units, row.allowed, row.used_after]), [[1, 1, 2], [1, 1, 1]]);
  assert.deepEqual(Object.keys(reservations[0]).sort(),
    ['allowed', 'id', 'limit_units', 'period', 'provider', 'reserved_at', 'units', 'used_after']);
  assert.equal((await client.json(request)).receipt.cacheHit, true);
  assert.equal(calls, 2);
  assert.equal(settings.store.providerReservations().length, 2);
});

for (const [name, location] of [['same origin', 'https://api.tavily.com/moved'],
  ['cross origin', 'https://example.com/stolen']]) {
  test(`authenticated API redirects never follow ${name}`, async t => {
    const requests = [];
    const transport = async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(null, { status: 302, headers: { Location: location } });
    };
    const settings = fixture(t, { tavily: { apiKey: 'fixture-only-key', freeConfirmed: true, periodLimit: 10 } });
    const client = createResearchClient({ ...settings, fetchFn: transport, download: mockDownload(transport) });
    await assert.rejects(client.request({ provider: 'tavily', url: 'https://api.tavily.com/search', method: 'POST',
      headers: { Authorization: 'Bearer fixture-only-key' }, json: { query: 'quantitative research' }, auth: true, cacheMs: 0 }), /重定向超过 0 次/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.tavily.com/search');
    assert.equal(requests[0].options.redirect, 'manual');
    assert.equal(settings.store.providerBudgets()[0].used, 1);
  });
}

test('private or credential-bearing URLs never reach Firecrawl usage or scrape APIs', async t => {
  let calls = 0;
  const transport = async () => { calls++; throw new Error('Unexpected HTTP request'); };
  const settings = fixture(t, { firecrawl: { apiKey: 'fixture-only-key', freeConfirmed: true, periodLimit: 10 } });
  const client = createResearchClient({ ...settings, fetchFn: transport, download: mockDownload(transport) });
  for (const url of ['https://127.0.0.1/article', 'https://10.0.0.1/article', 'https://[::1]/article',
    'https://localhost/article', 'https://machine.local/article', 'https://user:secret@example.com/article',
    'https://example.com/article?api_key=fixture-only-key', 'https://example.com:8443/article']) {
    await assert.rejects(client.firecrawl(url), /公开 HTTPS|私网|保留地址|本机|内部地址/);
  }
  assert.equal(calls, 0);
  assert.deepEqual(settings.store.providerBudgets(), []);
});

test('a secure-downloader private-address rejection cannot fall back to Firecrawl', async t => {
  let calls = 0, fallbacks = 0;
  const transport = async () => { calls++; throw new Error('Unexpected HTTP request'); };
  const settings = fixture(t, { firecrawl: { apiKey: 'fixture-only-key', freeConfirmed: true, periodLimit: 10 } });
  const client = createResearchClient({ ...settings, fetchFn: transport, download: mockDownload(transport) });
  const originalFallback = client.firecrawl;
  client.firecrawl = async url => { fallbacks++; return originalFallback(url); };
  await assert.rejects(readResearchDocument({ ...settings, client,
    candidate: { title: 'Private-address fixture', url: 'https://127.0.0.1/article', sourceId: 'fixture' },
    context: { cutoffAt: NOW, windowStart: '2026-10-02T01:00:00.000Z', supplementStart: '2026-09-26T01:00:00.000Z' },
  }), /私网或保留地址/);
  assert.equal(calls, 0);
  assert.equal(fallbacks, 0);
});

test('arXiv identities require a complete plain ID or an official arXiv URL', () => {
  assert.deepEqual(arxivIdentity('2601.12345v2'), { baseId: '2601.12345', version: 'v2', id: '2601.12345v2' });
  assert.equal(arxivIdentity('https://arxiv.org/abs/2601.12345v2')?.id, '2601.12345v2');
  assert.equal(arxivIdentity('https://export.arxiv.org/pdf/quant-ph/9501001.pdf')?.id, 'quant-ph/9501001');
  for (const input of ['https://example.com/abs/2601.12345v2', 'https://arxiv.org.example.com/abs/2601.12345',
    'https://doi.org/10.0000/2601.12345', 'https://example.com/2601.12345.pdf',
    'prefix2601.12345', '2601.12345 trailing', 'https://user:secret@arxiv.org/abs/2601.12345']) {
    assert.equal(arxivIdentity(input), null, input);
  }
});

for (const syntheticDns of [false, true]) {
  test(`research API uses validated pinned public DNS${syntheticDns ? ' after synthetic-DNS fallback' : ''}`, async t => {
    const pins = [], lookups = [], requests = [];
    let publicLookups = 0;
    const transport = async (url, options) => { requests.push({ url, options }); return Response.json({ results: [] }); };
    const settings = fixture(t, { tavily: { apiKey: 'fixture-only-key', freeConfirmed: true, periodLimit: 10 } });
    const download = mockDownload(transport, {
      dnsLookup: async host => { lookups.push(host); return [syntheticDns ? { address: '198.18.0.8', family: 4 } : PUBLIC_ADDRESS]; },
      publicDnsLookup: async () => { publicLookups++; return [PUBLIC_ADDRESS]; },
      pinnedFetchFactory: addresses => { pins.push(addresses); return transport; },
    });
    const client = createResearchClient({ ...settings, fetchFn: globalThis.fetch, download });
    const result = await client.json({ provider: 'tavily', url: 'https://api.tavily.com/search', method: 'POST',
      json: { query: 'LLM finance' }, auth: true, cacheMs: 0 });
    assert.deepEqual(result.data, { results: [] });
    assert.deepEqual(lookups, ['api.tavily.com']);
    assert.deepEqual(pins, [[PUBLIC_ADDRESS]]);
    assert.equal(publicLookups, syntheticDns ? 1 : 0);
    assert.equal(requests.length, 1);
    assert.equal(settings.store.providerBudgets()[0].used, 1);
  });
}
