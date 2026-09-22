import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
for (const file of ['src', 'scripts', 'test'].flatMap(walk).filter(f => /\.[cm]?js$/.test(f))) execFileSync(process.execPath, ['--check', file]);
const forbidden = [/OPENROUTER_API_KEY|CUSTOMERIO_APP_API_KEY|DISCORD_.*WEBHOOK/];
// Machine-specific isolation markers stay local and are never published.
const localPatterns = '.local/isolation-patterns.json';
if (fs.existsSync(localPatterns)) {
  const { patterns } = JSON.parse(fs.readFileSync(localPatterns, 'utf8'));
  if (!Array.isArray(patterns) || patterns.some(pattern => typeof pattern !== 'string')) throw new Error('本机隔离规则格式不正确');
  forbidden.push(...patterns.map(pattern => new RegExp(pattern)));
}
for (const file of walk('src')) if (forbidden.some(pattern => pattern.test(fs.readFileSync(file, 'utf8')))) throw new Error('检测到不属于本项目的集成配置：' + file);
console.log('语法和项目隔离检查通过。');
