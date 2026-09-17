import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORKSPACE_SCHEMA_VERSION,
  createEmptyWorkspace,
} from '../../src/offline/workspace/types.ts';
import {
  ensureWorkspaceFileName,
  parseWorkspace,
  serializeWorkspace,
} from '../../src/offline/workspace/serialize.ts';

// 空工作区必须包含全部导出分区、空的连接编号注册表与空的导出分区声明。
test('empty workspace contains every config section and an empty registry', () => {
  const workspace = createEmptyWorkspace('经开区二期', '2026-05-20T10:00:00.000Z');

  assert.equal(workspace.schema_version, WORKSPACE_SCHEMA_VERSION);
  assert.equal(workspace.workspace_name, '经开区二期');
  assert.equal(workspace.created_at, '2026-05-20T10:00:00.000Z');
  assert.equal(workspace.updated_at, '2026-05-20T10:00:00.000Z');
  assert.deepEqual(workspace.conn_ids, { map: {}, next_conn_id: 1 });
  assert.deepEqual(workspace.base, { source: 'empty', exported_at: '', included_sections: [], conn_tags: [] });
  assert.deepEqual(workspace.metadata, { scope: 'full', included_sections: [] });
  assert.deepEqual(workspace.agc_control_profiles, []);
  assert.deepEqual(workspace.config.iec104.links, []);
  assert.deepEqual(workspace.config.modbus_rtu, { mqtt: null, links: [] });
  assert.deepEqual(workspace.config.modbus_tcp.links, []);
  assert.deepEqual(workspace.config.dlt645, { mqtt: null, links: [] });
  assert.deepEqual(workspace.config.agc.groups, []);
  assert.deepEqual(workspace.config.avc.groups, []);
  assert.deepEqual(workspace.config.calc.groups, []);
  assert.deepEqual(workspace.config.data_bus.connections, []);
  assert.deepEqual(workspace.config.data_bus.conn_tags, []);
  assert.deepEqual(workspace.config.data_bus.routes, { replace: true, items: [] });
});

// 工作区序列化后必须能原样解析，中文工作区名与连接编号不得丢失。
test('workspace survives a serialize and parse round trip', () => {
  const workspace = createEmptyWorkspace('经开区二期', '2026-05-20T10:00:00.000Z');
  workspace.conn_ids = { map: { 'IEC104\u0000主站': 1 }, next_conn_id: 2 };
  workspace.config.iec104.links = [{
    link: { config: { conn_name: '主站' } },
    point_table: { conn_name: '主站', points: [{ tag: 'A相电压' }], replace: true },
  }];

  const raw = serializeWorkspace(workspace);
  const parsed = parseWorkspace(raw);

  assert.ok(raw.endsWith('\n'));
  assert.deepEqual(parsed, workspace);
});

// 非法 JSON 必须给出中文错误，不能把解析异常直接抛给页面。
test('parse rejects malformed json with a chinese message', () => {
  assert.throws(() => parseWorkspace('{'), /工作区文件不是合法 JSON/);
});

// 不支持的工作区版本必须拒绝载入，避免用新版字段覆盖本地数据。
test('parse rejects unsupported schema version', () => {
  const raw = JSON.stringify({ schema_version: WORKSPACE_SCHEMA_VERSION + 1, workspace_name: 'x', config: {} });

  assert.throws(() => parseWorkspace(raw), /不支持的工作区文件版本/);
});

// 缺少配置段的工作区文件必须拒绝载入并说明缺少什么。
test('parse rejects a workspace without config data', () => {
  const raw = JSON.stringify({ schema_version: WORKSPACE_SCHEMA_VERSION, workspace_name: 'x' });

  assert.throws(() => parseWorkspace(raw), /工作区文件缺少配置数据/);
});

// 旧文件或手工文件缺少可选字段时按空集合补齐，避免因缺字段无法载入。
test('parse fills missing optional fields with empty defaults', () => {
  const parsed = parseWorkspace(JSON.stringify({
    schema_version: WORKSPACE_SCHEMA_VERSION,
    workspace_name: '手写工作区',
    config: { iec104: { links: [] } },
  }));

  assert.deepEqual(parsed.conn_ids, { map: {}, next_conn_id: 1 });
  assert.deepEqual(parsed.agc_control_profiles, []);
  assert.deepEqual(parsed.metadata.included_sections, []);
  assert.deepEqual(parsed.config.modbus_rtu, { mqtt: null, links: [] });
  assert.deepEqual(parsed.config.data_bus.routes, { replace: true, items: [] });
  assert.equal(parsed.base.source, 'empty');
});

// 非法连接编号注册表必须被拒绝，避免载入后 conn_id 冲突。
test('parse rejects an invalid connection id registry', () => {
  const raw = JSON.stringify({
    schema_version: WORKSPACE_SCHEMA_VERSION,
    workspace_name: 'x',
    config: {},
    conn_ids: { map: { 'IEC104\u0000主站': 'abc' }, next_conn_id: 2 },
  });

  assert.throws(() => parseWorkspace(raw), /连接编号注册表不合法/);
});

// 工作区文件名必须统一带上 .mskwsp 扩展名，且不重复追加。
test('workspace file names get the mskwsp extension once', () => {
  assert.equal(ensureWorkspaceFileName('经开区二期'), '经开区二期.mskwsp');
  assert.equal(ensureWorkspaceFileName('经开区二期.mskwsp'), '经开区二期.mskwsp');
  assert.equal(ensureWorkspaceFileName('  '), '未命名工作区.mskwsp');
});
