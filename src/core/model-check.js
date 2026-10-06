import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createModel } from './model.js';
import { codexEnvironment } from './codex-model.js';
import { prepareData } from '../config/index.js';

const runFile = promisify(execFile);
export async function checkCodex(config, { infer = false, execFn = runFile, modelFactory = createModel } = {}) {
  const executable = config.model.cliPath;
  const options = { env: codexEnvironment(), timeout: 15000, maxBuffer: 64 * 1024, encoding: 'utf8' };
  let version, login;
  try {
    version = (await execFn(executable, ['--version'], options)).stdout.trim();
    const status = await execFn(executable, ['login', 'status', '-c', 'features.context_management=false', '-c', 'forced_login_method="chatgpt"'], options);
    login = `${status.stdout || ''}\n${status.stderr || ''}`;
  } catch { throw new Error('Codex CLI 路径、配置或 ChatGPT 登录检查失败；请检查本机登录'); }
  if (!/^codex-cli [0-9.]+/.test(version) || !/Logged in using ChatGPT/.test(login)) throw new Error('Codex CLI 必须使用 ChatGPT 订阅登录；未调用模型');
  const result = { provider: 'codex-cli', cliPath: executable, version, auth: 'chatgpt', model: config.model.models.writer,
    effort: config.model.effort, inferencePassed: false };
  if (infer) {
    prepareData(config);
    const dir = path.join(config.dataDir, 'connection-checks', randomUUID()); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const usage = [], model = modelFactory(config, { workDir: dir, onUsage: event => usage.push(event) });
    const text = await model.complete({ prompt: '只回复 CODEX_TEXT_OK。', timeoutMs: 120000 });
    if (text.trim() !== 'CODEX_TEXT_OK') throw new Error('Codex 文本推理验证未通过');
    const json = await model.json({ prompt: '只返回JSON {"ok":true,"marker":"CODEX_JSON_OK"}。', timeoutMs: 120000,
      validate: data => data.ok === true && data.marker === 'CODEX_JSON_OK' });
    result.inferencePassed = true;
    result.calls = usage.map(({ provider, model, effort, usage }) => ({ provider, model, effort, usage }));
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ ...result, text, json }, null, 2), { mode: 0o600 });
  }
  return result;
}
