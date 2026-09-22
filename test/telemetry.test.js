import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTelemetry, measureStage } from '../src/lib/telemetry.js';
import { fetchRetry } from '../src/lib/io.js';
import { createModel } from '../src/core/model.js';
import { loadConfig } from '../src/config/index.js';

test('model retry timing is recorded without request text, URLs, keys or response content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-metrics-'));
  let calls = 0;
  const usage = [];
  try {
    const onTelemetry = createTelemetry(dir);
    const model = createModel(loadConfig({ DEEPSEEK_API_KEY: 'private-fixture-key' }), { onTelemetry,
      onUsage: event => usage.push(event), fetchFn: async () => ++calls === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '0' } })
        : Response.json({ model: 'fixture', usage: { total_tokens: 8 }, choices: [{ finish_reason: 'stop', message: { content: 'private-response' } }] }),
    });
    assert.equal(await model.complete({ role: 'writer', prompt: 'private-prompt' }), 'private-response');
    onTelemetry({ stage: 'fixture', count: 2, prompt: 'private-prompt', url: 'https://private.example', token: 'private-fixture-key' });
    const raw = fs.readFileSync(path.join(dir, 'metrics.jsonl'), 'utf8');
    assert.doesNotMatch(raw, /private-/);
    const events = raw.trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(e => e.stage === 'model.request').length, 2);
    assert.ok(events.some(e => e.retrying === true));
    assert.equal(events.find(e => e.stage === 'model.complete').attempts, 2);
    assert.equal(usage[0].attempts, 2);
    assert.ok(usage[0].durationMs >= 0);
    assert.equal(fs.statSync(path.join(dir, 'metrics.jsonl')).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('diagnostic callback failures cannot retry a successful mutation or replace its result', async () => {
  let calls = 0;
  const broken = () => { throw new Error('diagnostic failed'); };
  const result = await measureStage(broken, 'mutation', () => fetchRetry(async () => {
    calls++; return Response.json({ id: 'created' });
  }, 'https://example.org/mutation', { method: 'POST' }, { onAttempt: broken }));
  assert.deepEqual(await result.json(), { id: 'created' });
  assert.equal(calls, 1);
});
