import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createRouteDirectionDraft, hasDraftSelection, changeDraftConnection,
  getDraftPairs, removeDraftPair, buildDirectionRoutes, classifyDraftRoutes,
  filterTags, selectFilteredTags, matchSameNameTags,
  findInvalidConnectionGroups,
} from '../../src/pages/DataBus/route-draft.ts';

const connections = [1, 2, 3, 4].map((id) => ({ conn_id: id, module_name: 'ModbusTCP', conn_name: `设备${id}` }));
const group = (id, src = 1, dst = 2) => ({ ...createRouteDirectionDraft(id, src, dst), sourceTags: ['功率', '电压'], destinationTags: ['P', 'U'] });

// 多组各自持有点位与顺序，统一构造包含第三组，不限制两个方向。
test('多组草稿切换编辑后保持各组点位并统一生成路由', () => {
  const groups = [group(1), group(2, 3, 2), group(3, 4, 2)];
  const original = structuredClone(groups);
  const next = groups.map((draft) => draft.id === 2 ? changeDraftConnection(draft, 'destination', 4) : draft);
  assert.deepEqual(groups, original);
  assert.deepEqual(next[0], original[0]);
  assert.deepEqual(next[2], original[2]);
  assert.deepEqual(next[1].sourceTags, ['功率', '电压']);
  assert.equal(next.flatMap((draft) => buildDirectionRoutes(draft, connections)).length, 4);
  assert.equal(groups.flatMap((draft) => buildDirectionRoutes(draft, connections)).length, 6);
});

// 切换源连接只清空源标签及自定义源字段，另一侧及映射顺序保留。
test('更换源连接保留目标点位与自定义目标字段', () => {
  const draft = { ...group(1), mode: 'custom', customMappings: [{ id: 10, sourceTag: 'A', destinationTag: 'X' }, { id: 11, destinationTag: 'Y' }] };
  const next = changeDraftConnection(draft, 'source', 3);
  assert.equal(next.sourceConnId, 3);
  assert.deepEqual(next.sourceTags, []);
  assert.deepEqual(next.destinationTags, ['P', 'U']);
  assert.deepEqual(next.customMappings, [{ id: 10, destinationTag: 'X' }, { id: 11, destinationTag: 'Y' }]);
  assert.equal(next.mode, 'custom');
  assert.equal(draft.customMappings[0].sourceTag, 'A');
});

// 更换目标连接与源侧规则对称；同一连接不重置草稿。
test('更换目标连接保留源点位且相同连接不清空', () => {
  const draft = { ...group(1), customMappings: [{ id: 10, sourceTag: 'A', destinationTag: 'X' }] };
  const next = changeDraftConnection(draft, 'destination', 3);
  assert.deepEqual(next.sourceTags, draft.sourceTags);
  assert.deepEqual(next.destinationTags, []);
  assert.deepEqual(next.customMappings, [{ id: 10, sourceTag: 'A' }]);
  assert.equal(changeDraftConnection(draft, 'source', 1), draft);
  assert.equal(changeDraftConnection(draft, 'destination', 2), draft);
});

// 新建组可以从更换草稿派生，但原组内容必须保留。
test('保留旧组并新建时只在新组清空受影响侧', () => {
  const old = group(1);
  const next = { ...changeDraftConnection(old, 'source', 3), id: 2 };
  assert.deepEqual(old.sourceTags, ['功率', '电压']);
  assert.equal(old.sourceConnId, 1);
  assert.equal(next.sourceConnId, 3);
  assert.deepEqual(next.destinationTags, old.destinationTags);
  assert.ok(hasDraftSelection(next));
  assert.equal(hasDraftSelection(createRouteDirectionDraft(3, 1, 2)), false);
  assert.ok(hasDraftSelection({ ...createRouteDirectionDraft(3, 1, 2), customMappings: [{ id: 9, destinationTag: 'X' }] }));
});

// 配对删除同时移除两侧同序号，不能将剩余点位错位重配。
test('删除一对一配对及自定义映射保持其余绑定', () => {
  const draft = { ...group(1), customMappings: [{ id: 20, sourceTag: 'A', destinationTag: 'B' }] };
  const next = removeDraftPair(draft, 'ordered', 0);
  assert.deepEqual(next.sourceTags, ['电压']);
  assert.deepEqual(next.destinationTags, ['U']);
  assert.equal(getDraftPairs(next).length, 2);
  const noCustom = removeDraftPair(next, 'custom', 20);
  assert.equal(noCustom.customMappings.length, 1);
  assert.equal(getDraftPairs(noCustom).length, 1);
  assert.equal(draft.sourceTags.length, 2);
});

