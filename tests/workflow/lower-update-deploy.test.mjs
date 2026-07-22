import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compareLowerUpdateImages } from '../../src/utils/lower-update-deploy.ts';

const pageSource = readFileSync(new URL('../../src/pages/AdvancedConfig/index.tsx', import.meta.url), 'utf8');
const backendSource = readFileSync(
  new URL('../../src-tauri/src/commands/lower_update.rs', import.meta.url),
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
