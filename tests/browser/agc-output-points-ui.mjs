import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 挂载真实 AGC 页面，以内存接口验证隐藏输出配置后的保存与路由，不访问设备。
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-agc-outputs-'));
const { chromium } = await (process.env.MSKDSP_PLAYWRIGHT_MODULE ? import(pathToFileURL(process.env.MSKDSP_PLAYWRIGHT_MODULE)) : import('playwright'));
const { createServer } = await import(pathToFileURL(root + '/node_modules/vite/dist/node/index.js'));
const { default: react } = await import(pathToFileURL(root + '/node_modules/@vitejs/plugin-react/dist/index.js'));
const signal = (tag, unit = 'kW', scale_decimal = '1', offset_decimal = '0') => ({ tag, unit, scale: Number(scale_decimal), offset: Number(offset_decimal), scale_decimal, offset_decimal });
const historicalOutputs = {
  p_total_meas: signal('历史实测', 'MW', '0.12345678901234567890', '-0.00000000000000000001'),
  p_total_target: signal('历史目标', 'W', '1000.00000000000000000001', '3.00000000000000000001'),
  p_total_error: signal('历史偏差', 'kW', '1.00000000000000000001', '-2.00000000000000000001'),
};
const historical = { group_name: '历史控制组', p_cmd: { signal: signal('历史总控'), mode: 1, delta_base: 0, base_tag: '' }, control_mode: 1, calculation_execution_period_seconds: 1, command_control_period_seconds: 4, strategy: { strategy_type: 'weighted' }, members: [], outputs: historicalOutputs };
const endpoint = (module_name, conn_name, tag) => ({ module_name, conn_name, tag });
const oldRoutes = ['发送甲', '发送乙'].map(tag => ({ src: endpoint('AGC', '历史控制组', '历史实测'), dst: endpoint('IEC104', '主站连接', tag) }));
const entry = path.join(output, 'entry.tsx');
await fs.writeFile(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App, ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import ${JSON.stringify('/@fs/' + root + '/src/theme/modal.css')};
import { darkTheme } from ${JSON.stringify('/@fs/' + root + '/src/theme/dark.ts')};
import { AppModeContext } from ${JSON.stringify('/@fs/' + root + '/src/offline/app-mode-context.ts')};
import AGC from ${JSON.stringify('/@fs/' + root + '/src/pages/AGC/index.tsx')};
createRoot(document.getElementById('root')).render(<ConfigProvider theme={darkTheme}><App><AppModeContext.Provider value={{can:()=>true,mode:'online'}}><MemoryRouter><AGC/></MemoryRouter></AppModeContext.Provider></App></ConfigProvider>);
`);
const aliases = Object.fromEntries(['react-dom', 'react', 'antd', 'react-router-dom', '@tauri-apps/api', '@ant-design/icons'].map(name => [name, root + '/node_modules/' + name]));
const server = await createServer({ configFile: false, root, cacheDir: path.join(output, '.vite'), plugins: [react(), {
  name: 'agc-output-fixture',
  load(id) {
    if (id.replaceAll('\\', '/') !== root + '/src/adapters/index.ts') return;
    return `
    window.agcFixture={groups:[{config:${JSON.stringify(historical)},state:1,conn_id:10,default_points:[]}],routes:${JSON.stringify(oldRoutes)},saves:[],routeWrites:[],routeDeletes:[]};
    const fixture=()=>window.agcFixture;
    export const api={
      agcListGroups:async()=>structuredClone(fixture().groups),
      agcGetGroup:async name=>structuredClone(fixture().groups.find(g=>g.config.group_name===name)),
      agcUpsertGroup:async(config,createOnly)=>{const f=fixture();f.saves.push(structuredClone({config,createOnly}));const existing=f.groups.find(g=>g.config.group_name===config.group_name);if(existing)existing.config=structuredClone(config);else f.groups.push({config:structuredClone(config),state:1,conn_id:20,default_points:[]});},
      dcListConnections:async()=>[{module_name:'IEC104',conn_name:'主站连接',conn_id:100}],
      dcGetConnTags:async()=>({tags:['发送甲','发送乙','发送丙']}),
      dcListRoutes:async()=>structuredClone(fixture().routes),
      dcGetLatest:async()=>[],dcGetSourceLatest:async()=>[],
      dcUpsertRoutes:async routes=>{fixture().routeWrites.push(structuredClone(routes));fixture().routes.push(...structuredClone(routes));},
      dcDeleteRoutes:async routes=>{fixture().routeDeletes.push(structuredClone(routes));fixture().routes=fixture().routes.filter(old=>!routes.some(route=>JSON.stringify(route)===JSON.stringify(old)));}
    };`;
  },
  configureServer(vite) {
    vite.middlewares.use('/__agc-outputs', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta charset="utf-8"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><style>html,body,#root{margin:0;height:100%;background:#1e1e1e;color:#eee}</style></head><body><div id="root"></div><script type="module" src=${JSON.stringify('/@fs/' + entry.replaceAll('\\', '/'))}></script></body></html>`);
    });
  },
}], resolve: { alias: aliases }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, output] }, watch: null, hmr: false }, logLevel: 'error' });
let browser, page;
const results = [], errors = [];
const dialog = () => page.getByRole('dialog', { name: /AGC 控制组/ });
const saveButton = () => dialog().getByRole('button', { name: '保存控制组并建立路由', exact: true });
const values = () => page.evaluate(() => structuredClone(window.agcFixture));
async function outputsHidden() {
  assert.equal(await dialog().getByText('派生输出点', { exact: true }).isVisible(), false, '不再显示派生输出点手工配置区');
  for (const label of ['总有功测量输出', '总有功目标输出', '总有功偏差输出']) {
    assert.equal(await dialog().getByRole('combobox', { name: label + '发送目标', exact: true }).count(), 1, '仍可配置' + label);
  }
  for (const label of ['单位', '缩放系数', '偏移量']) {
    assert.equal(await dialog().locator('.control-config-section--outputs').getByText(label, { exact: true }).count(), 0, '输出区不再显示' + label);
  }
}
async function save() {
  const before = (await values()).saves.length;
  await saveButton().click();
  await page.waitForFunction(count => window.agcFixture.saves.length === count + 1, before);
  await dialog().waitFor({ state: 'hidden' });
}
async function scenario(name, run) {
  try { await run(); results.push({ name, status: 'passed' }); }
  catch (error) { results.push({ name, status: 'failed', error: String(error) }); throw error; }
}
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'], ...(process.env.MSKDSP_BROWSER_EXECUTABLE ? { executablePath: process.env.MSKDSP_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__agc-outputs`);
  // 新建只显示发送目标，实际保存仍带有完整的三个默认输出。
  await scenario('新增保留默认三点和发送目标', async () => {
    await page.getByRole('button', { name: /新增控制组/ }).click();
    await dialog().waitFor();
    await outputsHidden();
    await dialog().getByPlaceholder('agc_group_1', { exact: true }).fill('新增验收组');
    await save();
    const saved = (await values()).saves.at(-1);
    assert.equal(saved.createOnly, true);
    assert.deepEqual(saved.config.outputs, { p_total_meas: signal('AGC总有功测量点'), p_total_target: signal('AGC总有功目标点'), p_total_error: signal('AGC总有功偏差点') });
  });
  // 历史多目标路由与全部精确输出参数在修改其他字段后保持。
  await scenario('历史自定义输出和多目标路由保持', async () => {
    await page.getByText('历史控制组', { exact: true }).first().click();
    await page.getByRole('button', { name: /编\s*辑/ }).click();
    await outputsHidden();
    await page.waitForFunction(() => document.querySelectorAll('.ant-select-selection-item').length >= 2);
    assert.equal(await dialog().getByText('IEC104 / 主站连接 / 发送甲', { exact: true }).count(), 1);
    assert.equal(await dialog().getByText('IEC104 / 主站连接 / 发送乙', { exact: true }).count(), 1);
    await save();
    const current = await values();
    assert.equal(current.saves.at(-1).createOnly, false);
    assert.deepEqual(current.saves.at(-1).config.outputs, historicalOutputs);
    assert.deepEqual(current.routes, oldRoutes);
    assert.deepEqual(current.routeWrites, []);
    assert.deepEqual(current.routeDeletes, []);
  });
  // 明确添加发送目标时以既有内部 tag 建立输出路由，保留旧目标。
  await scenario('修改发送目标不改历史输出且方向正确', async () => {
    await page.getByRole('button', { name: /编\s*辑/ }).click();
    const select = dialog().getByRole('combobox', { name: '总有功测量输出发送目标', exact: true });
    await select.click();
    const listId = await select.getAttribute('aria-controls');
    await page.locator(`[id=${JSON.stringify(listId)}]`).locator('..').locator('.ant-select-item-option-content').filter({ hasText: 'IEC104 / 主站连接 / 发送丙' }).click();
    await select.press('Escape');
    await save();
    const current = await values();
    assert.deepEqual(current.saves.at(-1).config.outputs, historicalOutputs);
    assert.deepEqual(current.routeWrites.at(-1), [...oldRoutes, { src: endpoint('AGC', '历史控制组', '历史实测'), dst: endpoint('IEC104', '主站连接', '发送丙') }]);
    assert.deepEqual(current.routeDeletes, []);
  });
  // 紧凑窗口仍保留三个映射入口与可见底部保存操作。
  await scenario('紧凑窗口无重复输出配置区', async () => {
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.getByRole('button', { name: /编\s*辑/ }).click();
    await outputsHidden();
    await saveButton().waitFor({ state: 'visible' });
    // 入场缩放动画会暂时改变屏幕坐标；布局验收须在动画完成后测量。
    await dialog().evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    const rect = await saveButton().boundingBox();
    assert.ok(rect.y >= 0 && rect.y + rect.height <= 720, '紧凑窗口保存按钮在视口内');
    await dialog().getByRole('combobox', { name: '总有功偏差输出发送目标', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'agc-output-mappings-720.png') });
    assert.deepEqual(errors, []);
  });
  // 历史上未配置的输出不能因隐藏字段而自动创建点位或发送映射。
  await scenario('历史空输出不自动补齐', async () => {
    await dialog().getByRole('button', { name: /取\s*消/ }).click();
    await dialog().waitFor({ state: 'hidden' });
    await page.evaluate(() => {
      const config = window.agcFixture.groups.find(group => group.config.group_name === '历史控制组').config;
      config.outputs.p_total_target = null;
      config.outputs.p_total_error = { tag: '', unit: 'kW', scale: 1, offset: 0, scale_decimal: '1', offset_decimal: '0' };
    });
    await page.locator('.ant-card-head').filter({ hasText: '控制组列表' }).getByRole('button', { name: 'reload', exact: true }).click();
    await page.getByRole('button', { name: /编\s*辑/ }).click();
    assert.equal(await dialog().getByRole('combobox', { name: '总有功目标输出发送目标', exact: true }).count(), 0);
    assert.equal(await dialog().getByRole('combobox', { name: '总有功偏差输出发送目标', exact: true }).count(), 0);
    assert.equal(await dialog().getByRole('combobox', { name: '总有功测量输出发送目标', exact: true }).count(), 1);
    const before = await values();
    await save();
    const current = await values();
    assert.deepEqual(current.saves.at(-1).config.outputs, { p_total_meas: historicalOutputs.p_total_meas, p_total_target: null, p_total_error: null });
    assert.deepEqual(current.routes, before.routes);
    assert.deepEqual(current.routeWrites, before.routeWrites);
    assert.deepEqual(current.routeDeletes, before.routeDeletes);
    assert.deepEqual(errors, []);
  });
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  await fs.writeFile(path.join(output, 'failure.txt'), String(error) + '\n' + (page ? await page.locator('body').innerText() : ''));
  throw error;
} finally {
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ output, results, errors }, null, 2));
  await browser?.close();
  await server.close();
}
