import path from 'node:path';
import { parseArgs } from 'node:util';

import { readJsonFile, writeJsonFile } from './lib/filesystem.mjs';
import { logInfo, resolveRepoRoot, setGithubOutput } from './lib/runtime.mjs';

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    'metadata-file': { type: 'string' },
    endpoint: { type: 'string' },
    'bundle-targets': { type: 'string' },
    'updater-artifacts': { type: 'string' },
  },
});

const repoRoot = resolveRepoRoot(import.meta.url);
const tauriConfigPath = path.join(repoRoot, 'src-tauri', 'tauri.conf.json');
const tauriConfig = readJsonFile(tauriConfigPath);
const metadata = values['metadata-file']
  ? readJsonFile(path.resolve(repoRoot, values['metadata-file']))
  : null;

if (metadata) {
  tauriConfig.version = metadata.effectiveVersion;
}

if (values.endpoint) {
  tauriConfig.plugins = tauriConfig.plugins ?? {};
  tauriConfig.plugins.updater = tauriConfig.plugins.updater ?? {};
  tauriConfig.plugins.updater.endpoints = [values.endpoint];
}

if (values['bundle-targets']) {
  tauriConfig.bundle = tauriConfig.bundle ?? {};
  tauriConfig.bundle.targets = values['bundle-targets'];
}

const updaterArtifactsMode = values['updater-artifacts'] ?? 'auto';
if (updaterArtifactsMode === 'true') {
  tauriConfig.bundle.createUpdaterArtifacts = true;
} else if (updaterArtifactsMode === 'false') {
  tauriConfig.bundle.createUpdaterArtifacts = false;
} else {
  tauriConfig.bundle.createUpdaterArtifacts = Boolean(
    process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_FILE,
  );
}

const outputPath = path.resolve(
  repoRoot,
  values.output ?? path.join('package', 'generated', 'tauri.ci.conf.json'),
);

writeJsonFile(outputPath, tauriConfig);
logInfo('已生成 Tauri CI 配置', { outputPath });
setGithubOutput('tauri_config', outputPath);
