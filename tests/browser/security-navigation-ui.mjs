import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer as createPortProbe } from 'node:net';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 真实 MainLayout、AntD Menu、生产 router 及三个纵密页面；仅隔离无关的顶部控件和运行模式。
// IPC 完全虚构，禁止访问 localhost 以外的地址；不登录、不检查网络、不下发配置。
// --baseline 在内存加载指定提交的 MainLayout，不修改生产文件。
// SECURITY_NAVIGATION_BASELINE_REF 可指定拆分前提交，默认 HEAD 便于实现前确认业务红测。
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const baseline = process.argv.includes('--baseline');
const baselineRef = process.env.SECURITY_NAVIGATION_BASELINE_REF || 'HEAD';
const baselineLayout = baseline ? execFileSync('git', ['show', `${baselineRef}:src/layouts/MainLayout.tsx`], { cwd: root, encoding: 'utf8' }) : null;
const output = process.env.SECURITY_NAVIGATION_UI_OUTPUT || await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-security-navigation-'));
await fs.mkdir(output, { recursive: true });
const { chromium } = await (process.env.MSKDSP_PLAYWRIGHT_MODULE
  ? import(pathToFileURL(process.env.MSKDSP_PLAYWRIGHT_MODULE)) : import('playwright'));
const { createServer } = await import(pathToFileURL(root + '/node_modules/vite/dist/node/index.js'));
const { default: react } = await import(pathToFileURL(root + '/node_modules/@vitejs/plugin-react/dist/index.js'));
const entry = path.join(output, 'entry.tsx');
await fs.writeFile(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App, ConfigProvider } from 'antd';
import { RouterProvider } from 'react-router-dom';
import zhCN from 'antd/locale/zh_CN';
import { darkTheme } from ${JSON.stringify('/@fs/' + root + '/src/theme/dark.ts')};
import { router } from ${JSON.stringify('/@fs/' + root + '/src/router.tsx')};
import ${JSON.stringify('/@fs/' + root + '/src/index.css')};
window.__securityFixtureRouter = router;
createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfigProvider theme={darkTheme} locale={zhCN}><App style={{height:'100%'}}><RouterProvider router={router} /></App></ConfigProvider></React.StrictMode>);
`);

const headerModules = new Set([
  '../components/control/ControlHeaderViewSwitcher',
  '../components/data-bus/DataBusHeaderViewSwitcher',
  '../components/app-update/SoftwareUpdateHeaderViewSwitcher',
  '../components/lower-update/LowerUpdateDeploymentUi',
  '../components/protocol/ProtocolHeaderViewSwitcher',
  '../offline/ui/OfflineModeControls.tsx',
  '../auth/PlatformAccountControl',
]);
const aliases = {};
for (const name of ['react-dom', 'react', 'react-router-dom', 'antd', '@tauri-apps/api', '@tauri-apps/plugin-dialog', '@ant-design/icons']) aliases[name] = root + '/node_modules/' + name;
// Vite 将 port: 0 当成默认端口；先让系统分配端口，再严格使用它，避免并行 fixture 互相串扰。
const portProbe = createPortProbe();
await new Promise((resolve, reject) => { portProbe.once('error', reject); portProbe.listen(0, '127.0.0.1', resolve); });
const port = portProbe.address().port;
await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
const server = await createServer({
  configFile: false, root, plugins: [{
    name: 'security-navigation-fixture', enforce: 'pre',
    resolveId(source, importer) {
      if (!importer?.replaceAll('\\', '/').endsWith('/src/layouts/MainLayout.tsx')) return null;
      if (headerModules.has(source)) return '\0security-navigation-header';
      if (source === '../offline/app-mode-context.ts') return '\0security-navigation-app-mode';
      if (source === '../components/app-update/app-update-context') return '\0security-navigation-app-update';
      return null;
    },
    load(id) {
      if (baselineLayout && id.replaceAll('\\', '/').endsWith('/src/layouts/MainLayout.tsx')) return baselineLayout;
      if (id === '\0security-navigation-header') return 'export default function HeaderFixture(){return null} export const LowerUpdateDeploymentHeader=HeaderFixture; export const PlatformAccountControl=HeaderFixture;';
      if (id === '\0security-navigation-app-mode') return 'const can=()=>true; export const useAppMode=()=>({can});';
      if (id === '\0security-navigation-app-update') return 'export const useAppUpdate=()=>({hasAvailableUpdate:false});';
      return null;
    },
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (!['/', '/alerts-logs', '/security-login', '/security-access', '/security-config'].includes(req.url?.split('?')[0])) return next();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><html><head><meta charset="utf-8"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><style>html,body,#root{height:100%;margin:0}body{background:#1e1e1e;color:white;font-family:Microsoft YaHei,sans-serif}</style></head><body><div id="root"></div><script type="module" src=${JSON.stringify('/@fs/' + entry.replaceAll('\\', '/'))}></script></body></html>`);
      });
    },
  }, react()],
  resolve: { alias: aliases },
  server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [root, output] }, watch: null, hmr: false },
  logLevel: 'error',
});
await server.listen();
const address = server.httpServer.address();
const origin = `http://127.0.0.1:${address.port}`;
let browser;
let page;
const failures = [];
const results = [];
const pages = [
  { path: '/security-login', label: '登录', title: '纵密登录' },
  { path: '/security-access', label: '访问通路', title: '纵密访问通路' },
  { path: '/security-config', label: 'DSP 网络配置', title: 'DSP 纵密网络配置' },
];
const parent = () => page.locator('.main-layout-sider-menu > .ant-menu-submenu').filter({ has: page.locator('.ant-menu-submenu-title').filter({ hasText: /^纵密$/ }) });
const parentTitle = () => parent().locator(':scope > .ant-menu-submenu-title');
const menuItem = label => parent().getByRole('menuitem', { name: label, exact: true });
const pathname = () => new URL(page.url()).pathname;
const clearCalls = () => page.evaluate(() => { window.__securityNavigationMock.calls = []; });
const calls = () => page.evaluate(() => window.__securityNavigationMock.calls);
async function capture(name) {
  await page.mouse.move(1400, 24);
  await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true, animations: 'disabled' });
}

