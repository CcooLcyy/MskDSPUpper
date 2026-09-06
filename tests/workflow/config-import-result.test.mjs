import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const settingsSource = readFileSync(new URL('../../src/pages/Settings/index.tsx', import.meta.url), 'utf8');
const exportSource = readFileSync(new URL('../../src/utils/config-export.ts', import.meta.url), 'utf8');

// 验证配置导入结果保留运行告警，并将链路重启失败作为警告展示。
test('config import surfaces deferred link startup warnings', () => {
  assert.match(exportSource, /配置已导入，但重新启动失败/);
  assert.match(settingsSource, /messageApi\.warning\(`\$\{successMessage\}（存在运行告警）`\)/);
  assert.match(settingsSource, /modal\[hasWarnings \? 'warning' : 'info'\]/);
});
