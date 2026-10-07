import { assertProjectPath } from '../lib/project-path.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, readJson, writeAtomic } from '../lib/io.js';
import { modelIdentity } from './model-identity.js';

const generated = ['research-trace.json', 'translation-checkpoint.json', 'artifact.json', 'article.md',
  'article.html', 'preview.html', 'prepared.json', 'cover.png', 'model-identity.json'];

// Called only before a new model stage, never before remote-operation recovery.
export function prepareModelRecovery({ workDir, modelConfig, profile, mode }) {
  const filename = path.join(workDir, 'model-identity.json');
  const identity = modelIdentity(modelConfig, { profile, mode }), saved = readJson(filename);
  const existing = generated.filter(name => fs.existsSync(path.join(workDir, name)));
  const changed = saved ? saved.fingerprint !== hash(identity)
    : identity.provider !== 'deepseek' && existing.length > 0;
  if (changed) {
    const historyRoot = path.join(workDir, 'model-history');
    assertProjectPath(workDir, historyRoot);
    fs.mkdirSync(historyRoot, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(historyRoot).isSymbolicLink()) throw new Error('模型历史目录不能是符号链接');
    const history = path.join(historyRoot, randomUUID()); fs.mkdirSync(history, { mode: 0o700 });
    for (const name of existing) {
      const source = path.join(workDir, name);
      if (!fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) throw new Error('模型历史文件不合法，已停止恢复');
      fs.copyFileSync(source, path.join(history, name), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(path.join(history, name), 0o600);
    }
    writeAtomic(path.join(history, 'change.json'), { from: saved?.identity || { provider: 'deepseek', legacy: true }, to: identity,
      at: new Date().toISOString() });
    const trace = readJson(path.join(workDir, 'research-trace.json'));
    if (trace) {
      if (profile === 'llm-quant-daily') {
        for (const key of ['writing', 'repairWriting', 'draft', 'draftWritingIdentity', 'approval', 'reviewFailure', 'reviewPasses', 'narrowing']) delete trace[key];
        // Existing repairRequest/baseDraft/correctionCount remain intact.
        if (trace.repairRequest) trace.repairRequest.complete = false;
      } else { delete trace.draft; delete trace.approvedReview; }
      trace.modelHistory = [...(trace.modelHistory || []), { directory: path.relative(workDir, history), from: saved?.identity || { provider: 'deepseek', legacy: true }, to: identity }];
      writeAtomic(path.join(workDir, 'research-trace.json'), trace);
    }
    // These files are safe to remove only after their exact local copies exist.
    for (const name of existing.filter(name => !['research-trace.json', 'model-identity.json', 'cover.png'].includes(name))) fs.unlinkSync(path.join(workDir, name));
  }
  writeAtomic(filename, { identity, fingerprint: hash(identity) });
  return { changed, identity };
}
