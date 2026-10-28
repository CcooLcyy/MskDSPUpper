import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 真实 React / AntD 页面与虚构 IPC fixture；不连接设备、不执行网络脚本。
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const output = process.env.SECURITY_ACCESS_UI_OUTPUT || await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-security-ui-'));
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
import SecurityConfig from ${JSON.stringify('/@fs/' + root + '/src/pages/SecurityConfig/index.tsx')};
import { reportLoginConnectionFailure } from ${JSON.stringify('/@fs/' + root + '/src/pages/SecurityAccess/access-state.ts')};
function Fixture() {
  const [page, setPage] = useState('access');
  return <><nav><button onClick={() => setPage('access')}>测试：访问页</button><button onClick={() => setPage('config')}>测试：配置页</button><button onClick={() => reportLoginConnectionFailure({ mode: 'direct', target_ip: '11.22.33.44', steps: [{ id: 'connect', state: 'failed' }] })}>测试：登录连接失败</button><button onClick={() => reportLoginConnectionFailure({ mode: 'direct', target_ip: '11.22.33.44', steps: [{ id: 'connect', state: 'success' }, { id: 'tls', state: 'success' }, { id: 'authenticate', state: 'failed' }] })}>测试：账号认证失败</button></nav>{page === 'access' ? <SecurityAccess /> : <SecurityConfig />}</>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfigProvider theme={darkTheme} locale={zhCN}><App><Fixture /></App></ConfigProvider></React.StrictMode>);
