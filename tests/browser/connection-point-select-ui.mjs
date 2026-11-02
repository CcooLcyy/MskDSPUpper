import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 挂载真实连接选点组件，用固定点表验证筛选，不访问设备或提交路由。
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-connection-point-ui-'));
const { chromium } = await (process.env.MSKDSP_PLAYWRIGHT_MODULE ? import(pathToFileURL(process.env.MSKDSP_PLAYWRIGHT_MODULE)) : import('playwright'));
const { createServer } = await import(pathToFileURL(root + '/node_modules/vite/dist/node/index.js'));
const { default: react } = await import(pathToFileURL(root + '/node_modules/@vitejs/plugin-react/dist/index.js'));
const entry = path.join(output, 'entry.tsx');
await fs.writeFile(entry, `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, Button } from 'antd';
import { darkTheme } from ${JSON.stringify('/@fs/' + root + '/src/theme/dark.ts')};
import ConnectionPointSelect from ${JSON.stringify('/@fs/' + root + '/src/components/control/ConnectionPointSelect.tsx')};
const endpoint=(module_name,conn_name,tag)=>({module_name,conn_name,tag});
const endpoints=[endpoint('ModbusRTU','逆变器甲','甲测量'),endpoint('ModbusRTU','逆变器甲','甲设定'),endpoint('ModbusRTU','逆变器乙','乙测量'),endpoint('ModbusRTU','逆变器乙','乙设定'),endpoint('IEC104','逆变器甲','远方测量')];
const toOptions=values=>values.map(endpoint=>({value:JSON.stringify([endpoint.module_name,endpoint.conn_name,endpoint.tag]),label:[endpoint.module_name,endpoint.conn_name,endpoint.tag].join(' / '),endpoint}));
const historical=[endpoint('ModbusRTU','逆变器甲','已移除测量'),endpoint('ModbusRTU','逆变器乙','乙测量')];
window.__pointFixture={calls:[]};
function Fixture(){
 const [options,setOptions]=useState(toOptions(endpoints));
 const [measurement,setMeasurement]=useState([]),[setpoint,setSetpoint]=useState([]),[existing,setExisting]=useState(historical);
 const changed=(field,setter)=>next=>{window.__pointFixture.calls.push({field,next});setter(next);};
 return <ConfigProvider theme={darkTheme}><main style={{maxWidth:760,padding:24}}>
 <h2>连接点位筛选验收</h2>
 <h3>有功测量点</h3><ConnectionPointSelect label="有功测量点" options={options} selected={measurement} loading={false} disabled={false} onChange={changed('measurement',setMeasurement)}/>
 <h3>有功设定点</h3><ConnectionPointSelect label="有功设定点" options={options} selected={setpoint} loading={false} disabled={false} onChange={changed('setpoint',setSetpoint)}/>
 <h3>历史多绑定</h3><ConnectionPointSelect label="历史多绑定" options={options} selected={existing} loading={false} disabled={false} onChange={changed('existing',setExisting)}/>
 <Button onClick={()=>setOptions(toOptions(endpoints))}>刷新点表</Button>
 <pre data-testid="bindings">{JSON.stringify({measurement,setpoint,existing})}</pre>
 </main></ConfigProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
const aliases = Object.fromEntries(['react-dom', 'react', 'antd'].map(name => [name, root + '/node_modules/' + name]));
const server = await createServer({ configFile: false, root, cacheDir: path.join(output, '.vite'), plugins: [react(), {
  name: 'connection-point-fixture',
  configureServer(vite) {
    vite.middlewares.use('/__connection-points', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta charset="utf-8"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><style>body{margin:0;background:#1e1e1e;color:#eee;font-family:sans-serif}pre{white-space:pre-wrap}</style></head><body><div id="root"></div><script type="module" src=${JSON.stringify('/@fs/' + entry.replaceAll('\\', '/'))}></script></body></html>`);
    });
  },
}], resolve: { alias: aliases }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, output] }, watch: null, hmr: false }, logLevel: 'error' });
let browser, page;
const results = [], runtimeErrors = [];
const combo = label => page.getByRole('combobox', { name: label, exact: true });
// 用当前输入框自己的列表定位弹层，避免关闭动画中的另一个弹层混入候选。
async function dropdown(label) {
  const listId = await combo(label).getAttribute('aria-controls');
  assert.ok(listId, '打开的选择器必须关联候选列表');
  return page.locator(`[id=${JSON.stringify(listId)}]`).locator('..');
}
async function choose(label, text) {
  await combo(label).click();
  await (await dropdown(label)).locator('.ant-select-item-option-content').filter({ hasText: text }).click();
}
async function candidates(label) {
  await combo(label).click();
  const values = await (await dropdown(label)).locator('.ant-select-item-option-content').allTextContents();
  await combo(label).press('Escape');
  return values;
}
const calls = () => page.evaluate(() => window.__pointFixture.calls);
const bindings = async () => JSON.parse(await page.getByTestId('bindings').innerText());
async function scenario(name, run) {
  try { await run(); results.push({ name, status: 'passed' }); }
  catch (error) {
    const evidence = path.join(output, `failure-${results.length + 1}`);
    await page.screenshot({ path: evidence + '.png', fullPage: true });
    await fs.writeFile(evidence + '.txt', String(error) + '\n' + await page.locator('body').innerText());
    results.push({ name, status: 'failed', error: String(error) });
    throw error;
  }
}
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'], ...(process.env.MSKDSP_BROWSER_EXECUTABLE ? { executablePath: process.env.MSKDSP_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__connection-points`);
  await combo('有功测量点连接').waitFor({ timeout: 45000 });
  // 未选择连接时不能打开点位下拉。
  await scenario('未选连接禁用测量与设定点下拉', async () => {
    assert.equal(await combo('有功测量点').isDisabled(), true);
    assert.equal(await combo('有功设定点').isDisabled(), true);
  });
  // 两个连接及跨协议同名连接的候选点必须互相隔离。
  await scenario('按连接与协议隔离测量点候选', async () => {
    await choose('有功测量点连接', 'ModbusRTU / 逆变器甲');
    assert.deepEqual(await candidates('有功测量点'), ['ModbusRTU / 逆变器甲 / 甲测量', 'ModbusRTU / 逆变器甲 / 甲设定']);
    await choose('有功测量点连接', 'ModbusRTU / 逆变器乙');
    assert.deepEqual(await candidates('有功测量点'), ['ModbusRTU / 逆变器乙 / 乙测量', 'ModbusRTU / 逆变器乙 / 乙设定']);
    await choose('有功测量点连接', 'IEC104 / 逆变器甲');
    assert.deepEqual(await candidates('有功测量点'), ['IEC104 / 逆变器甲 / 远方测量']);
    assert.deepEqual(await calls(), []);
  });
  // 测量与设定各自选择连接，浏览筛选不会修改已选绑定。
  await scenario('测量设定独立筛选且切换保留绑定', async () => {
    await choose('有功测量点连接', 'ModbusRTU / 逆变器甲');
    await choose('有功测量点', 'ModbusRTU / 逆变器甲 / 甲测量');
    await choose('有功设定点连接', 'ModbusRTU / 逆变器乙');
    assert.deepEqual(await candidates('有功设定点'), ['ModbusRTU / 逆变器乙 / 乙测量', 'ModbusRTU / 逆变器乙 / 乙设定']);
    await choose('有功设定点', 'ModbusRTU / 逆变器乙 / 乙设定');
    const before = await bindings(), changes = await calls();
    await choose('有功测量点连接', 'IEC104 / 逆变器甲');
    assert.deepEqual(await bindings(), before);
    assert.deepEqual(await calls(), changes);
    assert.equal(before.measurement[0].tag, '甲测量');
    assert.equal(before.setpoint[0].tag, '乙设定');
  });
  // 历史点缺失及跨连接多绑定保留完整显示与值。
  await scenario('历史缺失点与跨连接多绑定完整保留', async () => {
    const before = await bindings(), changes = await calls();
    assert.equal(await page.locator('.ant-select-selection-item').filter({ hasText: '已移除测量' }).count(), 1);
    assert.equal(await page.locator('.ant-select-selection-item').filter({ hasText: '乙测量' }).count(), 1);
    assert.ok((await candidates('历史多绑定')).some(label => label.includes('已移除测量')));
    await choose('历史多绑定连接', 'ModbusRTU / 逆变器乙');
    assert.deepEqual(await candidates('历史多绑定'), ['ModbusRTU / 逆变器乙 / 乙测量', 'ModbusRTU / 逆变器乙 / 乙设定']);
    assert.deepEqual(await bindings(), before);
    assert.deepEqual(await calls(), changes);
    await choose('历史多绑定', 'ModbusRTU / 逆变器乙 / 乙设定');
    const after = await bindings();
    assert.deepEqual(after.existing.map(endpoint => endpoint.tag), ['已移除测量', '乙测量', '乙设定']);
    await combo('历史多绑定').press('Escape');
  });
  // 刷新提供新的 options 数组时仍保留当前筛选与草稿。
  await scenario('刷新点表保留筛选与绑定', async () => {
    const before = await bindings(), changes = await calls();
    await page.getByRole('button', { name: /刷\s*新\s*点\s*表/ }).click();
    assert.deepEqual(await candidates('有功测量点'), ['IEC104 / 逆变器甲 / 远方测量']);
    assert.deepEqual(await bindings(), before);
    assert.deepEqual(await calls(), changes);
    assert.deepEqual(runtimeErrors, []);
    await page.screenshot({ path: path.join(output, 'connection-point-filter.png'), fullPage: true });
  });
} finally {
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ results, runtimeErrors }, null, 2));
  console.log(JSON.stringify({ output, results, runtimeErrors }, null, 2));
  await browser?.close();
  await server.close();
}
