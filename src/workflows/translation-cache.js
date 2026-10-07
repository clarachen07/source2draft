import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DOCUMENT_VERSION, SOURCE_SNAPSHOT_VERSION } from './translation-config.js';
import { assertSourceDocumentComplete } from './source-document.js';
import { fileRecord, preparedManifestHash, RENDER_VERSION } from '../lib/artifact-cache.js';
import { hash, readJson, writeAtomic } from '../lib/io.js';
import { assertProjectPath } from '../lib/project-path.js';
import { parseTranslationScope } from './translation-scope.js';
import { translationRequirements } from './translation-requirements.js';

export function sourceSnapshotKey(sourceUrl, scope, config) {
  const { requestedText: _requestedText, ...selectedScope } = scope;
  return crypto.createHash('sha256').update(JSON.stringify({
    version: SOURCE_SNAPSHOT_VERSION,
    documentVersion: DOCUMENT_VERSION,
    sourceUrl,
    scope: selectedScope,
    browserEnabled: config.browserEnabled !== false,
    datalabMode: config.datalabMode || 'balanced',
    datalabBaseUrl: config.datalabBaseUrl || '',
  })).digest('hex');
}

export function readSourceSnapshot(snapshotPath, key, workDir, refreshIdentity) {
  try {
    const saved = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    const root = fs.realpathSync(workDir);
    if (saved.version !== SOURCE_SNAPSHOT_VERSION || saved.key !== key || saved.workDir !== root) return undefined;
    if (refreshIdentity && saved.refreshIdentity !== refreshIdentity) return undefined;
    assertSourceDocumentComplete(saved.document);
    if (!Array.isArray(saved.assets) || saved.documentIdentity !== hash(saved.document)) return undefined;
    if (hash(sourceAssetRecords(saved.document, workDir)) !== hash(saved.assets)) return undefined;
    for (const record of saved.assets) if (JSON.stringify(fileRecord(record.path, workDir)) !== JSON.stringify(record)) return undefined;
    const assets = saved.document.blocks.flatMap((block) => [
      ...(block.images || []).map((image) => image.localPath),
      ...(block.type === 'table' ? [block.localPath] : []),
    ]);
    for (const asset of assets) {
      if (typeof asset !== 'string' || !path.isAbsolute(asset)) return undefined;
      const resolved = fs.realpathSync(asset);
      const info = fs.statSync(resolved);
      if (!resolved.startsWith(root + path.sep)) {
        const error = new Error('原文缓存资产指向任务目录之外，已停止恢复');
        error.code = 'SOURCE_ASSET_OUTSIDE_TASK';
        throw error;
      }
      if (!info.isFile() || !info.size) return undefined;
    }
    return saved.document;
  } catch (error) {
    if (error.code === 'SOURCE_ASSET_OUTSIDE_TASK') throw error;
    return undefined;
  }
}


