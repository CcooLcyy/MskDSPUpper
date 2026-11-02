import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { PARAMETER_HELP } from '../../src/components/help/parameter-help.ts';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// 验证公共参数说明包含工程量公式、单位语义和配置影响。
test('参数说明覆盖关键语义', () => {
  assert.match(PARAMETER_HELP.common.scale, /工程量 = 原始值 × 缩放系数 \+ 偏移量/);
  assert.match(PARAMETER_HELP.common.offset, /工程量单位/);
  assert.match(PARAMETER_HELP.common.deadband, /不进行变化过滤/);
  assert.match(PARAMETER_HELP.common.pollInterval, /通信负载/);
  assert.match(PARAMETER_HELP.modbus.addressBase, /0 基/);
  assert.match(PARAMETER_HELP.modbus.addressBase, /1 基/);
  assert.match(PARAMETER_HELP.mqtt.cleanSession, /会话/);
  assert.match(PARAMETER_HELP.control.commandMode, /绝对值模式/);
  assert.match(PARAMETER_HELP.control.commandMode, /增量值模式/);
});

// 验证首批协议配置页均接入 Ant Design 标签问号提示。
test('核心协议配置页接入参数提示', () => {
  const sourceExpectations = [
    ['../../src/pages/ModbusRTU/index.tsx', 12],
    ['../../src/pages/ModbusTCP/index.tsx', 10],
    ['../../src/pages/DLT645/index.tsx', 12],
    ['../../src/pages/IEC104/index.tsx', 12],
    ['../../src/pages/ModbusRTU/components/MqttConfigPanel.tsx', 3],
    ['../../src/pages/DLT645/components/MqttConfigPanel.tsx', 3],
    ['../../src/pages/AVC/index.tsx', 20],
  ];

  for (const [path, minimumCount] of sourceExpectations) {
    const source = Array.isArray(path) ? path.map(read).join('\n') : read(path);
    assert.match(source, /PARAMETER_HELP/);
    assert.ok(
      (source.match(/tooltip=\{PARAMETER_HELP\./g) ?? []).length >= minimumCount,
      `${path} 的参数提示数量不足`,
    );
  }
});

// 验证 AGC 剩余可见配置保留具体字段说明，不再依赖已移除输出区的提示数量。
test('AGC 可见字段保留参数提示且移除派生输出手工配置区', () => {
  const page = read('../../src/pages/AGC/index.tsx');
  const member = read('../../src/components/control/AgcMemberEditor.tsx');
  for (const [source, helpKeys] of [
    [page, [
      'control.controlMode', 'control.allocationMode', 'control.calculationPeriod',
      'control.commandPeriod', 'control.signalTag', 'control.unit', 'common.scale',
      'common.offset', 'control.commandMode', 'control.deltaBase', 'control.baseTag',
    ]],
    [member, ['control.capacity', 'control.activeLimits', 'control.weight', 'control.commandMode', 'control.deltaBase']],
  ]) {
    for (const key of helpKeys) {
      assert.ok(source.includes(`tooltip={PARAMETER_HELP.${key}}`), `AGC 可见字段缺少 ${key} 提示`);
    }
  }
  assert.doesNotMatch(page, /title="派生输出点"|className="[^"]*control-config-section--outputs/);
});
