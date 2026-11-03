import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 挂载真实 AGC 页，模拟独立运行缓存与控制接口，不访问设备。
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-agc-overview-'));
const { chromium } = await (process.env.MSKDSP_PLAYWRIGHT_MODULE ? import(pathToFileURL(process.env.MSKDSP_PLAYWRIGHT_MODULE)) : import('playwright'));
const { createServer } = await import(pathToFileURL(root + '/node_modules/vite/dist/node/index.js'));
const { default: react } = await import(pathToFileURL(root + '/node_modules/@vitejs/plugin-react/dist/index.js'));
const signal = tag => ({ tag, unit: 'kW', scale: 1, offset: 0, scale_decimal: '1', offset_decimal: '0' });
const member = (name, capacity) => ({ member_name: name, controllable: true, capacity_kw: capacity, capacity_kw_decimal: String(capacity), weight: capacity, weight_decimal: String(capacity), min_kw: 0, min_kw_decimal: '0', max_kw: capacity, max_kw_decimal: String(capacity), p_meas: signal(name + '_实测'), p_set: { signal: signal(name + '_设定'), mode: 1, delta_base: 0, base_tag: '' } });
const group = { conn_id: 10, state: 2, last_error: '', function_enabled: true, remote_enabled: true, default_points: [{ kind: 7, tag: 'AGC功能投入', name: 'AGC功能投入' }, { kind: 8, tag: 'AGC远方操作', name: 'AGC远方操作' }], config: { group_name: '总览控制组', control_mode: 1, calculation_execution_period_seconds: 1, command_control_period_seconds: 4, p_cmd: { signal: signal('总控输入'), mode: 1, delta_base: 0, base_tag: '' }, strategy: { strategy_type: 'weighted' }, members: [member('#1-1', 150), member('#1-2', 110)], outputs: { p_total_meas: signal('总有功实测'), p_total_target: signal('实际总目标'), p_total_error: signal('总有功偏差') } } };
const point = value => ({ value: { type: 'Decimal', value }, age: 0, quality: 1 });
const initialPoints = { 总控输入: point('999'), 总有功实测: point('57.71'), 实际总目标: point('100'), 总有功偏差: point('42.29'), '#1-1_实测': point('57.67'), '#1-1_设定': point('57.69'), '#1-2_实测': point('0.04'), '#1-2_设定': point('42.31'), AGC功能投入: { value: { type: 'Bool', value: true }, age: 45000, quality: 1 }, AGC远方操作: { value: { type: 'Bool', value: true }, age: 50000, quality: 3 } };
const entry = path.join(output, 'entry.tsx');
await fs.writeFile(entry, `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {App,ConfigProvider} from 'antd';
import {MemoryRouter} from 'react-router-dom';
import ${JSON.stringify('/@fs/' + root + '/src/index.css')};
import ${JSON.stringify('/@fs/' + root + '/src/components/protocol/protocol-page.css')};
import ${JSON.stringify('/@fs/' + root + '/src/theme/modal.css')};
import {darkTheme} from ${JSON.stringify('/@fs/' + root + '/src/theme/dark.ts')};
import {AppModeContext} from ${JSON.stringify('/@fs/' + root + '/src/offline/app-mode-context.ts')};
import AGC from ${JSON.stringify('/@fs/' + root + '/src/pages/AGC/index.tsx')};
createRoot(document.getElementById('root')).render(<ConfigProvider theme={darkTheme}><App><AppModeContext.Provider value={{mode:'online',can:()=>true}}><MemoryRouter><AGC/></MemoryRouter></AppModeContext.Provider></App></ConfigProvider>);
`);
const aliases = Object.fromEntries(['react-dom', 'react', 'antd', 'react-router-dom', '@tauri-apps/api', '@ant-design/icons'].map(name => [name, root + '/node_modules/' + name]));
const server = await createServer({ configFile: false, root, cacheDir: path.join(output, '.vite'), plugins: [react(), {
  name: 'agc-runtime-fixture',
  load(id) {
    if (id.replaceAll('\\', '/') !== root + '/src/adapters/index.ts') return;
    return `
window.runtimeFixture={group:${JSON.stringify(group)},points:${JSON.stringify(initialPoints)},destinations:{},offline:false,reads:0,writes:[],control:[]};
const f=()=>window.runtimeFixture;
export const api={
agcListGroups:async()=>[structuredClone(f().group)],agcGetGroup:async()=>structuredClone(f().group),
agcStartGroup:async name=>{f().control.push({action:'start',name});f().group.state=2;},
agcStopGroup:async name=>{f().control.push({action:'stop',name});f().group.state=1;},
agcGetTuningStatus:async()=>({state:0,group_name:'总览控制组',members:[]}),
agcUpsertGroup:async(...args)=>f().writes.push({kind:'group',args}),
dcUpsertRoutes:async(...args)=>f().writes.push({kind:'routes',args}),dcDeleteRoutes:async(...args)=>f().writes.push({kind:'deleteRoutes',args}),
dcListConnections:async()=>[],dcListRoutes:async()=>[],dcGetConnTags:async()=>({tags:[]}),
dcGetLatest:async()=>{if(f().offline)throw new Error('模拟通信断开');return Object.entries(f().destinations).map(([tag,value])=>({src_conn_id:999,src_tag:'外部同名输入',dst_conn_id:10,dst_tag:tag,value:{type:'Decimal',value},ts_ms:Date.now(),quality:1}));},
dcGetSourceLatest:async()=>{f().reads++;if(f().offline)throw new Error('模拟通信断开');return Object.entries(f().points).map(([tag,p])=>({conn_id:10,tag,value:p.value,quality:p.quality,ts_ms:p.unknownTime?0:Date.now()-p.age,sequence:1}));}
};`;
  },
  configureServer(vite) {
    vite.middlewares.use('/__agc-overview', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta charset="utf-8"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><style>html,body,#root{margin:0;height:100%;background:#1e1e1e;color:#eee}#root{display:flex;flex-direction:column}#root>.ant-app{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script type="module" src=${JSON.stringify('/@fs/' + entry.replaceAll('\\', '/'))}></script></body></html>`);
    });
  },
}], resolve: { alias: aliases }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, output] }, watch: null, hmr: false }, logLevel: 'error' });
let browser, page;
const results = [], errors = [];
const overview = () => page.getByLabel('AGC 功率总览', { exact: true });
const row = name => overview().getByRole('row').filter({ has: page.getByText(name, { exact: true }) }).first();
const card = name => overview().getByLabel(name, { exact: true });
const values = () => page.evaluate(() => structuredClone(window.runtimeFixture));
async function refresh() { const before = (await values()).reads; await overview().getByRole('button', { name: '刷新运行数据', exact: true }).click(); await page.waitForFunction(reads => window.runtimeFixture.reads > reads, before); }
async function refreshGroups() { await page.locator('.ant-card-head').filter({ hasText: '控制组列表' }).getByRole('button', { name: 'reload', exact: true }).click(); }
async function scenario(name, run) { try { await run(); results.push({ name, status: 'passed' }); } catch (error) { results.push({ name, status: 'failed', error: String(error) }); throw error; } }
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'], ...(process.env.MSKDSP_BROWSER_EXECUTABLE ? { executablePath: process.env.MSKDSP_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__agc-overview`);
  // 总目标来自派生缓存，不能用总控原始指令或成员设定合计代替。
  await scenario('总体功率和成员实测设定相邻展示', async () => {
    await card('总有功目标').getByText(/100\.00/).waitFor();
    assert.match(await card('总有功实测').innerText(), /57\.71/);
    assert.match(await card('总有功偏差').innerText(), /42\.29/);
    assert.doesNotMatch(await card('总有功目标').innerText(), /999/);
    assert.match(await row('#1-2').innerText(), /0\.04[\s\S]*42\.31[\s\S]*42\.27/);
    await page.screenshot({ path: path.join(output, 'agc-runtime-overview.png') });
  });
  // 点位和数据问题的只读展开不得提交配置或路由。
  await scenario('成员详情和异常明细只读可追溯', async () => {
    await overview().getByRole('button', { name: '展开成员 #1-2', exact: true }).click();
    await overview().getByText('#1-2_实测', { exact: true }).waitFor();
    await overview().getByRole('button', { name: '查看点值明细', exact: true }).click();
    const details = overview().getByRole('table', { name: '运行点值明细', exact: true });
    await details.getByText('AGC远方操作', { exact: true }).waitFor();
    assert.match(await details.innerText(), /陈旧|超时/);
    assert.match(await details.innerText(), /不确定/);
    assert.deepEqual((await values()).writes, []);
    await page.screenshot({ path: path.join(output, 'agc-runtime-point-details.png') });
    await overview().getByRole('button', { name: '收起点值明细', exact: true }).click();
    await overview().getByRole('button', { name: '收起成员 #1-2', exact: true }).click();
  });
  // 断线保留最后缓存值，同时明确显示连接异常。
  await scenario('通信断开保留旧值但标记连接异常', async () => {
    await page.evaluate(() => { window.runtimeFixture.offline = true; });
    await refresh();
    await overview().getByText('连接异常', { exact: true }).first().waitFor();
    assert.match(await card('总有功实测').innerText(), /57\.71/);
    await page.evaluate(() => { window.runtimeFixture.offline = false; });
    await refresh();
    await overview().getByText('连接异常', { exact: true }).first().waitFor({ state: 'hidden' });
  });
  // 缺失总目标不可从命令或成员设定补造；非数测量不能计算成员偏差。
  await scenario('缺失目标和非数测量不补造派生值', async () => {
    await page.evaluate(() => { delete window.runtimeFixture.points['实际总目标']; window.runtimeFixture.points['#1-2_实测'].value = { type: 'String', value: '未知' }; });
    await refresh();
    await card('总有功目标').getByText(/^—\s*kW$/).waitFor();
    assert.doesNotMatch(await card('总有功目标').innerText(), /999|100\.00/);
    assert.ok((await row('#1-2').innerText()).includes('—'));
    await page.evaluate(points => { window.runtimeFixture.points = points; }, initialPoints);
    await refresh();
    await card('总有功目标').getByText(/100\.00/).waitFor();
  });
  // 不可控成员只测量，不把缓存中的旧设定误当成当前控制目标。
  await scenario('输出源缓存缺失时拒绝同名目的缓存', async () => {
    await page.evaluate(() => {
      delete window.runtimeFixture.points['实际总目标'];
      delete window.runtimeFixture.points['#1-2_设定'];
      window.runtimeFixture.destinations = { 实际总目标: '812.3', '#1-2_设定': '912.3' };
    });
    await refresh();
    await card('总有功目标').getByText(/^—\s*kW$/).waitFor();
    assert.doesNotMatch(await card('总有功目标').innerText(), /812\.3/);
    assert.doesNotMatch(await row('#1-2').innerText(), /912\.3/);
    assert.match(await row('#1-2').innerText(), /—\s*kW[\s\S]*—/);
    await page.evaluate(points => { window.runtimeFixture.points = points; window.runtimeFixture.destinations = {}; }, initialPoints);
    await refresh();
    await card('总有功目标').getByText(/100\.00/).waitFor();
  });
  // 不可控成员只测量，不把缓存中的旧设定误当成当前控制目标。
  await scenario('不可控成员显示仅测量且不计算控制偏差', async () => {
    await page.evaluate(() => { window.runtimeFixture.group.config.members[1].controllable = false; });
    await refreshGroups();
    await row('#1-2').getByText(/仅测量/).first().waitFor();
    assert.doesNotMatch(await row('#1-2').innerText(), /42\.31|42\.27/);
    await page.evaluate(() => { window.runtimeFixture.group.config.members[1].controllable = true; });
    await refreshGroups();
  });
  // 编辑仍进入既有三页签，打开与关闭不写配置。
  await scenario('编辑入口保留三页签且不提前保存', async () => {
    await overview().getByRole('button', { name: /编\s*辑/ }).click();
    const editor = page.getByRole('dialog', { name: /编辑 AGC 控制组/ });
    await editor.getByRole('tab', { name: '基础与总控', exact: true }).waitFor();
    assert.equal(await editor.getByRole('tab', { name: /成员设备/ }).count(), 1);
    assert.equal(await editor.getByRole('tab', { name: '数据上送', exact: true }).count(), 1);
    await editor.getByRole('button', { name: /取\s*消/ }).click();
    await editor.waitFor({ state: 'hidden' });
    assert.deepEqual((await values()).writes, []);
  });
  // 控制组停止必须确认，取消不调用接口，确认后才调用一次。
  await scenario('停止控制组确认与取消时序正确', async () => {
    await overview().getByRole('button', { name: /停止控制组/ }).click();
    await page.locator('.ant-popconfirm').getByRole('button', { name: /取\s*消/ }).click();
    await page.locator('.ant-popconfirm').waitFor({ state: 'hidden' });
    assert.deepEqual((await values()).control, []);
    await overview().getByRole('button', { name: /停止控制组/ }).click();
    await page.locator('.ant-popconfirm').getByRole('button', { name: '停止控制组', exact: true }).click();
    await page.waitForFunction(() => window.runtimeFixture.control.length === 1);
    assert.deepEqual((await values()).control, [{ action: 'stop', name: '总览控制组' }]);
  });
  // 窄窗口允许表格自身滚动，功率总览容器不横向溢出。
  await scenario('窄窗口功率卡与操作区可用', async () => {
    await page.setViewportSize({ width: 680, height: 800 });
    const dimensions = await overview().evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    assert.ok(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions));
    assert.equal(await overview().getByRole('button', { name: '刷新运行数据', exact: true }).isVisible(), true);
    await page.screenshot({ path: path.join(output, 'agc-runtime-overview-680.png') });
    assert.deepEqual(errors, []);
    assert.deepEqual((await values()).writes, []);
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
