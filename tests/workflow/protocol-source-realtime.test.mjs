import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const realtimeSource = readFileSync(
  new URL('../../src/components/protocol/protocol-realtime.tsx', import.meta.url),
  'utf8',
);
const iec104Source = readFileSync(new URL('../../src/pages/IEC104/index.tsx', import.meta.url), 'utf8');
const modbusSource = readFileSync(new URL('../../src/pages/ModbusRTU/index.tsx', import.meta.url), 'utf8');
const dlt645Source = readFileSync(new URL('../../src/pages/DLT645/index.tsx', import.meta.url), 'utf8');

// 验证：协议页统一通过源端最新值接口监视采集点，不依赖影子路由。
test('protocol pages use source latest realtime monitoring', () => {
  assert.match(realtimeSource, /dcGetSourceLatest/);
  assert.doesNotMatch(realtimeSource, /dcGetProtocolShadowLatest/);
  assert.doesNotMatch(realtimeSource, /dcStartProtocolShadowStream/);
  assert.match(iec104Source, /useProtocolRealtime/);
  assert.match(modbusSource, /useProtocolRealtime/);
  assert.match(dlt645Source, /useProtocolRealtime/);
});

// 验证：协议页实时轮询具有请求代次和在途保护，旧响应不能覆盖当前连接的数据。
test('protocol source realtime polling rejects stale responses and overlap', () => {
  assert.match(realtimeSource, /requestIdRef/);
  assert.match(realtimeSource, /requestId\s*!==\s*requestIdRef\.current/);
  assert.match(realtimeSource, /refreshInFlightRef/);
});

// 验证：实时查询成功后会恢复错误状态，避免短暂故障留下永久告警。
test('protocol source realtime clears recovered query errors', () => {
  assert.match(realtimeSource, /setError\(null\)/);
});
