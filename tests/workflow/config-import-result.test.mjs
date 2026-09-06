import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const settingsSource = readFileSync(new URL('../../src/pages/Settings/index.tsx', import.meta.url), 'utf8');
const exportSource = readFileSync(new URL('../../src/utils/config-export.ts', import.meta.url), 'utf8');

// 验证成功导入只恢复配置并保持运行项停止，失败时仍尝试恢复原运行状态。
test('config import keeps runtime items stopped after successful restore', () => {
  const runtimeSource = exportSource.match(/async function withStoppedRuntimeItems\([\s\S]*?\n}\n/)?.[0] ?? '';

  assert.match(exportSource, /配置已保存，运行项保持停止状态，等待手动启动/);
  assert.match(runtimeSource, /restoreRuntimeItems\(moduleLabel, stoppedItems, start, warnings, true\)/);
  assert.match(runtimeSource, /throw error;/);
  assert.doesNotMatch(runtimeSource, /restoreRuntimeItems\(moduleLabel, stoppedItems, start, warnings\);/);
  assert.match(exportSource, /syncIec104\([\s\S]*?await withStoppedRuntimeItems\(/);
  assert.match(exportSource, /syncModbusRtu\([\s\S]*?await withStoppedRuntimeItems\(/);
  assert.match(exportSource, /syncDlt645\([\s\S]*?await withStoppedRuntimeItems\(/);
  assert.match(exportSource, /syncAgc\([\s\S]*?await withStoppedRuntimeItems\(/);
  assert.match(exportSource, /syncAvc\([\s\S]*?await withStoppedRuntimeItems\(/);
  assert.match(exportSource, /syncCalc\([\s\S]*?await withStoppedRuntimeItems\(/);
  assert.doesNotMatch(runtimeSource, /api\.[a-zA-Z]+Start(?:Link|Group)\(/);
  assert.match(settingsSource, /messageApi\.warning\(`\$\{successMessage\}（存在运行告警）`\)/);
  assert.match(settingsSource, /modal\[hasWarnings \? 'warning' : 'info'\]/);
});
