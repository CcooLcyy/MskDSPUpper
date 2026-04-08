import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateIdleHours,
  evaluatePromotionCandidate,
  versionMatchesBetaLine,
} from '../../scripts/workflow/lib/promotion.mjs';

// 验证 beta/x.y 与 package 版本 x.y.z 可以匹配，便于从版本线晋升稳定版。
test('versionMatchesBetaLine accepts x.y to x.y.z mapping', () => {
  assert.equal(versionMatchesBetaLine('1.2.3', '1.2'), true);
  assert.equal(versionMatchesBetaLine('1.2.3', '1.3'), false);
});

// 验证 beta/x.y.z 与 package 版本必须精确一致，避免错误晋升。
test('versionMatchesBetaLine requires exact match for x.y.z line', () => {
  assert.equal(versionMatchesBetaLine('1.2.3', '1.2.3'), true);
  assert.equal(versionMatchesBetaLine('1.2.4', '1.2.3'), false);
});

// 验证 3 天阈值会基于最新提交时间计算空窗期。
test('calculateIdleHours returns elapsed hours', () => {
  const hours = calculateIdleHours('2026-04-05T00:00:00.000Z', new Date('2026-04-08T00:00:00.000Z'));
  assert.equal(hours, 72);
});

// 验证满足 3 天无更新且不存在 stable tag 时，beta 分支可以自动晋升。
test('evaluatePromotionCandidate marks stale beta branch as eligible', () => {
  const result = evaluatePromotionCandidate({
    branchRef: 'beta/0.1',
    version: '0.1.0',
    lastCommitAt: '2026-04-05T00:00:00.000Z',
    now: new Date('2026-04-08T00:00:00.000Z'),
    thresholdHours: 72,
  });

  assert.equal(result.eligible, true);
  assert.equal(result.stableTag, 'v0.1.0');
});

// 验证已存在 stable tag 或未达到空窗阈值时，不会重复自动晋升。
test('evaluatePromotionCandidate blocks duplicate or premature promotion', () => {
  const duplicate = evaluatePromotionCandidate({
    branchRef: 'beta/0.1',
    version: '0.1.0',
    lastCommitAt: '2026-04-01T00:00:00.000Z',
    now: new Date('2026-04-08T00:00:00.000Z'),
    existingStableTags: ['v0.1.0'],
    thresholdHours: 72,
  });

  const premature = evaluatePromotionCandidate({
    branchRef: 'beta/0.1',
    version: '0.1.0',
    lastCommitAt: '2026-04-07T12:00:00.000Z',
    now: new Date('2026-04-08T00:00:00.000Z'),
    thresholdHours: 72,
  });

  assert.equal(duplicate.reason, 'stable_tag_exists');
  assert.equal(premature.reason, 'not_idle_enough');
});

// 验证非稳定三段式版本不会被自动晋升为 stable tag。
test('evaluatePromotionCandidate rejects non stable package version', () => {
  const result = evaluatePromotionCandidate({
    branchRef: 'beta/0.1',
    version: '0.1.0-beta.1',
    lastCommitAt: '2026-04-01T00:00:00.000Z',
    now: new Date('2026-04-08T00:00:00.000Z'),
    thresholdHours: 72,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'non_stable_version');
});
