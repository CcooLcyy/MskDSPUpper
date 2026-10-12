import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgcMemberSignals,
  buildAgcMemberBindingEdits,
  collectAgcMemberMappingFields,
} from '../../src/utils/agc-member-bindings.ts';
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
const local = (tag) => ({ module_name: 'AGC', conn_name: '控制组1', tag });
const field = (tag, direction) => ({ label: tag, tag, direction });
const signal = (tag, extra = {}) => ({ tag, unit: 'kW', scale: 1, offset: 0, scale_decimal: '1', offset_decimal: '0', ...extra });
const legacyMember = (extra = {}) => ({
  member_name: '逆变器1', controllable: true,
  capacity_kw: 100, weight: 1, min_kw: 0, max_kw: 100,
  p_meas: signal('内部测量', { unit: 'W', scale: 0.001, offset: -1, scale_decimal: '0.00100000000000000001', offset_decimal: '-1.00000000000000000001' }),
  p_set: { signal: signal('内部设定', { unit: '%', scale: 2, offset: 3, scale_decimal: '2.00000000000000000001', offset_decimal: '3' }), mode: 2, delta_base: 3, base_tag: '内部基准' },
  ...extra,
});
const normalizedSignal = (next) => {
  assert.equal(next.unit, 'kW');
  assert.equal(next.scale, 1);
  assert.equal(next.offset, 0);
  assert.equal(next.scale_decimal, '1');
  assert.equal(next.offset_decimal, '0');
};

// 验证新成员内部点名不会复用外部点名，且避免与组输入输出、成员信号和增量基准冲突。
test('AGC 新成员信号采用恒等工程量并生成同组唯一 tag', () => {
  const original = buildAgcMemberSignals({ memberName: ' PCS / #1 ', existingMembers: [], changedSignals: { p_meas: true, p_set: true } });
  normalizedSignal(original.p_meas);
  normalizedSignal(original.p_set.signal);
  assert.ok(original.p_meas.tag.trim());
  assert.notEqual(original.p_meas.tag, original.p_set.signal.tag);
  const occupied = [original.p_meas.tag, original.p_set.signal.tag];
  const next = buildAgcMemberSignals({
    memberName: ' PCS / #1 ',
    existingMembers: [legacyMember({ p_meas: signal(`${original.p_meas.tag}_2`), p_set: { ...legacyMember().p_set, signal: signal(`${original.p_set.signal.tag}_2`), base_tag: `${original.p_meas.tag}_3` } })],
    groupTags: occupied,
    changedSignals: { p_meas: true, p_set: true },
  });
  const existingTags = [...occupied, `${original.p_meas.tag}_2`, `${original.p_set.signal.tag}_2`, `${original.p_meas.tag}_3`];
  assert.ok(!existingTags.includes(next.p_meas.tag));
  assert.ok(!existingTags.includes(next.p_set.signal.tag));
  assert.notEqual(next.p_meas.tag, next.p_set.signal.tag);
});

// 验证旧成员改名称或容量不会改变信号精度、换算和增量模式，也不会修改输入对象。
test('AGC 未换点的旧成员保持原信号与命令语义', () => {
  const originalMember = legacyMember();
  const before = structuredClone(originalMember);
  const next = buildAgcMemberSignals({ memberName: '新名称', existingMembers: [], originalMember, changedSignals: { p_meas: false, p_set: false } });
  assert.deepEqual(next.p_meas, originalMember.p_meas);
  assert.deepEqual(next.p_set, originalMember.p_set);
  assert.deepEqual(originalMember, before);
});

// 验证旧成员缺失信号时补出的本地 tag 不会撞上该成员自身保留的另一信号。
test('AGC 补齐旧成员缺失信号时避开自身已有 tag', () => {
  const defaults = buildAgcMemberSignals({ memberName: '逆变器1', existingMembers: [], changedSignals: { p_meas: true, p_set: true } });
  const originalMember = legacyMember({ p_meas: null, p_set: { ...legacyMember().p_set, signal: signal(defaults.p_meas.tag) } });
  const next = buildAgcMemberSignals({ memberName: '逆变器1', existingMembers: [], originalMember, changedSignals: { p_meas: true, p_set: false } });
  normalizedSignal(next.p_meas);
  assert.notEqual(next.p_meas.tag, originalMember.p_set.signal.tag);
  assert.notEqual(next.p_meas.tag, originalMember.p_set.base_tag);
  assert.deepEqual(next.p_set, originalMember.p_set);
});

