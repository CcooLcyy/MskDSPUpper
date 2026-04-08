import test from 'node:test';
import assert from 'node:assert/strict';

import {
  choosePreferredBetaRef,
  compareVersionLine,
  parseBetaLine,
} from '../../scripts/workflow/lib/metadata.mjs';

// 验证 beta 版本线解析只接受约定的 beta/x.y 或 beta/x.y.z 形式。
test('parseBetaLine accepts supported beta ref naming', () => {
  assert.equal(parseBetaLine('refs/heads/beta/1.2'), '1.2');
  assert.equal(parseBetaLine('origin/beta/1.2.3'), '1.2.3');
  assert.equal(parseBetaLine('feature/demo'), null);
});

// 验证版本线比较优先更高版本，确保定时 beta 重建默认选中最新线。
test('compareVersionLine sorts higher beta line first', () => {
  assert.ok(compareVersionLine('1.3', '1.2') > 0);
  assert.ok(compareVersionLine('1.2.4', '1.2') > 0);
});

// 验证在多个 beta 分支中会选出语义版本最高的一条。
test('choosePreferredBetaRef picks newest beta branch', () => {
  const ref = choosePreferredBetaRef([
    'origin/beta/1.2',
    'origin/beta/1.3',
    'origin/beta/1.2.9',
  ]);

  assert.equal(ref, 'beta/1.3');
});
