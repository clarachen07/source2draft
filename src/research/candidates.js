import { JSDOM } from 'jsdom';
import { hash } from '../lib/io.js';

export function canonicalUrl(raw) {
  const url = new URL(String(raw));
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('研究来源必须是公开 HTTP 链接');
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|ref$|api[_-]?key$|token$|x-amz-|x-goog-)|signature|credential|authorization/i.test(key)) url.searchParams.delete(key);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  return url.href;
}

export function parsedDate(value) {
  const text = String(value || '').trim();
  if (!text || /^\d{4}(?:-\d{2})?$/.test(text)) return null;
  const prefix = /^(\d{4})[-/](\d{2})[-/](\d{2})/.exec(text);
  if (prefix) {
    const date = new Date(Date.UTC(Number(prefix[1]), Number(prefix[2]) - 1, Number(prefix[3])));
    if (date.getUTCFullYear() !== Number(prefix[1]) || date.getUTCMonth() + 1 !== Number(prefix[2]) || date.getUTCDate() !== Number(prefix[3])) return null;
    // A timestamp without a timezone cannot establish an instant. Keep only its
    // publisher-supplied calendar day instead of relying on the host's TZ.
    if (!/(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/i.test(text)) return { value: `${prefix[1]}-${prefix[2]}-${prefix[3]}`, precision: 'day' };
  }
  const zoned = /(?:Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/i.test(text);
  if (!prefix && !zoned && !/(?:\b\d{1,2}\s+[A-Za-z]+\s+\d{4}|\b[A-Za-z]+\s+\d{1,2},?\s+\d{4})/.test(text)) return null;
  const millis = Date.parse(zoned ? text : `${text} UTC`);
  if (!Number.isFinite(millis)) return null;
  return { value: new Date(millis).toISOString().slice(0, zoned ? 24 : 10), precision: zoned ? 'instant' : 'day' };
}

// Day-only publisher dates describe an interval, not an invented precise time.
export function temporalStatus(candidate, context) {
  const date = parsedDate(candidate.eventAt || candidate.publishedAt);
  if (!date || !candidate.dateVerified) return 'unverified';
  const start = Date.parse(date.value), end = date.precision === 'day' ? start + 86400000 : start;
  const cutoff = Date.parse(context.cutoffAt), window = Date.parse(context.windowStart), supplement = Date.parse(context.supplementStart);
  if (start > cutoff) return 'future';
  if (date.precision === 'instant' ? start >= window : end > window) return 'current';
  if (date.precision === 'instant' ? start >= supplement : end > supplement) return 'supplement';
  return 'old';
}

export function arxivIdentity(raw) {
  let value = String(raw || '').trim();
  if (/^https?:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (!['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname) || url.username || url.password) return null;
    const path = /^\/(?:abs|pdf|html)\/(.+)$/.exec(url.pathname);
    if (!path) return null;
    value = path[1];
  }
  const match = /^((?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7}))(v\d+)?(?:\.pdf)?$/i.exec(value);
  if (!match) return null;
  return { baseId: match[1], version: match[2] || '', id: `${match[1]}${match[2] || ''}` };
}

export function normalizeCandidate(raw, now = new Date().toISOString()) {
  if (!raw?.title?.trim() || !raw.url) return null;
  let url;
  try { url = canonicalUrl(raw.url); } catch { return null; }
  const arxiv = arxivIdentity(url), doi = String(raw.doi || '').toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
  const eventAt = raw.eventAt || raw.publishedAt || null;
  const identity = arxiv ? `arxiv:${arxiv.baseId}${arxiv.version}` : raw.eventId || (doi ? `doi:${doi}` : `url:${hash(url)}`);
  return { ...raw, title: raw.title.replace(/\s+/g, ' ').trim(), url, doi: doi || null, arxiv,
    eventId: identity, id: identity, publishedAt: parsedDate(raw.publishedAt)?.value || null,
    updatedAt: parsedDate(raw.updatedAt)?.value || null, eventAt: parsedDate(eventAt)?.value || null,
    hfSubmittedOnDailyAt: parsedDate(raw.hfSubmittedOnDailyAt)?.value || null,
    hfRecordPublishedAt: parsedDate(raw.hfRecordPublishedAt)?.value || null,
    datePrecision: parsedDate(eventAt)?.precision || null, dateVerified: Boolean(raw.dateVerified),
    firstSeenAt: raw.firstSeenAt || now, fetchedAt: raw.fetchedAt || now, summary: String(raw.summary || '') };
}

export function candidateScore(candidate, context) {
  const text = `${candidate.title} ${candidate.summary}`;
  // General ML papers also discuss risk, returns, factors and quantitative
  // analysis. Those words alone do not establish a finance intersection.
  const finance = /\b(financ\w*|trading|invest\w*|portfolio|backtest\w*|econometric\w*|stocks?|bonds?|forex|cryptocurrenc\w*|securities)\b|\b(?:financial|stock|bond|capital|prediction|equity|commodity|crypto)\s+markets?\b|\b(?:asset\s+(?:pricing|allocation)|option\s+pricing|quantitative\s+(?:finance|trading|investment))\b|金融|交易|投资|回测|股票|债券|资产配置|资产定价|量化金融|量化投资|量化交易/i.test(text);
  const llm = /\b(LLM|language model|foundation model|agent|transformer|reasoning|generative AI|machine learning)\b|大模型|语言模型|机器学习|智能体|时序/i.test(text);
  const timeSeries = /time.series|forecast|probabilistic|时序|时间序列|预测/i.test(text);
  const status = temporalStatus(candidate, context);
  return (status === 'current' ? 40 : status === 'supplement' ? 15 : status === 'unverified' ? 5 : -100)
    + (finance ? 18 : 0) + (llm ? 12 : 0) + (finance && llm ? 25 : 0) + (timeSeries ? 10 : 0)
    + (candidate.official ? 8 : 0) + (candidate.kind === 'paper' ? 8 : 0)
    - (/careers|hiring|webinar|conference registration|招聘|报名/i.test(text) ? 80 : 0);
}

export function deduplicateCandidates(raw, context, { limit = 80, delivered = () => false } = {}) {
  const entries = new Map();
  for (const item of raw) {
    const candidate = normalizeCandidate(item, context.cutoffAt);
    if (!candidate || ['old', 'future'].includes(temporalStatus(candidate, context))) continue;
    const keys = [candidate.url, candidate.doi ? `doi:${candidate.doi}` : null,
      candidate.arxiv ? `arxiv:${candidate.arxiv.baseId}` : null].filter(Boolean);
    const priorKey = [...entries.keys()].find(key => entries.get(key).dedupeKeys.some(k => keys.includes(k)));
    const prior = priorKey ? entries.get(priorKey) : null;
    if (prior) {
      // Prefer the source's own verified metadata over an index/search result.
      const prefer = (candidate.dateVerified && !prior.dateVerified) || (candidate.official && !prior.official)
        || (candidate.arxiv && prior.arxiv && Number(candidate.arxiv.version.slice(1)) > Number(prior.arxiv.version.slice(1)));
      const winner = prefer ? candidate : prior, other = prefer ? prior : candidate;
      entries.set(priorKey, { ...winner, doi: winner.doi || other.doi,
        hfSubmittedOnDailyAt: winner.hfSubmittedOnDailyAt || other.hfSubmittedOnDailyAt || null,
        hfRecordPublishedAt: winner.hfRecordPublishedAt || other.hfRecordPublishedAt || null,
        discoveryPublishedAt: winner.discoveryPublishedAt || other.discoveryPublishedAt || null,
        discoveries: [...(prior.discoveries || []), candidate.provider], dedupeKeys: [...new Set([...prior.dedupeKeys, ...keys])] });
    } else entries.set(candidate.eventId, { ...candidate, dedupeKeys: keys, discoveries: [candidate.provider] });
  }
  return [...entries.values()].filter(candidate => !delivered(candidate.eventId))
    .sort((a, b) => candidateScore(b, context) - candidateScore(a, context)).slice(0, Math.min(120, limit));
}

const descendants = (element, name) => [...element.getElementsByTagName('*')].filter(node => node.localName === name);
const textOf = (element, name) => descendants(element, name)[0]?.textContent?.trim() || '';

export function parseFeed(xml, profile, receipt = {}) {
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  try {
    const doc = dom.window.document;
    if (doc.getElementsByTagName('parsererror').length) throw new Error('来源返回无效 XML');
    const entries = [...doc.getElementsByTagName('*')].filter(node => ['entry', 'item'].includes(node.localName));
    return entries.map(entry => {
      const atom = entry.localName === 'entry';
      const link = atom ? descendants(entry, 'link').find(node => ['alternate', ''].includes(node.getAttribute('rel') || ''))?.getAttribute('href')
        : textOf(entry, 'link');
      const published = textOf(entry, atom ? 'published' : 'pubDate') || textOf(entry, 'date');
      const updated = textOf(entry, 'updated');
      const categories = descendants(entry, 'category').map(node => node.getAttribute('term') || node.textContent.trim());
      const license = descendants(entry, 'license')[0]?.textContent?.trim();
      const authorNames = descendants(entry, 'author').map(author => textOf(author, 'name') || author.textContent.trim());
      const identity = profile.id === 'arxiv' ? arxivIdentity(textOf(entry, 'id') || link) : null;
      const isRevision = Boolean(identity?.version && Number(identity.version.slice(1)) > 1 && parsedDate(updated));
      return normalizeCandidate({ title: textOf(entry, 'title'), url: link || (identity ? `https://arxiv.org/abs/${identity.id}` : ''),
        summary: textOf(entry, 'summary') || textOf(entry, 'description'), publishedAt: published, updatedAt: updated,
        eventAt: isRevision ? updated : published, eventType: isRevision ? 'paper-revision' : 'publication', dateVerified: Boolean(parsedDate(published)),
        kind: profile.id === 'arxiv' ? 'paper' : 'news', topic: profile.topic, sourceId: profile.id,
        provider: profile.id === 'arxiv' ? 'arxiv' : 'rss', official: !profile.community,
        authors: authorNames, categories, doi: textOf(entry, 'doi') || null, licenseUrl: license || null,
        licenseVerified: Boolean(profile.id === 'arxiv' && license),
        pdfUrl: identity ? `https://arxiv.org/pdf/${identity.id}` : null,
        fetchedAt: receipt.checkedAt, receipt,
      });
    }).filter(Boolean);
  } finally { dom.window.close(); }
}

export function selectDeepReads(candidates, context, maximum = 12) {
  const selected = [], groups = [
    { kinds: ['paper'], slots: 4 }, { topics: ['llm'], slots: 3 },
    { topics: ['practice'], slots: 3 }, { topics: ['institution', 'finance'], slots: 2 },
  ];
  const sorted = [...candidates].filter(candidate => candidate.official || candidate.kind === 'paper')
    .sort((a, b) => candidateScore(b, context) - candidateScore(a, context));
  for (const group of groups) for (const candidate of sorted.filter(c => group.kinds?.includes(c.kind) || group.topics?.includes(c.topic)).slice(0, group.slots)) {
    if (!selected.includes(candidate) && selected.length < Math.min(12, maximum)) selected.push(candidate);
  }
  for (const candidate of sorted) if (!selected.includes(candidate) && selected.length < Math.min(12, maximum)) selected.push(candidate);
  return selected;
}
