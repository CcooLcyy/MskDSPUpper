import assert from 'node:assert/strict';
import test from 'node:test';
import { calcInputTags, buildCalcRoutePlan, saveCalcWithRoutes, retryCalcRoutes, CalcSaveError } from '../../src/utils/calc-routing.ts';

const bus = { source_kind: 1, constant: null };
const scalar = { source_kind: 2, constant: { decimal_value: '1' } };
const item = { item_name: '总功率', operator_kind: 9, left_operand: null, right_operand: null, operands: [bus, bus, bus] };
const external = tag => ({ module_name: 'ModbusRTU', conn_name: '设备', tag });
const local = tag => ({ module_name: 'Calc', conn_name: '计算组', tag });
const inputRoute = (index, source) => ({ src: external(source), dst: local(`总功率/input_${index}`) });
const outputRoute = destination => ({ src: local('总功率/result'), dst: external(destination) });
const baseline = [inputRoute(1, 'A'), inputRoute(2, 'B'), inputRoute(3, 'C'), outputRoute('输出1')];
const unrelated = { src: external('其他源'), dst: local('其他项/left_input') };
const config = { group_name: '计算组', trigger_mode: 1, period_ms: 1000, items: [item] };
const nextConfig = { ...config, period_ms: 2000 };

// 验证多输入逻辑与混合表达式按列表生成槽位，旧二元逻辑继续保留左右标签。
test('逻辑列表和表达式派生输入标签并迁移旧二元路由', () => {
  for (const kind of [6, 7, 8, 11]) {
    assert.deepEqual(calcInputTags({ ...item, operator_kind: kind }), ['总功率/input_1', '总功率/input_2', '总功率/input_3']);
  }
  const previousItem = { ...item, operator_kind: 6, operands: [], left_operand: bus, right_operand: bus };
  assert.deepEqual(calcInputTags(previousItem), ['总功率/left_input', '总功率/right_input']);
  const oldRoutes = ['left_input', 'right_input'].map((suffix, index) => ({ src: external(index ? 'B' : 'A'), dst: local(`总功率/${suffix}`) }));
  const plan = buildCalcRoutePlan({ groupName: '计算组', previousItem, item: { ...item, operator_kind: 11, expression: '(A AND B) OR C' }, inputSources: [[external('A')], [external('B')], [external('C')]], outputs: [], baselineRoutes: oldRoutes });
  assert.deepEqual(plan.removedRoutes, oldRoutes);
  assert.deepEqual(plan.routes.map(route => route.dst.tag), ['总功率/input_1', '总功率/input_2', '总功率/input_3']);
});
const baseOptions = { groupName: '计算组', previousItem: item, item, inputSources: [[external('A')], [external('B')], [external('C')]], outputs: [external('输出1')], baselineRoutes: [...baseline, unrelated] };

// 验证普通、NOT 和聚合的输入槽位与下位机派生规则一致。
test('按运算方式生成完整输入标签', () => {
  assert.deepEqual(calcInputTags(item), ['总功率/input_1', '总功率/input_2', '总功率/input_3']);
  assert.deepEqual(calcInputTags({ ...item, operator_kind: 1, left_operand: bus, right_operand: scalar }), ['总功率/left_input', '总功率/right_input']);
  assert.deepEqual(calcInputTags({ ...item, operator_kind: 5, left_operand: bus }), ['总功率/left_input']);
});

// 验证再保存保留全部来源及一源多目标，且对其他计算项不产生删除计划。
test('保留已有多来源与多个输出目标并去重', () => {
  const plan = buildCalcRoutePlan({ ...baseOptions, inputSources: [[external('A'), external('第二来源'), external('A')], [external('B')], [external('C')]], outputs: [external('输出1'), external('输出2')] });
  assert.equal(plan.routes.length, 6);
  assert.deepEqual(plan.removedRoutes, []);
  assert(!plan.routes.some(route => route.dst.tag.startsWith('其他项')));
});

