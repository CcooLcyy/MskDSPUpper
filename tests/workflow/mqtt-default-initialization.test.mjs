import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const modbusPanel = readFileSync(
  new URL('../../src/pages/ModbusRTU/components/MqttConfigPanel.tsx', import.meta.url),
  'utf8',
);
const dlt645Panel = readFileSync(
  new URL('../../src/pages/DLT645/components/MqttConfigPanel.tsx', import.meta.url),
  'utf8',
);
const mqttInitializer = readFileSync(
  new URL('../../src/utils/mqtt-initialization.ts', import.meta.url),
  'utf8',
);
const tauriAdapter = readFileSync(new URL('../../src/adapters/tauri.ts', import.meta.url), 'utf8');
const browserAdapter = readFileSync(new URL('../../src/adapters/browser.ts', import.meta.url), 'utf8');

// 验证 MQTT 初始化先查询模块端状态，而不是直接覆盖已有配置。
test('Modbus and DLT645 panels use conditional MQTT initialization', () => {
  assert.match(modbusPanel, /initializeMqttConfig/);
  assert.match(modbusPanel, /getConfig:\s*api\.modbusRtuGetConfig/);
  assert.doesNotMatch(modbusPanel, /syncDefaultConfig/);
  assert.match(dlt645Panel, /initializeMqttConfig/);
  assert.match(dlt645Panel, /getConfig:\s*api\.dlt645GetConfig/);
  assert.doesNotMatch(dlt645Panel, /syncDefaultConfig/);
});

// 验证模块地址未就绪或请求暂时失败时会有限重试，并保留中文诊断信息。
test('MQTT initialization retries transient failures with a bounded policy', () => {
  assert.match(mqttInitializer, /maxAttempts/);
  assert.match(mqttInitializer, /retryDelayMs/);
  assert.match(mqttInitializer, /初始化 MQTT 默认配置失败/);
});

// 验证 Tauri 与浏览器适配器都暴露 MQTT 配置查询能力。
test('MQTT config query is available in both adapters', () => {
  assert.match(tauriAdapter, /modbusRtuGetConfig/);
  assert.match(tauriAdapter, /dlt645GetConfig/);
  assert.match(browserAdapter, /modbusRtuGetConfig/);
  assert.match(browserAdapter, /dlt645GetConfig/);
});

// 验证现有 Modbus 页面安全约束仍保留：默认值只在初始化流程确认缺失后下发。
test('Modbus MQTT defaults are still submitted through the explicit update API', () => {
  assert.match(modbusPanel, /await api\.modbusRtuUpdateConfig\(payload\)/);
  assert.match(modbusPanel, /saveStoredMqttConfig/);
});
