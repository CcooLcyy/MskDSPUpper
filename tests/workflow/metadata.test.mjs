import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createArtifactBaseName,
  createChannelLabel,
  createEffectiveVersion,
} from '../../scripts/workflow/lib/metadata.mjs';

// 验证 nightly 版本号会带上统一的时间戳与短 SHA 后缀。
test('nightly metadata uses prerelease semver suffix', () => {
  const version = createEffectiveVersion({
    baseVersion: '0.1.0',
    channel: 'nightly',
    timestamp: '20260408t010203z',
    shortSha: 'abcdef1',
  });

  assert.equal(version, '0.1.0-nightly.20260408t010203+sha.abcdef1');
});

// 验证 beta 版本线会进入 prerelease 语义，避免不同候选包版本冲突。
test('beta metadata includes beta line in effective version', () => {
  const version = createEffectiveVersion({
    baseVersion: '1.2.3',
    channel: 'beta',
    timestamp: '20260408t010203z',
    shortSha: '1234567',
    betaLine: '1.2',
  });

  assert.equal(version, '1.2.3-beta.1.2.20260408t010203+sha.1234567');
  assert.equal(createChannelLabel('beta', '1.2'), 'beta-1.2');
});

// 验证交付物命名同时包含项目、渠道、时间戳、SHA 与平台信息。
test('artifact base name is stable and channel aware', () => {
  const artifactName = createArtifactBaseName({
    projectSlug: 'mskdsp-upper',
    effectiveVersion: '0.1.0-nightly.20260408t010203+sha.abcdef1',
    channelLabel: 'nightly',
    timestamp: '20260408t010203z',
    shortSha: 'abcdef1',
    platform: 'windows-x64',
  });

  assert.equal(
    artifactName,
    'mskdsp-upper-0.1.0-nightly.20260408t010203_sha.abcdef1-nightly-20260408t010203z-abcdef1-windows-x64',
  );
});