async function assertPage(expected) {
  await page.getByRole('heading', { level: 1, name: expected.title, exact: true }).waitFor();
  assert.equal(pathname(), expected.path);
  assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1, '每个独立页面只有一个主标题');
  assert.equal(await page.locator('.ant-layout-header .protocol-header-title-text').innerText(), `纵密 · ${expected.label}`);
  assert.equal(await parentTitle().getAttribute('aria-expanded'), 'true', '当前纵密子路由展开父项');
  assert.equal(await parent().locator('.ant-menu-item-selected').innerText(), expected.label);
  assert.equal(await page.locator('.main-layout-sider-menu .ant-menu-item-selected').count(), 1);
}

async function goDirect(expected) {
  await page.goto(origin + expected.path, { waitUntil: 'commit', timeout: 15000 });
  await assertPage(expected);
}

try {
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'], ...(process.env.MSKDSP_BROWSER_EXECUTABLE ? { executablePath: process.env.MSKDSP_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => failures.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.addInitScript(() => {
    const mock = window.__securityNavigationMock = { calls: [], unexpected: [] };
    let callback = 0;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => ++callback, unregisterCallback: () => {},
      invoke: async (command, args) => {
        mock.calls.push({ command, args });
        if (command === 'remote_list_devices') return [{ device_id: 'fixture-dsp', display_name: '测试 DSP', online: true }];
        if (command === 'get_vertical_security_access_capabilities') return { remote_ip_available: false, remote_ip_reason: '虚构远程网络能力未接入' };
        if (command === 'get_vertical_security_login_capabilities') return { direct_available: true, remote_available: false, password_change_available: false, reason: '虚构登录能力' };
        if (command === 'get_vertical_security_certificate_profile') return { configured: false, client_certificate_path: null, trust_certificate_path: null, server_name: null };
        if (command === 'cancel_vertical_security_login' || command === 'logout_vertical_security' || command === 'close_vertical_security_access') return null;
        mock.unexpected.push(command);
        throw new Error('导航回归不应调用 IPC: ' + command);
      },
    };
  });
  await page.goto(origin + '/alerts-logs', { waitUntil: 'commit', timeout: 15000 });
  await page.getByText('告警与日志功能开发中', { exact: true }).waitFor({ timeout: 45000 });
  assert.equal(await parent().count(), 1, '侧栏应只有一个可展开的纵密父项');
  assert.equal(await parentTitle().getAttribute('aria-expanded'), 'false');
  await parentTitle().click();
  await menuItem('登录').waitFor();
  assert.equal(pathname(), '/alerts-logs', '点击纵密父项只展开，不跳转');
  assert.equal(await parent().getByRole('menuitem').count(), 4, '父项加三个子项');
  await parentTitle().click();
  assert.equal(await parentTitle().getAttribute('aria-expanded'), 'false');
  assert.equal(pathname(), '/alerts-logs', '收起纵密父项不跳转');
  await parentTitle().click();
  results.push('真实侧栏只有一个纵密分组和三个子项，父项展开/收起不更改路由');

  await clearCalls();
  await menuItem('登录').click();
  await assertPage(pages[0]);
  await page.getByLabel('纵密用户名', { exact: true }).waitFor();
  await page.waitForFunction(() => window.__securityNavigationMock.calls.some(call => call.command === 'get_vertical_security_certificate_profile'));
  assert.equal(await page.getByRole('heading', { name: '网络连接检查', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /检查直连|检查远程通路|配置纵密访问通路/ }).count(), 0);
  assert.equal((await calls()).some(call => /^(get_vertical_security_access_capabilities|check_vertical_security_access|configure_vertical_security_access_path)$/.test(call.command)), false);
  await capture('login');
  results.push('登录子页真实表单、选中状态及标题正确，不挂载或加载网络检查和通路配置');

  await clearCalls();
  await menuItem('访问通路').click();
  await assertPage(pages[1]);
  await page.getByRole('button', { name: /检查直连/ }).waitFor();
  await page.waitForFunction(() => window.__securityNavigationMock.calls.some(call => call.command === 'get_vertical_security_access_capabilities'));
  assert.equal(await page.getByLabel('纵密用户名', { exact: true }).count(), 0);
  assert.equal(await page.locator('.security-login-workbench').count(), 0);
  assert.equal((await calls()).some(call => /^(get_vertical_security_login_capabilities|get_vertical_security_certificate_profile|login_vertical_security)$/.test(call.command)), false);
  await capture('access');
  results.push('访问通路子页真实网络检查、选中状态及标题正确，不挂载认证或加载登录能力及证书');

  await clearCalls();
  await menuItem('网络配置').click();
  await assertPage(pages[2]);
  await page.getByRole('heading', { name: '配置目标', exact: true }).waitFor();
  await page.getByRole('heading', { name: '纵密业务地址', exact: true }).waitFor();
  assert.equal(await page.getByLabel('纵密用户名', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /检查直连/ }).count(), 0);
  assert.equal((await calls()).some(call => /^(get_vertical_security_login_capabilities|get_vertical_security_certificate_profile|get_vertical_security_access_capabilities)$/.test(call.command)), false);
  await capture('config');
  results.push('网络配置子页保留真实业务地址表单，独立标题与选中状态正确');

  for (const expected of pages) await goDirect(expected);
  results.push('直接进入三个生产子路由均显示正确页面、选中子项并自动展开纵密分组');

  await parentTitle().click();
  assert.equal(await parentTitle().getAttribute('aria-expanded'), 'false', '当前纵密页面允许手动收起');
  assert.equal(pathname(), '/security-config');
  // 使用生产 router 的外部导航入口，覆盖侧栏以外的跨页跳转和 POP 历史事件。
  await page.evaluate(() => window.__securityFixtureRouter.navigate('/alerts-logs'));
  await page.getByText('告警与日志功能开发中', { exact: true }).waitFor();
  assert.equal(pathname(), '/alerts-logs');
  await page.goBack();
  await assertPage(pages[2]);
  await page.goForward();
  await page.getByText('告警与日志功能开发中', { exact: true }).waitFor();
  if (await parentTitle().getAttribute('aria-expanded') === 'true') await parentTitle().click();
  await page.evaluate(() => window.__securityFixtureRouter.navigate('/security-access'));
  await assertPage(pages[1]);
  await page.goBack();
  await page.getByText('告警与日志功能开发中', { exact: true }).waitFor();
  if (await parentTitle().getAttribute('aria-expanded') === 'true') await parentTitle().click();
  await page.goForward();
  await assertPage(pages[1]);
  results.push('非纵密路由和纵密子页之间跳转、浏览器前进/返回均同步页面、选中状态及父项展开');

  await parentTitle().click();
  await page.locator('.ant-layout-sider-trigger').click();
  await page.locator('.ant-layout-sider-collapsed').waitFor();
  await page.waitForFunction(() => document.querySelector('.ant-layout-sider')?.getBoundingClientRect().width <= 81);
  assert.equal(pathname(), '/security-access');
  await capture('sidebar-collapsed');
  await page.locator('.ant-layout-sider-trigger').click();
  await page.locator('.ant-layout-sider:not(.ant-layout-sider-collapsed)').waitFor();
  await page.waitForFunction(() => document.querySelector('.ant-layout-sider')?.getBoundingClientRect().width >= 199);
  await assertPage(pages[1]);
  await menuItem('登录').click();
  await assertPage(pages[0]);
  results.push('侧栏收起再展开后恢复当前纵密分组，并能继续进入其他子页');

  // 在真实侧栏占用宽度下检查居中、控件宽度、主辅区域及窄屏堆叠。
  for (const width of [2560, 1440, 1024, 736]) {
    await page.setViewportSize({ width, height: width === 2560 ? 1349 : 1100 });
    for (const expected of pages) {
      await menuItem(expected.label).click();
      await assertPage(expected);
      const content = page.locator('.ant-layout-content');
      const heading = await page.getByRole('heading', { level: 1, name: expected.title }).boundingBox();
      const workbench = page.locator('.security-access-columns, .security-config-card');
      const workbenchBox = await workbench.boundingBox();
      const frame = page.locator('.security-login-frame, .security-access-frame, .security-config-workspace');
      const frameBox = await frame.boundingBox();
      const contentBox = await content.boundingBox();
      const contentWidth = await content.evaluate(element => element.clientWidth);
      assert.equal(await content.evaluate(element => element.scrollWidth <= element.clientWidth + 2), true, `${width}px ${expected.label}内容区无横向溢出`);
      assert.ok(Math.abs(frameBox.x + frameBox.width / 2 - contentBox.x - contentWidth / 2) <= 2, `${width}px ${expected.label}工作区在侧栏之外的主内容区居中`);
      assert.ok(heading.y + heading.height < workbenchBox.y, '页面标题始终在操作工作区上方');
      assert.ok(Math.abs(heading.x - frameBox.x) <= 1, '标题与居中工作区左侧对齐');
      if (expected.path === '/security-login') {
        const controls = await page.locator('.security-login-mode-controls').boundingBox();
        const submit = await page.getByRole('button', { name: /登录纵密/ }).boundingBox();
        const certificate = await page.locator('.security-login-certificate > summary').boundingBox();
        const auth = await page.locator('.security-login-auth').boundingBox();
        const progress = await page.locator('.security-login-progress').boundingBox();
        const username = await page.getByLabel('纵密用户名', { exact: true }).boundingBox();
        assert.ok(heading.y + heading.height < controls.y, '连接方式放在页面标题下方');
        assert.ok(submit.y + submit.height <= certificate.y, '登录按钮紧跟表单，位于高级证书设置之前');
        assert.ok(username.width <= 500, '宽屏不拉长登录输入框');
        assert.equal(await page.locator('.security-login-progress').evaluate(element => element.tagName), 'ASIDE', '进度作为轻量辅助区');
        if (width >= 1440) {
          assert.ok(progress.x >= auth.x + auth.width, '宽屏进度在认证区旁边');
          assert.ok(Math.abs(frameBox.y + frameBox.height / 2 - contentBox.y - contentBox.height / 2) <= 2, '宽屏登录整体在主内容区垂直居中');
        } else {
          assert.ok(progress.y >= auth.y + auth.height, '可用宽度不足时进度堆叠到认证区下方');
        }
      } else if (expected.path === '/security-access') {
        const actions = page.locator('.security-access-actions');
        const route = await page.locator('.security-access-path').boundingBox();
        const check = await page.locator('.security-access-connect').boundingBox();
        const nodes = await page.locator('.security-access-path li').evaluateAll(elements => elements.map(element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y }; }));
        assert.equal(await actions.getByRole('button', { name: /检查直连|配置纵密访问通路/ }).count(), 2, '配置通路与检查在同一操作区');
        assert.ok(route.y + route.height <= check.y, '路径概览放在检查工作区上方');
        if (width >= 1024) assert.ok(nodes.every(node => Math.abs(node.y - nodes[0].y) <= 1), '宽屏路径节点横向展示');
        else assert.ok(nodes[1].y > nodes[0].y, '窄屏路径节点竖向堆叠');
      } else {
        const actions = await page.locator('.security-config-actions').boundingBox();
        const target = await page.locator('.security-config-target-card').boundingBox();
        const local = await page.locator('#security-config-local-title').boundingBox();
        const remote = await page.locator('#security-config-remote-title').boundingBox();
        assert.ok(target.y + target.height < workbenchBox.y, '目标认证与业务地址分成两块卡片');
        if (width >= 1024) assert.ok(Math.abs(local.y - remote.y) <= 1, '宽屏本端和对端并排');
        else assert.ok(remote.y > local.y, '窄屏本端和对端上下堆叠');
        assert.ok(workbenchBox.y + workbenchBox.height - actions.y - actions.height < 48, '网络配置卡片底部不再保留撑满高度造成的大片空白');
      }
      await capture(`layout-${expected.path.slice(1)}-${width}`);
    }
  }
  results.push('真实侧栏下三页在2560/1440/1024/736px工作区居中；登录限宽且主辅分明，通路横向概览，网络配置分区，窄屏实际堆叠');

  // 展开较长表单后仍使用主内容区滚动，不以居中布局裁切底部操作。
  await page.setViewportSize({ width: 820, height: 560 });
  for (const expected of [pages[0], pages[2]]) {
    await goDirect(expected);
    const summary = page.locator(expected.path === '/security-login' ? '.security-login-certificate > summary' : '.security-config-auth > summary');
    await summary.click();
    const action = page.getByRole('button', { name: expected.path === '/security-login' ? '应用连接证书' : /应用 DSP 网络配置/ });
    await action.scrollIntoViewIfNeeded();
    const content = page.locator('.ant-layout-content');
    const contentBox = await content.boundingBox();
    const actionBox = await action.boundingBox();
    assert.equal(await content.evaluate(element => element.scrollHeight > element.clientHeight && element.scrollTop > 0), true, '长表单通过主内容区滚动');
    assert.ok(actionBox.y >= contentBox.y && actionBox.y + actionBox.height <= contentBox.y + contentBox.height + 1, '展开后的底部操作可以完整滚入视口');
    assert.equal(await content.evaluate(element => element.scrollWidth <= element.clientWidth + 2), true, '高级表单展开后无横向溢出');
    await capture(`expanded-${expected.path.slice(1)}-820`);
  }
  results.push('820×560窗口展开证书或SSH认证后，表单自然增高，底部操作可滚入视口且无横向溢出');

  await page.setViewportSize({ width: 1440, height: 1100 });
  for (const expected of [pages[0], pages[1]]) {
    await goDirect(expected);
    await page.locator('.ant-segmented-item').filter({ hasText: '平台远程' }).click();
    await page.getByRole('combobox', { name: '目标 DSP', exact: true }).waitFor();
    const content = page.locator('.ant-layout-content');
    assert.equal(await content.evaluate(element => element.scrollWidth <= element.clientWidth + 2), true, '远程设备选择和不可用提示不撑破居中布局');
    await capture(`remote-${expected.path.slice(1)}-1440`);
  }
  results.push('登录和访问通路远程模式的设备选择与不可用提示保持正常布局');

  assert.deepEqual(await page.evaluate(() => window.__securityNavigationMock.unexpected), []);
  assert.equal((await calls()).some(call => /^(login_vertical_security|check_vertical_security_access|configure_vertical_security_access_path|deploy_vertical_security_script)$/.test(call.command)), false);
  assert.deepEqual(failures, []);
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ baseline, results, failures }, null, 2));
  console.log(JSON.stringify({ output, baseline, results }, null, 2));
} catch (error) {
  failures.push(error.message);
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ baseline, results, failures, url: page?.url() }, null, 2));
  console.error(JSON.stringify({ output, baseline, failures, url: page?.url() }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
