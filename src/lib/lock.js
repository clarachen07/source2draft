import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// The OS releases SQLite's file lock even after SIGKILL. Never unlink the inode:
// replacing it could let two processes hold locks on different files at this path.
export async function acquireInstanceLock(root) {
  const directory = path.join(fs.realpathSync(root), '.local');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'instance-lock.sqlite');
  fs.closeSync(fs.openSync(filename, 'a', 0o600));
  fs.chmodSync(filename, 0o600);
  let db;
  try {
    db = new Database(filename, { timeout: 0 });
    db.exec('BEGIN EXCLUSIVE');
  }
  catch (error) {
    db?.close();
    if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') throw new Error('个人服务已有实例运行；请先停止服务再运行此命令', { cause: error });
    throw error;
  }
  return async () => { if (db.open) db.close(); };
}
