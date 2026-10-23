import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 真实 React 页面与内存中的 IPC Promise；不运行原软件、不连接设备，
// 不使用真实凭据、网络配置或证书。
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const output = process.env.SECURITY_LOGIN_UI_OUTPUT || await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-security-login-'));
await fs.mkdir(output, { recursive: true });
const { chromium } = await (process.env.MSKDSP_PLAYWRIGHT_MODULE
  ? import(pathToFileURL(process.env.MSKDSP_PLAYWRIGHT_MODULE)) : import('playwright'));
const { createServer } = await import(pathToFileURL(root + '/node_modules/vite/dist/node/index.js'));
const { default: react } = await import(pathToFileURL(root + '/node_modules/@vitejs/plugin-react/dist/index.js'));
const entry = path.join(output, 'entry.tsx');
await fs.writeFile(entry, `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { darkTheme } from ${JSON.stringify('/@fs/' + root + '/src/theme/dark.ts')};
import SecurityAccess from ${JSON.stringify('/@fs/' + root + '/src/pages/SecurityAccess/index.tsx')};
function Fixture() {
  const [visible, setVisible] = useState(true);
  return <><nav><button onClick={() => setVisible(true)}>测试：访问页</button><button onClick={() => setVisible(false)}>测试：离开页面</button></nav>{visible && <SecurityAccess />}</>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfigProvider theme={darkTheme} locale={zhCN}><App><Fixture /></App></ConfigProvider></React.StrictMode>);
`);
const aliases = {};
for (const name of ['react-dom', 'react', 'antd', '@tauri-apps/api', '@tauri-apps/plugin-dialog', '@ant-design/icons']) aliases[name] = root + '/node_modules/' + name;
const server = await createServer({ configFile: false, root, plugins: [react(), {
  name: 'security-login-fixture', configureServer(vite) {
    vite.middlewares.use('/__security-login', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta charset="utf-8"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><style>body{margin:0;background:#1e1e1e;color:white;font-family:Microsoft YaHei,sans-serif}</style></head><body><div id="root"></div><script type="module" src=${JSON.stringify('/@fs/' + entry.replaceAll('\\', '/'))}></script></body></html>`);
    });
  },
}], resolve: { alias: aliases }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, output] }, watch: null, hmr: false }, logLevel: 'error' });
await server.listen();
const address = server.httpServer.address();
const url = `http://127.0.0.1:${address.port}/__security-login`;
let browser;
let page;
const failures = [];
const results = [];