export function sourceAssetRecords(document, workDir) {
  const assets = document.blocks.flatMap(block => [...(block.images || []).map(image => image.localPath),
    ...(block.type === 'table' ? [block.localPath] : [])]).filter(Boolean);
  return [...new Set(assets)].map(file => fileRecord(file, workDir));
}
export function saveSourceSnapshot(filename, key, document, workDir, refreshIdentity) {
  writeAtomic(filename, { version: SOURCE_SNAPSHOT_VERSION, key, workDir: fs.realpathSync(workDir),
    document, documentIdentity: hash(document), assets: sourceAssetRecords(document, workDir), ...(refreshIdentity ? { refreshIdentity } : {}) });
}
export function inheritTranslationRevision({ run, store, workDir, workDirFor, sourceUrl, config }) {
  const requirements = translationRequirements(run.input);
  const refreshIdentity = requirements.refresh ? hash(requirements.refreshRequest) : undefined;
  const parentRequirements = translationRequirements(store.get(run.parent_id)?.input);
  if (!run.parent_id || (refreshIdentity && refreshIdentity !== (parentRequirements.refresh ? hash(parentRequirements.refreshRequest) : undefined))
    || fs.existsSync(path.join(workDir, 'translation-source-document.json'))) return false;
  const key = sourceSnapshotKey(sourceUrl, parseTranslationScope(run.input), config);
  const visited = new Set([run.id]); let id = run.parent_id;
  while (id && !visited.has(id)) {
    visited.add(id);
    const parent = store.get(id);
    if (!parent || parent.thread_key !== run.thread_key || parent.mode !== 'translation') return false;
    const parentDir = workDirFor(parent.id);
    const document = readSourceSnapshot(path.join(parentDir, 'translation-source-document.json'), key, parentDir, refreshIdentity);
    if (document) {
      const copied = new Map();
      const copy = file => {
        if (!file || copied.has(file)) return copied.get(file);
        const record = fileRecord(file, parentDir);
        const target = path.join(workDir, record.path);
        assertProjectPath(workDir, target);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.copyFileSync(path.join(parentDir, record.path), target); fs.chmodSync(target, 0o600);
        copied.set(file, target); return target;
      };
      const cloned = structuredClone(document);
      for (const block of cloned.blocks) {
        for (const image of block.images || []) image.localPath = copy(image.localPath);
        if (block.type === 'table') block.localPath = copy(block.localPath);
      }

      // Only translation data crosses revisions. Remote operations and task states never do.
      try {
        const checkpoint = readJson(path.join(parentDir, 'translation-checkpoint.json'));
        if (checkpoint?.version) writeAtomic(path.join(workDir, 'translation-checkpoint.json'), checkpoint);
      } catch { /* A damaged checkpoint leaves the verified source available. */ }
      // Formula caches are derived files; copy validated records, retaining their own identity.
      try {
        const math = readJson(path.join(parentDir, 'math-cache.json'));
        if (math?.version === 1) {
          const records = {};
          for (const [identity, item] of Object.entries(math.records || {})) {
            try { const record = fileRecord(item.file.path, parentDir); if (hash(record) !== hash(item.file)) continue;
              copy(path.join(parentDir, record.path)); records[identity] = item; } catch { /* Skip broken derived items. */ }
          }
          writeAtomic(path.join(workDir, 'math-cache.json'), { version: 1, records });
        }
      } catch { /* Formula rendering can rebuild missing derived data. */ }
      try {
        const prepared = readJson(path.join(parentDir, 'prepared.json'));
        if (prepared?.version === RENDER_VERSION && prepared.manifestHash === preparedManifestHash(prepared)) {
          const record = fileRecord(prepared.coverPath, parentDir);
          if (prepared.files?.some(item => hash(item) === hash(record))) copy(prepared.coverPath);
        }
      } catch { /* A missing derived cover is rendered in the new revision. */ }
      try {
        const receipts = readJson(path.join(parentDir, 'upload-receipts.json'));
        if (receipts?.version === 1 && receipts.account === hash(config.accountId || '')) {
          const hashes = new Set([...copied.values()].map(file => hash(fs.readFileSync(file))));
          const uploads = Object.fromEntries(Object.entries(receipts.uploads || {}).filter(([key, item]) => {
            const [purpose, digest] = key.split(':');
            return hashes.has(digest) && (purpose === 'body' ? typeof item?.url === 'string' && /^https?:\/\/mmbiz\.qpic\.cn\//.test(item.url)
              : purpose === 'cover' && typeof item?.media_id === 'string' && /^[\w-]{1,512}$/.test(item.media_id));
          }));
          writeAtomic(path.join(workDir, 'upload-receipts.json'), { version: 1, account: receipts.account, uploads });
        }
      } catch { /* Only known successful receipts can be inherited. */ }
      saveSourceSnapshot(path.join(workDir, 'translation-source-document.json'), key, cloned, workDir, refreshIdentity);
      return true;
    }
    id = parent.parent_id;
  }
  return false;
}
