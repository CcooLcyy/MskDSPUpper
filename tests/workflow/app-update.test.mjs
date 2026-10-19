import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const providerSource = readFileSync(
  new URL('../../src/components/app-update/AppUpdateProvider.tsx', import.meta.url),
  'utf8',
);
const tauriSource = readFileSync(
  new URL('../../src/adapters/tauri.ts', import.meta.url),
  'utf8',
);
const contextSource = readFileSync(
  new URL('../../src/components/app-update/app-update-context.ts', import.meta.url),
  'utf8',
);

// 验证 30 秒调度保留，且“已下载待安装”不再冻结后台检查。
test('upper updater keeps the 30-second schedule and only pauses while transferring', () => {
  assert.match(providerSource, /const UPDATE_CHECK_INTERVAL_MS = 30_000/);

  const timerBlock = providerSource.match(
    /window\.setInterval\(\(\) => \{([\s\S]*?)\n {4}\}, UPDATE_CHECK_INTERVAL_MS\)/,
  );
  assert.ok(timerBlock, '应保留 30 秒后台检查定时器');
  assert.match(timerBlock[1], /isDownloadingUpdateRef\.current/);
  assert.match(timerBlock[1], /isInstallingUpdateRef\.current/);
  assert.doesNotMatch(timerBlock[1], /isUpdateDownloaded/);
  assert.match(providerSource, /downloadingPromiseRef\.current/);
});

// 检查委派给原生目录查询，不在适配器中释放已下载包。
test('upper updater delegates catalog checks without dropping the downloaded package', () => {
  const checkHandler = tauriSource.match(/checkAppUpdate: [^\n]+/);
  assert.ok(checkHandler, '应保留 checkAppUpdate 适配器实现');
  assert.match(checkHandler[0], /invoke<AppUpdateInfo \| null>\('check_app_update'\)/);
  assert.doesNotMatch(checkHandler[0], /disposePendingAppUpdate/);
});

// 验证原生下载入口与前端包身份复用规则；失败保留行为由 Provider 实际执行测试覆盖。
test('upper updater keeps exactly one downloaded package and never leaves none', () => {
  assert.match(providerSource, /sameAppUpdatePackage\(downloaded, checkedUpdate\)/);
  assert.match(providerSource, /已保留已下载的客户端/);
  assert.match(tauriSource, /invoke<AppUpdateInfo>\('download_app_update', \{ taskId \}\)/);
});

// 验证下载照旧自动执行、安装仍由用户触发，且安装前做一次最终检查交由用户选择。
test('upper updater downloads automatically but only installs after explicit action', () => {
  assert.match(providerSource, /await api\.downloadAppUpdate/);
  assert.match(providerSource, /await api\.installAppUpdate\(\)/);
  assert.match(providerSource, /请选择要安装的版本/);
  assert.match(providerSource, /kind: 'needs-choice'/);
  assert.doesNotMatch(providerSource, /downloadAndInstallAppUpdate/);
  assert.match(tauriSource, /'download_app_update'/);
  assert.match(tauriSource, /'install_app_update'/);
  assert.doesNotMatch(tauriSource, /downloadAndInstallAppUpdate: async[\s\S]*?checkAppUpdate/);
});

// 验证持久化元数据、待安装状态与安装结果类型对页面可见。
test('upper updater persists metadata while documenting process-local download lifetime', () => {
  assert.match(providerSource, /APP_UPDATE_METADATA_KEY/);
  assert.match(providerSource, /persistUpdate\(downloaded\)/);
  assert.match(providerSource, /ready-to-install/);
  assert.match(contextSource, /isUpdateDownloaded: boolean/);
  assert.match(contextSource, /downloadedVersion: string \| null/);
  assert.match(contextSource, /AppUpdateInstallResult/);
});
