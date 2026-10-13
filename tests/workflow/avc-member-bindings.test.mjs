import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAvcMemberSignals,
  buildAvcMemberBindingEdits,
  collectAvcMemberMappingFields,
} from '../../src/utils/avc-member-bindings.ts';
import {
  buildControlMappingPlan,
  controlMappingFieldKey,
  getControlMappingEndpoints,
} from '../../src/utils/control-mapping-editor.ts';
import {
  ControlGroupRoutesError,
  retryControlRoutes,
  saveControlGroupWithOptionalRoutes,
} from '../../src/utils/control-auto-routing.ts';

const endpoint = (tag, connName = '逆变器1') => ({ module_name: 'ModbusRTU', conn_name: connName, tag });
const local = (tag) => ({ module_name: 'AVC', conn_name: '控制组1', tag });
const field = (tag, direction) => ({ label: tag, tag, direction });
const signal = (tag, extra = {}) => ({ tag, unit: 'kVar', scale: 1, offset: 0, scale_decimal: '1', offset_decimal: '0', ...extra });
const legacyMember = (extra = {}) => ({
  member_name: '逆变器1', controllable: true,
  weight: 1, q_min_kvar: -100, q_max_kvar: 100,
  q_meas: signal('内部测量', { unit: 'W', scale: 0.001, offset: -1, scale_decimal: '0.00100000000000000001', offset_decimal: '-1.00000000000000000001' }),
  q_set: { signal: signal('内部设定', { unit: '%', scale: 2, offset: 3, scale_decimal: '2.00000000000000000001', offset_decimal: '3' }), mode: 2, delta_base: 3, base_tag: '内部基准' },
  ...extra,
});
const normalizedSignal = (next) => {
  assert.equal(next.unit, 'kVar');
  assert.equal(next.scale, 1);
  assert.equal(next.offset, 0);
  assert.equal(next.scale_decimal, '1');
  assert.equal(next.offset_decimal, '0');
};

// 验证新成员内部点名不会复用外部点名，且避免与组输入输出、成员信号和增量基准冲突。
test('AVC 新成员信号采用恒等工程量并生成同组唯一 tag', () => {
  const original = buildAvcMemberSignals({ memberName: ' PCS / #1 ', existingMembers: [], changedSignals: { q_meas: true, q_set: true } });
  normalizedSignal(original.q_meas);
  normalizedSignal(original.q_set.signal);
  assert.ok(original.q_meas.tag.trim());
  assert.notEqual(original.q_meas.tag, original.q_set.signal.tag);
  const occupied = [original.q_meas.tag, original.q_set.signal.tag];
  const next = buildAvcMemberSignals({
    memberName: ' PCS / #1 ',
    existingMembers: [legacyMember({ q_meas: signal(`${original.q_meas.tag}_2`), q_set: { ...legacyMember().q_set, signal: signal(`${original.q_set.signal.tag}_2`), base_tag: `${original.q_meas.tag}_3` } })],
    groupTags: occupied,
    changedSignals: { q_meas: true, q_set: true },
  });
  const existingTags = [...occupied, `${original.q_meas.tag}_2`, `${original.q_set.signal.tag}_2`, `${original.q_meas.tag}_3`];
  assert.ok(!existingTags.includes(next.q_meas.tag));
  assert.ok(!existingTags.includes(next.q_set.signal.tag));
  assert.notEqual(next.q_meas.tag, next.q_set.signal.tag);
});

// 验证旧成员改名称或无功范围不会改变信号精度、换算和增量模式，也不会修改输入对象。
test('AVC 未换点的旧成员保持原信号与命令语义', () => {
  const originalMember = legacyMember();
  originalMember.q_meas.vendor_decimal = '0.00000000000000000001';
  originalMember.q_set.extension = { command_quality: 'legacy' };
  const before = structuredClone(originalMember);
  const next = buildAvcMemberSignals({ memberName: '新名称', existingMembers: [], originalMember, changedSignals: { q_meas: false, q_set: false } });
  assert.deepEqual(next.q_meas, originalMember.q_meas);
  assert.deepEqual(next.q_set, originalMember.q_set);
  assert.deepEqual(originalMember, before);
});

