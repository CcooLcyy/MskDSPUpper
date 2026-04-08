import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  copyPath,
  ensureDir,
  pathExists,
  readJsonFile,
  removeDir,
  writeTextFile,
  zipDirectory,
} from './lib/filesystem.mjs';
import { logInfo, resolveRepoRoot, setGithubOutput } from './lib/runtime.mjs';

function renderTemplate(source, replacements) {
  return Object.entries(replacements).reduce(
    (result, [key, value]) => result.replaceAll(`__${key}__`, value),
    source,
  );
}

const { values } = parseArgs({
  options: {
    'metadata-file': { type: 'string' },
    'package-dir': { type: 'string' },
  },
});

if (!values['metadata-file']) {
  throw new Error('--metadata-file 必填');
}

const repoRoot = resolveRepoRoot(import.meta.url);
const metadata = readJsonFile(path.resolve(repoRoot, values['metadata-file']));
const packageDir = path.resolve(repoRoot, values['package-dir'] ?? 'package');
const stageRoot = path.join(packageDir, 'staging', metadata.channelLabel, metadata.platform);
const appDir = path.join(stageRoot, 'app');
const symbolsDir = path.join(stageRoot, 'symbols');
const outDir = path.join(packageDir, 'out', metadata.channelLabel, metadata.platform);
const tempBundleDir = path.join(packageDir, 'tmp', metadata.artifactBaseName);
const payloadDir = path.join(tempBundleDir, 'payload');

removeDir(tempBundleDir);
removeDir(outDir);
ensureDir(payloadDir);
ensureDir(outDir);

copyPath(appDir, payloadDir);

const installerName =
  fs.readdirSync(payloadDir).find((entry) => /\.(exe|msi)$/i.test(entry)) ?? '';

const replacements = {
  PRODUCT_NAME: metadata.productName,
  BINARY_NAME: metadata.binaryName,
  INSTALL_DIR: metadata.defaultInstallDir,
  INSTALLER_NAME: installerName,
  PROCESS_NAME: metadata.binaryName,
};

for (const templateName of [
  'install.ps1',
  'start.ps1',
  'stop.ps1',
  'upgrade.ps1',
  'version.ps1',
  'logs.ps1',
]) {
  const templatePath = path.join(repoRoot, 'scripts', 'workflow', 'templates', templateName);
  const rendered = renderTemplate(fs.readFileSync(templatePath, 'utf8'), replacements);
  writeTextFile(path.join(tempBundleDir, templateName), rendered);
}

writeTextFile(
  path.join(tempBundleDir, 'README.txt'),
  [
    `${metadata.productName} ${metadata.channelLabel} 交付包`,
    '',
    `版本: ${metadata.effectiveVersion}`,
    `渠道: ${metadata.channelLabel}`,
    `时间戳: ${metadata.timestamp}`,
    `提交: ${metadata.shortSha}`,
    '',
    '使用方式:',
    '1. 运行 install.ps1 进行静默安装。',
    '2. 运行 start.ps1 启动客户端。',
    '3. 运行 stop.ps1 停止客户端。',
    '4. 运行 version.ps1 校验安装版本。',
    '5. 运行 logs.ps1 查看日志目录探测结果。',
  ].join('\n'),
);

const deliveryArchivePath = path.join(outDir, metadata.deliveryArchiveName);
zipDirectory(tempBundleDir, deliveryArchivePath);

let symbolsArchivePath = null;
if (pathExists(symbolsDir) && fs.readdirSync(symbolsDir).length > 0) {
  symbolsArchivePath = path.join(outDir, metadata.symbolsArchiveName);
  zipDirectory(symbolsDir, symbolsArchivePath);
}

for (const entry of fs.readdirSync(payloadDir)) {
  const sourcePath = path.join(payloadDir, entry);
  if (fs.statSync(sourcePath).isFile()) {
    const portableName =
      entry.toLowerCase() === `${metadata.binaryName}.exe`.toLowerCase()
        ? `${metadata.artifactBaseName}-portable.exe`
        : entry;
    copyPath(sourcePath, path.join(outDir, portableName));
  }
}

logInfo('已生成交付包与 symbols 包', {
  deliveryArchivePath,
  symbolsArchivePath,
  outDir,
});

setGithubOutput('output_dir', outDir);
setGithubOutput('delivery_archive', deliveryArchivePath);
setGithubOutput('symbols_archive', symbolsArchivePath ?? '');
