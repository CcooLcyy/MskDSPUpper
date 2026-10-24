import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 真实页面与 Provider 使用浏览器内存适配器；不登录平台、不连接或修改设备。
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const output = process.env.WORKBENCH_UI_OUTPUT || await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-workbench-ui-'));
await fs.mkdir(output, { recursive: true });
const { chromium } = await (process.env.MSKDSP_PLAYWRIGHT_MODULE
  ? import(pathToFileURL(process.env.MSKDSP_PLAYWRIGHT_MODULE)) : import('playwright'));
const { createServer } = await import(pathToFileURL(root + '/node_modules/vite/dist/node/index.js'));
const { default: react } = await import(pathToFileURL(root + '/node_modules/@vitejs/plugin-react/dist/index.js'));
const source = name => JSON.stringify('/@fs/' + root + '/src/' + name);
const entry = path.join(output, 'entry.tsx');
await fs.writeFile(entry, `
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { darkTheme } from ${source('theme/dark.ts')};
import ${source('index.css')};
import ${source('components/protocol/protocol-page.css')};
import { browserApi } from ${source('adapters/browser.ts')};
import { AppModeContext } from ${source('offline/app-mode-context.ts')};
import { capabilitiesFor } from ${source('offline/capabilities.ts')};
import { WorkbenchProvider } from ${source('workbench/WorkbenchProvider.tsx')};
import { WorkbenchViewSwitcher } from ${source('workbench/WorkbenchViewSwitcher.tsx')};
import { useWorkbench } from ${source('workbench/workbench-context.ts')};
import MainLayout from ${source('layouts/MainLayout.tsx')};
import { AppUpdateContext } from ${source('components/app-update/app-update-context.ts')};
import { PlatformAuthContext } from ${source('auth/platform-auth-context.ts')};
import { LowerUpdateDeploymentProvider } from ${source('components/lower-update/LowerUpdateDeploymentProvider.tsx')};
import IEC104 from ${source('pages/IEC104/index.tsx')};
import ModbusRTU from ${source('pages/ModbusRTU/index.tsx')};
import ModbusTCP from ${source('pages/ModbusTCP/index.tsx')};
import DLT645 from ${source('pages/DLT645/index.tsx')};
import AGC from ${source('pages/AGC/index.tsx')};
import AVC from ${source('pages/AVC/index.tsx')};
import DataBus from ${source('pages/DataBus/index.tsx')};
const state = window.__workbenchFixture = { calls: [], writes: [], mounts: {}, view: '', setView: null };
await browserApi.modbusTcpUpsertLink({ conn_name: '本地虚构 TCP 设备', tcp: { host: '127.0.0.1', port: 502, unit_id: 1, connect_timeout_ms: 3000, request_timeout_ms: 3000 }, poll_interval_ms: 1000, address_base: 1, read_plan: null }, true);
for (const [name, implementation] of Object.entries(browserApi)) {
  if (typeof implementation !== 'function') continue;
  browserApi[name] = (...args) => {
    state.calls.push(name);
    // 只记录接口名称，避免将接口参数和凭据写入验收日志。
    const read = !name.includes('GetOrCreate') && /(?:Get|List|Query|Subscribe|Unsubscribe)|^(get|list|query|subscribe|unsubscribe|loadAppSettings|check)/.test(name);
    if (!read) state.writes.push(name);
    return implementation(...args);
  };
}
const pages = { IEC104, ModbusRTU, ModbusTCP, DLT645, AGC, AVC, DataBus };
function ObservedPage({ name }) {
  useEffect(() => { state.mounts[name] = (state.mounts[name] || 0) + 1; }, [name]);
  const Page = pages[name];
  return <section data-testid="real-page" data-page={name} style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0 }}><Page /></section>;
}
function Workspace() {
  const { view, setView, runtimeAvailable } = useWorkbench();
  const [name, setName] = useState('IEC104');
  const navigate = useNavigate();
  state.view = view; state.setView = setView; state.runtimeAvailable = runtimeAvailable; state.navigate = navigate;
  return <><header className="fixture-header"><strong>本地虚构设备 · 只验证工作视图</strong><WorkbenchViewSwitcher /><span data-testid="view">{view}</span></header>
    <nav className="fixture-navigation">{Object.keys(pages).map(key => <button key={key} onClick={() => { navigate('/'); setName(key); }}>{key}</button>)}</nav>
    <ObservedPage key={name} name={name} /></>;
}
function Fixture() {
  const [mode, setMode] = useState('online');
  state.setMode = setMode;
  const value = useMemo(() => {
    const capabilities = capabilitiesFor(mode);
    return { mode, capabilities, can: capability => capabilities[capability], workspace: { workspace_name: '本地验收工作区 - 配置草稿仅留在浏览器内存' }, workspaceFilePath: null,
      switching: false, desktopRuntime: false, enterOfflineMode: async () => setMode('offline'), exitOfflineMode: async () => setMode('online'),
      listWorkspaces: async () => [], createWorkspace: () => {}, openWorkspaceFile: async () => {}, seedWorkspaceFromSnapshotFile: async () => '', saveWorkspaceAs: async () => '' };
  }, [mode]);
  if (new URLSearchParams(location.search).has('layout')) return <AppModeContext.Provider value={value}><WorkbenchProvider>
    <AppUpdateContext.Provider value={{ hasAvailableUpdate: false }}>
    <PlatformAuthContext.Provider value={{ snapshot: { phase: 'authenticated', status: { authenticated: true, display_name: '本地验收运维账号', username: 'fixture', role: 'admin', connection_state: 'online' } }, controller: { logout: async () => true } }}>
    <LowerUpdateDeploymentProvider><MemoryRouter initialEntries={['/protocol/iec104']}><Routes><Route path="/" element={<MainLayout />}><Route path="protocol/iec104" element={<IEC104 />} /></Route></Routes></MemoryRouter></LowerUpdateDeploymentProvider>
    </PlatformAuthContext.Provider></AppUpdateContext.Provider></WorkbenchProvider></AppModeContext.Provider>;
  return <AppModeContext.Provider value={value}><WorkbenchProvider><div className="fixture-shell">
    <div className="fixture-mode"><button onClick={() => setMode('offline')}>测试：进入离线</button><button onClick={() => setMode('online')}>测试：返回在线</button></div>
    <MemoryRouter><Workspace /></MemoryRouter></div></WorkbenchProvider></AppModeContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<ConfigProvider theme={darkTheme} locale={zhCN}><App><Fixture /></App></ConfigProvider>);
`);
const aliases = {};
for (const name of ['react-dom', 'react', 'antd', '@tauri-apps/api', '@ant-design/icons', 'react-router-dom']) aliases[name] = root + '/node_modules/' + name;
const server = await createServer({ configFile: false, root, plugins: [react(), {
  name: 'workbench-ui-fixture', configureServer(vite) {
    vite.middlewares.use('/__workbench-regression', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta charset="utf-8"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><style>html,body,#root{height:100%;margin:0;background:#1e1e1e;color:#eee;font-family:Microsoft YaHei,sans-serif}.fixture-shell{height:100vh;display:flex;flex-direction:column;overflow:hidden}.fixture-header{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;gap:12px;flex-wrap:wrap}.fixture-navigation,.fixture-mode{display:flex;gap:8px;padding:4px 12px;flex-wrap:wrap}.fixture-header>strong{font-size:13px}</style></head><body><div id="root"></div><script type="module" src=${JSON.stringify('/@fs/' + entry.replaceAll('\\', '/'))}></script></body></html>`);
    });
  },
}], resolve: { alias: aliases }, optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root, output] }, watch: { ignored: ['**/src-tauri/target/**', '**/dist/**'] } }, logLevel: 'error' });
await server.listen();
const address = server.httpServer.address();
const results = [];
const pageErrors = [];
let browser;
let page;
async function writeCount() { return page.evaluate(() => window.__workbenchFixture.writes.length); }
async function setView(view) {
  await page.locator('.workbench-view-switcher .ant-segmented-item').filter({ hasText: view === 'runtime' ? '运行监视' : '工程配置' }).click();
  await page.waitForFunction(value => window.__workbenchFixture.view === value, view);
}
async function programmaticView(view) {
  // 弹窗遮罩期间通过同一个 Provider 的公共 setView 验证草稿保留。
  await page.evaluate(value => window.__workbenchFixture.setView(value), view);
  await page.waitForFunction(value => window.__workbenchFixture.view === value, view);
}
async function identity() {
  return page.evaluate(() => {
    window.__observedPageNode = document.querySelector('[data-testid="real-page"]');
    const name = window.__observedPageNode.dataset.page;
    return { name, mounts: window.__workbenchFixture.mounts[name] };
  });
}
async function assertIdentity(before) {
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="real-page"]') === window.__observedPageNode), true, `${before.name} 不得重建页面节点`);
  assert.equal(await page.evaluate(name => window.__workbenchFixture.mounts[name], before.name), before.mounts, `${before.name} 不得重新挂载`);
}
async function assertNoWrites(before, label) {
  assert.equal(await writeCount(), before, `${label} 不得触发配置、目标或运行写接口：${JSON.stringify(await page.evaluate(() => window.__workbenchFixture.writes))}`);
}
async function choosePage(name) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.locator(`[data-testid="real-page"][data-page="${name}"]`).waitFor();
}
async function screenshot(name) {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true, animations: 'disabled' });
}
try {
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'], ...(process.env.MSKDSP_BROWSER_EXECUTABLE ? { executablePath: process.env.MSKDSP_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${address.port}/__workbench-regression`, { waitUntil: 'commit' });
  await page.locator('.protocol-connection-item-main').filter({ hasText: '调度中心-IEC104' }).click({ timeout: 60000 });
  await page.getByRole('button', { name: /筛选/ }).click();
  await page.getByPlaceholder('搜索 Tag 或 IOA').waitFor();

  // IEC104：连接选择、过滤与勾选点位在公共视图切换后保留。
  const search = page.getByPlaceholder('搜索 Tag 或 IOA');
  await search.fill('');
  const pointCheckbox = page.locator('.protocol-point-card .ant-table-row .ant-checkbox-input').first();
  await pointCheckbox.check();
  const selectedTag = await page.locator('.protocol-point-card .ant-table-row').first().getAttribute('data-row-key');
  await search.fill(selectedTag);
  const iecIdentity = await identity();
  const iecWrites = await writeCount();
  await setView('runtime');
  await assertIdentity(iecIdentity);
  await assertNoWrites(iecWrites, 'IEC104 切至运行监视');
  const runtimeHeaders = await page.locator('.protocol-point-card .ant-table-thead th').allTextContents();
  assert.match(runtimeHeaders[0], /Tag/);
  assert.match(runtimeHeaders[1], /实时.*值/);
  assert.match(runtimeHeaders[2], /质量|品质/);
  assert.match(runtimeHeaders[3], /时间/);
  await screenshot('iec104-runtime-1366');
  await setView('engineering');
  assert.equal(await search.inputValue(), selectedTag);
  assert.equal(await page.locator('.protocol-point-card .ant-table-row .ant-checkbox-input:checked').count() > 0, true, 'IEC104 选点应保留');
  await assertIdentity(iecIdentity);
  await assertNoWrites(iecWrites, 'IEC104 切回工程');
  await page.getByRole('button', { name: /编辑配置/ }).click();
  const connectionDialog = page.getByRole('dialog', { name: '编辑连接', exact: true });
  const editableInput = connectionDialog.locator('input:not([disabled]):not([type="hidden"])').first();
  await editableInput.fill('本地未保存草稿');
  await programmaticView('runtime');
  await programmaticView('engineering');
  assert.equal(await editableInput.inputValue(), '本地未保存草稿');
  await assertNoWrites(iecWrites, 'IEC104 未保存连接草稿切视图');
  await connectionDialog.getByRole('button', { name: /取\s*消/ }).click();
  await screenshot('iec104-engineering-1366');
  results.push('IEC104 真实页面：切换不卸载、不写设备，筛选/勾选/未保存连接草稿保留');

  // 其它协议：两种视图都可进入，页面身份稳定且不调用写接口。
  for (const name of ['ModbusRTU', 'ModbusTCP', 'DLT645']) {
    await choosePage(name);
    await page.locator('.protocol-connection-item-main').first().waitFor();
    const before = await identity();
    const writes = await writeCount();
    await setView('runtime');
    await assertIdentity(before);
    await setView('engineering');
    await assertIdentity(before);
    await assertNoWrites(writes, name + ' 切换工作视图');
    results.push(name + ' 真实页面：工程/运行切换不卸载且无写接口');
  }

  // 两个控制模块各保留一个未提交的组配置草稿与当前选择。
  for (const name of ['AGC', 'AVC']) {
    await choosePage(name);
    await page.locator('.control-summary-card .ant-card-extra button').first().waitFor();
    const second = page.locator('.ant-list-item').nth(1);
    await second.click();
    const selectedName = await second.locator('.ant-typography').first().innerText();
    const before = await identity();
    const writes = await writeCount();
    await setView('runtime');
    await page.getByText(selectedName + ' · 运行监视', { exact: true }).waitFor();
    await assertIdentity(before);
    await screenshot(name.toLowerCase() + '-runtime-1366');
    await setView('engineering');
    await page.locator('.control-summary-card .ant-card-extra button').first().click();
    const dialog = page.getByRole('dialog', { name: '编辑 ' + name + ' 控制组', exact: true });
    const input = dialog.locator('input[type="text"]:not([disabled]):visible').first();
    await input.fill('fixture-unsaved-' + name.toLowerCase());
    await programmaticView('runtime');
    await programmaticView('engineering');
    assert.equal(await input.inputValue(), 'fixture-unsaved-' + name.toLowerCase());
    await assertIdentity(before);
    await assertNoWrites(writes, name + ' 草稿切换');
    await dialog.getByRole('button', { name: /取\s*消/ }).click();
    const discard = page.getByRole('button', { name: /放弃|丢弃/, exact: false });
    if (await discard.count()) await discard.last().click();
    await screenshot(name.toLowerCase() + '-engineering-1366');
    results.push(name + ' 真实页面：控制组选择/未保存组配置保留，切换无写接口');
  }

  // 数据总线分别保留两个视图的过滤条件。
  await choosePage('DataBus');
  await page.evaluate(() => window.__workbenchFixture.navigate('/?view=config'));
  const routeSearch = page.getByPlaceholder('筛选端点、标签或连接编号');
  await routeSearch.fill('fixture-route-filter');
  const busIdentity = await identity();
  const busWrites = await writeCount();
  await setView('runtime');
  const monitorSearch = page.getByPlaceholder('筛选标签或连接编号');
  await monitorSearch.fill('fixture-value-filter');
  await setView('engineering');
  assert.equal(await routeSearch.inputValue(), 'fixture-route-filter');
  await setView('runtime');
  assert.equal(await monitorSearch.inputValue(), 'fixture-value-filter');
  await assertIdentity(busIdentity);
  await assertNoWrites(busWrites, '数据总线切视图');
  results.push('数据总线真实页面：两种视图过滤条件独立保留，页面未重建且无写接口');

  // 离线限制只改变有效视图，不覆盖在线展示偏好。
  const offlineWrites = await writeCount();
  await page.getByRole('button', { name: '测试：进入离线', exact: true }).click();
  await page.waitForFunction(() => window.__workbenchFixture.view === 'engineering' && !window.__workbenchFixture.runtimeAvailable);
  assert.equal(await page.locator('.workbench-view-switcher').getByRole('radio', { name: /运行监视/ }).isDisabled(), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('mskdsp.workbench.view.v1')), 'runtime');
  await page.getByRole('button', { name: '测试：返回在线', exact: true }).click();
  await page.waitForFunction(() => window.__workbenchFixture.view === 'runtime');
  await assertNoWrites(offlineWrites, '离线/在线视图恢复');
  await setView('engineering');
  await page.getByRole('button', { name: '测试：进入离线', exact: true }).click();
  await page.getByRole('button', { name: '测试：返回在线', exact: true }).click();
  await page.waitForFunction(() => window.__workbenchFixture.view === 'engineering');
  results.push('离线强制工程且禁用运行，返回在线分别恢复原工程/运行偏好');

  await choosePage('IEC104');
  await page.locator('.protocol-connection-item-main').filter({ hasText: '调度中心-IEC104' }).click();
  await setView('runtime');
  await page.setViewportSize({ width: 1024, height: 768 });
  await screenshot('iec104-runtime-1024');
  const viewport = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
    switcher: document.querySelector('.workbench-view-switcher').getBoundingClientRect().toJSON() }));
  assert.ok(viewport.switcher.x >= 0 && viewport.switcher.right <= viewport.width, '1024 宽工作视图入口不得溢出');
  assert.ok(viewport.scrollWidth <= viewport.width + 1, '1024 宽页面根节点不得产生横向滚动');
  await setView('engineering');
  await screenshot('iec104-engineering-1024');
  await page.reload();
  await page.getByTestId('view').waitFor({ timeout: 45000 });
  assert.equal(await page.getByTestId('view').innerText(), 'engineering');
  await setView('runtime');
  await page.reload();
  await page.getByTestId('view').waitFor({ timeout: 45000 });
  assert.equal(await page.getByTestId('view').innerText(), 'runtime');
  results.push('1366/1024 截图与入口可见性，刷新分别恢复工程/运行展示偏好');

  // 最外层使用真实 MainLayout，只有账号/更新通知的上下文由本地 fixture 提供。
  await page.goto(`http://127.0.0.1:${address.port}/__workbench-regression?layout=1`, { waitUntil: 'commit' });
  await page.locator('.workbench-global-header').waitFor();
  await page.locator('.protocol-connection-item-main').filter({ hasText: '调度中心-IEC104' }).click();
  for (const width of [1366, 1024]) {
    await page.setViewportSize({ width, height: 768 });
    await page.locator('.workbench-view-switcher .ant-segmented-item').filter({ hasText: '运行监视' }).click();
    await page.locator('[data-workbench-view="runtime"]').waitFor();
    await screenshot('main-layout-runtime-' + width);
    const geometry = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return { width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
        device: rect('.workbench-device-context'), switcher: rect('.workbench-view-switcher'), actions: rect('.workbench-global-actions') };
    });
    for (const key of ['device', 'switcher', 'actions']) {
      assert.ok(geometry[key].x >= 0 && geometry[key].right <= geometry.width, width + ' 宽顶栏 ' + key + ' 应可见');
    }
    const overlap = (a, b) => a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1;
    assert.equal(overlap(geometry.device, geometry.switcher), false, '设备上下文和工作视图不得重叠');
    assert.equal(overlap(geometry.switcher, geometry.actions), false, '工作视图和账号操作不得重叠');
    assert.ok(geometry.scrollWidth <= geometry.width + 1, '真实 MainLayout 不得横向溢出');
    await page.locator('.workbench-view-switcher .ant-segmented-item').filter({ hasText: '工程配置' }).click();
    await page.locator('[data-workbench-view="engineering"]').waitFor();
    await screenshot('main-layout-engineering-' + width);
  }
  await page.evaluate(() => window.__workbenchFixture.setMode('offline'));
  await page.getByText('本地验收工作区 - 配置草稿仅留在浏览器内存', { exact: true }).first().waitFor();
  const offlineControls = await page.locator('.workbench-global-actions button').evaluateAll(buttons => buttons.map(button => ({
    text: button.innerText, disabled: button.disabled, left: button.getBoundingClientRect().left, right: button.getBoundingClientRect().right,
  })));
  for (const button of offlineControls) assert.ok(button.left >= 0 && button.right <= 1024, '离线操作不得被裁切：' + JSON.stringify(button));
  await screenshot('main-layout-offline-1024');
  results.push('真实 MainLayout：1366/1024 顶栏设备、视图、账号不重叠，离线长工作区名截图');
  assert.deepEqual(pageErrors, [], '不得发生浏览器页面异常');
  console.log(JSON.stringify({ ok: true, results, output, scope: '真实页面与真实 WorkbenchProvider；AppModeContext 和设备接口使用本地 fixture，不代表真机联调' }, null, 2));
} catch (error) {
  if (page) await screenshot('failure').catch(() => {});
  console.error(JSON.stringify({ ok: false, completed: results, error: String(error), pageErrors, output }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
