import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const overviewSource = readFileSync(new URL('../../src/pages/Overview/index.tsx', import.meta.url), 'utf8');
const overviewStyle = readFileSync(new URL('../../src/pages/Overview/index.css', import.meta.url), 'utf8');
const adapterTypesSource = readFileSync(new URL('../../src/adapters/types.ts', import.meta.url), 'utf8');
const browserAdapterSource = readFileSync(new URL('../../src/adapters/browser.ts', import.meta.url), 'utf8');
const tauriAdapterSource = readFileSync(new URL('../../src/adapters/tauri.ts', import.meta.url), 'utf8');
const tauriDataCenterCommandSource = readFileSync(new URL('../../src-tauri/src/commands/data_center.rs', import.meta.url), 'utf8');
const tauriLibSource = readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8');

// 验证总览页提供可感知的同步状态和手动刷新入口。
test('总览页显示同步时间并支持手动刷新', () => {
  assert.match(overviewSource, /<Button[\s\S]*ReloadOutlined/);
  assert.match(overviewSource, /onClick=\{\(\) => void refresh\(\)\}/);
  assert.match(overviewSource, /lastSyncedAt/);
  assert.match(overviewSource, /overview-sync-status/);
});

// 验证已接入统计卡片能直接进入对应的运维页面，减少总览到配置页的跳转成本。
test('总览统计卡片支持页面跳转', () => {
  assert.match(overviewSource, /useNavigate\(\)/);
  assert.match(overviewSource, /overview-stat-card--link/);
  assert.match(overviewSource, /navigateToCard\(card\.path\)/);
  assert.match(overviewSource, /'\/module-ops'/);
  assert.match(overviewSource, /'\/data-bus'/);
});

// 验证总览只保留模块运维入口，避免把详细模块清单挤占首屏。
test('总览将模块详情交给模块运维页面', () => {
  assert.match(overviewSource, /'\/module-ops'/);
  assert.match(overviewSource, /进入模块运维/);
  assert.doesNotMatch(overviewSource, /overview-content-grid/);
  assert.doesNotMatch(overviewSource, /overview-module-list-item/);
});

// 验证总览不再用大面积能力占位区承载尚未接入的功能。
test('总览不占用空间展示未接入能力占位区', () => {
  assert.doesNotMatch(overviewSource, /overview-capability-list/);
  assert.doesNotMatch(overviewSource, /overview-capability-item/);
  assert.doesNotMatch(overviewSource, /title: '活动告警'/);
  assert.doesNotMatch(overviewSource, /dataSource=\{\[\]\}/);
  assert.doesNotMatch(overviewSource, /当前版本未接入真实吞吐量统计/);
});

// 验证吞吐量只展示路由转发口径，并覆盖接口待接入、浏览器演示数据和曲线状态。
test('总览提供数据总线转发速率面板', () => {
  assert.match(overviewSource, /overview-throughput-card/);
  assert.match(overviewSource, /routed_points_per_second/);
  assert.match(overviewSource, /数据总线转发速率/);
  assert.match(overviewSource, /接口待接入/);
  assert.match(overviewSource, /浏览器演示/);
  assert.match(overviewStyle, /\.overview-throughput-chart/);
  assert.match(overviewSource, /buildThroughputChartGeometry/);
  assert.match(overviewSource, /<svg[\s\S]*overview-throughput-line/);
  assert.match(overviewSource, /overview-throughput-axis-y/);
  assert.match(overviewSource, /overview-throughput-axis-x/);
  assert.match(overviewSource, /overview-throughput-y-tick/);
  assert.match(overviewSource, /overview-throughput-x-tick/);
  assert.match(overviewStyle, /\.overview-throughput-line/);
  assert.match(overviewStyle, /\.overview-throughput-area/);
  assert.doesNotMatch(overviewSource, /overview-throughput-bar/);
});

// 验证统计卡片图标使用独立容器，避免与大号统计数字挤在同一行。
test('总览统计卡片使用独立图标容器', () => {
  assert.match(overviewSource, /overview-stat-icon/);
  assert.match(overviewSource, /overview-stat-card-head/);
  assert.doesNotMatch(overviewSource, /prefix=\{card\.icon\}/);
  assert.match(overviewStyle, /\.overview-stat-icon/);
});

// 验证吞吐量适配器契约已接入后端快照命令，同时浏览器模式保留演示数据。
test('吞吐量 adapter 区分后端、浏览器演示和未接入状态', () => {
  assert.match(adapterTypesSource, /DataBusThroughputSnapshot/);
  assert.match(adapterTypesSource, /routed_points_per_second/);
  assert.match(browserAdapterSource, /source: 'browser-demo'/);
  assert.match(tauriAdapterSource, /dc_get_throughput_snapshot/);
  assert.match(tauriAdapterSource, /source: 'backend'/);
  assert.match(tauriDataCenterCommandSource, /dc_get_throughput_snapshot/);
  assert.match(tauriLibSource, /commands::data_center::dc_get_throughput_snapshot/);
});

// 验证总览页在窄窗口下使用网格断点，避免首屏内容横向溢出。
test('总览样式包含响应式网格断点', () => {
  assert.match(overviewStyle, /\.overview-summary-grid/);
  assert.match(overviewStyle, /@media \(max-width: 900px\)/);
  assert.match(overviewStyle, /@media \(max-width: 600px\)/);
});
