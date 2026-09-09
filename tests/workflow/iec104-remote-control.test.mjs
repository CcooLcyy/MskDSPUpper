import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { generateBatchPoints } from '../../src/pages/IEC104/batch-point.ts';
import {
  COMMAND_EXECUTION_MODE_DIRECT,
  COMMAND_EXECUTION_MODE_SELECT_EXECUTE,
  REMOTE_CONTROL_TYPE_DOUBLE,
  REMOTE_CONTROL_TYPE_SINGLE,
  isRemoteControlBusinessType,
  normalizeRemoteControlFields,
} from '../../src/pages/IEC104/remote-control.ts';

const pageSource = readFileSync(new URL('../../src/pages/IEC104/index.tsx', import.meta.url), 'utf8');
const browserSource = readFileSync(new URL('../../src/adapters/browser.ts', import.meta.url), 'utf8');
const rustSource = readFileSync(new URL('../../src-tauri/src/commands/iec104.rs', import.meta.url), 'utf8');

// 验证旧点位缺少新增字段时仍按“单点遥控 + 选择后执行”解释。
test('IEC104 遥控字段兼容旧点位默认值', () => {
  const normalized = normalizeRemoteControlFields({ tag: 'breaker' });

  assert.equal(normalized.remote_control_type, REMOTE_CONTROL_TYPE_SINGLE);
  assert.equal(normalized.command_execution_mode, COMMAND_EXECUTION_MODE_SELECT_EXECUTE);
  assert.equal(isRemoteControlBusinessType(4), true);
  assert.equal(isRemoteControlBusinessType(2), false);
});

// 验证显式配置双点直接遥控时不会被兼容默认值覆盖。
test('IEC104 遥控字段保留双点直接执行配置', () => {
  const normalized = normalizeRemoteControlFields({
    remote_control_type: REMOTE_CONTROL_TYPE_DOUBLE,
    command_execution_mode: COMMAND_EXECUTION_MODE_DIRECT,
  });

  assert.equal(normalized.remote_control_type, REMOTE_CONTROL_TYPE_DOUBLE);
  assert.equal(normalized.command_execution_mode, COMMAND_EXECUTION_MODE_DIRECT);
});

// 验证批量生成遥控点会完整携带双点和直接执行字段。
test('IEC104 批量遥控点保留命令类型和执行方式', () => {
  const result = generateBatchPoints({
    text: 'breaker_open\nbreaker_close',
    startIoa: 0x6001,
    step: 1,
    ioaCategory: 'remoteControl',
    pointType: 2,
    scale: 1,
    offset: 0,
    deadband: 0,
    remoteControlType: REMOTE_CONTROL_TYPE_DOUBLE,
    commandExecutionMode: COMMAND_EXECUTION_MODE_DIRECT,
  });

  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.drafts.map((point) => ({
    businessType: point.business_type,
    remoteControlType: point.remote_control_type,
    commandExecutionMode: point.command_execution_mode,
  })), [
    { businessType: 4, remoteControlType: 2, commandExecutionMode: 1 },
    { businessType: 4, remoteControlType: 2, commandExecutionMode: 1 },
  ]);
});

// 验证编辑、复制、批量和导入入口均贯通新增字段，且控件只为遥控点显示。
test('IEC104 页面贯通遥控命令配置', () => {
  assert.match(pageSource, /isRemoteControlBusinessType\(pointBusinessType\)/);
  assert.match(pageSource, /name="remote_control_type"/);
  assert.match(pageSource, /name="command_execution_mode"/);
  assert.match(pageSource, /remote_control_type: source\.remote_control_type \|\|/);
  assert.match(pageSource, /command_execution_mode: source\.command_execution_mode \|\|/);
  assert.match(pageSource, /remoteControlType: batchRemoteControlType/);
  assert.match(pageSource, /commandExecutionMode: batchCommandExecutionMode/);
  assert.match(pageSource, /isRemoteControlBusinessType\(record\.business_type\)/);
  assert.match(pageSource, /remote_control_type: draft\.remote_control_type/);
  assert.match(pageSource, /command_execution_mode: draft\.command_execution_mode/);
});

// 验证桌面端 DTO 和浏览器 mock 都在协议边界补齐旧配置默认值。
test('IEC104 适配器统一补齐遥控默认值', () => {
  assert.match(rustSource, /serde\(default = "default_remote_control_type"\)/);
  assert.match(rustSource, /serde\(default = "default_command_execution_mode"\)/);
  assert.match(rustSource, /remote_control_type: normalize_remote_control_type\(point\.remote_control_type\)/);
  assert.match(rustSource, /command_execution_mode: normalize_command_execution_mode\(self\.command_execution_mode\)/);
  assert.match(browserSource, /remote_control_type: point\.remote_control_type \|\| IEC104_REMOTE_CONTROL_TYPE_SINGLE/);
  assert.match(browserSource, /command_execution_mode: point\.command_execution_mode \|\| IEC104_COMMAND_EXECUTION_MODE_SELECT_EXECUTE/);
});