// 验证明确换测量点或非 BASE_TAG 模式的设定点只恢复该信号的恒等换算。
test('AGC 明确更换测量或设定点只归一化对应信号', () => {
  for (const changed of ['p_meas', 'p_set']) {
    const originalMember = changed === 'p_set'
      ? legacyMember({ p_set: { ...legacyMember().p_set, mode: 1, delta_base: 0, base_tag: '' } })
      : legacyMember();
    const next = buildAgcMemberSignals({ memberName: '新名称', existingMembers: [], originalMember, changedSignals: { p_meas: changed === 'p_meas', p_set: changed === 'p_set' } });
    assert.equal(next.p_meas.tag, '内部测量');
    assert.equal(next.p_set.signal.tag, '内部设定');
    if (changed === 'p_meas') {
      normalizedSignal(next.p_meas);
      assert.deepEqual(next.p_set, originalMember.p_set);
    } else {
      normalizedSignal(next.p_set.signal);
      assert.deepEqual(next.p_meas, originalMember.p_meas);
      assert.equal(next.p_set.mode, 1);
      assert.equal(next.p_set.delta_base, 0);
      assert.equal(next.p_set.base_tag, '');
    }
  }
});

// 验证旧 BASE_TAG 信号的换算属于基准输入，仅更换设定输出时不能破坏旧基准工程量。
test('AGC 只换设定输出时保留未换增量基准的旧换算', () => {
  const originalMember = legacyMember();
  const before = structuredClone(originalMember);
  const next = buildAgcMemberSignals({
    memberName: originalMember.member_name, existingMembers: [], originalMember,
    changedSignals: { p_meas: false, p_set: true, base_tag: false },
  });
  assert.deepEqual(next.p_meas, originalMember.p_meas);
  assert.deepEqual(next.p_set, originalMember.p_set);
  assert.deepEqual(originalMember, before);
  const member = { ...originalMember, ...next };
  assert.deepEqual(buildAgcMemberBindingEdits({ member, originalMember, selected: { p_set: [endpoint('新设定输出')] } }), {
    [controlMappingFieldKey(field('内部设定', 'output'))]: [endpoint('新设定输出')],
  });
});

// 验证更换到已经换算为 kW 的增量基准点时恢复其恒等换算，保留测量信号和设定端点。
test('AGC 更换增量基准输入时恢复恒等换算并只替换基准路由', () => {
  const originalMember = legacyMember();
  const before = structuredClone(originalMember);
  const next = buildAgcMemberSignals({
    memberName: originalMember.member_name, existingMembers: [], originalMember,
    changedSignals: { p_meas: false, p_set: false, base_tag: true },
  });
  normalizedSignal(next.p_set.signal);
  assert.deepEqual(next.p_meas, originalMember.p_meas);
  assert.equal(next.p_set.signal.tag, originalMember.p_set.signal.tag);
  assert.equal(next.p_set.mode, 2);
  assert.equal(next.p_set.delta_base, 3);
  assert.equal(next.p_set.base_tag, '内部基准');
  assert.deepEqual(originalMember, before);
  const member = { ...originalMember, ...next };
  const fields = collectAgcMemberMappingFields([member]);
  const oldBase = { src: endpoint('旧基准输入'), dst: local('内部基准') };
  const oldSet = { src: local('内部设定'), dst: endpoint('已有设定输出') };
  const edited = buildAgcMemberBindingEdits({ member, originalMember, selected: { base_tag: [endpoint('新kW基准输入')] } });
  const plan = buildControlMappingPlan({ moduleName: 'AGC', groupName: '控制组1', fields, baselineRoutes: [oldBase, oldSet], edited });
  assert.deepEqual(plan.routes, [{ src: endpoint('新kW基准输入'), dst: local('内部基准') }]);
  assert.deepEqual(plan.removedRoutes, [oldBase]);
});

// 验证回显多个旧端点后只修改容量不会默默选第一个端点并覆盖其他路由。
test('AGC 未换点保留多个既有测量与设定映射', () => {
  const member = legacyMember();
  const fields = [field('内部测量', 'input'), field('内部设定', 'output'), field('内部基准', 'input')];
  const routes = [
    { src: endpoint('测量A'), dst: local('内部测量') },
    { src: endpoint('测量B', '备用逆变器'), dst: local('内部测量') },
    { src: local('内部设定'), dst: endpoint('设定A') },
    { src: local('内部设定'), dst: endpoint('设定B', '备用逆变器') },
  ];
  assert.equal(getControlMappingEndpoints(routes, 'AGC', '控制组1', fields[0]).length, 2);
  assert.equal(getControlMappingEndpoints(routes, 'AGC', '控制组1', fields[1]).length, 2);
  const edited = buildAgcMemberBindingEdits({ member: { ...member, capacity_kw: 200 }, originalMember: member, selected: {} });
  assert.deepEqual(edited, {});
  assert.deepEqual(buildControlMappingPlan({ moduleName: 'AGC', groupName: '控制组1', fields, baselineRoutes: routes, edited }), { routes: [], removedRoutes: [] });
});

