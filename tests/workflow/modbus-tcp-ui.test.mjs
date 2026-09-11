import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const pageSource = read('../../src/pages/ModbusTCP/index.tsx');
const adapterSource = read('../../src/adapters/tauri.ts');
const browserAdapterSource = read('../../src/adapters/browser.ts');
const rustCommandsSource = read('../../src-tauri/src/commands/modbus_tcp.rs');
const rustCommandRegistrySource = read('../../src-tauri/src/lib.rs');
const rustExportConfigSource = read('../../src-tauri/src/commands/export_config.rs');
const protoSource = read('../../proto/ModbusTCP.proto');
const routerSource = read('../../src/router.tsx');
const layoutSource = read('../../src/layouts/MainLayout.tsx');
const configExportSource = read('../../src/utils/config-export.ts');

// 验证 ModbusTCP 使用独立页面、路由和导航入口。
test('ModbusTCP has an independent protocol page', () => {
  assert.match(routerSource, /path: 'protocol\/modbus-tcp'/);
  assert.match(layoutSource, /\/protocol\/modbus-tcp[\s\S]*Modbus TCP/);
  assert.match(pageSource, /api\.modbusTcpListLinks\(\)/);
  assert.match(pageSource, /moduleName:\s*'ModbusTCP'/);
});

// 验证上位机桥接覆盖下位机 ModbusTCP 控制面接口。
test('ModbusTCP adapter exposes link and point-table operations', () => {
  const operations = [
    ['UpsertLink', 'modbusTcpUpsertLink', 'modbus_tcp_upsert_link'],
    ['RenameLink', 'modbusTcpRenameLink', 'modbus_tcp_rename_link'],
    ['GetLink', 'modbusTcpGetLink', 'modbus_tcp_get_link'],
    ['ListLinks', 'modbusTcpListLinks', 'modbus_tcp_list_links'],
    ['DeleteLink', 'modbusTcpDeleteLink', 'modbus_tcp_delete_link'],
    ['StartLink', 'modbusTcpStartLink', 'modbus_tcp_start_link'],
    ['StopLink', 'modbusTcpStopLink', 'modbus_tcp_stop_link'],
    ['UpsertPointTable', 'modbusTcpUpsertPointTable', 'modbus_tcp_upsert_point_table'],
    ['GetPointTable', 'modbusTcpGetPointTable', 'modbus_tcp_get_point_table'],
  ];

  for (const [rpcName, adapterName, commandName] of operations) {
    assert.match(protoSource, new RegExp(`rpc ${rpcName}\\(`));
    assert.match(adapterSource, new RegExp(adapterName));
    assert.match(rustCommandsSource, new RegExp(`fn ${commandName}\\(`));
    assert.match(rustCommandRegistrySource, new RegExp(`commands::modbus_tcp::${commandName}`));
  }
  assert.match(rustCommandsSource, /protocol = "ModbusTCP"/);
});

// 验证 TCP 连接表单包含 MBAP 链路所需的目标端和 Unit ID 参数。
test('ModbusTCP validates TCP endpoint fields', () => {
  assert.match(pageSource, /name="host"/);
  assert.match(pageSource, /name="port"/);
  assert.match(pageSource, /name="unit_id"/);
  assert.match(pageSource, /name="connect_timeout_ms"/);
  assert.match(pageSource, /name="request_timeout_ms"/);
});

// 验证隐藏的下位机暂未生效字段在编辑和复制时仍会原样保留。
test('ModbusTCP preserves hidden read-plan and deadband values', () => {
  assert.match(pageSource, /read_plan:\s*editingLink\?\.read_plan/);
  assert.match(pageSource, /read_plan:\s*sourceConfig\.read_plan/);
  assert.match(pageSource, /name="deadband"\s+hidden/);
});

// 验证浏览器开发模式模拟下位机保存非空点表后自动启动连接的当前行为。
test('browser mock mirrors ModbusTCP point-table auto-start behavior', () => {
  assert.match(
    browserAdapterSource,
    /modbusTcpUpsertPointTable:[\s\S]*?nextPoints\.length > 0[\s\S]*?setLinkState\(modbusTcpLinks, connName, 2\)/,
  );
});

// 验证配置导入导出将 ModbusTCP 作为独立配置段处理。
test('ModbusTCP participates in config import and export', () => {
  assert.match(configExportSource, /key: 'modbus_tcp'/);
  assert.match(configExportSource, /async function loadModbusTcpConfig/);
  assert.match(configExportSource, /async function syncModbusTcp/);
  assert.match(rustExportConfigSource, /#\[serde\(default\)\]\s+pub modbus_tcp: ModbusTcpExportConfigDto/);
});