// 验证删除中间输入后按行携带的来源重新关联，不能继续保留旧位置的来源 B。
test('删除中间聚合输入将来源 C 迁移到第二槽位', () => {
  const plan = buildCalcRoutePlan({ ...baseOptions, item: { ...item, operands: [bus, bus] }, inputSources: [[external('A')], [external('C')]] });
  assert(plan.routes.some(route => route.dst.tag === '总功率/input_2' && route.src.tag === 'C'));
  assert.deepEqual(plan.removedRoutes, [baseline[1], baseline[2]]);
});

// 验证重命名迁移本项全部输入输出，而不接触其他项。
test('重命名迁移全部本项路由', () => {
  const plan = buildCalcRoutePlan({ ...baseOptions, item: { ...item, item_name: '新功率' } });
  assert.equal(plan.routes.length, 4);
  assert(plan.routes.every(route => route.dst.tag.startsWith('新功率/') || route.src.tag.startsWith('新功率/')));
  assert.deepEqual(plan.removedRoutes, baseline);
});

// 验证改常量只解除相应输入，其他输入及输出仍完整保留。
test('点位改常量解除该行旧路由', () => {
  const plan = buildCalcRoutePlan({ ...baseOptions, item: { ...item, operands: [bus, scalar, bus] }, inputSources: [[external('A')], [], [external('C')]] });
  assert.deepEqual(plan.removedRoutes, [baseline[1]]);
  assert.equal(plan.routes.length, 3);
});

// 验证删除计算项只删除本项关联，不按前缀误删名称相近的其他项。
test('删除计算项精确清理其路由', () => {
  const similar = { src: external('D'), dst: local('总功率扩展/input_1') };
  const plan = buildCalcRoutePlan({ ...baseOptions, item: null, baselineRoutes: [...baseline, unrelated, similar] });
  assert.deepEqual(plan.routes, []);
  assert.deepEqual(plan.removedRoutes, baseline);
});

// 验证不完整端点与新增自引用在产生任何路由计划前失败。
test('拒绝空端点及新增同组循环关联', () => {
  assert.throws(() => buildCalcRoutePlan({ ...baseOptions, outputs: [external('')] }), /完整|为空/);
  assert.throws(() => buildCalcRoutePlan({ ...baseOptions, outputs: [local('另一计算/input_1')] }), /当前|同一|循环/);
});

// 验证旧有同组关联可完整回显再保存，不静默删除用户已有配置。
test('保留已有同组来源', () => {
  const old = { src: local('旧计算/result'), dst: local('总功率/input_1') };
  const plan = buildCalcRoutePlan({ ...baseOptions, baselineRoutes: [old, ...baseline.slice(1)], inputSources: [[old.src], [external('B')], [external('C')]] });
  assert(plan.routes.some(route => route.src.tag === '旧计算/result'));
  assert.deepEqual(plan.removedRoutes, []);
});

function fixture({ running = true, autoStart = true, fail = '' } = {}) {
  const state = { config: structuredClone(config), running, fail };
  const calls = [];
  const api = {
    calcGetGroup: async () => { calls.push('读取'); return { config: structuredClone(state.config), state: state.running ? 2 : 1 }; },
    calcStopGroup: async () => { calls.push('停止'); state.running = false; },
    calcStartGroup: async () => { calls.push('启动'); if (state.fail === 'restart') throw new Error('恢复失败'); state.running = true; },
    calcUpsertGroup: async (value, create) => { calls.push('配置'); assert.equal(create, false); if (state.fail === 'config') throw new Error('配置失败'); state.config = structuredClone(value); state.running = autoStart; return { config: value, state: state.running ? 2 : 1 }; },
    dcUpsertRoutes: async (_routes, replace) => { calls.push('新增'); assert.equal(replace, false); assert.equal(state.running, false); if (state.fail === 'upsert') throw new Error('新增失败'); },
    dcDeleteRoutes: async () => { calls.push('清理'); assert.equal(state.running, false); if (state.fail === 'delete') throw new Error('清理失败'); },
  };
  const plan = { routes: [inputRoute(1, '新来源')], removedRoutes: [baseline[0]] };
  return { state, calls, api, plan, options: { config: nextConfig, expectedConfig: config, plan, api } };
}

