import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 真实 React 与 Ant Design，虚构 IPC 边界；不连接装置或读取真实证书。
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-security-admin-'));
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
import SecurityAdmin from ${JSON.stringify('/@fs/' + root + '/src/pages/SecurityAccess/SecurityAdmin.tsx')};
import SecurityLoginPage from ${JSON.stringify('/@fs/' + root + '/src/pages/SecurityLogin/index.tsx')};
import { retainLogin } from ${JSON.stringify('/@fs/' + root + '/src/pages/SecurityAccess/login-session.ts')};
import ${JSON.stringify('/@fs/' + root + '/src/pages/SecurityAccess/index.css')};
import ${JSON.stringify('/@fs/' + root + '/src/pages/SecurityLogin/index.css')};
const loginRole = new URLSearchParams(location.search).get('loginRole');
if (loginRole && loginRole !== '0') retainLogin({ request_id: 'fixture-request', state: 'authenticated', code: 'success', message: '测试认证', target_ip: '11.22.33.44', mode: 'direct', device_id: null, session_id: 'fixture-login', challenge_id: null, username: 'fixture-user', role: Number(loginRole), lock_seconds: null, last_login_at: null, device_version: 'fixture', steps: [] });
function Fixture() {
  const [sessionId, setSessionId] = useState('fixture-a');
  const [visible, setVisible] = useState(true);
  const [disabled, setDisabled] = useState(false);
  if (loginRole !== null) return <SecurityLoginPage />;
  return <><button onClick={() => setSessionId('fixture-b')}>测试：切换会话</button><button onClick={() => setVisible(false)}>测试：离开</button><button onClick={() => setDisabled(value => !value)}>测试：退出中</button>{visible && <SecurityAdmin key={sessionId} sessionId={sessionId} disabled={disabled} />}</>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfigProvider theme={darkTheme} locale={zhCN}><App><Fixture /></App></ConfigProvider></React.StrictMode>);
