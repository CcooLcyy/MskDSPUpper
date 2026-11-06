import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 删除已退役的生产入口，同时保留拒绝旧通道与历史包兼容的独立回归。
test('retired beta entry points cannot resolve or validate publishing branches', () => {
  for (const file of ['resolve-beta-ref.mjs', 'verify-beta-lineage.mjs']) {
    assert.equal(fs.existsSync(new URL(`../../scripts/workflow/${file}`, import.meta.url)), false);
  }
});
