import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const output = process.env.MODULE_OPS_UI_OUTPUT || await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-module-ops-ui-'));
await fs.mkdir(output, { recursive: true });
const { createServer } = await import(pathToFileURL(root + '/node_modules/vite/dist/node/index.js'));
const { default: react } = await import(pathToFileURL(root + '/node_modules/@vitejs/plugin-react/dist/index.js'));
// 复用已有 Playwright 与浏览器，不向产品添加测试运行时依赖。
const { chromium } = await (process.env.MSKDSP_PLAYWRIGHT_MODULE
  ? import(pathToFileURL(process.env.MSKDSP_PLAYWRIGHT_MODULE)) : import('playwright'));
let component = root + '/src/pages/ModuleOps/index.tsx';
if (process.env.MODULE_OPS_UI_BASELINE) {
  const source = execFileSync('git', ['show', process.env.MODULE_OPS_UI_BASELINE + ':src/pages/ModuleOps/index.tsx'], { cwd: root, encoding: 'utf8' });
  component = path.join(output, 'baseline.tsx').replaceAll('\\', '/');
  await fs.writeFile(component, source.replace(/(['"])(\.{1,2}\/[^'"]+)\1/g, (_match, _quote, relative) => {
    const base = path.resolve(root + '/src/pages/ModuleOps', relative).replaceAll('\\', '/');
    const target = path.extname(base) ? base : [base + '.ts', base + '.tsx', base + '/index.ts'].find(existsSync);
    return JSON.stringify('/@fs/' + target);
  }));
}
const entry = path.join(output, 'entry.tsx');
const mockAdapter = path.join(output, 'adapter.ts').replaceAll('\\', '/');
await fs.writeFile(mockAdapter, `import {invoke} from '@tauri-apps/api/core';
export const api={setManagerAddr:(addr,forceReconnect)=>invoke('set_manager_addr',{addr,forceReconnect}),
getModuleInfo:()=>invoke('get_module_info'),getRunningModuleInfo:()=>invoke('get_running_module_info'),
saveAppSetting:(key,value)=>invoke('save_app_setting',{key,value}),
startModule:moduleInfo=>invoke('start_module',{moduleInfo}),stopModule:moduleInfo=>invoke('stop_module',{moduleInfo})};`);
await fs.writeFile(entry, `import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import ModuleOps from ${JSON.stringify('/@fs/' + component)};
import {AppModeContext} from ${JSON.stringify('/@fs/' + root + '/src/offline/app-mode-context.ts')};
const context={can:()=>false};
function Fixture(){const [shown,setShown]=useState(true);return <AppModeContext.Provider value={context as any}><button onClick={()=>setShown(false)}>卸载测试页面</button>{shown&&<ModuleOps/>}</AppModeContext.Provider>}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture/></React.StrictMode>);
`);
const aliases = {};
for (const name of ['react-dom', 'react', 'antd', '@tauri-apps/api', '@xterm/xterm', '@xterm/addon-fit']) aliases[name] = root + '/node_modules/' + name;
const server = await createServer({ configFile: false, root, plugins: [react(), {
  name: 'module-ops-api-fixture', enforce: 'pre', resolveId(id, importer) {
    const resolved = id.startsWith('.') && importer ? path.resolve(path.dirname(importer), id).replaceAll('\\', '/') : id.replace(/^\/@fs\//, '');
    if ([root + '/src/adapters', root + '/src/adapters/index.ts'].includes(resolved)) return mockAdapter;
  },
}, {
  name: 'module-ops-regression', configureServer(server) {
    server.middlewares.use('/__module-ops-regression', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta charset="utf-8"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src=${JSON.stringify('/@fs/' + entry.replaceAll('\\', '/'))}></script></body></html>`);
    });
  },
}], resolve: { alias: aliases }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, output] } }, logLevel: 'error' });
await server.listen();
let browser;
let page;
const results = [];
const pageErrors = [];
try {
  browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--no-proxy-server'], ...(process.env.MSKDSP_BROWSER_EXECUTABLE ? { executablePath: process.env.MSKDSP_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const state = window.__moduleOpsMock = { mode: 'success', name: '初始模块', pending: [], calls: [], addresses: [], remote: false };
    const info = () => ({ module_name: state.name, version: { version: '0.0.1' }, lib_name: 'fixture.so', dependencies: [], outer_grpc_server: '192.0.2.1:17001', inner_grpc_server: '' });
    let next = 0;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++next, unregisterCallback: () => {},
      invoke: async (command, args) => {
        state.calls.push(command);
        if (command === 'remote_connection_status') return { remote: state.remote, device_id: state.remote ? 'fixture-device' : null, active: state.remote };
        if (command === 'remote_select_device') state.remote = true;
        if (command === 'remote_use_direct') state.remote = false;
        if (command === 'set_manager_addr') state.addresses.push(args.addr);
        if (command === 'remote_list_devices') return [{ device_id: 'fixture-device', display_name: '测试远程设备', online: true, allow_grpc: true, allow_ssh: false, services: ['ModuleManager'] }];
        if (command === 'get_running_module_info') {
          if (state.mode === 'pending') return new Promise((resolve, reject) => state.pending.push({ resolve, reject, value: [info()] }));
          return [info()];
        }
        if (command === 'get_module_info') return [info()];
        return null;
      },
    };
  });
  const open = async () => {
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__module-ops-regression`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByText('初始模块', { exact: true }).waitFor();
  };
  const connect = () => page.getByRole('button', { name: /^连\s*接$/, exact: true });
  const startPending = async () => {
    await page.evaluate(() => { window.__moduleOpsMock.mode = 'pending'; });
    await connect().click();
    await page.waitForFunction(() => window.__moduleOpsMock.pending.length === 1);
  };
  const settle = async (reject = false) => {
    await page.evaluate(async reject => {
      const pending = window.__moduleOpsMock.pending[0];
      if (reject) pending.reject('已放弃的旧请求失败'); else pending.resolve(pending.value);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    }, reject);
  };
  await open();
  await startPending();
  // 误点连接不能遮罩列表，也不能封锁地址及连接方式。
  assert.equal(await page.locator('.ant-table-wrapper .ant-spin-spinning').count(), 0, '连接等待不应遮罩模块列表');
  await page.getByRole('button', { name: /正在连接/ }).waitFor();
  assert.equal(await page.getByLabel('ModuleManager 地址', { exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('radio', { name: '平台远程', exact: true }).isEnabled(), true);
  await page.screenshot({ path: path.join(output, 'connecting.png'), fullPage: true });
  results.push('连接等待无遮罩，地址和平台切换保持可操作');
  // 不可达请求约五秒自行结束，旧数据必须标记过期且禁止启停。
  await page.getByRole('alert').filter({ hasText: /无法连接或读取模块列表/ }).waitFor({ timeout: 7000 });
  await page.getByText('上次读取，当前未连接', { exact: true }).waitFor();
  assert.equal(await page.getByText('初始模块', { exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: /停\s*止/ }).isDisabled(), true);
  await settle(true);
  assert.equal(await page.locator('.ant-message').filter({ hasText: /已放弃的旧请求失败/ }).count(), 0);
  await page.screenshot({ path: path.join(output, 'timeout.png'), fullPage: true });
  results.push('超时结束等待，保留并标记旧数据，禁用模块启停，迟到失败无弹窗');
  await page.evaluate(() => { window.__moduleOpsMock.mode = 'success'; window.__moduleOpsMock.name = '重连成功模块'; });
  await connect().click();
  await page.getByText('重连成功模块', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /停\s*止/ }).isEnabled(), true);
  assert.equal(await page.getByRole('alert').filter({ hasText: /无法连接或读取模块列表/ }).count(), 0);
  results.push('主动重试成功后恢复最新数据和模块操作');

  await open();
  await startPending();
  await page.getByLabel('ModuleManager 地址', { exact: true }).fill('192.0.2.2:17000');
  assert.equal(await page.getByRole('button', { name: /正在连接/ }).count(), 0);
  await page.evaluate(() => { window.__moduleOpsMock.mode = 'success'; window.__moduleOpsMock.name = '新地址模块'; });
  await connect().click();
  await page.getByText('新地址模块', { exact: true }).waitFor();
  const reads = await page.evaluate(() => window.__moduleOpsMock.calls.filter(command => command === 'get_module_info').length);
  await settle();
  assert.equal(await page.evaluate(() => window.__moduleOpsMock.calls.filter(command => command === 'get_module_info').length), reads, '旧请求成功后不能继续读取模块列表');
  assert.equal(await page.getByText('新地址模块', { exact: true }).isVisible(), true);
  results.push('修改地址立即结束等待，旧成功不覆盖新请求');

  await open();
  await startPending();
  await page.getByText('平台远程', { exact: true }).click();
  await page.getByRole('button', { name: '连接所选设备', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /正在连接/ }).count(), 0);
  await settle(true);
  assert.equal(await page.getByRole('alert').filter({ hasText: /已放弃的旧请求失败/ }).count(), 0);
  assert.equal(await page.locator('.ant-message').filter({ hasText: /已放弃的旧请求失败/ }).count(), 0);
  results.push('切平台立即结束旧等待，迟到失败无提示');

  await open();
  await page.getByLabel('ModuleManager 地址', { exact: true }).fill('192.0.2.3:17000');
  await page.evaluate(() => { window.__moduleOpsMock.name = '刷新输入地址模块'; });
  await page.getByRole('button', { name: /刷新模块/ }).click();
  await page.getByText('刷新输入地址模块', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__moduleOpsMock.addresses.at(-1)), '192.0.2.3:17000');
  results.push('手动刷新应用当前输入地址');

  await open();
  await page.getByText('平台远程', { exact: true }).click();
  await page.getByLabel('平台远程设备', { exact: true }).click();
  await page.getByText('测试远程设备', { exact: true }).click();
  await page.getByRole('button', { name: '连接所选设备', exact: true }).click();
  await page.waitForFunction(() => window.__moduleOpsMock.calls.includes('remote_select_device'));
  await page.getByText('现场直连', { exact: true }).click();
  await page.evaluate(() => { window.__moduleOpsMock.mode = 'pending'; });
  await page.getByRole('button', { name: '切换至现场直连', exact: true }).click();
  await page.waitForFunction(() => window.__moduleOpsMock.pending.length === 1);
  assert.equal(await page.getByRole('radio', { name: '平台远程', exact: true }).isEnabled(), true);
  await page.getByText('平台远程', { exact: true }).click();
  await settle(true);
  assert.equal(await page.getByRole('alert').filter({ hasText: /已放弃的旧请求失败/ }).count(), 0);
  results.push('从远程返回直连读取时不锁住连接方式，切走后旧失败无提示');

  await open();
  await startPending();
  await page.getByRole('button', { name: '卸载测试页面', exact: true }).click();
  await settle(true);
  assert.equal(await page.locator('.module-ops-page').count(), 0);
  assert.equal(await page.locator('.ant-message').count(), 0);
  assert.deepEqual(pageErrors, [], '页面不应存在未捕获异常');
  results.push('离开页面结束等待，迟到失败不弹消息或抛异常');
  const report = { results, pageErrors, output };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  const report = { results, pageErrors, error: String(error), output };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally { await browser?.close(); await server.close(); }
