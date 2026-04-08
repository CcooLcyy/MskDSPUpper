import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { ensureDir, readJsonFile, writeJsonFile } from './lib/filesystem.mjs';
import { replaceCargoPackageVersion, replaceJsonVersion } from './lib/manifests.mjs';
import { logInfo, resolveRepoRoot, setGithubOutput } from './lib/runtime.mjs';

const { values } = parseArgs({
  options: {
    'metadata-file': { type: 'string' },
    'backup-dir': { type: 'string' },
  },
});

if (!values['metadata-file']) {
  throw new Error('--metadata-file 必填');
}

const repoRoot = resolveRepoRoot(import.meta.url);
const metadata = readJsonFile(path.resolve(repoRoot, values['metadata-file']));
const backupDir = path.resolve(repoRoot, values['backup-dir'] ?? path.join('package', '.manifest-backup'));
const targets = [
  'package.json',
  path.join('src-tauri', 'Cargo.toml'),
  path.join('src-tauri', 'tauri.conf.json'),
];

ensureDir(backupDir);

for (const relativePath of targets) {
  const sourcePath = path.join(repoRoot, relativePath);
  const backupPath = path.join(backupDir, relativePath);
  ensureDir(path.dirname(backupPath));
  fs.copyFileSync(sourcePath, backupPath);
}

const packageJsonPath = path.join(repoRoot, 'package.json');
const tauriConfigPath = path.join(repoRoot, 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = path.join(repoRoot, 'src-tauri', 'Cargo.toml');

writeJsonFile(
  packageJsonPath,
  replaceJsonVersion(readJsonFile(packageJsonPath), metadata.effectiveVersion),
);
writeJsonFile(
  tauriConfigPath,
  replaceJsonVersion(readJsonFile(tauriConfigPath), metadata.effectiveVersion),
);
fs.writeFileSync(
  cargoTomlPath,
  replaceCargoPackageVersion(fs.readFileSync(cargoTomlPath, 'utf8'), metadata.effectiveVersion),
  'utf8',
);

logInfo('已应用渠道版本到清单文件', {
  effectiveVersion: metadata.effectiveVersion,
  backupDir,
});

setGithubOutput('backup_dir', backupDir);
setGithubOutput('effective_version', metadata.effectiveVersion);
