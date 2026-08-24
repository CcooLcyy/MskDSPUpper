import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const realtimeSource = read('../../src/components/protocol/protocol-realtime.tsx');
const tauriAdapterSource = read('../../src/adapters/tauri.ts');
const browserAdapterSource = read('../../src/adapters/browser.ts');
const dataCenterCommandSource = read('../../src-tauri/src/commands/data_center.rs');
const dataCenterGrpcSource = read('../../src-tauri/src/grpc/data_center.rs');
const iec104Source = read('../../src/pages/IEC104/index.tsx');
const modbusSource = read('../../src/pages/ModbusRTU/index.tsx');
const dlt645Source = read('../../src/pages/DLT645/index.tsx');

// 验证协议实时值 Hook 和非 IEC104 从站页面保留 DataCenter 源端查询路径。
test('protocol realtime source latest path remains available', () => {
  assert.match(realtimeSource, /export function useProtocolRealtime\(/);
  assert.match(realtimeSource, /api\.dcGetSourceLatest\(/);
  assert.match(tauriAdapterSource, /dcGetSourceLatest:/);
  assert.match(browserAdapterSource, /dcGetSourceLatest:/);
  assert.match(dataCenterCommandSource, /pub async fn dc_get_source_latest\(/);
  assert.match(dataCenterGrpcSource, /get_source_latest\(/);
  assert.match(iec104Source, /useProtocolRealtime/);
  assert.match(modbusSource, /useProtocolRealtime/);
  assert.match(dlt645Source, /useProtocolRealtime/);
});

// 验证 IEC104 从站运行视图读取路由后的目的端最新值。
test('IEC104 slave runtime monitor uses destination latest query', () => {
  assert.match(realtimeSource, /export type ProtocolRealtimeQueryMode = 'source' \| 'destination'/);
  assert.match(realtimeSource, /mode === 'destination'/);
  assert.match(realtimeSource, /api\.dcGetLatest\(/);
  assert.match(realtimeSource, /dst_conn_id[\s\S]*dst_tag/);
  assert.match(iec104Source, /const realtimeQueryMode[\s\S]*isSlaveStationConfig\(selectedLink\?\.config\)/);
  assert.match(iec104Source, /useProtocolRealtime\([\s\S]*realtimeQueryMode/);
});
