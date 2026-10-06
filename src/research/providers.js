import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { safeFetchResource, assertSafeHttpUrl } from '../workflows/translation-source-text.js';
import { hash, readJson, writeAtomic } from '../lib/io.js';
import { emitTelemetry } from '../lib/telemetry.js';
import { withRuntimeResource } from '../config/runtime.js';
import { OFFICIAL_PROFILES, OFFICIAL_REPOSITORIES, discoveryQueries, profileForUrl } from './catalog.js';
import { arxivIdentity, normalizeCandidate, parseFeed, canonicalUrl, temporalStatus as temporalStatusForCollection } from './candidates.js';

const API_ORIGINS = { exa: 'https://api.exa.ai', tavily: 'https://api.tavily.com',
  firecrawl: 'https://api.firecrawl.dev', 'research-index': 'https://api.firecrawl.dev', openalex: 'https://api.openalex.org', github: 'https://api.github.com', crossref: 'https://api.crossref.org' };
let lastArxivAttempt = 0;

export function providerSettings(config, provider) {
  const configured = config.daily?.providers?.[provider] || {};
  return { ...configured, apiKey: configured.apiKey || config.daily?.[`${provider}Key`] || (provider === 'exa' ? config.exaKey : '') || '',
    freeConfirmed: configured.freeConfirmed === true || config.daily?.[`${provider}FreeConfirmed`] === true };
}

export function providerEnabled(config, provider) {
  const settings = providerSettings(config, provider);
  return ['exa', 'tavily', 'firecrawl'].includes(provider) ? Boolean(settings.apiKey && settings.freeConfirmed) : true;
}

const safeStatus = error => Number(/(?:HTTP\s*|获取失败:)(\d{3})/.exec(error?.message || '')?.[1]) || null;
export function publicFailure(error) {
  return { code: error?.code === 'PROVIDER_BUDGET_EXHAUSTED' ? error.code : error?.code === 'PROVIDER_FREE_TIER_UNCONFIRMED'
    ? error.code : 'SOURCE_UNAVAILABLE', status: safeStatus(error) };
}

function budgetFor(config, provider, now, units, period) {
  const settings = providerSettings(config, provider);
  const defaultLimits = { exa: 900, tavily: 900, firecrawl: 900, openalex: settings.apiKey ? 90 : 9,
    github: settings.apiKey ? 4000 : 60, crossref: 150, arxiv: 150, rss: 200, source: 150, 'research-index': 30 };
  const maximum = provider === 'openalex' && !settings.apiKey ? 9 : defaultLimits[provider] || 150;
  const configured = Number(settings.periodLimit);
  return { provider, units: units ?? 1, limit: Number.isFinite(configured) && configured >= 0 ? Math.min(configured, maximum) : maximum,
    period: period || (['exa', 'tavily'].includes(provider) ? now.slice(0, 7) : provider === 'github' ? now.slice(0, 13) : now.slice(0, 10)) };
}

