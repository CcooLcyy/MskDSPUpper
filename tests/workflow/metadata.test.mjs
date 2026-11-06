import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  createArtifactBaseName,
  createChannelLabel,
  createEffectiveVersion,
  createReleaseTag,
  formatBeijingTimestamp,
} from '../../scripts/workflow/lib/metadata.mjs';

// 验证 nightly 版本号会带上统一的时间戳与短 SHA 后缀。
test('nightly metadata uses prerelease semver suffix', () => {
  const version = createEffectiveVersion({
    baseVersion: '0.1.0',
    channel: 'nightly',
    timestamp: '20260408t010203z',
    shortSha: 'abcdef1',
  });

  assert.equal(version, '0.1.0-nightly.20260408t090203+sha.abcdef1');
});

// 北京时间转换覆盖跨日、跨月和跨年，原始输入始终表示 UTC。
test('Beijing build timestamp handles calendar boundaries', () => {
  for (const [utc, beijing] of [
    ['20260408t010203z', '20260408t090203'],
    ['20260408t180203z', '20260409t020203'],
    ['20260430t180203z', '20260501t020203'],
    ['20261231t180203z', '20270101t020203'],
  ]) {
    assert.equal(formatBeijingTimestamp(utc), beijing);
    assert.equal(createEffectiveVersion({ baseVersion: '0.1.0', channel: 'ci', timestamp: utc, shortSha: 'abcdef1' }), `0.1.0-ci.${beijing}+sha.abcdef1`);
    assert.equal(createReleaseTag({ channel: 'ci', timestamp: utc, shortSha: 'abcdef1' }), `ci-${beijing}-utc8-abcdef1`);
  }
});

// 退役后直接调用公共元数据函数也不能创建新的 Beta 包身份。
test('metadata producers reject retired beta channel', () => {
  const options = {
    baseVersion: '1.2.3', channel: 'beta', timestamp: '20260408t010203z', shortSha: '1234567',
  };
  assert.throws(() => createEffectiveVersion(options), /不支持的渠道/);
  assert.throws(() => createReleaseTag(options), /不支持的渠道/);
  assert.throws(() => createChannelLabel('beta'), /不支持的渠道/);
});

// CLI 拒绝 Beta 和旧版本线参数；现行包元数据不再输出 Beta 专用字段。
test('metadata CLI rejects beta inputs and emits current channels without beta line', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'upper-metadata-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../../scripts/workflow/emit-build-metadata.mjs', import.meta.url));
  const output = path.join(directory, 'metadata.json');
  const run = (args) => spawnSync(process.execPath, [script, ...args, '--output', output], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } });
  const beta = run(['--channel', 'beta']);
  assert.notEqual(beta.status, 0);
  assert.match(beta.stderr, /Beta/);
  assert.equal(fs.existsSync(output), false);
  const obsoleteArgument = run(['--channel', 'ci', '--beta-line', '1.2']);
  assert.notEqual(obsoleteArgument.status, 0);
  assert.match(obsoleteArgument.stderr, /beta-line/);
  assert.equal(fs.existsSync(output), false);
  for (const channel of ['ci', 'nightly', 'stable']) {
    const result = run(['--channel', channel, '--timestamp', '20261231t180203z']);
    assert.equal(result.status, 0, result.stderr);
    const metadata = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(metadata.channel, channel);
    assert.equal(metadata.channelLabel, channel);
    assert.equal(Object.hasOwn(metadata, 'betaLine'), false);
    assert.equal(metadata.timestamp, '20261231t180203z');
    if (channel !== 'stable') {
      assert.match(metadata.effectiveVersion, /20270101t020203/);
      assert.match(metadata.artifactBaseName, /20270101t020203-utc8/);
    }
  }
});

// 验证交付物命名同时包含项目、渠道、时间戳、SHA 与平台信息。
test('artifact base name is stable and channel aware', () => {
  const artifactName = createArtifactBaseName({
    projectSlug: 'mskdsp-upper',
    effectiveVersion: '0.1.0-nightly.20260408t090203+sha.abcdef1',
    channelLabel: 'nightly',
    timestamp: '20260408t010203z',
    shortSha: 'abcdef1',
    platform: 'windows-x64',
  });

  assert.equal(
    artifactName,
    'mskdsp-upper-0.1.0-nightly.20260408t090203_sha.abcdef1-nightly-20260408t090203-utc8-abcdef1-windows-x64',
  );
});
