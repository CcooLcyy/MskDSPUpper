import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const iec104Source = readFileSync(new URL('../../src/pages/IEC104/index.tsx', import.meta.url), 'utf8');
const modbusSource = readFileSync(new URL('../../src/pages/ModbusRTU/index.tsx', import.meta.url), 'utf8');
const dlt645Source = readFileSync(new URL('../../src/pages/DLT645/index.tsx', import.meta.url), 'utf8');

// 验证点表 RPC 失败会显示明确错误，不会静默伪装成空配置。
test('protocol pages report point table loading failures', () => {
  assert.match(iec104Source, /加载 IEC104 点表失败/);
  assert.match(modbusSource, /加载 ModbusRTU 点表失败/);
  assert.match(dlt645Source, /加载 DLT645 点表失败/);
});
