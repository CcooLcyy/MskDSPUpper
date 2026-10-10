import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildControlMappingPlan,
  getControlMappingEndpoints,
  controlMappingFieldKey,
} from '../../src/utils/control-mapping-editor.ts';
import { saveControlGroupWithOptionalRoutes, retryControlRoutes } from '../../src/utils/control-auto-routing.ts';

const group = (tag) => ({ module_name: 'AGC', conn_name: '控制组', tag });
const external = (tag) => ({ module_name: 'ModbusRTU', conn_name: 'PCS', tag });
const field = { label: '目标', tag: '目标', direction: 'input' };
const oldRoute = { src: external('旧目标'), dst: group('目标') };
const unrelated = { src: external('量测'), dst: group('成员测量') };
const options = { moduleName: 'AGC', groupName: '控制组', fields: [field], baselineRoutes: [oldRoute, unrelated] };

// 验证映射回显保留多个外部端点，并忽略运行期连接编号。
test('映射回显保留一对多的稳定端点', () => {
  const result = getControlMappingEndpoints([oldRoute, { src: { ...external('另一目标'), conn_id: 5 }, dst: group('目标') }], 'AGC', '控制组', field);
  assert.deepEqual(result, [external('旧目标'), external('另一目标')]);
});

// 验证未明确编辑映射时不触碰任何既有路由。
test('未编辑映射保留所有既有路由', () => {
  assert.deepEqual(buildControlMappingPlan({ ...options, edited: {} }), { routes: [], removedRoutes: [] });
});

// 验证更换来源只清理当前字段旧绑定，不影响其他成员。
test('更换来源只修改明确编辑的字段', () => {
  const plan = buildControlMappingPlan({ ...options, edited: { [controlMappingFieldKey(field)]: [external('新目标')] } });
  assert.deepEqual(plan.routes, [{ src: external('新目标'), dst: group('目标') }]);
  assert.deepEqual(plan.removedRoutes, [oldRoute]);
  assert.ok(!plan.removedRoutes.includes(unrelated));
});

// 验证清空选择能够解除当前字段映射而不依赖新增路由。
test('清空外部点生成纯删除计划', () => {
  const plan = buildControlMappingPlan({ ...options, edited: { [controlMappingFieldKey(field)]: [] } });
  assert.deepEqual(plan, { routes: [], removedRoutes: [oldRoute] });
});

// 验证显式编辑的映射优先于旧成员快速选点草稿。
test('明确编辑优先于成员自动路由草稿', () => {
  const plan = buildControlMappingPlan({ ...options, edited: { [controlMappingFieldKey(field)]: [] }, bindings: [{ direction: 'input', groupTag: field.tag, external: external('快速选点') }] });
  assert.deepEqual(plan, { routes: [], removedRoutes: [oldRoute] });
});

// 验证不能把当前组当作外部端点。
test('映射编辑拒绝控制组自引用', () => {
  assert.throws(() => buildControlMappingPlan({ ...options, edited: { [controlMappingFieldKey(field)]: [group('另一点')] } }), /当前控制组/);
});

// 验证输出字段正确生成控制组到外部的路由且重复选择去重。
test('输出映射方向正确并去重', () => {
  const output = { ...field, direction: 'output' };
  const plan = buildControlMappingPlan({ ...options, fields: [output], edited: { [controlMappingFieldKey(output)]: [external('设定'), external('设定')] } });
  assert.deepEqual(plan.routes, [{ src: group('目标'), dst: external('设定') }]);
});

// 验证纯删除计划也在配置保存后执行。
test('纯删除计划先保存配置再解除路由', async () => {
  const calls = [];
  await saveControlGroupWithOptionalRoutes({ createRoutes: true, routes: [], removedRoutes: [oldRoute], saveGroup: async () => calls.push('配置'), saveRoutes: async () => calls.push('新增'), deleteRoutes: async () => calls.push('删除') });
  assert.deepEqual(calls, ['配置', '删除']);
});

// 验证新增失败不清理旧路由，异常保留只重试路由所需的计划。
test('路由失败保留计划且重试不重复保存控制组', async () => {
  const calls = [];
  const newRoute = { src: external('新目标'), dst: group('目标') };
  let pending;
  try {
    await saveControlGroupWithOptionalRoutes({ createRoutes: true, routes: [newRoute], removedRoutes: [oldRoute], saveGroup: async () => calls.push('配置'), saveRoutes: async () => { calls.push('新增失败'); throw new Error('网络中断'); }, deleteRoutes: async () => calls.push('错误删除') });
  } catch (error) { pending = error; }
  assert.deepEqual(pending.routes, [newRoute]);
  assert.deepEqual(pending.removedRoutes, [oldRoute]);
  await retryControlRoutes(pending, { saveRoutes: async () => calls.push('重试新增'), deleteRoutes: async () => calls.push('重试删除') });
  assert.deepEqual(calls, ['配置', '新增失败', '重试新增', '重试删除']);
});

// 验证重试中的故障阶段更新，删除部分成功后仍可幂等重试。
test('重试从新增失败推进到旧路由清理失败时保留完整计划', async () => {
  const newRoute = { src: external('新目标'), dst: group('目标') };
  let pending;
  try {
    await saveControlGroupWithOptionalRoutes({ createRoutes: true, routes: [newRoute], removedRoutes: [oldRoute], saveGroup: async () => {}, saveRoutes: async () => { throw new Error('新增失败'); }, deleteRoutes: async () => {} });
  } catch (error) { pending = error; }
  assert.equal(pending.phase, 'upsert');
  try {
    await retryControlRoutes(pending, { saveRoutes: async () => {}, deleteRoutes: async () => { throw new Error('清理失败'); } });
  } catch (error) { pending = error; }
  assert.equal(pending.phase, 'delete');
  assert.deepEqual(pending.routes, [newRoute]);
  assert.deepEqual(pending.removedRoutes, [oldRoute]);
  const calls = [];
  await retryControlRoutes(pending, { saveRoutes: async () => calls.push('确认新绑定'), deleteRoutes: async () => calls.push('解除旧绑定') });
  assert.deepEqual(calls, ['确认新绑定', '解除旧绑定']);
});
