import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig, assertConfig, ROOT } from '../src/config/index.js';
import { escapeHtml } from '../src/lib/io.js';

const label = 'com.source2draft.content-hub';
const target = `gui/${process.getuid()}/${label}`;
const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
const action = process.argv[2];
const run = (args, optional = false) => {
  try { return execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: optional ? 'pipe' : 'inherit' }); }
  catch (e) { if (!optional) throw e; }
};
try {
  if (process.platform !== 'darwin') throw new Error('本服务安装器仅支持 macOS');
  if (action === 'install') {
    assertConfig(loadConfig());
    const logs = path.join(os.homedir(), 'Library/Logs/source2draft');
    fs.mkdirSync(logs, { recursive: true, mode: 0o700 }); fs.mkdirSync(path.dirname(plist), { recursive: true });
    const value = text => `<string>${escapeHtml(text)}</string>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${value(label)}
<key>ProgramArguments</key><array>${value(process.execPath)}${value(path.join(ROOT, 'src/index.js'))}</array>
<key>WorkingDirectory</key>${value(ROOT)}
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer>
<key>ExitTimeOut</key><integer>180</integer><key>Umask</key><integer>63</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key>${value(`${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</dict>
<key>StandardOutPath</key>${value(path.join(logs, 'out.log'))}
<key>StandardErrorPath</key>${value(path.join(logs, 'error.log'))}
</dict></plist>`;
    fs.writeFileSync(plist, xml, { mode: 0o600 }); execFileSync('/usr/bin/plutil', ['-lint', plist], { stdio: 'inherit' });
    run(['bootout', target], true);
    run(['bootstrap', `gui/${process.getuid()}`, plist]); console.log('个人服务已安装并启动；登录后自动运行。');
  } else if (action === 'restart') run(['kickstart', '-k', target]);
  else if (action === 'stop') run(['bootout', target]);
  else if (action === 'status') run(['print', target]);
  else if (action === 'uninstall') { run(['bootout', target], true); fs.rmSync(plist, { force: true }); console.log('已卸载个人服务，保留配置、文章、数据库和日志。'); }
  else throw new Error('可用操作：install、restart、stop、status、uninstall');
} catch (error) { console.error(error.message); process.exitCode = 1; }
