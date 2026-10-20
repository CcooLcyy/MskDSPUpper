import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const output = process.env.SSH_UI_TEST_OUTPUT || await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-ssh-browser-'));
await fs.mkdir(output, { recursive: true });
const { createServer } = await import(pathToFileURL(root + '/node_modules/vite/dist/node/index.js'));
const { default: react } = await import(pathToFileURL(root + '/node_modules/@vitejs/plugin-react/dist/index.js'));
// 复用已有浏览器测试运行时，不安装或加入产品依赖。
const playwright = process.env.MSKDSP_PLAYWRIGHT_MODULE;
const { chromium } = await (playwright ? import(pathToFileURL(playwright)) : import('playwright'));
const componentPath = root + '/src/components/remote/RemoteAccessPanel.tsx';
const snapshot = path.join(output, 'original-RemoteAccessPanel.tsx');
if (process.env.SSH_UI_BASELINE) {
  let source = execFileSync('git', ['show', process.env.SSH_UI_BASELINE + ':src/components/remote/RemoteAccessPanel.tsx'], { cwd: root, encoding: 'utf8' });
  source = source.replace(/(['"])\.\.\/\.\.\/utils\/([^'"]+)\1/g, (_match, _quote, name) =>
    JSON.stringify('/@fs/' + root + '/src/utils/' + name + (path.posix.extname(name) ? '' : '.ts')));
  await fs.writeFile(snapshot, source);
}
const component = Boolean(process.env.SSH_UI_BASELINE) ? snapshot.replaceAll('\\', '/') : componentPath;
const entry = path.join(output, 'entry.tsx');
await fs.writeFile(entry, `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport RemoteAccessPanel from ${JSON.stringify('/@fs/' + component)};\nconst callback=()=>{}; const connected=async()=>{};\ncreateRoot(document.getElementById('root')!).render(<React.StrictMode><RemoteAccessPanel directAddress="192.0.2.1:17000" onModeChange={callback} onConnected={connected}/></React.StrictMode>);\n`);
const aliases = {};
for (const name of ['react-dom', 'react', 'antd', '@tauri-apps/api', '@xterm/xterm', '@xterm/addon-fit']) aliases[name] = root + '/node_modules/' + name;
const serveEntry = { name: 'ssh-regression-entry', configureServer(server) { server.middlewares.use('/__ssh-regression', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><meta charset="utf-8"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src=${JSON.stringify('/@fs/' + entry.replaceAll('\\', '/'))}></script></body></html>`);
}); } };
const server = await createServer({ configFile: false, root, plugins: [react(), serveEntry], resolve: { alias: aliases },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root, output] } }, logLevel: 'error' });
await server.listen();
const address = server.httpServer.address();
let browser;
let page;
const failures = [];
const results = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.env.MSKDSP_BROWSER_EXECUTABLE ? { executablePath: process.env.MSKDSP_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => failures.push(error.message));
  await page.addInitScript(() => {
    const state = window.__sshMock = { calls: [], events: null, resolveOpen: null, rejectOpen: null, resolveTrust: null, deferTrust: false };
    let next = 0;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++next, unregisterCallback: () => {},
      invoke: async (command, args) => {
        state.calls.push({ command, sessionId: args?.sessionId });
        if (command === 'remote_list_devices') return [{ device_id: 'fixture-device', display_name: '测试设备', online: true, allow_grpc: true, allow_ssh: true, services: ['ModuleManager', 'ssh'] }];
        if (command === 'remote_connection_status') return { remote: true, device_id: 'fixture-device', active: true };
        if (command === 'remote_ssh_open') {
          state.events = args.events;
          return new Promise((resolve, reject) => { state.resolveOpen = resolve; state.rejectOpen = reject; });
        }
        if (command === 'remote_ssh_trust' && state.deferTrust) return new Promise(resolve => { state.resolveTrust = resolve; });
        return null;
      },
    };
  });
  await page.goto(`http://127.0.0.1:${address.port}/__ssh-regression`);
  // 真实React与AntD延迟挂载，IPC全部使用虚构设备和凭据。
  await page.getByRole('button', { name: 'SSH 终端', exact: true }).click();
  await page.locator('.xterm').waitFor({ timeout: 8000 });
  assert.equal(await page.locator('.xterm').count(), 1, '首次延迟挂载必须创建一个终端');
  results.push('首次延迟挂载与StrictMode初始化通过');
  await page.getByRole('textbox', { name: 'SSH 账号', exact: true }).fill('fixture-user');
  await page.getByLabel('SSH 密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /登\s*录/, exact: true }).click();
  await page.waitForFunction(() => window.__sshMock.calls.some(call => call.command === 'remote_ssh_open'));
  await page.evaluate(() => window.__sshMock.events.onmessage({ type: 'host_key', device_id: 'fixture-device', fingerprint: 'SHA256:fixture-old' }));
  await page.getByText('SHA256:fixture-old', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '已核对，信任此设备', exact: true }).isDisabled(), true, '会话ID未绑定时不可吞掉信任点击');
  await page.evaluate(() => window.__sshMock.resolveOpen('fixture-session-1'));
  const trust = page.getByRole('button', { name: '已核对，信任此设备', exact: true });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent?.includes('信任此设备') && !button.disabled));
  await trust.click();
  await page.waitForFunction(() => window.__sshMock.calls.some(call => call.command === 'remote_ssh_trust' && call.sessionId === 'fixture-session-1'));
  await page.evaluate(() => window.__sshMock.events.onmessage({ type: 'connected' }));
  await page.getByRole('button', { name: /断\s*开/, exact: true }).waitFor();
  results.push('登录触发、早到指纹等待ID绑定及确认通过');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.xterm').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'SSH 终端', exact: true }).click();
  await page.locator('.xterm').waitFor();
  assert.equal(await page.locator('.xterm').count(), 1);
  assert.equal(await page.getByLabel('SSH 密码', { exact: true }).inputValue(), '');
  results.push('关闭释放、重新打开与清除密码通过');
  await page.getByLabel('SSH 密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /登\s*录/, exact: true }).click();
  await page.waitForFunction(() => window.__sshMock.calls.filter(call => call.command === 'remote_ssh_open').length === 2);
  await page.evaluate(() => window.__sshMock.rejectOpen('测试SSH目标不可达'));
  await page.getByText(/测试SSH目标不可达/).first().waitFor();
  await page.screenshot({ path: path.join(output, 'ssh-error.png'), fullPage: true });
  results.push('连接失败持续可见反馈通过');
  // 旧会话的确认完成不得清除新会话的指纹。
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.xterm').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'SSH 终端', exact: true }).click();
  await page.locator('.xterm').waitFor();
  await page.getByLabel('SSH 密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /登\s*录/, exact: true }).click();
  await page.waitForFunction(() => window.__sshMock.calls.filter(call => call.command === 'remote_ssh_open').length === 3);
  await page.evaluate(() => {
    window.__sshMock.deferTrust = true;
    window.__sshMock.resolveOpen('fixture-session-old');
    window.__sshMock.events.onmessage({ type: 'host_key', device_id: 'fixture-device', fingerprint: 'SHA256:pending-old' });
  });
  await page.getByText('SHA256:pending-old', { exact: true }).waitFor();
  await page.getByRole('button', { name: '已核对，信任此设备', exact: true }).click();
  await page.waitForFunction(() => window.__sshMock.resolveTrust !== null);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.xterm').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'SSH 终端', exact: true }).click();
  await page.locator('.xterm').waitFor();
  await page.getByLabel('SSH 密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /登\s*录/, exact: true }).click();
  await page.waitForFunction(() => window.__sshMock.calls.filter(call => call.command === 'remote_ssh_open').length === 4);
  await page.evaluate(() => {
    window.__sshMock.resolveOpen('fixture-session-new');
    window.__sshMock.events.onmessage({ type: 'host_key', device_id: 'fixture-device', fingerprint: 'SHA256:current-new' });
  });
  await page.getByText('SHA256:current-new', { exact: true }).waitFor();
  await page.evaluate(async () => {
    window.__sshMock.resolveTrust();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  assert.equal(await page.getByText('SHA256:current-new', { exact: true }).isVisible(), true);
  results.push('旧会话确认回调不会覆盖新指纹通过');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.xterm').waitFor({ state: 'detached' });
  // 强制组件观察器初始化失败，错误必须可见且可通过关闭重开恢复。
  await page.evaluate(() => {
    const Original = window.ResizeObserver;
    window.__sshMock.originalResizeObserver = Original;
    window.ResizeObserver = class extends Original {
      observe(target, options) {
        if (target instanceof HTMLElement && target.style.height === '460px' && target.querySelector(':scope > .xterm')) {
          throw new Error('fixture-init-error');
        }
        return super.observe(target, options);
      }
    };
  });
  await page.getByRole('button', { name: 'SSH 终端', exact: true }).click();
  await page.getByText('终端初始化失败，请关闭窗口后重试', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /登\s*录/, exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => { window.ResizeObserver = window.__sshMock.originalResizeObserver; });
  await page.getByRole('button', { name: 'SSH 终端', exact: true }).click();
  await page.getByText('终端已就绪，请登录', { exact: true }).waitFor();
  await page.locator('.xterm').waitFor();
  results.push('初始化失败反馈及关闭重开恢复通过');
  assert.deepEqual(failures, [], '页面不应存在未捕获异常');
  const report = { results, pageErrors: failures, output };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  const report = { results, pageErrors: failures, error: String(error), output };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally { await browser?.close(); await server.close(); }
