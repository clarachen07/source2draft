import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadConfig, missingConfig, assertConfig, prepareData, redact, ROOT } from '../src/config/index.js';
import { openStore } from '../src/core/store.js';
import { createModel } from '../src/core/model.js';
import { createWechat } from '../src/channels/wechat.js';
import { createEngine } from '../src/core/engine.js';
import { prepareArticle } from '../src/lib/wechat-render.js';
import { acquireInstanceLock } from '../src/lib/lock.js';
import { writeAtomic } from '../src/lib/io.js';
import bolt from '@slack/bolt';
import { verifySlackIdentity } from '../src/triggers/slack.js';

process.umask(0o077);
const [command, ...args] = process.argv.slice(2);
const config = loadConfig();
let store, release;
try {
  if (command === 'setup') {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) fs.copyFileSync(path.join(ROOT, '.env.example'), envPath);
    fs.chmodSync(envPath, 0o600);
    console.log(`个人配置文件已准备：${envPath}\n按 docs/SETUP.md 创建个人 Slack App 并填写凭据。`);
  } else if (command === 'config') {
    const missing = missingConfig(config, { wechat: true });
    console.log(`模式：${config.dryRun ? '模拟（不写入微信）' : '真实草稿'}\n待填写：${missing.join(', ') || '无'}`);
    for (const name of ['pdfinfo', 'pdftotext']) { execFileSync(name, ['-v'], { stdio: 'ignore' }); console.log(`${name}：可用`); }
    if (missing.length) process.exitCode = 1;
  } else if (command === 'connections') {
    assertConfig(config, { wechat: true });
    const app = new bolt.App({ token: config.slack.botToken, appToken: config.slack.appToken, socketMode: true, logLevel: 'error' });
    await verifySlackIdentity(app.client, config);
    console.log('Slack Bot 与个人 #general：通过（未发送消息）');
    await app.start(); await app.stop(); console.log('Slack Socket Mode 连接：通过');
    const response = await fetch('https://api.deepseek.com/models', { headers: { Authorization: `Bearer ${config.model.key}` }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`DeepSeek 模型检查 HTTP ${response.status}`);
    const models = (await response.json()).data.map(m => m.id);
    for (const name of Object.values(config.model.models)) if (!models.includes(name)) throw new Error(`DeepSeek 账号当前不可用模型：${name}`);
    console.log('DeepSeek key 与模型可用性：通过');
    await createWechat(config).listDrafts(); console.log('公众号认证与草稿读取：通过（未创建草稿）');
    console.log('Exa 和 Datalab 的可用性需要真实搜索/PDF 任务验证；本命令未产生搜索或解析调用。');
  } else {
    prepareData(config);
    if (command !== 'status') release = await acquireInstanceLock(config.root);
    store = openStore(config.dbPath, { maxQueue: config.maxQueue });
    if (command === 'status') console.log(JSON.stringify(store.list(), null, 2));
    else if (command === 'retry') {
      if (!args[0]) throw new Error('用法：npm run retry -- <任务 ID>（先停止服务）');
      store.retry(args[0]); console.log('已重新入队；请启动服务，结果不明的上传只进行核对。');
    } else if (command === 'preview') {
      if (!args[0]) throw new Error('用法：npm run preview -- <本地 Markdown 文件>');
      const dir = path.join(config.dataDir, 'previews', crypto.randomUUID()); fs.mkdirSync(dir, { recursive: true });
      const markdown = fs.readFileSync(path.resolve(args[0]), 'utf8');
      // Arbitrary files outside a task are never read through image references.
      await prepareArticle({ markdown, workDir: dir, config, signal: AbortSignal.timeout(120000) });
      console.log(path.join(dir, 'preview.html'));
    } else if (command === 'run' || command === 'wechat-test') {
      const isTest = command === 'wechat-test';
      if (!args.includes(isTest ? '--create-test-draft' : '--prompt-file')) throw new Error(isTest
        ? '用法：npm run test:wechat -- --create-test-draft；此命令会创建一篇标有【接入测试】的真实草稿'
        : '用法：npm run run:local -- --prompt-file <指令文本文件> [--publish]；默认模拟，不写入微信');
      const publish = isTest || args.includes('--publish');
      if (!isTest) assertConfig(config, { slack: false, wechat: publish });
      if (publish && (!config.wechat.appId || !config.wechat.secret)) throw new Error('请先填写个人公众号凭据');
      const runtime = { ...config, dryRun: !publish };
      if (isTest) await createWechat(runtime).listDrafts();
      const input = isTest ? '公众号接入测试' : fs.readFileSync(path.resolve(args[args.indexOf('--prompt-file') + 1]), 'utf8');
      const stamp = Date.now() / 1000;
      const { run } = store.enqueue({ threadKey: `local:${crypto.randomUUID()}`, ts: String(stamp), text: input, version: stamp, dryRun: !publish });
      const engine = createEngine({ config: runtime, store });
      if (isTest) {
        const dir = engine.workDirFor(run.id); fs.mkdirSync(dir, { recursive: true });
        const article = `---\ntitle: "【接入测试】个人公众号自动草稿"\n---\n\n这是一篇接入测试草稿，仅用于验证个人公众号的素材上传、草稿创建和回读。不会正式发表。\n\n测试时间：${new Date().toISOString()}\n`;
        writeAtomic(path.join(dir, 'article.md'), article); writeAtomic(path.join(dir, 'artifact.json'), { article, warnings: [] });
      }
      await engine.execute(run);
      const result = store.get(run.id); console.log(JSON.stringify({ id: result.id, status: result.status, error: result.error, result: result.result }, null, 2));
      if (result.status !== 'done') process.exitCode = 1;
    } else throw new Error('可用命令：setup、config、connections、status、retry、preview、run、wechat-test');
  }
} catch (error) { console.error(redact(error, config)); process.exitCode = 1; }
finally { store?.close(); await release?.(); }