// Every actual HTTP attempt, including a retry/redirect, reserves quota before
// dispatch. Cache hits never reserve. No URL, request body or API key is logged.
export function createResearchClient({ config, store, workDir, signal, fetchFn = globalThis.fetch, onTelemetry,
  download = safeFetchResource, clock = () => new Date().toISOString(), arxivIntervalMs = 3000 } = {}) {
  const cacheDir = path.join(config.dataDir || workDir, 'research-cache');
  const health = {};
  async function request({ provider = 'source', url, method = 'GET', json, headers = {}, units, period,
    cacheMs = 3600000, maxBytes = 5 * 1024 * 1024, auth = false, sourceId = provider, redirects = 5 }) {
    signal?.throwIfAborted();
    const target = new URL(url);
    if (API_ORIGINS[provider] && target.origin !== API_ORIGINS[provider]) throw new Error('研究 API 地址不在固定官方域名内');
    if (['exa', 'tavily', 'firecrawl'].includes(provider) && !providerEnabled(config, provider)) {
      const error = new Error(`${provider} 未确认免费额度，已跳过`); error.code = 'PROVIDER_FREE_TIER_UNCONFIRMED'; throw error;
    }
    const fingerprintBody = json ? Object.fromEntries(Object.entries(json).filter(([name]) => !/key|token|authorization/i.test(name))) : undefined;
    const cleanUrl = canonicalUrl(url);
    const key = hash({ provider, url: cleanUrl, method, body: fingerprintBody });
    const cacheFile = path.join(cacheDir, `${key}.json`);
    const cache = readJson(cacheFile);
    const now = clock();
    if (cacheMs > 0 && cache?.version === 1 && cache.receipt?.status >= 200 && cache.receipt.status < 300
      && Date.parse(cache.receipt.checkedAt) <= Date.parse(now) && Date.parse(now) - Date.parse(cache.receipt.checkedAt) < cacheMs) {
      health[sourceId] = { ok: true, cacheHit: true, checkedAt: cache.receipt.checkedAt };
      emitTelemetry(onTelemetry, { stage: 'daily.provider', provider, sourceId, cacheHit: true, count: 1 });
      return { ...cache.receipt, buffer: Buffer.from(cache.base64, 'base64'), cacheHit: true };
    }
    let attempts = 0;
    const reserve = async () => {
      if (!store?.reserveProviderBudget) throw new Error('日报缺少持久化额度存储，已停止外部请求');
      const reservation = await store.reserveProviderBudget(budgetFor(config, provider, clock(), units, period));
      if (!reservation.allowed) { const error = new Error(`${provider} 免费额度预算已耗尽`); error.code = 'PROVIDER_BUDGET_EXHAUSTED'; throw error; }
    };
    const attemptFetch = async (transport, address, options) => {
      // Redirects on authenticated APIs are prohibited even within the origin.
      if (API_ORIGINS[provider] && new URL(address).origin !== API_ORIGINS[provider]) throw new Error('研究 API 重定向不在固定官方域名内');
      await reserve();
      attempts++;
      if (provider === 'arxiv') return withRuntimeResource('daily-arxiv', async () => {
        const wait = Math.max(0, arxivIntervalMs - (Date.now() - lastArxivAttempt));
        if (wait) await delay(wait, undefined, { signal: options.signal });
        lastArxivAttempt = Date.now();
        return transport(address, options);
      }, options.signal);
      return transport(address, options);
    };
    const retry = async (transport, address, options) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await attemptFetch(transport, address, options);
          if (attempt === 0 && [429, 500, 502, 503, 504].includes(response.status)) {
            const seconds = Math.min(5, Number(response.headers.get('retry-after')) || 1);
            await response.body?.cancel();
            await delay(seconds * 1000, undefined, { signal: options.signal });
            continue;
          }
          return response;
        } catch (error) {
          signal?.throwIfAborted();
          if (attempt || error.code === 'PROVIDER_BUDGET_EXHAUSTED' || /固定官方域名/.test(error.message)) throw error;
          await delay(250, undefined, { signal: options.signal });
        }
      }
      throw new Error('研究请求未取得响应');
    };
    try {
      const fetched = await download({ url, method, body: json ? JSON.stringify(json) : undefined, fetchFn,
        fetchWithRetry: retry, headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers }, signal,
        limits: { maxSourceBytes: maxBytes, maxRedirects: auth || API_ORIGINS[provider] ? 0 : redirects, fetchTimeoutMs: 35000 }, maxBytes });
      const receipt = { sourceUrl: cleanUrl, finalUrl: canonicalUrl(fetched.finalUrl), status: fetched.status,
        contentType: fetched.contentType, checkedAt: clock(), provider, sourceId, attempts };
      health[sourceId] = { ok: true, cacheHit: false, checkedAt: receipt.checkedAt, status: fetched.status, attempts };
      store.providerHealth?.(sourceId, health[sourceId]);
      if (cacheMs > 0) writeAtomic(cacheFile, { version: 1, receipt, base64: fetched.buffer.toString('base64') });
      emitTelemetry(onTelemetry, { stage: 'daily.provider', provider, sourceId, cacheHit: false, count: 1, attempts, status: fetched.status });
      return { ...receipt, buffer: fetched.buffer, cacheHit: false };
    } catch (error) {
      signal?.throwIfAborted();
      const failure = { ok: false, checkedAt: clock(), attempts, ...publicFailure(error) };
      health[sourceId] = failure;
      store.providerHealth?.(sourceId, failure);
      emitTelemetry(onTelemetry, { stage: 'daily.provider', provider, sourceId, cacheHit: false, outcome: 'failed', attempts, status: failure.status });
      throw error;
    }
  }
  async function json(requestOptions) {
    const fetched = await request(requestOptions);
    let data;
    try { data = JSON.parse(fetched.buffer.toString('utf8')); } catch { throw new Error('研究 API 返回无效 JSON'); }
    return { data, receipt: { ...fetched, buffer: undefined } };
  }
  async function firecrawl(url) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || (target.port && target.port !== '443') || target.username || target.password
      || [...target.searchParams.keys()].some(name => /api[_-]?key|token|secret|signature|credential|authorization|x-amz-/i.test(name))) throw new Error('备用提取只接受无凭据的公开 HTTPS 正文');
    await assertSafeHttpUrl(url, { signal });
    if (!providerEnabled(config, 'firecrawl')) throw new Error('Firecrawl 免费备用提取未启用');
    const settings = providerSettings(config, 'firecrawl'), headers = { Authorization: `Bearer ${settings.apiKey}` };
    const { data: usage } = await json({ provider: 'firecrawl', url: 'https://api.firecrawl.dev/v2/team/credit-usage',
      auth: true, headers, units: 0, cacheMs: 0, sourceId: 'firecrawl-usage' });
    const balance = usage?.data;
    const start = Date.parse(balance?.billingPeriodStart), end = Date.parse(balance?.billingPeriodEnd), now = Date.parse(clock());
    if (!usage.success || !(balance.planCredits > 0 && balance.planCredits <= 1000) || !(balance.remainingCredits >= 1)
      || !Number.isFinite(start) || !Number.isFinite(end) || now < start || now > end) {
      const error = new Error('Firecrawl 未能确认有效免费账期和余额，已跳过'); error.code = 'PROVIDER_FREE_TIER_UNCONFIRMED'; throw error;
    }
    const result = await json({ provider: 'firecrawl', url: 'https://api.firecrawl.dev/v2/scrape', method: 'POST', headers,
      auth: true, units: 1, period: `billing:${new Date(start).toISOString()}`, cacheMs: 6 * 3600000,
      json: { url, formats: ['markdown'], onlyMainContent: true, timeout: 30000, parsers: [] } });
    if (!result.data?.success || !result.data?.data?.markdown?.trim() || result.data.data.metadata?.statusCode >= 400) throw new Error('备用提取未取得可用原文');
    const returnedUrl = result.data.data.metadata?.sourceURL || result.data.data.metadata?.url || url;
    if (canonicalUrl(returnedUrl) !== canonicalUrl(url)) throw new Error('备用提取来源与请求文章不一致');
    return { markdown: result.data.data.markdown, metadata: result.data.data.metadata || {}, receipt: result.receipt };
  }
  return { request, json, firecrawl, health };
}

