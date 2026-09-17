import assert from 'node:assert/strict';
import test from 'node:test';

import {
  connectionKey,
  createConnIdRegistry,
  ensureConnectionId,
  findConnectionId,
  listConnections,
  removeConnectionId,
} from '../../src/offline/workspace/registry.ts';

// 稳定键必须能区分模块名与连接名的不同切分，避免键冲突导致 conn_id 串号。
test('connection key separates module and connection names unambiguously', () => {
  assert.notEqual(connectionKey('AB', 'C'), connectionKey('A', 'BC'));
  assert.equal(connectionKey('IEC104', 'main'), 'IEC104\u0000main');
});

// 同一稳定键重复注册必须返回同一个 conn_id，并且不推进自增号。
test('ensure is idempotent for the same stable key', () => {
  const first = ensureConnectionId(createConnIdRegistry(), 'IEC104', 'main');
  const second = ensureConnectionId(first.registry, 'IEC104', 'main');

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.connId, second.connId);
  assert.equal(second.registry.next_conn_id, first.registry.next_conn_id);
});

// 删除连接后不得复用已分配的 conn_id，避免历史路由指向新连接。
test('removed connection ids are never reused', () => {
  const { registry } = ensureConnectionId(createConnIdRegistry(), 'IEC104', 'main');
  const removed = removeConnectionId(registry, 'IEC104', 'main');

  assert.equal(findConnectionId(removed, 'IEC104', 'main'), null);

  const recreated = ensureConnectionId(removed, 'IEC104', 'main');
  assert.equal(recreated.connId, 2);
  assert.equal(recreated.registry.next_conn_id, 3);
});

// 分配出去的 conn_id 必须跨会话稳定：序列化再解析后仍解析到同一个编号。
test('assigned ids survive a json round trip', () => {
  let registry = createConnIdRegistry();
  ({ registry } = ensureConnectionId(registry, 'ModbusRTU', '1-1#'));
  ({ registry } = ensureConnectionId(registry, 'Calc', '1#'));

  const restored = JSON.parse(JSON.stringify(registry));

  assert.equal(findConnectionId(restored, 'ModbusRTU', '1-1#'), 1);
  assert.equal(findConnectionId(restored, 'Calc', '1#'), 2);
  assert.equal(findConnectionId(restored, 'IEC104', 'main'), null);
});

// 列出的连接必须能还原模块名与连接名，供数据总线与路由页面复用。
test('listConnections restores module and connection names', () => {
  let registry = createConnIdRegistry();
  ({ registry } = ensureConnectionId(registry, 'ModbusRTU', '1-1#'));
  ({ registry } = ensureConnectionId(registry, 'IEC104', '经开区云擎光伏新能源'));

  assert.deepEqual(listConnections(registry), [
    { module_name: 'ModbusRTU', conn_name: '1-1#', conn_id: 1 },
    { module_name: 'IEC104', conn_name: '经开区云擎光伏新能源', conn_id: 2 },
  ]);
});

// 注册表更新必须是纯函数，不能就地修改传入对象，否则页面无法安全回滚。
test('registry updates do not mutate the input registry', () => {
  const registry = createConnIdRegistry();
  const snapshot = JSON.stringify(registry);

  ensureConnectionId(registry, 'IEC104', 'main');
  removeConnectionId(registry, 'IEC104', 'main');

  assert.equal(JSON.stringify(registry), snapshot);
});

// 起始编号可配置，便于测试与后续调整本地编号空间。
test('registry honours a custom start id', () => {
  const { connId, registry } = ensureConnectionId(createConnIdRegistry(100), 'IEC104', 'main');

  assert.equal(connId, 100);
  assert.equal(registry.next_conn_id, 101);
});
