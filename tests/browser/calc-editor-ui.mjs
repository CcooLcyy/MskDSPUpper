import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 挂载真实页面，仅使用浏览器内存接口与虚构点位，不连接设备或执行部署。
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const output = process.env.CALC_EDITOR_UI_OUTPUT || await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-calc-editor-'));
await fs.mkdir(output, { recursive: true });
const { chromium } = await (process.env.MSKDSP_PLAYWRIGHT_MODULE ? import(pathToFileURL(process.env.MSKDSP_PLAYWRIGHT_MODULE)) : import('playwright'));
const { createServer } = await import(pathToFileURL(root + '/node_modules/vite/dist/node/index.js'));
const { default: react } = await import(pathToFileURL(root + '/node_modules/@vitejs/plugin-react/dist/index.js'));
const entry = path.join(output, 'entry.tsx');
await fs.writeFile(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { App, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { darkTheme } from ${JSON.stringify('/@fs/' + root + '/src/theme/dark.ts')};
import CalcPage from ${JSON.stringify('/@fs/' + root + '/src/pages/Calc/index.tsx')};
import { browserApi as api } from ${JSON.stringify('/@fs/' + root + '/src/adapters/browser.ts')};
const bus = { source_kind: 1, constant: null };
const sum = { item_name: '测试总功率', operator_kind: 9, left_operand: null, right_operand: null, operands: [bus,bus,bus] };
const binary = { item_name: '测试换算', operator_kind: 3, left_operand: bus, right_operand: { source_kind: 2, constant: { decimal_value: '0.001' } }, operands: [] };
for (const group of await api.calcListGroups()) await api.calcDeleteGroup(group.config.group_name);
await api.dcUpsertRoutes([], true);
await api.calcUpsertGroup({ group_name: '路由测试组', trigger_mode: 1, period_ms: 1000, items: [sum,binary] }, true);
await api.calcUpsertGroup({ group_name: '另一个计算组', trigger_mode: 2, period_ms: 1000, items: [binary] }, true);
const source = await api.dcGetOrCreateConnection('ModbusRTU', '测试逆变器');
await api.dcUpsertConnTags(source.conn_id, ['功率A','功率B','功率C','功率D'], true);
const target = await api.dcGetOrCreateConnection('IEC104', '测试主站');
await api.dcUpsertConnTags(target.conn_id, ['总功率','备用总功率'], true);
const src = tag => ({ module_name: 'ModbusRTU', conn_name: '测试逆变器', tag });
const dst = tag => ({ module_name: 'Calc', conn_name: '路由测试组', tag });
await api.dcUpsertRoutes(['功率A','功率B','功率C'].map((tag,i) => ({src:src(tag),dst:dst('测试总功率/input_'+(i+1))})).concat([{src:src('功率A'),dst:dst('测试换算/left_input')}]), false);
if (new URLSearchParams(location.search).has('multi')) await api.dcUpsertRoutes([{src:src('功率D'),dst:dst('测试总功率/input_1')}],false);
await api.calcStartGroup('路由测试组');
const mock = window.__calcMock = { calls: [], failRoutes: false, api };
for (const name of ['calcUpsertGroup','dcUpsertRoutes','dcDeleteRoutes','calcStartGroup','calcStopGroup']) {
  const original = api[name].bind(api);
  api[name] = async (...args) => {
    mock.calls.push({name,args:JSON.parse(JSON.stringify(args))});
    if (name === 'dcUpsertRoutes' && mock.failRoutes) throw new Error('测试路由写入失败');
    return original(...args);
  };
}
const router = createMemoryRouter([{path:'/',element:<CalcPage />},{path:'/other',element:<div>其他页面</div>}]);
mock.router = router;
createRoot(document.getElementById('root')!).render(<ConfigProvider theme={darkTheme} locale={zhCN}><App><RouterProvider router={router} /></App></ConfigProvider>);
`);
const aliases = Object.fromEntries(['react-dom','react','react-router-dom','antd','@tauri-apps/api','@tauri-apps/plugin-dialog','@ant-design/icons'].map(name => [name,root+'/node_modules/'+name]));
const server = await createServer({ configFile:false, root, cacheDir:path.join(output,'.vite'), plugins:[react(),{
  name:'calc-editor-fixture', configureServer(vite) {
    vite.middlewares.use('/__calc-editor',(_req,res) => {
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta charset="utf-8"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><style>html,body,#root,.ant-app{height:100%;margin:0}body{background:#1e1e1e;font-family:'Microsoft YaHei',sans-serif}.ant-app{display:flex;min-height:0}</style></head><body><div id="root"></div><script type="module" src=${JSON.stringify('/@fs/'+entry.replaceAll('\\','/'))}></script></body></html>`);
    });
  }
}], resolve:{alias:aliases}, server:{host:'127.0.0.1',port:0,fs:{allow:[root,output]},watch:null,hmr:false}, logLevel:'error' });
let browser;
let page;
const results = [];
const runtimeErrors = [];
async function openFixture(query = '') {
  await page?.close();
  page = await browser.newPage({viewport:{width:1280,height:1000}});
  page.setDefaultTimeout(12000);
  page.on('pageerror',error => runtimeErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__calc-editor${query}`);
  await page.getByText('测试总功率',{exact:true}).first().waitFor();
}
async function test(name, run, query = '') {
  try { await openFixture(query); await run(); results.push({name,status:'passed'}); }
  catch(error) { await page?.screenshot({path:path.join(output,`failure-${results.length+1}.png`),fullPage:true}); results.push({name,status:'failed',error:String(error)}); }
}
async function editFirst() {
  await page.getByRole('button',{name:/编\s*辑/}).first().click();
  await page.locator('.calc-inline-editor').waitFor();
}
async function choosePoint(label, query) {
  const combo=page.getByRole('combobox',{name:label,exact:true});
  await combo.click();
  await combo.fill(query);
  const escaped=query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({hasText:new RegExp('(?:^|[\\s/])'+escaped+'$')}).first().click();
  await combo.press('Escape');
}
async function routes() { return page.evaluate(() => window.__calcMock.api.dcListRoutes(0,'',0,'')); }
const findRoute=(all,srcTag,dstTag)=>all.some(route=>route.src.tag===srcTag&&route.dst.tag===dstTag);
async function waitSaved() {
  await page.waitForFunction(() => window.__calcMock.calls.some(c=>c.name==='dcUpsertRoutes'));
  await page.locator('.calc-inline-editor').waitFor({state:'hidden'});
}
try {
  await server.listen();
  browser = await chromium.launch({headless:true,args:['--no-proxy-server'],...(process.env.MSKDSP_BROWSER_EXECUTABLE?{executablePath:process.env.MSKDSP_BROWSER_EXECUTABLE}:{})});
  // 清单原位编辑，无计算项弹窗；选点只改变草稿。
  await test('清单内编辑与直接关联入口',async () => {
    await page.getByRole('button',{name:/编\s*辑/}).first().click();
    assert.equal(await page.getByRole('dialog').count(),0,'计算项应直接在清单内编辑');
    await page.getByRole('combobox',{name:'结果关联目标',exact:true}).waitFor();
    assert.equal(await page.evaluate(() => window.__calcMock.calls.filter(c => c.name==='dcUpsertRoutes').length),0);
    await page.screenshot({path:path.join(output,'inline-editor.png'),fullPage:true});
  });
  // 在同一编辑器中更换输入及选择多个输出，检查未保存不写路由和保存后的真实映射。
  await test('输入换点与结果多目标差量保存',async () => {
    await editFirst();
    await choosePoint('输入1关联点位','功率D');
    await choosePoint('结果关联目标','备用总功率');
    await choosePoint('结果关联目标','总功率');
    assert.equal(await page.evaluate(()=>window.__calcMock.calls.length),0,'选点期间只能修改草稿');
    await page.getByRole('button',{name:/保存计算与关联/}).click();
    await waitSaved();
    const all=await routes();
    assert(findRoute(all,'功率D','测试总功率/input_1'));
    assert(!findRoute(all,'功率A','测试总功率/input_1'));
    assert(findRoute(all,'测试总功率/result','总功率'));
    assert(findRoute(all,'测试总功率/result','备用总功率'));
    assert(findRoute(all,'功率A','测试换算/left_input'),'其他计算项关联必须保留');
    assert(await page.evaluate(()=>window.__calcMock.calls.filter(c=>c.name==='dcUpsertRoutes').every(c=>c.args[1]===false)),'不能覆盖全局路由');
  });
  // 中间行移除后，原第三行仍关联功率C，并迁移到第二个槽位。
  await test('聚合删除中间输入保持来源身份',async () => {
    await editFirst();
    await page.getByRole('button',{name:'移除输入2',exact:true}).click();
    await page.getByRole('button',{name:/保存计算与关联/}).click();
    await waitSaved();
    const all=await routes();
    assert(findRoute(all,'功率A','测试总功率/input_1'));
    assert(findRoute(all,'功率C','测试总功率/input_2'));
    assert(!all.some(r=>r.dst.tag==='测试总功率/input_3'));
    assert(!findRoute(all,'功率B','测试总功率/input_2'));
  });
  // 路由失败要保持待重试草稿，仅重试关联，不重复保存已成功的计算配置。
  await test('路由失败保留编辑并支持独立重试',async () => {
    await editFirst();
    await choosePoint('输入1关联点位','功率D');
    await page.evaluate(()=>{window.__calcMock.failRoutes=true;});
    await page.getByRole('button',{name:/保存计算与关联/}).click();
    await page.getByText(/计算已保存.*路由/).first().waitFor();
    assert.equal(await page.locator('.calc-inline-editor').count(),1);
    const saves=await page.evaluate(()=>window.__calcMock.calls.filter(c=>c.name==='calcUpsertGroup').length);
    assert.equal(saves,1);
    assert.notEqual(await page.evaluate(async ()=>(await window.__calcMock.api.calcGetGroup('路由测试组')).state),2,'路由失败时分组功能应保持停止');
    await page.screenshot({path:path.join(output,'route-failure.png'),fullPage:true});
    await page.evaluate(()=>{window.__calcMock.failRoutes=false;});
    await page.getByRole('button',{name:/重试路由同步/}).click();
    await page.locator('.calc-inline-editor').waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>window.__calcMock.calls.filter(c=>c.name==='calcUpsertGroup').length),saves);
    assert(findRoute(await routes(),'功率D','测试总功率/input_1'));
    assert.equal(await page.evaluate(async ()=>(await window.__calcMock.api.calcGetGroup('路由测试组')).state),2,'重试完成后恢复原运行状态');
  });
  // 切换计算项前明确确认草稿；继续编辑不能丢失所选来源，也不能写入接口。
  await test('切换计算项保护未保存草稿',async () => {
    await editFirst();
    await choosePoint('输入1关联点位','功率D');
    await page.getByRole('button',{name:/编\s*辑/}).last().click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button',{name:/继续编辑/}).click();
    assert.match(await page.locator('.calc-inline-editor').innerText(),/功率D/);
    assert.equal(await page.evaluate(()=>window.__calcMock.calls.length),0);
  });
  // 人工配置过的多来源输入必须完整回显，再保存不能静默丢失任一来源。
  await test('已有多来源回显与再次保存',async () => {
    await editFirst();
    const first=page.getByRole('combobox',{name:'输入1关联点位',exact:true});
    const selected=await first.evaluate(el=>el.closest('.ant-select').innerText);
    assert.match(selected,/功率A/);
    assert.match(selected,/功率D/);
    await page.getByRole('button',{name:/保存计算与关联/}).click();
    await waitSaved();
    const all=await routes();
    assert(findRoute(all,'功率A','测试总功率/input_1'));
    assert(findRoute(all,'功率D','测试总功率/input_1'));
  },'?multi=1');
  // 常用宽度下展开编辑与列表均不横向溢出。
  await test('清单展开编辑窄窗口布局',async () => {
    await editFirst();
    for(const width of [1280,1024,768]) {
      await page.setViewportSize({width,height:1000});
      await page.waitForTimeout(200);
      const dimensions=await page.evaluate(()=>({width:innerWidth,page:document.documentElement.scrollWidth,editor:[...document.querySelectorAll('.calc-inline-editor')].map(el=>({client:el.clientWidth,scroll:el.scrollWidth}))}));
      assert(dimensions.page<=width,JSON.stringify(dimensions));
      assert(dimensions.editor.every(el=>el.scroll<=el.client+1),JSON.stringify(dimensions));
      await page.screenshot({path:path.join(output,`editor-${width}.png`),fullPage:true});
    }
  });
  // 未提交的草稿可直接切页；部分保存成功后仍需先处理待重试计划。
  await test('切页恢复草稿且保护待重试计划',async () => {
    await editFirst();
    await choosePoint('输入1关联点位','功率D');
    await page.evaluate(()=>{void window.__calcMock.router.navigate('/other');});
    await page.getByText('其他页面',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__calcMock.calls.length),0);
    await page.evaluate(()=>{void window.__calcMock.router.navigate('/');});
    const editor=page.locator('.calc-inline-editor');
    await editor.getByText('未保存 · 草稿已暂存',{exact:true}).waitFor();
    assert.match(await editor.innerText(),/功率D/);
    await page.evaluate(()=>{window.__calcMock.failRoutes=true;});
    await page.getByRole('button',{name:/保存计算与关联/}).click();
    await page.getByText(/计算已保存.*路由/).first().waitFor();
    await page.evaluate(()=>{void window.__calcMock.router.navigate('/other');});
    await page.waitForTimeout(200);
    assert.equal(await page.getByText('其他页面',{exact:true}).count(),0,'待重试计划存在时站内导航必须被阻止');
    assert.equal(await page.locator('.calc-inline-editor').count(),1);
  });
  // 外部配置变化后不可无限卡在旧计划；显式放弃并加载不应写设备或调整运行状态。
  await test('待重试计划冲突后允许显式重新加载',async () => {
    await editFirst();
    await choosePoint('输入1关联点位','功率D');
    await page.evaluate(()=>{window.__calcMock.failRoutes=true;});
    await page.getByRole('button',{name:/保存计算与关联/}).click();
    await page.getByText(/计算已保存.*路由/).first().waitFor();
    await page.evaluate(async ()=>{
      const api=window.__calcMock.api;
      const latest=await api.calcGetGroup('路由测试组');
      await api.calcUpsertGroup({...latest.config,period_ms:2000},false);
      window.__calcMock.failRoutes=false;
      window.__calcMock.calls=[];
    });
    await page.getByRole('button',{name:/重试路由同步/}).click();
    await page.getByText(/配置.*变化|配置.*变更|配置.*不一致/).first().waitFor();
    await page.getByRole('button',{name:'重新加载当前配置',exact:true}).click();
    const confirm=page.getByRole('dialog');
    await confirm.waitFor();
    assert.match(await confirm.innerText(),/放弃/);
    await confirm.getByRole('button',{name:'放弃并重新加载',exact:true}).click();
    await page.getByRole('button',{name:/重试路由同步/}).waitFor({state:'hidden'});
    assert.equal(await page.locator('.calc-inline-editor').count(),0);
    assert.equal(await page.evaluate(()=>window.__calcMock.calls.length),0,'放弃旧计划并读取配置不应写入设备或调整运行状态');
    assert.equal(await page.getByRole('combobox',{name:'计算分组',exact:true}).isDisabled(),false);
  });
  // 精确十进制常量在实际编辑控件和公式中保留原文，不被显示格式化舍入。
  await test('精确十进制常量与公式显示保持原文',async () => {
    await page.getByRole('button',{name:/编\s*辑/}).nth(1).click();
    const constant=page.getByRole('spinbutton',{name:'输入2常量值',exact:true});
    await constant.waitFor();
    assert.equal(await constant.inputValue(),'0.001');
    const formula=page.locator('.calc-formula-preview');
    assert.match(await formula.innerText(),/×\s*0\.001/);
    assert.doesNotMatch(await formula.innerText(),/×\s*0\.00(?!\d)/);
    const precise='0.00000000000000000001';
    await constant.fill(precise);
    await constant.press('Tab');
    assert.equal(await constant.inputValue(),precise);
    assert((await formula.innerText()).includes(`× ${precise}`),'公式须显示完整的精确十进制常量');
    assert.equal(await page.evaluate(()=>window.__calcMock.calls.length),0,'编辑精确常量不能隐式保存或写路由');
    await page.screenshot({path:path.join(output,'decimal-precision.png'),fullPage:true});
  });
  assert.deepEqual(runtimeErrors,[]);
  assert.equal(results.filter(result=>result.status==='failed').length,0,'存在失败的浏览器验收场景，请查看证据目录');
} finally {
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify({results,runtimeErrors},null,2));
  console.log(JSON.stringify({output,results,runtimeErrors}));
  await browser?.close();
  await server.close();
}
