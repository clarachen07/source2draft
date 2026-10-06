import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { loadConfig, missingConfig } from '../src/config/index.js';
import { createModel } from '../src/core/model.js';
import { CODEX_LIMITS, codexEnvironment } from '../src/core/codex-model.js';
import { modelIdentity } from '../src/core/model-identity.js';
import { prepareModelRecovery } from '../src/core/model-recovery.js';
import { checkCodex } from '../src/core/model-check.js';
import { writeAtomic, readJson, hash } from '../src/lib/io.js';

const final = content => [
  { type: 'thread.started', thread_id: 'fixture' }, { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', phase: 'final_answer', text: JSON.stringify({ content }) } },
  { type: 'turn.completed', usage: { input_tokens: 8, cached_input_tokens: 2, output_tokens: 4, unsafe: 'private' } },
];
function fixture(t, handler = (child, input, call) => { child.stdout.end(final('完成').map(JSON.stringify).join('\n')); child.emit('close', 0); }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source2draft-codex-'));
  const workDir = path.join(root, 'run'); fs.mkdirSync(workDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { ...loadConfig({ MODEL_PROVIDER: 'codex-cli', CODEX_CLI_PATH: process.execPath }), root };
  const calls = [], kills = [], usage = [];
  const spawnFn = (executable, args, options) => {
    const child = new EventEmitter(); child.pid = 100 + calls.length;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let input = '';
    child.stdin = new Writable({ write(chunk, _encoding, done) { input += chunk.toString(); done(); } });
    child.stdin.on('finish', () => queueMicrotask(() => handler(child, input, calls.length)));
    child.kill = () => {};
    calls.push({ executable, args, options, child }); return child;
  };
  const killFn = (pid, sig) => { kills.push([pid, sig]); if (sig === 'SIGTERM') queueMicrotask(() => calls.find(c => c.child.pid === pid).child.emit('close', null)); };
  const model = createModel(config, { workDir, spawnFn, killFn, onUsage: value => usage.push(value),
    env: { HOME: '/fixture', PATH: '/bin', CODEX_HOME: '/fixture-codex', OPENAI_API_KEY: 'private', CODEX_API_KEY: 'private',
      OPENAI_BASE_URL: 'https://private.example', DEEPSEEK_API_KEY: 'private', SLACK_BOT_TOKEN: 'private' },
    fetchFn: () => { throw new Error('must never fall back to API'); } });
  return { root, workDir, config, model, calls, kills, usage };
}

test('Codex route needs no DeepSeek key, retains legacy default and validates selection', () => {
  const config = loadConfig({ MODEL_PROVIDER: 'codex-cli' });
  assert.equal(config.model.models.translation, 'gpt-6-luna'); assert.equal(config.model.effort, 'high');
  assert.deepEqual(missingConfig(config, { daily: true, slack: false, wechat: false }), []);
  assert.equal(loadConfig({}).model.provider, 'deepseek');
  assert.throws(() => loadConfig({ MODEL_PROVIDER: 'unknown' }), /MODEL_PROVIDER/);
  assert.throws(() => loadConfig({ CODEX_CLI_PATH: 'codex' }), /绝对路径/);
  assert.throws(() => loadConfig({ CODEX_MODEL: '--bad argument' }), /模型标识/);
});
test('Codex dispatch uses isolated argument arrays, stdin, ChatGPT and a secret-free environment', async t => {
  const f = fixture(t);
  assert.equal(await f.model.complete({ prompt: 'private task `$(do not execute)`', systemPrompt: 'trusted policy' }), '完成');
  const call = f.calls[0]; assert.equal(call.options.shell, false); assert.equal(call.options.detached, true);
  assert.ok(call.options.cwd.startsWith(fs.realpathSync(f.workDir) + path.sep)); assert.doesNotMatch(call.args.join(' '), /private task/);
  for (const flag of ['--ignore-user-config', '--ephemeral', '--output-schema', '--json']) assert.ok(call.args.includes(flag));
  assert.ok(call.args.includes('forced_login_method="chatgpt"')); assert.ok(call.args.includes('model_reasoning_effort="high"'));
  assert.ok(call.args.some(value => value.startsWith('model_catalog_json=')));
  const catalogPath = JSON.parse(call.args.find(value => value.startsWith('model_catalog_json=')).slice('model_catalog_json='.length));
  const metadata = JSON.parse(fs.readFileSync(catalogPath, 'utf8')).models[0];
  assert.equal(metadata.slug, 'gpt-6-luna'); assert.equal(metadata.model_messages, undefined);
  assert.deepEqual(metadata.experimental_supported_tools, []); assert.equal(metadata.supports_search_tool, false);
  assert.ok(metadata.base_instructions.includes('text-only'));
  for (const feature of ['shell_tool', 'apps', 'plugins', 'hooks', 'multi_agent', 'browser_use']) assert.ok(call.args.includes(feature));
  assert.deepEqual(call.options.env, { HOME: '/fixture', PATH: '/bin', CODEX_HOME: '/fixture-codex' });
  assert.equal(f.usage[0].provider, 'codex-cli'); assert.equal(f.usage[0].model, 'gpt-6-luna');
  assert.deepEqual(f.usage[0].usage, { input_tokens: 8, cached_input_tokens: 2, output_tokens: 4 });
  assert.equal(fs.statSync(path.join(call.options.cwd, 'response-schema.json')).mode & 0o777, 0o600);
});
test('split UTF-8 event chunks and absent final newline are parsed as a complete reply', async t => {
  const f = fixture(t, child => {
    const bytes = Buffer.from(final('中文结果').map(JSON.stringify).join('\n'));
    for (let i = 0; i < bytes.length; i += 3) child.stdout.write(bytes.subarray(i, i + 3));
    child.stdout.end(); child.emit('close', 0);
  });
  assert.equal(await f.model.complete({ prompt: 'fixture' }), '中文结果');
});
test('structured content uses the existing bounded JSON validation and repair', async t => {
  const f = fixture(t, (child, _input, call) => { child.stdout.end(final(call === 1 ? 'invalid' : '{"ok":true}').map(JSON.stringify).join('\n')); child.emit('close', 0); });
  assert.deepEqual(await f.model.json({ prompt: 'fixture', validate: value => value.ok === true }), { ok: true });
  assert.equal(f.calls.length, 2);
});
for (const [name, events, code, expected] of [
  ['partial result', final('partial').slice(0, -1), 0, 'CODEX_INCOMPLETE'],
  ['empty content', final(' '), 0, 'CODEX_EMPTY'],
  ['bad envelope', [{ type: 'item.completed', item: { type: 'agent_message', text: '{"other":"x"}' } }, { type: 'turn.completed' }], 0, 'CODEX_EMPTY'],
  ['failed event after partial message', [...final('partial').slice(0, -1), { type: 'turn.failed', error: { message: 'private quota credit limit' } }], 0, 'CODEX_QUOTA'],
  ['tool attempt', [{ type: 'item.started', item: { type: 'command_execution', command: 'private' } }], 0, 'CODEX_TOOL_ATTEMPT'],
  ['unsuccessful exit despite completed message', final('valid-looking'), 1, 'CODEX_CALL_FAILED'],
  ['malformed protocol', ['{invalid}'], 0, 'CODEX_PROTOCOL'],
  ['invalid event shape', ['null'], 0, 'CODEX_PROTOCOL'],
  ['runtime error item', [{ type: 'turn.started' }, { type: 'item.completed', item: { type: 'error', message: 'private authentication error' } }], 0, 'CODEX_AUTH'],
]) test(`Codex rejects ${name} without API fallback or partial usage acceptance`, async t => {
  const f = fixture(t, child => { child.stdout.end(events.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n')); child.emit('close', code); });
  await assert.rejects(f.model.complete({ prompt: 'private-prompt' }), error => error.code === expected && !error.message.includes('private'));
  assert.equal(f.usage.length, 0); assert.equal(f.calls.length, 1);
});
for (const [message, code] of [['Authentication expired; private token', 'CODEX_AUTH'], ['usage limit credits private', 'CODEX_QUOTA'],
  ['Error loading config.toml: reserved built-in provider private', 'CODEX_CONFIG'],
  ['Model metadata for private not found. Defaulting to fallback metadata', 'CODEX_CONFIG'],
  ["The 'private' model is not supported when using Codex with a ChatGPT account.", 'CODEX_MODEL_UNAVAILABLE']]) test(`CLI errors classify ${code} without retaining raw text`, async t => {
  const f = fixture(t, child => { child.stderr.end(message); child.emit('close', 1); });
  await assert.rejects(f.model.complete({ prompt: 'fixture' }), e => e.code === code && e.retryable === false && !e.message.includes('private'));
});
test('disabled code-mode startup notice is accepted only before a turn; actual errors remain fatal', async t => {
  const notice = { type: 'item.completed', item: { type: 'error', message: 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable features.code_mode_host.' } };
  const f = fixture(t, child => { child.stdout.end([notice, ...final('valid')].map(JSON.stringify).join('\n')); child.emit('close', 0); });
  assert.equal(await f.model.complete({ prompt: 'fixture' }), 'valid');
  const g = fixture(t, child => { child.stdout.end([{ type: 'turn.started' }, notice, ...final('invalid')].map(JSON.stringify).join('\n')); child.emit('close', 0); });
  await assert.rejects(g.model.complete({ prompt: 'fixture' }), e => e.code === 'CODEX_CALL_FAILED');
});
test('oversized output and stderr stop rather than accepting a truncated reply', async t => {
  for (const stream of ['stdout', 'stderr']) {
    const f = fixture(t, child => child[stream].write('x'.repeat(CODEX_LIMITS[stream] + 1)));
    await assert.rejects(f.model.complete({ prompt: 'fixture' }), e => e.code === 'CODEX_OUTPUT_LIMIT');
    assert.ok(f.kills.some(([, sig]) => sig === 'SIGKILL'));
  }
});
test('timeout terminates process group and frees the shared slot for another task', async t => {
  const f = fixture(t, (child, _input, call) => { if (call > 1) { child.stdout.end(final('recovered').map(JSON.stringify).join('\n')); child.emit('close', 0); } });
  await assert.rejects(f.model.complete({ prompt: 'fixture', timeoutMs: 15 }), e => e.code === 'CODEX_TIMEOUT');
  assert.deepEqual(f.kills.map(([, sig]) => sig), ['SIGTERM', 'SIGKILL']);
  assert.equal(await f.model.complete({ prompt: 'fixture' }), 'recovered');
});
test('two shared model slots and cancellation while waiting cannot start a third CLI', async t => {
  const children = [], f = fixture(t, child => children.push(child));
  const a = new AbortController(), b = new AbortController(), waiting = new AbortController();
  const pending = [f.model.complete({ prompt: 'a', signal: a.signal }), f.model.complete({ prompt: 'b', signal: b.signal })];
  await new Promise(resolve => setTimeout(resolve, 10));
  const third = f.model.complete({ prompt: 'c', signal: waiting.signal }); waiting.abort(new Error('cancel waiting'));
  await assert.rejects(third, /cancel waiting/); assert.equal(f.calls.length, 2);
  a.abort(new Error('cancel a')); b.abort(new Error('cancel b'));
  await Promise.all(pending.map(p => assert.rejects(p, /cancel/)));
});
test('environment whitelist cannot inherit model endpoints or project credentials', () => {
  assert.deepEqual(codexEnvironment({ HOME: '/home', OPENAI_API_KEY: 'private', CODEX_API_KEY: 'private', OPENAI_BASE_URL: 'private' }), { HOME: '/home' });
});
test('model identity excludes credentials and executable location but binds route and reasoning', () => {
  const a = modelIdentity({ provider: 'codex-cli', models: { writer: 'gpt-6-luna' }, effort: 'high', key: 'private', cliPath: '/a' });
  assert.equal(JSON.stringify(a).includes('private'), false);
  assert.deepEqual(a, modelIdentity({ provider: 'codex-cli', models: { writer: 'gpt-6-luna' }, effort: 'high', key: 'other', cliPath: '/b' }));
  assert.notDeepEqual(a, modelIdentity({ provider: 'deepseek', models: a.models, effort: 'high' }));
  assert.notDeepEqual(a, modelIdentity({ provider: 'codex-cli', models: a.models, effort: 'medium' }));
});
test('route change archives generation, retains frozen evidence and the already spent repair', t => {
  const f = fixture(t), trace = { context: { cutoffAt: 'fixed' }, cards: [{ id: 'C1' }], draft: { old: true }, writing: { old: true },
    approval: { old: true }, correctionCount: 1, repairRequest: { complete: true, errors: ['same factual error'], baseDraft: { old: true } } };
  writeAtomic(path.join(f.workDir, 'research-trace.json'), trace); writeAtomic(path.join(f.workDir, 'artifact.json'), { old: true });
  const result = prepareModelRecovery({ workDir: f.workDir, modelConfig: f.config.model, profile: 'llm-quant-daily' });
  assert.equal(result.changed, true); const current = readJson(path.join(f.workDir, 'research-trace.json'));
  assert.equal(current.correctionCount, 1); assert.deepEqual(current.context, trace.context); assert.deepEqual(current.cards, trace.cards);
  assert.deepEqual(current.repairRequest.errors, trace.repairRequest.errors); assert.equal(current.approval, undefined); assert.equal(current.draft, undefined);
  const history = path.join(f.workDir, current.modelHistory[0].directory); assert.deepEqual(readJson(path.join(history, 'research-trace.json')), trace);
  assert.equal(fs.existsSync(path.join(f.workDir, 'artifact.json')), false);
  assert.equal(prepareModelRecovery({ workDir: f.workDir, modelConfig: f.config.model, profile: 'llm-quant-daily' }).changed, false);
});
test('existing same-provider identity is stable and does not invalidate artifacts', t => {
  const f = fixture(t), identity = modelIdentity(f.config.model);
  writeAtomic(path.join(f.workDir, 'model-identity.json'), { identity, fingerprint: hash(identity) });
  writeAtomic(path.join(f.workDir, 'artifact.json'), { retained: true });
  assert.equal(prepareModelRecovery({ workDir: f.workDir, modelConfig: f.config.model }).changed, false);
  assert.deepEqual(readJson(path.join(f.workDir, 'artifact.json')), { retained: true });
});
test('Codex preflight distinguishes login checks from real inference', async t => {
  const f = fixture(t); f.config.dataDir = path.join(f.root, 'runtime');
  const execFn = async (_exe, args) => args[0] === '--version' ? { stdout: 'codex-cli 0.148.0' } : { stdout: '', stderr: 'Logged in using ChatGPT' };
  const result = await checkCodex(f.config, { execFn }); assert.equal(result.inferencePassed, false);
  await assert.rejects(checkCodex(f.config, { execFn: async () => ({ stdout: 'Logged in using API key' }) }), /ChatGPT/);
});