export function arxivQuery(context, query, { revisions = false } = {}) {
  const stamp = date => new Date(date).toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const window = `submittedDate:[${stamp(context.supplementStart)} TO ${stamp(context.cutoffAt)}]`;
  // Submission windows find new papers; overlapping lastUpdatedDate sorting also
  // discovers revisions. Dates are verified again against frozen issue bounds.
  return `https://export.arxiv.org/api/query?${new URLSearchParams({ search_query: revisions ? `(${query})` : `(${query}) AND ${window}`, start: '0', max_results: '35', sortBy: 'lastUpdatedDate', sortOrder: 'descending' })}`;
}

function searchCandidate(result, provider, query, receipt) {
  const profile = profileForUrl(result.url);
  const arxiv = arxivIdentity(result.url);
  if (!profile) return null;
  return normalizeCandidate({ title: result.title || result.url, url: result.url, summary: result.text || result.content || result.snippet || '',
    discoveryPublishedAt: result.publishedDate || result.published_date || null,
    // Search engine date hints are never asserted as source-verified dates.
    dateVerified: false, kind: arxiv ? 'paper' : 'news', topic: arxiv ? 'paper' : profile.topic || query.topic,
    official: !profile.community, sourceId: profile.id, provider, receipt,
    pdfUrl: arxiv ? `https://arxiv.org/pdf/${arxiv.id}` : null });
}

