// Source profiles are data, not bespoke site crawlers. Primary announcements are
// discovered on these official domains and read individually by the downloader.
export const OFFICIAL_PROFILES = Object.freeze([
  { id: 'openai', label: 'OpenAI', url: 'https://openai.com/news/', domains: ['openai.com'], feed: 'https://openai.com/news/rss.xml', topic: 'llm' },
  { id: 'anthropic', label: 'Anthropic', url: 'https://www.anthropic.com/news', domains: ['anthropic.com'], topic: 'llm' },
  { id: 'deepmind', label: 'Google DeepMind', url: 'https://deepmind.google/blog/', domains: ['deepmind.google', 'blog.google'], topic: 'llm' },
  { id: 'google-research', label: 'Google Research', url: 'https://research.google/blog/', domains: ['research.google'], topic: 'research' },
  // The HF blog contains community posts. It discovers papers; it is not an
  // unconditional declaration that every hosted author speaks for Hugging Face.
  { id: 'huggingface', label: 'Hugging Face', url: 'https://huggingface.co/blog', domains: ['huggingface.co'], feed: 'https://huggingface.co/blog/feed.xml', topic: 'llm', community: true },
  { id: 'meta', label: 'Meta AI', url: 'https://ai.meta.com/blog/', domains: ['ai.meta.com'], topic: 'llm' },
  { id: 'deepseek', label: 'DeepSeek', url: 'https://www.deepseek.com/news/', domains: ['deepseek.com'], topic: 'llm', region: 'china' },
  { id: 'qwen', label: 'Qwen', url: 'https://qwen.ai/blog', domains: ['qwen.ai'], topic: 'llm', region: 'china' },
  { id: 'arxiv', label: 'arXiv', url: 'https://arxiv.org/', domains: ['arxiv.org'], topic: 'paper' },
  { id: 'microsoft-quant', label: 'Microsoft Qlib / RD-Agent', url: 'https://github.com/microsoft/qlib', domains: ['github.com'], topic: 'practice' },
  { id: 'lean', label: 'QuantConnect LEAN', url: 'https://github.com/QuantConnect/Lean', domains: ['github.com'], topic: 'practice' },
  { id: 'vnpy', label: 'vn.py', url: 'https://github.com/vnpy/vnpy', domains: ['github.com'], topic: 'practice', region: 'china' },
  { id: 'aqr', label: 'AQR Research', url: 'https://www.aqr.com/Insights/Research', domains: ['aqr.com'], topic: 'institution' },
  { id: 'man', label: 'Man AHL / Numeric', url: 'https://www.man.com/insights', domains: ['man.com'], topic: 'institution' },
  { id: 'robeco', label: 'Robeco', url: 'https://www.robeco.com/en-int/insights', domains: ['robeco.com'], topic: 'institution' },
  { id: 'twosigma', label: 'Two Sigma Data Science', url: 'https://www.twosigma.com/topic/data-science/', domains: ['twosigma.com'], topic: 'institution' },
  { id: 'bis', label: 'BIS research', url: 'https://www.bis.org/rss', domains: ['bis.org'], feed: 'https://www.bis.org/doclist/bis_fsi_publs.rss', topic: 'finance' },
  { id: 'fed', label: 'Federal Reserve research', url: 'https://www.federalreserve.gov/feeds/feeds.htm', domains: ['federalreserve.gov'], feeds: ['https://www.federalreserve.gov/feeds/working_papers.xml', 'https://www.federalreserve.gov/feeds/feds_notes.xml'], topic: 'finance' },
]);

export const OFFICIAL_REPOSITORIES = Object.freeze([
  'microsoft/qlib', 'microsoft/RD-Agent', 'QuantConnect/Lean',
  'AI4Finance-Foundation/FinRL', 'AI4Finance-Foundation/FinGPT', 'AI4Finance-Foundation/FinRobot',
  'amazon-science/chronos-forecasting', 'google-research/timesfm', 'SalesforceAIResearch/uni2ts',
  'ibm-granite/granite-tsfm', 'vnpy/vnpy',
]);

export function profileForUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'github.com') {
    const repository = url.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
    if (!OFFICIAL_REPOSITORIES.some(repo => repo.toLowerCase() === repository.toLowerCase())
      && !['qwenlm', 'deepseek-ai'].includes(repository.split('/')[0].toLowerCase())) return null;
    return { id: 'github', label: repository, topic: 'practice', domains: ['github.com'] };
  }
  return OFFICIAL_PROFILES.find(profile => profile.id !== 'microsoft-quant' && profile.id !== 'lean' && profile.id !== 'vnpy'
    && profile.domains.some(domain => host === domain || host.endsWith(`.${domain}`))) || null;
}

export function discoveryQueries(limit = 12) {
  const llm = ['openai.com', 'anthropic.com', 'deepmind.google', 'blog.google', 'research.google', 'ai.meta.com'];
  const institutions = ['aqr.com', 'man.com', 'robeco.com', 'twosigma.com'];
  const plan = [
    { topic: 'llm', query: 'latest language model release capabilities evaluations benchmark technical report', domains: llm },
    { topic: 'llm', query: 'language model agent tool use reasoning inference serving release research', domains: llm },
    { topic: 'llm', query: 'DeepSeek Qwen 大模型 最新 发布 推理 评测 金融', domains: ['deepseek.com', 'qwen.ai', 'github.com'] },
    { topic: 'paper', query: 'large language models quantitative finance trading portfolio financial forecasting new research', domains: ['arxiv.org'] },
    { topic: 'paper', query: 'time series foundation model financial forecasting probabilistic uncertainty research', domains: ['arxiv.org', 'research.google', 'huggingface.co'] },
    { topic: 'paper', query: 'machine learning cross asset factor investing portfolio transaction cost out of sample research', domains: ['arxiv.org', ...institutions] },
    { topic: 'paper', query: 'financial language model benchmark evaluation data leakage look ahead bias reproducibility', domains: ['arxiv.org', 'huggingface.co'] },
    { topic: 'practice', query: 'Qlib RD-Agent FinRL FinGPT FinRobot LEAN release financial agent open source', domains: ['github.com', 'quantconnect.com'] },
    { topic: 'institution', query: 'quantitative investing machine learning artificial intelligence risk portfolio research', domains: institutions },
    { topic: 'finance', query: 'artificial intelligence machine learning financial markets systemic risk research', domains: ['federalreserve.gov', 'bis.org'] },
    { topic: 'practice', query: 'vnpy Qlib 量化 时序 大模型 开源 发布 回测 工程', domains: ['github.com', 'qwen.ai', 'deepseek.com'] },
    { topic: 'practice', query: 'Chronos TimesFM Moirai Granite time series foundation models new version release', domains: ['github.com', 'research.google', 'huggingface.co'] },
  ];
  return plan.slice(0, Math.max(1, Math.min(24, limit)));
}
