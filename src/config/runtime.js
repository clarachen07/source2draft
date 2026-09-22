const gates = new Map();

export async function acquireRuntimeResource(name, signal) {
  const limit = name === 'model' ? 2 : 1;
  if (!gates.has(name)) gates.set(name, { active: 0, waiting: [] });
  const gate = gates.get(name);
  signal?.throwIfAborted();
  if (gate.active >= limit) await new Promise((resolve, reject) => {
    const waiter = { resolve: () => { signal?.removeEventListener('abort', abort); resolve(); } };
    const abort = () => { gate.waiting.splice(gate.waiting.indexOf(waiter), 1); reject(signal.reason); };
    gate.waiting.push(waiter);
    signal?.addEventListener('abort', abort, { once: true });
  });
  else gate.active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = gate.waiting.shift();
    if (next) next.resolve(); else gate.active--;
  };
}
export async function withRuntimeResource(name, fn, signal) {
  const release = await acquireRuntimeResource(name, signal);
  try { signal?.throwIfAborted(); return await fn(); } finally { release(); }
}