export async function collectCandidates({ context, config, client, checkpoint, persist = () => {}, signal, progress = () => {} }) {
  const warnings = [];
  checkpoint.collection ||= {};
  const slots = checkpoint.collection;
  const now = context.cutoffAt;
  async function slot(id, action, { retainMetadata = false } = {}) {
    signal?.throwIfAborted();
    if (slots[id]?.ok) return slots[id].candidates;
    try {
      const candidates = (await action()).filter(candidate => retainMetadata || !['old', 'future'].includes(temporalStatusForCollection(candidate, context)));
      slots[id] = { ok: true, candidates, checkedAt: new Date().toISOString() };
      persist();
      return candidates;
    } catch (error) {
      signal?.throwIfAborted();
      slots[id] = { ok: false, ...publicFailure(error), checkedAt: new Date().toISOString() };
      warnings.push(`${id} 本次未取得可核验来源${error.code === 'PROVIDER_BUDGET_EXHAUSTED' ? '（免费预算已用尽）' : ''}`);
      persist();
      return [];
    }
  }
  const all = [];
  progress('正在检查官方论文、公告和开源项目更新');
  for (const profile of OFFICIAL_PROFILES) for (const [index, feed] of (profile.feeds || (profile.feed ? [profile.feed] : [])).entries()) {
    const id = `rss:${profile.id}:${index}`;
    all.push(...await slot(id, async () => {
      const fetched = await client.request({ provider: 'rss', url: feed, sourceId: id, cacheMs: 15 * 60000 });
      return parseFeed(fetched.buffer.toString('utf8'), profile, { ...fetched, buffer: undefined });
    }));
  }
  const paperQueries = [
    '(cat:q-fin.* AND (all:"machine learning" OR all:"language model" OR all:"artificial intelligence" OR all:"forecasting"))',
    '((cat:cs.AI OR cat:cs.LG OR cat:cs.CL OR cat:stat.ML) AND (all:"finance" OR all:"trading" OR all:"portfolio" OR all:"time series"))',
  ];
  for (const [index, query] of paperQueries.entries()) all.push(...await slot(`arxiv:${index}`, async () => {
    const fetched = await client.request({ provider: 'arxiv', url: arxivQuery(context, query), sourceId: `arxiv:${index}`, cacheMs: 30 * 60000 });
    return parseFeed(fetched.buffer.toString('utf8'), { id: 'arxiv', topic: 'paper' }, { ...fetched, buffer: undefined });
  }));
  // An older first submission can have a new version today. This bounded query
  // must not carry the first-submission lower bound.
  all.push(...await slot('arxiv:revisions', async () => {
    const fetched = await client.request({ provider: 'arxiv', url: arxivQuery(context, paperQueries.join(' OR '), { revisions: true }),
      sourceId: 'arxiv:revisions', cacheMs: 30 * 60000 });
    return parseFeed(fetched.buffer.toString('utf8'), { id: 'arxiv', topic: 'paper' }, { ...fetched, buffer: undefined });
  }));
  const github = providerSettings(config, 'github');
  const githubHeaders = { Accept: 'application/vnd.github+json', ...(github.apiKey ? { Authorization: `Bearer ${github.apiKey}` } : {}) };
  for (const repo of OFFICIAL_REPOSITORIES) all.push(...await slot(`github:${repo}`, async () => {
    const { data: repository } = await client.json({ provider: 'github', url: `https://api.github.com/repos/${repo}`,
      headers: githubHeaders, auth: Boolean(github.apiKey), sourceId: `github-public:${repo}`, cacheMs: 30 * 60000 });
    if (repository.private !== false) throw new Error('日报只读取公开 GitHub 仓库');
    const { data, receipt } = await client.json({ provider: 'github', url: `https://api.github.com/repos/${repo}/releases?per_page=5`,
      headers: githubHeaders, auth: Boolean(github.apiKey), sourceId: `github:${repo}`, cacheMs: 30 * 60000 });
    if (!Array.isArray(data)) throw new Error('GitHub releases 数据格式不正确');
    return data.filter(release => !release.draft && !release.prerelease).map(release => normalizeCandidate({
      eventId: `github-release:${repo.toLowerCase()}:${release.id}`, title: `${repo} ${release.name || release.tag_name}`,
      url: release.html_url, summary: release.body || '', publishedAt: release.published_at,
      dateVerified: true, kind: 'release', topic: 'practice', sourceId: `github:${repo}`, official: true, provider: 'github',
      sourceText: release.body || '', sourceTextVerified: true, repository: repo, receipt, fetchedAt: receipt.checkedAt,
    })).filter(Boolean);
  }));
  all.push(...await slot('hf:daily-papers', async () => {
    const { data, receipt } = await client.json({ provider: 'source', url: 'https://huggingface.co/api/daily_papers?limit=100',
      sourceId: 'hf:daily-papers', cacheMs: 30 * 60000 });
    if (!Array.isArray(data)) throw new Error('HF papers 数据格式不正确');
    return data.map(item => {
      const id = arxivIdentity(item.paper?.id);
      return id ? normalizeCandidate({ title: item.title || item.paper.title, url: `https://arxiv.org/abs/${id.id}`,
        summary: item.paper.summary || item.summary, discoveryPublishedAt: item.paper.publishedAt,
        hfSubmittedOnDailyAt: item.paper.submittedOnDailyAt || null, hfRecordPublishedAt: item.publishedAt || null,
        kind: 'paper', topic: 'paper', sourceId: 'hf-papers', provider: 'hf', official: false, dateVerified: false,
        pdfUrl: `https://arxiv.org/pdf/${id.id}`, receipt }) : null;
    }).filter(Boolean);
  }));
  all.push(...await slot('openalex:finance-llm', async () => {
    const settings = providerSettings(config, 'openalex');
    const params = new URLSearchParams({ search: 'large language model financial forecasting',
      filter: `from_publication_date:${context.supplementStart.slice(0, 10)}`, sort: 'publication_date:desc', per_page: '20' });
    if (settings.apiKey) params.set('api_key', settings.apiKey);
    const { data, receipt } = await client.json({ provider: 'openalex', url: `https://api.openalex.org/works?${params}`,
      units: 1, auth: Boolean(settings.apiKey), sourceId: 'openalex:finance-llm', cacheMs: 6 * 3600000 });
    if (!Array.isArray(data.results)) throw new Error('OpenAlex 数据格式不正确');
    return data.results.map(work => {
      const location = work.best_oa_location || work.primary_location;
      if (!location?.landing_page_url && !work.doi) return null;
      return normalizeCandidate({ title: work.display_name, url: location?.landing_page_url || work.doi,
        doi: work.doi, discoveryPublishedAt: work.publication_date, dateVerified: false, provider: 'openalex', sourceId: 'openalex',
        kind: 'paper', topic: 'paper', official: false, pdfUrl: location?.pdf_url || null, receipt,
        authors: work.authorships?.map(author => author.author.display_name) || [] });
    }).filter(Boolean);
  }));
  // Firecrawl's ResearchIndex is a separate anonymous GET index. Its created/
  // updated filter dates describe indexing, so no such date becomes eventAt.
  // Passages discover papers; the original author API and full text verify them.
  if ((!slots['arxiv:0']?.ok && !slots['arxiv:1']?.ok) || (!providerEnabled(config, 'exa') && !providerEnabled(config, 'tavily'))) {
    for (const [index, query] of ['large language model quantitative finance', 'time series foundation model forecasting'].entries()) {
      all.push(...await slot(`research-index:${index}`, async () => {
        const { data, receipt } = await client.json({ provider: 'research-index',
          url: `https://api.firecrawl.dev/v2/search/research/papers?${new URLSearchParams({ query, k: '20' })}`,
          sourceId: `research-index:${index}`, cacheMs: 6 * 3600000 });
        const records = data.results || data.papers || data.data?.results || data.data?.papers || data.data;
        if (!Array.isArray(records)) throw new Error('ResearchIndex 返回无效论文列表');
        return records.map(record => {
          const paper = record.paper || record;
          const identity = arxivIdentity(String(paper.ids?.arxiv?.[0] || paper.primaryId || paper.arxivId || paper.url || '').replace(/^arxiv:/i, ''));
          if (!identity || !paper.title) return null;
          return normalizeCandidate({ title: paper.title, url: `https://arxiv.org/abs/${identity.id}`, pdfUrl: `https://arxiv.org/pdf/${identity.id}`,
            summary: paper.abstract || paper.description || '', provider: 'research-index', sourceId: 'research-index', kind: 'paper', topic: 'paper',
            official: false, dateVerified: false, receipt });
        }).filter(Boolean);
      }));
    }
  }
  const plans = discoveryQueries(config.daily?.limits?.maxQueries || config.daily?.maxQueries || 12);
  if (providerEnabled(config, 'exa') || providerEnabled(config, 'tavily')) {
    progress('正在检索官方模型发布、量化研究与中文实践');
    for (const [index, query] of plans.entries()) {
      let results = [];
      if (providerEnabled(config, 'exa')) results = await slot(`search:exa:${index}`, async () => {
        const settings = providerSettings(config, 'exa');
        const { data, receipt } = await client.json({ provider: 'exa', url: 'https://api.exa.ai/search', method: 'POST', auth: true, units: 2,
          headers: { 'x-api-key': settings.apiKey }, sourceId: `search:exa:${index}`,
          json: { query: query.query, type: 'auto', numResults: 8, includeDomains: query.domains,
            startPublishedDate: context.supplementStart, endPublishedDate: context.cutoffAt,
            contents: { text: { maxCharacters: 6000 } } } });
        if (!Array.isArray(data.results)) throw new Error('Exa 返回无效搜索结果');
        return data.results.map(result => searchCandidate(result, 'exa', query, receipt)).filter(Boolean);
      });
      // A zero-result successful search is valid; fallback only on failed calls.
      const crossCheck = [3, 7, 8].includes(index);
      if ((!providerEnabled(config, 'exa') || slots[`search:exa:${index}`]?.ok === false || crossCheck) && providerEnabled(config, 'tavily')) {
        const additional = await slot(`search:tavily:${index}`, async () => {
          const settings = providerSettings(config, 'tavily');
          const { data, receipt } = await client.json({ provider: 'tavily', url: 'https://api.tavily.com/search', method: 'POST', auth: true, units: 1,
            headers: { Authorization: `Bearer ${settings.apiKey}` }, sourceId: `search:tavily:${index}`,
            json: { query: query.query, search_depth: 'basic', max_results: 8, include_domains: query.domains,
              start_date: context.supplementStart.slice(0, 10), end_date: context.cutoffAt.slice(0, 10),
              include_answer: false, include_raw_content: false, auto_parameters: false } });
          if (!Array.isArray(data.results)) throw new Error('Tavily 返回无效搜索结果');
          return data.results.map(result => searchCandidate(result, 'tavily', query, receipt)).filter(Boolean);
        });
        results.push(...additional);
      }
      all.push(...results);
    }
  } else warnings.push('免费搜索账号尚未确认，本期官方网页检索覆盖受限');
  // HF and search/index metadata identify papers. Batch verify those arXiv IDs
  // through the original API before treating index dates as publication dates.
  const ids = [...new Set(all.filter(item => !item.dateVerified).map(item => item.arxiv?.id).filter(Boolean))].slice(0, 35);
  let resolved = [];
  if (ids.length) resolved = await slot('arxiv:enrichment', async () => {
    const fetched = await client.request({ provider: 'arxiv', url: `https://export.arxiv.org/api/query?${new URLSearchParams({ id_list: ids.join(','), max_results: String(ids.length) })}`,
      sourceId: 'arxiv:enrichment', cacheMs: 6 * 3600000 });
    return parseFeed(fetched.buffer.toString('utf8'), { id: 'arxiv', topic: 'paper' }, { ...fetched, buffer: undefined });
  }, { retainMetadata: true });
  // Resolve every unversioned discovery to the author API's event identity
  // before dedup/delivery checks. This also removes already-old indexed papers.
  const byBase = new Map(resolved.filter(candidate => candidate.arxiv).map(candidate => [candidate.arxiv.baseId, candidate]));
  const candidates = all.map(candidate => candidate.arxiv && byBase.has(candidate.arxiv.baseId)
    ? { ...candidate, ...byBase.get(candidate.arxiv.baseId), doi: byBase.get(candidate.arxiv.baseId).doi || candidate.doi,
      hfSubmittedOnDailyAt: byBase.get(candidate.arxiv.baseId).hfSubmittedOnDailyAt || candidate.hfSubmittedOnDailyAt || null,
      hfRecordPublishedAt: byBase.get(candidate.arxiv.baseId).hfRecordPublishedAt || candidate.hfRecordPublishedAt || null,
      discoveryPublishedAt: byBase.get(candidate.arxiv.baseId).discoveryPublishedAt || candidate.discoveryPublishedAt || null } : candidate);
  return { candidates, warnings, health: collectionHealth(slots, config), checkedAt: now };
}

