import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGC_DEFAULT_POINT_TAGS,
  AVC_DEFAULT_POINT_TAGS,
  IEC104_DEFAULT_TIME_SYNC_TAG,
  deriveCalcItemTags,
  deriveConnTags,
} from '../../src/offline/workspace/derive-tags.ts';

// IEC104 必须连带注册对时标签，否则主站对时会缺少订阅标签。
test('iec104 tags include the default time sync tag', () => {
  const tags = deriveConnTags({ module: 'IEC104', points: [{ tag: 'A' }, { tag: 'B' }] });

  assert.deepEqual(tags, ['A', 'B', IEC104_DEFAULT_TIME_SYNC_TAG]);
});

// 点表里已声明对时标签时不得重复注册。
test('iec104 does not duplicate a declared time sync tag', () => {
  const tags = deriveConnTags({ module: 'IEC104', points: [{ tag: IEC104_DEFAULT_TIME_SYNC_TAG }] });

  assert.deepEqual(tags, [IEC104_DEFAULT_TIME_SYNC_TAG]);
});

// 配置覆盖对时标签名时必须使用配置值。
test('iec104 honours a configured time sync tag', () => {
  const tags = deriveConnTags({ module: 'IEC104', points: [{ tag: 'A' }], timeSyncTag: 'sync/pulse' });

  assert.deepEqual(tags, ['A', 'sync/pulse']);
});

// Modbus 点表标签必须全量注册，采集点与写功能码点不区分。
test('modbus tags include every point tag', () => {
  assert.deepEqual(
    deriveConnTags({ module: 'ModbusRTU', points: [{ tag: 'B' }, { tag: 'A' }, { tag: 'A' }] }),
    ['A', 'B'],
  );
  assert.deepEqual(deriveConnTags({ module: 'ModbusTCP', points: [{ tag: 'C' }] }), ['C']);
});

// DLT645 的标签是点表与块配置 items 的并集，且不做任何拼接。
test('dlt645 merges point tags and block item tags', () => {
  const tags = deriveConnTags({
    module: 'DLT645',
    points: [{ tag: 'B' }],
    blocks: [{ block_di: '00000000', block_data_len: 4, items: [{ tag: 'A' }, { tag: 'A' }] }],
  });

  assert.deepEqual(tags, ['A', 'B']);
});

// AGC 必须始终注册 8 个固定默认点。
test('agc always registers the eight fixed default points', () => {
  const tags = deriveConnTags({
    module: 'AGC',
    config: { group_name: 'g', p_cmd: null, members: [], outputs: null },
  });

  assert.deepEqual(tags, [...AGC_DEFAULT_POINT_TAGS].sort());
  assert.equal(AGC_DEFAULT_POINT_TAGS.length, 8);
});

// AGC 必须叠加配置中的字面标签，并在增量模式下叠加 base_tag。
test('agc adds configured tags and conditional base tags', () => {
  const tags = deriveConnTags({
    module: 'AGC',
    config: {
      group_name: 'g',
      p_cmd: { signal: { tag: 'p_cmd_tag' }, mode: 2, delta_base: 3, base_tag: 'p_cmd_base' },
      outputs: { p_total_meas: { tag: 'p_meas_total' }, p_total_target: null, p_total_error: null },
      members: [{
        member_name: '1#',
        p_meas: { tag: 'member_meas' },
        p_set: { signal: { tag: 'member_set' }, mode: 2, delta_base: 3, base_tag: 'member_base' },
      }],
    },
  });

  for (const tag of ['p_cmd_tag', 'p_cmd_base', 'p_meas_total', 'member_meas', 'member_set', 'member_base']) {
    assert.ok(tags.includes(tag), `AGC 标签应包含 ${tag}`);
  }
});

// 绝对值模式下不得把 base_tag 注册成标签。
test('agc ignores base_tag when the value mode is absolute', () => {
  const tags = deriveConnTags({
    module: 'AGC',
    config: {
      group_name: 'g',
      p_cmd: { signal: null, mode: 1, delta_base: 3, base_tag: 'unexpected' },
      members: [],
      outputs: null,
    },
  });

  assert.ok(!tags.includes('unexpected'));
});

// AVC 必须始终注册 12 个固定默认点。
test('avc always registers the twelve fixed default points', () => {
  const tags = deriveConnTags({
    module: 'AVC',
    config: { group_name: 'g', members: [] },
  });

  assert.deepEqual(tags, [...AVC_DEFAULT_POINT_TAGS].sort());
  assert.equal(AVC_DEFAULT_POINT_TAGS.length, 12);
});

// AVC 必须叠加电压量测、命令分支与成员标签。
test('avc adds configured tags for measurement command and members', () => {
  const tags = deriveConnTags({
    module: 'AVC',
    config: {
      group_name: 'g',
      voltage_meas: { tag: 'voltage_meas_tag' },
      voltage_cmd: { tag: 'voltage_cmd_tag' },
      q_total_cmd: { signal: { tag: 'q_total_tag' }, mode: 2, delta_base: 3, base_tag: 'q_total_base' },
      members: [{
        member_name: '1#',
        q_meas: { tag: 'member_q_meas' },
        q_set: { signal: { tag: 'member_q_set' }, mode: 1, delta_base: 0, base_tag: '' },
      }],
    },
  });

  for (const tag of ['voltage_meas_tag', 'voltage_cmd_tag', 'q_total_tag', 'q_total_base', 'member_q_meas', 'member_q_set']) {
    assert.ok(tags.includes(tag), `AVC 标签应包含 ${tag}`);
  }
});

// Calc 聚合项必须按 1-based 编号派生 input_N 与 result。
test('calc aggregate items derive numbered inputs and a result tag', () => {
  const tags = deriveCalcItemTags({
    item_name: 'item',
    operator_kind: 9,
    operands: [{}, {}, {}],
    left_operand: null,
    right_operand: null,
  });

  assert.deepEqual(tags, ['item/input_1', 'item/input_2', 'item/input_3', 'item/result']);
});

// Calc 非聚合项（含 NOT）必须派生 left_input 与 right_input。
test('calc non aggregate items derive left and right input tags', () => {
  assert.deepEqual(
    deriveCalcItemTags({
      item_name: 'item',
      operator_kind: 5,
      operands: [],
      left_operand: {},
      right_operand: null,
    }),
    ['item/left_input', 'item/result', 'item/right_input'],
  );
});

// Calc 分组本身没有分组级标签，只由计算项派生。
test('calc group without items yields no tags', () => {
  assert.deepEqual(deriveConnTags({ module: 'Calc', config: { group_name: 'g', items: [] } }), []);
});

// DeviceInfo 与 BoardIO 的固定标签必须与模块硬编码注册保持一致。
test('device info and board io expose fixed tags', () => {
  assert.deepEqual(deriveConnTags({ module: 'DeviceInfo' }), ['cpu.usage_percent', 'memory.usage_percent']);
  assert.deepEqual(deriveConnTags({ module: 'BoardIO', connName: 'board-di' }), ['DI1', 'DI2', 'DI3', 'DI4']);
  assert.deepEqual(deriveConnTags({ module: 'BoardIO', connName: 'board-do' }), ['DO1', 'DO2']);
});

// 未支持的模块必须显式报错，避免静默生成错误的标签注册表。
test('unsupported module raises a chinese error', () => {
  assert.throws(
    () => deriveConnTags({ module: 'IEC61850' }),
    /离线工作区暂不支持派生该模块的标签/,
  );
});
