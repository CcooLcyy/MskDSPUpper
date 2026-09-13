import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const page = read('../../src/pages/IEC104/index.tsx');
const panel = read('../../src/pages/IEC104/SoeHistoryPanel.tsx');
const views = read('../../src/components/protocol/protocol-view.ts');
const adapter = read('../../src/adapters/tauri.ts');
const mock = read('../../src/adapters/browser.ts');

test('IEC104 页面在连接配置和报文日志之间提供 SOE 历史视图', () => {
  assert.match(views, /value: 'soe'/);
  assert.match(page, /currentView === 'soe'/);
  assert.match(page, /<SoeHistoryPanel connName=\{selectedConn\}/);
});

test('SOE 历史页提供北京时间、筛选、5 秒刷新和两种导出', () => {
  assert.match(panel, /timeZone: 'Asia\/Shanghai'/);
  assert.match(panel, /window\.setInterval\([^\n]*5000/);
  assert.match(panel, /导出当前页/);
  assert.match(panel, /导出全部/);
  assert.match(panel, /acknowledged_filter/);
});

test('IEC104 SOE 查询在 Tauri 和浏览器适配器中均可用', () => {
  assert.match(adapter, /iec104QuerySoe:/);
  assert.match(adapter, /iec104_query_soe/);
  assert.match(mock, /iec104QuerySoe: async/);
  assert.match(mock, /before_event_sequence/);
});
