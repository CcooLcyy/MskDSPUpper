import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const source = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

// 验证自动更新方案明确了 30 秒调度和安装边界。
test('software auto update design fixes the 30 second no-side-effect policy', () => {
  const design = source('doc/软件自动更新方案.md');

  assert.match(design, /每 30 秒自动检查/);
  assert.match(design, /上位机更新只进入“待安装”状态/);
  assert.match(design, /不自动上传、安装或连接目标设备/);
});
// 验证上位机后台任务会自动下载，但安装动作仍由用户触发。
test('upper updater separates download from install and keeps the 30 second timer', () => {
  const provider = source('src/components/app-update/AppUpdateProvider.tsx');
  const adapter = source('src/adapters/tauri.ts');

  assert.match(provider, /const UPDATE_CHECK_INTERVAL_MS = 30_000/);
  assert.match(provider, /downloadAppUpdate/);
  assert.match(provider, /ready-to-install/);
  assert.match(adapter, /update\.download\(/);
  assert.match(adapter, /update\.install\(/);
  assert.doesNotMatch(provider, /downloadAndInstallAppUpdate/);
});

// 验证下位机后台任务检查全部通道，只使用本地下载接口，不执行部署。
test('lower updater auto coordinator downloads every channel without deployment', () => {
  const coordinator = source('src/components/lower-update/LowerUpdateAutoProvider.tsx');
  const design = source('doc/软件自动更新方案.md');
  const context = source('src/components/lower-update/lower-update-auto-context.ts');

  assert.match(coordinator, /30_000/);
  assert.match(coordinator, /const LOWER_UPDATE_CHANNELS[^\n]*stable[^\n]*beta[^\n]*nightly[^\n]*ci/);
  assert.match(coordinator, /api\.checkLowerUpdate\(channel\)/);
  assert.match(coordinator, /api\.listCachedLowerUpdates\(channel\)/);
  assert.match(coordinator, /api\.downloadLowerUpdate\(manifest/);
  assert.match(context, /channels: Record<LowerUpdateChannel, LowerUpdateAutoChannelStatus>/);
  assert.match(design, /`stable`、`beta`、`nightly`、`ci` 四个通道/);
  assert.match(coordinator, /downloadLowerUpdate/);
  assert.doesNotMatch(coordinator, /uploadLowerUpdatePackage/);
  assert.doesNotMatch(coordinator, /installLowerUpdatePackage/);
});