async function openFixture(options = {}) {
  await page?.close();
  page = await browser.newPage({ viewport: { width: 1360, height: 1200 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => failures.push(error.message));
  await page.addInitScript(initial => {
    const mock = window.__securityLoginMock = {
      calls: [], login: [], checks: [],
      configured: initial.configured !== false,
      configureError: null,
      capabilities: { direct_available: true, remote_available: initial.remoteAvailable === true, password_change_available: false, reason: '虚构登录能力（fixture）' },
    };
    const profile = () => ({
      configured: mock.configured,
      client_certificate_path: mock.configured ? 'C:\\fixture\\client.p12' : null,
      trust_certificate_path: mock.configured ? 'C:\\fixture\\trust.pem' : null,
      server_name: mock.configured ? 'fixture-gateway' : null,
    });
    let callback = 0;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async (command, args) => {
        mock.calls.push({ command, args });
        if (command === 'get_vertical_security_access_capabilities') return { remote_ip_available: initial.remoteAvailable === true, remote_ip_reason: '远程网络通道待接入（fixture）' };
        if (command === 'remote_list_devices') return [{ device_id: 'fixture-dsp', display_name: '测试 DSP', online: true }];
        if (command === 'get_vertical_security_login_capabilities') return mock.capabilities;
        if (command === 'get_vertical_security_certificate_profile') return profile();
        if (command === 'plugin:dialog|open') return args.options.title.includes('PKCS12') ? 'C:\\fixture\\client.p12' : 'C:\\fixture\\trust.pem';
        if (command === 'configure_vertical_security_certificate_profile') {
          if (mock.configureError) throw new Error(mock.configureError);
          mock.configured = true;
          return profile();
        }
        if (command === 'login_vertical_security') return new Promise((resolve, reject) => mock.login.push({ resolve, reject, request: args.request }));
        if (command === 'check_vertical_security_access') return new Promise((resolve, reject) => mock.checks.push({ resolve, reject }));
        if (command === 'cancel_vertical_security_login' || command === 'logout_vertical_security' || command === 'close_vertical_security_access') return null;
        if (command === 'change_vertical_security_password') throw new Error('fixture 拒绝尚未接入的改密操作');
        return null;
      },
    };
  }, options);
  await page.goto(url, { waitUntil: 'commit', timeout: 15000 });
  await page.getByRole('button', { name: /登录纵密/ }).waitFor({ timeout: 45000 });
  await page.waitForFunction(() => window.__securityLoginMock.calls.some(call => call.command === 'get_vertical_security_certificate_profile'));
}

const loginButton = () => page.getByRole('button', { name: /登录纵密/ });
const username = () => page.getByLabel('纵密用户名', { exact: true });
const password = () => page.getByLabel('纵密密码', { exact: true });
async function fillLogin() {
  await username().fill('fixture-user');
  await password().fill('fixture-secret');
}
async function submitLogin() {
  await fillLogin();
  await loginButton().click();
  await page.waitForFunction(() => window.__securityLoginMock.login.length > 0);
  return page.evaluate(() => window.__securityLoginMock.login.at(-1).request);
}
async function resolveLogin(patch = {}) {
  await page.evaluate(change => {
    const pending = window.__securityLoginMock.login.shift();
    const request = pending.request;
    pending.resolve({
      request_id: request.request_id, state: 'authenticated', code: 'authenticated', message: 'fixture 登录成功',
      target_ip: '11.22.33.44', mode: request.mode, device_id: request.device_id ?? null,
      session_id: 'fixture-session', challenge_id: null, username: request.username, role: request.role,
      lock_seconds: null, last_login_at: '2026-01-01 01:02:03', device_version: 'fixture-version',
      steps: ['connect', 'tls', 'authenticate', 'initialize'].map(id => ({ id, name: id, state: 'success', message: 'fixture 阶段完成' })), ...change,
    });
  }, patch);
}
const calls = () => page.evaluate(() => window.__securityLoginMock.calls);
async function assertNoPersistedSecret() {
  assert.equal(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes('fixture-secret'))), false, '登录秘密不得写入浏览器存储');
}

