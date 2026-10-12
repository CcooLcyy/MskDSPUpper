import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateModbusTemplate, planTemplateApplication, isTemplateWritePoint } from '../../src/features/modbus-templates/model.ts';
import { buildReadPlanBlocks } from '../../src/pages/ModbusRTU/modbus-form-rules.ts';

const load = () => validateModbusTemplate(JSON.parse(readFileSync(new URL('../../src/features/modbus-templates/builtin/sungrow-pv-v1-1-78.json', import.meta.url), 'utf8')));
const states = [[0, '运行'], [0x8000, '停机'], [0x1200, '初始待机'], [0x1300, '按键关机'], [0x1400, '待机'],
  [0x1500, '紧急停机'], [0x1600, '启动中'], [0x5500, '故障停机'], [0x9100, '告警运行'], [0x8100, '降额运行'], [0x8200, '调度运行'], [0x2500, '通讯故障']];

// 验证批准的73点范围、来源哈希及高分辨率保留，防止重新加入已排除的组串等参数。
test('阳光模板严格保留73点和高分辨率测量', () => {
  const data = load();
  assert.equal(data.manufacturer, '阳光电源');
  assert.equal(data.address_base, 1);
  assert.equal(data.points.length, 73);
  assert.deepEqual(data.sources, [{ file: '阳光电源逆变器.pdf', sha256: 'aed440fcda4fbdc9f4976f8fe06a1f2a0608408fbb8b994b2cd6aa5dbcdc2535' }]);
  const read = data.points.filter(point => !isTemplateWritePoint(point));
  assert.equal(read.length, 66);
  assert.equal(read.filter(point => point.data_type === 'BOOL').length, 37);
  assert.equal(read.filter(point => point.data_type !== 'BOOL' && point.group !== '故障告警').length, 28);
  assert.equal(read.filter(point => point.group === '故障告警').length, 1);
  assert.ok(read.every(point => point.function_code === 4));
  assert.ok(!read.some(point => [5004, 5036].includes(point.address)));
  assert.ok(!data.points.some(point => /MPPT|组串|PID|曲线/.test(point.tag)));
  const expected = [
    [5001, 'UINT16', '0.1', 'kW'], [5008, 'INT16', '0.1', '℃'], [5009, 'UINT32', '1', 'VA'],
    [5017, 'UINT32', '1', 'W'], [5019, 'UINT16', '0.1', 'V'], [5020, 'UINT16', '0.1', 'V'],
    [5021, 'UINT16', '0.1', 'V'], [5022, 'UINT16', '0.1', 'A'], [5023, 'UINT16', '0.1', 'A'],
    [5024, 'UINT16', '0.1', 'A'], [5031, 'INT32', '1', 'W'], [5033, 'INT32', '1', 'var'],
    [5035, 'INT16', '0.001', ''], [5049, 'UINT16', '0.1', 'kvar'], [5071, 'UINT16', '1', 'kΩ'],
    [5083, 'INT32', '1', 'W'], [5091, 'INT32', '1', 'W'], [5146, 'INT16', '0.1', 'V'],
    [5147, 'UINT16', '0.1', 'V'], [5148, 'UINT16', '0.01', 'Hz'],
    [5003, 'UINT16', '0.1', 'kWh'], [5006, 'UINT32', '1', 'h'], [5113, 'UINT16', '1', 'min'],
    [5128, 'UINT32', '0.1', 'kWh'], [5144, 'UINT32', '0.1', 'kWh'],
    [5077, 'UINT32', '1', 'W'], [5079, 'INT32', '1', 'var'], [5125, 'INT16', '0.001', ''],
  ];
  const measurements = read.filter(point => point.data_type !== 'BOOL' && point.group !== '故障告警');
  assert.deepEqual(measurements.map(point => [point.address, point.data_type, point.scale, point.unit]), expected);
  for (const point of data.points) {
    assert.equal(point.byte_order, 'AB');
    assert.equal(point.word_order, point.reg_count === 2 ? 'LH' : 'HL');
    assert.ok(point.source_page > 0);
    if (point.condition) assert.equal(point.default_selected, false);
  }
});

