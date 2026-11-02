import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as api from '../../src/features/modbus-templates/bindings.ts';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/modbus-templates/aiswei-inverter-v2-1-5.json', import.meta.url), 'utf8'));
const template = { ...fixture, points: fixture.points.slice(0, 4).map((p, i) => ({ ...p, id: `p${i}`, tag: `点${i}`, address: 100 + i * 10, condition: '' })) };
const make = (id, ids, prefix = '', revision = '1') => api.createApplication({ platformId: 'one', templateId: 'db', revision, template, addressBase: 1, prefix, selectedIds: ids, existingPoints: [], applicationId: id });
const options = (apps, current, latest = template, revision = '2') => ({ bindings: { schema_version: 1, applications: apps }, current, latest, revision, platformId: 'one', templateId: 'db', addressBase: 1 });
const choose = (o, predicate) => api.planConnectionTemplateChanges(o).rows.filter(predicate).map(r => r.id);

// 验证首次应用不加前缀且全部等待用户手选。
test('连接首次应用与补加共用无前缀入口', () => {
  const o = options([], []);
  const rows = api.planConnectionTemplateChanges(o).rows;
  assert.ok(rows.every(r => r.kind === 'added' && !r.selected));
  const result = api.applyConnectionTemplateChanges({ ...o, selectedIds: [rows[0].id] });
  assert.equal(result.points[0].tag, '点0');
  assert.equal(result.bindings.applications[0].prefix, '');
});

// 验证分散于历史记录的点均被识别，局部接受只更新对应来源。
test('多条版本记录统一比较并保留跳过的逐点基线', () => {
  const a = make('a', ['p0']);
  const b = make('b', ['p1'], '', '2');
  const latest = { ...template, points: template.points.map(p => ({ ...p, scale: '2' })) };
  const o = options([a.application, b.application], [...a.points, ...b.points], latest, '3');
  const rows = api.planConnectionTemplateChanges(o).rows;
  assert.equal(rows.filter(r => r.kind === 'modified').length, 2);
  const result = api.applyConnectionTemplateChanges({ ...o, selectedIds: [rows.find(r => r.current?.tag === '点1').id] });
  assert.deepEqual(result.bindings.applications[0], a.application);
  assert.equal(result.bindings.applications[1].mappings[0].source_revision, '3');
  assert.doesNotThrow(() => api.parseTemplateBindings(JSON.stringify(result.bindings)));
});

// 验证历史重复源点具有独立行身份，不会静默丢弃任何映射。
test('同源点分属不同旧记录仍独立维护且新点不继承前缀', () => {
  const a = make('a', ['p0'], 'A_');
  const b = make('b', ['p0'], 'B_');
  const o = options([a.application, b.application], [...a.points, ...b.points]);
  const rows = api.planConnectionTemplateChanges(o).rows;
  assert.equal(rows.filter(r => r.kind === 'applied').length, 2);
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
  const result = api.applyConnectionTemplateChanges({ ...o, selectedIds: choose(o, r => r.next?.tag === '点1') });
  assert.ok(result.points.some(p => p.tag === 'A_点0'));
  assert.ok(result.points.some(p => p.tag === 'B_点0'));
  assert.ok(result.points.some(p => p.tag === '点1'));
  assert.equal(result.bindings.applications.length, 3);
});

// 验证现场重命名映射保留，而平台明确改名呈现待接受差异。
test('旧前缀和现场重命名不被自动改名，平台改名有预览', () => {
  const a = make('a', ['p0'], 'A_');
  a.application.mappings[0].target_tag = '现场标签';
  const current = a.points.map(p => ({ ...p, tag: '现场标签' }));
  const o = options([a.application], current);
  assert.equal(api.planConnectionTemplateChanges(o).rows.find(r => r.current).kind, 'applied');
  const changed = { ...template, points: template.points.map(p => p.id === 'p0' ? { ...p, tag: '平台新标签' } : p) };
  const row = api.planConnectionTemplateChanges({ ...o, latest: changed }).rows.find(r => r.current);
  assert.equal(row.kind, 'conflict');
  assert.equal(row.next.tag, '平台新标签');
});

// 验证旧版本和不同地址基准仍阻断，不能通过记录聚合绕过保护。
test('所有历史记录都执行版本与地址基准保护', () => {
  const a = make('a', ['p0']);
  const b = make('b', ['p1'], '', '4');
  assert.throws(() => api.planConnectionTemplateChanges(options([a.application, b.application], [...a.points, ...b.points])), /旧于/);
  assert.throws(() => api.planConnectionTemplateChanges({ ...options([a.application], a.points), addressBase: 2 }), /地址基准/);
});

