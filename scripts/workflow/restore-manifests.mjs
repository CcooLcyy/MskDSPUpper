import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { pathExists } from './lib/filesystem.mjs';
import { logInfo, resolveRepoRoot } from './lib/runtime.mjs';

const { values } = parseArgs({
  options: {
    'backup-dir': { type: 'string' },
  },
});

const repoRoot = resolveRepoRoot(import.meta.url);
const backupDir = path.resolve(repoRoot, values['backup-dir'] ?? path.join('package', '.manifest-backup'));

if (!pathExists(backupDir)) {
  logInfo('未找到 manifest 备份目录，跳过恢复', { backupDir });
  process.exit(0);
}

for (const relativePath of [
  'package.json',
  path.join('src-tauri', 'Cargo.toml'),
  path.join('src-tauri', 'tauri.conf.json'),
]) {
  const backupPath = path.join(backupDir, relativePath);
  if (!pathExists(backupPath)) {
    continue;
  }

  fs.copyFileSync(backupPath, path.join(repoRoot, relativePath));
}

logInfo('已恢复 manifest 文件', { backupDir });
