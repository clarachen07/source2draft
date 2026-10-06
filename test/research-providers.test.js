import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFeed, parsedDate, temporalStatus, deduplicateCandidates, candidateScore } from '../src/research/candidates.js';
import { createResearchClient, collectCandidates, collectionHealth, arxivQuery } from '../src/research/providers.js';
import { OFFICIAL_REPOSITORIES } from '../src/research/catalog.js';

const context = { issueDate: '2026-10-02', cutoffAt: '2026-10-03T00:00:00.000Z', windowStart: '2026-10-02T00:00:00.000Z', supplementStart: '2026-09-26T00:00:00.000Z' };
const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry><id>https://arxiv.org/abs/2501.12345v2</id><title>LLM Portfolio Research</title><published>2025-01-20T12:00:00Z</published><updated>2026-10-02T12:00:00Z</updated><link href="https://arxiv.org/abs/2501.12345v2" rel="alternate"/><summary>Financial language models</summary><arxiv:license>http://creativecommons.org/licenses/by/4.0/</arxiv:license></entry></feed>`;
const emptyAtom = '<feed xmlns="http://www.w3.org/2005/Atom"></feed>';

test('generic ML risk, returns and quantitative analysis do not outrank a true financial LLM intersection', () => {
  const base = { publishedAt: '2026-10-02T12:00:00Z', dateVerified: true, official: true, kind: 'paper' };
  const generic = { ...base, title: 'LLM quantitative analysis of population risk', summary: 'A factor returns a bound on the model risk.' };
  const finance = { ...base, title: 'LLM financial portfolio trading', summary: 'Out-of-sample investment evaluation with transaction costs.' };
  assert.ok(candidateScore(finance, context) > candidateScore(generic, context) + 40);
});

test('RSS 1.0 dc:date and Atom version updates retain source dates and licenses', () => {
  const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><item><title>Financial AI risk</title><link>https://www.bis.org/publ/example.htm</link><dc:date>2026-10-02</dc:date></item></rdf:RDF>`;
  const feed = parseFeed(rdf, { id: 'bis', topic: 'finance' });
  assert.equal(feed[0].datePrecision, 'day'); assert.equal(temporalStatus(feed[0], context), 'current');
  const paper = parseFeed(atom, { id: 'arxiv', topic: 'paper' })[0];
  assert.equal(paper.eventType, 'paper-revision'); assert.equal(paper.publishedAt, '2025-01-20T12:00:00.000Z');
  assert.equal(paper.eventAt, '2026-10-02T12:00:00.000Z'); assert.equal(temporalStatus(paper, context), 'current');
  assert.equal(paper.licenseVerified, true);
});

test('publisher dates reject invalid calendar days and never invent timezone precision', () => {
  assert.equal(parsedDate('2026-02-30'), null); assert.equal(parsedDate('2026-10'), null);
  assert.deepEqual(parsedDate('2026-10-02T10:00:00'), { value: '2026-10-02', precision: 'day' });
  assert.deepEqual(parsedDate('Fri, 02 Oct 2026 10:00:00 GMT'), { value: '2026-10-02T10:00:00.000Z', precision: 'instant' });
  assert.equal(temporalStatus({ publishedAt: '2026-10-03T01:00:00Z', dateVerified: true }, context), 'future');
  assert.equal(temporalStatus({ publishedAt: '2026-10-02', dateVerified: false }, context), 'unverified');
});

test('revision discovery query does not exclude older first submissions', () => {
  const fresh = new URL(arxivQuery(context, 'cat:q-fin.*'));
  const revised = new URL(arxivQuery(context, 'cat:q-fin.*', { revisions: true }));
  assert.match(fresh.searchParams.get('search_query'), /submittedDate/);
  assert.doesNotMatch(revised.searchParams.get('search_query'), /submittedDate/);
  assert.equal(revised.searchParams.get('sortBy'), 'lastUpdatedDate');
});

test('resolved paper versions dedupe before prior-delivery check; next version remains eligible', () => {
  const discovery = { title: 'LLM Portfolio Research', url: 'https://arxiv.org/abs/2501.12345', dateVerified: false, provider: 'hf' };
  const version = parseFeed(atom, { id: 'arxiv', topic: 'paper' })[0];
  const delivered = id => id === 'arxiv:2501.12345v2';
  assert.equal(deduplicateCandidates([discovery, version], context, { delivered }).length, 0);
  const next = parseFeed(atom.replaceAll('v2', 'v3'), { id: 'arxiv', topic: 'paper' })[0];
  assert.equal(deduplicateCandidates([discovery, next], context, { delivered })[0].eventId, 'arxiv:2501.12345v3');
});

