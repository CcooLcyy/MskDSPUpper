import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALL_CAPABILITIES,
  capabilitiesFor,
  disabledCapabilities,
  isCapabilityEnabled,
} from '../../src/offline/capabilities.ts';

// 在线模式必须启用全部与既有功能有关的能力，保证门禁分支不会影响既有功能。
// 唯一例外是 workspace.manage（离线工作区目录入口）：在线模式没有工作区，也没有对应既有功能。
test('online mode enables every capability except the offline-only workspace entry', () => {
  const matrix = capabilitiesFor('online');

  for (const capability of ALL_CAPABILITIES) {
    if (capability === 'workspace.manage') {
      continue;
    }

    assert.equal(matrix[capability], true, `在线模式应启用能力: ${capability}`);
  }

  assert.equal(matrix['workspace.manage'], false);
  assert.deepEqual(disabledCapabilities('online'), ['workspace.manage']);
});

// 离线模式只保留配置读写、导出与本地能力，运行态与控制类能力必须关闭。
test('offline mode keeps only workspace and local capabilities', () => {
  assert.equal(isCapabilityEnabled('offline', 'config.read'), true);
  assert.equal(isCapabilityEnabled('offline', 'config.write'), true);
  assert.equal(isCapabilityEnabled('offline', 'config.export'), true);
  assert.equal(isCapabilityEnabled('offline', 'local.settings'), true);
  assert.equal(isCapabilityEnabled('offline', 'workspace.manage'), true);

  assert.equal(isCapabilityEnabled('offline', 'config.push'), false);
  assert.equal(isCapabilityEnabled('offline', 'runtime.read'), false);
  assert.equal(isCapabilityEnabled('offline', 'runtime.control'), false);
  assert.equal(isCapabilityEnabled('offline', 'realtime'), false);
  assert.equal(isCapabilityEnabled('offline', 'soe'), false);
  assert.equal(isCapabilityEnabled('offline', 'module.ops'), false);
  assert.equal(isCapabilityEnabled('offline', 'iec61850'), false);
  assert.equal(isCapabilityEnabled('offline', 'orchestrator'), false);
});

// 两张能力矩阵必须覆盖同一组能力键，避免新增能力时漏配导致门禁失效。
test('both capability matrices cover exactly the declared capability keys', () => {
  const expected = [...ALL_CAPABILITIES].sort();

  for (const mode of ['online', 'offline']) {
    assert.deepEqual(Object.keys(capabilitiesFor(mode)).sort(), expected, mode);
  }
});

// 离线禁用的能力数量必须与能力表总数减去保留能力一致，防止漏改矩阵。
test('offline disabled capability list matches the enabled subset', () => {
  const disabled = disabledCapabilities('offline');
  const enabled = ALL_CAPABILITIES.length - disabled.length;

  assert.equal(enabled, 5);
  assert.ok(disabled.includes('runtime.control'));
  assert.ok(!disabled.includes('config.export'));
  assert.ok(!disabled.includes('workspace.manage'));
});

// 每次取用能力矩阵都必须返回独立副本，避免页面之间互相污染。
test('capability matrices are returned as independent copies', () => {
  const first = capabilitiesFor('offline');
  first.realtime = true;

  assert.equal(capabilitiesFor('offline').realtime, false);
  assert.equal(isCapabilityEnabled('offline', 'realtime'), false);
});
