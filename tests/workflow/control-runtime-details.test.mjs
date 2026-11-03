import assert from 'node:assert/strict';
import test from 'node:test';
import { describeControlRuntimePoints, summarizeControlRuntime } from '../../src/utils/control-runtime-values.ts';

const point = (ts_ms, quality = 1) => ({ value: { type: 'Decimal', value: '42.00000000000000000001' }, ts_ms, quality });

// 验证明细保留真实缓存、点名去重，正常点无问题，缺失点不伪造时间或质量。
test('点值明细保留实际缓存并区分缺失点', () => {
  const update = point(9900);
  const rows = describeControlRuntimePoints({ actual: update }, ['actual', 'missing', 'actual', ''], 10000, 1000);
  assert.deepEqual(rows.map(row => row.tag), ['actual', 'missing']);
  assert.equal(rows[0].update, update);
  assert.deepEqual(rows[0].issues, []);
  assert.equal(rows[1].update, undefined);
  assert.deepEqual(rows[1].issues, ['点值缺失']);
});

// 验证超时、未知时间和未来时间与既有摘要规则一致，精确阈值及一秒容差不误报。
test('点值时间问题沿用原有新鲜度判定边界', () => {
  for (const [ts, issues] of [[9000, []], [8999, ['数据陈旧']], [0, ['时间未知']], [-1, ['时间未知']], [NaN, ['时间未知']], [Infinity, ['时间未知']], [11000, []], [11001, ['时间超前']]]) {
    const updates = { p: point(ts) };
    const [row] = describeControlRuntimePoints(updates, ['p'], 10000, 1000);
    assert.deepEqual(row.issues, issues);
    assert.equal(summarizeControlRuntime(updates, ['p'], 10000, 1000).staleCount, issues.length ? 1 : 0);
  }
});

// 验证质量问题可与超时同时展示，不把未指定、无效、不确定质量当作有效。
test('点值明细同时列出时间和质量问题', () => {
  for (const [quality, text] of [[0, '质量未指定'], [2, '质量无效'], [3, '质量不确定'], [99, '质量未知']]) {
    const [row] = describeControlRuntimePoints({ p: point(8000, quality) }, ['p'], 10000, 1000);
    assert.deepEqual(row.issues, ['数据陈旧', text]);
  }
});
