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
import SecurityLoginPage from ${JSON.stringify('/@fs/' + root + '/src/pages/SecurityLogin/index.tsx')};
function Fixture() {
  const [visible, setVisible] = useState(true);
  return <><nav><button onClick={() => setVisible(true)}>测试：登录页</button><button onClick={() => setVisible(false)}>测试：离开页面</button></nav>{visible && <SecurityLoginPage />}</>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfigProvider theme={darkTheme} locale={zhCN}><App><Fixture /></App></ConfigProvider></React.StrictMode>);
`);
const aliases = {};
for (const name of ['react-dom', 'react', 'antd', '@tauri-apps/api', '@tauri-apps/plugin-dialog', '@ant-design/icons']) aliases[name] = root + '/node_modules/' + name;
const server = await createServer({ configFile: false, root, cacheDir: path.join(output, '.vite'), plugins: [react(), {
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
      calls: [], login: [], checks: [], changes: [], activeChecks: [],
      connectionActive: true, deferActiveCheck: false, deferLogout: false, logouts: [],
      locks: (JSON.parse(sessionStorage.getItem('fixture-login-locks') || 'null') || initial.locks || []).map(lock => ({ ...lock, deadline: lock.deadline ?? Date.now() + lock.lock_seconds * 1000 })),
      configured: initial.configured !== false,
      configureError: null,
      capabilities: { direct_available: true, remote_available: initial.remoteAvailable === true, password_change_available: initial.passwordChangeAvailable === true, reason: '虚构登录能力（fixture）' },
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
        if (command === 'get_vertical_security_login_locks') return mock.locks.map(({ deadline, ...lock }) => ({ ...lock, lock_seconds: Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) })).filter(lock => lock.lock_seconds > 0);
        if (command === 'get_vertical_security_certificate_profile') return profile();
        if (command === 'plugin:dialog|open') return args.options.title.includes('PKCS12') ? 'C:\\fixture\\client.p12' : 'C:\\fixture\\trust.pem';
        if (command === 'configure_vertical_security_certificate_profile') {
          if (mock.configureError) throw new Error(mock.configureError);
          mock.configured = true;
          return profile();
        }
        if (command === 'login_vertical_security_one_click') return new Promise((resolve, reject) => mock.login.push({ resolve, reject, request: args.request }));
        if (command === 'check_vertical_security_access') return new Promise((resolve, reject) => mock.checks.push({ resolve, reject }));
        if (command === 'logout_vertical_security') return mock.deferLogout ? new Promise((resolve, reject) => mock.logouts.push({ resolve, reject })) : null;
        if (command === 'cancel_vertical_security_login' || command === 'close_vertical_security_access') return null;
        if (command === 'change_vertical_security_password') return new Promise((resolve, reject) => mock.changes.push({ resolve, reject, request: args.request }));
        if (command === 'is_vertical_security_login_active') return mock.deferActiveCheck ? new Promise((resolve, reject) => mock.activeChecks.push({ resolve, reject, connectionId: args.connectionId })) : mock.connectionActive;
        return null;
      },
    };
  }, options);
  await page.goto(url, { waitUntil: 'commit', timeout: 15000 });
  await page.getByRole('button', { name: /登录纵密/ }).waitFor({ timeout: 45000 });
  await page.waitForFunction(() => window.__securityLoginMock.calls.some(call => call.command === 'get_vertical_security_certificate_profile'));
  assert.equal((await page.evaluate(() => window.__securityLoginMock.calls)).some(call => /^(get_vertical_security_access_capabilities|check_vertical_security_access|configure_vertical_security_access_path)$/.test(call.command)), false, '登录页不加载网络检查能力、不检查或配置访问通路');
  assert.equal(await page.getByRole('button', { name: /检查直连|检查远程通路|配置纵密访问通路/ }).count(), 0, '登录页不显示网络检查或访问通路配置');
  assert.equal(await page.getByRole('heading', { name: '网络连接检查', exact: true }).count(), 0);
  await page.getByRole('heading', { name: '纵密登录', level: 1, exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1, '独立登录页只有一个主标题');
}

const loginButton = () => page.getByRole('button', { name: /登录纵密/ });
async function assertNoCredentialInputs() {
  for (const label of ['纵密用户名', '纵密密码', '纵密新密码', '确认纵密新密码']) {
    assert.equal(await page.getByLabel(label, { exact: true }).count(), 0, '一键登录不要求输入凭据');
  }
}
async function submitLogin() {
  await assertNoCredentialInputs();
  await loginButton().click();
  await page.waitForFunction(() => window.__securityLoginMock.login.length > 0);
  const request = await page.evaluate(() => window.__securityLoginMock.login.at(-1).request);
  assert.equal('username' in request, false, '前端不发送用户名');
  assert.equal('password' in request, false, '前端不发送密码');
  return request;
}
async function resolveLogin(patch = {}) {
  await page.evaluate(change => {
    const pending = window.__securityLoginMock.login.shift();
    const request = pending.request;
    if (change.code === 'account_locked' && change.lock_seconds > 0) {
      const mock = window.__securityLoginMock;
      mock.locks = mock.locks.filter(lock => lock.username !== (request.role === 1 ? 'admin' : 'secure') || lock.mode !== request.mode || lock.device_id !== (request.device_id ?? null));
      mock.locks.push({ mode: request.mode, device_id: request.device_id ?? null, username: request.role === 1 ? 'admin' : 'secure', deadline: Date.now() + change.lock_seconds * 1000 });
      sessionStorage.setItem('fixture-login-locks', JSON.stringify(mock.locks));
    }
    pending.resolve({
      request_id: request.request_id, state: 'authenticated', code: 'authenticated', message: 'fixture 登录成功',
      target_ip: '11.22.33.44', mode: request.mode, device_id: request.device_id ?? null,
      session_id: 'fixture-session', challenge_id: null, username: request.role === 1 ? 'admin' : 'secure', role: request.role,
      lock_seconds: null, last_login_at: '2026-01-01 01:02:03', device_version: 'fixture-version',
      steps: ['connect', 'tls', 'authenticate', 'initialize'].map(id => ({ id, name: id, state: 'success', message: 'fixture 阶段完成' })), ...change,
    });
  }, patch);
}
async function requirePasswordChange(patch = {}) {
  await resolveLogin({ state: 'password_change_required', code: 'default_password', message: 'fixture 默认密码必须修改', session_id: null, challenge_id: 'fixture-challenge', device_version: null,
    steps: ['connect', 'tls', 'authenticate', 'initialize'].map(id => ({ id, name: id, state: id === 'initialize' ? 'pending' : 'success', message: id === 'initialize' ? '修改密码后重新登录，再读取装置信息' : 'fixture 阶段完成' })), ...patch });
}
const calls = () => page.evaluate(() => window.__securityLoginMock.calls);
async function assertNoPersistedSecret() {
  assert.equal(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes('fixture-secret'))), false, '登录秘密不得写入浏览器存储');
}

try {
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'], ...(process.env.MSKDSP_BROWSER_EXECUTABLE ? { executablePath: process.env.MSKDSP_BROWSER_EXECUTABLE } : {}) });
  // 切页只保留已完成认证的会话，返回时先确认连接仍有效，不重复发送认证材料。
  await openFixture();
  await submitLogin();
  await resolveLogin();
  await page.getByText('fixture-version', { exact: true }).waitFor();
  await page.getByRole('button', { name: '测试：离开页面', exact: true }).click();
  assert.equal(await page.getByText('fixture-version', { exact: true }).count(), 0);
  assert.equal((await calls()).some(call => call.command === 'logout_vertical_security'), false, '已认证会话切页不能退出登录');
  await page.evaluate(() => { window.__securityLoginMock.deferActiveCheck = true; });
  await page.getByRole('button', { name: '测试：登录页', exact: true }).click();
  await page.waitForFunction(() => window.__securityLoginMock.activeChecks.length > 0);
  assert.equal(await page.getByText('fixture-version', { exact: true }).count(), 0, '活性查询完成前不能展示缓存身份');
  await page.evaluate(() => { for (const check of window.__securityLoginMock.activeChecks.splice(0)) check.resolve(true); window.__securityLoginMock.deferActiveCheck = false; });
  await page.getByText('fixture-version', { exact: true }).waitFor();
  assert.equal((await calls()).filter(call => call.command === 'login_vertical_security_one_click').length, 1, '返回页面不自动重新认证或续期');
  assert.equal((await calls()).filter(call => call.command === 'is_vertical_security_login_active').every(call => call.args.connectionId === 'fixture-session'), true);
  await assertNoPersistedSecret();
  await page.screenshot({ path: path.join(output, 'session-restored.png'), fullPage: true });
  await page.getByRole('button', { name: /退出纵密登录/ }).click();
  await loginButton().waitFor();
  await page.getByRole('button', { name: '测试：离开页面', exact: true }).click();
  await page.getByRole('button', { name: '测试：登录页', exact: true }).click();
  await loginButton().waitFor();
  assert.equal(await page.getByText('fixture-version', { exact: true }).count(), 0);
  assert.equal((await calls()).filter(call => call.command === 'logout_vertical_security' && call.args.sessionId === 'fixture-session').length, 1);
  results.push('已认证会话跨页保留、返回先检查活性、主动退出后不恢复且不重复认证');

  // 返回页面时的即时查询必须先于缓存身份展示，不能等待下一轮定时检查。
  for (const failure of ['disconnected', 'query-error']) {
    await openFixture();
    await submitLogin();
    await resolveLogin();
    await page.getByText('fixture-version', { exact: true }).waitFor();
    await page.getByRole('button', { name: '测试：离开页面', exact: true }).click();
    await page.evaluate(() => { window.__securityLoginMock.deferActiveCheck = true; });
    await page.getByRole('button', { name: '测试：登录页', exact: true }).click();
    await page.waitForFunction(() => window.__securityLoginMock.activeChecks.length > 0);
    assert.equal(await page.getByText('fixture-version', { exact: true }).count(), 0);
    await page.evaluate(kind => {
      for (const check of window.__securityLoginMock.activeChecks.splice(0)) {
        if (kind === 'query-error') check.reject(new Error('fixture 返回页面查询失败'));
        else check.resolve(false);
      }
      window.__securityLoginMock.deferActiveCheck = false;
      window.__securityLoginMock.connectionActive = false;
    }, failure);
    await loginButton().waitFor();
    assert.equal(await page.getByText('fixture-version', { exact: true }).count(), 0);
    assert.equal((await calls()).filter(call => call.command === 'login_vertical_security_one_click').length, 1);
  }
  results.push('返回页面即时查询失败或连接已失效时，不展示缓存身份且不自动认证');

  // 登录页不在场时仍检查真实连接；断线和查询失败均不保留可恢复身份。
  for (const failure of ['disconnected', 'query-error']) {
    await openFixture();
    await submitLogin();
    await resolveLogin();
    await page.getByText('fixture-version', { exact: true }).waitFor();
    await page.getByRole('button', { name: '测试：离开页面', exact: true }).click();
    await page.evaluate(() => { window.__securityLoginMock.deferActiveCheck = true; });
    await page.waitForFunction(() => window.__securityLoginMock.activeChecks.length > 0);
    await page.evaluate(kind => {
      for (const check of window.__securityLoginMock.activeChecks.splice(0)) {
        if (kind === 'query-error') check.reject(new Error('fixture 状态查询失败'));
        else check.resolve(false);
      }
      window.__securityLoginMock.deferActiveCheck = false;
      window.__securityLoginMock.connectionActive = false;
    }, failure);
    await page.waitForFunction(() => window.__securityLoginMock.calls.some(call => call.command === 'logout_vertical_security' && call.args.sessionId === 'fixture-session'));
    await page.getByRole('button', { name: '测试：登录页', exact: true }).click();
    await loginButton().waitFor();
    assert.equal(await page.getByText('fixture-version', { exact: true }).count(), 0);
    assert.equal((await calls()).filter(call => call.command === 'login_vertical_security_one_click').length, 1);
  }
  results.push('离页后仍检测断线和查询失败，失效会话无法恢复');

  // 主动退出请求的结果不依赖原页面仍然挂载。
  await openFixture();
  await submitLogin();
  await resolveLogin();
  await page.getByText('fixture-version', { exact: true }).waitFor();
  await page.evaluate(() => { window.__securityLoginMock.deferLogout = true; });
  await page.getByRole('button', { name: /退出纵密登录/ }).click();
  await page.waitForFunction(() => window.__securityLoginMock.logouts.length > 0);
  await page.getByRole('button', { name: '测试：离开页面', exact: true }).click();
  await page.evaluate(() => { for (const pending of window.__securityLoginMock.logouts.splice(0)) pending.resolve(null); window.__securityLoginMock.deferLogout = false; });
  await page.getByRole('button', { name: '测试：登录页', exact: true }).click();
  await loginButton().waitFor();
  assert.equal(await page.getByText('fixture-version', { exact: true }).count(), 0);
  results.push('退出请求期间切页，迟到成功仍撤销共享身份');

  // 自动改密与重新认证也属于未完成的一键请求，离页后必须取消。
  await openFixture();
  const pendingIdentity = await submitLogin();
  await page.getByRole('button', { name: '测试：离开页面', exact: true }).click();
  await page.waitForFunction(requestId => window.__securityLoginMock.calls.some(call => call.command === 'cancel_vertical_security_login' && call.args.requestId === requestId), pendingIdentity.request_id);
  await resolveLogin({ session_id: 'fixture-late-navigation-session' });
  await page.waitForFunction(() => window.__securityLoginMock.calls.some(call => call.command === 'logout_vertical_security' && call.args.sessionId === 'fixture-late-navigation-session'));
  await page.getByRole('button', { name: '测试：登录页', exact: true }).click();
  await loginButton().waitFor();
  await assertNoCredentialInputs();
  results.push('切页取消未完成的一键请求并清理迟到会话');

  if (!process.argv.includes('--session-only')) {
  await openFixture({ configured: false });
  // 默认选择系统管理员，只有显式点击登录按钮才发起认证。
  assert.equal(await page.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: '纵密登录角色', exact: true }) }).innerText(), '系统管理员');
  assert.equal((await calls()).some(call => call.command === 'login_vertical_security_one_click'), false, '默认角色不触发自动登录');
  await assertNoCredentialInputs();
  await assertNoCredentialInputs();
  await assertNoCredentialInputs();
  assert.equal(await loginButton().isDisabled(), true, '未配置证书时不允许登录');
  await assertNoPersistedSecret();
  results.push('初始无凭据输入框，证书未配置时禁止登录');

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
  assert.equal((await calls()).some(call => call.command === 'check_vertical_security_access'), false, '登录无需先执行 ICMP 检查');
  await page.screenshot({ path: path.join(output, 'login-page.png'), fullPage: true });
  const request = await submitLogin();
  assert.equal(request.mode, 'direct');
  assert.equal(request.device_id, undefined);
  assert.deepEqual(Object.keys(request).sort(), ['mode', 'request_id', 'role']);
  assert.equal(request.role, 1, '未切换角色时使用系统管理员进行认证');
  assert.equal(typeof request.request_id, 'string');
  assert.equal(request.request_id.length > 0, true);
  await assertNoCredentialInputs();
  await resolveLogin();
  await page.getByText('fixture-version', { exact: true }).waitFor();
  assert.equal((await calls()).some(call => call.command === 'remote_select_device'), false);
  await assertNoPersistedSecret();
  await page.screenshot({ path: path.join(output, 'authenticated.png'), fullPage: true });
  results.push('独立登录不执行或依赖 ICMP 检查，认证继承当前路径与身份且不切换全局设备');

  for (const [name, patch] of [
    ['missing-session', { session_id: null }],
    ['empty-session', { session_id: '' }],
    ['wrong-target', { target_ip: '192.0.2.44' }],
    ['wrong-mode', { mode: 'remote' }],
    ['wrong-request', { request_id: 'fixture-unrelated-request' }],
    ['wrong-user', { username: 'fixture-other-user' }],
    ['missing-user', { username: null }],
    ['missing-role', { role: null }],
    ['invalid-old-certificate', { certificate_group: 'old', legacy_compatibility: false }],
    ['invalid-new-certificate', { certificate_group: 'new', legacy_compatibility: true }],
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
    ['failed', 'password_change_unconfirmed', 'fixture 改密结果未确认，请核实装置状态', {}],
    ['failed', 'account_locked', 'fixture 账户锁定，请等待', { lock_seconds: 120 }],
    ['unsupported', 'unavailable', 'fixture 登录能力暂不可用', {}],
  ]) {
    await openFixture();
    await submitLogin();
    await resolveLogin({ state, code, message: text, session_id: null, device_version: null, ...extra });
    if (code === 'account_locked') await page.getByText(/纵密账号 admin 已锁定，剩余 \d{2}:\d{2}/).waitFor();
    else await page.locator('.security-login-workbench .ant-alert-description').filter({ hasText: text }).waitFor();
    await assertNoCredentialInputs();
    assert.equal(await page.getByText('fixture-version', { exact: true }).count(), 0);
    assert.equal((await calls()).filter(call => call.command === 'login_vertical_security_one_click').length, 1, '前端不能自行重试');
    assert.equal((await calls()).some(call => call.command === 'change_vertical_security_password'), false);
  }
  results.push('错误凭据、未知应答、证书失败、锁定及不支持均显示真实失败信息');

  await openFixture();
  await submitLogin();
  await page.evaluate(() => window.__securityLoginMock.login.shift().reject(new Error('fixture IPC 中断')));
  await page.getByText('纵密登录失败，请检查连接与装置状态后手动重试。', { exact: true }).waitFor();
  assert.equal((await calls()).filter(call => call.command === 'login_vertical_security_one_click').length, 1);
  assert.equal(await page.getByText('已登录纵密装置', { exact: true }).count(), 0);
  results.push('一键请求异常停止，前端不自行追加认证');

  // 锁定限制按后台固定用户名计算，切页或切回角色不能清掉等待。
  await openFixture();
  await submitLogin();
  await resolveLogin({ state: 'failed', code: 'account_locked', message: 'fixture 账号已锁定', session_id: null, lock_seconds: 120 });
  await page.getByText(/纵密账号 admin 已锁定，剩余/).waitFor();
  assert.equal(await loginButton().isDisabled(), true);
  await page.getByRole('button', { name: '测试：离开页面', exact: true }).click();
  await page.getByRole('button', { name: '测试：登录页', exact: true }).click();
  await page.getByText(/纵密账号 admin 已锁定，剩余/).waitFor();
  assert.equal(await loginButton().isDisabled(), true);
  await page.getByRole('combobox', { name: '纵密登录角色' }).click();
  await page.getByText('安全操作员', { exact: true }).click();
  assert.equal(await loginButton().isEnabled(), true, '管理员锁定不能扩大到安全操作员');
  await page.getByRole('combobox', { name: '纵密登录角色' }).click();
  await page.getByText('系统管理员', { exact: true }).click();
  assert.equal(await loginButton().isDisabled(), true, '切回原账号仍受锁定限制');
  assert.equal((await calls()).filter(call => call.command === 'login_vertical_security_one_click').length, 1);
  await page.reload();
  await page.getByText(/纵密账号 admin 已锁定，剩余/).waitFor();
  assert.equal(await loginButton().isDisabled(), true, '刷新页面后从后端恢复锁定');
  await assertNoPersistedSecret();
  await page.screenshot({ path: path.join(output, 'account-lock-countdown.png'), fullPage: true });
  results.push('固定账号锁定跨页、刷新和切换角色仍生效，其他账号不受影响');

  // 倒计时结束仅恢复手动提交；下一次装置锁定应答重新更新等待时间。
  await openFixture({ locks: [{ mode: 'direct', device_id: null, username: 'admin', lock_seconds: 3 }] });
  await assertNoCredentialInputs();
  await page.getByText('纵密账号 admin 的锁定等待时间已结束', { exact: true }).waitFor();
  assert.equal(await loginButton().isEnabled(), true);
  assert.equal((await calls()).filter(call => call.command === 'login_vertical_security_one_click').length, 0, '到期不能自动认证');
  await loginButton().click();
  await page.waitForFunction(() => window.__securityLoginMock.login.length === 1);
  await resolveLogin({ state: 'failed', code: 'account_locked', message: 'fixture 仍然锁定', session_id: null, lock_seconds: 60 });
  await page.getByText(/纵密账号 admin 已锁定，剩余/).waitFor();
  assert.equal(await loginButton().isDisabled(), true);
  results.push('倒计时到期恢复手动登录但不自动认证，最新锁定应答重新限制提交');

  for (const lockSeconds of [null, 0]) {
    await openFixture();
    await submitLogin();
    await resolveLogin({ state: 'failed', code: 'account_locked', message: 'fixture 锁定应答', session_id: null, lock_seconds: lockSeconds });
    await page.getByText(lockSeconds === null ? '装置未提供有效剩余时间，无法显示倒计时。' : '装置返回剩余 0 秒，可手动重新尝试登录。', { exact: true }).waitFor();
      assert.equal(await loginButton().isEnabled(), true, '不能虚构锁定时长');
  }
  results.push('缺失或零秒锁定应答保留提示，不虚构倒计时');

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
  await page.getByRole('button', { name: '测试：登录页', exact: true }).click();
  await loginButton().waitFor();
  assert.equal(await page.getByText('fixture-version', { exact: true }).count(), 0);
  results.push('页面卸载后关闭迟到会话，新页面不继承旧认证结果');

  // 一键流程对前端只返回最终结果；漏出的改密挑战必须拒绝并关闭。
  for (const patch of [{}, { username: null, role: null, challenge_id: null }, { code: 'unknown' }]) {
    await openFixture();
    const identity = await submitLogin();
    await requirePasswordChange(patch);
    await page.getByText('一键登录未完成密码处理，当前账号尚未登录。', { exact: true }).waitFor();
    await assertNoCredentialInputs();
    assert.equal(await page.getByText('已登录纵密装置', { exact: true }).count(), 0);
    const id = patch.challenge_id === null ? identity.request_id : 'fixture-challenge';
    assert.equal((await calls()).some(call => call.command === 'cancel_vertical_security_login' && call.args.requestId === id), true);
    assert.equal((await calls()).some(call => call.command === 'change_vertical_security_password'), false);
  }
  results.push('后台未完成改密的应答拒绝建立身份并清理，不暴露手动改密表单');

  await openFixture();
  await page.getByRole('combobox', { name: '纵密登录角色', exact: true }).click();
  assert.equal(await page.getByRole('option', { name: '日志审计员', exact: true }).count(), 0);
  assert.equal(await page.locator('.ant-select-item-option').count(), 2);
  await page.getByText('安全操作员', { exact: true }).click();
  const operatorRequest = await submitLogin();
  assert.equal(operatorRequest.role, 2);
  await resolveLogin();
  await page.getByText('已登录纵密装置', { exact: true }).waitFor();
  assert.equal(await page.locator('.security-admin-session').getByText('secure', { exact: true }).count(), 1);
  results.push('仅保留两种身份，安全操作员使用固定账号建立会话');

  // 同步连续点击也不能生成并发 IPC；自动改密和重登都在同一请求中完成。
  await openFixture();
  await loginButton().evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => window.__securityLoginMock.login.length === 1);
  assert.equal((await calls()).filter(call => call.command === 'login_vertical_security_one_click').length, 1);
  assert.equal(await loginButton().isDisabled(), true);
  assert.equal(await page.getByRole('combobox', { name: '纵密登录角色' }).isDisabled(), true);
  await resolveLogin({ message: 'fixture 自动改密并重新认证完成' });
  await page.getByText('fixture-version', { exact: true }).waitFor();
  assert.equal((await calls()).filter(call => call.command === 'login_vertical_security_one_click').length, 1);
  assert.equal((await calls()).some(call => call.command === 'change_vertical_security_password'), false);
  results.push('同步双击只产生一个 IPC，请求完成后直接进入业务会话');

  for (const leave of ['cancel', 'unmount']) {
    await openFixture();
    await submitLogin();
    await page.getByRole('button', { name: leave === 'cancel' ? /取消登录/ : '测试：离开页面' }).click();
    await requirePasswordChange({ challenge_id: 'fixture-late-challenge' });
    await page.waitForFunction(() => window.__securityLoginMock.calls.some(call => call.command === 'cancel_vertical_security_login' && call.args.requestId === 'fixture-late-challenge'));
    await assertNoCredentialInputs();
  }
  results.push('取消或卸载后迟到的异常改密挑战仍按标识清理');

  for (const outcome of ['disconnected', 'query-error']) {
    await openFixture();
    await submitLogin();
    await resolveLogin();
    await page.getByText('fixture-version', { exact: true }).waitFor();
    await page.evaluate(() => { window.__securityLoginMock.deferActiveCheck = true; });
    await page.waitForFunction(() => window.__securityLoginMock.activeChecks.length === 1);
    await page.evaluate(kind => {
      const check = window.__securityLoginMock.activeChecks.shift();
      if (kind === 'query-error') check.reject(new Error('fixture 状态查询失败'));
      else check.resolve(false);
      window.__securityLoginMock.deferActiveCheck = false;
    }, outcome);
    await page.getByText('纵密连接已失效或状态无法确认，请重新登录。', { exact: true }).waitFor();
    await loginButton().waitFor();
    await assertNoCredentialInputs();
  }
  results.push('会话断线或状态查询异常时撤销已登录身份');

  // 旧会话查询的迟到响应不能清掉后来创建的新会话。
  await openFixture();
  await submitLogin();
  await resolveLogin();
  await page.getByText('fixture-version', { exact: true }).waitFor();
  await page.evaluate(() => { window.__securityLoginMock.deferActiveCheck = true; });
  await page.waitForFunction(() => window.__securityLoginMock.activeChecks.length === 1);
  await page.getByRole('button', { name: /退出纵密登录/ }).click();
  await submitLogin();
  await resolveLogin({ session_id: 'fixture-new-session', device_version: 'fixture-new-version' });
  await page.getByText('fixture-new-version', { exact: true }).waitFor();
  await page.evaluate(() => { window.__securityLoginMock.activeChecks.shift().resolve(false); window.__securityLoginMock.deferActiveCheck = false; });
  assert.equal(await page.getByText('fixture-new-version', { exact: true }).count(), 1);
  assert.equal(await page.getByText('纵密连接已失效或状态无法确认，请重新登录。', { exact: true }).count(), 0);
  results.push('旧会话迟到活性响应不影响新一键登录会话');

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
  await assertNoCredentialInputs();
  const device = page.getByRole('combobox', { name: '目标 DSP', exact: true });
  await device.click();
  await page.getByText('测试 DSP · 在线', { exact: true }).click();
  assert.equal(await loginButton().isDisabled(), true);
  assert.equal((await calls()).some(call => call.command === 'login_vertical_security_one_click' || call.command === 'remote_select_device'), false);
  await page.screenshot({ path: path.join(output, 'remote-unavailable.png'), fullPage: true });
  results.push('远程能力未接入时禁止登录，不发起认证或改动全局目标');

  }
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
