import fs from 'node:fs';
import path from 'node:path';

// Check every existing ancestor before creating anything. The project itself
// may be addressed through an alias; writable descendants may not be links.
export function assertProjectPath(root, target) {
  const base = path.resolve(root), full = path.resolve(target);
  if (!fs.existsSync(base)) {
    let existing = path.dirname(base);
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    if (fs.lstatSync(existing).isSymbolicLink()) throw new Error('写入目录或文件不能是符号链接');
    if (!full.startsWith(base + path.sep)) throw new Error('写入目录必须在本项目内');
    return assertProjectPath(existing, full);
  }
  const realBase = fs.realpathSync(base);
  const selectedBase = full.startsWith(base + path.sep) ? base : realBase;
  if (!full.startsWith(selectedBase + path.sep)) throw new Error('写入目录必须在本项目内');
  let current = realBase;
  for (const part of path.relative(selectedBase, full).split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('写入目录或文件不能是符号链接');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return full;
}
