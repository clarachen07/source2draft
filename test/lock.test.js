import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireInstanceLock } from '../src/lib/lock.js';

const moduleUrl = new URL('../src/lib/lock.js', import.meta.url).href;
function contender(root) {
  const script = `import { acquireInstanceLock } from ${JSON.stringify(moduleUrl)};
    let release;
    process.on('message', async command => {
      if (command === 'acquire') {
        try { release = await acquireInstanceLock(process.argv[1]); process.send({ locked: true }); }
        catch (error) { process.send({ locked: false, message: error.message }); }
      } else if (command === 'release') { await release?.(); process.disconnect(); }
    });
    process.send({ ready: true });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  return { child, ready: once(child, 'message') };
}
async function cleanup(children) {
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }));
}
async function race(root, count, children) {
  const contenders = Array.from({ length: count }, () => contender(root));
  children.push(...contenders.map(item => item.child));
  await Promise.all(contenders.map(item => item.ready));
  const results = contenders.map(({ child }) => once(child, 'message'));
  for (const { child } of contenders) child.send('acquire');
  const messages = await Promise.all(results);
  assert.equal(messages.filter(([result]) => result.locked).length, 1);
  for (const [result] of messages.filter(([result]) => !result.locked)) assert.match(result.message, /已有实例/);
  return contenders[messages.findIndex(([result]) => result.locked)].child;
}

test('lock canonicalizes symlink roots, isolates projects, preserves inode, and is private', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-lock-roots-'));
  const root = path.join(directory, 'project'), other = path.join(directory, 'other'), alias = path.join(directory, 'alias');
  fs.mkdirSync(root); fs.mkdirSync(other); fs.symlinkSync(root, alias);
  let release, otherRelease;
  try {
    release = await acquireInstanceLock(root);
    const filename = path.join(root, '.local', 'instance-lock.sqlite'), before = fs.statSync(filename);
    assert.equal(before.mode & 0o777, 0o600);
    await assert.rejects(acquireInstanceLock(alias), /已有实例/);
    otherRelease = await acquireInstanceLock(other);
    await release(); await release();
    assert.equal(fs.statSync(filename).ino, before.ino);
    release = await acquireInstanceLock(alias);
    assert.equal(fs.statSync(filename).ino, before.ino);
  } finally { await release?.(); await otherRelease?.(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('concurrent processes elect one owner and SIGKILL recovery still elects only one owner', { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-lock-race-')), children = [];
  try {
    const first = await race(root, 8, children);
    const filename = path.join(root, '.local', 'instance-lock.sqlite'), inode = fs.statSync(filename).ino;
    await assert.rejects(acquireInstanceLock(root), /已有实例/);
    const exited = once(first, 'exit'); first.kill('SIGKILL'); await exited;
    const second = await race(root, 8, children);
    assert.equal(fs.statSync(filename).ino, inode);
    await assert.rejects(acquireInstanceLock(root), /已有实例/);
    const released = once(second, 'exit'); second.send('release'); await released;
    const release = await acquireInstanceLock(root); await release();
    assert.equal(fs.statSync(filename).ino, inode);
  } finally { await cleanup(children); fs.rmSync(root, { recursive: true, force: true }); }
});
