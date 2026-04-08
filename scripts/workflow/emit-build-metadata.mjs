import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { readJsonFile, writeJsonFile } from './lib/filesystem.mjs';
import {
  createArtifactBaseName,
  createChannelLabel,
  createEffectiveVersion,
  createReleaseTag,
  createReleaseTitle,
  ensureStableTagMatchesVersion,
  formatUtcTimestamp,
  normalizeGitRef,
  parseBetaLine,
  shortenSha,
} from './lib/metadata.mjs';
import { logInfo, resolveRepoRoot, setGithubOutput } from './lib/runtime.mjs';

function extractCargoValue(source, pattern, fallback = null) {
  const match = source.match(pattern);
  return match ? match[1] : fallback;
}

const { values } = parseArgs({
  options: {
    channel: { type: 'string' },
    repository: { type: 'string' },
    ref: { type: 'string' },
    sha: { type: 'string' },
    tag: { type: 'string' },
    timestamp: { type: 'string' },
    output: { type: 'string' },
    'beta-line': { type: 'string' },
    'target-triple': { type: 'string' },
    platform: { type: 'string' },
  },
});

if (!values.channel) {
  throw new Error('--channel 必填');
}

const repoRoot = resolveRepoRoot(import.meta.url);
const packageJson = readJsonFile(path.join(repoRoot, 'package.json'));
const tauriConfig = readJsonFile(path.join(repoRoot, 'src-tauri', 'tauri.conf.json'));
const cargoToml = fs.readFileSync(path.join(repoRoot, 'src-tauri', 'Cargo.toml'), 'utf8');

const channel = values.channel;
const baseVersion = packageJson.version;
const ref = values.ref ? normalizeGitRef(values.ref) : null;
const sha = values.sha ?? '0000000';
const shortSha = shortenSha(sha);
const timestamp = values.timestamp ?? formatUtcTimestamp();
const betaLine = values['beta-line'] ?? (ref ? parseBetaLine(ref) : null);

if (channel === 'stable' && values.tag) {
  ensureStableTagMatchesVersion(values.tag, baseVersion);
}

const channelLabel = createChannelLabel(channel, betaLine);
const effectiveVersion = createEffectiveVersion({
  baseVersion,
  channel,
  timestamp,
  shortSha,
  betaLine,
});

const binaryName =
  extractCargoValue(cargoToml, /^\[\[bin\]\][\s\S]*?^name\s*=\s*"([^"]+)"/m) ??
  extractCargoValue(cargoToml, /^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m) ??
  'mskdsp-upper';

const projectSlug =
  extractCargoValue(cargoToml, /^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m) ??
  packageJson.name ??
  'mskdsp-upper';

const platform = values.platform ?? 'windows-x64';
const targetTriple = values['target-triple'] ?? 'x86_64-pc-windows-msvc';
const artifactBaseName = createArtifactBaseName({
  projectSlug,
  effectiveVersion,
  channelLabel,
  timestamp,
  shortSha,
  platform,
});

const releaseTag =
  channel === 'stable'
    ? `v${baseVersion}`
    : createReleaseTag({
        channel,
        baseVersion,
        timestamp,
        shortSha,
        betaLine,
      });

const metadata = {
  projectSlug,
  productName: tauriConfig.productName,
  binaryName,
  channel,
  channelLabel,
  betaLine,
  baseVersion,
  effectiveVersion,
  releaseTag,
  releaseTitle: createReleaseTitle({
    productName: tauriConfig.productName,
    channel,
    channelLabel,
    effectiveVersion,
  }),
  timestamp,
  shortSha,
  artifactBaseName,
  platform,
  targetTriple,
  repository: values.repository ?? null,
  checksumFileName: `${artifactBaseName}-SHA256SUMS.txt`,
  deliveryArchiveName: `${artifactBaseName}.zip`,
  symbolsArchiveName: `${artifactBaseName}-symbols.zip`,
  defaultInstallDir: `%LOCALAPPDATA%\\Programs\\${tauriConfig.productName}`,
};

const outputPath = path.resolve(repoRoot, values.output ?? path.join('package', 'build-metadata.json'));
writeJsonFile(outputPath, metadata);

logInfo('已生成构建元数据', { outputPath, metadata });

setGithubOutput('metadata_file', outputPath);
setGithubOutput('channel', channel);
setGithubOutput('channel_label', channelLabel);
setGithubOutput('effective_version', effectiveVersion);
setGithubOutput('artifact_base_name', artifactBaseName);
setGithubOutput('release_tag', releaseTag);
setGithubOutput('release_title', metadata.releaseTitle);
setGithubOutput('beta_line', betaLine ?? '');