// 验证内部 tag 明确替换时，旧字段和新字段都进入计划，且不修改所选端点。
test('AVC 更换内部 tag 时同时清理旧字段并绑定新字段', () => {
  const originalMember = legacyMember();
  const member = { ...originalMember, q_meas: signal('新的内部测量') };
  const selected = { q_meas: [endpoint('新的外部测量')] };
  const before = structuredClone(selected);
  const edited = buildAvcMemberBindingEdits({ member, originalMember, selected });
  const oldRoute = { src: endpoint('旧测量'), dst: local('内部测量') };
  const plan = buildControlMappingPlan({
    moduleName: 'AVC', groupName: '控制组1',
    fields: [...collectAvcMemberMappingFields([originalMember]), ...collectAvcMemberMappingFields([member])],
    baselineRoutes: [oldRoute], edited,
  });
  assert.deepEqual(plan.routes, [{ src: endpoint('新的外部测量'), dst: local('新的内部测量') }]);
  assert.deepEqual(plan.removedRoutes, [oldRoute]);
  assert.deepEqual(selected, before);
  assert.notEqual(edited[controlMappingFieldKey(field('新的内部测量', 'input'))][0], selected.q_meas[0]);
});

// 验证增量命令由指定基准切换为其他来源时，只解除指定基准路由。
test('AVC 取消指定基准保留测量和设定路由', () => {
  const originalMember = legacyMember();
  const member = { ...originalMember, q_set: { ...originalMember.q_set, delta_base: 1, base_tag: '' } };
  assert.deepEqual(buildAvcMemberBindingEdits({ member, originalMember, selected: { base_tag: [endpoint('隐藏基准')] } }), {
    [controlMappingFieldKey(field('内部基准', 'input'))]: [],
  });
});

// 验证旧绑定清理失败保存完整新增/删除差异；重试只同步路由，不再次保存控制组。
test('AVC 换点清理失败保留完整差异供路由独立重试', async () => {
  const member = legacyMember();
  const oldRoute = { src: endpoint('旧测量'), dst: local('内部测量') };
  const edited = buildAvcMemberBindingEdits({ member, originalMember: member, selected: { q_meas: [endpoint('新测量')] } });
  const plan = buildControlMappingPlan({
    moduleName: 'AVC', groupName: '控制组1', fields: collectAvcMemberMappingFields([member]), baselineRoutes: [oldRoute], edited,
  });
  const calls = [];
  let pending;
  await assert.rejects(saveControlGroupWithOptionalRoutes({
    createRoutes: true, ...plan,
    saveGroup: async () => calls.push('保存组'),
    saveRoutes: async (routes) => { calls.push('新增路由'); assert.deepEqual(routes, plan.routes); },
    deleteRoutes: async () => { calls.push('删除失败'); throw new Error('断线'); },
  }), (error) => {
    assert.ok(error instanceof ControlGroupRoutesError);
    assert.equal(error.phase, 'delete');
    assert.equal(error.groupSaved, true);
    assert.deepEqual(error.routes, plan.routes);
    assert.deepEqual(error.removedRoutes, [oldRoute]);
    pending = error;
    return true;
  });
  await retryControlRoutes(pending, {
    saveRoutes: async (routes) => { calls.push('重试新增'); assert.deepEqual(routes, plan.routes); },
    deleteRoutes: async (routes) => { calls.push('重试删除'); assert.deepEqual(routes, [oldRoute]); },
  });
  assert.deepEqual(calls, ['保存组', '新增路由', '删除失败', '重试新增', '重试删除']);
});

