import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 真实页面，虚构 IPC 和凭据；不连接设备，不访问系统凭据库。
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-remote-credentials-'));
const { chromium } = await (process.env.MSKDSP_PLAYWRIGHT_MODULE
  ? import(pathToFileURL(process.env.MSKDSP_PLAYWRIGHT_MODULE)) : import('playwright'));
const { createServer } = await import(pathToFileURL(root + '/node_modules/vite/dist/node/index.js'));
const { default: react } = await import(pathToFileURL(root + '/node_modules/@vitejs/plugin-react/dist/index.js'));
const entry = path.join(output, 'entry.tsx');
const modulePath = name => JSON.stringify('/@fs/' + root + '/src/' + name);
await fs.writeFile(entry, `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {App,ConfigProvider} from 'antd';
import {MemoryRouter} from 'react-router-dom';
import Page from ${modulePath('pages/AdvancedConfig/index.tsx')};
import {PlatformAuthContext} from ${modulePath('auth/platform-auth-context.ts')};
import {AppUpdateContext} from ${modulePath('components/app-update/app-update-context.ts')};
import {LowerUpdateDeploymentContext} from ${modulePath('components/lower-update/lower-update-deployment-context.ts')};
const noop=()=>{}; const asyncNoop=async()=>{};
const deployment={task:null,isRunning:false,hasPendingRemote:false,start:asyncNoop,matchesArchitectureContext:()=>false,clearArchitectureResult:noop,openDetails:noop};
const update={appVersion:'0.8.0',availableUpdate:null,downloadedVersion:null,supersededUpdate:null,updateStatus:{kind:'idle'},isCheckingUpdate:false,isDownloadingUpdate:false,isInstallingUpdate:false,isUpdateDownloaded:false,downloadedBytes:0,totalBytes:null};
function Fixture(){
 const [visible,setVisible]=useState(true);
 const [endpoint,setEndpoint]=useState('https://fixture-platform.example:443');
 return <PlatformAuthContext.Provider value={{controller:{} as any,snapshot:{settings:{grpc_endpoint:endpoint}} as any}}>
 <AppUpdateContext.Provider value={update as any}><LowerUpdateDeploymentContext.Provider value={deployment as any}>
 <button onClick={()=>setVisible(v=>!v)}>测试：切换页面</button>
 <button onClick={()=>setEndpoint('https://other-platform.example:443')}>测试：切换平台</button>
 {visible&&<Page/>}</LowerUpdateDeploymentContext.Provider></AppUpdateContext.Provider></PlatformAuthContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfigProvider><App><MemoryRouter initialEntries={['/?view=lower']}><Fixture/></MemoryRouter></App></ConfigProvider></React.StrictMode>);
`);
const aliases = {};
for (const name of ['react-dom', 'react', 'react-router-dom', 'antd', '@tauri-apps/api', '@ant-design/icons']) aliases[name] = root + '/node_modules/' + name;
const server = await createServer({ configFile: false, root, cacheDir: process.env.MSKDSP_UI_VITE_CACHE || path.join(output, '.vite'), plugins: [react(), {
  name: 'remote-credentials-fixture', configureServer(vite) {
    vite.middlewares.use('/__remote-credentials', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta charset="utf-8"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src=${JSON.stringify('/@fs/' + entry.replaceAll('\\', '/'))}></script></body></html>`);
    });
  },
}], optimizeDeps: { entries: [entry] }, resolve: { alias: aliases }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, output] }, watch: null, hmr: false }, logLevel: 'error' });
await server.listen();
let browser;
let page;
const failures = [];
const results = [];
const pendingRequests = new Set();
const saved = { ssh_password: 'fixture-ssh-secret', sudo_password: 'fixture-sudo-secret', reuse_ssh_password_for_sudo: false };
try {
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'], ...(process.env.MSKDSP_BROWSER_EXECUTABLE ? { executablePath: process.env.MSKDSP_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => failures.push(error.message));
  page.on('request', request => pendingRequests.add(request.url()));
  page.on('requestfinished', request => pendingRequests.delete(request.url()));
  page.on('requestfailed', request => pendingRequests.delete(request.url()));
  await page.addInitScript(() => {
    const mock = window.__remoteCredentialsMock = { calls: [], pending: [], nextId: 0, device: 'fixture-device-a' };
    let callback = 0;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async (command, args) => {
        mock.calls.push({ command, args });
        if (command === 'remote_connection_status') return { remote: true, device_id: mock.device };
        if (command === 'remote_list_devices') return ['fixture-device-a', 'fixture-device-b'].map(device_id => ({ device_id, display_name: device_id }));
        if (command === 'list_cached_lower_updates') return [];
        if (command === 'get_remote_lower_update_credentials') return new Promise((resolve, reject) => {
          mock.pending.push({ id: ++mock.nextId, ...args, resolve, reject });
        });
        return null;
      },
    };
  });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__remote-credentials`;
  const ssh = () => page.getByLabel('SSH 密码', { exact: true });
  const sudo = () => page.getByLabel('独立 sudo 密码', { exact: true });
  const user = () => page.getByLabel('远程设备 SSH 用户', { exact: true });
  const remember = () => page.getByRole('switch', { name: '在本机记住密码', exact: true });
  const waitRequest = async (device = 'fixture-device-a', sshUser = 'megsky') => page.waitForFunction(({device,sshUser}) => window.__remoteCredentialsMock.pending.some(p => p.remote.device_id === device && p.sshUser === sshUser), {device,sshUser});
  const settle = async (value, device = 'fixture-device-a', sshUser = 'megsky') => {
    await page.evaluate(({ value, device, sshUser }) => {
      const mock = window.__remoteCredentialsMock;
      const selected = mock.pending.filter(p => p.remote.device_id === device && p.sshUser === sshUser);
      mock.pending = mock.pending.filter(p => !selected.includes(p));
      selected.forEach(p => p.resolve(value));
    }, {value,device,sshUser});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const assertValue = async (locator, expected) => { await page.waitForFunction(({label,expected}) => document.querySelector(`[aria-label="${label}"]`)?.value === expected, {label: await locator.getAttribute('aria-label'),expected}); assert.equal(await locator.inputValue(),expected); };
  await page.goto(url, {waitUntil:'domcontentloaded',timeout:60000});
  await waitRequest();
  await settle(null);
  assert.equal(await remember().getAttribute('aria-checked'), 'false');
  assert.equal(await ssh().inputValue(), '');
  results.push('新设备默认不记住密码');

  // 重新进入页面模拟已存在的系统凭据，普通页面设置不保存密码。
  await page.getByRole('button', {name:'测试：切换页面'}).click();
  await page.getByRole('button', {name:'测试：切换页面'}).click();
  await waitRequest();
  await settle(saved);
  await assertValue(ssh(), saved.ssh_password);
  await assertValue(sudo(), saved.sudo_password);
  assert.equal(await remember().getAttribute('aria-checked'), 'true');
  await page.getByText('已记住密码', {exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'remote-credentials-saved.png'),fullPage:true});
  results.push('重新进入页面自动恢复 SSH、独立 sudo 及复用选项');

  await page.getByRole('button',{name:'更换密码',exact:true}).click();
  assert.equal(await ssh().inputValue(),'');
  assert.equal(await sudo().inputValue(),'');
  assert.equal(await remember().getAttribute('aria-checked'),'true');
  await ssh().fill('fixture-replacement-ssh');
  await sudo().fill('fixture-replacement-sudo');
  assert.equal(await ssh().inputValue(),'fixture-replacement-ssh');
  assert.equal(await sudo().inputValue(),'fixture-replacement-sudo');
  assert.equal(await page.evaluate(()=>window.__remoteCredentialsMock.calls.some(c=>/^(submit_|install_|upload_|save_remote_)/.test(c.command))),false);
  results.push('更换密码清空 SSH 与独立 sudo 并保留记住选项，允许输入新密码且不触发保存或部署');

  await user().fill('other_user');
  await waitRequest('fixture-device-a','other_user');
  assert.equal(await ssh().inputValue(), '');
  await ssh().fill('fixture-user-edited');
  await settle(saved,'fixture-device-a','other_user');
  assert.equal(await ssh().inputValue(),'fixture-user-edited');
  results.push('用户名切换清空旧密码，迟到读取不覆盖手动输入');

  await user().fill('megsky');
  await waitRequest();
  await page.evaluate(() => { window.__remoteCredentialsMock.device='fixture-device-b'; });
  await waitRequest('fixture-device-b');
  await settle(saved);
  assert.equal(await ssh().inputValue(),'');
  await settle({...saved,ssh_password:'fixture-device-b-secret',reuse_ssh_password_for_sudo:true},'fixture-device-b');
  await assertValue(ssh(),'fixture-device-b-secret');
  assert.equal(await sudo().count(),0);
  results.push('设备切换读取各自凭据，旧设备迟到响应被隔离');

  await page.getByRole('button',{name:'清除已保存密码',exact:true}).click();
  await page.waitForFunction(() => window.__remoteCredentialsMock.calls.some(c=>c.command==='clear_remote_lower_update_credentials'));
  const clear = await page.evaluate(() => window.__remoteCredentialsMock.calls.find(c=>c.command==='clear_remote_lower_update_credentials'));
  assert.equal(clear.args.remote.device_id,'fixture-device-b');
  assert.equal(clear.args.sshUser,'megsky');
  assert.equal(await ssh().inputValue(),'');
  assert.equal(await remember().getAttribute('aria-checked'),'false');
  results.push('清除仅指定设备和用户，并清空当前密码');

  await page.getByRole('button',{name:'测试：切换平台'}).click();
  await waitRequest('fixture-device-b');
  const pendingPlatform = await page.evaluate(()=>window.__remoteCredentialsMock.pending.map(p=>p.remote.endpoint));
  assert.equal(pendingPlatform.includes('https://other-platform.example:443'),true);
  await settle(saved,'fixture-device-b');
  await assertValue(ssh(),saved.ssh_password);
  await remember().click();
  await page.waitForFunction(() => window.__remoteCredentialsMock.calls.filter(c=>c.command==='clear_remote_lower_update_credentials').length===2);
  const lastClear = await page.evaluate(()=>window.__remoteCredentialsMock.calls.filter(c=>c.command==='clear_remote_lower_update_credentials').at(-1));
  assert.equal(lastClear.args.remote.endpoint,'https://other-platform.example:443');
  assert.equal(await remember().getAttribute('aria-checked'),'false');
  results.push('平台切换独立读取，关闭记住立即删除对应保存记录');

  const local = await page.evaluate(()=>JSON.stringify({...localStorage}));
  for(const secret of [saved.ssh_password,saved.sudo_password,'fixture-device-b-secret','fixture-user-edited','fixture-replacement-ssh','fixture-replacement-sudo']) assert.equal(local.includes(secret),false);
  assert.equal(await page.evaluate(()=>window.__remoteCredentialsMock.calls.some(c=>/^(submit_|install_|upload_|save_remote_)/.test(c.command))),false);
  assert.deepEqual(failures,[]);
  results.push('全程无部署及保存调用，普通存储不含密码');
  await page.screenshot({path:path.join(output,'remote-credentials.png'),fullPage:true});
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify({results,failures},null,2));
  console.log(JSON.stringify({output,results},null,2));
} catch(error) {
  await page?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});
  console.error(JSON.stringify({output,results,failures,pendingRequests:[...pendingRequests]}));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
