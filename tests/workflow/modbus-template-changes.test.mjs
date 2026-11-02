import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as bindings from '../../src/features/modbus-templates/bindings.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/modbus-templates/aiswei-inverter-v2-1-5.json', import.meta.url), 'utf8'));
const source = { ...fixture, points: fixture.points.slice(0, 5).map((point, index) => ({ ...point, id: `p${index}`, tag: `点${index}`, address: 100 + index * 10, default_selected: true, condition: '' })) };
const makeApp = (ids = ['p0', 'p1', 'p2']) => bindings.createApplication({ platformId: 'one', templateId: 'db-1', revision: '1', template: source, addressBase: 1, prefix: '设备_', selectedIds: ids, existingPoints: [], applicationId: 'app-1' });
const latest = () => ({ ...source, points: source.points.filter(p => p.id !== 'p2').map(p => p.id === 'p0' ? { ...p, tag: '平台改名' } : p) });

// 验证统一列表同时显示更新、已添加、删除和首次排除点，全部默认不选。
test('统一列表展示全部点与差异且所有点手动选择', () => {
  const { application, points } = makeApp();
  const rows = bindings.planApplicationChanges(application, points, latest(), '2', 1);
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.id, row.kind])), { p0: 'modified', p1: 'applied', p3: 'added', p4: 'added', p2: 'deleted' });
  assert.ok(rows.every(row => !row.selected));
  assert.equal(rows.find(row => row.id === 'p0').next.tag, '设备_平台改名');
});

// 验证同一事务混合补加、更新、删除，沿用应用身份并保持输入不变。
test('混合接受新增更新删除并保留原应用', () => {
  const { application, points } = makeApp();
  const before = structuredClone({ application, points });
  const result = bindings.applyApplicationChanges(application, points, latest(), '2', ['p0', 'p2', 'p3'], 1);
  assert.deepEqual(result.points.map(p => p.tag).sort(), ['设备_平台改名', '设备_点1', '设备_点3'].sort());
  assert.equal(result.application.application_id, 'app-1');
  assert.equal(result.application.revision, '2');
  assert.equal(result.application.mappings.find(m => m.source_point_id === 'p3').source_revision, '2');
  assert.ok(!result.application.excluded_source_ids.includes('p3'));
  assert.ok(result.application.excluded_source_ids.includes('p4'));
  assert.deepEqual({ application, points }, before);
  assert.doesNotThrow(() => bindings.parseTemplateBindings(JSON.stringify({ schema_version: 1, applications: [result.application] })));
});

// 验证不勾选现场冲突和平台删除时不推进这些点的基线。
test('仅补加保留未接受的冲突删除与整表版本', () => {
  const { application, points } = makeApp();
  const dirty = points.map(p => p.tag === '设备_点0' ? { ...p, address: 700 } : p);
  const result = bindings.applyApplicationChanges(application, dirty, latest(), '2', ['p3'], 1);
  assert.equal(result.application.revision, '1');
  assert.deepEqual(result.points.slice(0, 3), dirty);
  assert.deepEqual(result.application.mappings[0], application.mappings[0]);
  const rows = bindings.planApplicationChanges(result.application, result.points, latest(), '2', 1);
  assert.equal(rows.find(r => r.id === 'p0').kind, 'conflict');
  assert.equal(rows.find(r => r.id === 'p2').kind, 'deleted');
});

// 验证明确选择冲突时使用平台值，冲突删除只移除所选映射点。
test('明确选择现场冲突和删除冲突可以同次处理', () => {
  const { application, points } = makeApp();
  const dirty = points.map(p => ({ ...p, address: p.address + 1000 }));
  const rows = bindings.planApplicationChanges(application, dirty, latest(), '2', 1);
  assert.equal(rows.find(r => r.id === 'p0').kind, 'conflict');
  assert.equal(rows.find(r => r.id === 'p2').kind, 'conflict');
  assert.equal(rows.find(r => r.id === 'p2').next, undefined);
  const result = bindings.applyApplicationChanges(application, dirty, latest(), '2', ['p0', 'p2'], 1);
  assert.equal(result.points.find(p => p.tag === '设备_平台改名').address, 100);
  assert.ok(!result.points.some(p => p.tag === '设备_点2'));
  assert.deepEqual(result.points.find(p => p.tag === '设备_点1'), dirty[1]);
});

