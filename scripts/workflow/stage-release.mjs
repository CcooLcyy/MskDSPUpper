import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  copyPath,
  ensureDir,
  listFilesRecursive,
  pathExists,
  readJsonFile,
  removeDir,
  writeJsonFile,
} from './lib/filesystem.mjs';
import { logInfo, logWarn, resolveRepoRoot, setGithubOutput } from './lib/runtime.mjs';
import {
  createGithubReleaseAssetUrl,
  createStaticUpdaterManifest,
  createUpdaterTargets,
  formatTimestampAsRfc3339,
  normalizeUpdaterBundleType,
} from './lib/updater-manifest.mjs';

function findArtifactFiles(rootPath, predicate) {
  return listFilesRecursive(rootPath).filter(predicate);
}

const { values } = parseArgs({
  options: {
    'metadata-file': { type: 'string' },
    'package-dir': { type: 'string' },
    'target-dir': { type: 'string' },
    'dist-dir': { type: 'string' },
    'build-log': { type: 'string' },
    'submodule-status-file': { type: 'string' },
  },
});

if (!values['metadata-file']) {
  throw new Error('--metadata-file 必填');
}

const repoRoot = resolveRepoRoot(import.meta.url);
const metadata = readJsonFile(path.resolve(repoRoot, values['metadata-file']));
const packageDir = path.resolve(repoRoot, values['package-dir'] ?? 'package');
const distDir = path.resolve(repoRoot, values['dist-dir'] ?? 'dist');
const targetDir = path.resolve(repoRoot, values['target-dir'] ?? path.join('src-tauri', 'target'));
const stageRoot = path.join(packageDir, 'staging', metadata.channelLabel, metadata.platform);
const appDir = path.join(stageRoot, 'app');
const symbolsDir = path.join(stageRoot, 'symbols');
const diagnosticsDir = path.join(stageRoot, 'diagnostics');

removeDir(stageRoot);
ensureDir(appDir);
ensureDir(symbolsDir);
ensureDir(diagnosticsDir);

if (!copyPath(distDir, path.join(appDir, 'dist'))) {
  throw new Error(`未找到 dist 目录: ${distDir}`);
}

const bundleRoots = [
  path.join(targetDir, metadata.targetTriple, 'release', 'bundle'),
  path.join(targetDir, 'release', 'bundle'),
];
const releaseRoots = [
  path.join(targetDir, metadata.targetTriple, 'release'),
  path.join(targetDir, 'release'),
];

const bundleRoot = bundleRoots.find((candidate) => pathExists(candidate));
if (!bundleRoot) {
  throw new Error(`未找到 bundle 产物目录: ${bundleRoots.join(', ')}`);
}

const installerFiles = findArtifactFiles(
  bundleRoot,
  (filePath) => /\.(exe|msi)$/i.test(filePath),
);

if (installerFiles.length === 0) {
  throw new Error(`未在 ${bundleRoot} 找到安装包产物`);
}

const stagedInstallers = installerFiles.map((sourcePath) => {
  const extension = path.extname(sourcePath).toLowerCase();
  const destinationName = `${metadata.artifactBaseName}${extension}`;
  const destinationPath = path.join(appDir, destinationName);
  return {
    sourcePath,
    destinationName,
    destinationPath,
    signatureSourcePath: `${sourcePath}.sig`,
    signatureDestinationPath: `${destinationPath}.sig`,
    bundleType: normalizeUpdaterBundleType(path.basename(path.dirname(sourcePath))),
  };
});

const duplicateInstallerAsset = stagedInstallers.find(
  (installer, index) =>
    stagedInstallers.findIndex(
      (candidate) =>
        candidate.destinationName.toLowerCase() === installer.destinationName.toLowerCase(),
    ) !== index,
);

if (duplicateInstallerAsset) {
  throw new Error(`installer 资源命名冲突: ${duplicateInstallerAsset.destinationName}`);
}

const copiedInstallers = stagedInstallers.map((installer) => {
  fs.copyFileSync(installer.sourcePath, installer.destinationPath);
  return installer.destinationPath;
});

const updaterFiles = findArtifactFiles(
  bundleRoot,
  (filePath) => /\.(json|sig)$/i.test(filePath),
);

for (const sourcePath of updaterFiles) {
  const matchedInstaller = stagedInstallers.find(
    (installer) => path.resolve(installer.signatureSourcePath) === path.resolve(sourcePath),
  );
  const destinationPath = matchedInstaller
    ? matchedInstaller.signatureDestinationPath
    : path.join(appDir, path.basename(sourcePath));
  fs.copyFileSync(sourcePath, destinationPath);
}

