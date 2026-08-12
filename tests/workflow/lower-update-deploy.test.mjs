import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  assessLowerUpdateCacheFreshness,
  compareLowerUpdateImages,
} from '../../src/utils/lower-update-deploy.ts';

const pageSource = readFileSync(new URL('../../src/pages/AdvancedConfig/index.tsx', import.meta.url), 'utf8');
const backendSource = readFileSync(
  new URL('../../src-tauri/src/commands/lower_update.rs', import.meta.url),
  'utf8',
);
const tauriAdapterSource = readFileSync(
  new URL('../../src/adapters/tauri.ts', import.meta.url),
  'utf8',
);

// 验证同一个 Docker 构建的镜像 ID 比较不区分大小写。
test('lower update treats image ids with different hex casing as the same build', () => {
  assert.equal(
    compareLowerUpdateImages(`sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(64)}`),
    'same',
  );
});

// 验证未知目标镜像不能被误判为已是最新。
test('lower update does not treat missing image ids as the same build', () => {
  assert.equal(compareLowerUpdateImages(`sha256:${'a'.repeat(64)}`, '-'), 'unknown');
  assert.equal(compareLowerUpdateImages(`sha256:${'a'.repeat(64)}`, null), 'unknown');
});

// 验证不同镜像构建会继续进入下发流程。
test('lower update distinguishes different builds', () => {
  assert.equal(
    compareLowerUpdateImages(`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`),
    'different',
  );
});

function makeManifest(overrides = {}) {
  return {
    channel: 'ci',
    platform: 'linux-arm64',
    image_id: `sha256:${'a'.repeat(64)}`,
    asset: {
      sha256: 'a'.repeat(64),
    },
    ...overrides,
  };
}

function makeCachedPackage(manifest = makeManifest(), overrides = {}) {
  return {
    downloaded_at: 1,
    manifest,
    package_path: '/tmp/lower-update.tar.gz',
    package_size: 1,
    sha256: manifest.asset.sha256,
    ...overrides,
  };
}

// 验证缓存新鲜度在未检查、无缓存、匹配和落后场景下保持明确语义。
test('lower update assesses cached package freshness against the online manifest', () => {
  const onlineManifest = makeManifest();
  assert.equal(assessLowerUpdateCacheFreshness(null, null), 'unknown');
  assert.equal(assessLowerUpdateCacheFreshness(onlineManifest, null), 'unavailable');
  assert.equal(
    assessLowerUpdateCacheFreshness(
      onlineManifest,
      makeCachedPackage(makeManifest({ image_id: `SHA256:${'A'.repeat(64)}`, asset: { sha256: 'A'.repeat(64) } })),
    ),
    'current',
  );
  assert.equal(
    assessLowerUpdateCacheFreshness(
      onlineManifest,
      makeCachedPackage(makeManifest({ asset: { sha256: 'b'.repeat(64) } }), { sha256: 'b'.repeat(64) }),
    ),
    'stale',
  );
  assert.equal(
    assessLowerUpdateCacheFreshness(
      onlineManifest,
      makeCachedPackage(makeManifest({ image_id: `sha256:${'b'.repeat(64)}` })),
    ),
    'stale',
  );
  assert.equal(
    assessLowerUpdateCacheFreshness(
      onlineManifest,
      makeCachedPackage(makeManifest({ channel: 'stable' })),
    ),
    'stale',
  );
  assert.equal(
    assessLowerUpdateCacheFreshness(
      onlineManifest,
      makeCachedPackage(makeManifest({ image_id: null }), { sha256: 'a'.repeat(64) }),
    ),
    'unknown',
  );
});

// 验证页面在上传前执行目标机版本预检，并把期望镜像传给安装接口。
test('lower update deploy flow preflights the target before upload and install', () => {
  assert.match(pageSource, /checkLowerUpdateTargetBeforeDeploy\(activeManifest\.image_id\)/);
  assert.match(pageSource, /expected_image_id: expectedImageId/);
  assert.match(
    pageSource,
    /if \(!shouldContinueLowerUpdateDeploy\) \{[\s\S]*?return;[\s\S]*?\}\s*\n\s*setIsUploadModalOpen\(true\)/,
  );
});

// 验证 Rust 安装接口在执行安装命令前也会校验期望镜像。
test('lower update backend checks the expected image before running the package', () => {
  assert.match(backendSource, /pub expected_image_id: String/);
  assert.match(backendSource, /if should_skip_install\([\s\S]*?already_current: true/);
  const preflightIndex = backendSource.indexOf('query_lower_update_runtime_info(&target');
  const installCommandIndex = backendSource.indexOf('let output = tokio::time::timeout(', preflightIndex);
  assert.ok(preflightIndex >= 0, '安装接口应查询目标机运行镜像');
  assert.ok(installCommandIndex > preflightIndex, '安装命令必须在镜像预检之后执行');
});

// 验证上位机能够在不访问在线清单的情况下恢复已校验缓存包。
test('lower update restores verified cached packages when the page opens', () => {
  assert.match(backendSource, /pub async fn list_cached_lower_updates\(/);
  assert.match(tauriAdapterSource, /listCachedLowerUpdates[\s\S]*?invoke<[^>]+>\('list_cached_lower_updates'/);
  assert.match(pageSource, /api\.listCachedLowerUpdates\(channel\)/);
  assert.match(pageSource, /cachedPackages\.map/);
  assert.match(pageSource, /handleDeployCachedPackage\(cachedPackage\)/);
  assert.match(pageSource, /downloaded_at/);
  assert.match(pageSource, /可能不是线上最新版本/);
  assert.match(pageSource, /cacheFreshness/);
  assert.match(pageSource, /const nextCacheFreshness = summarizeCachedPackageFreshness\(manifest, cachedPackages\)/);
  assert.match(pageSource, /setCacheFreshness\(nextCacheFreshness\)/);
  assert.match(pageSource, /assessLowerUpdateCacheFreshness\(manifest, cachedPackage\) === 'current'/);
  assert.match(pageSource, /与线上最新版本一致/);
  assert.match(pageSource, /缓存版本不是线上最新版本/);
});

// 验证“下发已缓存版本”入口只复用缓存清单和本地包，不隐式触发检查或下载。
test('lower update can deploy a cached package without check or download', () => {
  assert.match(pageSource, /下发已缓存版本/);
  const handler = pageSource.match(
    /const handleDeployCachedPackage = async \([^)]*\): Promise<void> => \{([\s\S]*?)\n  \};/,
  );
  assert.ok(handler, '应提供独立的缓存包下发处理函数');
  assert.match(handler[1], /runDeployFlow/);
  assert.doesNotMatch(handler[1], /handleCheckUpdate|handleDownload|checkLowerUpdate|downloadLowerUpdate/);
});