test('HF native daily-submission, record and paper dates survive official resolution and dedupe without changing the arXiv event', async () => {
  const hfSubmittedOnDailyAt = '2026-10-02T00:00:00.000Z', hfRecordPublishedAt = '2026-09-29T20:00:00.000Z';
  const client = {
    request: async args => ({ checkedAt: context.cutoffAt, buffer: Buffer.from(args.provider === 'arxiv' ? atom : '<rss><channel></channel></rss>') }),
    json: async args => {
      if (args.url.includes('huggingface.co/api/daily_papers')) return { data: [{ publishedAt: hfRecordPublishedAt,
        paper: { id: '2501.12345', title: 'LLM Portfolio Research', summary: 'Financial language models',
          publishedAt: '2025-01-20T12:00:00Z', submittedOnDailyAt: hfSubmittedOnDailyAt } }], receipt: { checkedAt: context.cutoffAt } };
      if (args.provider === 'github') return { data: args.url.includes('/releases?') ? [] : { private: false }, receipt: {} };
      return { data: { results: [] }, receipt: {} };
    },
  };
  const result = await collectCandidates({ context, client, checkpoint: {}, config: { daily: {} } });
  const resolvedDiscovery = result.candidates.find(candidate => candidate.hfSubmittedOnDailyAt);
  assert.equal(resolvedDiscovery.eventId, 'arxiv:2501.12345v2'); assert.equal(resolvedDiscovery.hfSubmittedOnDailyAt, hfSubmittedOnDailyAt);
  const [winner] = deduplicateCandidates(result.candidates, context);
  assert.equal(winner.provider, 'arxiv'); assert.equal(winner.hfSubmittedOnDailyAt, hfSubmittedOnDailyAt);
  assert.equal(winner.hfRecordPublishedAt, hfRecordPublishedAt);
  assert.equal(winner.discoveryPublishedAt, '2025-01-20T12:00:00Z');
  assert.equal(winner.publishedAt, '2025-01-20T12:00:00.000Z'); assert.equal(winner.eventAt, '2026-10-02T12:00:00.000Z');
  assert.equal(temporalStatus(winner, context), 'current');
  assert.equal(deduplicateCandidates([{ ...winner, hfSubmittedOnDailyAt: undefined }], context)[0].hfSubmittedOnDailyAt, null);
});

test('public baseline can establish no-update coverage without optional keys and survives one RSS outage', () => {
  const slots = { 'arxiv:0': { ok: true }, 'rss:openai:0': { ok: true }, 'rss:fed:0': { ok: true } };
  for (const repo of OFFICIAL_REPOSITORIES.slice(0, 6)) slots[`github:${repo}`] = { ok: true };
  assert.equal(collectionHealth(slots, { daily: {} }).healthy, true);
  slots['rss:openai:0'] = { ok: false }; slots['search:exa:0'] = { ok: true };
  const config = { daily: { providers: { exa: { apiKey: 'fixture-key', freeConfirmed: true } } } };
  assert.equal(collectionHealth(slots, config).healthy, true);
  assert.equal(collectionHealth({}, config).healthy, false);
});

test('each HTTP retry reserves budget, cache avoids new reservation, API keys never enter receipts/cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-provider-'));
  const reservations = [], events = []; let calls = 0;
  const download = async args => {
    const response = await args.fetchWithRetry(args.fetchFn, args.url, { headers: args.headers, signal: args.signal, redirect: 'manual' });
    if (!response.ok) throw new Error(`原文获取失败:${response.status}`);
    return { status: response.status, finalUrl: args.url, contentType: 'application/json', buffer: Buffer.from(await response.arrayBuffer()) };
  };
  try {
    const client = createResearchClient({ config: { dataDir: dir, daily: { providers: { openalex: { apiKey: 'fixture-secret' } } } }, workDir: dir,
      store: { reserveProviderBudget: value => { reservations.push(value); return { allowed: true }; }, providerHealth() {} }, download,
      clock: () => '2026-10-02T12:00:00.000Z', onTelemetry: event => events.push(event),
      fetchFn: async () => ++calls === 1 ? new Response('retry', { status: 503, headers: { 'retry-after': '0.01' } }) : Response.json({ results: [] }) });
    const request = { provider: 'openalex', url: 'https://api.openalex.org/works?api_key=fixture-secret', units: 1, auth: true };
    const receipt = await client.request(request); await client.request(request);
    assert.equal(calls, 2); assert.equal(reservations.length, 2); assert.equal(receipt.attempts, 2);
    assert.doesNotMatch(JSON.stringify({ receipt: { ...receipt, buffer: undefined }, events }), /fixture-secret|api_key/);
    for (const file of fs.readdirSync(path.join(dir, 'research-cache'))) assert.doesNotMatch(fs.readFileSync(path.join(dir, 'research-cache', file), 'utf8'), /fixture-secret|api_key/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('healthy Exa queries retain three Tavily complementary searches and reject private repositories', async () => {
  const requests = [], releases = [];
  const client = {
    request: async args => { requests.push(args); return { status: 200, finalUrl: args.url, checkedAt: context.cutoffAt, buffer: Buffer.from(args.provider === 'arxiv' ? emptyAtom : '<rss><channel></channel></rss>') }; },
    json: async args => {
      requests.push(args);
      if (args.url.endsWith('/releases?per_page=5')) { releases.push(args.url); return { data: [], receipt: {} }; }
      if (args.provider === 'github') return { data: { private: args.url.endsWith('/vnpy/vnpy') }, receipt: {} };
      if (['exa', 'tavily'].includes(args.provider)) return { data: { results: [] }, receipt: {} };
      if (args.provider === 'openalex') return { data: { results: [] }, receipt: {} };
      return { data: [], receipt: {} };
    },
  };
  const checkpoint = {};
  const result = await collectCandidates({ context, client, checkpoint, config: { daily: { providers: {
    exa: { apiKey: 'fixture-key', freeConfirmed: true }, tavily: { apiKey: 'fixture-key', freeConfirmed: true },
  }, limits: { maxQueries: 12 } } } });
  assert.equal(requests.filter(request => request.provider === 'exa').length, 12);
  assert.equal(requests.filter(request => request.provider === 'tavily').length, 3);
  assert.equal(releases.some(url => url.includes('/vnpy/vnpy/')), false);
  assert.equal(checkpoint.collection['github:vnpy/vnpy'].ok, false);
  assert.equal(result.health.healthy, true);
});
