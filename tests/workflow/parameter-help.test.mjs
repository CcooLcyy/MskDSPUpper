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
    ['../../src/pages/AGC/index.tsx', 20],
    ['../../src/pages/AVC/index.tsx', 20],
  ];

  for (const [path, minimumCount] of sourceExpectations) {
    const source = read(path);
    assert.match(source, /PARAMETER_HELP/);
    assert.ok(
      (source.match(/tooltip=\{PARAMETER_HELP\./g) ?? []).length >= minimumCount,
      `${path} 的参数提示数量不足`,
    );
  }
});
