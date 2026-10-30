import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 使用真实页面与可控的虚构 IPC，验证凭据读取竞争；不连接设备、不访问系统凭据。
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-security-credentials-'));
const { chromium } = await (process.env.MSKDSP_PLAYWRIGHT_MODULE
  ? import(pathToFileURL(process.env.MSKDSP_PLAYWRIGHT_MODULE)) : import('playwright'));
const { createServer } = await import(pathToFileURL(root + '/node_modules/vite/dist/node/index.js'));
const { default: react } = await import(pathToFileURL(root + '/node_modules/@vitejs/plugin-react/dist/index.js'));
const entry = path.join(output, 'entry.tsx');
await fs.writeFile(entry, `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ConfigProvider } from 'antd';
import SecurityConfig from ${JSON.stringify('/@fs/' + root + '/src/pages/SecurityConfig/index.tsx')};
function Fixture() {
  const [visible, setVisible] = useState(true);
  return <><button onClick={() => setVisible(value => !value)}>测试：切换页面</button>{visible && <SecurityConfig />}</>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfigProvider><App><Fixture /></App></ConfigProvider></React.StrictMode>);
`);
const aliases = {};
for (const name of ['react-dom', 'react', 'antd', '@tauri-apps/api', '@ant-design/icons']) aliases[name] = root + '/node_modules/' + name;
const server = await createServer({ configFile: false, root, cacheDir: path.join(output, '.vite'), plugins: [react(), {
  name: 'security-credentials-fixture', configureServer(vite) {
    vite.middlewares.use('/__security-credentials', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta charset="utf-8"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src=${JSON.stringify('/@fs/' + entry.replaceAll('\\', '/'))}></script></body></html>`);
    });
  },
}], resolve: { alias: aliases }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, output] }, watch: null, hmr: false }, logLevel: 'error' });
await server.listen();
let browser;
let page;
const failures = [];
const results = [];
const defaultAccount = 'megsky@192.168.1.219:10022';
const otherAccount = 'fixture@192.0.2.2:10022';
const saved = { ssh_password: 'fixture-saved-ssh', sudo_password: 'fixture-saved-sudo' };
try {
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'], ...(process.env.MSKDSP_BROWSER_EXECUTABLE ? { executablePath: process.env.MSKDSP_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => failures.push(error.message));
  await page.addInitScript(() => {
    const mock = window.__credentialMock = { calls: [], pending: [], nextId: 0 };
    let callback = 0;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async (command, args) => {
        mock.calls.push({ command, args });
        if (command === 'get_lower_update_credentials') return new Promise((resolve, reject) => {
          mock.pending.push({ id: ++mock.nextId, account: args.uploadAccount, resolve, reject });
        });
        return null;
      },
    };
  });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__security-credentials`;
  const account = () => page.getByLabel('SSH 上传账号', { exact: true });
  const ssh = () => page.getByLabel('SSH 密码', { exact: true });
  const sudo = () => page.getByLabel('独立 sudo 密码', { exact: true });
  const reuse = () => page.locator('.security-config-auth').getByRole('switch');
  const waitRequest = async (target = defaultAccount) => page.waitForFunction(value => window.__credentialMock.pending.some(item => item.account === value), target);
  const settle = async (target = defaultAccount, value = saved, reject = false) => {
    await page.evaluate(({ target, value, reject }) => {
      const mock = window.__credentialMock;
      const requests = mock.pending.filter(item => item.account === target);
      mock.pending = mock.pending.filter(item => item.account !== target);
      for (const request of requests) {
        if (reject) request.reject(new Error('fixture-private-error'));
        else request.resolve(value);
      }
    }, { target, value, reject });
    // 等待浏览器执行 promise 回调与 React 更新，不使用固定时间休眠。
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const start = async () => {
    await page.goto(url, { waitUntil: 'commit', timeout: 15000 });
    await page.getByRole('heading', { name: 'DSP 纵密网络配置', exact: true }).waitFor({ timeout: 45000 });
    await page.locator('.security-config-auth summary').click();
  };

  // 验证首次显示的设备与账号默认值一致，并读取其已保存凭据。
  await start();
  assert.equal(await account().inputValue(), defaultAccount, '首次进入应自动填入默认 SSH 账号');
  await waitRequest();
  assert.equal(await ssh().inputValue(), '');
  await settle();
  assert.equal(await ssh().inputValue(), saved.ssh_password);
  assert.equal(await sudo().count(), 0);
  results.push('首次进入默认账号并回填已保存 SSH 密码');

  // 验证独立 sudo 密码读取及复用开关清空失效的独立凭据。
  await reuse().click();
  await waitRequest();
  await settle();
  assert.equal(await sudo().inputValue(), saved.sudo_password);
  await reuse().click();
  assert.equal(await sudo().count(), 0);
  await reuse().click();
  assert.equal(await sudo().inputValue(), '');
  await waitRequest();
  await settle();
  assert.equal(await sudo().inputValue(), saved.sudo_password);
  results.push('独立 sudo 回填及复用切换清理');

  // 验证不存在已保存凭据时保持空白，读取失败只显示通用提示。
  await start();
  await waitRequest();
  await settle(defaultAccount, { ssh_password: null, sudo_password: null });
  assert.equal(await ssh().inputValue(), '');
  await account().fill(otherAccount);
  await waitRequest(otherAccount);
  await settle(otherAccount, null, true);
  await page.getByText(/读取已保存.*失败/).waitFor();
  assert.equal(await ssh().inputValue(), '');
  assert.equal((await page.locator('body').innerText()).includes('fixture-private-error'), false);
  results.push('凭据缺失可手动输入，读取失败隐藏底层错误');

  // 验证用户输入和主动清空后，迟到的读取都不能覆盖用户选择。
  await start();
  await waitRequest();
  await ssh().fill('fixture-manual');
  await settle();
  assert.equal(await ssh().inputValue(), 'fixture-manual');
  await start();
  await waitRequest();
  await ssh().fill('fixture-manual');
  await ssh().fill('');
  await settle();
  assert.equal(await ssh().inputValue(), '');
  results.push('迟到回填不覆盖手动输入或手动清空');

  // 验证账号变化清除旧凭据，并拒绝旧账号的迟到响应。
  await start();
  await waitRequest();
  await ssh().fill('fixture-old-target');
  await account().fill(otherAccount);
  assert.equal(await ssh().inputValue(), '');
  await waitRequest(otherAccount);
  await settle();
  assert.equal(await ssh().inputValue(), '');
  await settle(otherAccount, { ssh_password: 'fixture-other-ssh', sudo_password: null });
  assert.equal(await ssh().inputValue(), 'fixture-other-ssh');
  results.push('账号变化清理密码并忽略旧账号响应');

  // 验证认证模式变化不保留隐藏 SSH 密码，迟到请求不能跨模式回填。
  await start();
  await waitRequest();
  await ssh().fill('fixture-before-certificate');
  await page.locator('.security-config-auth .ant-segmented-item').filter({ hasText: '证书' }).click();
  assert.equal(await ssh().count(), 0);
  await settle();
  await page.locator('.security-config-auth .ant-segmented-item').filter({ hasText: '密码' }).click();
  assert.equal(await ssh().inputValue(), '');
  await waitRequest();
  await settle();
  assert.equal(await ssh().inputValue(), saved.ssh_password);
  results.push('认证模式变化清理 SSH 密码并撤销旧读取');

  // 验证重置使旧请求失效，新读取可以重新恢复默认账号密码。
  await start();
  await waitRequest();
  const beforeReset = await page.evaluate(() => window.__credentialMock.nextId);
  await page.getByRole('button', { name: /重\s*置/ }).click();
  await page.locator('.security-config-auth summary').click();
  assert.equal(await account().inputValue(), defaultAccount);
  await page.waitForFunction(id => window.__credentialMock.pending.some(item => item.id > id), beforeReset);
  await page.evaluate(({ id, value }) => {
    const mock = window.__credentialMock;
    const stale = mock.pending.filter(item => item.id <= id);
    mock.pending = mock.pending.filter(item => item.id > id);
    stale.forEach(item => item.resolve(value));
  }, { id: beforeReset, value: { ssh_password: 'fixture-stale-reset', sudo_password: null } });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await ssh().inputValue(), '');
  await settle();
  assert.equal(await ssh().inputValue(), saved.ssh_password);
  results.push('重置撤销旧读取并重新读取默认账号凭据');

  // 验证卸载后的响应不污染重新进入的页面，也不触发部署或保存。
  await start();
  await waitRequest();
  await page.getByRole('button', { name: '测试：切换页面' }).click();
  await settle();
  await page.getByRole('button', { name: '测试：切换页面' }).click();
  await page.locator('.security-config-auth summary').click();
  assert.equal(await ssh().inputValue(), '');
  await waitRequest();
  await settle();
  assert.equal(await ssh().inputValue(), saved.ssh_password);
  const calls = await page.evaluate(() => window.__credentialMock.calls);
  assert.equal(calls.some(call => /^(deploy_|save_|clear_)/.test(call.command)), false);
  assert.deepEqual(failures, []);
  results.push('卸载迟到结果隔离，全程不部署或保存');
  await page.screenshot({ path: path.join(output, 'credentials-filled.png'), fullPage: true });
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ results, failures }, null, 2));
  console.log(JSON.stringify({ output, results }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ output, results, failures }));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
