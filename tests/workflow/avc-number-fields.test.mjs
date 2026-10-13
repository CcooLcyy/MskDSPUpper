import assert from 'node:assert/strict';
import test from 'node:test';

import { synchronizeAvcNumberFields } from '../../src/utils/avc-number-fields.ts';

test('AVC 未修改成员数值时保留历史 decimal 全部精度', () => {
  const original = {
    member_name: 'PCS1', weight: 0.1, q_min_kvar: -10, q_max_kvar: 10,
    weight_decimal: '0.10000000000000000001',
    q_min_kvar_decimal: '-10.00000000000000000001',
    q_max_kvar_decimal: '10.00000000000000000001',
    q_meas: { tag: '已有内部点' },
  };
  const next = { ...original, member_name: '重命名' };
  const before = structuredClone(next);
  const result = synchronizeAvcNumberFields(next, original, ['weight', 'q_min_kvar', 'q_max_kvar']);
  assert.deepEqual(result, next);
  assert.notEqual(result, next);
  assert.equal(result.q_meas, next.q_meas);
  assert.deepEqual(next, before);
  assert.equal(original.member_name, 'PCS1');
});

test('AVC 成员范围或权重修改时同步对应 decimal 防止旧值覆盖', () => {
  const original = {
    weight: 1, weight_decimal: '1.000000000000000001',
    q_min_kvar: -100, q_min_kvar_decimal: '-100.000000000000000001',
    q_max_kvar: 100, q_max_kvar_decimal: '100.000000000000000001',
  };
  const next = { ...original, weight: 3, q_min_kvar: -200 };
  const result = synchronizeAvcNumberFields(next, original, ['weight', 'q_min_kvar', 'q_max_kvar']);
  assert.equal(result.weight_decimal, '3');
  assert.equal(result.q_min_kvar_decimal, '-200');
  assert.equal(result.q_max_kvar_decimal, original.q_max_kvar_decimal);
  assert.equal(next.weight_decimal, original.weight_decimal);
});

test('AVC 新对象即使带有陈旧 decimal 也以当前有限数值同步', () => {
  const next = { weight: 2, weight_decimal: '99', q_min_kvar: -5, q_max_kvar: 5, extension: '保留' };
  const result = synchronizeAvcNumberFields(next, undefined, ['weight', 'q_min_kvar', 'q_max_kvar']);
  assert.deepEqual(result, {
    ...next, weight_decimal: '2', q_min_kvar_decimal: '-5', q_max_kvar_decimal: '5',
  });
  assert.equal(next.weight_decimal, '99');
});

test('AVC 旧对象缺少或清空 decimal 时补齐当前数值', () => {
  const original = { scale: 0.001, offset: -2 };
  for (const decimal of [undefined, '', '   ', null]) {
    const result = synchronizeAvcNumberFields({ ...original, scale_decimal: decimal }, original, ['scale', 'offset']);
    assert.equal(result.scale_decimal, '0.001');
    assert.equal(result.offset_decimal, '-2');
  }
});

test('AVC 信号换算和电压参数只同步改变的数值', () => {
  for (const [fields, original, next, expected] of [
    [['scale', 'offset'], { scale: 0.1, offset: 1, scale_decimal: '0.10000000000000001', offset_decimal: '1.00000000000000001' },
      { scale: 1, offset: 1, scale_decimal: '0.10000000000000001', offset_decimal: '1.00000000000000001' },
      { scale_decimal: '1', offset_decimal: '1.00000000000000001' }],
    [['kp', 'deadband'], { kp: 10, deadband: 0.1, kp_decimal: '10.00000000000000001', deadband_decimal: '0.10000000000000001' },
      { kp: 10, deadband: 0.2, kp_decimal: '10.00000000000000001', deadband_decimal: '0.10000000000000001' },
      { kp_decimal: '10.00000000000000001', deadband_decimal: '0.2' }],
  ]) {
    const result = synchronizeAvcNumberFields(next, original, fields);
    for (const [field, value] of Object.entries(expected)) assert.equal(result[field], value);
  }
});

test('AVC 相同数值显式提供新 decimal 时保留调用方当前 decimal', () => {
  const original = { scale: 1, scale_decimal: '1.0000000000000001' };
  const result = synchronizeAvcNumberFields({ scale: 1, scale_decimal: '1' }, original, ['scale']);
  assert.equal(result.scale_decimal, '1');
});

test('AVC 缺失或非有限 number 在保存前给出中文错误', () => {
  for (const value of [undefined, null, NaN, Infinity, -Infinity, '2']) {
    const next = { weight: value, weight_decimal: '旧值' };
    const before = { ...next };
    assert.throws(() => synchronizeAvcNumberFields(next, undefined, ['weight']), /weight.*必须是有限数值/);
    assert.deepEqual(next, before);
  }
});

test('AVC 仅同步指定字段并支持零和科学记数数值', () => {
  const next = { offset: 0, scale: 1e-8, untouched: 2, untouched_decimal: '2.00000000000000001' };
  const result = synchronizeAvcNumberFields(next, undefined, ['offset', 'scale']);
  assert.equal(result.offset_decimal, '0');
  assert.equal(result.scale_decimal, '1e-8');
  assert.equal(result.untouched_decimal, next.untouched_decimal);
});
