import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 真实模板弹窗配合内存点表验证统一变更，不连接设备或写入平台。
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-template-additions-'));
const { chromium } = await (process.env.MSKDSP_PLAYWRIGHT_MODULE ? import(pathToFileURL(process.env.MSKDSP_PLAYWRIGHT_MODULE)) : import('playwright'));
const { createServer } = await import(pathToFileURL(root + '/node_modules/vite/dist/node/index.js'));
const { default: react } = await import(pathToFileURL(root + '/node_modules/@vitejs/plugin-react/dist/index.js'));
const fixture = JSON.parse(await fs.readFile(root + '/tests/fixtures/modbus-templates/aiswei-inverter-v2-1-5.json', 'utf8'));
const source = { ...fixture, points: fixture.points.slice(0, 6).map(point => ({ ...point, condition: '', default_selected: true })) };
const latest = { ...source, points: source.points.filter((_, index) => index !== 2).map((point, index) => index < 2 ? { ...point, scale: String(index + 2) } : point) };
const summary = { ...latest, id: 'db-1', revision: '2', point_count: latest.points.length, updated_at: 0 };

const entry = path.join(output, 'entry.tsx');
await fs.writeFile(entry, `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ConfigProvider, Button } from 'antd';
import { darkTheme } from ${JSON.stringify('/@fs/' + root + '/src/theme/dark.ts')};
import TemplateModal from ${JSON.stringify('/@fs/' + root + '/src/features/modbus-templates/TemplateModal.tsx')};
import { createApplication } from ${JSON.stringify('/@fs/' + root + '/src/features/modbus-templates/bindings.ts')};
import { PlatformAuthContext } from ${JSON.stringify('/@fs/' + root + '/src/auth/platform-auth-context.ts')};
const auth = { snapshot: { phase: 'authenticated', settings: { grpc_endpoint: 'fixture' }, status: { username: 'fixture' } } };
const source = ${JSON.stringify(source)};
const initial = createApplication({ platformId: 'fixture', templateId: 'db-1', revision: '1', template: source, addressBase: 1, prefix: '原前缀_', selectedIds: source.points.slice(0, 4).map(point => point.id), existingPoints: [], applicationId: 'app-1' });
const initialPoints = initial.points.map((point, index) => index === 1 ? { ...point, scale: 7, scale_decimal: '7' } : point);
function Fixture() {
  const [open, setOpen] = useState(true);
  const [table, setTable] = useState({ revision: '1', points: initialPoints, template_bindings_json: JSON.stringify({ schema_version: 1, applications: [initial.application] }) });
  window.fixtureTable = table;
  return <ConfigProvider theme={darkTheme}><App><PlatformAuthContext.Provider value={auth}>
    <Button onClick={() => setOpen(true)}>打开模板</Button>
    <TemplateModal open={open} connectionName="测试逆变器" protocol="RTU" addressBase={1} table={table} busy={false} onClose={() => setOpen(false)} onApply={async commit => { setTable({ revision: String(Number(table.revision) + 1), points: commit.points, template_bindings_json: JSON.stringify(commit.bindings) }); return true; }} />
  </PlatformAuthContext.Provider></App></ConfigProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`);
