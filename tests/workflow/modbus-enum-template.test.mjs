import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateModbusTemplate, planTemplateApplication, createTemplateFromPoints } from '../../src/features/modbus-templates/model.ts';
import { saveTemplatePoints } from '../../src/features/modbus-templates/save-template.ts';

const point = (value, extra = {}) => ({ id: `state-${value}`, tag: `状态${value}`, group: '状态', unit: '', function_code: 4,
  address: 5038, data_type: 'BOOL', reg_count: 1, scale: '1', offset: '0', deadband: '0', word_order: 'HL', byte_order: 'AB',
  bit_index: null, enum_value: value, source_page: 27, description: '', ...extra });
const template = (points) => ({ schema_version: 1, id: 'enum-test', name: '枚举测试', manufacturer: '', models: [],
  protocol_version: '', address_base: 1, notes: [], sources: [], points });

// 验证枚举0存在性、同址不同枚举可共同应用，保存个人模板不会丢失选择器。
test('枚举遥信0和不同状态同址共存并往返保存', () => {
  const data = validateModbusTemplate(template([point(0), point(0x8000)]));
  const plan = planTemplateApplication(data, { addressBase: 1, existingPoints: [] });
  assert.equal(plan.points.length, 2);
  assert.ok(plan.rows.every(row => row.conflict === null));
  assert.deepEqual(plan.points.map(item => item.enum_value), [0, 0x8000]);
  assert.ok(plan.points.every(item => item.address === 5037 && item.bit_index === null));
  const saved = createTemplateFromPoints({ id: 'personal-enum', name: '个人枚举', addressBase: 1, points: plan.points });
  assert.deepEqual(planTemplateApplication(saved, { addressBase: 1, existingPoints: [] }).points, plan.points);
});

// 验证选择器互斥、只读BOOL和16/32位范围，不允许将写点或普通数值误标为枚举。
test('枚举遥信拒绝非法选择器和范围，32位完整值可用', () => {
  for (const extra of [{ bit_index: 0 }, { data_type: 'UINT16' }, { function_code: 6 }, { function_code: 1 },
    { enum_value: -1 }, { enum_value: 65536 }, { enum_value: 0.5 }]) {
    assert.throws(() => validateModbusTemplate(template([point(0, extra)])), /枚举/);
  }
  assert.equal(validateModbusTemplate(template([point(0xffffffff, { reg_count: 2 })])).points[0].enum_value, 0xffffffff);
  assert.throws(() => validateModbusTemplate(template([point(0x100000000, { reg_count: 2 })])), /枚举/);
});

// 验证重复枚举以及枚举与整字/位选择器不能绕过现有点表冲突规则。
test('枚举重复映射和其他解码模式共享地址仍冲突', () => {
  for (const other of [point(0, { id: 'duplicate', tag: '重复状态' }),
    point(null, { id: 'raw', tag: '原始状态', data_type: 'UINT16' }),
    point(null, { id: 'bit', tag: '位状态', bit_index: 0 }),
    point(1, { id: 'other-order', tag: '字节序不同', byte_order: 'BA' })]) {
    const plan = planTemplateApplication(template([point(0), other]), { addressBase: 1, existingPoints: [] });
    assert.equal(plan.points.length, 0);
    assert.ok(plan.rows.every(row => row.conflict));
  }
});

// 验证旧接口缺省与新DTO的null等价，真正修改枚举常量仍会阻止旧快照保存。
test('模板提交兼容缺省枚举字段并检测枚举常量变化', async () => {
  const old = { tag: '旧点', address: 1, function: 2, data_type: 2, reg_count: 1, scale: 1, offset: 0, deadband: 0,
    scale_decimal: '1', offset_decimal: '0', deadband_decimal: '0', word_order: 1, byte_order: 1, bit_index: null };
  let saved;
  await saveTemplatePoints({ expected: [old], additions: [{ ...old, tag: '新增', address: 2 }],
    read: async () => [{ ...old, enum_value: null }], save: async points => { saved = points; }, onChanged: () => assert.fail('不应误判变化') });
  assert.equal(saved.length, 2);
  await assert.rejects(saveTemplatePoints({ expected: [{ ...old, enum_value: 0 }], additions: [{ ...old, tag: '新增' }],
    read: async () => [{ ...old, enum_value: 1 }], save: async () => assert.fail('不应保存'), onChanged: () => {} }), /点表已变化/);
});
