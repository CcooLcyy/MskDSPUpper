import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validateModbusTemplate, planTemplateApplication, isTemplateWritePoint } from '../../src/features/modbus-templates/model.ts';
import { buildReadPlanBlocks } from '../../src/pages/ModbusRTU/modbus-form-rules.ts';

const load = () => validateModbusTemplate(JSON.parse(readFileSync(new URL('../../src/features/modbus-templates/builtin/aiswei-inverter-v2-1-5.json', import.meta.url), 'utf8')));

// 验证批准的35点范围，保留有功绝对值并防止把储能、电表或组串控制混入逆变器模板。
test('爱士惟模板保留35点及逆变器P/Q设定的真实单位', () => {
  const data = load();
  assert.equal(data.manufacturer, '爱士惟');
  assert.equal(data.address_base, 0);
  assert.equal(data.points.length, 35);
  assert.deepEqual(data.sources, [{ file: '爱士惟通讯协议.pdf', sha256: 'b7de1abf53c339864d0a9ec5266ea4cc50d7c3313c6c349580834c4e557c4b84' }]);
  const read = data.points.filter(point => !isTemplateWritePoint(point));
  assert.equal(read.length, 27);
  assert.equal(read.filter(point => point.data_type === 'BOOL').length, 7);
  assert.equal(read.filter(point => point.data_type !== 'BOOL' && point.group !== '故障告警').length, 18);
  assert.equal(read.filter(point => point.data_type !== 'BOOL' && point.group === '故障告警').length, 2);
  assert.ok(read.every(point => point.function_code === 4));
  assert.ok(!data.points.some(point => /充放电|电表|MPPT|组串/.test(point.tag)));
  const absolute = data.points.find(point => point.id === '16-41220');
  assert.deepEqual([absolute.address, absolute.data_type, absolute.reg_count, absolute.unit, absolute.scale], [1219, 'INT32', 2, 'W', '1']);
  assert.match(absolute.condition, /第二寄存器地址/);
  assert.match(absolute.description, /30000/);
  for (const [id, expected] of [
    ['16-45403', [5402, 'UINT16', '%Pn', '0.01']],
    ['16-45516', [5515, 'INT16', '%Sn', '0.01']],
    ['16-45503', [5502, 'INT16', '', '0.0001']],
  ]) {
    const point = data.points.find(point => point.id === id);
    assert.deepEqual([point.address, point.data_type, point.unit, point.scale], expected);
  }
  for (const point of data.points) {
    assert.ok(point.source_page > 0);
    if (point.condition) assert.equal(point.default_selected, false);
    if (point.reg_count === 2) {
      assert.match(point.condition, /字序/);
      assert.equal(point.word_order, 'HL');
      assert.equal(point.byte_order, 'AB');
    }
  }
});

// 验证全字枚举相等判断包含值0，状态既能共同应用也不会被误解为bit位。
test('爱士惟7个BOOL按完整寄存器枚举相等定义', () => {
  const data = load();
  const states = data.points.filter(point => point.data_type === 'BOOL');
  assert.deepEqual(states.map(point => [point.address, point.enum_value]), [
    [1308, 0], [1308, 1], [1308, 2], [1308, 4], [1376, 1], [1390, 0], [1390, 1],
  ]);
  assert.ok(states.every(point => point.bit_index === null && point.reg_count === 1));
  const plan = planTemplateApplication(data, { addressBase: 1, existingPoints: [], selectedIds: states.map(point => point.id) });
  assert.equal(plan.points.length, 7);
  assert.ok(plan.rows.filter(row => row.selected).every(row => row.conflict === null));
  assert.equal(plan.points.filter(point => point.enum_value === 0).length, 2);
});

// 验证协议地址换算、全选无重叠、条件点默认排除，且写控制不会进入采集区间。
test('爱士惟全部点位在两种地址基准下可应用且控制不参与轮询', () => {
  const data = load();
  const selectedIds = data.points.map(point => point.id);
  const zero = planTemplateApplication(data, { addressBase: 1, existingPoints: [], selectedIds });
  const one = planTemplateApplication(data, { addressBase: 2, existingPoints: [], selectedIds });
  assert.equal(zero.points.length, 35);
  assert.equal(one.points.length, 35);
  assert.ok(zero.rows.every(row => row.conflict === null && row.point.address === row.source.address));
  assert.ok(one.rows.every(row => row.conflict === null && row.point.address === row.source.address + 1));
  assert.equal(zero.rows.find(row => row.id === '4-31028').point.address, 1027);
  assert.equal(zero.rows.find(row => row.id === '16-40201').point.address, 200);
  assert.equal(one.rows.find(row => row.id === '16-41220').point.address, 1220);
  const controls = data.points.filter(isTemplateWritePoint);
  assert.equal(controls.length, 8);
  assert.ok(controls.every(point => point.function_code === 16 && point.default_selected === false));
  const defaults = planTemplateApplication(data, { addressBase: 1, existingPoints: [] });
  assert.ok(defaults.rows.filter(row => isTemplateWritePoint(row.source) || row.source.condition).every(row => !row.selected));
  const controlPlan = planTemplateApplication(data, { addressBase: 1, existingPoints: [], selectedIds: controls.map(point => point.id) });
  assert.deepEqual(buildReadPlanBlocks(controlPlan.points), []);
  assert.ok(buildReadPlanBlocks(zero.points).every(block => block.function === 3));
  const repeated = planTemplateApplication(data, { addressBase: 1, existingPoints: zero.points, selectedIds });
  assert.equal(repeated.points.length, 0);
  assert.ok(repeated.rows.every(row => row.conflict));
});
