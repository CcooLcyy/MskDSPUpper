import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildConnectionPointOptions, filterConnectionPoints, pointConnectionKey } from '../../src/utils/connection-point-options.ts';
import { controlEndpointKey } from '../../src/utils/control-mapping-editor.ts';

const endpoint = (module_name, conn_name, tag) => ({ module_name, conn_name, tag });
const a = endpoint('ModbusRTU', '逆变器', '测量');
const b = endpoint('ModbusRTU', '另一连接', '设定');
const c = endpoint('ModbusTCP', '逆变器', '测量');
const options = [a, b, c].map(endpoint => ({ endpoint, value: controlEndpointKey(endpoint), label: endpoint.tag }));

// 未选连接没有候选；同协议不同连接、跨协议同名连接均不能串点。
test('point candidates are limited to the selected protocol connection', () => {
  assert.deepEqual(filterConnectionPoints(options, undefined), []);
  assert.deepEqual(filterConnectionPoints(options, pointConnectionKey(a)), [options[0]]);
  assert.deepEqual(filterConnectionPoints(options, pointConnectionKey(b)), [options[1]]);
  assert.deepEqual(filterConnectionPoints(options, pointConnectionKey(c)), [options[2]]);
});

// 保留离线、刷新后缺失及跨连接的历史绑定，筛选不改变原始绑定。
test('connection filters retain all existing bindings and missing points', () => {
  const old = endpoint('IEC104', '历史连接', '历史点');
  const selected = [a, old];
  const model = buildConnectionPointOptions(options, selected);
  assert.equal(model.connections.length, 4);
  assert.equal(model.all.size, 4);
  assert.match(model.all.get(controlEndpointKey(old)).label, /已有绑定/);
  assert.deepEqual(filterConnectionPoints([...model.all.values()], pointConnectionKey(old)).map(x => x.endpoint), [old]);
  assert.deepEqual(selected, [a, old]);
  assert.equal(options.length, 3);
});