export function collectionHealth(slots, config) {
  const successful = id => slots[id]?.ok === true;
  const githubCount = OFFICIAL_REPOSITORIES.filter(repo => successful(`github:${repo}`)).length;
  const search = index => successful(`search:exa:${index}`) || successful(`search:tavily:${index}`);
  const sections = { papers: successful('arxiv:0') || successful('arxiv:1') || successful('arxiv:revisions') || [3, 4, 5, 6].filter(search).length >= 2,
    llm: successful('rss:openai:0') || [0, 1, 2].some(search),
    practice: githubCount >= Math.ceil(OFFICIAL_REPOSITORIES.length / 2) || [7, 10, 11].filter(search).length >= 2,
    finance: successful('rss:fed:0') || successful('rss:fed:1') || successful('rss:bis:0') || (search(8) && search(9)),
    officialSearch: Object.entries(slots).some(([id, entry]) => id.startsWith('search:') && entry.ok) };
  const searchEnabled = providerEnabled(config, 'exa') || providerEnabled(config, 'tavily');
  const healthy = sections.papers && sections.llm && sections.practice && sections.finance;
  return { healthy, sections, githubCount, configuredSearch: searchEnabled,
    failures: Object.entries(slots).filter(([, value]) => !value.ok).map(([id]) => id) };
}

export async function crossrefMetadata(doi, client) {
  if (!doi || !/^10\.\d{4,9}\/\S+$/i.test(doi)) return null;
  const { data, receipt } = await client.json({ provider: 'crossref', url: `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    sourceId: 'crossref', cacheMs: 24 * 3600000 });
  const work = data.message;
  if (!work || String(work.DOI).toLowerCase() !== doi.toLowerCase()) throw new Error('Crossref DOI 元数据不匹配');
  const parts = (work['published-online'] || work['published-print'] || work.published)?.['date-parts']?.[0];
  return { title: work.title?.[0], publicationDate: parts?.length >= 3 ? parts.map((part, index) => index ? String(part).padStart(2, '0') : String(part)).join('-') : null,
    datePrecision: parts?.length >= 3 ? 'day' : parts?.length === 2 ? 'month' : 'year',
    publisher: work.publisher, corrections: work['update-to'] || [], receipt };
}
