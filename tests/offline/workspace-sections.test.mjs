import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALL_CONFIG_SECTION_IDS,
  buildConfigExportMetadata,
  buildWorkspaceExportFileName,
  dedupeConfigSections,
  ensureMskcfgExtension,
  isFullSectionSelection,
  scopeWorkspaceConfig,
} from '../../src/offline/workspace/sections.ts';
import { createEmptyWorkspaceConfig } from '../../src/offline/workspace/types.ts';

// 分区去重必须按固定顺序输出，保证 included_sections 与文件名稳定。
test('dedupeConfigSections returns the canonical order', () => {
  assert.deepEqual(dedupeConfigSections(['data_bus', 'iec104', 'iec104']), ['iec104', 'data_bus']);
  assert.deepEqual(dedupeConfigSections([...ALL_CONFIG_SECTION_IDS].reverse()), [...ALL_CONFIG_SECTION_IDS]);
  assert.deepEqual(dedupeConfigSections([]), []);
});

// 只有选中全部分区时才标记为 full，否则为 partial。
test('metadata scope reflects the selected sections', () => {
  assert.equal(isFullSectionSelection(ALL_CONFIG_SECTION_IDS), true);
  assert.equal(isFullSectionSelection(['iec104']), false);
  assert.deepEqual(buildConfigExportMetadata(['iec104']), { scope: 'partial', included_sections: ['iec104'] });
  assert.deepEqual(buildConfigExportMetadata([...ALL_CONFIG_SECTION_IDS]), {
    scope: 'full',
    included_sections: [...ALL_CONFIG_SECTION_IDS],
  });
});

// 未选中的分区必须清空，选中的分区必须保留。
test('scopeWorkspaceConfig empties unselected sections', () => {
  const config = createEmptyWorkspaceConfig();
  config.iec104.links.push({
    link: { config: { conn_name: 'main' } },
    point_table: { conn_name: 'main', points: [{ tag: 'A' }], replace: true },
  });
  config.data_bus.connections.push({ module_name: 'IEC104', conn_name: 'main' });

  const scoped = scopeWorkspaceConfig(config, ['iec104']);

  assert.equal(scoped.iec104.links.length, 1);
  assert.deepEqual(scoped.data_bus.connections, []);
  assert.deepEqual(scoped.agc.groups, []);
  assert.deepEqual(scoped.modbus_rtu, { mqtt: null, links: [] });
  assert.equal(config.data_bus.connections.length, 1);
});

// 裁剪结果必须是独立副本，避免后续编辑污染工作区原始配置。
test('scopeWorkspaceConfig returns an independent copy', () => {
  const config = createEmptyWorkspaceConfig();
  config.iec104.links.push({
    link: { config: { conn_name: 'main' } },
    point_table: { conn_name: 'main', points: [], replace: true },
  });

  const scoped = scopeWorkspaceConfig(config, ['iec104']);
  scoped.iec104.links.push({
    link: { config: { conn_name: 'other' } },
    point_table: { conn_name: 'other', points: [], replace: true },
  });

  assert.equal(config.iec104.links.length, 1);
});

// 导出文件名必须带工作区名与时间戳；部分分区时附加分区标识。
test('export file name carries the workspace name and timestamp', () => {
  const exportedAt = new Date(2026, 4, 20, 10, 15, 30).toISOString();

  assert.equal(
    buildWorkspaceExportFileName('经开区二期', exportedAt, [...ALL_CONFIG_SECTION_IDS]),
    '经开区二期-20260520-101530.mskcfg',
  );
  assert.equal(
    buildWorkspaceExportFileName('经开区二期', exportedAt, ['iec104', 'data_bus']),
    '经开区二期-iec104-data-bus-20260520-101530.mskcfg',
  );
});

// 文件名不得包含路径分隔符或 Windows 非法字符。
test('export file name sanitizes illegal characters', () => {
  const exportedAt = new Date(2026, 4, 20, 10, 15, 30).toISOString();
  const name = buildWorkspaceExportFileName('现场A/B:C*?', exportedAt, ['iec104']);

  assert.ok(!/[\\/:*?"<>|]/.test(name), name);
  assert.ok(name.endsWith('.mskcfg'), name);
});

// 扩展名补齐必须幂等且大小写不敏感。
test('ensureMskcfgExtension appends the extension once', () => {
  assert.equal(ensureMskcfgExtension('a'), 'a.mskcfg');
  assert.equal(ensureMskcfgExtension('a.mskcfg'), 'a.mskcfg');
  assert.equal(ensureMskcfgExtension('a.MSKCFG'), 'a.MSKCFG');
});