// 验证旧成员缺失信号时补出的本地 tag 不会撞上该成员自身保留的另一信号。
test('AVC 补齐旧成员缺失信号时避开自身已有 tag', () => {
  const defaults = buildAvcMemberSignals({ memberName: '逆变器1', existingMembers: [], changedSignals: { q_meas: true, q_set: true } });
  const originalMember = legacyMember({ q_meas: null, q_set: { ...legacyMember().q_set, signal: signal(defaults.q_meas.tag) } });
  const next = buildAvcMemberSignals({ memberName: '逆变器1', existingMembers: [], originalMember, changedSignals: { q_meas: true, q_set: false } });
  normalizedSignal(next.q_meas);
  assert.notEqual(next.q_meas.tag, originalMember.q_set.signal.tag);
  assert.notEqual(next.q_meas.tag, originalMember.q_set.base_tag);
  assert.deepEqual(next.q_set, originalMember.q_set);
});

// 验证明确换测量点或非 BASE_TAG 模式的设定点只恢复该信号的恒等换算。
test('AVC 明确更换测量或设定点只归一化对应信号', () => {
  for (const changed of ['q_meas', 'q_set']) {
    const originalMember = changed === 'q_set'
      ? legacyMember({ q_set: { ...legacyMember().q_set, mode: 1, delta_base: 0, base_tag: '' } })
      : legacyMember();
    const next = buildAvcMemberSignals({ memberName: '新名称', existingMembers: [], originalMember, changedSignals: { q_meas: changed === 'q_meas', q_set: changed === 'q_set' } });
    assert.equal(next.q_meas.tag, '内部测量');
    assert.equal(next.q_set.signal.tag, '内部设定');
    if (changed === 'q_meas') {
      normalizedSignal(next.q_meas);
      assert.deepEqual(next.q_set, originalMember.q_set);
    } else {
      normalizedSignal(next.q_set.signal);
      assert.deepEqual(next.q_meas, originalMember.q_meas);
      assert.equal(next.q_set.mode, 1);
      assert.equal(next.q_set.delta_base, 0);
      assert.equal(next.q_set.base_tag, '');
    }
  }
});

// 验证旧 BASE_TAG 信号的换算属于基准输入，仅更换设定输出时不能破坏旧基准工程量。
test('AVC 只换设定输出时保留未换增量基准的旧换算', () => {
  const originalMember = legacyMember();
  const before = structuredClone(originalMember);
  const next = buildAvcMemberSignals({
    memberName: originalMember.member_name, existingMembers: [], originalMember,
    changedSignals: { q_meas: false, q_set: true, base_tag: false },
  });
  assert.deepEqual(next.q_meas, originalMember.q_meas);
  assert.deepEqual(next.q_set, originalMember.q_set);
  assert.deepEqual(originalMember, before);
  const member = { ...originalMember, ...next };
  assert.deepEqual(buildAvcMemberBindingEdits({ member, originalMember, selected: { q_set: [endpoint('新设定输出')] } }), {
    [controlMappingFieldKey(field('内部设定', 'output'))]: [endpoint('新设定输出')],
  });
});

// 验证更换到已经换算为 kVar 的增量基准点时恢复其恒等换算，保留测量信号和设定端点。
test('AVC 更换增量基准输入时恢复恒等换算并只替换基准路由', () => {
  const originalMember = legacyMember();
  const before = structuredClone(originalMember);
  const next = buildAvcMemberSignals({
    memberName: originalMember.member_name, existingMembers: [], originalMember,
    changedSignals: { q_meas: false, q_set: false, base_tag: true },
  });
  normalizedSignal(next.q_set.signal);
  assert.deepEqual(next.q_meas, originalMember.q_meas);
  assert.equal(next.q_set.signal.tag, originalMember.q_set.signal.tag);
  assert.equal(next.q_set.mode, 2);
  assert.equal(next.q_set.delta_base, 3);
  assert.equal(next.q_set.base_tag, '内部基准');
  assert.deepEqual(originalMember, before);
  const member = { ...originalMember, ...next };
  const fields = collectAvcMemberMappingFields([member]);
  const oldBase = { src: endpoint('旧基准输入'), dst: local('内部基准') };
  const oldSet = { src: local('内部设定'), dst: endpoint('已有设定输出') };
  const edited = buildAvcMemberBindingEdits({ member, originalMember, selected: { base_tag: [endpoint('新kVar基准输入')] } });
  const plan = buildControlMappingPlan({ moduleName: 'AVC', groupName: '控制组1', fields, baselineRoutes: [oldBase, oldSet], edited });
  assert.deepEqual(plan.routes, [{ src: endpoint('新kVar基准输入'), dst: local('内部基准') }]);
  assert.deepEqual(plan.removedRoutes, [oldBase]);
});