`);
const aliases = {};
for (const name of ['react-dom', 'react', 'antd', '@tauri-apps/api', '@tauri-apps/plugin-dialog', '@ant-design/icons']) aliases[name] = root + '/node_modules/' + name;
const server = await createServer({ configFile: false, root, cacheDir: path.join(output, '.vite'), plugins: [react(), {
  name: 'security-admin-fixture', configureServer(vite) { vite.middlewares.use('/__security-admin', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><meta charset="utf-8"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><style>body{margin:20px;background:#1e1e1e;color:white;font-family:Microsoft YaHei,sans-serif}</style></head><body><div id="root"></div><script type="module" src=${JSON.stringify('/@fs/' + entry.replaceAll('\\', '/'))}></script></body></html>`);
  }); },
}], resolve: { alias: aliases }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, output] }, watch: null, hmr: false }, logLevel: 'error' });
await server.listen();
let browser;
let page;
const errors = [];
const results = [];
try {
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'], ...(process.env.MSKDSP_BROWSER_EXECUTABLE ? { executablePath: process.env.MSKDSP_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1280, height: 1050 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const mock = window.__admin = { calls: [], pending: [], defer: false, fail: false, failLogout: false, ip: '192.0.2.8', active: true };
    let callback = 0;
    const response = action => ({ message: '装置应答：操作完成', status: action === 'status' ? 'initialized' : null, certificates: action === 'list_certificates' ? [{ name: 'master.cer', certificate_type: 5 }] : [], data: [65, 66] });
    window.__TAURI_INTERNALS__ = { transformCallback: () => ++callback, unregisterCallback: () => {}, invoke: async (command, args) => {
      mock.calls.push({ command, args });
      if (command === 'remote_list_devices') return [];
      if (command === 'get_vertical_security_login_capabilities') return { direct_available: true, remote_available: false, password_change_available: false, reason: '测试能力' };
      if (command === 'get_vertical_security_certificate_profile') return { configured: true, source: 'builtin', server_name: '11.22.33.44' };
      if (command === 'is_vertical_security_login_active') return mock.active;
      if (command === 'logout_vertical_security' && mock.failLogout) throw new Error('测试：退出失败');
      if (command === 'run_vertical_security_admin') {
        if (mock.fail) throw new Error('装置拒绝请求（测试）');
        if (mock.defer) return new Promise(resolve => mock.pending.push({ resolve, request: args.request }));
        return response(args.request.action);
      }
      if (command === 'get_vertical_security_sim_ip') return mock.ip;
      if (command === 'plugin:dialog|open') return 'C:\\fixture\\chosen.cer';
      if (command === 'read_vertical_security_certificate_file') return { name: 'chosen.cer', data: [67] };
      if (command === 'plugin:dialog|save') return 'C:\\fixture\\' + args.options.defaultPath;
      if (command === 'save_vertical_security_file') return args.path;
      return null;
    } };
  });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__security-admin`;
  await page.goto(url, { waitUntil: 'commit' });
  await page.getByRole('button', { name: '查询初始化状态', exact: true }).waitFor({ timeout: 45000 });
  const calls = () => page.evaluate(() => window.__admin.calls.filter(call => call.command === 'run_vertical_security_admin').map(call => call.args.request));
  assert.equal((await calls()).length, 0);
  await page.getByRole('button', { name: '查询初始化状态', exact: true }).click();
  await page.getByText('已初始化', { exact: true }).waitFor();
  results.push('进入不自动发送操作，查询后展示装置状态');

  await page.getByRole('button', { name: '导出 SM2 CSR', exact: true }).click();
  await page.getByText('CSR 已保存。', { exact: true }).waitFor();
  assert.equal((await calls()).some(call => call.action === 'generate_sm2'), false);
  const save = await page.evaluate(() => window.__admin.calls.find(call => call.command === 'plugin:dialog|save'));
  assert.equal(save.args.options.defaultPath, '192.0.2.8_SM2.csr');
  await page.evaluate(() => { window.__admin.ip = null; });
  await page.getByRole('button', { name: '导出 SM2 CSR', exact: true }).click();
  await page.getByText('无法获取当前 DSP 的 SIM IP，CSR 将使用 SM2.csr 文件名。', { exact: true }).waitFor();
  results.push('CSR 不重生成密钥，IP 命名与失败回退');

  await page.getByRole('button', { name: '导入主站证书', exact: true }).click();
  await page.getByText('master.cer', { exact: true }).waitFor();
  assert.equal((await calls()).find(call => call.action === 'import_certificate').certificate_type, 5);
  await page.getByLabel('主站证书类别', { exact: true }).click();
  await page.getByText('装置管理系统证书', { exact: true }).last().click();
  await page.getByRole('button', { name: '导入主站证书', exact: true }).click();
  await page.waitForFunction(() => window.__admin.calls.some(call => call.args?.request?.action === 'import_certificate' && call.args.request.certificate_type === 4));
  assert.equal(await page.getByRole('button', { name: '查看内容', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('原始证书内容', { exact: true }).count(), 0);
  await page.getByRole('button', { name: /^导\s*出$/ }).click();
  await page.waitForFunction(() => window.__admin.calls.some(call => call.command === 'save_vertical_security_file' && call.args?.path?.endsWith('master.cer')));
  await page.getByRole('button', { name: /^删\s*除$/ }).click();
  assert.equal((await calls()).some(call => call.action === 'delete_certificate'), false);
  await page.getByRole('tooltip').getByRole('button', { name: /^删\s*除$/ }).click();
  await page.waitForFunction(() => window.__admin.calls.some(call => call.args?.request?.action === 'delete_certificate'));
  results.push('主站5/4分类导入，移除内容查看并保留导出与删除确认');

  await page.getByRole('button', { name: '测试：退出中', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '查询初始化状态', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '测试：退出中', exact: true }).click();
  await page.evaluate(() => { window.__admin.fail = true; });
  await page.getByRole('button', { name: '查询初始化状态', exact: true }).click();
  await page.getByText('装置拒绝请求（测试）', { exact: true }).waitFor();
  await page.evaluate(() => { window.__admin.fail = false; window.__admin.defer = true; });
  await page.getByRole('button', { name: '导出 SM2 CSR', exact: true }).click();
  await page.waitForFunction(() => window.__admin.pending.length === 1);
  assert.equal(await page.getByRole('button', { name: '导入主站证书', exact: true }).isDisabled(), true);
  const savesBefore = await page.evaluate(() => window.__admin.calls.filter(call => call.command === 'save_vertical_security_file').length);
  await page.getByRole('button', { name: '测试：切换会话', exact: true }).click();
  await page.evaluate(() => { window.__admin.pending[0].resolve({ message: '迟到响应', status: '错误会话状态', certificates: [], data: [65] }); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByText('错误会话状态', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.__admin.calls.filter(call => call.command === 'save_vertical_security_file').length), savesBefore);
  results.push('退出中与忙时禁用、错误保持、会话切换隔离迟到 CSR');
  for (const role of [0, 2, 3]) {
    await page.goto(url + '?loginRole=' + role, { waitUntil: 'commit' });
    await page.getByLabel('纵密登录工作台', { exact: true }).waitFor();
    if (role === 0) await page.getByText('登录纵密', { exact: true }).waitFor();
    else await page.getByText('退出纵密登录', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('纵密系统管理员工作台', { exact: true }).count(), 0);
  }
  await page.goto(url + '?loginRole=1', { waitUntil: 'commit' });
  await page.getByLabel('纵密系统管理员工作台', { exact: true }).waitFor();
  assert.equal(await page.locator('.security-login-columns').count(), 0, '登录成功后移除认证双栏');
  assert.equal(await page.getByText('装置身份认证', { exact: true }).count(), 0);
  assert.equal(await page.getByText('登录进度', { exact: true }).count(), 0);
  await page.getByRole('heading', { name: '纵密工作台', exact: true }).waitFor();
  assert.equal(await page.getByLabel('纵密登录连接方式', { exact: true }).count(), 0);
  await page.evaluate(() => { window.__admin.failLogout = true; });
  await page.getByText('退出纵密登录', { exact: true }).click();
  await page.getByText('退出纵密登录失败，会话记录仍保留，请重试。', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('纵密系统管理员工作台', { exact: true }).count(), 1);
  assert.equal(await page.locator('.security-login-columns').count(), 0);
  await page.evaluate(() => { window.__admin.failLogout = false; });
  await page.getByText('退出纵密登录', { exact: true }).click();
  await page.getByRole('heading', { name: '纵密登录', exact: true }).waitFor();
  await page.getByText('装置身份认证', { exact: true }).waitFor();
  await page.getByText('登录进度', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('纵密系统管理员工作台', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.__admin.calls.filter(call => call.command === 'logout_vertical_security').length), 2);
  assert.equal(await page.evaluate(() => window.__admin.calls.some(call => /logout/.test(call.command) && call.command !== 'logout_vertical_security')), false);
  await page.goto(url + '?loginRole=1', { waitUntil: 'commit' });
  await page.getByLabel('纵密系统管理员工作台', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'security-admin.png'), fullPage: true });
  await page.evaluate(() => { window.__admin.active = false; });
  await page.getByText('纵密连接已失效或状态无法确认，请重新登录。', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('纵密系统管理员工作台', { exact: true }).count(), 0);
  await page.getByText('装置身份认证', { exact: true }).waitFor();
  await page.getByText('登录进度', { exact: true }).waitFor();
  results.push('真实登录组件：未登录与非管理员隐藏、管理员可见、过期会话撤销');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ results, screenshot: path.join(output, 'security-admin.png') }, null, 2));
} finally { await browser?.close(); await server.close(); }