let generatedUpdaterManifestPath = null;
if (metadata.repository) {
  const platforms = {};

  for (const installer of stagedInstallers) {
    if (!pathExists(installer.signatureSourcePath)) {
      throw new Error(`未找到 updater 签名文件: ${installer.signatureSourcePath}`);
    }

    const signature = fs.readFileSync(installer.signatureSourcePath, 'utf8').trim();
    if (!signature) {
      throw new Error(`updater 签名文件为空: ${installer.signatureSourcePath}`);
    }

    const downloadUrl = createGithubReleaseAssetUrl({
      repository: metadata.repository,
      releaseTag: metadata.releaseTag,
      assetName: path.basename(installer.destinationPath),
    });

    for (const target of createUpdaterTargets(metadata.targetTriple, installer.bundleType)) {
      platforms[target] = {
        url: downloadUrl,
        signature,
      };
    }
  }

  generatedUpdaterManifestPath = path.join(appDir, 'latest.json');
  writeJsonFile(
    generatedUpdaterManifestPath,
    createStaticUpdaterManifest({
      version: metadata.effectiveVersion,
      notes: metadata.releaseTitle,
      pubDate: formatTimestampAsRfc3339(metadata.timestamp),
      platforms,
    }),
  );
} else {
  logWarn('metadata.repository 缺失，跳过 latest.json 生成');
}

const existingReleaseRoots = releaseRoots.filter((candidate) => pathExists(candidate));
if (existingReleaseRoots.length === 0) {
  throw new Error(`未找到 release 产物目录: ${releaseRoots.join(', ')}`);
}

const binaryCandidates = existingReleaseRoots.flatMap((releaseRoot) => [
  path.join(releaseRoot, `${metadata.binaryName}.exe`),
  path.join(releaseRoot, `${metadata.projectSlug}.exe`),
]);

for (const candidate of binaryCandidates) {
  if (pathExists(candidate)) {
    fs.copyFileSync(candidate, path.join(appDir, path.basename(candidate)));
    break;
  }
}

const pdbFiles = existingReleaseRoots.flatMap((releaseRoot) =>
  fs
    .readdirSync(releaseRoot)
    .filter((name) => /\.pdb$/i.test(name))
    .map((name) => path.join(releaseRoot, name)),
);

for (const sourcePath of pdbFiles) {
  fs.copyFileSync(sourcePath, path.join(symbolsDir, path.basename(sourcePath)));
}

const sourceMaps = listFilesRecursive(path.join(appDir, 'dist')).filter((filePath) =>
  filePath.endsWith('.map'),
);
for (const sourcePath of sourceMaps) {
  const relativePath = path.relative(path.join(appDir, 'dist'), sourcePath);
  const destinationPath = path.join(symbolsDir, 'dist', relativePath);
  ensureDir(path.dirname(destinationPath));
  fs.copyFileSync(sourcePath, destinationPath);
}

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

copyPath(path.resolve(repoRoot, values['metadata-file']), path.join(diagnosticsDir, 'build-metadata.json'));

if (values['build-log'] && pathExists(path.resolve(repoRoot, values['build-log']))) {
  copyPath(
    path.resolve(repoRoot, values['build-log']),
    path.join(diagnosticsDir, path.basename(values['build-log'])),
  );
}

if (
  values['submodule-status-file'] &&
  pathExists(path.resolve(repoRoot, values['submodule-status-file']))
){
  copyPath(
    path.resolve(repoRoot, values['submodule-status-file']),
    path.join(diagnosticsDir, path.basename(values['submodule-status-file'])),
  );
}

const manifest = {
  metadata,
  stageRoot,
  appDir,
  symbolsDir,
  diagnosticsDir,
  installers: copiedInstallers.map((filePath) => path.relative(stageRoot, filePath)),
  updaterFiles: updaterFiles.map((filePath) => path.relative(bundleRoot, filePath)),
  stagedUpdaterFiles: listFilesRecursive(appDir)
    .filter((filePath) => /\.(json|sig)$/i.test(filePath))
    .map((filePath) => path.relative(stageRoot, filePath)),
  generatedUpdaterManifest: generatedUpdaterManifestPath
    ? path.relative(stageRoot, generatedUpdaterManifestPath)
    : null,
  pdbFiles: pdbFiles.map((filePath) => path.relative(repoRoot, filePath)),
  sourceMaps: sourceMaps.map((filePath) => path.relative(appDir, filePath)),
};

const manifestPath = path.join(stageRoot, 'staging-manifest.json');
writeJsonFile(manifestPath, manifest);

logInfo('已完成 staging 收集', {
  stageRoot,
  installerCount: copiedInstallers.length,
  updaterManifestGenerated: Boolean(generatedUpdaterManifestPath),
  symbolCount: pdbFiles.length + sourceMaps.length,
});

setGithubOutput('stage_root', stageRoot);
setGithubOutput('staging_manifest', manifestPath);
