import assert from 'node:assert/strict';
import test from 'node:test';

import { findConnectionId } from '../../src/offline/workspace/registry.ts';
import {
  snapshotToWorkspace,
  workspaceToSnapshot,
} from '../../src/offline/workspace/snapshot.ts';
import { createEmptyWorkspace } from '../../src/offline/workspace/types.ts';

const NOW = '2026-05-20T10:00:00.000Z';

function iec104Link(connName, tags) {
  return {
    link: { config: { conn_name: connName } },
    point_table: {
      conn_name: connName,
      points: tags.map((tag, index) => ({ tag, ioa: index + 1 })),
      replace: true,
    },
  };
}

// 未选择任何分区时必须拒绝导出，避免生成空目标态快照。
test('workspaceToSnapshot rejects an empty section selection', () => {
  const workspace = createEmptyWorkspace('ws', NOW);

  assert.throws(
    () => workspaceToSnapshot(workspace, { sections: [], exportedAtIso: NOW }),
    /至少需要选择一个配置分区/,
  );
});

// 导出只包含选中分区，并写出正确的 metadata 与 source 字段。
test('workspaceToSnapshot scopes sections and metadata', () => {
  const workspace = createEmptyWorkspace('ws', NOW);
  workspace.config.iec104.links.push(iec104Link('main', ['A']));
  workspace.config.data_bus.connections.push({ module_name: 'IEC104', conn_name: 'main' });

  const snapshot = workspaceToSnapshot(workspace, { sections: ['iec104'], exportedAtIso: NOW });

  assert.equal(snapshot.schema_version, 1);
  assert.equal(snapshot.exported_at, NOW);
  assert.equal(snapshot.source.manager_addr, '');
  assert.equal(snapshot.module_startup.source, 'get_running_module_info');
  assert.equal(snapshot.config.iec104.links.length, 1);
  assert.deepEqual(snapshot.config.data_bus.connections, []);
  assert.deepEqual(snapshot.config.modbus_rtu, { mqtt: null, links: [] });
  assert.deepEqual(snapshot.metadata, { scope: 'partial', included_sections: ['iec104'] });
});

// 路由端点必须剥离运行态 conn_id，由现场导入重新解析。
test('workspaceToSnapshot strips runtime conn ids from routes', () => {
  const workspace = createEmptyWorkspace('ws', NOW);
  workspace.config.data_bus.routes.items.push({
    src: { module_name: 'ModbusRTU', conn_name: '1-1#', tag: 'A', conn_id: 7 },
    dst: { module_name: 'IEC104', conn_name: 'main', tag: 'B', conn_id: 9 },
  });

  const snapshot = workspaceToSnapshot(workspace, { sections: ['data_bus'], exportedAtIso: NOW });

  assert.deepEqual(snapshot.config.data_bus.routes.items[0].src, {
    module_name: 'ModbusRTU',
    conn_name: '1-1#',
    tag: 'A',
  });
  assert.deepEqual(snapshot.config.data_bus.routes.items[0].dst, {
    module_name: 'IEC104',
    conn_name: 'main',
    tag: 'B',
  });
});

// 模块清单必须由工作区内容推导，供现场导入决定需要确保哪些模块。
test('workspaceToSnapshot derives the module list from content', () => {
  const workspace = createEmptyWorkspace('ws', NOW);
  workspace.config.iec104.links.push(iec104Link('main', ['A']));
  workspace.config.data_bus.connections.push({ module_name: 'IEC104', conn_name: 'main' });

  const snapshot = workspaceToSnapshot(workspace, { sections: ['iec104', 'data_bus'], exportedAtIso: NOW });

  assert.deepEqual(snapshot.module_startup.modules, ['DataCenter', 'IEC104']);
});

// 导出必须带上 AGC 固定控制参数 profile（选中 agc 分区时）。
test('workspaceToSnapshot keeps agc control profiles only for the agc section', () => {
  const workspace = createEmptyWorkspace('ws', NOW);
  workspace.agc_control_profiles.push({ group_name: 'g', members: [], version: 1, confirmed_at_ms: 0 });

  const withAgc = workspaceToSnapshot(workspace, { sections: ['agc'], exportedAtIso: NOW });
  const withoutAgc = workspaceToSnapshot(workspace, { sections: ['iec104'], exportedAtIso: NOW });

  assert.equal(withAgc.agc_control_profiles.length, 1);
  assert.deepEqual(withoutAgc.agc_control_profiles, []);
});

