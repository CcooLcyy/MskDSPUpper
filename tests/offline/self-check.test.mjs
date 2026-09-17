import assert from 'node:assert/strict';
import test from 'node:test';

import { selfCheckSnapshot } from '../../src/offline/workspace/self-check.ts';

const NOW = '2026-05-20T10:00:00.000Z';

function iec104Link(connName, points, timeSyncTag) {
  return {
    link: { config: { conn_name: connName, ...(timeSyncTag ? { time_sync_tag: timeSyncTag } : {}) } },
    point_table: { conn_name: connName, points, replace: true },
  };
}

function makeSnapshot({
  iec104Links = [],
  modbusRtuLinks = [],
  mqtt = null,
  connections = [],
  connTags = [],
  routes = [],
  agcGroups = [],
} = {}) {
  return {
    schema_version: 1,
    exported_at: NOW,
    source: { manager_addr: '' },
    module_startup: { source: 'get_running_module_info', modules: [] },
    config: {
      iec104: { links: iec104Links },
      modbus_rtu: { mqtt, links: modbusRtuLinks },
      modbus_tcp: { links: [] },
      dlt645: { mqtt: null, links: [] },
      agc: { groups: agcGroups },
      avc: { groups: [] },
      calc: { groups: [] },
      data_bus: { connections, conn_tags: connTags, routes: { replace: true, items: routes } },
    },
    agc_control_profiles: [],
    metadata: { scope: 'partial', included_sections: ['iec104', 'data_bus'] },
  };
}

const MAIN_CONNECTION = { module_name: 'IEC104', conn_name: 'main' };

// 正例：标签完整、路由自洽的快照不得产生任何自检问题。
test('a consistent snapshot produces no issues', () => {
  const snapshot = makeSnapshot({
    iec104Links: [iec104Link('main', [{ tag: 'A', ioa: 1 }])],
    connections: [MAIN_CONNECTION],
    connTags: [{ module_name: 'IEC104', conn_name: 'main', tags: ['A', '__time_sync__'] }],
    routes: [{
      src: { module_name: 'IEC104', conn_name: 'main', tag: 'A' },
      dst: { module_name: 'IEC104', conn_name: 'main', tag: '__time_sync__' },
    }],
  });

  assert.deepEqual(selfCheckSnapshot(snapshot), []);
});

// IEC104 连接缺少对时标签时必须报错：现场导入会覆盖注册表并影响主站对时。
test('missing time sync tag is reported as an error', () => {
  const snapshot = makeSnapshot({
    iec104Links: [iec104Link('main', [{ tag: 'A', ioa: 1 }])],
    connections: [MAIN_CONNECTION],
    connTags: [{ module_name: 'IEC104', conn_name: 'main', tags: ['A'] }],
  });

  const issues = selfCheckSnapshot(snapshot);

  assert.ok(issues.some((issue) => issue.level === 'error' && issue.code === 'tags-missing'));
});

// 配置覆盖了对时标签名时，必须按配置的标签名校验。
test('configured time sync tag name is honoured', () => {
  const snapshot = makeSnapshot({
    iec104Links: [iec104Link('main', [{ tag: 'A', ioa: 1 }], 'sync/pulse')],
    connections: [MAIN_CONNECTION],
    connTags: [{ module_name: 'IEC104', conn_name: 'main', tags: ['A'] }],
  });

  const issues = selfCheckSnapshot(snapshot);

  assert.ok(issues.some((issue) => issue.code === 'tags-missing' && issue.message.includes('sync/pulse')));
});

// 同一连接内重复标签必须报错。
test('duplicate declared tags are reported as an error', () => {
  const snapshot = makeSnapshot({
    connections: [MAIN_CONNECTION],
    connTags: [{ module_name: 'IEC104', conn_name: 'main', tags: ['A', 'A'] }],
  });

  const issues = selfCheckSnapshot(snapshot);

  assert.ok(issues.some((issue) => issue.level === 'error' && issue.code === 'duplicate-conn-tag'));
});

// 同一连接内 IOA 重复必须报错。
test('duplicate point addresses are reported as an error', () => {
  const snapshot = makeSnapshot({
    iec104Links: [iec104Link('main', [{ tag: 'A', ioa: 5 }, { tag: 'B', ioa: 5 }])],
    connections: [MAIN_CONNECTION],
    connTags: [{ module_name: 'IEC104', conn_name: 'main', tags: ['A', 'B', '__time_sync__'] }],
  });

  const issues = selfCheckSnapshot(snapshot);

  assert.ok(issues.some((issue) => issue.level === 'error' && issue.code === 'duplicate-point-address'));
});

