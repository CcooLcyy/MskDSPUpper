import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  mergeControlRuntimeUpdates,
  readControlRuntimeBool,
  summarizeControlRuntime,
} from '../../src/utils/control-runtime-values.ts';

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

// 验证控制状态优先使用实时默认点，实时点尚未返回时保留控制组元数据回退值。
test('control runtime bool states override group metadata when available', () => {
  const updates = mergeControlRuntimeUpdates([
    {
      ...destinationUpdate('AGC功能投入', 0),
      value: { type: 'Bool', value: false },
    },
  ], []);

  assert.equal(readControlRuntimeBool(updates, 'AGC功能投入', true), false);
  assert.equal(readControlRuntimeBool(updates, 'AGC远方操作', true), true);
  assert.equal(readControlRuntimeBool(updates, undefined, false), false);
});

// 验证 AGC、AVC 页面都查询源端值并使用统一合并逻辑。
test('AGC and AVC runtime monitors include source latest values', () => {
  for (const source of [agcSource, avcSource]) {
    assert.match(source, /api\.dcGetLatest\(selectedGroup\.conn_id, tags\)/);
    assert.match(source, /api\.dcGetSourceLatest\(selectedGroup\.conn_id, tags\)/);
    assert.match(source, /mergeControlRuntimeUpdates\(/);
    assert.match(source, /readControlRuntimeBool\(/);
  }
});

const runtimeUpdate = (tag, ts_ms = 9900, quality = 1) => ({
  ...destinationUpdate(tag, 42),
  ts_ms,
  quality,
});

// 验证未返回任何期望点值时保持等待，同时记录缺点数量。
test('运行摘要在尚未收到期望点值时等待', () => {
  assert.deepEqual(summarizeControlRuntime({}, ['p', 'q'], 10000, 1000), {
    state: 'waiting', latestTimestamp: null, staleCount: 0, missingCount: 2, uncertainCount: 0,
  });
  assert.equal(summarizeControlRuntime({ extra: runtimeUpdate('extra') }, [], 10000, 1000).state, 'waiting');
});

// 验证所有期望点均新鲜且质量有效才正常，数据时间取点值时间而非查询时间。
test('运行摘要使用真实点值时间并要求所有点有效', () => {
  assert.deepEqual(summarizeControlRuntime({ p: runtimeUpdate('p'), q: runtimeUpdate('q', 10000) }, ['p', 'q'], 10000, 1000), {
    state: 'ok', latestTimestamp: 10000, staleCount: 0, missingCount: 0, uncertainCount: 0,
  });
});

// 验证阈值边界有效，超过阈值后进入陈旧状态，即使查询仍然成功。
test('运行摘要按点值年龄区分阈值边界与过期', () => {
  const updates = { p: runtimeUpdate('p', 9000) };
  assert.equal(summarizeControlRuntime(updates, ['p'], 10000, 1000).state, 'ok');
  const result = summarizeControlRuntime(updates, ['p'], 10001, 1000);
  assert.equal(result.state, 'stale');
  assert.equal(result.latestTimestamp, 9000);
  assert.equal(result.staleCount, 1);
});

// 验证零、负数、非有限时间均为未知且陈旧，不能伪装为最新数据。
test('运行摘要将未知时间视为陈旧', () => {
  for (const timestamp of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = summarizeControlRuntime({ p: runtimeUpdate('p', timestamp) }, ['p'], 10000, 1000);
    assert.equal(result.state, 'stale');
    assert.equal(result.latestTimestamp, null);
    assert.equal(result.staleCount, 1);
  }
});

// 验证未来异常时间不可显示正常，但保留原始时间供界面解释。
test('运行摘要标识未来异常时间', () => {
  const result = summarizeControlRuntime({ p: runtimeUpdate('p', 11001) }, ['p'], 10000, 1000);
  assert.equal(result.state, 'stale');
  assert.equal(result.latestTimestamp, 11001);
  assert.equal(result.staleCount, 1);
});

// 验证展示时钟比刚到达的点值落后时，一秒以内的新值不会误判为未来异常。
test('运行摘要允许一秒展示时钟容差并保留真实时间', () => {
  for (const timestamp of [10001, 10500, 11000]) {
    const result = summarizeControlRuntime({ p: runtimeUpdate('p', timestamp) }, ['p'], 10000, 1000);
    assert.equal(result.state, 'ok');
    assert.equal(result.latestTimestamp, timestamp);
    assert.equal(result.staleCount, 0);
  }
});

// 验证未指定、无效、不确定质量均不可显示正常，也不丢弃其点值。
test('运行摘要保留质量异常点并计数', () => {
  for (const quality of [0, 2, 3]) {
    const updates = { p: runtimeUpdate('p', 9900, quality) };
    const result = summarizeControlRuntime(updates, ['p'], 10000, 1000);
    assert.equal(result.state, 'quality');
    assert.equal(result.uncertainCount, 1);
    assert.equal(result.latestTimestamp, 9900);
    assert.equal(updates.p.value.value, 42);
  }
});

// 验证部分缺点优先显示缺点，并同时保留陈旧和质量异常计数。
test('运行摘要同时汇总缺点陈旧与质量异常', () => {
  assert.deepEqual(summarizeControlRuntime({ p: runtimeUpdate('p', 5000, 2) }, ['p', 'q'], 10000, 1000), {
    state: 'missing', latestTimestamp: 5000, staleCount: 1, missingCount: 1, uncertainCount: 1,
  });
});

// 验证重复及空标签不重复计数，额外点值不会改变控制组摘要。
test('运行摘要只计算去重后的有效期望标签', () => {
  const result = summarizeControlRuntime({ p: runtimeUpdate('p'), extra: runtimeUpdate('extra', 1, 2) }, ['p', 'p', ''], 10000, 1000);
  assert.equal(result.state, 'ok');
  assert.equal(result.latestTimestamp, 9900);
});