// 验证回显多个旧端点后只修改无功范围不会默默选第一个端点并覆盖其他路由。
test('AVC 未换点保留多个既有测量与设定映射', () => {
  const member = legacyMember();
  const fields = [field('内部测量', 'input'), field('内部设定', 'output'), field('内部基准', 'input')];
  const routes = [
    { src: endpoint('测量A'), dst: local('内部测量') },
    { src: endpoint('测量B', '备用逆变器'), dst: local('内部测量') },
    { src: local('内部设定'), dst: endpoint('设定A') },
    { src: local('内部设定'), dst: endpoint('设定B', '备用逆变器') },
  ];
  assert.equal(getControlMappingEndpoints(routes, 'AVC', '控制组1', fields[0]).length, 2);
  assert.equal(getControlMappingEndpoints(routes, 'AVC', '控制组1', fields[1]).length, 2);
  const edited = buildAvcMemberBindingEdits({ member: { ...member, q_max_kvar: 200 }, originalMember: member, selected: {} });
  assert.deepEqual(edited, {});
  assert.deepEqual(buildControlMappingPlan({ moduleName: 'AVC', groupName: '控制组1', fields, baselineRoutes: routes, edited }), { routes: [], removedRoutes: [] });
});

// 验证明确换测量点只替换测量字段的全部旧绑定，不影响旧设定、基准及无关路由。
test('AVC 换点替换指定字段且保留其他成员路由', () => {
  const member = legacyMember();
  const oldMeasurementRoutes = [
    { src: endpoint('测量A'), dst: local('内部测量') },
    { src: endpoint('测量B'), dst: local('内部测量') },
  ];
  const oldSet = { src: local('内部设定'), dst: endpoint('设定') };
  const unrelated = { src: endpoint('其他成员测量'), dst: local('其他成员内部测量') };
  const edited = buildAvcMemberBindingEdits({ member, originalMember: member, selected: { q_meas: [endpoint('新测量')] } });
  assert.deepEqual(Object.keys(edited), [controlMappingFieldKey(field('内部测量', 'input'))]);
  const plan = buildControlMappingPlan({ moduleName: 'AVC', groupName: '控制组1', fields: [field('内部测量', 'input'), field('内部设定', 'output')], baselineRoutes: [...oldMeasurementRoutes, oldSet, unrelated], edited });
  assert.deepEqual(plan.routes, [{ src: endpoint('新测量'), dst: local('内部测量') }]);
  assert.deepEqual(plan.removedRoutes, oldMeasurementRoutes);
});

// 验证可控改为不可控时只解除设定与增量基准旧绑定，不创建隐藏的输出路由。
test('AVC 不可控成员忽略设定选择并解除旧控制映射', () => {
  const originalMember = legacyMember();
  const member = { ...originalMember, controllable: false, q_set: null };
  const edited = buildAvcMemberBindingEdits({ member, originalMember, selected: { q_set: [endpoint('隐藏设定')] } });
  assert.deepEqual(edited, {
    [controlMappingFieldKey(field('内部设定', 'output'))]: [],
    [controlMappingFieldKey(field('内部基准', 'input'))]: [],
  });
  const newMemberEdits = buildAvcMemberBindingEdits({ member, selected: { q_meas: [endpoint('测量')], q_set: [endpoint('隐藏设定')] } });
  assert.deepEqual(newMemberEdits, { [controlMappingFieldKey(field('内部测量', 'input'))]: [endpoint('测量')] });
});

