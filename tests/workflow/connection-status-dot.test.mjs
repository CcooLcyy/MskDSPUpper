import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const listSource = readFileSync(new URL('../../src/components/protocol/ProtocolConnectionList.tsx', import.meta.url), 'utf8');
const iec104Source = readFileSync(new URL('../../src/pages/IEC104/index.tsx', import.meta.url), 'utf8');
const iec61850Source = readFileSync(new URL('../../src/pages/IEC61850/index.tsx', import.meta.url), 'utf8');
const modbusSource = readFileSync(new URL('../../src/pages/ModbusRTU/index.tsx', import.meta.url), 'utf8');
const dlt645Source = readFileSync(new URL('../../src/pages/DLT645/index.tsx', import.meta.url), 'utf8');
const typesSource = readFileSync(new URL('../../src/adapters/types.ts', import.meta.url), 'utf8');

// 验证公共连接列表支持独立于功能运行状态的通信状态点和悬浮提示。
test('协议连接列表使用独立通信状态颜色', () => {
  assert.match(listSource, /getConnectionStateColor\?:/);
  assert.match(listSource, /getConnectionStateLabel\?:/);
  assert.match(listSource, /getConnectionStateColor\?\.\(item\)/);
  assert.match(listSource, /getConnectionStateLabel\?\.\(item\) \?\? getStateLabel\?\.\(item\)/);
  assert.match(listSource, /aria-label=\{stateLabel\}/);
  assert.match(listSource, /display: 'inline-block'/);
});

// 验证 IEC104 页面按链路运行状态显示连接列表状态点，而不是按 TCP 会话状态显示。
test('IEC104 页面按链路运行状态显示状态点', () => {
  assert.match(typesSource, /connection_state: number/);
  assert.match(iec104Source, /LIST_STATE_COLOR_MAP/);
  assert.match(iec104Source, /getStateColor=\{\(item\) => LIST_STATE_COLOR_MAP\[item\.state\]/);
  assert.match(iec104Source, /getStateLabel=\{\(item\) => STATE_MAP\[item\.state\]\?\.label/);
  assert.doesNotMatch(iec104Source, /CONNECTION_STATE_COLOR_MAP/);
  assert.doesNotMatch(iec104Source, /getConnectionStateColor=\{\(item\) => CONNECTION_STATE_COLOR_MAP/);
});

// 验证 IEC61850 页面依据任一已连接 MMS 通道显示绿色状态点。
test('IEC61850 页面按 MMS 通道状态显示通信状态点', () => {
  assert.match(iec61850Source, /CHANNEL_STATE_CONNECTED = 4/);
  assert.match(iec61850Source, /some\(\(channel\) => channel\.state === CHANNEL_STATE_CONNECTED\)/);
  assert.match(iec61850Source, /getIedConnectionState/);
});

// 验证 ModbusRTU 与 DLT645 运行中的状态点按最近一轮现场抄读健康状态显示，并保持三秒刷新。
test('ModbusRTU 与 DLT645 使用通信健康状态点并每三秒刷新', () => {
  for (const source of [modbusSource, dlt645Source]) {
    assert.match(source, /communication_state/);
    assert.match(source, /getConnectionStateColor=\{\(item\) => item\.state === 2/);
    assert.match(source, /getConnectionStateLabel=\{\(item\) => item\.state === 2/);
    assert.match(source, /window\.setInterval\([\s\S]*?3000\)/);
  }
  assert.match(modbusSource, /0: '等待首轮抄读'/);
  assert.match(modbusSource, /2: '本轮无有效数据'/);
  assert.match(dlt645Source, /0: '等待首轮抄读'/);
  assert.match(dlt645Source, /2: '本轮无有效数据'/);
});
