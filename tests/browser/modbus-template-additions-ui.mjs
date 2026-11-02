import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 真实模板弹窗配合内存点表验证补加流程，不连接设备或写入平台。
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-template-additions-'));
const { chromium } = await (process.env.MSKDSP_PLAYWRIGHT_MODULE ? import(pathToFileURL(process.env.MSKDSP_PLAYWRIGHT_MODULE)) : import('playwright'));
const { createServer } = await import(pathToFileURL(root + '/node_modules/vite/dist/node/index.js'));
const { default: react } = await import(pathToFileURL(root + '/node_modules/@vitejs/plugin-react/dist/index.js'));
const fixture = JSON.parse(await fs.readFile(root + '/tests/fixtures/modbus-templates/aiswei-inverter-v2-1-5.json', 'utf8'));
const source = { ...fixture, points: fixture.points.slice(0, 3).map(point => ({ ...point, condition: '', default_selected: true })) };
const latest = { ...source, points: source.points.map((point, index) => index === 0 ? { ...point, scale: '2' } : point) };
const summary = { ...latest, id: 'db-1', revision: '2', point_count: latest.points.length, updated_at: 0 };
const oldModal = process.env.MSKDSP_TEMPLATE_BASELINE ? execFileSync('git', ['show', 'HEAD:src/features/modbus-templates/TemplateModal.tsx'], { cwd: root, encoding: 'utf8' }) : null;
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
const initial = createApplication({ platformId: 'fixture', templateId: 'db-1', revision: '1', template: source, addressBase: 1, prefix: '原前缀_', selectedIds: [source.points[0].id], existingPoints: [], applicationId: 'app-1' });
const initialPoints = initial.points.map(point => ({ ...point, scale: 7, scale_decimal: '7' }));
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
    if (oldModal && normalized === root + '/src/features/modbus-templates/TemplateModal.tsx') return oldModal;
    if (normalized === root + '/src/features/modbus-templates/catalog.ts') return `export const platformTemplateCatalog = () => ({ list: async () => ({ summaries: [${JSON.stringify(summary)}], cached: false }), get: async () => (${JSON.stringify({ summary, template: latest, platformId: 'fixture', cached: false })}) });`;
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
  assert.equal(await rows.count(), 3, '重复打开默认应显示全部模板点位，可继续补加');
  const applied = rows.filter({ hasText: '原前缀_' + source.points[0].tag });
  assert.match(await applied.innerText(), /已添加/);
  assert.equal(await applied.getByRole('checkbox').isDisabled(), true, '已添加点位禁止重复勾选');
  const addition = rows.filter({ hasText: '原前缀_' + source.points[1].tag });
  await addition.getByRole('checkbox').check();
  // 只添加一个点，保留另一个未添加项供重新打开核对。
  const other = rows.filter({ hasText: '原前缀_' + source.points[2].tag });
  await other.getByRole('checkbox').uncheck();
  await page.getByRole('button', { name: '添加所选点位', exact: true }).click();
  await page.waitForFunction(() => window.fixtureTable.points.length === 2);
  const saved = await page.evaluate(() => window.fixtureTable);
  const bindings = JSON.parse(saved.template_bindings_json);
  assert.equal(bindings.applications.length, 1, '补加应沿用同一应用记录');
  assert.equal(bindings.applications[0].application_id, 'app-1');
  assert.equal(bindings.applications[0].prefix, '原前缀_');
  assert.equal(saved.points[0].scale_decimal, '7', '补加不得覆盖现场修改');
  assert.equal(bindings.applications[0].mappings[0].source_revision, '1', '补加不得接受已有点更新');
  await page.getByRole('button', { name: '打开模板', exact: true }).click();
  await page.locator('.ant-table-body .ant-table-row').first().waitFor();
  assert.equal(await rows.count(), 3);
  assert.equal(await rows.filter({ hasText: '原前缀_' + source.points[1].tag }).getByRole('checkbox').isDisabled(), true);
  assert.equal(await other.getByRole('checkbox').isDisabled(), false);
  await page.getByRole('combobox', { name: '模板操作', exact: true }).click();
  assert.equal(await page.getByText('作为新的模板应用（可使用不同前缀）', { exact: true }).count(), 0, '移除重复应用入口');
  await page.getByTitle('检查模板更新', { exact: true }).click();
  await page.getByText('现场修改，需选择', { exact: true }).waitFor();
  assert.equal(await rows.count(), 1, '检查更新仍应保留未接受的平台修改');
  assert.equal(await rows.first().getByRole('checkbox').isChecked(), false, '现场冲突默认不选');
  await page.screenshot({ path: path.join(output, 'update.png') });
  await page.getByRole('combobox', { name: '模板操作', exact: true }).click();
  await page.getByTitle('添加点位', { exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.ant-table-body .ant-table-row').length === 3);
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '添加所选点位' && !button.disabled));
  assert.equal(await page.getByRole('button', { name: '添加所选点位', exact: true }).isEnabled(), true, '切回补加后剩余点位可继续保存');
  await page.locator('.mt-heading').click();
  await page.getByTitle('检查模板更新', { exact: true }).waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(output, 'additions.png') });
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
  await page.getByRole('button', { name: '添加所选点位', exact: true }).click();
  await page.waitForFunction(() => window.fixtureTable.points.length === 3);
  await page.getByRole('button', { name: '打开模板', exact: true }).click();
  await page.locator('.ant-table-body .ant-table-row').first().waitFor();
  assert.equal(await rows.count(), 3);
  assert.equal(await rows.getByRole('checkbox', { disabled: true }).count(), 3, '全部补加后均应禁选');
  assert.equal(await page.getByRole('button', { name: '添加所选点位', exact: true }).isDisabled(), true, '全部已添加时不可重复保存');
  const complete = await page.evaluate(() => JSON.parse(window.fixtureTable.template_bindings_json));
  assert.equal(complete.applications.length, 1);
  assert.equal(complete.applications[0].application_id, 'app-1');
  await page.screenshot({ path: path.join(output, 'all-added-720.png') });
  assert.deepEqual(errors, []);
  results.push({ status: 'passed', checks: ['默认补加全点列表', '已添加禁选', '原记录补加并保留现场值及基线', '重开后可继续补加', '独立检查模板更新', '已有模板小窗口布局', '全部补加后禁止重复保存'], compact });
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