// 验证取消增量基准只清理旧基准映射，保留未明确更换的设定点。
test('AVC 改为绝对值命令时清理废弃的增量基准映射', () => {
  const originalMember = legacyMember();
  const member = { ...originalMember, q_set: { ...originalMember.q_set, mode: 1, base_tag: '' } };
  assert.deepEqual(buildAvcMemberBindingEdits({ member, originalMember, selected: {} }), {
    [controlMappingFieldKey(field('内部基准', 'input'))]: [],
  });
});

// 验证删除成员时原字段仍参与差异计划，只清理该成员的输入、输出和基准路由。
test('AVC 删除成员保留原映射字段以清理其路由', () => {
  const member = legacyMember();
  const removedFields = collectAvcMemberMappingFields([member]);
  assert.deepEqual(removedFields.map(({ tag, direction }) => ({ tag, direction })), [
    { tag: '内部测量', direction: 'input' },
    { tag: '内部设定', direction: 'output' },
    { tag: '内部基准', direction: 'input' },
  ]);
  const memberRoutes = [
    { src: endpoint('测量'), dst: local('内部测量') },
    { src: local('内部设定'), dst: endpoint('设定') },
    { src: endpoint('基准'), dst: local('内部基准') },
  ];
  const otherMember = legacyMember({ member_name: '其他成员', q_meas: signal('其他成员测量'), q_set: null, controllable: false });
  const unrelatedRoutes = [
    { src: endpoint('其他测量'), dst: local('其他成员测量') },
    { src: endpoint('总控目标'), dst: local('组目标') },
    { src: endpoint('其他控制组测量'), dst: { ...local('内部测量'), conn_name: '控制组2' } },
  ];
  const edited = Object.fromEntries(removedFields.map((mappingField) => [controlMappingFieldKey(mappingField), []]));
  const plan = buildControlMappingPlan({
    moduleName: 'AVC', groupName: '控制组1',
    fields: [...collectAvcMemberMappingFields([otherMember]), ...removedFields],
    baselineRoutes: [...memberRoutes, ...unrelatedRoutes], edited,
  });
  assert.deepEqual(plan.routes, []);
  assert.deepEqual(plan.removedRoutes, memberRoutes);
});

// 验证新成员选点在最终保存时生成正确方向路由，失败保留完整计划且只重试路由。
test('AVC 新成员最终保存自动绑定并支持配置保存后的独立路由重试', async () => {
  const signals = buildAvcMemberSignals({ memberName: '新成员', existingMembers: [], changedSignals: { q_meas: true, q_set: true } });
  const member = { ...legacyMember(), ...signals };
  const fields = [field(member.q_meas.tag, 'input'), field(member.q_set.signal.tag, 'output')];
  const selected = { q_meas: [endpoint('实际无功')], q_set: [endpoint('无功命令')] };
  const edited = buildAvcMemberBindingEdits({ member, selected });
  const plan = buildControlMappingPlan({ moduleName: 'AVC', groupName: '控制组1', fields, baselineRoutes: [], edited });
  assert.deepEqual(plan.routes, [
    { src: endpoint('实际无功'), dst: local(member.q_meas.tag) },
    { src: local(member.q_set.signal.tag), dst: endpoint('无功命令') },
  ]);
  const calls = [];
  let pending;
  await assert.rejects(saveControlGroupWithOptionalRoutes({
    createRoutes: true, ...plan,
    saveGroup: async () => calls.push('保存控制组'),
    saveRoutes: async () => { calls.push('路由失败'); throw new Error('DataCenter 暂不可用'); },
  }), (error) => {
    assert.ok(error instanceof ControlGroupRoutesError);
    assert.equal(error.groupSaved, true);
    assert.deepEqual(error.routes, plan.routes);
    pending = error;
    return true;
  });
  await retryControlRoutes(pending, { saveRoutes: async (routes) => { calls.push('重试路由'); assert.deepEqual(routes, plan.routes); } });
  assert.deepEqual(calls, ['保存控制组', '路由失败', '重试路由']);
});
