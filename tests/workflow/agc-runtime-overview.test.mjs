import assert from 'node:assert/strict';
import test from 'node:test';
import { readRuntimeNumericText, getMemberRuntimeDifference, runtimePointState, selectAgcOverviewUpdates } from '../../src/utils/agc-runtime-overview.ts';
const signal = { tag: 'p', unit: 'kW', scale: 1, offset: 0, scale_decimal: '1', offset_decimal: '0' };
const point = (value, ts_ms = 100000, quality = 1) => ({ value: { type: 'Decimal', value }, ts_ms, quality });
const member = { controllable: true, p_meas: signal, p_set: { signal, mode: 1 } };
// 验证输出仅采用 AGC 源端快照，不把同名目的输入伪装成已发布设定或总输出。
test('AGC 输出禁止回退同名目的输入', () => {
  const destination = { measure: point('57.71'), target: point('999'), setpoint: point('999') };
  const filtered = selectAgcOverviewUpdates(destination, {}, ['target', 'setpoint']);
  assert.equal(filtered.measure, destination.measure);
  assert.equal(filtered.target, undefined);
  assert.equal(filtered.setpoint, undefined);
  const source = point('100');
  assert.equal(selectAgcOverviewUpdates(destination, { target: source }, ['target']).target, source);
  assert.equal(destination.target.value.value, '999');
});
// 验证偏差使用原始 Decimal20 文本而不是浮点近似。
test('成员偏差保留 Decimal20 精度', () => {
  assert.equal(getMemberRuntimeDifference(member, point('0.10000000000000000001'), point('0.3')), '0.19999999999999999999');
});
// 验证缺失、非法或非数字缓存不伪造零值及偏差。
test('缺失和非数值点不产生偏差', () => {
  assert.equal(readRuntimeNumericText(undefined), null);
  assert.equal(readRuntimeNumericText(point('NaN')), null);
  assert.equal(readRuntimeNumericText({ value: { type: 'Bool', value: true } }), null);
  assert.equal(getMemberRuntimeDifference(member, undefined, point('10')), null);
});
// 验证不可控成员、未知单位或不同单位不能直接相减。
test('成员偏差检查可控状态与工程量单位', () => {
  assert.equal(getMemberRuntimeDifference({ ...member, controllable: false }, point('1'), point('2')), null);
  assert.equal(getMemberRuntimeDifference({ ...member, p_meas: { ...signal, unit: 'MW' } }, point('1'), point('2')), null);
  assert.equal(getMemberRuntimeDifference({ ...member, p_meas: { ...signal, unit: '' } }, point('1'), point('2')), null);
  assert.equal(getMemberRuntimeDifference({ ...member, p_meas: { ...signal, unit: 'MW' }, p_set: { signal: { ...signal, unit: 'MW' }, mode: 1 } }, point('1'), point('2')), null);
});
// 验证增量设定和非默认换算不被误当成可直接比较的绝对功率。
test('增量及非默认换算成员不产生绝对偏差', () => {
  assert.equal(getMemberRuntimeDifference({ ...member, p_set: { signal, mode: 2 } }, point('1'), point('2')), null);
  assert.equal(getMemberRuntimeDifference({ ...member, p_meas: { ...signal, scale_decimal: '2' } }, point('1'), point('2')), null);
  assert.equal(getMemberRuntimeDifference({ ...member, p_meas: { ...signal, offset_decimal: '1' } }, point('1'), point('2')), null);
});
// 验证测量点按现有时间和质量规则展示，断连时保留缓存但不宣称正常。
test('成员测量状态区分离线陈旧质量和缺失', () => {
  assert.equal(runtimePointState(point('1'), 100000, 30000, false), '新鲜 · 有效');
  assert.equal(runtimePointState(point('1', 60000), 100000, 30000, false), '数据陈旧');
  assert.equal(runtimePointState(point('1', 102000), 100000, 30000, false), '数据陈旧');
  assert.equal(runtimePointState(point('1', 100000, 0), 100000, 30000, false), '质量异常');
  assert.equal(runtimePointState(undefined, 100000, 30000, false), '点值缺失');
  assert.equal(runtimePointState(point('1'), 100000, 30000, true), '连接异常 · 缓存值');
});
