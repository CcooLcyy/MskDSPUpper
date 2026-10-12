import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {
  validateModbusTemplate, parseModbusTemplateJson, planTemplateApplication,
  createTemplateFromPoints, MAX_TEMPLATE_POINTS,
} from '../../src/features/modbus-templates/model.ts';

const point = (extra = {}) => ({ id: 'p1', tag: '电压', group: '', unit: 'V', function_code: 3,
  address: 100, data_type: 'UINT16', reg_count: 1, scale: '0.12345678901234567890',
  offset: '0', deadband: '0', word_order: 'HL', byte_order: 'AB', bit_index: null,
  source_page: 1, description: '', ...extra });
const template = (points = [point()], extra = {}) => ({ schema_version: 1, id: 'test',
  name: '测试', manufacturer: '测试厂家', models: ['型号'], protocol_version: '1',
  address_base: 0, notes: [], sources: [{ file: '来源.pdf', sha256: 'a'.repeat(64) }], points, ...extra });

test('实际功能码和地址基准转换，保留精确倍率，默认不选择写点', () => {
  const data = validateModbusTemplate(template([point(), point({ id: 'write', tag: '设置', address: 101, function_code: 6 })]));
  const plan = planTemplateApplication(data, { existingPoints: [], addressBase: 2 });
  assert.equal(plan.points.length, 1);
  assert.equal(plan.points[0].function, 2);
  assert.equal(plan.points[0].address, 101);
  assert.equal(plan.points[0].scale_decimal, '0.12345678901234567890');
  assert.equal(plan.points[0].word_order, 1);
  assert.equal(plan.points[0].byte_order, 1);
  assert.equal(plan.rows[1].selected, false);
  assert.equal(planTemplateApplication(data, { existingPoints: [], addressBase: 1, selectedIds: ['write'] }).points[0].function, 4);
});

test('一基转零基和双寄存器地址边界', () => {
  const data = validateModbusTemplate(template([point({ address: 65535, data_type: 'UINT32', reg_count: 2 })], { address_base: 1 }));
  assert.equal(planTemplateApplication(data, { existingPoints: [], addressBase: 1 }).points[0].address, 65534);
  assert.throws(() => validateModbusTemplate(template([point({ address: 65535, data_type: 'UINT32', reg_count: 2 })])), /地址/);
  assert.throws(() => validateModbusTemplate(template([point({ address: 0 })], { address_base: 1 })), /地址/);
});

test('转换后地址超出现有上位机范围时标记冲突并跳过，零基仍可用', () => {
  const data = validateModbusTemplate(template([point({ address: 65535 })]));
  const one = planTemplateApplication(data, { existingPoints: [], addressBase: 2 });
  assert.match(one.rows[0].conflict, /地址/);
  assert.deepEqual(one.points, []);
  assert.equal(planTemplateApplication(data, { existingPoints: [], addressBase: 1 }).points.length, 1);
  const templateOne = validateModbusTemplate(template([point({ address: 65536 })], { address_base: 1 }));
  assert.equal(planTemplateApplication(templateOne, { existingPoints: [], addressBase: 1 }).points[0].address, 65535);
  assert.deepEqual(planTemplateApplication(templateOne, { existingPoints: [], addressBase: 2 }).points, []);
  const double = validateModbusTemplate(template([point({ address: 65534, reg_count: 2, data_type: 'UINT32' })]));
  assert.deepEqual(planTemplateApplication(double, { existingPoints: [], addressBase: 2 }).points, []);
});

test('标签冲突优先，前缀参与冲突，范围重叠不能覆盖', () => {
  const data = validateModbusTemplate(template());
  const old = planTemplateApplication(data, { existingPoints: [], addressBase: 1 }).points[0];
  const duplicate = planTemplateApplication(data, { existingPoints: [old], addressBase: 1 });
  assert.match(duplicate.rows[0].conflict, /标签/);
  assert.deepEqual(duplicate.points, []);
  const overlap = planTemplateApplication(data, { existingPoints: [old], addressBase: 1, prefix: '新_' });
  assert.equal(overlap.rows[0].finalTag, '新_电压');
  assert.match(overlap.rows[0].conflict, /地址/);
});

test('非法前缀显示冲突并阻止添加，修正后可以继续使用', () => {
  const data = validateModbusTemplate(template());
  for (const prefix of ['x'.repeat(257), '设备\0']) {
    const plan = planTemplateApplication(data, { existingPoints: [], addressBase: 1, prefix });
    assert.deepEqual(plan.points, []);
    assert.match(plan.rows[0].conflict, /标签前缀/);
  }
  const corrected = planTemplateApplication(data, { existingPoints: [], addressBase: 1, prefix: '设备_' });
  assert.equal(corrected.points.length, 1);
  assert.equal(corrected.rows[0].conflict, null);
});

