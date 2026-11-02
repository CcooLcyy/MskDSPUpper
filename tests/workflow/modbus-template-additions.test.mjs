import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as bindings from '../../src/features/modbus-templates/bindings.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/modbus-templates/aiswei-inverter-v2-1-5.json', import.meta.url), 'utf8'));
const source = { ...fixture, points: fixture.points.slice(0, 3).map((point, index) => ({ ...point, id: `p${index}`, tag: `点${index}`, address: 100 + index * 10, default_selected: true, condition: '' })) };
const makeApp = () => bindings.createApplication({ platformId: 'one', templateId: 'db-1', revision: '1', template: source, addressBase: 1, prefix: '设备_', selectedIds: ['p0'], existingPoints: [], applicationId: 'app-1' });

test('再次打开列出全部点位，已添加不可重复，首次排除点可补加', () => {
  const { application, points } = makeApp();
  const latest = { ...source, points: source.points.map(p => p.id === 'p0' ? { ...p, tag: '平台改名', address: 500 } : p) };
  const rows = bindings.planApplicationAdditions(application, points, latest, '2', 1);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].applied, true);
  assert.equal(rows[0].selected, false);
  assert.equal(rows[0].finalTag, points[0].tag);
  assert.deepEqual(rows[0].point, points[0]);
  assert.equal(rows[0].conflict, null);
  assert.equal(rows[1].applied, false);
  assert.equal(rows[1].selected, true);
  assert.equal(rows[1].conflict, null);
});

test('补加沿用应用和前缀，保留现场值及未接受的平台更新基线', () => {
  const { application, points } = makeApp();
  const dirty = [{ ...points[0], scale: 99, scale_decimal: '99' }];
  const latest = { ...source, points: source.points.map(p => p.id === 'p0' ? { ...p, scale: '2' } : p) };
  const before = structuredClone({ application, dirty });
  const result = bindings.applyApplicationAdditions(application, dirty, latest, '2', ['p1'], 1);
  assert.equal(result.points.length, 2);
  assert.deepEqual(result.points[0], dirty[0]);
  assert.equal(result.points[1].tag, '设备_点1');
  assert.equal(result.application.application_id, application.application_id);
  assert.equal(result.application.revision, '1');
  assert.deepEqual(result.application.template_snapshot, application.template_snapshot);
  assert.deepEqual(result.application.mappings[0], application.mappings[0]);
  assert.equal(result.application.mappings[1].source_revision, '2');
  assert.deepEqual(result.application.excluded_source_ids, ['p2']);
  assert.equal(bindings.planApplicationUpdate(result.application, result.points, latest, '2', 1)[0].kind, 'conflict');
  assert.deepEqual({ application, dirty }, before);
  assert.doesNotThrow(() => bindings.parseTemplateBindings(JSON.stringify({ schema_version: 1, applications: [result.application] })));
});

test('旧记录无排除列表时保留未补加排除项；删除后可重新添加同一个来源', () => {
  const { application, points } = makeApp();
  delete application.excluded_source_ids;
  const restored = bindings.applyApplicationAdditions(application, [], source, '1', ['p0', 'p1'], 1);
  assert.equal(restored.application.mappings.length, 2);
  assert.deepEqual(restored.application.excluded_source_ids, ['p2']);
  assert.equal(restored.application.mappings[0].target_tag, points[0].tag);
  assert.equal(restored.points.length, 2);
});

test('补加拒绝已添加、无效选择、已有点冲突及同批互斥点，不修改输入', () => {
  const { application, points } = makeApp();
  assert.throws(() => bindings.applyApplicationAdditions(application, points, source, '1', ['p0'], 1), /已添加/);
  assert.throws(() => bindings.applyApplicationAdditions(application, points, source, '1', ['missing'], 1), /无效|不存在/);
  assert.throws(() => bindings.applyApplicationAdditions(application, points, source, '1', [], 1), /请选择/);
  const overlapping = { ...source, points: source.points.map(p => p.id === 'p2' ? { ...p, address: source.points[1].address } : p) };
  const rows = bindings.planApplicationAdditions(application, points, overlapping, '1', 1, false, ['p1', 'p2']);
  assert.ok(rows.find(row => row.id === 'p1').conflict);
  assert.ok(rows.find(row => row.id === 'p2').conflict);
  assert.throws(() => bindings.applyApplicationAdditions(application, points, overlapping, '1', ['p1', 'p2'], 1), /冲突/);
  assert.throws(() => bindings.applyApplicationAdditions(application, [...points, { ...points[0], tag: '设备_点1', address: 400 }], source, '1', ['p1'], 1), /冲突/);
  assert.equal(points.length, 1);
  assert.equal(application.mappings.length, 1);
});

test('补加保护地址基准及旧缓存，历史版本必须明确选择', () => {
  const { application, points } = makeApp();
  application.revision = '2';
  assert.throws(() => bindings.planApplicationAdditions(application, points, source, '1', 1), /旧于/);
  assert.throws(() => bindings.planApplicationAdditions(application, points, source, '2', 2), /基准/);
  assert.throws(() => bindings.planApplicationAdditions(application, points, source, '0', 1), /版本无效/);
  assert.doesNotThrow(() => bindings.planApplicationAdditions(application, points, source, '1', 1, true));
});

test('同一应用内旧来源标签现场已删除时，新来源补加迁移旧映射', () => {
  const { application } = makeApp();
  const latest = { ...source, points: [{ ...source.points[0], id: 'replacement' }, ...source.points.slice(1)] };
  const result = bindings.applyApplicationAdditions(application, [], latest, '2', ['replacement'], 1);
  assert.equal(result.application.mappings.length, 1);
  assert.equal(result.application.mappings[0].source_point_id, 'replacement');
  assert.ok(result.application.excluded_source_ids.includes('p0'));
  assert.doesNotThrow(() => bindings.parseTemplateBindings(JSON.stringify({ schema_version: 1, applications: [result.application] })));
  assert.equal(application.mappings[0].source_point_id, 'p0');
});

test('条件及写控制点补加默认不选，但允许明确选择不冲突点', () => {
  const { application, points } = makeApp();
  const latest = { ...source, points: [source.points[0], { ...source.points[1], condition: '仅指定型号' }, { ...source.points[2], function_code: 6 }] };
  const rows = bindings.planApplicationAdditions(application, points, latest, '2', 1);
  assert.equal(rows.find(row => row.id === 'p1').selected, false);
  assert.equal(rows.find(row => row.id === 'p2').selected, false);
  const result = bindings.applyApplicationAdditions(application, points, latest, '2', ['p1', 'p2'], 1);
  assert.equal(result.points.length, 3);
});
