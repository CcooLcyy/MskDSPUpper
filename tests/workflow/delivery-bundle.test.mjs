import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('create-delivery-bundle uses staged installer manifest and PowerShell env install path', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mskdsp-upper-delivery-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const packageDir = path.join(tempRoot, 'package');
  const metadataFile = path.join(tempRoot, 'metadata.json');
  const metadata = {
    projectSlug: 'mskdsp-upper',
    productName: 'MskDSP Upper',
    binaryName: 'mskdsp-upper',
    channel: 'beta',
    channelLabel: 'beta-0.1.0',
    betaLine: '0.1.0',
    baseVersion: '0.1.0',
    effectiveVersion: '0.1.0-beta.0.1.0.20260410t010203+sha.abcdef1',
    releaseTag: 'beta-0-1-0-20260410t010203z-abcdef1',
    releaseTitle: 'MskDSP Upper beta/0.1.0 0.1.0-beta.0.1.0.20260410t010203+sha.abcdef1',
    timestamp: '20260410t010203z',
    shortSha: 'abcdef1',
    artifactBaseName: 'mskdsp-upper-test-artifact',
    platform: 'windows-x64',
    targetTriple: 'x86_64-pc-windows-msvc',
    repository: 'CcooLcyy/MskDSPUpper',
    checksumFileName: 'checksums.txt',
    deliveryArchiveName: 'delivery.zip',
    symbolsArchiveName: 'symbols.zip',
    defaultInstallDir: '$env:LOCALAPPDATA\\Programs\\MskDSP Upper',
  };
  const stageRoot = path.join(packageDir, 'staging', metadata.channelLabel, metadata.platform);
  const appDir = path.join(stageRoot, 'app');

  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'mskdsp-upper.exe'), 'gui binary', 'utf8');
  fs.writeFileSync(path.join(appDir, `${metadata.artifactBaseName}.exe`), 'installer', 'utf8');
  fs.writeFileSync(path.join(appDir, `${metadata.artifactBaseName}.exe.sig`), 'signature', 'utf8');
  writeJson(path.join(stageRoot, 'staging-manifest.json'), {
    installers: [path.join('app', `${metadata.artifactBaseName}.exe`)],
  });
  writeJson(metadataFile, metadata);

  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'workflow', 'create-delivery-bundle.mjs'),
      '--metadata-file',
      metadataFile,
      '--package-dir',
      packageDir,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const bundleRoot = path.join(packageDir, 'tmp', metadata.artifactBaseName);
  const outDir = path.join(packageDir, 'out', metadata.channelLabel, metadata.platform);
  const installScript = fs.readFileSync(path.join(bundleRoot, 'install.ps1'), 'utf8');
  const startScript = fs.readFileSync(path.join(bundleRoot, 'start.ps1'), 'utf8');

  assert.match(installScript, /payload\\mskdsp-upper-test-artifact\.exe/);
  assert.doesNotMatch(installScript, /payload\\mskdsp-upper\.exe/);
  assert.match(startScript, /\$env:LOCALAPPDATA\\Programs\\MskDSP Upper\\mskdsp-upper\.exe/);
  assert.equal(fs.existsSync(path.join(outDir, `${metadata.artifactBaseName}.exe`)), true);
  assert.equal(fs.existsSync(path.join(outDir, 'mskdsp-upper.exe')), false);
});

test('build metadata schema requires workflow fields used by packaging helpers', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'scripts', 'workflow', 'schema', 'build-metadata.schema.json'), 'utf8'),
  );

  assert.ok(schema.required.includes('targetTriple'));
  assert.ok(schema.required.includes('defaultInstallDir'));
  assert.equal(schema.properties.defaultInstallDir.type, 'string');
});
