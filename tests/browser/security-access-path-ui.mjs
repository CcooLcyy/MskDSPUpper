import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 真实 React / AntD + 内存 IPC fixture；全部调用由内存模拟截获，不连接设备。
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const output = process.env.SECURITY_ACCESS_PATH_UI_OUTPUT || await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-security-path-'));
await fs.mkdir(output, { recursive: true });
const { chromium } = await (process.env.MSKDSP_PLAYWRIGHT_MODULE ? import(pathToFileURL(process.env.MSKDSP_PLAYWRIGHT_MODULE)) : import('playwright'));
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
import SecurityLoginPage from ${JSON.stringify('/@fs/' + root + '/src/pages/SecurityLogin/index.tsx')};
function Fixture() {
  const [view, setView] = useState(new URLSearchParams(location.search).get('view') === 'login' ? 'login' : 'access');
  return <><nav><button onClick={() => setView('access')}>测试：访问页</button><button onClick={() => setView('login')}>测试：登录页</button><button onClick={() => setView('hidden')}>测试：离开页面</button></nav>{view === 'access' ? <SecurityAccess /> : view === 'login' ? <SecurityLoginPage /> : null}</>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfigProvider theme={darkTheme} locale={zhCN}><App><Fixture /></App></ConfigProvider></React.StrictMode>);
`);
const aliases = {};
for (const name of ['react-dom', 'react', 'antd', '@tauri-apps/api', '@tauri-apps/plugin-dialog', '@ant-design/icons']) aliases[name] = root + '/node_modules/' + name;
const server = await createServer({ configFile: false, root, cacheDir: path.join(output, '.vite'), plugins: [react(), {
  name: 'security-access-path-fixture', configureServer(vite) {
    vite.middlewares.use('/__security-path', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta charset="utf-8"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><style>body{margin:0;background:#1e1e1e;color:white;font-family:Microsoft YaHei,sans-serif}</style></head><body><div id="root"></div><script type="module" src=${JSON.stringify('/@fs/' + entry.replaceAll('\\', '/'))}></script></body></html>`);
    });
  },
}], resolve: { alias: aliases }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, output] }, watch: null, hmr: false }, logLevel: 'error' });
await server.listen();
const address = server.httpServer.address();
const url = `http://127.0.0.1:${address.port}/__security-path`;
let browser;
let page;
const failures = [];
const results = [];

