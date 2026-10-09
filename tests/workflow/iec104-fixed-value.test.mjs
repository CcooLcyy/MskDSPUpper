import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  canUseIec104FixedValue,
  getIec104FixedValueError,
  normalizeIec104FixedValueFields,
} from '../../src/pages/IEC104/fixed-value.ts';
import { parseWorkspace, serializeWorkspace } from '../../src/offline/workspace/serialize.ts';
import { createEmptyWorkspace } from '../../src/offline/workspace/types.ts';

const point = { tag: 'voltage', ioa: 0x4001, point_type: 1, business_type: 2, scale: 2, offset: 3, deadband: 0,
  scale_decimal: '2', offset_decimal: '3', deadband_decimal: '0', fixed_value_enabled: true, fixed_value: 0 };

// 验证旧配置默认关闭，固定零值及倍率偏移在复制与关闭时完整保留。
test('IEC104 固定值兼容旧配置并保留零值和换算参数', () => {
  const legacy = { ...point };
  delete legacy.fixed_value_enabled;
  delete legacy.fixed_value;
  assert.deepEqual(normalizeIec104FixedValueFields(legacy), { ...legacy, fixed_value_enabled: false, fixed_value: 0 });
  assert.deepEqual(normalizeIec104FixedValueFields({ ...point }), point);
  assert.deepEqual(normalizeIec104FixedValueFields({ ...point, fixed_value_enabled: false }), { ...point, fixed_value_enabled: false });
});

// 验证固定值只为从站上报点开放，业务、类型及站角色变化清理非法启用状态。
test('IEC104 固定值限制从站遥测遥信并清理非法配置', () => {
  assert.equal(canUseIec104FixedValue(point, true), true);
  assert.equal(canUseIec104FixedValue(point, false), false);
  for (const business_type of [3, 4, 5]) {
    assert.equal(normalizeIec104FixedValueFields({ ...point, business_type }).fixed_value_enabled, false);
  }
  assert.equal(normalizeIec104FixedValueFields(point, false).fixed_value_enabled, false);
  assert.equal(normalizeIec104FixedValueFields({ ...point, point_type: 0 }).fixed_value_enabled, false);
  assert.equal(normalizeIec104FixedValueFields({ ...point, point_type: 2, fixed_value: 10 }).fixed_value_enabled, false);
  assert.equal(normalizeIec104FixedValueFields({ ...point, point_type: 2, fixed_value: 1 }).fixed_value_enabled, true);
  assert.equal(canUseIec104FixedValue({ ...point, business_type: 0 }, true), true);
});

// 验证固定值必须为有限 FLOAT 或布尔 0/1，关闭时允许保留上次输入供后续修改。
test('IEC104 固定值校验有限单精度范围和单点零一值', () => {
  for (const fixed_value of [NaN, Infinity, -Infinity, 1e39, -1e39, 3.4028235e38, -3.4028235e38]) {
    assert.match(getIec104FixedValueError({ ...point, fixed_value }), /有限|单精度/);
  }
  assert.equal(getIec104FixedValueError({ ...point, fixed_value: 3.4028234663852886e38 }), undefined);
  assert.equal(getIec104FixedValueError({ ...point, fixed_value: -10 }), undefined);
  assert.equal(getIec104FixedValueError({ ...point, point_type: 2, fixed_value: 0 }), undefined);
  assert.equal(getIec104FixedValueError({ ...point, point_type: 2, fixed_value: 1 }), undefined);
  assert.match(getIec104FixedValueError({ ...point, point_type: 2, fixed_value: 2 }), /0 或 1/);
  assert.equal(getIec104FixedValueError({ ...point, fixed_value_enabled: false, fixed_value: 10 }), undefined);
});

// 验证离线文件序列化与导出导入共享的点表结构不会丢失固定值或原换算参数。
test('IEC104 固定值在离线工作区和导出数据往返中保留', () => {
  const workspace = createEmptyWorkspace('固定值测试', '2026-10-09T00:00:00Z');
  workspace.config.iec104.links = [{ link: { config: { conn_name: 'slave', role: 1, station_role: 2 } },
    point_table: { conn_name: 'slave', points: [point], replace: true } }];
  const parsed = parseWorkspace(serializeWorkspace(workspace));
  assert.deepEqual(parsed.config.iec104.links[0].point_table.points[0], point);
});

// 验证 UI 与协议转换路径均接入字段，且固定模式下仅置灰倍率偏移。
test('IEC104 固定值贯通编辑复制列表和协议边界', () => {
  const page = readFileSync(new URL('../../src/pages/IEC104/index.tsx', import.meta.url), 'utf8');
  const rust = readFileSync(new URL('../../src-tauri/src/commands/iec104.rs', import.meta.url), 'utf8');
  const proto = readFileSync(new URL('../../proto/IEC104.proto', import.meta.url), 'utf8');
  assert.match(page, /name="fixed_value_enabled"/);
  assert.match(page, /name="fixed_value"/);
  assert.match(page, /fixed_value_enabled: source\.fixed_value_enabled/);
  assert.match(page, /fixed_value: source\.fixed_value/);
  assert.match(page, /disabled=\{isSinglePoint \|\| pointFixedValueEnabled\}/);
  assert.match(page, /固定值模式下不生效/);
  assert.match(page, /固定上报值/);
  assert.match(page, /实时源值/);
  assert.match(rust, /fixed_value_enabled: point\.fixed_value_enabled/);
  assert.match(rust, /fixed_value: self\.fixed_value/);
  assert.match(proto, /bool fixed_value_enabled = 13;/);
  assert.match(proto, /double fixed_value = 14;/);
});