// 验证37个状态的完整枚举/位定义，枚举0不可误当未配置，也不能按bit解码。
test('阳光37个状态分别按枚举相等和位图完整展开', () => {
  const data = load();
  const state1 = data.points.filter(point => point.address === 5038);
  assert.deepEqual(state1.map(point => [point.enum_value, point.tag]), states.map(([value, name]) => [value, `工作状态1-${name}`]));
  const bitNames = [...states.map(([, name], index) => [[0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13][index], name]), [17, '总运行'], [18, '总故障']];
  const state2 = data.points.filter(point => point.address === 5081);
  assert.deepEqual(state2.map(point => [point.bit_index, point.tag]), bitNames.map(([bit, name]) => [bit, `工作状态2-${name}`]));
  assert.ok(state2.every(point => point.reg_count === 2 && point.enum_value == null && point.source_page === 27));
  const inverter1 = ['待机', '发电', '自降额发电', '限额发电', '计划停运', '限电停运', '故障停运'];
  const inverter2 = ['运行', '停机', '检修', '待机'];
  for (const [address, names, start, prefix] of [[5140, inverter1, 0, '逆变器状态1'], [5141, inverter2, 1, '逆变器状态2']]) {
    const points = data.points.filter(point => point.address === address);
    assert.deepEqual(points.map(point => [point.enum_value, point.tag]), names.map((name, index) => [index + start, `${prefix}-${name}`]));
    assert.ok(points.every(point => point.bit_index === null && point.source_page === 8));
  }
  assert.ok(state1.every(point => point.bit_index === null && point.source_page === 27));
  assert.equal(data.points.filter(point => point.enum_value != null).length, 23);
});

// 验证全部点位共同应用无冲突，一基/零基换算正确，写控制不生成读取区间。
test('阳光全部点位可应用且控制保持独立不进入采集计划', () => {
  const data = load();
  const selectedIds = data.points.map(point => point.id);
  const all = planTemplateApplication(data, { addressBase: 1, existingPoints: [], selectedIds });
  assert.equal(all.points.length, 73);
  assert.ok(all.rows.every(row => row.conflict === null && row.point.address === row.source.address - 1));
  const one = planTemplateApplication(data, { addressBase: 2, existingPoints: [], selectedIds });
  assert.ok(one.rows.every(row => row.conflict === null && row.point.address === row.source.address));
  const controls = data.points.filter(isTemplateWritePoint);
  assert.deepEqual(controls.map(point => [point.address, point.data_type, point.scale]), [
    [5006, 'UINT16', '1'], [5007, 'UINT16', '1'], [5008, 'UINT16', '0.1'],
    [5036, 'UINT16', '1'], [5037, 'INT16', '0.1'], [5039, 'UINT16', '0.1'], [5040, 'INT16', '0.1'],
  ]);
  assert.ok(controls.every(point => point.function_code === 6 && point.default_selected === false && point.bit_index === null));
  const defaultPlan = planTemplateApplication(data, { addressBase: 1, existingPoints: [] });
  assert.ok(defaultPlan.rows.filter(row => isTemplateWritePoint(row.source)).every(row => !row.selected));
  const controlPlan = planTemplateApplication(data, { addressBase: 1, existingPoints: [], selectedIds: controls.map(point => point.id) });
  assert.deepEqual(buildReadPlanBlocks(controlPlan.points), []);
  assert.ok(buildReadPlanBlocks(all.points).every(block => block.function === 3));
  const repeats = planTemplateApplication(data, { addressBase: 1, existingPoints: all.points, selectedIds });
  assert.equal(repeats.points.length, 0);
  assert.ok(repeats.rows.every(row => row.conflict));
});
