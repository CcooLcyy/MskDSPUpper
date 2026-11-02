import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 挂载真实弹窗，用固定平台目录隔离网络；不连接设备或写入点表。
const root = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/').replace(/\/$/, '');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'mskdsp-template-scroll-'));
const { chromium } = await (process.env.MSKDSP_PLAYWRIGHT_MODULE ? import(pathToFileURL(process.env.MSKDSP_PLAYWRIGHT_MODULE)) : import('playwright'));
const { createServer } = await import(pathToFileURL(root + '/node_modules/vite/dist/node/index.js'));
const { default: react } = await import(pathToFileURL(root + '/node_modules/@vitejs/plugin-react/dist/index.js'));
const template = JSON.parse(await fs.readFile(root + '/tests/fixtures/modbus-templates/huawei-sun2000-three-v3-02.json', 'utf8'));
const summary = { ...template, revision: '1', point_count: template.points.length, updated_at: 0 };
const entry = path.join(output, 'entry.tsx');
await fs.writeFile(entry, `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App, ConfigProvider, Button } from 'antd';
import { darkTheme } from ${JSON.stringify('/@fs/' + root + '/src/theme/dark.ts')};
import TemplateModal from ${JSON.stringify('/@fs/' + root + '/src/features/modbus-templates/TemplateModal.tsx')};
import { PlatformAuthContext } from ${JSON.stringify('/@fs/' + root + '/src/auth/platform-auth-context.ts')};
const auth = { snapshot: { phase: 'authenticated', settings: { grpc_endpoint: 'fixture' }, status: { username: 'fixture' } } };
const table = { revision: '1', points: [], template_bindings_json: '' };
function Fixture() {
  const [open, setOpen] = useState(true);
  return <ConfigProvider theme={darkTheme}><App><PlatformAuthContext.Provider value={auth}>
    <Button onClick={() => setOpen(true)}>打开模板</Button>
    <TemplateModal open={open} connectionName="测试逆变器" protocol="RTU" addressBase={1} table={table} busy={false} onClose={() => setOpen(false)} onApply={async () => true} />
  </PlatformAuthContext.Provider></App></ConfigProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`);
const aliases = Object.fromEntries(['react-dom', 'react', 'antd', '@tauri-apps/api', '@ant-design/icons'].map(name => [name, root + '/node_modules/' + name]));
const server = await createServer({ configFile: false, root, cacheDir: path.join(output, '.vite'), plugins: [react(), {
  name: 'template-scroll-fixture',
  load(id) {
    if (id.replaceAll('\\', '/') === root + '/src/features/modbus-templates/catalog.ts') return `export const platformTemplateCatalog = () => ({ list: async () => ({ summaries: [${JSON.stringify(summary)}], cached: false }), get: async () => (${JSON.stringify({ summary, template, platformId: 'fixture', cached: false })}) });`;
  },
  configureServer(vite) {
    vite.middlewares.use('/__template-scroll', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><style>body{margin:0;background:#1e1e1e}</style></head><body><div id="root"></div><script type="module" src=${JSON.stringify('/@fs/' + entry.replaceAll('\\', '/'))}></script></body></html>`);
    });
  }
}], resolve: { alias: aliases }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, output] }, watch: null, hmr: false }, logLevel: 'error' });
let browser;
const results = [];
try {
  await server.listen();
  browser = await chromium.launch(process.env.MSKDSP_BROWSER_EXECUTABLE ? { executablePath: process.env.MSKDSP_BROWSER_EXECUTABLE } : {});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const viewport of [{ width: 2560, height: 1349 }, { width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__template-scroll`);
    await page.locator('.ant-table-body .ant-table-row').first().waitFor();
    await page.waitForTimeout(400);
    const body = page.locator('.mt-table-area .ant-table-body');
    const metrics = await body.evaluate(el => {
      el.scrollTop = el.scrollHeight;
      const area = el.closest('.mt-table-area').getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      return { bottom: rect.bottom, areaBottom: area.bottom, height: el.clientHeight, scrollHeight: el.scrollHeight };
    });
    try {
      assert.ok(metrics.height > 50, '点表必须有可用的滚动高度');
      assert.ok(metrics.bottom <= metrics.areaBottom + 1, `滚动条下端被裁切：${JSON.stringify(metrics)}`);
      const last = body.locator('tbody .ant-table-row').last();
      await last.scrollIntoViewIfNeeded();
      const rowBox = await last.boundingBox();
      assert.ok(rowBox.y + rowBox.height <= metrics.areaBottom + 1, '最后一行必须完整显示');
      await page.screenshot({ path: path.join(output, `bottom-${viewport.height}.png`) });
      const top = await body.evaluate(el => el.scrollTop);
      await body.hover();
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(150);
      assert.equal(await body.evaluate(el => el.scrollTop), top, '到达底部后滚动位置应保持不变');
      await page.getByRole('textbox', { name: '搜索点位', exact: true }).fill(template.points.at(-1).tag);
      await page.waitForTimeout(150);
      assert.ok(await body.locator('tbody .ant-table-row').count() > 0, '筛选后保留匹配行');
      await page.getByRole('textbox', { name: '搜索点位', exact: true }).fill('不存在的点位');
      await page.getByText('没有匹配点位', { exact: true }).waitFor();
      const footer = await page.locator('.mt-footer').boundingBox();
      assert.ok(footer.y + footer.height <= viewport.height, '空结果时底部操作栏保持可见');
      await page.getByRole('button', { name: /取\s*消/ }).click();
      await page.getByRole('button', { name: '打开模板', exact: true }).click();
      await body.locator('tbody .ant-table-row').first().waitFor();
      assert.equal(await body.evaluate(el => el.scrollTop), 0, '重新打开后从顶部显示');
      results.push({ viewport, status: 'passed', metrics });
    } catch (error) {
      await page.screenshot({ path: path.join(output, `failure-${viewport.height}.png`) });
      results.push({ viewport, status: 'failed', error: String(error), metrics });
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ output, results }, null, 2));
}
assert.ok(results.length === 3 && results.every(result => result.status === 'passed'), '滚动布局检查失败');