// 验证下位机保存可能自动运行，必须再次停止后写路由，最后才恢复原运行状态。
test('运行分组按停止、配置、再次停止、路由、恢复顺序保存', async () => {
  const f = fixture(); await saveCalcWithRoutes(f.options);
  assert.deepEqual(f.calls.filter(call => call !== '读取'), ['停止', '配置', '停止', '新增', '清理', '启动']);
});

// 验证原来停止的分组即使保存后自动运行，也必须恢复到停止状态。
test('原停止分组保存后保持停止', async () => {
  const f = fixture({ running: false }); await saveCalcWithRoutes(f.options);
  assert.equal(f.state.running, false); assert(!f.calls.includes('启动'));
});

// 验证外部配置变更在停止和写入之前被发现。
test('外部配置变化阻止覆盖', async () => {
  const f = fixture(); f.state.config.period_ms = 333;
  await assert.rejects(saveCalcWithRoutes(f.options), /变更|变化|重新加载/);
  assert.deepEqual(f.calls, ['读取']);
});

// 验证配置失败不会写路由，并尝试恢复原运行状态，不能声称配置已保存。
test('配置失败不提交路由并报告配置阶段', async () => {
  const f = fixture({ fail: 'config' });
  await assert.rejects(saveCalcWithRoutes(f.options), error => error instanceof CalcSaveError && !error.configSaved && error.phase === 'config');
  assert(!f.calls.includes('新增')); assert.equal(f.state.running, true);
});

for (const fail of ['upsert', 'delete']) {
  // 验证各路由阶段失败后保留停止状态，重试不重复写入计算配置。
  test(`${fail} 路由阶段失败保留计划并支持重试`, async () => {
    const f = fixture({ fail }); let failure;
    await assert.rejects(saveCalcWithRoutes(f.options), error => { failure = error; return error instanceof CalcSaveError && error.configSaved && error.phase === 'routes'; });
    assert.equal(f.state.running, false); assert.deepEqual(failure.plan, f.plan);
    f.state.fail = ''; await retryCalcRoutes(failure, f.api);
    assert.equal(f.calls.filter(call => call === '配置').length, 1); assert.equal(f.state.running, true);
  });
}

// 验证待重试期间配置已变化，必须阻止旧计划覆盖新配置。
test('重试前校验已保存配置仍一致', async () => {
  const f = fixture({ fail: 'upsert' }); let failure;
  await assert.rejects(saveCalcWithRoutes(f.options), error => { failure = error; return true; });
  f.state.config.period_ms = 888; const before = f.calls.length;
  await assert.rejects(retryCalcRoutes(failure, f.api), /变更|变化|重新加载/);
  assert.deepEqual(f.calls.slice(before), ['读取']);
});

// 验证恢复运行失败可仅重试恢复，不重复保存配置或同步路由。
test('恢复失败仅重试恢复运行', async () => {
  const f = fixture({ fail: 'restart' }); let failure;
  await assert.rejects(saveCalcWithRoutes(f.options), error => { failure = error; return error instanceof CalcSaveError && error.configSaved && error.phase === 'restart'; });
  const before = f.calls.length; f.state.fail = ''; await retryCalcRoutes(failure, f.api);
  assert.deepEqual(f.calls.slice(before), ['读取', '启动']);
});

// 验证键顺序与未设置的可选字段不造成虚假的并发配置冲突。
test('配置相等判断忽略对象键顺序', async () => {
  const f = fixture(); f.options.expectedConfig = { items: structuredClone(config.items), period_ms: 1000, trigger_mode: 1, group_name: '计算组' };
  await saveCalcWithRoutes(f.options); assert.equal(f.state.config.period_ms, 2000);
});

function protectedFixture(options) {
  const f = fixture(options);
  f.plan = buildCalcRoutePlan({ ...baseOptions, inputSources: [[external('新来源')], [external('B')], [external('C')]] });
  f.state.routes = structuredClone([...baseline, unrelated]);
  f.api.dcListRoutes = async () => { f.calls.push('读取路由'); return structuredClone(f.state.routes); };
  f.options.plan = f.plan;
  return f;
}