const aliases = Object.fromEntries(['react-dom', 'react', 'antd', '@tauri-apps/api', '@ant-design/icons'].map(name => [name, root + '/node_modules/' + name]));
const server = await createServer({ configFile: false, root, cacheDir: path.join(output, '.vite'), plugins: [react(), {
  name: 'template-additions-fixture',
  load(id) {
    const normalized = id.replaceAll('\\', '/');
    if (normalized === root + '/src/features/modbus-templates/catalog.ts') return `
      window.fixturePlatform = { summary: ${JSON.stringify(summary)}, template: ${JSON.stringify(latest)}, listCalls: 0, getCalls: 0 };
      const alternate = ${JSON.stringify({ ...summary, id: 'db-2', name: '另一模板' })};
      export const platformTemplateCatalog = () => ({
        list: async () => { const data = window.fixturePlatform; data.listCalls++; return { summaries: [data.summary, alternate], cached: false }; },
        get: async (_platform, id, revision) => { const data = window.fixturePlatform; data.getCalls++; return { summary: { ...(id === 'db-2' ? alternate : data.summary), revision }, template: revision === '1' ? ${JSON.stringify(source)} : data.template, platformId: 'fixture', cached: false }; }
      });`;
  },
  configureServer(vite) {
    vite.middlewares.use('/__template-additions', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><style>body{margin:0;background:#1e1e1e}</style></head><body><div id="root"></div><script type="module" src=${JSON.stringify('/@fs/' + entry.replaceAll('\\', '/'))}></script></body></html>`);
    });
  }
}], resolve: { alias: aliases }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, output] }, watch: null, hmr: false }, logLevel: 'error' });
let browser;
let page;
const results = [];
try {
  await server.listen();
  browser = await chromium.launch(process.env.MSKDSP_BROWSER_EXECUTABLE ? { executablePath: process.env.MSKDSP_BROWSER_EXECUTABLE } : {});
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__template-additions`);
  await page.locator('.ant-table-body .ant-table-row').first().waitFor();
  const rows = page.locator('.ant-table-body .ant-table-row');
  const rowFor = index => rows.filter({ hasText: '原前缀_' + source.points[index].tag });
  const assertZeroSelection = async () => {
    assert.equal(await rows.getByRole('checkbox', { checked: true }).count(), 0, '重新加载后必须全部不勾选');
    assert.equal(await page.getByRole('button', { name: '应用所选变更', exact: true }).isDisabled(), true);
  };
  assert.equal(await rows.count(), 6, '同一列表包含未添加、已添加、修改、冲突和删除');
  assert.equal(await page.getByRole('combobox', { name: '模板操作', exact: true }).count(), 0, '不再切换添加和更新操作');
  assert.equal(await page.getByRole('button', { name: '默认选择', exact: true }).count(), 0, '移除默认选择按钮');
  await assertZeroSelection();
  assert.match(await rowFor(0).innerText(), /平台修改/);
  assert.match(await rowFor(1).innerText(), /现场修改|现场冲突/);
  assert.match(await rowFor(2).innerText(), /平台删除/);
  assert.match(await rowFor(3).innerText(), /已添加/);
  assert.equal(await rowFor(3).getByRole('checkbox').isDisabled(), true, '无变化已添加点禁止重复勾选');
  await rowFor(4).getByRole('checkbox').check();
  assert.match(await page.locator('.mt-footer').innerText(), /新增 1 项.*更新 0 项.*删除 0 项/s);
  await page.getByRole('button', { name: '应用所选变更', exact: true }).click();
  await page.waitForFunction(() => window.fixtureTable.points.length === 5);
  const saved = await page.evaluate(() => window.fixtureTable);
  const bindings = JSON.parse(saved.template_bindings_json);
  assert.equal(bindings.applications.length, 1, '补加沿用同一应用记录');
  assert.equal(bindings.applications[0].application_id, 'app-1');
  assert.equal(bindings.applications[0].prefix, '原前缀_');
  assert.equal(saved.points.find(point => point.tag.endsWith(source.points[1].tag)).scale_decimal, '7', '未选择的现场修改保持不变');
  assert.equal(bindings.applications[0].mappings[0].source_revision, '1', '补加不得接受未选择的已有点更新');
  const calls = await page.evaluate(() => ({ list: window.fixturePlatform.listCalls, get: window.fixturePlatform.getCalls }));
  // 模拟窗口关闭后平台发布新版本，重新打开必须主动获取而无需点击刷新。
  await page.evaluate(() => {
    window.fixturePlatform.summary.revision = '3';
    window.fixturePlatform.template.points[0].scale = '4';
    window.fixturePlatform.template.points[0].tag = '平台更新后的标签';
  });
  await page.getByRole('button', { name: '打开模板', exact: true }).click();
  await page.getByText('原前缀_平台更新后的标签', { exact: false }).first().waitFor();
  const reopenedCalls = await page.evaluate(() => ({ list: window.fixturePlatform.listCalls, get: window.fixturePlatform.getCalls }));
  assert.ok(reopenedCalls.list > calls.list && reopenedCalls.get > calls.get, '每次打开均重新读取目录和选中模板内容');
  assert.equal(await rows.count(), 6);
  await assertZeroSelection();
  await rowFor(5).getByRole('checkbox').check();
  await page.getByRole('button', { name: /刷新平台模板$/ }).click();
  await page.getByText('原前缀_平台更新后的标签', { exact: false }).first().waitFor();
  await assertZeroSelection();
  await rowFor(5).getByRole('checkbox').check();
  await page.getByRole('textbox', { name: '指定历史版本', exact: true }).fill('1');
  await page.getByRole('button', { name: '读取指定版本', exact: true }).click();
  await page.getByText('历史版本 1 · 当前版本 3', { exact: true }).waitFor();
  await assertZeroSelection();
  await page.getByRole('button', { name: '返回当前版本', exact: true }).click();
  await page.getByText('原前缀_平台更新后的标签', { exact: false }).first().waitFor();
  await assertZeroSelection();
  await rowFor(5).getByRole('checkbox').check();
  await page.getByRole('button', { name: /另一模板/ }).click();
  await page.locator('.mt-prefix').waitFor();
  await assertZeroSelection();
  await page.getByRole('button', { name: new RegExp(fixture.name) }).click();
  await page.getByText('原前缀_平台更新后的标签', { exact: false }).first().waitFor();
  await assertZeroSelection();
  await page.screenshot({ path: path.join(output, 'unified-changes.png') });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(200);
  const compact = await page.locator('.ant-table-body').evaluate(el => {
    const rect = el.getBoundingClientRect();
    const area = el.closest('.mt-table-area').getBoundingClientRect();
    return { height: el.clientHeight, bottom: rect.bottom, areaBottom: area.bottom };
  });
  const footer = await page.locator('.mt-footer').boundingBox();
  assert.ok(compact.height > 50, '已有模板的操作栏不能挤没表格');
  assert.ok(compact.bottom <= compact.areaBottom + 1, '小窗口表格滚动区不能被裁切');
  assert.ok(footer.y + footer.height <= 720, '小窗口底部操作栏应完整可见');
  await page.screenshot({ path: path.join(output, 'additions-720.png') });
  await rows.filter({ hasText: '原前缀_平台更新后的标签' }).getByRole('checkbox').check();
  await rowFor(1).getByRole('checkbox').check();
  await rowFor(2).getByRole('checkbox').check();
  await rowFor(5).getByRole('checkbox').check();
  assert.match(await page.locator('.mt-footer').innerText(), /新增 1 项.*更新 2 项.*删除 1 项/s);
  await page.getByRole('button', { name: '应用所选变更', exact: true }).click();
  await page.getByRole('button', { name: '确认应用', exact: true }).click();
  await page.waitForFunction(() => window.fixtureTable.points.some(point => point.tag === '原前缀_平台更新后的标签'));
  const mixed = await page.evaluate(() => window.fixtureTable);
  assert.equal(mixed.points.length, 5, '混合提交同时新增、修改和删除');
  assert.equal(mixed.points.find(point => point.tag === '原前缀_平台更新后的标签').scale_decimal, '4');
  assert.equal(mixed.points.find(point => point.tag.endsWith(source.points[1].tag)).scale_decimal, '3', '明确选择冲突后采用平台值');
  assert.equal(mixed.points.some(point => point.tag.endsWith(source.points[2].tag)), false, '明确选择平台删除后移除现场点');
  await page.getByRole('button', { name: '打开模板', exact: true }).click();
  await page.locator('.ant-table-body .ant-table-row').first().waitFor();
  assert.equal(await rows.count(), 5);
  assert.equal(await rows.getByRole('checkbox', { disabled: true }).count(), 5, '全部应用后已添加点均禁选');
  await assertZeroSelection();
  const complete = await page.evaluate(() => JSON.parse(window.fixtureTable.template_bindings_json));
  assert.equal(complete.applications.length, 1);
  assert.equal(complete.applications[0].application_id, 'app-1');
  await page.screenshot({ path: path.join(output, 'all-applied-720.png') });
  assert.deepEqual(errors, []);
  results.push({ status: 'passed', checks: ['统一显示全部变更', '全部手动选择', '重开自动获取最新平台模板', '刷新及切换后零选择', '未选择现场值及基线保留', '新增更新删除一次保存', '小窗口布局', '已应用禁止重复选择'], compact });
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') });
  results.push({ status: 'failed', error: String(error) });
} finally {
  await browser?.close();
  await server.close();
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ output, results }, null, 2));
}
assert.ok(results.length === 1 && results[0].status === 'passed', '模板补加浏览器回归失败');
