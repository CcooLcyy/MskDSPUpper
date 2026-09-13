import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const listSource = readFileSync(new URL('../../src/components/protocol/ProtocolConnectionList.tsx', import.meta.url), 'utf8');
const iec104Source = readFileSync(new URL('../../src/pages/IEC104/index.tsx', import.meta.url), 'utf8');
const iec61850Source = readFileSync(new URL('../../src/pages/IEC61850/index.tsx', import.meta.url), 'utf8');
const typesSource = readFileSync(new URL('../../src/adapters/types.ts', import.meta.url), 'utf8');

// 验证公共连接列表支持独立于功能运行状态的通信状态点和悬浮提示。
test('协议连接列表使用独立通信状态颜色', () => {
  assert.match(listSource, /getConnectionStateColor\?:/);
  assert.match(listSource, /getConnectionStateLabel\?:/);
  assert.match(listSource, /getConnectionStateColor\?\.\(item\)/);
  assert.match(listSource, /aria-label=\{stateLabel\}/);
});

// 验证 IEC104 页面只将 CONNECTED 显示为绿色，并读取 connection_state 字段。
test('IEC104 页面显示 TCP 通信状态点', () => {
  assert.match(typesSource, /connection_state: number/);
  assert.match(iec104Source, /CONNECTION_STATE_COLOR_MAP/);
  assert.match(iec104Source, /item\.connection_state/);
  assert.match(iec104Source, /selectedLink\.connection_state/);
});

// 验证 IEC61850 页面依据任一已连接 MMS 通道显示绿色状态点。
test('IEC61850 页面按 MMS 通道状态显示通信状态点', () => {
  assert.match(iec61850Source, /CHANNEL_STATE_CONNECTED = 4/);
  assert.match(iec61850Source, /some\(\(channel\) => channel\.state === CHANNEL_STATE_CONNECTED\)/);
  assert.match(iec61850Source, /getIedConnectionState/);
});
