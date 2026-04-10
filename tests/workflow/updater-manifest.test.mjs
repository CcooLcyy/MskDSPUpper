import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGithubReleaseAssetUrl,
  createUpdaterTargets,
  formatTimestampAsRfc3339,
} from '../../scripts/workflow/lib/updater-manifest.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('updater manifest helpers derive Windows target keys and timestamps', () => {
  assert.deepEqual(createUpdaterTargets('x86_64-pc-windows-msvc', 'nsis'), [
    'windows-x86_64-nsis',
    'windows-x86_64',
  ]);
  assert.equal(
    formatTimestampAsRfc3339('20260410t010203z'),
    '2026-04-10T01:02:03Z',
  );
});

test('stage-release generates latest.json and renames matched signature assets', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mskdsp-upper-stage-release-'));
  t.after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const distDir = path.join(tempRoot, 'dist');
  const packageDir = path.join(tempRoot, 'package');
  const targetDir = path.join(tempRoot, 'target');
  const metadataFile = path.join(tempRoot, 'metadata.json');
  const bundleDir = path.join(
    targetDir,
    'x86_64-pc-windows-msvc',
    'release',
    'bundle',
    'nsis',
  );
  const releaseDir = path.join(targetDir, 'x86_64-pc-windows-msvc', 'release');
  const installerSourcePath = path.join(bundleDir, 'MskDSP Upper_0.1.0_x64-setup.exe');
  const signatureValue = 'test-updater-signature';
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
    artifactBaseName:
      'mskdsp-upper-0.1.0-beta.0.1.0.20260410t010203_sha.abcdef1-beta-0.1.0-20260410t010203z-abcdef1-windows-x64',
    platform: 'windows-x64',
    targetTriple: 'x86_64-pc-windows-msvc',
    repository: 'CcooLcyy/MskDSPUpper',
    checksumFileName: 'checksums.txt',
    deliveryArchiveName: 'delivery.zip',
    symbolsArchiveName: 'symbols.zip',
  };

  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<html></html>', 'utf8');
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(installerSourcePath, 'installer', 'utf8');
  fs.writeFileSync(`${installerSourcePath}.sig`, signatureValue, 'utf8');
  fs.writeFileSync(path.join(releaseDir, 'mskdsp-upper.exe'), 'binary', 'utf8');
  writeJson(metadataFile, metadata);

  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'workflow', 'stage-release.mjs'),
      '--metadata-file',
      metadataFile,
      '--package-dir',
      packageDir,
      '--target-dir',
      targetDir,
      '--dist-dir',
      distDir,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const stageRoot = path.join(packageDir, 'staging', metadata.channelLabel, metadata.platform);
  const appDir = path.join(stageRoot, 'app');
  const stagedInstallerName = `${metadata.artifactBaseName}.exe`;
  const stagedInstallerPath = path.join(appDir, stagedInstallerName);
  const stagedSignaturePath = `${stagedInstallerPath}.sig`;
  const latestJsonPath = path.join(appDir, 'latest.json');
  const expectedUrl = createGithubReleaseAssetUrl({
    repository: metadata.repository,
    releaseTag: metadata.releaseTag,
    assetName: stagedInstallerName,
  });

  assert.equal(fs.existsSync(stagedInstallerPath), true);
  assert.equal(fs.existsSync(stagedSignaturePath), true);
  assert.equal(fs.readFileSync(stagedSignaturePath, 'utf8'), signatureValue);

  const latestJson = JSON.parse(fs.readFileSync(latestJsonPath, 'utf8'));
  assert.deepEqual(latestJson, {
    version: metadata.effectiveVersion,
    notes: metadata.releaseTitle,
    pub_date: '2026-04-10T01:02:03Z',
    platforms: {
      'windows-x86_64-nsis': {
        url: expectedUrl,
        signature: signatureValue,
      },
      'windows-x86_64': {
        url: expectedUrl,
        signature: signatureValue,
      },
    },
  });

  const stagingManifest = JSON.parse(
    fs.readFileSync(path.join(stageRoot, 'staging-manifest.json'), 'utf8'),
  );
  assert.equal(stagingManifest.generatedUpdaterManifest, path.join('app', 'latest.json'));
  assert.ok(stagingManifest.stagedUpdaterFiles.includes(path.join('app', 'latest.json')));
  assert.ok(
    stagingManifest.stagedUpdaterFiles.includes(path.join('app', `${stagedInstallerName}.sig`)),
  );
});
