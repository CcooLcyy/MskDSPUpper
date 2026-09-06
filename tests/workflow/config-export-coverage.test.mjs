import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const exportSource = fs.readFileSync(path.join(repoRoot, 'src/utils/config-export.ts'), 'utf8');
const typesSource = fs.readFileSync(path.join(repoRoot, 'src/adapters/types.ts'), 'utf8');
const protoSource = fs.readFileSync(path.join(repoRoot, 'proto/ExportConfig.proto'), 'utf8');

test('配置导出覆盖 Calc、AGC 固定参数和 DataCenter 注册表', () => {
  assert.match(exportSource, /key: 'calc'/);
  assert.match(exportSource, /api\.calcListGroups\(\)/);
  assert.match(exportSource, /api\.agcGetControlProfile\(/);
  assert.match(exportSource, /api\.dcGetOrCreateConnection\(/);
  assert.match(exportSource, /api\.dcGetConnTags\(/);
  assert.match(typesSource, /ConfigExportSectionId\s*=([\s\S]*?)'calc'/);
  assert.match(typesSource, /agc_control_profiles/);
  assert.match(typesSource, /connections: StableDataBusConnection\[\]/);
  assert.match(typesSource, /conn_tags: StableDataBusConnTags\[\]/);
  assert.match(protoSource, /repeated DataBusConnection connections = 2/);
  assert.match(protoSource, /repeated DataBusConnTags conn_tags = 3/);
  assert.match(protoSource, /repeated AGCProto\.GroupControlProfile agc_control_profiles = 8/);
});

test('导出前会拒绝未启动的所选模块，避免静默导出空配置', () => {
  assert.match(exportSource, /导出.*模块未启动/);
  assert.match(exportSource, /assertExportModulesRunning/);
});

test('导入摘要包含 Calc 分组数量，旧快照字段按空集合兼容', () => {
  assert.match(exportSource, /calcGroups/);
  assert.match(exportSource, /snapshot\.config\.calc\.groups/);
  assert.match(exportSource, /\?\? \[\]/);
});
