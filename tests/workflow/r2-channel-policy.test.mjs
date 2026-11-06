import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Windows 发布环境中，旧通道必须在读取包目录、凭据或调用 AWS 前被拒绝。
test('R2 publisher rejects beta before resolving assets or credentials', { skip: process.platform !== 'win32' }, () => {
  const script = fileURLToPath(new URL('../../scripts/workflow/Publish-R2StaticUpdater.ps1', import.meta.url));
  for (const channel of ['beta', 'beta-0.8', 'unknown']) {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-PackageOutputDir', '__retired_channel_must_not_read_assets__', '-ChannelPath', channel,
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ChannelPath/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /__retired_channel_must_not_read_assets__/);
  }
});
