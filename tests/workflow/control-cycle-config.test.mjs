import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('AGC 与 AVC 控制周期协议字段保持一致', () => {
  const agcProto = read('proto/AGC.proto');
  const avcProto = read('proto/AVC.proto');

  for (const source of [agcProto, avcProto]) {
    assert.match(source, /CONTROL_MODE_PI_EVENT\s*=\s*1/);
    assert.match(source, /CONTROL_MODE_DIRECT_CYCLIC\s*=\s*2/);
    assert.match(source, /calculation_execution_period_seconds/);
    assert.match(source, /command_control_period_seconds/);
  }
  assert.match(agcProto, /control_mode\s*=\s*7/);
  assert.match(agcProto, /calculation_execution_period_seconds\s*=\s*8/);
  assert.match(agcProto, /command_control_period_seconds\s*=\s*9/);
  assert.match(avcProto, /control_mode\s*=\s*8/);
  assert.match(avcProto, /calculation_execution_period_seconds\s*=\s*9/);
  assert.match(avcProto, /command_control_period_seconds\s*=\s*10/);
});

test('周期直分配表单仅允许标准规定的周期范围', () => {
  const agcPage = read('src/pages/AGC/index.tsx');
  const avcPage = read('src/pages/AVC/index.tsx');
  for (const source of [agcPage, avcPage]) {
    assert.match(source, /calculation_execution_period_seconds/);
    assert.match(source, /command_control_period_seconds/);
    assert.match(source, /min: 1, max: 15/);
    assert.match(source, /min: 4, max: 30/);
    assert.match(source, /CONTROL_MODE_DIRECT_CYCLIC/);
  }
});

test('旧控制组配置默认按 PI 事件触发兼容', () => {
  const agcCommand = read('src-tauri/src/commands/agc.rs');
  const avcCommand = read('src-tauri/src/commands/avc.rs');
  const browserAdapter = read('src/adapters/browser.ts');
  for (const source of [agcCommand, avcCommand]) {
    assert.match(source, /#\[serde\(default\)\]/);
    assert.match(source, /控制模式无效/);
  }
  assert.match(browserAdapter, /control_mode: config\.control_mode \?\? 1/);
});