async function openFixture(options = {}) {
  await page?.close();
  page = await browser.newPage({ viewport: { width: 1360, height: 1100 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => failures.push(error.message));
  await page.addInitScript(initial => {
    const mock = window.__securityPathMock = { devices: initial.devices || [{ device_id: 'fixture-dsp', display_name: '测试 DSP', online: true, allow_ssh: true, services: ['ssh', 'vertical-security'] }, { device_id: 'fixture-no-access', display_name: '无维护权限 DSP', online: true, allow_ssh: false, services: [] }, { device_id: 'fixture-offline', display_name: '离线 DSP', online: false, allow_ssh: true, services: [] }, { device_id: 'fixture-no-services', display_name: '未开放服务 DSP', online: true, allow_ssh: true, services: [] }], deviceListError: false, deferDevices: false, deviceListResolve: null, calls: [], pathResolve: null, pathReject: null, profileFailure: initial.profileFailure === true, source: initial.source || 'builtin', builtinMode: initial.builtinMode || 'auto', builtinError: false, deferBuiltin: false, builtinResolve: null };
    const profile = () => ({ configured: true, source: mock.source, builtin_mode: mock.source === 'builtin' ? mock.builtinMode : null, label: mock.source === 'builtin' ? '内置配套证书（fixture）' : '虚构自定义证书', client_certificate_path: mock.source === 'builtin' ? null : 'C:\\fixture\\client.p12', trust_certificate_path: mock.source === 'builtin' ? null : 'C:\\fixture\\trust.pem', server_name: '11.22.33.44' });
    let callback = 0;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async (command, args) => {
        mock.calls.push({ command, args });
        if (command === 'get_vertical_security_access_capabilities') return { remote_ip_available: initial.remoteAvailable === true, remote_ip_reason: '远程网络通道待接入（fixture）' };
        if (command === 'remote_list_devices') {
          if (mock.deviceListError) throw new Error('fixture 设备列表读取失败');
          if (mock.deferDevices) return new Promise(resolve => { mock.deviceListResolve = resolve; });
          return mock.devices;
        }
        if (command === 'get_vertical_security_login_capabilities') return { direct_available: true, remote_available: false, password_change_available: false, reason: '虚构 TLS 能力，仅用于 UI 测试' };
        if (command === 'get_vertical_security_login_locks') return [];
        if (command === 'get_vertical_security_certificate_profile') { if (mock.profileFailure) throw new Error('fixture profile failure'); return profile(); }
        if (command === 'configure_vertical_security_access_path') return new Promise((resolve, reject) => { mock.pathResolve = resolve; mock.pathReject = reject; });
        if (command === 'check_vertical_security_access') return new Promise(resolve => { mock.checkResolve = resolve; });
        if (command === 'use_builtin_vertical_security_certificates') {
          if (mock.builtinError) throw new Error('fixture certificate mode failure');
          const apply = () => { mock.source = 'builtin'; mock.builtinMode = args?.request?.mode || 'auto'; return profile(); };
          if (mock.deferBuiltin) return new Promise(resolve => { mock.builtinResolve = () => resolve(apply()); });
          return apply();
        }
        if (command === 'configure_vertical_security_certificate_profile') { mock.source = 'custom'; return profile(); }
        if (command === 'plugin:dialog|open') return args.options.title.includes('PKCS12') ? 'C:\\fixture\\client.p12' : 'C:\\fixture\\trust.pem';
        if (command === 'login_vertical_security') return { ...args.request, state: 'unverified_response', target_ip: '11.22.33.44', device_id: null, session_id: null, challenge_id: null, code: 'fixture', message: initial.tlsFailed ? 'fixture TLS 证书验证失败' : '虚构未验证应答', lock_seconds: null, last_login_at: null, device_version: null, certificate_group: initial.certificateGroup || null, legacy_compatibility: initial.legacyCompatibility === true, steps: initial.certificateGroup ? [{ id: 'connect', name: '连接装置', state: 'success', message: 'fixture 已连接' }, { id: 'tls', name: 'TLS 安全连接', state: initial.tlsFailed ? 'failed' : 'success', message: initial.tlsFailed ? 'fixture TLS 失败' : 'fixture TLS 已完成' }, { id: 'authenticate', name: '身份认证', state: 'failed', message: 'fixture 未验证应答' }, { id: 'initialize', name: '读取装置信息', state: 'unsupported', message: 'fixture 未执行' }] : [] };
        if (command === 'cancel_vertical_security_login' || command === 'logout_vertical_security') return;
        throw new Error(`未配置的 fixture IPC：${command}`);
      },
    };
  }, options);
  await page.goto(url + (options.view === 'login' ? '?view=login' : ''));
  await page.getByRole('heading', { name: options.view === 'login' ? '纵密登录' : '纵密访问通路', level: 1, exact: true }).waitFor();
  await page.waitForFunction(command => window.__securityPathMock.calls.some(call => call.command === command), options.view === 'login' ? 'get_vertical_security_certificate_profile' : 'get_vertical_security_access_capabilities');
  if (options.view !== 'login') {
    assert.equal(await page.getByLabel('纵密用户名', { exact: true }).count(), 0);
    assert.equal((await page.evaluate(() => window.__securityPathMock.calls)).some(call => /^(get_vertical_security_login_capabilities|get_vertical_security_certificate_profile)$/.test(call.command)), false, '通路配置页不加载纵密认证资料');
  } else {
    assert.equal(await page.getByRole('button', { name: /配置纵密访问通路|检查直连/ }).count(), 0);
    assert.equal((await page.evaluate(() => window.__securityPathMock.calls)).some(call => call.command === 'get_vertical_security_access_capabilities'), false);
  }
}
const calls = command => page.evaluate(name => window.__securityPathMock.calls.filter(call => call.command === name), command);
const sensitiveCalls = () => page.evaluate(() => window.__securityPathMock.calls.filter(call => /^(configure_vertical_security_access_path|check_vertical_security_access|login_vertical_security)$/.test(call.command)));
const dialog = () => page.getByRole('dialog', { name: /配置纵密访问通路/ });
async function openPath() { await page.getByRole('button', { name: /配置纵密访问通路/ }).click(); await dialog().waitFor(); }
async function fillPath() { await dialog().getByLabel('访问通路 SSH 上传账号', { exact: true }).fill('fixture@fixture-host:10022'); await dialog().getByLabel('访问通路 SSH 密码', { exact: true }).fill('fixture-ssh-secret'); }
async function resolvePath(applied = true) {
  await page.evaluate(value => window.__securityPathMock.pathResolve({ target_ip: '11.22.33.44', applied: value, exit_code: value ? 0 : 1, message: value ? 'fixture 配置完成；目标连通性尚未检查' : 'fixture 预检查拒绝，未完成配置', steps: ['preflight', 'addresses', 'routes', 'forwarding', 'verification', 'persistence'].map(id => ({ id, name: id === 'persistence' ? '开机恢复' : id, state: value ? 'success' : id === 'preflight' ? 'failed' : 'pending', message: value ? 'fixture 检查通过' : id === 'preflight' ? 'fixture 固定地址冲突' : 'fixture 阶段未执行' })) }), applied);
}
async function check(name, run) {
  if (process.argv.includes('--device-filter-only') && !/^(平台候选|刷新移除|空列表|刷新等待)/.test(name)) return;
  await run(); results.push(name);
}

try {
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'], ...(process.env.MSKDSP_BROWSER_EXECUTABLE ? { executablePath: process.env.MSKDSP_BROWSER_EXECUTABLE } : {}) });
  await check('平台候选仅展示在线且有维护权限的设备，不按服务过滤', async () => {
    await openFixture({ remoteAvailable: true });
    await page.locator('.ant-segmented-item').filter({ hasText: '平台远程' }).click();
    await page.getByRole('combobox', { name: '目标 DSP', exact: true }).click();
    assert.equal(await page.getByText('离线 DSP · 离线', { exact: true }).count(), 0, '离线设备不应出现在候选列表');
    assert.equal(await page.getByText('无维护权限 DSP · 在线', { exact: true }).count(), 0, '无维护权限设备不应出现在候选列表');
    assert.equal(await page.getByText('测试 DSP · 在线', { exact: true }).count(), 1);
    await page.screenshot({ path: path.join(output, 'filtered-devices.png'), fullPage: true });
    await page.getByText('未开放服务 DSP · 在线', { exact: true }).click();
    await page.getByText('所选 DSP 尚未开放 SSH 服务，无法远程配置通路', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /配置纵密访问通路/ }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: /检查远程通路/ }).isDisabled(), true);
  });
  await check('刷新移除失去资格的当前目标并清除旧通路检查结果', async () => {
    for (const reason of ['offline', 'unauthorized', 'removed', 'list-error']) {
      await openFixture({ remoteAvailable: true });
      await page.locator('.ant-segmented-item').filter({ hasText: '平台远程' }).click();
      await page.getByRole('combobox', { name: '目标 DSP', exact: true }).click();
      await page.getByText('测试 DSP · 在线', { exact: true }).click();
      await page.getByRole('button', { name: /检查远程通路/ }).click();
      await page.waitForFunction(() => Boolean(window.__securityPathMock.checkResolve));
      await page.evaluate(() => window.__securityPathMock.checkResolve({ mode: 'remote', target_ip: '11.22.33.44', device_id: 'fixture-dsp', state: 'ready', session_id: null, checked_at_ms: Date.now(), steps: ['platform-device', 'remote-channel', 'management-tcp', 'management-tls'].map(id => ({ id, name: id, state: 'success', message: 'fixture 远程通过' })) }));
      await page.getByText('远程管理通路检查通过', { exact: true }).waitFor();
      await page.evaluate(kind => {
        const mock = window.__securityPathMock;
        if (kind === 'list-error') mock.deviceListError = true;
        else if (kind === 'removed') mock.devices = [];
        else mock.devices = [{ device_id: 'fixture-dsp', display_name: '测试 DSP', online: kind !== 'offline', allow_ssh: kind !== 'unauthorized', services: ['ssh', 'vertical-security'] }];
      }, reason);
      await page.getByRole('button', { name: '刷新平台设备', exact: true }).click();
      await page.getByText('目标 DSP：尚未选择', { exact: true }).waitFor();
      assert.equal(await page.getByText('远程管理通路检查通过', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: /检查远程通路/ }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: /配置纵密访问通路/ }).isDisabled(), true);
      assert.equal((await calls('check_vertical_security_access')).length, 1, '刷新不能自动检查');
      assert.equal((await calls('login_vertical_security')).length, 0, '刷新不能触发认证');
      assert.equal((await calls('remote_select_device')).length, 0, '刷新不改变全局目标');
      await page.getByRole('combobox', { name: '目标 DSP', exact: true }).click();
      assert.equal(await page.getByText('测试 DSP · 在线', { exact: true }).count(), 0);
      await page.getByText('暂无有权限且在线的设备', { exact: true }).waitFor();
    }
  });
  await check('空列表明确展示无有权限在线设备且不能操作', async () => {
    await openFixture({ remoteAvailable: true, devices: [] });
    await page.locator('.ant-segmented-item').filter({ hasText: '平台远程' }).click();
    await page.getByRole('combobox', { name: '目标 DSP', exact: true }).click();
    await page.getByText('暂无有权限且在线的设备', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'empty-devices.png'), fullPage: true });
    assert.equal(await page.getByRole('button', { name: /配置纵密访问通路/ }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: /检查远程通路/ }).isDisabled(), true);
    assert.equal((await calls('check_vertical_security_access')).length, 0);
  });
  await check('刷新等待期间禁止选择或对旧目标发起配置与检查', async () => {
    await openFixture({ remoteAvailable: true });
    await page.locator('.ant-segmented-item').filter({ hasText: '平台远程' }).click();
    await page.getByRole('combobox', { name: '目标 DSP', exact: true }).click();
    await page.getByText('测试 DSP · 在线', { exact: true }).click();
    await page.evaluate(() => { window.__securityPathMock.deferDevices = true; });
    await page.getByRole('button', { name: '刷新平台设备', exact: true }).click();
    await page.waitForFunction(() => Boolean(window.__securityPathMock.deviceListResolve));
    assert.equal(await page.getByRole('combobox', { name: '目标 DSP', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: /配置纵密访问通路/ }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: /检查远程通路/ }).isDisabled(), true);
    await page.evaluate(() => window.__securityPathMock.deviceListResolve(window.__securityPathMock.devices));
    await page.getByRole('button', { name: /检查远程通路/ }).waitFor();
    assert.equal(await page.getByRole('combobox', { name: '目标 DSP', exact: true }).isDisabled(), false);
    assert.equal((await calls('configure_vertical_security_access_path')).length, 0);
    assert.equal((await calls('check_vertical_security_access')).length, 0);
  });
  await check('内置证书自动加载，不手选证书即可尝试登录；加载页面不自动配置/检查/登录', async () => {
    await openFixture({ view: 'login' });
    await page.getByText('内置配套证书 · 自动匹配', { exact: true }).waitFor();
    assert.equal((await sensitiveCalls()).length, 0);
    await page.getByLabel('纵密用户名', { exact: true }).fill('fixture-user');
    await page.getByLabel('纵密密码', { exact: true }).fill('fixture-login-secret');
    await page.getByRole('button', { name: /登录纵密/ }).click();
    await page.getByText('装置应答尚未验证，未建立登录会话', { exact: true }).waitFor();
    assert.equal((await calls('login_vertical_security')).length, 1);
    assert.equal((await calls('configure_vertical_security_certificate_profile')).length, 0);
    assert.equal(await page.getByLabel('纵密密码', { exact: true }).inputValue(), '');
  });
  await check('默认连接信息大小写正确，打开窗口不应用；关闭清除手填密码并恢复默认值', async () => {
    await openFixture(); await openPath();
    assert.equal((await sensitiveCalls()).length, 0);
    assert.equal(await dialog().getByLabel('访问通路 SSH 上传账号', { exact: true }).inputValue(), 'megsky@192.168.1.219:10022');
    assert.ok(await dialog().getByLabel('访问通路 SSH 密码', { exact: true }).inputValue() === 'Meg@admin123', '默认密码必须与已确认设备配置的大小写一致');
    assert.equal(await dialog().getByRole('textbox', { name: /目录|本端|对端|RTU/ }).count(), 0);
    await dialog().getByText('应用后独立开机恢复维护通路', { exact: true }).waitFor();
    assert.equal(/运行态有效|重启后需要重新配置|不配置.*开机服务/.test(await dialog().innerText()), false);
    await dialog().getByText(/独立的 systemd 服务/).waitFor();
    await dialog().getByLabel('访问通路 SSH 密码', { exact: true }).fill('fixture-override-secret');
    await dialog().getByRole('button', { name: /关\s*闭/ }).click();
    await openPath();
    assert.ok(await dialog().getByLabel('访问通路 SSH 密码', { exact: true }).inputValue() === 'Meg@admin123', '重新打开默认账号时恢复正确默认密码，不保留手填值');
    await dialog().getByRole('button', { name: '应用访问通路', exact: true }).click();
    const [defaultCall] = await calls('configure_vertical_security_access_path');
    assert.equal(defaultCall.args.request.upload_account, 'megsky@192.168.1.219:10022');
    assert.ok(defaultCall.args.request.auth.method === 'password' && defaultCall.args.request.auth.password === 'Meg@admin123', '首次提交应使用正确的默认 SSH 密码');
    assert.ok(defaultCall.args.request.sudo_password === 'Meg@admin123', 'sudo 默认复用正确的 SSH 密码');
    assert.equal(await dialog().getByLabel('访问通路 SSH 密码', { exact: true }).inputValue(), '');
    await resolvePath();
    await dialog().getByText('访问通路已应用', { exact: true }).waitFor();
    await fillPath(); await dialog().getByRole('button', { name: /关\s*闭/ }).click();
    await openPath(); assert.equal(await dialog().getByLabel('访问通路 SSH 密码', { exact: true }).inputValue(), '');
  });
  await check('显式应用提交最小payload，立即清秘密，执行中锁界面且不能关闭，无自动后续动作', async () => {
    await openFixture(); await openPath(); await fillPath();
    await dialog().getByRole('button', { name: '应用访问通路', exact: true }).click();
    await dialog().getByText('正在应用访问通路，请等待设备返回结果', { exact: true }).waitFor();
    assert.equal(await dialog().getByLabel('访问通路 SSH 密码', { exact: true }).inputValue(), '');
    const [call] = await calls('configure_vertical_security_access_path');
    assert.deepEqual(call.args.request, { upload_account: 'fixture@fixture-host:10022', auth: { method: 'password', password: 'fixture-ssh-secret' }, sudo_password: 'fixture-ssh-secret' });
    assert.equal(await page.getByRole('radio', { name: /平台远程/ }).isDisabled(), true);
    assert.equal(await page.getByLabel('纵密登录角色', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /检查直连/ }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: /登录纵密/ }).count(), 0);
    assert.equal(await dialog().getByRole('button', { name: /关\s*闭/ }).count(), 0);
    assert.equal(await dialog().getByRole('button', { name: /取消/ }).count(), 0);
    await page.keyboard.press('Escape'); assert.equal(await dialog().isVisible(), true);
    await resolvePath(); await dialog().getByText('访问通路已应用', { exact: true }).waitFor();
    assert.equal((await calls('check_vertical_security_access')).length, 0);
    assert.equal((await calls('login_vertical_security')).length, 0);
    assert.equal(await page.getByRole('radio', { name: /平台远程/ }).isDisabled(), false);
    await page.screenshot({ path: path.join(output, 'path-applied.png'), fullPage: true });
  });
  await check('真实失败结果显示步骤和退出码，不宣称已应用', async () => {
    await openFixture(); await openPath(); await fillPath();
    await dialog().getByRole('button', { name: '应用访问通路', exact: true }).click(); await resolvePath(false);
    await dialog().getByText('访问通路配置未完成', { exact: true }).waitFor();
    assert.equal(await dialog().getByText('访问通路已应用', { exact: true }).count(), 0);
    await dialog().getByText('fixture 固定地址冲突', { exact: true }).waitFor();
    assert.equal(await dialog().getByText('未执行', { exact: true }).count(), 5);
    assert.equal(await dialog().getByText('不支持', { exact: true }).count(), 0);
    assert.equal(await dialog().getByLabel('访问通路 SSH 上传账号', { exact: true }).isDisabled(), false);
  });
  await check('目录预检失败显示白名单原因，后续阶段明确未执行', async () => {
    await openFixture(); await openPath(); await fillPath();
    await dialog().getByRole('button', { name: '应用访问通路', exact: true }).click();
    await page.waitForFunction(() => Boolean(window.__securityPathMock.pathResolve));
    await page.evaluate(() => window.__securityPathMock.pathResolve({ target_ip: '11.22.33.44', applied: false, exit_code: 1, message: 'fixture 目录预检查失败', steps: ['preflight', 'addresses', 'routes', 'forwarding', 'verification', 'persistence'].map(id => ({ id, name: id, state: id === 'preflight' ? 'failed' : 'pending', message: id === 'preflight' ? '目录 /usr 的所有者、权限或访问控制不满足可信目录要求' : '前置阶段失败，本阶段未执行。' })) }));
    await dialog().getByText('目录 /usr 的所有者、权限或访问控制不满足可信目录要求', { exact: true }).waitFor();
    assert.equal(await dialog().getByText('失败', { exact: true }).count(), 1);
    assert.equal(await dialog().getByText('未执行', { exact: true }).count(), 5);
    assert.equal(await dialog().getByText('未确认', { exact: true }).count(), 0);
    assert.equal(await dialog().getByText('不支持', { exact: true }).count(), 0);
    assert.equal(await dialog().getByText('访问通路已应用', { exact: true }).count(), 0);
    assert.equal(await dialog().getByLabel('访问通路 SSH 密码', { exact: true }).inputValue(), '');
  });
  await check('超时与结果缺失标为未确认，不冒充未执行或环境不支持', async () => {
    await openFixture(); await openPath(); await fillPath();
    await dialog().getByRole('button', { name: '应用访问通路', exact: true }).click();
    await page.waitForFunction(() => Boolean(window.__securityPathMock.pathResolve));
    await page.evaluate(() => window.__securityPathMock.pathResolve({ target_ip: '11.22.33.44', applied: false, exit_code: null, message: 'fixture SSH 操作超时，实际配置状态未确认', steps: ['preflight', 'addresses', 'routes', 'forwarding', 'verification', 'persistence'].map(id => ({ id, name: id, state: 'unknown', message: '未取得该阶段的确认结果。' })) }));
    await dialog().getByText('fixture SSH 操作超时，实际配置状态未确认', { exact: false }).waitFor();
    assert.equal(await dialog().getByText('未确认', { exact: true }).count(), 6);
    assert.equal(await dialog().getByText('未执行', { exact: true }).count(), 0);
    assert.equal(await dialog().getByText('不支持', { exact: true }).count(), 0);
    assert.equal(await dialog().getByText('访问通路已应用', { exact: true }).count(), 0);
    assert.equal((await calls('check_vertical_security_access')).length, 0);
    assert.equal((await calls('login_vertical_security')).length, 0);
  });
  await check('完成标记与退出码或步骤冲突时拒绝宣称已应用', async () => {
    await openFixture(); await openPath(); await fillPath();
    await dialog().getByRole('button', { name: '应用访问通路', exact: true }).click();
    await page.evaluate(() => window.__securityPathMock.pathResolve({ target_ip: '11.22.33.44', applied: true, exit_code: 1, message: 'fixture contradictory', steps: [{ id: 'verification', name: '配置核验', state: 'failed', message: 'fixture 配置未完成' }] }));
    await dialog().getByText('配置结果的完成标记与执行状态不一致，不能确认已应用，请检查设备实际网络状态。', { exact: true }).waitFor();
    assert.equal(await dialog().getByText('访问通路已应用', { exact: true }).count(), 0);
    assert.equal((await calls('check_vertical_security_access')).length, 0);
    assert.equal((await calls('login_vertical_security')).length, 0);
  });
  await check('缺少持久化确认、重复或未知阶段不能误认完整成功', async () => {
    const expected = ['preflight', 'addresses', 'routes', 'forwarding', 'verification', 'persistence'];
    for (const phases of [expected.slice(0, -1), [...expected, 'unknown'], [...expected.slice(0, -1), 'verification'], []]) {
      await openFixture(); await openPath(); await fillPath();
      await dialog().getByRole('button', { name: '应用访问通路', exact: true }).click();
      await page.waitForFunction(() => Boolean(window.__securityPathMock.pathResolve));
      await page.evaluate(ids => window.__securityPathMock.pathResolve({ target_ip: '11.22.33.44', applied: true, exit_code: 0, message: 'fixture incomplete confirmation', steps: ids.map(id => ({ id, name: id, state: 'success', message: 'fixture success' })) }), phases);
      await dialog().getByText('访问通路配置未完成', { exact: true }).waitFor();
      assert.equal(await dialog().getByText('访问通路已应用', { exact: true }).count(), 0);
      await dialog().getByText('配置结果的完成标记与执行状态不一致，不能确认已应用，请检查设备实际网络状态。', { exact: true }).waitFor();
      assert.equal((await calls('check_vertical_security_access')).length, 0);
      assert.equal((await calls('login_vertical_security')).length, 0);
    }
  });
  await check('证书SSH认证只携带独立sudo密码；与纵密TLS证书分离', async () => {
    await openFixture(); await openPath();
    await dialog().getByLabel('访问通路 SSH 上传账号', { exact: true }).fill('fixture@fixture-host:10022');
    await dialog().locator('.ant-segmented-item').filter({ hasText: '证书' }).click();
    await dialog().getByLabel('访问通路独立 sudo 密码', { exact: true }).fill('fixture-sudo-secret');
    await dialog().getByRole('button', { name: '应用访问通路', exact: true }).click();
    await dialog().getByText('正在应用访问通路，请等待设备返回结果', { exact: true }).waitFor();
    assert.deepEqual((await calls('configure_vertical_security_access_path'))[0].args.request, { upload_account: 'fixture@fixture-host:10022', auth: { method: 'certificate' }, sudo_password: 'fixture-sudo-secret' });
    assert.equal(await dialog().getByLabel('访问通路独立 sudo 密码', { exact: true }).inputValue(), '');
    await resolvePath();
  });
  await check('远程未选择设备时禁止配置且不自动执行', async () => {
    await openFixture(); await page.locator('.ant-segmented-item').filter({ hasText: '平台远程' }).click();
    assert.equal(await page.getByRole('button', { name: /配置纵密访问通路/ }).isDisabled(), true);
    assert.equal((await calls('configure_vertical_security_access_path')).length, 0);
  });
  await check('远程配置绑定所选DSP，经手动应用后另行检测管理通路', async () => {
    await openFixture({ remoteAvailable: true });
    await page.locator('.ant-segmented-item').filter({ hasText: '平台远程' }).click();
    await page.getByRole('combobox', { name: '目标 DSP', exact: true }).click();
    await page.getByText('测试 DSP · 在线', { exact: true }).click();
    await openPath();
    await dialog().getByText('目标 DSP：测试 DSP', { exact: true }).waitFor();
    assert.equal(await dialog().getByLabel('访问通路 SSH 上传账号', { exact: true }).count(), 0, '远程模式只输入设备SSH用户名，不输入现场主机地址');
    await dialog().getByLabel('访问通路 SSH 用户名', { exact: true }).fill('fixture');
    assert.equal(await dialog().getByLabel('访问通路 SSH 密码', { exact: true }).inputValue(), '', '远程目标不得预填真机密码');
    await dialog().getByLabel('访问通路 SSH 密码', { exact: true }).fill('fixture-remote-secret');
    await dialog().getByRole('button', { name: '应用访问通路', exact: true }).click();
    await page.waitForFunction(() => Boolean(window.__securityPathMock.pathResolve));
    assert.deepEqual((await calls('configure_vertical_security_access_path'))[0].args.request, { upload_account: 'fixture@remote:22', device_id: 'fixture-dsp', auth: { method: 'password', password: 'fixture-remote-secret' }, sudo_password: 'fixture-remote-secret' });
    assert.equal(await page.getByRole('combobox', { name: '目标 DSP', exact: true }).isDisabled(), true);
    assert.equal(await dialog().getByLabel('访问通路 SSH 密码', { exact: true }).inputValue(), '');
    await resolvePath();
    await dialog().getByText('访问通路已应用', { exact: true }).waitFor();
    assert.equal((await calls('check_vertical_security_access')).length, 0, '配置成功不自动检测');
    await dialog().getByRole('button', { name: /关\s*闭/ }).click();
    await page.getByRole('button', { name: /检查远程通路/ }).click();
    await page.waitForFunction(() => Boolean(window.__securityPathMock.checkResolve));
    assert.deepEqual((await calls('check_vertical_security_access'))[0].args.request, { mode: 'remote', device_id: 'fixture-dsp' });
    await page.evaluate(() => window.__securityPathMock.checkResolve({ mode: 'remote', target_ip: '11.22.33.44', device_id: 'fixture-dsp', state: 'ready', session_id: null, checked_at_ms: Date.now(), steps: ['platform-device', 'remote-channel', 'management-tcp', 'management-tls'].map(id => ({ id, name: id, state: 'success', message: 'fixture 真实阶段的模拟结果' })) }));
    await page.getByText('远程管理通路检查通过', { exact: true }).waitFor();
    assert.equal(await page.getByText('纵密网络访问已建立', { exact: true }).count(), 0, '只读探测不能声称建立持久网络');
    assert.equal((await calls('login_vertical_security')).length, 0, '通路检测不登录纵密');
    await page.screenshot({ path: path.join(output, 'remote-access-result.png'), fullPage: true });
    await page.getByRole('combobox', { name: '目标 DSP', exact: true }).click();
    assert.equal(await page.getByText('无维护权限 DSP · 在线', { exact: true }).count(), 0, '新需求：无权限设备从候选列表隐藏');
    await page.getByText('未开放服务 DSP · 在线', { exact: true }).click();
    assert.equal(await page.getByRole('button', { name: /配置纵密访问通路/ }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: /检查远程通路/ }).isDisabled(), true);
    assert.equal(await page.getByText('远程管理通路检查通过', { exact: true }).count(), 0, '切换DSP必须失效旧结果');
    assert.equal((await calls('remote_select_device')).length, 0, '不改其他业务页面的全局目标');
  });
  await check('高级自定义证书可显式恢复内置，恢复时清口令', async () => {
    await openFixture({ view: 'login', source: 'custom' });
    await page.locator('.security-login-certificate > summary').click();
    await page.getByLabel('纵密证书口令', { exact: true }).fill('fixture-certificate-secret');
    await page.getByRole('button', { name: '使用内置配套证书', exact: true }).click();
    await page.getByText('内置配套证书 · 自动匹配', { exact: true }).waitFor();
    assert.equal((await calls('use_builtin_vertical_security_certificates')).length, 1);
    assert.deepEqual((await calls('use_builtin_vertical_security_certificates'))[0].args, { request: { mode: 'auto' } });
    assert.equal(await page.getByLabel('纵密证书口令', { exact: true }).inputValue(), '');
    assert.equal((await calls('configure_vertical_security_certificate_profile')).length, 0);
  });
  await check('证书读取失败不能伪造内置ready', async () => {
    await openFixture({ view: 'login', profileFailure: true });
    await page.getByText('读取纵密登录能力、证书配置或锁定状态失败，请离开此页后重试。', { exact: true }).waitFor();
    await page.getByLabel('纵密用户名', { exact: true }).fill('fixture-user'); await page.getByLabel('纵密密码', { exact: true }).fill('fixture-secret');
    assert.equal(await page.getByRole('button', { name: /登录纵密/ }).isDisabled(), true);
    assert.equal(await page.getByText('内置配套证书 · 自动匹配', { exact: true }).count(), 0);
  });
  await check('内置模式只显式应用，运行时锁定并清密码，不提前显示已匹配', async () => {
    await openFixture({ view: 'login' });
    await page.getByText('内置配套证书 · 自动匹配', { exact: true }).waitFor();
    await page.getByLabel('纵密密码', { exact: true }).fill('fixture-mode-secret');
    await page.locator('.security-login-certificate > summary').click();
    await page.locator('.security-login-builtin-mode > summary').click();
    await page.getByLabel('内置证书模式', { exact: true }).click();
    await page.locator('.ant-select-item-option-content').filter({ hasText: '仅旧版配套证书' }).click();
    assert.equal((await calls('use_builtin_vertical_security_certificates')).length, 0);
    await page.getByText('已生效模式：自动匹配旧版／新版。下方选择须点击应用才会生效。', { exact: true }).waitFor();
    await page.getByText('内置配套证书 · 自动匹配', { exact: true }).waitFor();
    await page.evaluate(() => { window.__securityPathMock.deferBuiltin = true; });
    await page.getByRole('button', { name: /应用内置证书模式/ }).click();
    await page.waitForFunction(() => Boolean(window.__securityPathMock.builtinResolve));
    assert.equal(await page.getByLabel('纵密密码', { exact: true }).inputValue(), '');
    assert.equal(await page.getByRole('radio', { name: /平台远程/ }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: /检查直连/ }).count(), 0);
    assert.equal(await page.getByLabel('内置证书模式', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByText(/已匹配旧版证书/).count(), 0);
    await page.evaluate(() => window.__securityPathMock.builtinResolve());
    await page.getByText('内置配套证书 · 仅旧版', { exact: true }).waitFor();
    assert.deepEqual((await calls('use_builtin_vertical_security_certificates'))[0].args, { request: { mode: 'old' } });
    assert.equal((await calls('login_vertical_security')).length, 0);
    assert.equal((await calls('check_vertical_security_access')).length, 0);
    assert.equal(await page.getByRole('radio', { name: /平台远程/ }).isDisabled(), false);
  });
  await check('模式应用失败保留原模式，不假切换、不自动重试', async () => {
    await openFixture({ view: 'login', builtinMode: 'new' });
    await page.getByText('内置配套证书 · 仅新版', { exact: true }).waitFor();
    await page.locator('.security-login-certificate > summary').click();
    await page.locator('.security-login-builtin-mode > summary').click();
    await page.getByLabel('内置证书模式', { exact: true }).click();
    await page.locator('.ant-select-item-option-content').filter({ hasText: '仅旧版配套证书' }).click();
    await page.evaluate(() => { window.__securityPathMock.builtinError = true; });
    await page.getByRole('button', { name: /应用内置证书模式/ }).click();
    await page.getByText('加载内置配套证书失败，请检查应用资源与证书状态。', { exact: true }).waitFor();
    await page.getByText('内置配套证书 · 仅新版', { exact: true }).waitFor();
    assert.equal(await page.getByText('内置配套证书 · 仅旧版', { exact: true }).count(), 0);
    assert.equal((await calls('use_builtin_vertical_security_certificates')).length, 1);
    assert.equal((await calls('login_vertical_security')).length, 0);
  });
  await check('实际TLS匹配后显示旧版受限兼容或新版严格校验，账号只发一次', async () => {
    for (const group of ['old', 'new']) {
      await openFixture({ view: 'login', certificateGroup: group, legacyCompatibility: group === 'old' });
      assert.equal(await page.getByText(/已匹配[旧新]版证书/).count(), 0);
      await page.getByLabel('纵密用户名', { exact: true }).fill('fixture-match-user');
      await page.getByLabel('纵密密码', { exact: true }).fill('fixture-match-secret');
      await page.getByRole('button', { name: /登录纵密/ }).click();
      await page.getByText(group === 'old' ? '已匹配旧版证书' : '已匹配新版证书', { exact: true }).waitFor();
      await page.getByText(group === 'old' ? /受限旧版兼容已启用/ : /严格证书校验/).waitFor();
      assert.equal((await calls('login_vertical_security')).length, 1);
      assert.equal(await page.getByText('已登录纵密装置', { exact: true }).count(), 0);
    }
  });
  await check('TLS失败或旧版兼容元数据缺失时不显示已匹配', async () => {
    for (const option of [{ certificateGroup: 'old', legacyCompatibility: true, tlsFailed: true }, { certificateGroup: 'old', legacyCompatibility: false }]) {
      await openFixture({ ...option, view: 'login' });
      await page.getByLabel('纵密用户名', { exact: true }).fill('fixture-match-user');
      await page.getByLabel('纵密密码', { exact: true }).fill('fixture-match-secret');
      await page.getByRole('button', { name: /登录纵密/ }).click();
      await page.getByText('装置应答尚未验证，未建立登录会话', { exact: true }).waitFor();
      assert.equal(await page.getByText(/已匹配[旧新]版证书/).count(), 0);
      assert.equal((await calls('login_vertical_security')).length, 1);
    }
  });
  await check('模式应用、自定义替换及恢复自动成功后清除上轮匹配结果', async () => {
    for (const action of ['mode', 'custom', 'restore']) {
      await openFixture({ view: 'login', certificateGroup: 'old', legacyCompatibility: true });
      await page.getByLabel('纵密用户名', { exact: true }).fill('fixture-match-user');
      await page.getByLabel('纵密密码', { exact: true }).fill('fixture-match-secret');
      await page.getByRole('button', { name: /登录纵密/ }).click();
      await page.getByText('已匹配旧版证书', { exact: true }).waitFor();
      await page.locator('.security-login-certificate > summary').click();
      if (action === 'mode') {
        await page.locator('.security-login-builtin-mode > summary').click();
        await page.getByLabel('内置证书模式', { exact: true }).click();
        await page.locator('.ant-select-item-option-content').filter({ hasText: '仅新版配套证书' }).click();
        await page.getByRole('button', { name: /应用内置证书模式/ }).click();
        await page.getByText('内置配套证书 · 仅新版', { exact: true }).waitFor();
      } else {
        await page.locator('.security-login-custom-certificate > summary').click();
        if (action === 'custom') {
          await page.getByRole('button', { name: /选择客户端证书/ }).click();
          await page.getByRole('button', { name: /选择信任证书/ }).click();
          await page.getByRole('button', { name: /应用连接证书/ }).click();
          await page.getByText('已配置 · 当前进程有效', { exact: true }).waitFor();
        } else {
          await page.getByRole('button', { name: /使用内置配套证书/ }).click();
          await page.getByText('已启用内置证书自动匹配，等待下次 TLS 连接确认实际组别。', { exact: true }).waitFor();
        }
      }
      assert.equal(await page.getByText(/已匹配[旧新]版证书/).count(), 0);
      assert.equal((await calls('login_vertical_security')).length, 1);
    }
  });
  await check('卸载不声称撤销运行中的配置，迟到结果不自动登录或检查', async () => {
    await openFixture(); await openPath(); await fillPath(); await dialog().getByRole('button', { name: '应用访问通路', exact: true }).click();
    await dialog().getByText('正在应用访问通路，请等待设备返回结果', { exact: true }).waitFor();
    // 测试宿主触发组件卸载，模拟应用导航/关闭；不把模态遮罩当作可取消入口。
    await page.getByRole('button', { name: '测试：离开页面', exact: true }).evaluate(button => button.click());
    await resolvePath();
    assert.equal(await page.getByText('访问通路已应用', { exact: true }).count(), 0);
    assert.equal((await calls('cancel_vertical_security_login')).length, 0);
    assert.equal((await calls('check_vertical_security_access')).length, 0);
    assert.equal((await calls('login_vertical_security')).length, 0);
  });
  assert.deepEqual(failures, []);
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ results, failures }, null, 2));
  console.log(JSON.stringify({ output, passed: results.length, results }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: String(error), results, failures }, null, 2));
  throw error;
} finally { await browser?.close(); await server.close(); }