// 验证当前计算项被外部改绑时在停止、配置写入之前终止。
test('保存前检测本项路由发生外部变化', async () => {
  const f = protectedFixture();
  f.state.routes[0] = inputRoute(1, '外部改绑');
  await assert.rejects(saveCalcWithRoutes(f.options), /路由.*变|关联.*变/);
  assert.deepEqual(f.calls, ['读取', '读取路由']);
});

// 验证其他计算项增加或改变关联不会阻止当前项保存。
test('其他计算项的路由变化不会造成误报', async () => {
  const f = protectedFixture();
  f.state.routes.push({ src: external('新增其他源'), dst: local('其他项/right_input') });
  await saveCalcWithRoutes(f.options);
  assert(f.calls.includes('配置'));
});

// 验证作用域包含新名称标签，防止迁移覆盖此前未知的同名关联。
test('重命名前同时保护新旧名称的路由作用域', async () => {
  const f = protectedFixture();
  f.options.plan = buildCalcRoutePlan({ ...baseOptions, item: { ...item, item_name: '新功率' } });
  f.state.routes.push({ src: external('外部来源'), dst: local('新功率/input_1') });
  await assert.rejects(saveCalcWithRoutes(f.options), /路由.*变|关联.*变/);
  assert(!f.calls.includes('配置'));
});

// 验证自身已新增但未清理的中间状态允许重试，不误判为外部变化。
test('重试接受自身新增和旧关联并存的中间态', async () => {
  const f = protectedFixture({ fail: 'delete' }); let failure;
  await assert.rejects(saveCalcWithRoutes(f.options), error => { failure = error; return error.phase === 'routes'; });
  f.state.routes.push(...f.plan.routes);
  f.state.fail = '';
  await retryCalcRoutes(failure, f.api);
  assert.equal(f.calls.filter(call => call === '配置').length, 1);
});

// 验证保存后标签同步可能清理旧标签，重试允许计划内旧关联已缺失。
test('重命名清理旧标签后的缺失旧路由允许重试', async () => {
  const f = protectedFixture({ fail: 'upsert' }); let failure;
  f.options.plan = buildCalcRoutePlan({ ...baseOptions, item: { ...item, item_name: '新功率' } });
  await assert.rejects(saveCalcWithRoutes(f.options), error => { failure = error; return error.phase === 'routes'; });
  f.state.routes = [unrelated]; f.state.fail = '';
  await retryCalcRoutes(failure, f.api);
  assert(f.calls.includes('新增'));
});

// 验证重试期间出现未知的新关联时保留重试计划并禁止覆盖。
test('重试阻止本项未知新路由', async () => {
  const f = protectedFixture({ fail: 'upsert' }); let failure;
  await assert.rejects(saveCalcWithRoutes(f.options), error => { failure = error; return error.phase === 'routes'; });
  f.state.routes.push(inputRoute(1, '外部新来源'));
  const before = f.calls.length;
  await assert.rejects(retryCalcRoutes(failure, f.api), /路由.*变|关联.*变/);
  assert.deepEqual(f.calls.slice(before), ['读取', '读取路由']);
});

// 验证外部删除未变更的关联也应被发现，不能把它作为自身失败造成的中间态。
test('重试阻止未变更关联被外部删除', async () => {
  const f = protectedFixture({ fail: 'upsert' }); let failure;
  await assert.rejects(saveCalcWithRoutes(f.options), error => { failure = error; return error.phase === 'routes'; });
  f.state.routes = f.state.routes.filter(route => route.dst.tag !== '总功率/input_2');
  await assert.rejects(retryCalcRoutes(failure, f.api), /路由.*变|关联.*变/);
});

// 验证路由加载失败不能视为无关联后继续写入配置。
test('受保护计划在路由读取失败时禁止保存', async () => {
  const f = protectedFixture(); f.api.dcListRoutes = async () => { throw new Error('读取路由失败'); };
  await assert.rejects(saveCalcWithRoutes(f.options), /读取路由失败/);
  assert(!f.calls.includes('配置'));
});
