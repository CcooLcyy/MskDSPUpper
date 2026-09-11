import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { findDlt645PointConflict } from '../../src/pages/DLT645/dlt645-form-rules.ts';
import {
  createDlt645EngineeringFields,
  normalizeDlt645Block,
  normalizeDlt645PointEngineeringFields,
  resolveDlt645EngineeringDecimalText,
} from '../../src/pages/DLT645/dlt645-decimal.ts';

const dlt645Source = readFileSync(new URL('../../src/pages/DLT645/index.tsx', import.meta.url), 'utf8');

// 验证普通 DLT645 点位不能复用其他点位的 DI。
test('DLT645 普通点位检测 DI 冲突', () => {
  const conflict = findDlt645PointConflict(
    { tag: 'power_copy', di: '02010100', data_len: 4, data_type: 6, byte_index: null, bit_index: null },
    [{ tag: 'power', di: '02010100', data_len: 4, data_type: 6, byte_index: null, bit_index: null }],
  );
  assert.equal(conflict, 'di');
});

// 验证 Tag 冲突优先于 DI 冲突，编辑当前点位时允许保留原 Tag 和 DI。
test('DLT645 点位检测 Tag 冲突并跳过当前编辑项', () => {
  const existing = { tag: 'power', di: '02010100', data_len: 4, data_type: 6, byte_index: null, bit_index: null };
  assert.equal(
    findDlt645PointConflict({ ...existing, di: '02010200' }, [existing]),
    'tag',
  );
  assert.equal(findDlt645PointConflict(existing, [existing], 0), null);
});

// 验证 DLT645 BOOL bit 点允许不同 bit，共用同一 DI 时仍检查长度和 bit 重复。
test('DLT645 BOOL bit 点检测 byte、bit 和长度冲突', () => {
  const existing = { tag: 'status_0', di: '02010100', data_len: 2, data_type: 1, byte_index: 0, bit_index: 0 };
  assert.equal(
    findDlt645PointConflict(
      { ...existing, tag: 'status_1', bit_index: 1 },
      [existing],
    ),
    null,
  );
  assert.equal(
    findDlt645PointConflict(
      { ...existing, tag: 'status_dup' },
      [existing],
    ),
    'di_bit',
  );
  assert.equal(
    findDlt645PointConflict(
      { ...existing, tag: 'status_len', bit_index: 1, data_len: 4 },
      [existing],
    ),
    'di_length',
  );
});

// 验证 DLT645 页面接入 Tag 和 DI 的前端冲突校验，避免仅依赖下位机返回错误。
test('DLT645 页面接入点位重复校验', () => {
  assert.match(dlt645Source, /findDlt645PointConflict\(/);
  assert.match(dlt645Source, /tag: point\.tag/);
  assert.match(dlt645Source, /useEffect\(\(\) => \{[\s\S]*pointForm\.setFields\(\[\{ name: 'tag', errors: \['标签已存在'\] \}\]\)/);
  assert.match(dlt645Source, /标签已存在/);
  assert.match(dlt645Source, /DI.*已存在|DI.*冲突/);
});

// 验证 DLT645 单点工程量构造保留 20 位小数原文，并同步派生旧 number 字段。
test('DLT645 单点工程量保留精确十进制原文', () => {
  const fields = createDlt645EngineeringFields({
    scale: '0.12345678901234567890',
    offset: '-2.00000000000000000001',
    deadband: '1e-20',
  });

  assert.equal(fields.scale_decimal, '0.12345678901234567890');
  assert.equal(fields.offset_decimal, '-2.00000000000000000001');
  assert.equal(fields.deadband_decimal, '1e-20');
  assert.equal(fields.scale, Number('0.12345678901234567890'));
});

// 验证旧 DLT645 点位回退 number，新点位优先读取精确文本。
test('DLT645 单点兼容旧点表并优先读取十进制文本', () => {
  const point = {
    tag: 'voltage',
    di: '02010100',
    data_len: 2,
    data_type: 4,
    access: 1,
    scale: 0.1,
    offset: 0,
    deadband: 0.01,
    scale_decimal: '',
    offset_decimal: '',
    deadband_decimal: '',
    byte_index: null,
    bit_index: null,
  };

  assert.equal(resolveDlt645EngineeringDecimalText(point, 'scale'), '0.1');
  const normalized = normalizeDlt645PointEngineeringFields({
    ...point,
    scale_decimal: '0.10000000000000000001',
  });
  assert.equal(normalized.scale_decimal, '0.10000000000000000001');
  assert.equal(normalized.offset_decimal, '0');
  assert.equal(normalized.deadband_decimal, '0.01');
});

// 验证数据块归一化覆盖全部子项，供连接复制和配置导入导出保持十进制原文。
test('DLT645 数据块复制保留所有子项的十进制文本', () => {
  const block = normalizeDlt645Block({
    block_di: '00010000',
    block_data_len: 4,
    items: [{
      tag: 'active_power',
      data_len: 4,
      data_type: 4,
      access: 1,
      scale: Number('0.00000000000000000001'),
      offset: 0,
      deadband: 0,
      scale_decimal: '0.00000000000000000001',
      offset_decimal: '0.00000000000000000000',
      deadband_decimal: '0',
      trim_right_space: null,
      byte_index: null,
      bit_index: null,
    }],
  });

  assert.equal(block.items[0].scale_decimal, '0.00000000000000000001');
  assert.equal(block.items[0].offset_decimal, '0.00000000000000000000');
});
