import path from 'node:path';
import { parseArgs } from 'node:util';

import { copyPath, ensureDir, pathExists, readJsonFile, writeTextFile } from './lib/filesystem.mjs';
import { git } from './lib/git.mjs';
import { logInfo, resolveRepoRoot, setGithubOutput } from './lib/runtime.mjs';

const { values } = parseArgs({
  options: {
    channel: { type: 'string' },
    phase: { type: 'string' },
    'package-dir': { type: 'string' },
    'metadata-file': { type: 'string' },
    'build-log': { type: 'string' },
  },
});

const repoRoot = resolveRepoRoot(import.meta.url);
const packageDir = path.resolve(repoRoot, values['package-dir'] ?? 'package');
const channel = values.channel ?? 'unknown';
const phase = values.phase ?? 'failure';
const diagnosticsDir = path.join(packageDir, 'diagnostics', `${channel}-${phase}`);

ensureDir(diagnosticsDir);

for (const relativePath of [
  'package.json',
  'package-lock.json',
  '.gitmodules',
  path.join('src-tauri', 'Cargo.toml'),
  path.join('src-tauri', 'Cargo.lock'),
  path.join('src-tauri', 'tauri.conf.json'),
]) {
  copyPath(path.join(repoRoot, relativePath), path.join(diagnosticsDir, relativePath));
}

if (values['metadata-file'] && pathExists(path.resolve(repoRoot, values['metadata-file']))) {
  const metadata = readJsonFile(path.resolve(repoRoot, values['metadata-file']));
  copyPath(
    path.resolve(repoRoot, values['metadata-file']),
    path.join(diagnosticsDir, 'build-metadata.json'),
  );

  for (const relativePath of [
    path.join('package', 'generated'),
    path.join('package', 'staging', metadata.channelLabel, metadata.platform),
    path.join('package', 'out', metadata.channelLabel, metadata.platform),
  ]) {
    copyPath(path.join(repoRoot, relativePath), path.join(diagnosticsDir, relativePath));
  }
}

if (pathExists(path.join(repoRoot, 'dist'))) {
  copyPath(path.join(repoRoot, 'dist'), path.join(diagnosticsDir, 'dist'));
}

for (const candidate of [
  path.join('src-tauri', 'target', 'release', 'bundle'),
  path.join('src-tauri', 'target', 'x86_64-pc-windows-msvc', 'release', 'bundle'),
]) {
  const sourcePath = path.join(repoRoot, candidate);
  if (pathExists(sourcePath)) {
    copyPath(sourcePath, path.join(diagnosticsDir, candidate));
  }
}

if (values['build-log'] && pathExists(path.resolve(repoRoot, values['build-log']))) {
  copyPath(
    path.resolve(repoRoot, values['build-log']),
    path.join(diagnosticsDir, path.basename(values['build-log'])),
  );
}

writeTextFile(
  path.join(diagnosticsDir, 'git-status.txt'),
  git(['status', '--short'], { allowFailure: true }).stdout,
);
writeTextFile(
  path.join(diagnosticsDir, 'git-submodule-status.txt'),
  git(['submodule', 'status'], { allowFailure: true }).stdout,
);
writeTextFile(
  path.join(diagnosticsDir, 'git-head.txt'),
  git(['rev-parse', 'HEAD'], { allowFailure: true }).stdout,
);

logInfo('已收集诊断信息', { diagnosticsDir });
setGithubOutput('diagnostics_dir', diagnosticsDir);
