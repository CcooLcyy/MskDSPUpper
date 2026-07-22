import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const modbusSource = readFileSync(new URL('../../src/pages/ModbusRTU/index.tsx', import.meta.url), 'utf8');
const mqttPanelSource = readFileSync(
  new URL('../../src/pages/ModbusRTU/components/MqttConfigPanel.tsx', import.meta.url),
  'utf8',
);
const browserAdapterSource = readFileSync(new URL('../../src/adapters/browser.ts', import.meta.url), 'utf8');

// 验证 MQTT UART 新建连接使用与下位机一致的请求、字节和帧超时默认值。
test('Modbus MQTT UART defaults match the module contract', () => {
  assert.match(modbusSource, /request_timeout_ms:\s*3000/);
  assert.match(modbusSource, /serial_byte_timeout_ms:\s*100/);
  assert.match(modbusSource, /serial_frame_timeout_ms:\s*100/);
});

// 验证切换连接时使用请求序号保护，旧点表响应不能覆盖当前连接。
test('Modbus point table loading ignores stale connection responses', () => {
  assert.match(modbusSource, /pointLoadRequestRef/);
  assert.match(modbusSource, /requestId\s*!==\s*pointLoadRequestRef\.current/);
});

// 验证连接和点位保存具有显式提交状态，避免重复发送配置请求。
test('Modbus modal submissions expose busy state', () => {
  assert.match(modbusSource, /confirmLoading=\{linkSubmitting\}/);
  assert.match(modbusSource, /confirmLoading=\{pointSubmitting\}/);
});

test('Modbus 点表支持复制点位并递增地址', () => {
  assert.match(modbusSource, /const openCopyPoint = useCallback/);
  assert.match(modbusSource, /buildDuplicatePointTag\(point\.tag/);
  assert.match(modbusSource, /getNextDuplicatePointAddress\(point, points\)/);
  assert.match(modbusSource, /onCopy=\{\(index\) => openCopyPoint\(index\)\}/);
});

// 验证打开 Modbus 页面不会静默覆盖模块 MQTT 全局配置。
test('Modbus MQTT config is only written after explicit submit', () => {
  assert.doesNotMatch(mqttPanelSource, /syncDefaultConfig/);
  assert.doesNotMatch(mqttPanelSource, /void\s+syncDefaultConfig\(\)/);
  assert.match(mqttPanelSource, /await api\.modbusRtuUpdateConfig\(payload\)/);
});

// 验证浏览器开发 mock 与 Modbus protobuf 的停止/运行状态枚举一致。
test('browser Modbus mock uses the protocol link state enum', () => {
  assert.match(browserAdapterSource, /modbusRtuStartLink: async \(connName: string\) => setLinkState\(modbusLinks, connName, 2\)/);
  assert.match(browserAdapterSource, /modbusRtuStopLink: async \(connName: string\) => setLinkState\(modbusLinks, connName, 1\)/);
});
