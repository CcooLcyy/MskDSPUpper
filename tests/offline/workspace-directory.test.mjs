import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const readSource = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const adapterTypesSource = readSource('src/adapters/types.ts');
const browserAdapterSource = readSource('src/adapters/browser.ts');
const settingsPageSource = readSource('src/pages/Settings/index.tsx');
const workspaceManagerSource = readSource('src/offline/ui/WorkspaceManagerModal.tsx');
const workspaceStoreSource = readSource('src/offline/workspace/store.ts');
const rustRuntimePathsSource = readSource('src-tauri/src/runtime_paths.rs');
const rustAppStorageSource = readSource('src-tauri/src/commands/app_storage.rs');

// 工作区目录只有 Rust 一处来源：DTO 字段、前端类型与浏览器 mock 必须同步。
test('工作区目录由 Rust DTO 下发并在前端类型与浏览器 mock 中同步', () => {
  assert.match(adapterTypesSource, /RuntimeDirectoryKind = [^;]*'workspaces'/);
  assert.match(adapterTypesSource, /workspaces_dir: string;/);
  assert.match(browserAdapterSource, /workspaces_dir: 'browser-dev:\/\/workspaces'/);
  assert.match(rustRuntimePathsSource, /pub const WORKSPACES_SUBDIRECTORY: &str = "workspaces";/);
  assert.match(rustRuntimePathsSource, /pub fn workspaces_dir\(&self\) -> PathBuf \{[\s\S]*?self\.data_dir\.join\(WORKSPACES_SUBDIRECTORY\)/);
  assert.match(rustRuntimePathsSource, /workspaces_dir: self\.workspaces_dir\(\)\.to_string_lossy\(\)\.into_owned\(\)/);
  assert.match(rustRuntimePathsSource, /fn workspaces_dir_is_a_data_subdirectory_and_exposed_in_dto\(\)/);
});

// `打开工作区目录` 复用既有运行目录命令，避免新增一套打开目录的链路。
test('open_runtime_directory 支持 workspaces 类型', () => {
  assert.match(rustAppStorageSource, /"workspaces" => state\.runtime_paths\.workspaces_dir\(\)/);
});

// 前端不再自行拼接 `workspaces` 子目录名，防止与 Rust 侧漂移。
test('前端不再重复硬编码工作区子目录名', () => {
  assert.match(workspaceStoreSource, /paths\.workspaces_dir/);
  assert.doesNotMatch(workspaceStoreSource, /'workspaces'/);
});

// 本地数据卡片：路径行与按钮都必须由能力门禁控制，在线模式不出现工作区概念。
test('本地数据卡片按 workspace.manage 能力显示工作区目录入口', () => {
  assert.match(settingsPageSource, /useCapability\('workspace\.manage'\)/);
  assert.match(settingsPageSource, /<CapabilityGate need="workspace\.manage">/);
  assert.match(settingsPageSource, /handleOpenRuntimeDirectory\('workspaces'\)/);
  assert.match(settingsPageSource, /打开工作区目录/);
  assert.match(settingsPageSource, /runtimePaths\.workspaces_dir/);
});

// 离线工作区弹窗是选/存工作区的地方，同样提供直接打开默认目录的入口。
test('离线工作区弹窗提供打开工作区目录入口', () => {
  assert.match(workspaceManagerSource, /openRuntimeDirectory\('workspaces'\)/);
  assert.match(workspaceManagerSource, /打开工作区目录/);
});
