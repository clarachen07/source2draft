export function modelIdentity(config = {}) {
  const provider = config.provider || 'deepseek';
  return { provider, adapterVersion: provider === 'codex-cli' ? 3 : 1,
    models: config.models || (config.writerModel ? { writer: config.writerModel } : {}), effort: config.effort || 'high',
    ...(provider === 'deepseek' ? { maxTokens: config.maxTokens } : {}) };
}
