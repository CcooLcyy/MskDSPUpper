import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { confirmLowerUpdateDeployment } from '../../src/utils/lower-update-package-cleanup.ts';

const makeRequest = () => ({
  package_name: 'mskdsp-v1.0.0-linux-arm64',
  expected_image_id: `sha256:${'a'.repeat(64)}`,
  upload_account: 'test@192.0.2.1:22',
  install_dir: '/home/test',
  auth: { method: 'password', password: 'test-password' },
  sudo_password: 'test-sudo-password',
});
const cleanupResult = { remote_path: '/home/test/mskdsp-v1.0.0-linux-arm64', removed_files: 2, reclaimed_bytes: 1024 };

// 验证没有成功安装记录时不查询镜像、不清理历史包。
test('package cleanup requires a successful installation request', async () => {
  const calls = [];
  const result = await confirmLowerUpdateDeployment(null, {
    verifyImage: async () => { calls.push('verify'); return 'succeeded'; },
    cleanupPackages: async () => { calls.push('cleanup'); return cleanupResult; },
  });
  assert.deepEqual(calls, []);
  assert.equal(result.verification, 'failed');
  assert.equal(result.cleanupResult, null);
});

// 验证镜像确认完成后才清理，并使用成功安装时的目标与包而非后来切换的值。
test('package cleanup follows verification and preserves the installation target', async () => {
  const request = makeRequest();
  const expected = structuredClone(request);
  const calls = [];
  const result = await confirmLowerUpdateDeployment(request, {
    verifyImage: async (snapshot) => {
      calls.push('verify');
      assert.deepEqual(snapshot, expected);
      request.package_name = 'mskdsp-v2.0.0-linux-x64';
      request.upload_account = 'other@192.0.2.2:22';
      request.auth.password = 'changed';
      return 'succeeded';
    },
    cleanupPackages: async (snapshot) => {
      calls.push('cleanup');
      assert.deepEqual(snapshot, expected);
      return cleanupResult;
    },
  });
  assert.deepEqual(calls, ['verify', 'cleanup']);
  assert.equal(result.verification, 'succeeded');
  assert.deepEqual(result.cleanupResult, cleanupResult);
  assert.equal(result.cleanupError, null);
});

// 验证镜像不一致或查询失败时不删除任何历史包。
test('package cleanup is skipped when the running image is mismatched or unavailable', async () => {
  for (const verification of ['mismatch', 'failed']) {
    let cleanupCalls = 0;
    const result = await confirmLowerUpdateDeployment(makeRequest(), {
      verifyImage: async () => verification,
      cleanupPackages: async () => { cleanupCalls += 1; return cleanupResult; },
    });
    assert.equal(result.verification, verification);
    assert.equal(cleanupCalls, 0);
    assert.equal(result.cleanupResult, null);
    assert.equal(result.cleanupError, null);
  }
});

// 验证镜像查询抛错时仍不调用清理接口。
test('package cleanup does not run after a verification exception', async () => {
  let cleanupCalls = 0;
  await assert.rejects(confirmLowerUpdateDeployment(makeRequest(), {
    verifyImage: async () => { throw new Error('镜像查询失败'); },
    cleanupPackages: async () => { cleanupCalls += 1; return cleanupResult; },
  }), /镜像查询失败/);
  assert.equal(cleanupCalls, 0);
});

// 验证清理失败保留升级成功状态，并允许重复确认后重试清理。
test('package cleanup failure preserves verification success and can be retried', async () => {
  const error = new Error('历史安装包清理失败');
  let cleanupCalls = 0;
  const operations = {
    verifyImage: async () => 'succeeded',
    cleanupPackages: async () => {
      cleanupCalls += 1;
      if (cleanupCalls === 1) throw error;
      return cleanupResult;
    },
  };
  const failed = await confirmLowerUpdateDeployment(makeRequest(), operations);
  assert.equal(failed.verification, 'succeeded');
  assert.equal(failed.cleanupError, error);
  assert.equal(failed.cleanupResult, null);
  const retried = await confirmLowerUpdateDeployment(makeRequest(), operations);
  assert.deepEqual(retried.cleanupResult, cleanupResult);
  assert.equal(retried.cleanupError, null);
  assert.equal(cleanupCalls, 2);
});

// 验证页面与各适配器接入同一清理接口，重置安装时清空成功安装记录。
test('deployment page and adapters wire package cleanup to successful installation context', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
  const page = read('../../src/pages/AdvancedConfig/index.tsx');
  assert.match(page, /successfulInstallRequestRef\.current = request/);
  assert.match(page, /const resetInstallState[^]*?successfulInstallRequestRef\.current = null/);
  assert.match(page, /confirmLowerUpdateDeployment\(successfulInstallRequestRef\.current/);
  assert.match(page, /verifyRunningImage\(request\.expected_image_id, request\)/);
  assert.match(page, /api\.cleanupLowerUpdatePackages\(request\)/);
  assert.match(page, /历史包清理/);
  assert.match(page, /升级已完成，历史安装包清理失败/);
  assert.match(read('../../src/adapters/tauri.ts'), /cleanupLowerUpdatePackages:[^]*?'cleanup_lower_update_packages'/);
  assert.match(read('../../src/adapters/browser.ts'), /cleanupLowerUpdatePackages:/);
  assert.match(read('../../src/offline/adapter/workspace-api.ts'), /'cleanupLowerUpdatePackages'/);
});
