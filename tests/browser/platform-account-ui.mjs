import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// 复用外部已有 Playwright，不安装浏览器或修改产品依赖。
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const output = process.env.PLATFORM_ACCOUNT_UI_OUTPUT || await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-platform-account-browser-'));
await fs.mkdir(output, { recursive: true });
const playwright = process.env.MSKDSP_PLAYWRIGHT_MODULE;
const { chromium } = await (playwright ? import(pathToFileURL(playwright)) : import('playwright'));
const { createServer } = await import(pathToFileURL(root + '/node_modules/vite/dist/node/index.js'));
const { default: react } = await import(pathToFileURL(root + '/node_modules/@vitejs/plugin-react/dist/index.js'));
const source = name => JSON.stringify('/@fs/' + root + '/src/auth/' + name);
const entry = path.join(output, 'entry.tsx');
await fs.writeFile(entry, `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { darkTheme } from ${JSON.stringify('/@fs/' + root + '/src/theme/dark.ts')};
import ${JSON.stringify('/@fs/' + root + '/src/index.css')};
import { PlatformAuthProvider } from ${source('PlatformAuthProvider.tsx')};
import { PlatformAuthGate } from ${source('PlatformAuthGate.tsx')};
import { PlatformAccountControl } from ${source('PlatformAccountControl.tsx')};
import { createPlatformAuthController } from ${source('platform-auth-controller.ts')};
import { platformAuthApi } from ${source('platform-auth-api.ts')};
import { usePlatformAuth } from ${source('platform-auth-context.ts')};
import { assertPlatformLogoutAllowed, registerPlatformLogoutGuard, reloadPlatformWorkspace } from ${source('platform-workspace-lifecycle.ts')};
const controller = createPlatformAuthController(platformAuthApi, async () => {
  sessionStorage.setItem('fixture-initializations', String(Number(sessionStorage.getItem('fixture-initializations') || 0) + 1));
}, Date.now, { prepareLogout: assertPlatformLogoutAllowed, resetWorkspace: reloadPlatformWorkspace });
window.__accountFixture = { controller, taskActive: false };
registerPlatformLogoutGuard(() => window.__accountFixture.taskActive ? '模拟设备正在升级，请等待升级完成后退出。' : null);
function Workspace() {
  const [draft, setDraft] = useState('');
  const { snapshot } = usePlatformAuth();
  return <section data-testid="workspace"><PlatformAccountControl />
    <p data-testid="workspace-account">{snapshot.owner}</p>
    <label>模拟草稿<input aria-label="模拟草稿" value={draft} onChange={event => setDraft(event.target.value)} /></label>
  </section>;
}
createRoot(document.getElementById('root')!).render(<ConfigProvider theme={darkTheme} locale={zhCN}><App><PlatformAuthProvider controller={controller}><PlatformAuthGate><Workspace /></PlatformAuthGate></PlatformAuthProvider></App></ConfigProvider>);
`);
const aliases = {};
for (const name of ['react-dom', 'react', 'antd', '@tauri-apps/api']) aliases[name] = root + '/node_modules/' + name;
const serveEntry = { name: 'platform-account-regression-entry', configureServer(server) {
  server.middlewares.use('/__platform-account-regression', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><meta charset="utf-8"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src=${JSON.stringify('/@fs/' + entry.replaceAll('\\', '/'))}></script></body></html>`);
  });
} };
const server = await createServer({ configFile: false, root, plugins: [react(), serveEntry], resolve: { alias: aliases }, optimizeDeps: { entries: [entry] },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root, output] } }, logLevel: 'error' });
await server.listen();
let browser;
let page;
const failures = [];
const results = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.env.MSKDSP_BROWSER_EXECUTABLE ? { executablePath: process.env.MSKDSP_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => failures.push(error.message));
  await page.addInitScript(() => {
    const signedOut = () => ({ authenticated: false, username: null, display_name: null, role: null, connection_state: 'signed_out', expires_at: null, message: null });
    const readSettings = () => JSON.parse(sessionStorage.getItem('fixture-settings') || JSON.stringify({ grpc_endpoint: 'http://fixture.invalid:50000', username: 'alice', auto_login: false, remember_password: false }));
    sessionStorage.setItem('fixture-loads', String(Number(sessionStorage.getItem('fixture-loads') || 0) + 1));
    const state = window.__accountMock = { status: signedOut(), calls: [] };
    const authenticate = username => state.status = { authenticated: true, username, display_name: username, role: 'operator', connection_state: 'online', expires_at: Date.now() + 3600000, message: null };
    let callback = 0;
    window.__TAURI_INTERNALS__ = { transformCallback: () => ++callback, unregisterCallback: () => {}, invoke: async (command, args) => {
      // 模拟记录只保留命令名，不记录密码及令牌。
      state.calls.push(command);
      if (command === 'get_platform_login_settings') return readSettings();
      if (command === 'save_platform_login_settings') {
        sessionStorage.setItem('fixture-settings', JSON.stringify(args.settings));
        return args.settings;
      }
      if (command === 'platform_login') {
        sessionStorage.setItem('fixture-settings', JSON.stringify({ ...readSettings(), username: args.username, auto_login: args.autoLogin, remember_password: args.rememberPassword }));
        return authenticate(args.username);
      }
      if (command === 'platform_auto_login') return authenticate(readSettings().username);
      if (command === 'get_platform_auth_status') return state.status;
      if (command === 'platform_logout') return state.status = signedOut();
      if (command === 'has_platform_saved_password') return readSettings().remember_password && args.username === readSettings().username;
      if (command === 'get_platform_saved_password') return readSettings().remember_password && args.username === readSettings().username ? 'fixture-password' : null;
      if (command === 'plugin:window|is_maximized') return true;
      return null;
    } };
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__platform-account-regression`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const account = () => page.locator('input[autocomplete="username"]');
  const login = async (username, autoLogin = false) => {
    await account().fill(username);
    await page.locator('input[autocomplete="current-password"]').fill('fixture-password');
    if (autoLogin) await page.getByLabel('下次自动登录', { exact: true }).check();
    await page.getByRole('button', { name: /^登\s*录$/ }).click();
    await page.getByTestId('workspace-account').filter({ hasText: username }).waitFor();
  };
  await login('alice', true);
  await page.getByRole('textbox', { name: '模拟草稿', exact: true }).fill('alice-unsaved-draft');
  const beforeLoads = await page.evaluate(() => sessionStorage.getItem('fixture-loads'));
  await page.getByTestId('workspace').getByRole('button', { name: /退\s*出$/ }).click();
  assert.equal(await page.getByRole('dialog').count(), 1, '主动退出只应显示一次确认');
  await page.getByRole('dialog').getByRole('button', { name: '退出登录', exact: true }).click();
  await page.waitForFunction(previous => sessionStorage.getItem('fixture-loads') !== previous, beforeLoads);
  await account().waitFor();
  assert.equal(await account().getAttribute('readonly'), null, '重建后的账号必须可以编辑');
  assert.equal(await page.getByLabel('下次自动登录', { exact: true }).isChecked(), false);
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.screenshot({ path: path.join(output, 'logout-login.png'), fullPage: true });
  await login('bob');
  assert.equal(await page.getByRole('textbox', { name: '模拟草稿', exact: true }).inputValue(), '', '新账号不得继承旧草稿');
  assert.equal(await page.evaluate(() => Number(sessionStorage.getItem('fixture-initializations'))), 2);
  results.push('主动退出一次确认、整页重载、关闭自动登录及新账号独立工作台通过');

  await page.getByRole('textbox', { name: '模拟草稿', exact: true }).fill('bob-retained-draft');
  const bobLoads = await page.evaluate(() => sessionStorage.getItem('fixture-loads'));
  await page.evaluate(async () => {
    window.__accountMock.status = { ...window.__accountMock.status, authenticated: false, expires_at: 0 };
    await window.__accountFixture.controller.poll();
  });
  await page.getByText('工作台已锁定', { exact: true }).waitFor();
  assert.equal(await account().getAttribute('readonly'), '');
  assert.equal(await account().inputValue(), 'bob');
  await page.getByRole('button', { name: '退出并更换账号', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.locator('.ant-modal-root.platform-auth-confirm').evaluate(node => getComputedStyle(node).display !== 'none'), true, '锁定页确认必须豁免业务弹窗隐藏规则');
  assert.equal(await page.evaluate(() => {
    const businessModal = document.createElement('div');
    businessModal.className = 'ant-modal-root';
    document.body.append(businessModal);
    const display = getComputedStyle(businessModal).display;
    businessModal.remove();
    return display;
  }), 'none', '普通业务弹窗在锁定时仍必须隐藏');
  await page.getByRole('dialog').getByRole('button', { name: /^取\s*消$/ }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.locator('input[autocomplete="current-password"]').fill('fixture-password');
  await page.getByRole('button', { name: /^登\s*录$/ }).click();
  await page.getByTestId('workspace-account').waitFor();
  assert.equal(await page.getByRole('textbox', { name: '模拟草稿', exact: true }).inputValue(), 'bob-retained-draft');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('fixture-loads')), bobLoads);
  assert.equal(await page.evaluate(() => Number(sessionStorage.getItem('fixture-initializations'))), 2);
  results.push('会话失效保留草稿、原账号重新登录恢复且不重建工作台通过');

  await page.evaluate(() => { window.__accountFixture.taskActive = true; });
  await page.getByTestId('workspace').getByRole('button', { name: /退\s*出$/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByText('模拟设备正在升级，请等待升级完成后退出。', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('workspace').isVisible(), true);
  assert.equal(await page.getByRole('textbox', { name: '模拟草稿', exact: true }).inputValue(), 'bob-retained-draft');
  assert.equal(await page.evaluate(() => window.__accountFixture.controller.getSnapshot().phase), 'authenticated');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('fixture-loads')), bobLoads);
  assert.equal(await page.evaluate(() => window.__accountMock.calls.includes('platform_logout')), false);
  await page.screenshot({ path: path.join(output, 'logout-task-guard.png'), fullPage: true });
  results.push('不可中断任务阻止退出，认证资格、工作台与草稿保持通过');
  await page.evaluate(async () => {
    window.__accountFixture.taskActive = false;
    window.__accountMock.status = { ...window.__accountMock.status, authenticated: false, expires_at: 0 };
    await window.__accountFixture.controller.poll();
  });
  await page.getByRole('button', { name: '退出并更换账号', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '退出并更换账号', exact: true }).click();
  await page.waitForFunction(previous => sessionStorage.getItem('fixture-loads') !== previous, bobLoads);
  await account().waitFor();
  assert.equal(await account().getAttribute('readonly'), null);
  results.push('锁定页确认可见、可取消及直接退出更换账号通过');
  assert.deepEqual(failures, [], '页面不应存在未捕获异常');
  const report = { results, pageErrors: failures, output };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) await fs.writeFile(path.join(output, 'failure.html'), await page.content()).catch(() => {});
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  const report = { results, pageErrors: failures, error: String(error), output };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
