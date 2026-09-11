import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  addAgcDecimalTexts,
  compareAgcDecimalTexts,
  createAgcDecimalFields,
  inferAgcAllocationMode,
  multiplyAgcDecimalTexts,
  normalizeAgcControlProfileDecimalFields,
  normalizeAgcGroupConfigDecimalFields,
  normalizeAgcTuningConfigDecimalFields,
  normalizeAgcTuningStatusDecimalFields,
  resolveAgcDecimalText,
  subtractAgcDecimalTexts,
} from '../../src/utils/agc-decimal.ts';
import { getDecimalTextError } from '../../src/utils/decimal-input.ts';

const agcPageSource = readFileSync(new URL('../../src/pages/AGC/index.tsx', import.meta.url), 'utf8');
const agcRustSource = readFileSync(new URL('../../src-tauri/src/commands/agc.rs', import.meta.url), 'utf8');

// 验证 AGC 工程量读取优先使用 decimal 原文，旧配置才回退 number 字段。
test('AGC 工程量字段优先保留 decimal 原文并兼容旧 number', () => {
  assert.equal(resolveAgcDecimalText({ value: 0.1, value_decimal: '0.10000000000000000001' }, 'value', 'value_decimal'), '0.10000000000000000001');
  assert.equal(resolveAgcDecimalText({ value: 0.1, value_decimal: '' }, 'value', 'value_decimal'), '0.1');
  assert.deepEqual(createAgcDecimalFields('0.12345678901234567890', 'value', 'value_decimal'), {
    value: Number('0.12345678901234567890'),
    value_decimal: '0.12345678901234567890',
  });
});

// 验证 AGC Decimal20 纯逻辑运算不经 number，并覆盖正负数及 20 位量化边界。
test('AGC Decimal20 纯逻辑支持精确比较和派生值', () => {
  assert.equal(addAgcDecimalTexts('0.1', '0.2'), '0.3');
  assert.equal(subtractAgcDecimalTexts('0.3', '0.10000000000000000001'), '0.19999999999999999999');
  assert.equal(multiplyAgcDecimalTexts('0.12345678901234567890', '0.003'), '0.00037037036703703704');
  assert.equal(compareAgcDecimalTexts('-0.00000000000000000001', '0'), -1);
  assert.equal(compareAgcDecimalTexts('1e2', '100.00000000000000000000'), 0);
});

// 验证控制组深层归一化覆盖信号、容量、权重和上下限，且不会改写精确原文。
test('AGC 控制组归一化覆盖全部工程量字段', () => {
  const config = normalizeAgcGroupConfigDecimalFields({
    group_name: 'g1',
    p_cmd: {
      signal: { tag: 'cmd', unit: 'kW', scale: 1, offset: 0, scale_decimal: '1.00000000000000000001', offset_decimal: '-0.00000000000000000001' },
      mode: 1,
      delta_base: 0,
      base_tag: '',
    },
    control_mode: 1,
    calculation_execution_period_seconds: 1,
    command_control_period_seconds: 4,
    strategy: { strategy_type: 'weighted' },
    members: [{
      member_name: 'm1',
      controllable: true,
      capacity_kw: 100,
      capacity_kw_decimal: '100.00000000000000000001',
      weight: 1,
      weight_decimal: '0.33333333333333333333',
      min_kw: 0,
      min_kw_decimal: '0.00000000000000000001',
      max_kw: 100,
      max_kw_decimal: '99.99999999999999999999',
      p_meas: { tag: 'meas', unit: 'kW', scale: 1, offset: 0, scale_decimal: '', offset_decimal: '' },
      p_set: null,
    }],
    outputs: null,
  });

  assert.equal(config.p_cmd.signal.scale_decimal, '1.00000000000000000001');
  assert.equal(config.p_cmd.signal.offset_decimal, '-0.00000000000000000001');
  assert.equal(config.members[0].capacity_kw_decimal, '100.00000000000000000001');
  assert.equal(config.members[0].weight_decimal, '0.33333333333333333333');
  assert.equal(config.members[0].p_meas.scale_decimal, '1');
  assert.equal(config.members[0].p_meas.offset_decimal, '0');
});

// 验证分配方式识别按 decimal 文本比较，避免高精度权重被 number 抹平后误判。
test('AGC 分配方式识别保留高精度权重差异', () => {
  assert.equal(inferAgcAllocationMode([
    { controllable: true, weight: 1, weight_decimal: '1.00000000000000000001', capacity_kw: 100, capacity_kw_decimal: '100' },
    { controllable: true, weight: 1, weight_decimal: '1.00000000000000000002', capacity_kw: 200, capacity_kw_decimal: '200' },
  ]), 'custom');
  assert.equal(inferAgcAllocationMode([
    { controllable: true, weight: 1, weight_decimal: '1', capacity_kw: 100, capacity_kw_decimal: '100' },
    { controllable: true, weight: 2, weight_decimal: '2', capacity_kw: 200, capacity_kw_decimal: '200' },
  ]), 'proportional');
});