test('不同位索引允许共享寄存器，同批冲突跳过并允许无冲突点位添加', () => {
  const bits = validateModbusTemplate(template([point({ data_type: 'BOOL', bit_index: 0 }),
    point({ id: 'p2', tag: '状态', data_type: 'BOOL', bit_index: 1 })]));
  assert.equal(planTemplateApplication(bits, { existingPoints: [], addressBase: 1 }).points.length, 2);
  const overlaps = validateModbusTemplate(template([point(), point({ id: 'p2', tag: '另一点' }), point({ id: 'p3', tag: '无冲突', address: 200 })]));
  const plan = planTemplateApplication(overlaps, { existingPoints: [], addressBase: 1 });
  assert.ok(plan.rows.slice(0, 2).every(row => row.conflict));
  assert.equal(plan.points.length, 1);
  assert.equal(plan.points[0].tag, '无冲突');
});

test('条件点默认不选且可显式选择，适用条件原文保留', () => {
  const data = validateModbusTemplate(template([point({ default_selected: false, condition: '仅三相设备' })]));
  assert.equal(data.points[0].condition, '仅三相设备');
  assert.equal(planTemplateApplication(data, { existingPoints: [], addressBase: 1 }).points.length, 0);
  assert.equal(planTemplateApplication(data, { existingPoints: [], addressBase: 1, selectedIds: ['p1'] }).points.length, 1);
  assert.throws(() => validateModbusTemplate(template([point({ default_selected: 1 })])));
});

test('全部内置JSON可校验、来源可追踪，目录ID唯一且实际功能码映射符合proto', () => {
  const directory = new URL('../../src/features/modbus-templates/builtin/', import.meta.url);
  const files = fs.readdirSync(directory).filter(file => file.endsWith('.json'));
  assert.ok(files.length > 0);
  const ids = new Set();
  for (const file of files) {
    const data = parseModbusTemplateJson(fs.readFileSync(new URL(file, directory), 'utf8'));
    assert.ok(!ids.has(data.id), file);
    ids.add(data.id);
    assert.ok(data.sources.length > 0, file);
    assert.ok(data.points.every(point => point.source_page > 0), file);
  }
  for (const [functionCode, nativeEnum, type] of [[1,1,'BOOL'],[3,2,'UINT16'],[4,3,'UINT16'],[6,4,'UINT16'],[16,5,'UINT16'],[5,6,'BOOL']]) {
    const data = validateModbusTemplate(template([point({function_code:functionCode,data_type:type})]));
    const plan = planTemplateApplication(data, { existingPoints: [], addressBase: 1, selectedIds: ['p1'] });
    assert.equal(plan.points[0].function, nativeEnum);
  }
});

test('拒绝损坏JSON、未知字段、重复ID标签、不支持类型与长度、非有限倍率及非法位索引', () => {
  assert.throws(() => parseModbusTemplateJson('{'), /JSON/);
  for (const invalid of [template([], { schema_version: 2 }), template([], { password: 'x' }),
    template([point(), point()]), template([point(), point({ id: 'p2' })]),
    template([point({ data_type: 'FLOAT32' })]), template([point({ reg_count: 2 })]),
    template([point({ function_code: 5 })]), template([point({ scale: 'NaN' })]),
    template([point({ offset: 'Infinity' })]), template([point({ deadband: 1 })]),
    template([point({ bit_index: 1 })]), template([point({ data_type: 'BOOL', bit_index: 16 })]),
    template([point({ source_page: -1 })]), template(Array(MAX_TEMPLATE_POINTS + 1).fill(point()))]) {
    assert.throws(() => validateModbusTemplate(invalid));
  }
});

test('保存当前点表再应用保持现有枚举、地址、字节序及十进制原文', () => {
  const data = validateModbusTemplate(template([point({ function_code: 4, word_order: 'LH', byte_order: 'BA' })]));
  const points = planTemplateApplication(data, { existingPoints: [], addressBase: 2 }).points;
  assert.equal(points[0].word_order, 2);
  assert.equal(points[0].byte_order, 2);
  const saved = createTemplateFromPoints({ id: 'personal', name: '个人', addressBase: 2, points });
  assert.equal(saved.points[0].unit, '');
  assert.deepEqual(planTemplateApplication(saved, { existingPoints: [], addressBase: 2 }).points, points);
  for (const defaultEnum of [0, 1]) {
    const nativeDefault = { ...points[0], word_order: defaultEnum, byte_order: defaultEnum };
    const defaultSaved = createTemplateFromPoints({ id: 'defaults', name: '默认', addressBase: 2, points: [nativeDefault] });
    assert.equal(defaultSaved.points[0].word_order, 'HL');
    assert.equal(defaultSaved.points[0].byte_order, 'AB');
  }
});
