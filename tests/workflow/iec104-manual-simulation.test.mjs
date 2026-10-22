import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildManualSimulationDraft,
  buildManualSimulationPoints,
  buildManualSimulationSnapshot,
} from '../../src/pages/IEC104/manual-simulation.ts';
import { buildIec104SimulationUpdates, resolveIec104RuntimeDisplay } from '../../src/pages/IEC104/simulation-realtime.ts';

const analog = { tag: '功率', ioa: 16385, point_type: 1, business_type: 2, scale: 1, offset: 0 };
const digital = { tag: '开关', ioa: 1, point_type: 2, business_type: 1 };
const table = [analog, digital, { ...analog, tag: '固定', fixed_value_enabled: true },
  { ...analog, tag: '遥调', business_type: 3 }, { ...analog, tag: '其他类型', point_type: 3 },
  { ...analog, tag: '错配遥测', business_type: 1 }, { ...digital, tag: '错配遥信', business_type: 2 }];
const request = [{ tag: '功率', point_type: 1, double_value: 0 }, { tag: '开关', point_type: 2, bool_value: false }];
const slave = { station_role: 2, role: 2 };

test('手动草稿排除固定与非上报点，未模拟点没有隐式默认值', () => {
  const rows = buildManualSimulationDraft(table, null);
  assert.deepEqual(rows.map(({ tag, selected, value }) => ({ tag, selected, value })), [
    { tag: '开关', selected: false, value: undefined }, { tag: '功率', selected: false, value: undefined },
  ]);
  rows[0].selected = true;
  assert.throws(() => buildManualSimulationPoints(rows), /开关.*0.*1/);
});

test('已有快照初始化为勾选，合法0和false保留，草稿不修改原快照', () => {
  const snapshot = buildManualSimulationSnapshot('从站', slave, table, request, 123);
  const rows = buildManualSimulationDraft(table, snapshot);
  assert.deepEqual(buildManualSimulationPoints(rows), [request[1], request[0]]);
  rows[0].value = true;
  assert.equal(snapshot.points.find((p) => p.tag === '开关').bool_value, false);
  const mismatch = buildManualSimulationDraft(table, { points: [{ tag: '开关', point_type: 1, double_value: 3 }] });
  assert.equal(mismatch[0].selected, false);
});

test('只提交勾选点，退出点的运行显示恢复真实值，空选使用清除入口', () => {
  const rows = buildManualSimulationDraft(table, buildManualSimulationSnapshot('从站', slave, table, request, 123));
  rows.find((p) => p.tag === '功率').selected = false;
  const next = buildManualSimulationSnapshot('从站', slave, table, buildManualSimulationPoints(rows), 456);
  const real = { value: { type: 'Double', value: 88 }, quality: 0, ts_ms: 789 };
  assert.deepEqual(resolveIec104RuntimeDisplay('功率', buildIec104SimulationUpdates(next), real), { update: real, simulated: false });
  rows.forEach((p) => { p.selected = false; });
  assert.throws(() => buildManualSimulationPoints(rows), /至少.*清除/);
});

test('完整验证通过后才构造新快照，拒绝固定点、主站、缺失、重复和错类型', () => {
  const before = buildManualSimulationSnapshot('从站', slave, table, request, 123);
  for (const bad of [
    [{ tag: '固定', point_type: 1, double_value: 1 }],
    [{ tag: '缺失', point_type: 1, double_value: 1 }],
    [request[0], request[0]], [{ tag: '功率', point_type: 2, bool_value: true }],
    [{ tag: '开关', point_type: 2, bool_value: 0 }],
    [{ tag: '功率', point_type: 1, double_value: Infinity }],
    [{ tag: '功率', point_type: 1, double_value: 1, bool_value: false }],
  ]) assert.throws(() => buildManualSimulationSnapshot('从站', slave, table, bad, 456));
  assert.throws(() => buildManualSimulationSnapshot('从站', { station_role: 1, role: 1 }, table, request, 456), /从站/);
  assert.doesNotThrow(() => buildManualSimulationSnapshot('从站', { station_role: 0, role: 1 }, table, request, 456));
  assert.throws(() => buildManualSimulationSnapshot('从站', { station_role: 0, role: 2 }, table, request, 456), /从站/);
  assert.deepEqual(before, buildManualSimulationSnapshot('从站', slave, table, request, 123));
});

test('遥测按工程量与十进制倍率偏移校验报文范围，倍率0按1处理', () => {
  const scaled = { ...analog, scale: 1, scale_decimal: '100', offset_decimal: '10' };
  assert.doesNotThrow(() => buildManualSimulationSnapshot('从站', slave, [scaled], [{ ...request[0], double_value: 1e40 }], 1));
  assert.throws(() => buildManualSimulationSnapshot('从站', slave, [{ ...scaled, scale_decimal: '0.0001' }], [{ ...request[0], double_value: 1e38 }], 1), /浮点/);
  assert.doesNotThrow(() => buildManualSimulationSnapshot('从站', slave, [{ ...analog, scale: 0 }], request.slice(0, 1), 1));
  assert.throws(() => buildManualSimulationSnapshot('从站', slave, [{ ...analog, scale_decimal: 'abc' }], request.slice(0, 1), 1), /倍率/);
  const max = 3.4028234663852886e38;
  assert.doesNotThrow(() => buildManualSimulationSnapshot('从站', slave, [analog], [{ ...request[0], double_value: max }], 1));
  assert.throws(() => buildManualSimulationSnapshot('从站', slave, [analog], [{ ...request[0], double_value: max * (1 + 1e-9) }], 1), /浮点/);
});