// 不完整配对仍在草稿预览内；连接缺失时不得生成空模块路由。
test('配对预览保留未配对项并排除未选择连接的路由', () => {
  const draft = { ...group(1), destinationTags: ['P'] };
  assert.equal(getDraftPairs(draft).length, 2);
  assert.equal(getDraftPairs(draft)[1].destinationTag, undefined);
  assert.equal(buildDirectionRoutes(draft, connections).length, 1);
  assert.deepEqual(buildDirectionRoutes({ ...draft, destinationConnId: null }, connections), []);
  assert.deepEqual(buildDirectionRoutes({ ...draft, sourceConnId: 999 }, connections), []);
});

// 切换模式不会让另一种模式的完整映射从最终提交中消失。
test('两种编辑模式的映射共同进入预览与提交', () => {
  const draft = { ...group(1), mode: 'custom', customMappings: [{ id: 20, sourceTag: 'A', destinationTag: 'X' }] };
  assert.deepEqual(getDraftPairs(draft).map((pair) => pair.kind), ['ordered', 'ordered', 'custom']);
  assert.deepEqual(buildDirectionRoutes(draft, connections).map((route) => [route.src.tag, route.dst.tag]), [['功率', 'P'], ['电压', 'U'], ['A', 'X']]);
  assert.deepEqual(buildDirectionRoutes({ ...draft, mode: 'ordered' }, connections), buildDirectionRoutes(draft, connections));
});

// 任一含点位的组缺少有效连接应阻止整批提交，空白组不阻塞其他组。
test('提交连接校验识别失效连接及缺选连接且忽略空白组', () => {
  const drafts = [group(1), group(2, 999, 2), group(3, 1, null), createRouteDirectionDraft(4, null, null)];
  assert.deepEqual(findInvalidConnectionGroups(drafts, connections).map((draft) => draft.id), [2, 3]);
  assert.deepEqual(findInvalidConnectionGroups([group(1)], connections), []);
  assert.deepEqual(findInvalidConnectionGroups([group(1)], connections.filter((conn) => conn.conn_id !== 1)).map((draft) => draft.id), [1]);
});

// 跨组重复只创建一次，反向路由需跨组及现有列表共同校验。
test('跨组去重与双向校验保留所属组信息', () => {
  const first = { ...group(1), sourceTags: ['A'], destinationTags: ['B'] };
  const duplicate = { ...first, id: 2 };
  const result = classifyDraftRoutes([first, duplicate], connections, []);
  assert.deepEqual(result.map((item) => [item.directionId, item.status]), [[1, 'ready'], [2, 'duplicate']]);
  const reverse = { ...group(3, 2, 1), sourceTags: ['B'], destinationTags: ['A'] };
  assert.deepEqual(classifyDraftRoutes([first, reverse], connections, []).map((item) => item.status), ['bidirectional', 'bidirectional']);
  const existing = buildDirectionRoutes(first, connections);
  assert.equal(classifyDraftRoutes([first], connections, existing)[0].status, 'existing');
  assert.equal(classifyDraftRoutes([reverse], connections, existing)[0].status, 'bidirectional');
});

// 同一连接不同点可以转发，自环必须禁止；一对多不受误判。
test('自环与一对多使用端点身份判断', () => {
  const self = { ...group(1, 1, 1), sourceTags: ['A'], destinationTags: ['A'] };
  assert.equal(classifyDraftRoutes([self], connections, [])[0].status, 'self');
  const fanout = { ...createRouteDirectionDraft(2, 1, 2), customMappings: [{ id: 1, sourceTag: 'A', destinationTag: 'B' }, { id: 2, sourceTag: 'A', destinationTag: 'C' }] };
  assert.deepEqual(classifyDraftRoutes([fanout], connections, []).map((item) => item.status), ['ready', 'ready']);
});

// 搜索后的批量选择追加而非覆盖已有点位，不改变已选顺序。
test('搜索筛选批量选择保留已有选择顺序并去重', () => {
  const filtered = filterTags(['Power_A', '电压', 'power_B'], ' POWER ');
  assert.deepEqual(filtered, ['Power_A', 'power_B']);
  assert.deepEqual(selectFilteredTags(['电压', 'power_B'], filtered), ['电压', 'power_B', 'Power_A']);
  assert.deepEqual(filterTags(['A', 'B'], ''), ['A', 'B']);
});

// 同名匹配必须精确比较标签并按源目录顺序输出，不能依赖目标目录排序。
test('同名匹配精确生成配对预览且不修改输入', () => {
  const src = ['U', 'P', 'A', 'U'];
  const dst = ['P', 'U', 'a'];
  assert.deepEqual(matchSameNameTags(src, dst), { sourceTags: ['U', 'P'], destinationTags: ['U', 'P'] });
  assert.deepEqual(matchSameNameTags(['A'], ['a']), { sourceTags: [], destinationTags: [] });
  assert.deepEqual(src, ['U', 'P', 'A', 'U']);
});