// 路由端点连接未在连接注册表中声明时必须报错。
test('route endpoints referencing unknown connections are errors', () => {
  const snapshot = makeSnapshot({
    routes: [{
      src: { module_name: 'ModbusRTU', conn_name: '1-1#', tag: 'A' },
      dst: { module_name: 'IEC104', conn_name: 'main', tag: 'A' },
    }],
  });

  const issues = selfCheckSnapshot(snapshot);

  assert.ok(issues.some((issue) => issue.level === 'error' && issue.code === 'route-connection-missing'));
});

// 路由端点标签未在 ConnTags 中声明时必须报错。
test('route endpoints referencing unknown tags are errors', () => {
  const snapshot = makeSnapshot({
    connections: [MAIN_CONNECTION],
    connTags: [{ module_name: 'IEC104', conn_name: 'main', tags: ['A'] }],
    routes: [{
      src: { module_name: 'IEC104', conn_name: 'main', tag: 'ghost' },
      dst: { module_name: 'IEC104', conn_name: 'main', tag: 'A' },
    }],
  });

  const issues = selfCheckSnapshot(snapshot);

  assert.ok(issues.some((issue) => issue.level === 'error' && issue.code === 'route-tag-missing'));
});

// 没有声明 ConnTags 的连接可以配路由（下位机校验放行），但必须提示风险。
test('connections without declared tags produce a warning', () => {
  const snapshot = makeSnapshot({ connections: [MAIN_CONNECTION] });

  const issues = selfCheckSnapshot(snapshot);

  assert.ok(issues.some((issue) => issue.level === 'warning' && issue.code === 'connection-without-tags'));
});

// 无点表的连接必须提示，避免导出后现场发现采集点为空。
test('links without points produce a warning', () => {
  const snapshot = makeSnapshot({
    iec104Links: [iec104Link('main', [])],
    connections: [MAIN_CONNECTION],
    connTags: [{ module_name: 'IEC104', conn_name: 'main', tags: ['__time_sync__'] }],
  });

  const issues = selfCheckSnapshot(snapshot);

  assert.ok(issues.some((issue) => issue.level === 'warning' && issue.code === 'link-without-points'));
});

// 自环路由下位机允许，但离线导出必须提示。
test('self loop routes produce a warning', () => {
  const snapshot = makeSnapshot({
    connections: [MAIN_CONNECTION],
    connTags: [{ module_name: 'IEC104', conn_name: 'main', tags: ['A'] }],
    routes: [{
      src: { module_name: 'IEC104', conn_name: 'main', tag: 'A' },
      dst: { module_name: 'IEC104', conn_name: 'main', tag: 'A' },
    }],
  });

  const issues = selfCheckSnapshot(snapshot);

  assert.ok(issues.some((issue) => issue.level === 'warning' && issue.code === 'route-self-loop'));
});

// 标签数量比打底快照减少时必须提示：现场覆盖后会静默剪除相关路由。
test('shrunk tag sets are reported against the baseline', () => {
  const snapshot = makeSnapshot({
    connections: [MAIN_CONNECTION],
    connTags: [{ module_name: 'IEC104', conn_name: 'main', tags: ['A'] }],
  });

  const issues = selfCheckSnapshot(snapshot, {
    baselineConnTags: [{ module_name: 'IEC104', conn_name: 'main', tags: ['A', 'B'] }],
  });

  assert.ok(issues.some((issue) => issue.level === 'warning' && issue.code === 'tags-shrunk'));
});

// 导出文件带明文 MQTT 密码时必须提示。
test('mqtt password in the export produces a warning', () => {
  const snapshot = makeSnapshot({
    mqtt: { host: '127.0.0.1', port: 1883, client_id: 'c', username: 'u', password: 'secret', keepalive_sec: 60, clean_session: true, connect_timeout_ms: 5000 },
  });

  const issues = selfCheckSnapshot(snapshot);

  assert.ok(issues.some((issue) => issue.level === 'warning' && issue.code === 'mqtt-password-in-export'));
});

// AGC 控制组标签缺少固定默认点时必须报错。
test('agc connections missing default points are errors', () => {
  const snapshot = makeSnapshot({
    connections: [{ module_name: 'AGC', conn_name: '控制组1' }],
    connTags: [{ module_name: 'AGC', conn_name: '控制组1', tags: ['某点'] }],
    agcGroups: [{ upsert: { config: { group_name: '控制组1', members: [] } } }],
  });

  const issues = selfCheckSnapshot(snapshot);

  assert.ok(issues.some((issue) => issue.level === 'error' && issue.code === 'tags-missing'));
});