// 验证增改删组合检查先释放被替换点，不受应用记录顺序影响。
test('跨旧记录混合更新删除和补点保留未选配置', () => {
  const a = make('a', ['p0']);
  const b = make('b', ['p1']);
  const latest = { ...template, points: template.points.filter(p => p.id !== 'p1').map(p => p.id === 'p0' ? { ...p, scale: '2' } : p) };
  const o = options([a.application, b.application], [...a.points, ...b.points], latest);
  const selectedIds = choose(o, r => r.kind !== 'applied' && r.next?.tag !== '点3');
  const result = api.applyConnectionTemplateChanges({ ...o, selectedIds });
  assert.deepEqual(result.points.map(p => p.tag).sort(), ['点0', '点2']);
  assert.ok(result.bindings.applications.some(app => app.mappings.some(m => m.source_point_id === 'p2')));
  assert.doesNotThrow(() => api.parseTemplateBindings(JSON.stringify(result.bindings)));
});

// 验证现场已有同源点时不重复显示补回旧副本，且保留历史来源不丢失。
test('同源残留旧映射与现存映射只产生一个现场候选', () => {
  const a = make('a', ['p0'], '旧_');
  const b = make('b', ['p0']);
  const o = options([a.application, b.application], b.points);
  const rows = api.planConnectionTemplateChanges(o).rows;
  assert.equal(rows.filter(r => r.source_point_id === 'p0').length, 1);
  assert.equal(rows.find(r => r.source_point_id === 'p0').kind, 'applied');
  const result = api.applyConnectionTemplateChanges({ ...o, selectedIds: choose(o, r => r.next?.tag === '点1') });
  assert.deepEqual(result.bindings.applications[0], a.application);
});

// 验证跨模板残留映射先显示重新添加，再原子迁移本次选中的来源。
test('跨模板来源迁移有重新添加预览且只迁移所选点', () => {
  const a = make('a', ['p0', 'p1']);
  a.application.template_id = 'other';
  const o = options([a.application], []);
  const row = api.planConnectionTemplateChanges(o).rows.find(r => r.source_point_id === 'p0');
  assert.equal(row.kind, 'readded');
  const result = api.applyConnectionTemplateChanges({ ...o, selectedIds: [row.id] });
  assert.equal(result.transfers.length, 1);
  assert.equal(result.transfers[0].source_point_id, 'p0');
  assert.deepEqual(result.bindings.applications[0].mappings.map(m => m.source_point_id), ['p1']);
  assert.ok(result.bindings.applications[0].excluded_source_ids.includes('p0'));
});

// 验证一次接受跨记录地址交换时先释放旧点，避免按顺序校验误报冲突。
test('跨应用地址交换可在同一次选择中通过', () => {
  const a = make('a', ['p0']);
  const b = make('b', ['p1']);
  const latest = { ...template, points: template.points.map(p => p.id === 'p0' ? { ...p, address: 110 } : p.id === 'p1' ? { ...p, address: 100 } : p) };
  const o = options([a.application, b.application], [...a.points, ...b.points], latest);
  const selectedIds = choose(o, r => r.kind === 'modified');
  const preview = api.planConnectionTemplateChanges({ ...o, selectedIds });
  assert.ok(preview.rows.filter(r => selectedIds.includes(r.id)).every(r => !r.blocked));
  const result = api.applyConnectionTemplateChanges({ ...o, selectedIds });
  assert.equal(result.points.find(p => p.tag === '点0').address, 110);
  assert.equal(result.points.find(p => p.tag === '点1').address, 100);
});

// 验证初次排除点不阻止仅版本修订确认，真正后续新增点仍阻止完整版本推进。
test('初次排除点允许确认版本且无关记录形状保持不变', () => {
  const a = make('a', ['p0']);
  const unrelated = make('other', ['p1']);
  unrelated.application.platform_id = 'another';
  delete unrelated.application.excluded_source_ids;
  const o = options([a.application, unrelated.application], [...a.points, ...unrelated.points]);
  assert.equal(api.planConnectionTemplateChanges(o).acknowledgeOnly, true);
  const result = api.applyConnectionTemplateChanges(o);
  assert.equal(result.bindings.applications[0].revision, '2');
  assert.deepEqual(result.bindings.applications[1], unrelated.application);
  assert.deepEqual(result.points, o.current);
  const newer = { ...template, points: [...template.points, { ...template.points[0], id: 'new', tag: '新点', address: 800 }] };
  const withNew = { ...o, latest: newer };
  assert.equal(api.planConnectionTemplateChanges(withNew).acknowledgeOnly, false);
  assert.throws(() => api.applyConnectionTemplateChanges(withNew), /选择/);
});

// 验证两条历史同源映射改为同一平台标签时展示冲突，不让整个列表因重复标签消失。
test('重复历史源点同时改名时保持可取消的冲突预览', () => {
  const a = make('a', ['p0'], 'A_');
  const b = make('b', ['p0'], 'B_');
  const latest = { ...template, points: template.points.map(p => p.id === 'p0' ? { ...p, tag: '平台新标签' } : p) };
  const o = options([a.application, b.application], [...a.points, ...b.points], latest);
  const selectedIds = choose(o, r => r.source_point_id === 'p0');
  const plan = api.planConnectionTemplateChanges({ ...o, selectedIds });
  assert.ok(plan.rows.filter(r => selectedIds.includes(r.id)).every(r => r.blocked));
  assert.throws(() => api.applyConnectionTemplateChanges({ ...o, selectedIds }), /冲突/);
});