// 验证明确换测量点只替换测量字段的全部旧绑定，不影响旧设定、基准及无关路由。
test('AGC 换点替换指定字段且保留其他成员路由', () => {
  const member = legacyMember();
  const oldMeasurementRoutes = [
    { src: endpoint('测量A'), dst: local('内部测量') },
    { src: endpoint('测量B'), dst: local('内部测量') },
  ];
  const oldSet = { src: local('内部设定'), dst: endpoint('设定') };
  const unrelated = { src: endpoint('其他成员测量'), dst: local('其他成员内部测量') };
  const edited = buildAgcMemberBindingEdits({ member, originalMember: member, selected: { p_meas: [endpoint('新测量')] } });
  assert.deepEqual(Object.keys(edited), [controlMappingFieldKey(field('内部测量', 'input'))]);
  const plan = buildControlMappingPlan({ moduleName: 'AGC', groupName: '控制组1', fields: [field('内部测量', 'input'), field('内部设定', 'output')], baselineRoutes: [...oldMeasurementRoutes, oldSet, unrelated], edited });
  assert.deepEqual(plan.routes, [{ src: endpoint('新测量'), dst: local('内部测量') }]);
  assert.deepEqual(plan.removedRoutes, oldMeasurementRoutes);
});

// 验证可控改为不可控时只解除设定与增量基准旧绑定，不创建隐藏的输出路由。
test('AGC 不可控成员忽略设定选择并解除旧控制映射', () => {
  const originalMember = legacyMember();
  const member = { ...originalMember, controllable: false, p_set: null };
  const edited = buildAgcMemberBindingEdits({ member, originalMember, selected: { p_set: [endpoint('隐藏设定')] } });
  assert.deepEqual(edited, {
    [controlMappingFieldKey(field('内部设定', 'output'))]: [],
    [controlMappingFieldKey(field('内部基准', 'input'))]: [],
  });
  const newMemberEdits = buildAgcMemberBindingEdits({ member, selected: { p_meas: [endpoint('测量')], p_set: [endpoint('隐藏设定')] } });
  assert.deepEqual(newMemberEdits, { [controlMappingFieldKey(field('内部测量', 'input'))]: [endpoint('测量')] });
});

// 验证取消增量基准只清理旧基准映射，保留未明确更换的设定点。
test('AGC 改为绝对值命令时清理废弃的增量基准映射', () => {
  const originalMember = legacyMember();
  const member = { ...originalMember, p_set: { ...originalMember.p_set, mode: 1, base_tag: '' } };
  assert.deepEqual(buildAgcMemberBindingEdits({ member, originalMember, selected: {} }), {
    [controlMappingFieldKey(field('内部基准', 'input'))]: [],
  });
});

// 验证删除成员时原字段仍参与差异计划，只清理该成员的输入、输出和基准路由。
test('AGC 删除成员保留原映射字段以清理其路由', () => {
  const member = legacyMember();
  const removedFields = collectAgcMemberMappingFields([member]);
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
  const otherMember = legacyMember({ member_name: '其他成员', p_meas: signal('其他成员测量'), p_set: null, controllable: false });
  const unrelatedRoutes = [
    { src: endpoint('其他测量'), dst: local('其他成员测量') },
    { src: endpoint('总控目标'), dst: local('组目标') },
    { src: endpoint('其他控制组测量'), dst: { ...local('内部测量'), conn_name: '控制组2' } },
  ];
  const edited = Object.fromEntries(removedFields.map((mappingField) => [controlMappingFieldKey(mappingField), []]));
  const plan = buildControlMappingPlan({
    moduleName: 'AGC', groupName: '控制组1',
    fields: [...collectAgcMemberMappingFields([otherMember]), ...removedFields],
    baselineRoutes: [...memberRoutes, ...unrelatedRoutes], edited,
  });
  assert.deepEqual(plan.routes, []);
  assert.deepEqual(plan.removedRoutes, memberRoutes);
});

// 验证新成员选点在最终保存时生成正确方向路由，失败保留完整计划且只重试路由。
test('AGC 新成员最终保存自动绑定并支持配置保存后的独立路由重试', async () => {
  const signals = buildAgcMemberSignals({ memberName: '新成员', existingMembers: [], changedSignals: { p_meas: true, p_set: true } });
  const member = { ...legacyMember(), ...signals };
  const fields = [field(member.p_meas.tag, 'input'), field(member.p_set.signal.tag, 'output')];
  const selected = { p_meas: [endpoint('实际有功')], p_set: [endpoint('有功命令')] };
  const edited = buildAgcMemberBindingEdits({ member, selected });
  const plan = buildControlMappingPlan({ moduleName: 'AGC', groupName: '控制组1', fields, baselineRoutes: [], edited });
  assert.deepEqual(plan.routes, [
    { src: endpoint('实际有功'), dst: local(member.p_meas.tag) },
    { src: local(member.p_set.signal.tag), dst: endpoint('有功命令') },
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
