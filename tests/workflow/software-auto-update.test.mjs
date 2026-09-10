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

// 验证页面手动下载和自动下载共用路由外的全局任务。
test('lower updater keeps one resumable download task across route changes', () => {
  const coordinator = source('src/components/lower-update/LowerUpdateAutoProvider.tsx');
  const context = source('src/components/lower-update/lower-update-auto-context.ts');
  const page = source('src/pages/AdvancedConfig/index.tsx');

  assert.match(context, /ensureDownloaded/);
  assert.match(context, /downloadResult: LowerUpdateDownloadResult \| null/);
  assert.match(coordinator, /downloadTasksRef/);
  assert.match(coordinator, /cacheKey\(manifest\)/);
  assert.match(coordinator, /ensureDownloaded/);
  assert.match(page, /useLowerUpdateAuto\(\)/);
  assert.match(page, /ensureDownloaded\(downloadingManifest\)/);

  const manualDownloadHandler = page.match(
    /const handleDownload = async \(\): Promise<void> => \{([\s\S]*?)\n  \};/,
  );
  assert.ok(manualDownloadHandler, '应保留手动下载处理函数');
  assert.doesNotMatch(manualDownloadHandler[1], /api\.downloadLowerUpdate/);
});

// 验证缓存读取和后台下载期间不会误报“无可用缓存”。
test('lower update page distinguishes loading and background download from empty cache', () => {
  const page = source('src/pages/AdvancedConfig/index.tsx');

  assert.match(page, /正在读取缓存/);
  assert.match(page, /后台下载中/);
  assert.match(page, /isLoadingCachedPackages[\s\S]*?isDownloadingLowerUpdate[\s\S]*?无可用缓存/);
});

// 验证 Tauri 下载进度使用任务和通道标识过滤，避免多通道串线。
test('lower update progress is correlated to one task and channel', () => {
  const adapterTypes = source('src/adapters/types.ts');
  const adapter = source('src/adapters/tauri.ts');
  const backend = source('src-tauri/src/commands/lower_update.rs');

  assert.match(adapterTypes, /task_id: string/);
  assert.match(adapterTypes, /channel: LowerUpdateChannel/);
  assert.match(adapter, /payload\.task_id !== taskId/);
  assert.match(adapter, /payload\.channel !== manifest\.channel/);
  assert.match(backend, /pub task_id: String/);
  assert.match(backend, /pub channel: String/);
});