// 验证现场独立修改不被当作平台更新，现场已删除点允许手动补回。
test('现场独立修改仍为已添加，缺失点显示重新添加', () => {
  const { application, points } = makeApp();
  const dirty = points.filter(p => p.tag !== '设备_点1').map(p => p.tag === '设备_点0' ? { ...p, address: 700 } : p);
  const rows = bindings.planApplicationChanges(application, dirty, source, '1', 1);
  assert.equal(rows.find(r => r.id === 'p0').kind, 'applied');
  assert.equal(rows.find(r => r.id === 'p0').next.address, 700);
  assert.equal(rows.find(r => r.id === 'p1').kind, 'readded');
  const result = bindings.applyApplicationChanges(application, dirty, source, '1', ['p1'], 1);
  assert.equal(result.points.length, 3);
  assert.equal(result.points.find(p => p.tag === '设备_点0').address, 700);
});

// 验证非法、重复、已添加和空选择不能意外写入点表。
test('拒绝非法重复已添加和空差异选择', () => {
  const { application, points } = makeApp();
  for (const selected of [['missing'], ['p3', 'p3'], ['p1'], []]) {
    assert.throws(() => bindings.applyApplicationChanges(application, points, latest(), '2', selected, 1), /选择|已添加|不存在/);
  }
});

// 验证同批新增互斥点在预览及应用时均被阻断。
test('统一预览及保存阻止同批寄存器重叠', () => {
  const { application, points } = makeApp();
  const overlap = { ...source, points: source.points.map(p => p.id === 'p4' ? { ...p, address: 130 } : p) };
  const rows = bindings.planApplicationChanges(application, points, overlap, '2', 1, false, ['p3', 'p4']);
  assert.ok(rows.find(r => r.id === 'p3').blocked);
  assert.ok(rows.find(r => r.id === 'p4').blocked);
  assert.throws(() => bindings.applyApplicationChanges(application, points, overlap, '2', ['p3', 'p4'], 1), /冲突/);
});

// 验证同一事务先释放选择更新或删除的旧地址，再校验新点组合。
test('混合更新与补加可以使用同次释放的地址', () => {
  const { application, points } = makeApp();
  const moved = { ...source, points: source.points.map(p => p.id === 'p0' ? { ...p, address: 500 } : p.id === 'p3' ? { ...p, address: 100 } : p) };
  const rows = bindings.planApplicationChanges(application, points, moved, '2', 1, false, ['p0', 'p3']);
  assert.ok(!rows.find(r => r.id === 'p3').blocked);
  const result = bindings.applyApplicationChanges(application, points, moved, '2', ['p0', 'p3'], 1);
  assert.equal(result.points.find(p => p.tag === '设备_点3').address, 100);
  assert.equal(result.points.find(p => p.tag === '设备_点0').address, 500);
});

// 验证无点位变化时可以显式确认版本，初次排除的未添加点不会强迫添加。
test('纯版本信息确认不自动添加初次排除点', () => {
  const { application, points } = makeApp();
  const result = bindings.applyApplicationChanges(application, points, source, '2', [], 1);
  assert.equal(result.application.revision, '2');
  assert.deepEqual(result.points, points);
  assert.deepEqual(result.application.mappings, application.mappings);
});

// 验证重新添加新来源时迁移现场已不存在的同标签旧映射。
test('统一补加迁移同应用内已删除的旧标签来源', () => {
  const { application } = makeApp(['p0']);
  const replacement = { ...source, points: [{ ...source.points[0], id: 'replacement' }, ...source.points.slice(1)] };
  const result = bindings.applyApplicationChanges(application, [], replacement, '2', ['replacement'], 1);
  assert.deepEqual(result.application.mappings.map(m => m.source_point_id), ['replacement']);
  assert.ok(result.application.excluded_source_ids.includes('p0'));
  assert.doesNotThrow(() => bindings.parseTemplateBindings(JSON.stringify({ schema_version: 1, applications: [result.application] })));
});

// 验证地址基准和版本倒退保护，历史版本仅在明确许可时可读取。
test('统一操作保留版本及地址基准保护', () => {
  const { application, points } = makeApp();
  assert.throws(() => bindings.planApplicationChanges(application, points, source, '0', 1), /版本无效/);
  assert.throws(() => bindings.planApplicationChanges(application, points, source, '1', 2), /基准/);
  application.revision = '2';
  assert.throws(() => bindings.planApplicationChanges(application, points, source, '1', 1), /旧于/);
  assert.doesNotThrow(() => bindings.planApplicationChanges(application, points, source, '1', 1, true));
});
