import fs from 'node:fs';
import path from 'node:path';
import { hash, readJson, parseArticle, writeAtomic } from './io.js';

export const QUALITY_POLICY = 2;
export const RENDER_VERSION = 3;
export function fileRecord(file, workDir) {
  const root = fs.realpathSync(workDir), resolved = fs.realpathSync(path.resolve(workDir, file));
  if (!resolved.startsWith(root + path.sep) || fs.lstatSync(path.resolve(workDir, file)).isSymbolicLink()) {
    throw Object.assign(new Error('缓存资产指向任务目录之外或使用符号链接'), { needsReview: true, code: 'SOURCE_ASSET_OUTSIDE_TASK' });
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || !stat.size) throw new Error('缓存文件缺失或为空');
  return { path: path.relative(root, resolved), bytes: stat.size, sha256: hash(fs.readFileSync(resolved)) };
}
export function preparedManifestHash(prepared) {
  const { manifestHash: _manifestHash, ...manifest } = prepared;
  return hash(manifest);
}
export function preparedIdentity(markdown, config, cover, workDir) {
  let coverIdentity = null;
  if (cover?.url) coverIdentity = { url: cover.url };
  else if (cover?.path) coverIdentity = fileRecord(cover.path, workDir);
  return hash({ markdown, renderVersion: RENDER_VERSION, browser: config.browser || null, cover: coverIdentity });
}
export function readPreparedCache(workDir, { markdown, config, cover, repairOutputs = false }) {
  try {
    const prepared = readJson(path.join(workDir, 'prepared.json'));
    if (!prepared || prepared.version !== RENDER_VERSION
      || prepared.identity !== preparedIdentity(markdown, config, cover, workDir)
      || prepared.title !== parseArticle(markdown).title
      || prepared.manifestHash !== preparedManifestHash(prepared)
      || !Array.isArray(prepared.files) || !prepared.files.length) return null;
    const expectedPaths = new Set([...(prepared.assets || []), prepared.coverPath,
      path.join(workDir, 'article.html'), path.join(workDir, 'preview.html')].map(file => path.relative(workDir, path.resolve(workDir, file))));
    if (expectedPaths.size !== prepared.files.length || prepared.files.some(item => !expectedPaths.has(item.path))) return null;
    const damagedOutputs = [];
    for (const file of prepared.files) {
      try { if (JSON.stringify(fileRecord(file.path, workDir)) === JSON.stringify(file)) continue; }
      catch (error) { if (error.needsReview) throw error; }
      const content = prepared.outputContents?.[file.path];
      if (!repairOutputs || typeof content !== 'string' || hash(content) !== file.sha256 || Buffer.byteLength(content) !== file.bytes) return null;
      damagedOutputs.push([file.path, content]);
    }
    for (const [file, content] of damagedOutputs) writeAtomic(path.join(workDir, file), content);
    if (fs.readFileSync(path.join(workDir, 'article.html'), 'utf8') !== prepared.html) return null;
    return prepared;
  } catch (error) { if (error.needsReview) throw error; return null; }
}
function approvalIdentity(artifact, context) {
  const { approval: _approval, ...content } = artifact;
  return hash({ content, ...context });
}
export function approveArtifact(artifact, { input, mode, modelIdentity }) {
  return { ...artifact, approval: { policy: QUALITY_POLICY,
    identity: approvalIdentity(artifact, { input, mode, modelIdentity }) } };
}
export function readArtifactCache(workDir, { input, mode, modelIdentity }) {
  try {
    const artifact = readJson(path.join(workDir, 'artifact.json'));
    if (!artifact?.article || artifact.approval?.policy !== QUALITY_POLICY
      || artifact.approval.identity !== approvalIdentity(artifact, { input, mode, modelIdentity })) return null;
    return artifact;
  } catch { return null; }
}
