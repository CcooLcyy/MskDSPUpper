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

// 验证协议页实时值链路使用源端最新值查询，而不是影子连接事件或影子快照。
test('protocol pages use DataCenter source latest query', () => {
  assert.match(realtimeSource, /export function useProtocolRealtime\(/);
  assert.match(realtimeSource, /api\.dcGetSourceLatest\(/);
  assert.doesNotMatch(realtimeSource, /dcGetProtocolShadowLatest|dcStartProtocolShadowStream|protocol-shadow-update|listen</);
  assert.doesNotMatch(tauriAdapterSource, /dcGetProtocolShadowLatest|dcStartProtocolShadowStream|protocol-shadow/);
  assert.doesNotMatch(browserAdapterSource, /dcGetProtocolShadowLatest|dcStartProtocolShadowStream|protocol-shadow/);
  assert.doesNotMatch(dataCenterCommandSource, /dc_start_protocol_shadow_stream|dc_get_protocol_shadow_latest/);
  assert.equal(
    (dataCenterCommandSource.match(/cleanup_legacy_protocol_shadow_connections/g) ?? []).length,
    3,
  );
  assert.match(tauriAdapterSource, /dcGetSourceLatest:/);
  assert.match(browserAdapterSource, /dcGetSourceLatest:/);
  assert.match(dataCenterCommandSource, /pub async fn dc_get_source_latest\(/);
  assert.match(dataCenterGrpcSource, /get_source_latest\(/);
  assert.match(iec104Source, /useProtocolRealtime/);
  assert.match(modbusSource, /useProtocolRealtime/);
  assert.match(dlt645Source, /useProtocolRealtime/);
});