`);
const aliases = {};
for (const name of ['react-dom', 'react', 'antd', '@tauri-apps/api', '@ant-design/icons']) aliases[name] = root + '/node_modules/' + name;
const server = await createServer({ configFile: false, root, cacheDir: path.join(output, '.vite'), plugins: [react(), {
  name: 'security-workbench-fixture', configureServer(vite) {
    vite.middlewares.use('/__security-workbench', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta charset="utf-8"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><style>body{margin:0;background:#1e1e1e;color:white;font-family:Microsoft YaHei,sans-serif}</style></head><body><div id="root"></div><script type="module" src=${JSON.stringify('/@fs/' + entry.replaceAll('\\', '/'))}></script></body></html>`);
    });
  },
}], resolve: { alias: aliases }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, output] }, watch: null, hmr: false }, logLevel: 'error' });
await server.listen();
let browser;
const failures = [];
const results = [];
let page;
try {
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'], ...(process.env.MSKDSP_BROWSER_EXECUTABLE ? { executablePath: process.env.MSKDSP_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1300, height: 1100 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => failures.push(error.message));
  await page.addInitScript(() => {
    const mock = window.__securityMock = { calls: [], resolve: null, reject: null };
    let callback = 0;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async (command, args) => {
        mock.calls.push({ command, args });
        if (command === 'get_vertical_security_access_capabilities') return { remote_ip_available: false, remote_ip_reason: '远程网络通道待接入（fixture）' };
        if (command === 'get_vertical_security_login_capabilities') return { direct_available: false, remote_available: false, password_change_available: false, reason: '此回归仅验证网络检查与配置（fixture）' };
        if (command === 'get_vertical_security_certificate_profile') return { configured: false, client_certificate_path: null, trust_certificate_path: null, server_name: null };
        if (command === 'remote_list_devices') return [{ device_id: 'fixture-dsp', display_name: '测试 DSP', online: true }];
        if (command === 'check_vertical_security_access') return new Promise((resolve, reject) => { mock.resolve = resolve; mock.reject = reject; });
        if (command === 'deploy_vertical_security_script') return { remote_path: '/home/fixture/vertical-security.sh', service_name: 'fixture-security', exit_code: 0, stdout: '', stderr: '', success: true };
        if (command === 'get_vertical_security_status') return { service_name: 'fixture-security', active_state: 'active', sub_state: 'running', result: 'success', exit_code: 0, restart_count: 0, steps: ['precheck', 'forwarding', 'local_security', 'local_rtu', 'ppp0_wait', 'remote_security_route', 'dnat', 'snat', 'conntrack', 'save_config'].map(id => ({ step_id: id, name: id, state: 'success', message: '虚构执行结果', updated_at: 1 })) };
        return null;
      },
    };
  });
  const address = server.httpServer.address();
  await page.goto(`http://127.0.0.1:${address.port}/__security-workbench`, { waitUntil: 'commit', timeout: 15000 });
  await page.getByRole('button', { name: /检查直连/ }).waitFor({ timeout: 45000 });
  assert.equal(await page.getByLabel('纵密用户名', { exact: true }).count(), 0, '访问通路页不得挂载纵密登录表单');
  assert.equal(await page.locator('.security-login-workbench').count(), 0);
  assert.equal((await page.evaluate(() => window.__securityMock.calls)).some(call => /^(get_vertical_security_login_capabilities|get_vertical_security_certificate_profile|login_vertical_security)$/.test(call.command)), false, '访问通路页不得加载登录能力或证书');
  await page.getByRole('heading', { name: '纵密访问通路', level: 1, exact: true }).waitFor();
  results.push('访问通路页独立显示标题和网络检查，不挂载认证界面或加载登录能力及证书');
  const ready = { mode: 'direct', target_ip: '11.22.33.44', device_id: null, state: 'ready', session_id: null, checked_at_ms: Date.UTC(2026, 9, 28, 9, 20, 0), steps: [
    { id: 'computer-network', name: '电脑网络', state: 'success', message: '虚构网卡维护地址符合要求' },
    { id: 'target-route', name: '纵密访问路径', state: 'success', message: '虚构路由出口符合要求' },
    { id: 'round-trip', name: '往返响应', state: 'success', message: '虚构 ICMP 响应，不代表所有业务均已联调' },
    { id: 'management-tcp', name: '管理端口', state: 'success', message: 'TCP 8888 已连接' },
    { id: 'management-tls', name: 'TLS 握手', state: 'success', message: '配套证书验证成功，探测连接已关闭' },
  ] };
  await page.getByRole('button', { name: /检查直连/ }).click();
  await page.waitForFunction(() => window.__securityMock.resolve !== null);
  assert.equal(await page.getByRole('radio', { name: /平台远程/ }).isDisabled(), true);
  await page.getByRole('button', { name: '取消检查', exact: true }).click();
  await page.evaluate(value => { window.__securityMock.resolve(value); window.__securityMock.resolve = null; }, ready);
  await page.getByRole('button', { name: /检查直连/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /复制目标 IP/ }).count(), 0, '取消后的迟到结果不得变成成功');
  results.push('取消检查后忽略迟到结果');
  await page.getByRole('button', { name: /检查直连/ }).click();
  await page.waitForFunction(() => window.__securityMock.resolve !== null);
  await page.evaluate(value => { window.__securityMock.resolve(value); window.__securityMock.resolve = null; }, ready);
  await page.getByText('管理连接可用', { exact: true }).waitFor();
  assert.match(await page.locator('.security-access-page').innerText(), /检查时间/);
  assert.equal(await page.locator('.security-access-check-time time').getAttribute('datetime'), new Date(ready.checked_at_ms).toISOString());
  assert.equal(await page.getByText('TLS 握手', { exact: true }).isVisible(), true);
  await page.getByRole('button', { name: '测试：账号认证失败', exact: true }).click();
  assert.equal(await page.getByText('管理连接可用', { exact: true }).isVisible(), true, '账号错误不能否定已验证的管理连接');
  assert.equal(await page.getByRole('button', { name: /复制目标 IP/ }).isVisible(), true);
  assert.equal((await page.locator('.security-access-target strong').innerText()), '11.22.33.44');
  assert.equal(/HTTPS|127\.0\.0\.1:|打开管理页面/.test(await page.locator('.security-access-page').innerText()), false);
  assert.equal(await page.getByRole('heading', { name: 'DSP 侧网络配置', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(output, 'direct-result.png'), fullPage: true });
  results.push('真实组件显示后端检测结果，目标为 IP 且无协议端口输入');
  await page.getByRole('button', { name: '测试：登录连接失败', exact: true }).click();
  await page.getByText('管理连接可用', { exact: true }).waitFor({ state: 'hidden' });
  results.push('登录连接失败撤销旧通过结果，账号认证失败保留连接结果');
  await page.getByRole('button', { name: /检查直连/ }).click();
  await page.waitForFunction(() => window.__securityMock.resolve !== null);
  await page.getByRole('button', { name: '测试：登录连接失败', exact: true }).click();
  await page.evaluate(value => { window.__securityMock.resolve(value); window.__securityMock.resolve = null; }, ready);
  assert.equal(await page.getByText('管理连接可用', { exact: true }).count(), 0, '登录连接失败后的迟到成功不得回填');
  results.push('检查期间发生登录连接失败，迟到成功结果不会恢复绿色状态');
  await page.getByRole('button', { name: /检查直连/ }).click();
  await page.waitForFunction(() => window.__securityMock.resolve !== null);
  const refused = { ...ready, state: 'failed', steps: ready.steps.map(step => step.id === 'management-tcp'
    ? { ...step, state: 'failed', message: '管理端口拒绝连接' }
    : step.id === 'management-tls' ? { ...step, state: 'unsupported', message: 'TCP 连接失败，未执行 TLS 握手' } : step) };
  await page.evaluate(value => { window.__securityMock.resolve(value); window.__securityMock.resolve = null; }, refused);
  await page.getByText('管理端口拒绝连接', { exact: true }).waitFor();
  assert.equal(await page.getByText('管理连接可用', { exact: true }).count(), 0, 'ICMP 成功但 TCP 拒绝不能显示通过');
  assert.equal(await page.locator('.security-access-step').filter({ hasText: 'TLS 握手' }).locator('span').last().innerText(), '未执行');
  await page.screenshot({ path: path.join(output, 'port-refused.png'), fullPage: true });
  results.push('ICMP 成功但管理端口拒绝时显示失败，并保留 TLS 未执行诊断');
  await page.getByRole('button', { name: /检查直连/ }).click();
  await page.waitForFunction(() => window.__securityMock.resolve !== null);
  const tlsFailed = { ...ready, state: 'failed', steps: ready.steps.map(step => step.id === 'management-tls'
    ? { ...step, state: 'failed', message: '证书握手失败' } : step) };
  await page.evaluate(value => { window.__securityMock.resolve(value); window.__securityMock.resolve = null; }, tlsFailed);
  await page.getByText('证书握手失败', { exact: true }).waitFor();
  assert.equal(await page.getByText('管理连接可用', { exact: true }).count(), 0, 'TCP 成功但 TLS 失败不能显示通过');
  results.push('TCP 成功但证书握手失败时整体失败');
  await page.getByRole('button', { name: /检查直连/ }).click();
  await page.waitForFunction(() => window.__securityMock.resolve !== null);
  const noPing = { ...ready, steps: ready.steps.map(step => step.id === 'round-trip'
    ? { ...step, state: 'failed', message: 'ICMP 无响应，仅供诊断' } : step) };
  await page.evaluate(value => { window.__securityMock.resolve(value); window.__securityMock.resolve = null; }, noPing);
  await page.getByText('管理连接可用', { exact: true }).waitFor();
  assert.equal(await page.getByText('ICMP 无响应，仅供诊断', { exact: true }).isVisible(), true);
  results.push('ICMP 无响应但管理连接验证通过时，显示可用且保留诊断提示');
  await page.locator('.ant-segmented-item').filter({ hasText: '平台远程' }).click();
  await page.getByText('远程网络通道待接入', { exact: true }).waitFor();
  const combo = page.getByRole('combobox', { name: '目标 DSP', exact: true });
  await combo.click();
  await page.getByText('测试 DSP · 在线', { exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /建立访问连接/ }).isDisabled(), true);
  const calls = await page.evaluate(() => window.__securityMock.calls);
  assert.equal(calls.some(call => call.command === 'remote_select_device'), false, '独立页面不得修改全局业务目标');
  assert.equal(calls.filter(call => call.command === 'check_vertical_security_access').every(call => call.args.request.mode === 'direct'), true);
  await page.screenshot({ path: path.join(output, 'remote-pending.png'), fullPage: true });
  results.push('远程设备可选但 IP 通道待接入，禁止模拟连接或切全局目标');
  await page.locator('.ant-segmented-item').filter({ hasText: '101 口直连' }).click();
  await page.getByRole('button', { name: /检查直连/ }).click();
  await page.waitForFunction(() => window.__securityMock.resolve !== null);
  await page.getByRole('button', { name: '测试：配置页', exact: true }).click();
  await page.evaluate(value => { window.__securityMock.resolve(value); window.__securityMock.resolve = null; }, ready);
  await page.getByRole('button', { name: '测试：访问页', exact: true }).click();
  await page.getByRole('button', { name: /检查直连/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /复制目标 IP/ }).count(), 0, '离开页面的结果不得污染新页面');
  results.push('页面卸载和重新进入不会保留迟到检查结果');
  await page.getByRole('button', { name: '测试：配置页', exact: true }).click();
  await page.getByRole('heading', { name: '纵密网络配置', exact: true }).waitFor();
  assert.equal(await page.locator('.security-config-maintenance').count(), 0, '业务页移除维护参数详情');
  assert.equal(/11\.22\.33\.44|101\s*\/\s*108\s*维护|代理\s*ARP|SNAT/.test(await page.locator('.security-config-page').innerText()), false, '业务页不展示维护配置');
  assert.equal(await page.getByRole('button', { name: '返回纵密访问', exact: true }).count(), 0);
  const passwords = await page.locator('input[type="password"]').evaluateAll(inputs => inputs.map(input => input.value));
  assert.equal(passwords.every(value => value === ''), true, '配置页不能自动填入内置密码');
  assert.equal((await page.evaluate(() => window.__securityMock.calls)).some(call => call.command === 'deploy_vertical_security_script'), false);
  await page.screenshot({ path: path.join(output, 'network-config.png'), fullPage: true });
  results.push('独立配置页无重复返回入口、无内置密码、未自动下发');
  for (const [label, value] of [['本端 RTU 地址', '10.10.1.10'], ['本端纵密地址', '10.10.1.20'], ['本端网关地址', '10.10.1.1'], ['对端 RTU 地址', '10.20.1.10'], ['对端纵密地址', '10.20.1.20'], ['对端网关地址', '10.20.1.1']]) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await page.getByRole('button', { name: /配置预览/ }).click();
  const previewDialog = page.getByRole('dialog', { name: '纵密配置脚本预览', exact: true });
  await previewDialog.waitFor();
  const businessPreview = await previewDialog.innerText();
  assert.equal(/11\.22\.33\.44|101|代理\s*ARP/.test(businessPreview), false, '业务预览不包含维护参数或步骤');
  assert.match(businessPreview, /-A POSTROUTING -o ppp0[\s\S]*?-j SNAT/, '业务预览包含限定 ppp0 的业务 SNAT');
  assert.equal(/PPP/.test(businessPreview) && /DNAT/.test(businessPreview) && /连接跟踪/.test(businessPreview), true, '业务预览保留业务网络影响');
  assert.equal((await page.evaluate(() => window.__securityMock.calls)).some(call => call.command === 'deploy_vertical_security_script'), false, '预览不能下发配置');
  await page.screenshot({ path: path.join(output, 'network-config-preview.png'), fullPage: true });
  await previewDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await previewDialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /应用网络配置/ }).click();
  await page.waitForFunction(() => document.querySelector('.security-config-auth')?.open === true);
  assert.equal((await page.evaluate(() => window.__securityMock.calls)).some(call => call.command === 'deploy_vertical_security_script'), false, '认证缺失时应用不能下发');
  await page.getByLabel('SSH 上传账号', { exact: true }).fill('fixture-user@192.0.2.1:10022');
  await page.getByLabel('SSH 密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: /应用网络配置/ }).click();
  await page.waitForFunction(() => window.__securityMock.calls.some(call => call.command === 'get_vertical_security_status'));
  assert.equal(await page.getByRole('dialog').count(), 0, '应用直接下发，不打开预览或确认弹窗');
  assert.equal((await page.evaluate(() => window.__securityMock.calls)).filter(call => call.command === 'deploy_vertical_security_script').length, 1);
  await page.screenshot({ path: path.join(output, 'network-config-applied.png'), fullPage: true });
  results.push('独立预览无需认证且不下发；应用校验认证后直接部署并查询状态，不弹配置预览（全程虚构IPC）');
  await page.getByRole('button', { name: '测试：访问页', exact: true }).click();
  for (const width of [736, 375, 320]) {
    await page.setViewportSize({ width, height: 1300 });
    const overflow = await page.locator('.security-access-page').evaluate(element => element.scrollWidth > element.clientWidth + 2);
    assert.equal(overflow, false, `${width}px 不应出现横向溢出`);
  }
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  results.push('736/375/320px 窄屏无横向溢出');
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