try {
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'], ...(process.env.MSKDSP_BROWSER_EXECUTABLE ? { executablePath: process.env.MSKDSP_BROWSER_EXECUTABLE } : {}) });
  await openFixture({ configured: false });
  assert.equal(await username().inputValue(), '');
  assert.equal(await password().inputValue(), '');
  await fillLogin();
  assert.equal(await loginButton().isDisabled(), true, '未配置证书时不允许登录');
  await assertNoPersistedSecret();
  results.push('初始无预置账号秘密，证书未配置时禁止登录');

  // 证书控件实际经过原生文件选择器 IPC，返回的路径全部是虚构值。
  await page.locator('.security-login-certificate > summary').click();
  await page.getByRole('button', { name: /选择客户端证书/ }).click();
  await page.getByRole('button', { name: /选择信任证书/ }).click();
  await page.getByLabel('纵密证书口令', { exact: true }).fill('fixture-secret');
  await page.locator('.security-login-advanced > summary').click();
  await page.getByLabel('服务端证书名称', { exact: true }).fill('fixture-gateway');
  await page.getByRole('button', { name: /应用连接证书/ }).click();
  await page.waitForFunction(() => window.__securityLoginMock.calls.some(call => call.command === 'configure_vertical_security_certificate_profile'));
  assert.equal(await page.getByLabel('纵密证书口令', { exact: true }).inputValue(), '', '证书口令保存后立即清空');
  const certificateCall = (await calls()).find(call => call.command === 'configure_vertical_security_certificate_profile');
  assert.deepEqual(certificateCall.args.request, { client_certificate_path: 'C:\\fixture\\client.p12', trust_certificate_path: 'C:\\fixture\\trust.pem', certificate_password: 'fixture-secret', server_name: 'fixture-gateway' });
  await page.evaluate(() => { window.__securityLoginMock.configureError = 'fixture 证书格式错误'; });
  await page.getByLabel('纵密证书口令', { exact: true }).fill('fixture-secret');
  await page.getByRole('button', { name: /应用连接证书/ }).click();
  await page.getByText('证书配置失败，请检查格式、口令与装置信任证书。', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('纵密证书口令', { exact: true }).inputValue(), '', '证书配置失败也必须清空口令');
  await assertNoPersistedSecret();
  results.push('原生证书选择、保存契约与口令清除');

  await openFixture();
  await page.getByRole('button', { name: /检查直连/ }).click();
  await page.waitForFunction(() => window.__securityLoginMock.checks.length > 0);
  await page.evaluate(() => window.__securityLoginMock.checks.shift().resolve({ mode: 'direct', target_ip: '11.22.33.44', device_id: null, state: 'failed', session_id: null, steps: [{ id: 'round-trip', name: '往返响应', state: 'failed', message: 'fixture ICMP 无响应' }] }));
  await page.getByText('fixture ICMP 无响应', { exact: true }).waitFor();
  const request = await submitLogin();
  assert.equal(request.mode, 'direct');
  assert.equal(request.device_id, undefined);
  assert.equal(request.username, 'fixture-user');
  assert.equal(request.password, 'fixture-secret');
  assert.equal([1, 2, 3].includes(request.role), true);
  assert.equal(typeof request.request_id, 'string');
  assert.equal(request.request_id.length > 0, true);
  assert.equal(await password().inputValue(), '', '提交后清空密码');
  await resolveLogin();
  await page.getByText('fixture-version', { exact: true }).waitFor();
  assert.equal((await calls()).some(call => call.command === 'remote_select_device'), false);
  await assertNoPersistedSecret();
  await page.screenshot({ path: path.join(output, 'authenticated.png'), fullPage: true });
  results.push('ICMP 无响应仍允许认证，认证继承当前路径与身份且不切换全局设备');

  for (const [name, patch] of [
    ['missing-session', { session_id: null }],
    ['empty-session', { session_id: '' }],
    ['wrong-target', { target_ip: '192.0.2.44' }],
    ['wrong-mode', { mode: 'remote' }],
    ['wrong-request', { request_id: 'fixture-unrelated-request' }],
    ['wrong-user', { username: 'fixture-other-user' }],
    ['wrong-role', { role: 3 }],
    ['wrong-device', { device_id: 'fixture-other-dsp' }],
    ['missing-stages', { steps: [] }],
    ['failed-stage', { steps: ['connect', 'tls', 'authenticate', 'initialize'].map(id => ({ id, name: id, state: id === 'tls' ? 'failed' : 'success', message: 'fixture 阶段结果' })) }],
  ]) {
    await openFixture();
    const invalidRequest = await submitLogin();
    await resolveLogin(name === 'wrong-role' ? { ...patch, role: invalidRequest.role === 3 ? 1 : 3 } : patch);
    await page.getByText(/已拒绝建立纵密身份。/).waitFor();
    assert.equal(await page.getByText('fixture-version', { exact: true }).count(), 0, name + ' 不得显示登录成功');
    if (patch.session_id !== null && patch.session_id !== '') {
      await page.waitForFunction(() => window.__securityLoginMock.calls.some(call => call.command === 'logout_vertical_security'));
    }
  }
  results.push('认证成功必须有非空会话并匹配 request、目标、路径、设备、用户名和角色');

  for (const [state, code, text, extra] of [
    ['failed', 'invalid_credentials', 'fixture 用户名或密码错误', {}],
    ['unverified_response', 'unknown_response', 'fixture 未知设备应答，未确认登录', {}],
    ['failed', 'certificate_error', 'fixture 证书验证失败', {}],
    ['failed', 'account_locked', 'fixture 账户锁定，请等待', { lock_seconds: 120 }],
    ['unsupported', 'unavailable', 'fixture 登录能力暂不可用', {}],
  ]) {
    await openFixture();
    await submitLogin();
    await resolveLogin({ state, code, message: text, session_id: null, device_version: null, ...extra });
    await page.locator('.security-login-workbench .ant-alert-description').filter({ hasText: text }).waitFor();
    if (code === 'account_locked') await page.getByText('装置返回锁定时间：120 秒', { exact: true }).waitFor();
    assert.equal(await password().inputValue(), '');
    assert.equal(await page.getByText('fixture-version', { exact: true }).count(), 0);
  }
  results.push('错误凭据、未知应答、证书失败、锁定及不支持均显示真实失败信息');

  await openFixture();
  await submitLogin();
  await page.getByRole('button', { name: /取消登录/ }).click();
  await resolveLogin({ session_id: 'fixture-late-cancel-session' });
  await page.waitForFunction(() => window.__securityLoginMock.calls.some(call => call.command === 'logout_vertical_security' && call.args.sessionId === 'fixture-late-cancel-session'));
  assert.equal((await calls()).some(call => call.command === 'cancel_vertical_security_login'), true);
  assert.equal(await page.getByText('fixture-version', { exact: true }).count(), 0);
  results.push('取消认证后关闭迟到会话');

  await openFixture();
  await submitLogin();
  await page.getByRole('button', { name: '测试：离开页面', exact: true }).click();
  await resolveLogin({ session_id: 'fixture-late-unmount-session' });
  await page.waitForFunction(() => window.__securityLoginMock.calls.some(call => call.command === 'logout_vertical_security' && call.args.sessionId === 'fixture-late-unmount-session'));
  await page.getByRole('button', { name: '测试：访问页', exact: true }).click();
  await loginButton().waitFor();
  assert.equal(await page.getByText('fixture-version', { exact: true }).count(), 0);
  results.push('页面卸载后关闭迟到会话，新页面不继承旧认证结果');

  await openFixture();
  await fillLogin();
  await page.getByRole('combobox', { name: '纵密登录角色', exact: true }).click();
  await page.getByText('日志审计员', { exact: true }).click();
  assert.equal(await password().inputValue(), '', '切换角色清空密码');
  const auditRequest = await submitLogin();
  assert.equal(auditRequest.role, 3);
  await resolveLogin({ state: 'password_change_required', code: 'password_change_required', message: 'fixture 需要更改默认密码', session_id: null, challenge_id: 'fixture-challenge', device_version: null });
  await page.getByText('fixture 需要更改默认密码', { exact: true }).waitFor();
  assert.equal((await calls()).some(call => call.command === 'change_vertical_security_password'), false);
  assert.equal(await page.getByText('fixture-version', { exact: true }).count(), 0);
  results.push('角色切换清秘密并继承新角色，未接入改密能力不伪装完成');

  await openFixture();
  const expiredRequest = await submitLogin();
  await resolveLogin({ state: 'password_change_required', code: 'password_expired', message: 'fixture 密码已过期', username: null, role: null, session_id: null, challenge_id: null, device_version: null });
  await page.getByText('需要修改纵密密码', { exact: true }).waitFor();
  await page.getByText('密码修改流程尚未验证，当前不可修改', { exact: true }).waitFor();
  assert.equal(await page.getByText('已登录纵密装置', { exact: true }).count(), 0);
  assert.equal((await calls()).some(call => call.command === 'change_vertical_security_password'), false);
  await page.getByRole('button', { name: '取消并返回登录', exact: true }).click();
  await loginButton().waitFor();
  assert.equal((await calls()).some(call => call.command === 'cancel_vertical_security_login' && call.args.requestId === expiredRequest.request_id), true);
  results.push('真实过期应答缺少身份与 challenge 时只显示待处理，取消按原请求清理');

  await openFixture({ remoteAvailable: true });
  await page.locator('.ant-segmented-item').filter({ hasText: '平台远程' }).click();
  await page.getByRole('combobox', { name: '目标 DSP', exact: true }).click();
  await page.getByText('测试 DSP · 在线', { exact: true }).click();
  const remoteRequest = await submitLogin();
  assert.equal(remoteRequest.mode, 'remote');
  assert.equal(remoteRequest.device_id, 'fixture-dsp');
  await resolveLogin();
  await page.getByText('fixture-version', { exact: true }).waitFor();
  assert.equal((await calls()).some(call => call.command === 'remote_select_device'), false);
  results.push('虚构远程能力可用时认证沿当前 DSP 路径，独立会话不切换全局目标');

  await openFixture();
  await page.locator('.ant-segmented-item').filter({ hasText: '平台远程' }).click();
  await fillLogin();
  const device = page.getByRole('combobox', { name: '目标 DSP', exact: true });
  await device.click();
  await page.getByText('测试 DSP · 在线', { exact: true }).click();
  assert.equal(await loginButton().isDisabled(), true);
  assert.equal((await calls()).some(call => call.command === 'login_vertical_security' || call.command === 'remote_select_device'), false);
  await page.screenshot({ path: path.join(output, 'remote-unavailable.png'), fullPage: true });
  results.push('远程能力未接入时禁止登录，不发起认证或改动全局目标');

  assert.deepEqual(failures, []);
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ results, failures }, null, 2));
  console.log(JSON.stringify({ output, results }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ failures, url: page?.url() }));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