// 载入 .mskcfg 打底时必须重建本地连接编号并记录打底来源。
test('snapshotToWorkspace seeds a workspace from a device snapshot', () => {
  const workspace = createEmptyWorkspace('ws', NOW);
  const snapshot = {
    schema_version: 1,
    exported_at: '2026-05-19T08:00:00.000Z',
    source: { manager_addr: '' },
    module_startup: { source: 'get_running_module_info', modules: ['IEC104', 'DataCenter'] },
    config: {
      iec104: { links: [iec104Link('main', ['A'])] },
      modbus_rtu: { mqtt: null, links: [] },
      modbus_tcp: { links: [] },
      dlt645: { mqtt: null, links: [] },
      agc: { groups: [] },
      avc: { groups: [] },
      calc: { groups: [] },
      data_bus: {
        connections: [
          { module_name: 'IEC104', conn_name: 'main' },
          { module_name: 'ModbusRTU', conn_name: '1-1#' },
        ],
        conn_tags: [{ module_name: 'IEC104', conn_name: 'main', tags: ['A', '__time_sync__'] }],
        routes: { replace: true, items: [] },
      },
    },
    agc_control_profiles: [],
    metadata: { scope: 'partial', included_sections: ['iec104', 'data_bus'] },
  };

  const seeded = snapshotToWorkspace(workspace, snapshot, { nowIso: '2026-05-21T00:00:00.000Z' });

  assert.equal(seeded.workspace_name, 'ws');
  assert.equal(seeded.created_at, NOW);
  assert.equal(seeded.updated_at, '2026-05-21T00:00:00.000Z');
  assert.equal(seeded.base.source, 'device-snapshot');
  assert.equal(seeded.base.exported_at, '2026-05-19T08:00:00.000Z');
  assert.deepEqual(seeded.base.included_sections, ['iec104', 'data_bus']);
  assert.deepEqual(seeded.metadata, { scope: 'partial', included_sections: ['iec104', 'data_bus'] });
  assert.equal(seeded.config.iec104.links.length, 1);
  assert.deepEqual(seeded.config.data_bus.conn_tags, [
    { module_name: 'IEC104', conn_name: 'main', tags: ['A', '__time_sync__'] },
  ]);
  assert.equal(findConnectionId(seeded.conn_ids, 'IEC104', 'main'), 1);
  assert.equal(findConnectionId(seeded.conn_ids, 'ModbusRTU', '1-1#'), 2);
  assert.equal(seeded.conn_ids.next_conn_id, 3);
});

// 打底时链路里出现但连接注册表没有的连接同样要登记，避免离线配路由时缺连接。
test('snapshotToWorkspace registers link connections missing from the registry', () => {
  const workspace = createEmptyWorkspace('ws', NOW);
  const snapshot = {
    schema_version: 1,
    exported_at: '2026-05-19T08:00:00.000Z',
    source: { manager_addr: '' },
    module_startup: { source: 'get_running_module_info', modules: [] },
    config: {
      iec104: { links: [] },
      modbus_rtu: { mqtt: null, links: [{ link: { config: { conn_name: '1-1#' } }, point_table: { conn_name: '1-1#', points: [], replace: true } }] },
      modbus_tcp: { links: [] },
      dlt645: { mqtt: null, links: [] },
      agc: { groups: [{ upsert: { config: { group_name: '控制组1', members: [] } } }] },
      avc: { groups: [] },
      calc: { groups: [] },
      data_bus: { connections: [], conn_tags: [], routes: { replace: true, items: [] } },
    },
    agc_control_profiles: [],
    metadata: { scope: 'full', included_sections: ['modbus_rtu', 'agc'] },
  };

  const seeded = snapshotToWorkspace(workspace, snapshot, { nowIso: NOW });

  assert.equal(findConnectionId(seeded.conn_ids, 'ModbusRTU', '1-1#'), 1);
  assert.equal(findConnectionId(seeded.conn_ids, 'AGC', '控制组1'), 2);
});