// 验证调试配置、状态和候选 profile 均贯通 decimal 并保留时间字段的 number 语义。
test('AGC 调试链路归一化覆盖配置状态和控制 profile', () => {
  const config = normalizeAgcTuningConfigDecimalFields({
    target_lower_kw: 0,
    target_lower_kw_decimal: '0.00000000000000000001',
    target_upper_kw: 10,
    target_upper_kw_decimal: '9.99999999999999999999',
    total_time_minutes: 120,
    attempt_max_time_minutes: 1,
    target_entry_time_seconds: 10,
    stable_hold_time_seconds: 20,
    min_up_tests: 3,
    min_down_tests: 3,
    total_tolerance_kw: 0.1,
    total_tolerance_kw_decimal: '0.10000000000000000001',
  });
  const profile = normalizeAgcControlProfileDecimalFields({
    group_name: 'g1',
    members: [{
      member_name: 'm1',
      up_p_gain: 0.1,
      up_p_gain_decimal: '0.10000000000000000001',
      up_i_gain: 0,
      up_i_gain_decimal: '',
      down_p_gain: 0,
      down_p_gain_decimal: '',
      down_i_gain: 0,
      down_i_gain_decimal: '',
      up_bias_kw: 0,
      up_bias_kw_decimal: '',
      down_bias_kw: 0,
      down_bias_kw_decimal: '',
      integral_limit_kw: 0,
      integral_limit_kw_decimal: '',
      max_step_kw: 0,
      max_step_kw_decimal: '',
      max_ramp_kw_per_s: 0,
      max_ramp_kw_per_s_decimal: '',
      version: 1,
      confirmed_at_ms: 2,
    }],
    version: 1,
    confirmed_at_ms: 2,
  });
  const status = normalizeAgcTuningStatusDecimalFields({
    group_name: 'g1',
    state: 2,
    direction: 1,
    completed_up_tests: 0,
    completed_down_tests: 0,
    started_at_ms: 1,
    elapsed_ms: 2,
    current_target_kw: 1,
    current_target_kw_decimal: '1.00000000000000000001',
    current_total_meas_kw: 1,
    current_total_meas_kw_decimal: '0.99999999999999999999',
    target_entry_elapsed_seconds: 3,
    stable_elapsed_seconds: 4,
    last_error: '',
    candidate_profile: profile,
  });

  assert.equal(config.target_upper_kw_decimal, '9.99999999999999999999');
  assert.equal(config.total_time_minutes, 120);
  assert.equal(profile.members[0].up_p_gain_decimal, '0.10000000000000000001');
  assert.equal(profile.members[0].up_i_gain_decimal, '0');
  assert.equal(status.current_target_kw_decimal, '1.00000000000000000001');
  assert.equal(status.current_total_meas_kw_decimal, '0.99999999999999999999');
});

// 验证非法 AGC decimal 文本会被公共严格校验拒绝，且不会静默回退旧 number。
test('AGC decimal 输入严格拒绝空白和非有限文本', () => {
  assert.match(getDecimalTextError(' 1.0', 'AGC 倍率'), /完整十进制数/);
  assert.match(getDecimalTextError('NaN', 'AGC 倍率'), /完整十进制数/);
  assert.equal(getDecimalTextError('0.12345678901234567890', 'AGC 倍率'), undefined);
});

// 验证 AGC 页面所有工程量输入使用字符串模式，而周期和时间字段继续使用 number。
test('AGC 页面工程量表单使用 InputNumber stringMode', () => {
  for (const field of [
    'scale_decimal',
    'offset_decimal',
    'capacity_kw_decimal',
    'weight_decimal',
    'min_kw_decimal',
    'max_kw_decimal',
    'target_lower_kw_decimal',
    'target_upper_kw_decimal',
    'total_tolerance_kw_decimal',
  ]) {
    assert.match(agcPageSource, new RegExp(`['\"]${field}['\"]`));
  }
  assert.match(agcPageSource, /<InputNumber<string>[\s\S]{0,240}?stringMode/);
  assert.ok((agcPageSource.match(/stringMode/g) ?? []).length >= 10);
  assert.match(agcPageSource, /name="total_time_minutes"[\s\S]{0,240}?<InputNumber min=\{1\}/);
});

// 验证 Tauri AGC DTO 在 Proto 双向转换中逐项携带 decimal 字段。
test('AGC Tauri DTO 贯通全部 decimal parallel 字段', () => {
  for (const field of [
    'scale_decimal',
    'offset_decimal',
    'capacity_kw_decimal',
    'weight_decimal',
    'min_kw_decimal',
    'max_kw_decimal',
    'up_p_gain_decimal',
    'up_i_gain_decimal',
    'down_p_gain_decimal',
    'down_i_gain_decimal',
    'up_bias_kw_decimal',
    'down_bias_kw_decimal',
    'integral_limit_kw_decimal',
    'max_step_kw_decimal',
    'max_ramp_kw_per_s_decimal',
    'target_lower_kw_decimal',
    'target_upper_kw_decimal',
    'total_tolerance_kw_decimal',
    'current_target_kw_decimal',
    'current_total_meas_kw_decimal',
  ]) {
    const occurrences = agcRustSource.match(new RegExp(field, 'g'))?.length ?? 0;
    assert.ok(occurrences >= 2, `${field} 必须同时存在于 DTO 和转换路径`);
  }
});
