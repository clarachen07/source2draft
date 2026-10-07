export function modelIdentity(config = {}, { mode, profile } = {}) {
  const provider = config.provider || 'deepseek';
  const roles = mode === 'translation' ? ['translation'] : mode || profile ? ['planner', 'writer', 'review'] : null;
  const configured = config.models || (config.writerModel ? { writer: config.writerModel } : {});
  const models = roles ? Object.fromEntries(roles.filter(role => configured[role]).map(role => [role, configured[role]])) : configured;
  return { provider, adapterVersion: provider === 'codex-cli' ? 4 : 1,
    models, effort: config.effort || 'high',
    ...(provider === 'deepseek' ? { maxTokens: config.maxTokens } : {}) };
}
