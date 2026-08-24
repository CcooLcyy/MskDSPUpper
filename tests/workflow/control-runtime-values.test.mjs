import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { mergeControlRuntimeUpdates } from '../../src/utils/control-runtime-values.ts';

const agcSource = readFileSync(new URL('../../src/pages/AGC/index.tsx', import.meta.url), 'utf8');
const avcSource = readFileSync(new URL('../../src/pages/AVC/index.tsx', import.meta.url), 'utf8');

const destinationUpdate = (tag, value) => ({
  src_conn_id: 101,
  src_tag: `external_${tag}`,
  dst_conn_id: 7,
  dst_tag: tag,
  value: { type: 'Double', value },
  ts_ms: 100,
  quality: 0,
});

const sourceUpdate = (tag, value) => ({
  conn_id: 7,
  tag,
  value: { type: 'Double', value },
  ts_ms: 200,
  quality: 0,
  sequence: 2,
});

// 验证输入测量值和控制模块源端设定值会合并到同一运行值索引。
test('control runtime values merge destination measurements and source setpoints', () => {
  const result = mergeControlRuntimeUpdates(
    [destinationUpdate('q_meas', 71.9)],
    [sourceUpdate('q_set', 73.5)],
  );

  assert.equal(result.q_meas.value.value, 71.9);
  assert.equal(result.q_set.value.value, 73.5);
});

// 验证同名点位同时存在时，以控制模块源端实际发布值为准。
test('control runtime values prefer source updates for duplicate tags', () => {
  const result = mergeControlRuntimeUpdates(
    [destinationUpdate('actual_setpoint', 10)],
    [sourceUpdate('actual_setpoint', 12.5)],
  );

  assert.equal(result.actual_setpoint.value.value, 12.5);
  assert.equal(result.actual_setpoint.src_conn_id, 7);
  assert.equal(result.actual_setpoint.dst_tag, 'actual_setpoint');
});

// 验证 AGC、AVC 页面都查询源端值并使用统一合并逻辑。
test('AGC and AVC runtime monitors include source latest values', () => {
  for (const source of [agcSource, avcSource]) {
    assert.match(source, /api\.dcGetLatest\(selectedGroup\.conn_id, tags\)/);
    assert.match(source, /api\.dcGetSourceLatest\(selectedGroup\.conn_id, tags\)/);
    assert.match(source, /mergeControlRuntimeUpdates\(/);
  }
});
