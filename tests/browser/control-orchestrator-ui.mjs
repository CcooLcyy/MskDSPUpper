import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 真实 React 与表单，接口使用内存假件；不连接设备或下发真实命令。
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-orchestrator-ui-'));
const { chromium } = await (process.env.MSKDSP_PLAYWRIGHT_MODULE ? import(pathToFileURL(process.env.MSKDSP_PLAYWRIGHT_MODULE)) : import('playwright'));
const { createServer } = await import(pathToFileURL(root + '/node_modules/vite/dist/node/index.js'));
const { default: react } = await import(pathToFileURL(root + '/node_modules/@vitejs/plugin-react/dist/index.js'));
const entry = path.join(output, 'entry.tsx');
await fs.writeFile(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { darkTheme } from ${JSON.stringify('/@fs/' + root + '/src/theme/dark.ts')};
import Page from ${JSON.stringify('/@fs/' + root + '/src/pages/ControlOrchestrator/index.tsx')};
import { browserApi as api } from ${JSON.stringify('/@fs/' + root + '/src/adapters/browser.ts')};
const source=await api.dcGetOrCreateConnection('ModbusRTU','测试逆变器');
await api.dcUpsertConnTags(source.conn_id,['命令甲','命令乙','运行状态'],true);
const trigger=await api.dcGetOrCreateConnection('IEC104','测试主站');
await api.dcUpsertConnTags(trigger.conn_id,['总功率命令'],true);
const endpoint=tag=>({module_name:'ModbusRTU',conn_name:'测试逆变器',tag,conn_id:source.conn_id});
const step=(name,tag)=>({step_name:name,source:endpoint(tag),value:{type:'Decimal',value:'0.12345678901234567890'},use_trigger_value:location.search.includes('trigger'),timeout_ms:4321,delay_after_ms:123,verification:{status_source:endpoint('运行状态'),expected_value:{type:'Bool',value:true},wait_timeout_ms:5678,poll_interval_ms:321,failure_action:'RETRY_COMMAND',max_retries:2,retry_interval_ms:456}});
if(!location.search.includes('empty')) await api.controlOrchestratorUpsertSequence({sequence_name:'验收编排',trigger:null,steps:[step('切换模式','命令甲'),step('设置功率','命令乙')]},true);
const mock=window.__orchestrator={api,calls:[],failRoutes:false,failTags:false,deferExecute:false,pendingExecute:[],deferSave:false,pendingSave:[]};
for(const name of ['controlOrchestratorUpsertSequence','controlOrchestratorExecuteSequence','dcUpsertRoutes','dcDeleteRoutes','dcUpsertConnTags','dcGetConnTags']) {
 const original=api[name].bind(api);
 api[name]=async(...args)=>{
  mock.calls.push({name,args:JSON.parse(JSON.stringify(args))});
  if(name==='dcGetConnTags'&&mock.failTags&&args[0]===source.conn_id) throw new Error('测试连接读取超时');
  if(name==='dcUpsertRoutes'&&mock.failRoutes) throw new Error('测试路由写入失败');
  if(name==='controlOrchestratorExecuteSequence'&&mock.deferExecute) return new Promise((resolve,reject)=>mock.pendingExecute.push({resolve,reject}));
  if(name==='controlOrchestratorUpsertSequence'&&mock.deferSave) await new Promise(resolve=>mock.pendingSave.push(resolve));
  return original(...args);
 };
}
createRoot(document.getElementById('root')!).render(<ConfigProvider theme={darkTheme} locale={zhCN}><App><Page /></App></ConfigProvider>);
`);
const aliases=Object.fromEntries(['react-dom','react','antd','@tauri-apps/api','@tauri-apps/plugin-dialog','@ant-design/icons'].map(name=>[name,root+'/node_modules/'+name]));
const server=await createServer({configFile:false,root,cacheDir:path.join(output,'.vite'),plugins:[react(),{
 name:'orchestrator-fixture',configureServer(vite){vite.middlewares.use('/__orchestrator',(_req,res)=>{
 res.setHeader('Content-Type','text/html; charset=utf-8');
 res.end(`<!doctype html><html><head><meta charset="utf-8"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><style>html,body,#root,.ant-app{height:100%;margin:0}body{background:#1e1e1e;font-family:'Microsoft YaHei',sans-serif}.ant-app{display:flex;min-height:0}</style></head><body><div id="root"></div><script type="module" src=${JSON.stringify('/@fs/'+entry.replaceAll('\\','/'))}></script></body></html>`);
 });}
}],resolve:{alias:aliases},server:{host:'127.0.0.1',port:0,fs:{allow:[root,output]},watch:null,hmr:false},logLevel:'error'});
let browser,page;
const results=[],runtimeErrors=[];
// 等待有限过渡动画结束再留存截图，避免把弹窗淡入帧当作最终布局。
async function capture(options){
 await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})));});
 await page.screenshot(options);
}
const btn=name=>page.getByRole('button',{name:new RegExp(name.split('').join('\\s*')+'$')});
const dialog=()=>page.getByRole('dialog',{name:/新建编排|编辑编排/});
const cards=()=>dialog().locator('.orchestrator-step');
async function open(query=''){
 await page?.close();page=await browser.newPage({viewport:{width:1280,height:1000}});page.setDefaultTimeout(8000);
 page.on('pageerror',e=>runtimeErrors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__orchestrator${query}`,{waitUntil:'commit'});
 await btn('新建编排').waitFor({timeout:45000});
 await page.waitForFunction(()=>!!window.__orchestrator);
 if(!query.includes('empty'))await page.getByRole('cell',{name:'验收编排',exact:true}).waitFor();
}
async function scenario(name,run,query=''){
 try{await open(query);await run();results.push({name,status:'passed'});}catch(error){
  await page?.screenshot({path:path.join(output,`failure-${results.length+1}.png`),fullPage:true});
  await fs.writeFile(path.join(output,`failure-${results.length+1}.txt`),String(error)+'\n'+await page.locator('body').innerText());
  results.push({name,status:'failed',error:String(error)});
 }
}
async function edit(){await btn('编辑').click();await dialog().waitFor();await btn('刷新点表').waitFor();await page.waitForFunction(()=>window.__orchestrator.calls.some(c=>c.name==='dcGetConnTags'));}
async function choose(label,value){
 const combo=page.getByRole('combobox',{name:label,exact:true});await combo.click();
 await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({hasText:new RegExp('^'+value+'$')}).click();
}
async function count(name){return page.evaluate(n=>window.__orchestrator.calls.filter(c=>c.name===n).length,name);}
async function save(){await dialog().getByRole('button',{name:'保存并同步路由',exact:true}).click();}
try{
 await server.listen();browser=await chromium.launch({headless:true,args:['--no-proxy-server'],...(process.env.MSKDSP_BROWSER_EXECUTABLE?{executablePath:process.env.MSKDSP_BROWSER_EXECUTABLE}:{})});
 // 空态、表单取消与类型展示应使用中文。
 await scenario('中文空态与表单文案',async()=>{
  await page.getByText('暂无编排，请新建编排',{exact:true}).waitFor();
  assert.equal(await page.getByText('No data',{exact:true}).count(),0);
  await btn('新建编排').click();await dialog().waitFor();
  await dialog().getByRole('button',{name:/取\s*消/}).waitFor();
  assert.equal(await dialog().getByText('Decimal',{exact:true}).count(),0);
  await choose('步骤 1 固定值类型','布尔值');
  await page.getByRole('combobox',{name:'步骤 1 固定值',exact:true}).waitFor();
 },'?empty');
 // 小窗口及大窗口保存固定可见，内容区域负责滚动。
 await scenario('两种窗口高度均可见底部保存按钮',async()=>{
  await edit();
  for(const viewport of [{width:822,height:591},{width:1920,height:1080}]){
   await page.setViewportSize(viewport);await cards().nth(0).getByRole('button',{name:'复制',exact:true}).click();
   const saveButton=dialog().getByRole('button',{name:'保存并同步路由',exact:true});
   const box=await saveButton.boundingBox();assert(box&&box.y>=0&&box.y+box.height<=viewport.height,'保存按钮必须在视口内');
   const scrollable=await dialog().locator('.ant-modal-body').evaluate(el=>el.scrollHeight>el.clientHeight&&getComputedStyle(el).overflowY==='auto');
   assert(scrollable,'多步骤必须在正文内滚动');
   await capture({path:path.join(output,`editor-${viewport.width}.png`)});
  }
 });
 // 排序、复制不丢失高级参数，最多八步且复制名称唯一。
 await scenario('步骤移动复制及高级参数保留',async()=>{
  await edit();
  assert.equal(await cards().first().locator('details').getAttribute('open'),null);
  await cards().first().getByRole('button',{name:'下移',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'步骤 1 步骤名',exact:true}).inputValue(),'设置功率');
  await cards().nth(1).getByRole('button',{name:'上移',exact:true}).click();
  await cards().first().getByRole('button',{name:'复制',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'步骤 2 步骤名',exact:true}).inputValue(),'切换模式副本');
  await cards().nth(1).locator('summary').click();
  assert.deepEqual(await cards().nth(1).getByRole('spinbutton').evaluateAll(els=>els.map(el=>el.value)),['4321','123','5678','321','2','456']);
  while(await cards().count()<8)await cards().first().getByRole('button',{name:'复制',exact:true}).click();
  assert.equal(await dialog().getByRole('button',{name:/添加步骤（8\/8）$/}).isDisabled(),true);
  assert.equal(await cards().first().getByRole('button',{name:'复制',exact:true}).isDisabled(),true);
  await save();await dialog().waitFor({state:'hidden'});
  const config=await page.evaluate(()=>window.__orchestrator.calls.find(c=>c.name==='controlOrchestratorUpsertSequence').args[0]);
  assert.equal(new Set(config.steps.map(s=>s.step_name)).size,8);
  assert.equal(config.steps[1].timeout_ms,4321);assert.equal(config.steps[1].verification.wait_timeout_ms,5678);
  assert.equal(config.steps[1].value.value,'0.12345678901234567890');
 });
 // 未保存修改的关闭必须确认，必填及重名错误不能发起保存。
 await scenario('草稿关闭保护与字段校验',async()=>{
  await edit();await page.getByRole('textbox',{name:'步骤 1 步骤名',exact:true}).fill('');
  await save();await cards().first().getByText('请填写或选择步骤名',{exact:true}).waitFor();
  const invalid=await page.getByRole('textbox',{name:'步骤 1 步骤名',exact:true}).evaluate(el=>({invalid:el.getAttribute('aria-invalid'),field:el.closest('[data-field]')?.getAttribute('data-field'),classes:el.closest('.ant-form-item')?.className}));
  await fs.writeFile(path.join(output,'invalid-field.json'),JSON.stringify(invalid));
  assert.equal(await count('controlOrchestratorUpsertSequence'),0);
  assert.equal(invalid.field,'steps.0.name');assert.match(invalid.classes,/ant-form-item-has-error/);
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='步骤 1 步骤名');
  const errorBox=await cards().first().getByText('请填写或选择步骤名',{exact:true}).boundingBox();assert(errorBox&&errorBox.y>=0&&errorBox.y<1000);
  await page.getByRole('textbox',{name:'步骤 1 步骤名',exact:true}).fill('设置功率');await save();
  assert.equal(await count('controlOrchestratorUpsertSequence'),0);
  assert.match(await dialog().locator('.ant-form-item-explain-error').first().innerText(),/重复/);
  await dialog().getByRole('button',{name:/取\s*消/}).click();
  await page.locator('.ant-modal-confirm-title').filter({hasText:'放弃未保存的修改？'}).waitFor();
  await btn('继续编辑').click();assert.equal(await dialog().isVisible(),true);
  await dialog().getByRole('button',{name:/取\s*消/}).click();await btn('放弃修改').click();await dialog().waitFor({state:'hidden'});
 });
 // 延迟执行接口期间禁止重复命令，失败结果持久保留。
 await scenario('执行锁与持久失败结果',async()=>{
  await page.evaluate(()=>{window.__orchestrator.deferExecute=true;});
  await btn('执行').click();await page.getByRole('dialog',{name:'确认执行编排'}).getByRole('button',{name:/执\s*行/}).click();
  await page.waitForFunction(()=>window.__orchestrator.pendingExecute.length===1);
  assert.equal(await btn('执行中').isDisabled(),true);assert.equal(await count('controlOrchestratorExecuteSequence'),1);
  await page.evaluate(()=>window.__orchestrator.pendingExecute[0].resolve({accepted:false,executed_steps:1,failed_step_index:2,failed_step_name:'设置功率',reason:'测试遥信超时',failed_command_status:6}));
  const result=page.locator('.orchestrator-execution');await result.getByText('失败原因：测试遥信超时',{exact:true}).waitFor();
  assert.match(await result.innerText(),/第 2 步 · 设置功率/);assert.match(await result.innerText(),/命令已接受数量：1/);
  await btn('刷新').click();assert.match(await result.innerText(),/测试遥信超时/);
  assert.equal(await count('controlOrchestratorExecuteSequence'),1);
  await btn('执行').click();await page.getByRole('dialog',{name:'确认执行编排'}).getByRole('button',{name:/执\s*行/}).click();
  await page.waitForFunction(()=>window.__orchestrator.pendingExecute.length===2);
  await page.evaluate(()=>window.__orchestrator.pendingExecute[1].reject(new Error('测试断线')));
  await result.getByText('通信异常，执行结果未知，请核实设备状态后再操作。',{exact:true}).waitFor();
  assert.equal(await count('controlOrchestratorExecuteSequence'),2);
  await capture({path:path.join(output,'execution-unknown.png')});
 });
 // 点表读取异常应与点位未注册分开提示，刷新后可恢复。
 await scenario('点表加载失败可刷新恢复',async()=>{
  await page.evaluate(()=>{window.__orchestrator.failTags=true;});await edit();
  await page.getByText('有 1 个连接的点名加载失败',{exact:true}).waitFor();
  await save();await dialog().getByText('该连接的点名加载失败，请刷新点表后重试',{exact:true}).first().waitFor();
  assert.equal(await dialog().getByText('点名尚未在数据中心注册',{exact:true}).count(),0);
  assert.equal(await count('controlOrchestratorUpsertSequence'),0);
  await page.evaluate(()=>{window.__orchestrator.failTags=false;});await btn('刷新点表').click();
  await page.getByText('有 1 个连接的点名加载失败',{exact:true}).waitFor({state:'hidden'});
  await save();await dialog().waitFor({state:'hidden'});
 });
 // 新建保存自动建立路由，失败重试不得重复创建配置。
 await scenario('新建自动路由与同步失败恢复',async()=>{
  await btn('新建编排').click();await dialog().waitFor();
  await page.getByRole('textbox',{name:'编排名称',exact:true}).fill('新建验收');
  await page.getByRole('textbox',{name:'步骤 1 步骤名',exact:true}).fill('调节功率');
  for(const [label,value]of [['触发模块','IEC104'],['触发连接','测试主站'],['触发点名','总功率命令'],['步骤 1 目标模块','ModbusRTU'],['步骤 1 目标连接','测试逆变器'],['步骤 1 目标点名','命令甲']])await choose(label,value);
  assert.equal(await count('controlOrchestratorUpsertSequence'),0);assert.equal(await count('dcUpsertRoutes'),0);
  await page.evaluate(()=>{window.__orchestrator.failRoutes=true;window.__orchestrator.deferSave=true;});await save();
  await page.waitForFunction(()=>window.__orchestrator.pendingSave.length===1);
  assert.equal(await dialog().getByRole('button',{name:/取\s*消/}).isDisabled(),true);assert.equal(await count('controlOrchestratorUpsertSequence'),1);
  await page.evaluate(()=>window.__orchestrator.pendingSave[0]());
  await dialog().getByText('编排“新建验收”已保存，自动路由未同步',{exact:true}).waitFor();
  await dialog().getByRole('button',{name:/重试路由同步$/}).click();
  await page.waitForFunction(()=>window.__orchestrator.calls.filter(c=>c.name==='dcUpsertRoutes').length===2);
  assert.equal(await count('controlOrchestratorUpsertSequence'),1);
  await page.evaluate(()=>{window.__orchestrator.failRoutes=false;});await dialog().getByRole('button',{name:/重试路由同步$/}).click();
  await dialog().getByText('编排“新建验收”已保存，自动路由未同步',{exact:true}).waitFor({state:'hidden'});
  assert.equal(await count('controlOrchestratorUpsertSequence'),1);
  const routes=await page.evaluate(()=>window.__orchestrator.api.dcListRoutes(0,'',0,''));
  assert(routes.some(r=>r.src.tag==='总功率命令'&&r.dst.tag==='trigger:新建验收'));
  assert(routes.some(r=>r.src.tag==='step:新建验收:调节功率'&&r.dst.tag==='命令甲'));
 },'?empty');

 // 部分路由已经写入后，同步恢复时清空触发点也必须清理残留。
 await scenario('部分写入失败后取消触发仍清理残留',async()=>{
  await edit();
  await choose('触发模块','IEC104');await choose('触发连接','测试主站');await choose('触发点名','总功率命令');
  await page.evaluate(()=>{
   const mock=window.__orchestrator;const original=mock.api.dcUpsertRoutes.bind(mock.api);
   mock.api.dcUpsertRoutes=async(...args)=>{await original(...args);if(!mock.partialFailed){mock.partialFailed=true;throw new Error('测试部分写入后失败');}};
  });
  await save();await dialog().getByText('编排“验收编排”已保存，自动路由未同步',{exact:true}).waitFor();
  const partial=await page.evaluate(()=>window.__orchestrator.api.dcListRoutes(0,'',0,''));assert(partial.some(r=>r.dst.tag==='trigger:验收编排'));
  const trigger=page.getByRole('combobox',{name:'触发模块',exact:true});
  await trigger.hover();await dialog().locator('[data-field="trigger.module"] .ant-select-clear').click();
  await save();await dialog().waitFor({state:'hidden'});
  const routes=await page.evaluate(()=>window.__orchestrator.api.dcListRoutes(0,'',0,''));
  assert.equal(routes.some(r=>r.dst.tag==='trigger:验收编排'||r.src.tag.startsWith('step:验收编排:')),false);
 });

 // 有触发值的执行确认框在小窗口中也能完成输入与确认。
 await scenario('小窗口执行触发值确认',async()=>{
  await page.setViewportSize({width:822,height:591});await btn('执行').click();
  const confirm=page.getByRole('dialog',{name:'确认执行编排'});await confirm.waitFor();
  await page.getByRole('textbox',{name:'触发值',exact:true}).fill('12.345');
  const footer=confirm.getByRole('button',{name:/执\s*行/});const box=await footer.boundingBox();
  assert(box&&box.y>=0&&box.y+box.height<=591,'执行确认按钮必须在视口内');
  await capture({path:path.join(output,'execute-822.png')});
 },'?trigger');
 assert.deepEqual(runtimeErrors,[]);
 assert.equal(results.filter(r=>r.status==='failed').length,0,'存在失败场景，请查看证据');
}finally{
 await fs.writeFile(path.join(output,'results.json'),JSON.stringify({results,runtimeErrors},null,2));console.log(JSON.stringify({output,results,runtimeErrors}));
 await browser?.close();await server.close();
}
