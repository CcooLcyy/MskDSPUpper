import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildDuplicatePointTag,
  findDlt645PointConflict,
} from '../../src/pages/DLT645/dlt645-form-rules.ts';

const dlt645Source = readFileSync(new URL('../../src/pages/DLT645/index.tsx', import.meta.url), 'utf8');

// 验证 DLT645 复制点位会规范化已有副本后缀并选择第一个可用编号。
test('DLT645 复制点位生成规范化且不重复的 Tag', () => {
  assert.equal(buildDuplicatePointTag('temperature', []), 'temperature_copy');
  assert.equal(buildDuplicatePointTag('temperature_copy', ['temperature_copy']), 'temperature_copy_2');
  assert.equal(
    buildDuplicatePointTag('temperature_copy_3', ['temperature_copy', 'temperature_copy_3']),
    'temperature_copy_2',
  );
});

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
  assert.match(dlt645Source, /标签已存在/);
  assert.match(dlt645Source, /DI.*已存在|DI.*冲突/);
});
