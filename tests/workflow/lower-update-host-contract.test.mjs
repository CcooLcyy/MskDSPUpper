import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// 验证上位机实际携带的宿主机更新器与下位机维护的源码逐字节一致。
test('the embedded host updater matches the canonical lower updater', (context) => {
  const embedded = readFileSync(new URL('../../src-tauri/src/commands/lower_update_task.py', import.meta.url));
  const canonicalUrl = new URL('../../../MskDSP/script/update/lower_update_task.py', import.meta.url);
  if (!existsSync(canonicalUrl)) {
    context.skip('独立上位机检出无下位机仓库，跨仓库字节一致性在联合工作区验证');
    return;
  }
  const canonical = readFileSync(canonicalUrl);
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(embedded), digest(canonical), '上下位机必须携带相同的任务与回退实现');
});
