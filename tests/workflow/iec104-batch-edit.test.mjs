import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planIec104BatchEdit } from '../../src/pages/IEC104/batch-edit.ts';

const point = (tag, ioa, fields = {}) => ({
  tag, ioa, point_type: 1, business_type: 2,
  remote_control_type: 1, command_execution_mode: 2,
  scale: 2, offset: 3, deadband: 4,
  scale_decimal: '2', offset_decimal: '3', deadband_decimal: '4',
  fixed_value_enabled: false, fixed_value: 0,
  ...fields,
});

test('批量改 IOA 类别会保留段内地址、补空号，并保留已有的有效业务', () => {
  const inputs = [
    point('原遥信', 0x0002, { business_type: 0 }),
    point('原遥调', 0x6201, { business_type: 3 }),
    point('段内已选', 0x4002),
    point('段内未选', 0x5000),
  ];
  const result = planIec104BatchEdit(inputs, new Set(['原遥信', '原遥调', '段内已选']), { ioaCategory: 'telemetry' }, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.ioaChanges, [
    { tag: '原遥信', before: 0x0002, after: 0x4001 },
    { tag: '原遥调', before: 0x6201, after: 0x4003 },
  ]);
  assert.equal(result.newPoints[0].business_type, 1);
  assert.equal(result.newPoints[1].business_type, 3);
  assert.equal(result.businessTypeChangedCount, 0);
  assert.strictEqual(result.newPoints[2], inputs[2]);
  assert.strictEqual(result.newPoints[3], inputs[3]);
});

test('IOA 地址不足时拒绝整批迁移，不产生部分迁移或越界地址', () => {
  const inputs = [
    ...Array.from({ length: 255 }, (_, index) => point(`占用 ${index}`, 0x6001 + index)),
    point('待迁移 A', 0x4001), point('待迁移 B', 0x4002),
  ];
  const result = planIec104BatchEdit(inputs, new Set(['待迁移 A', '待迁移 B']), { ioaCategory: 'remoteControl' }, true);
  assert.match(result.issues[0], /没有足够的空闲地址/);
  assert.deepEqual(result.ioaChanges, []);
  assert.deepEqual(result.newPoints, inputs);
});

test('业务类型独立于 IOA，按修改后业务应用遥控字段并解除不兼容配置', () => {
  const input = point('原遥测', 0x4001, { fixed_value_enabled: true, fixed_value: 5 });
  const selected = new Set([input.tag]);
  const control = planIec104BatchEdit([input], selected, { businessType: 4, remoteControlType: 2 }, true);
  assert.deepEqual(control.issues, []);
  assert.deepEqual(control.newPoints[0], {
    ...input, business_type: 4, remote_control_type: 2, fixed_value_enabled: false,
  });
  assert.equal(control.releasedFixedValueCount, 1);
  const back = planIec104BatchEdit(control.newPoints, selected, { businessType: 0 }, true);
  assert.deepEqual(back.issues, []);
  assert.deepEqual(back.newPoints[0], { ...input, business_type: 0, fixed_value_enabled: false });
  assert.equal(back.businessTypeChangedCount, 1);
});

test('混选时工程参数只改最终 FLOAT，固定值校验与开关分开应用', () => {
  const inputs = [
    point('遥测', 0x4001, { fixed_value_enabled: true, fixed_value: 5 }),
    point('遥信', 0x0001, { business_type: 1, point_type: 2 }),
    point('遥控', 0x6001, { business_type: 4, point_type: 2 }),
  ];
  const selected = new Set(inputs.map(({ tag }) => tag));
  const scale = '1.0000000000000000001';
  const result = planIec104BatchEdit(inputs, selected, { scale, deadband: '0', fixedValue: '0' }, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.newPoints[0], {
    ...inputs[0], scale: 1, scale_decimal: scale, deadband: 0, deadband_decimal: '0', fixed_value: 0,
  });
  assert.strictEqual(result.newPoints[1], inputs[1]);
  assert.strictEqual(result.newPoints[2], inputs[2]);

  for (const fixedValue of ['25', '1.00000000000000001', '1e-324']) {
    const invalid = planIec104BatchEdit(inputs, selected, { fixedValueEnabled: false, fixedValue }, true);
    assert.match(invalid.issues[0], /遥信.*只允许 0 或 1/);
  }
  const converted = planIec104BatchEdit(inputs, selected, { pointType: 1, offset: '0', fixedValueEnabled: false, fixedValue: '25' }, true);
  assert.deepEqual(converted.issues, []);
  assert.deepEqual(converted.newPoints[1], {
    ...inputs[1], point_type: 1, scale: 1, scale_decimal: '1', offset: 0, offset_decimal: '0',
    deadband: 0, deadband_decimal: '0', fixed_value: 25,
  });
});
