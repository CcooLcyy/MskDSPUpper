import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { computeSha256, readJsonFile, writeTextFile } from './lib/filesystem.mjs';
import { logInfo, resolveRepoRoot, setGithubOutput } from './lib/runtime.mjs';

const { values } = parseArgs({
  options: {
    'metadata-file': { type: 'string' },
    'output-dir': { type: 'string' },
  },
});

if (!values['metadata-file']) {
  throw new Error('--metadata-file 必填');
}

const repoRoot = resolveRepoRoot(import.meta.url);
const metadata = readJsonFile(path.resolve(repoRoot, values['metadata-file']));
const outputDir = path.resolve(
  repoRoot,
  values['output-dir'] ?? path.join('package', 'out', metadata.channelLabel, metadata.platform),
);

const checksumPath = path.join(outputDir, metadata.checksumFileName);
const lines = fs
  .readdirSync(outputDir)
  .filter((entry) => entry !== metadata.checksumFileName)
  .map((entry) => path.join(outputDir, entry))
  .filter((entryPath) => fs.statSync(entryPath).isFile())
  .sort((left, right) => path.basename(left).localeCompare(path.basename(right)))
  .map((entryPath) => `${computeSha256(entryPath)}  ${path.basename(entryPath)}`);

writeTextFile(checksumPath, `${lines.join('\n')}\n`);
logInfo('已生成 SHA256SUMS', { checksumPath, fileCount: lines.length });
setGithubOutput('checksum_file', checksumPath);
