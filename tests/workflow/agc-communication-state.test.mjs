import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildAgcMemberSignals, buildAgcMemberBindingEdits, collectAgcMemberMappingFields } from '../../src/utils/agc-member-bindings.ts';
import { memberCommunicationState } from '../../src/utils/agc-runtime-overview.ts';
import { normalizeAgcMemberDecimalFields } from '../../src/utils/agc-decimal.ts';
import { deriveConnTags } from '../../src/offline/workspace/derive-tags.ts';
import { mergeControlRuntimeUpdates } from '../../src/utils/control-runtime-values.ts';
import { controlMappingFieldKey } from '../../src/utils/control-mapping-editor.ts';

const signal = (tag) => ({ tag, unit: '', scale: 1, offset: 0, scale_decimal: '1', offset_decimal: '0' });
const member = { member_name: '逆变器', controllable: true, capacity_kw: 100, weight: 1, min_kw: 0, max_kw: 100, p_meas: signal('p'), p_set: null, communication_state: signal('通信输入'), communication_timeout_ms: 30000 };
const point = (value, extra = {}) => ({ value: { type: 'Int', value }, quality: 1, ts_ms: 100000, ...extra });
const stateKey = controlMappingFieldKey({ direction: 'input', tag: '通信输入' });

// 验证通信输入使用独立内部标签、保持原绑定，并正确解除旧路由。
test('通信状态标签与绑定支持创建、保留、清除', () => {
  const created = buildAgcMemberSignals({ memberName: '逆变器', existingMembers: [], communicationEnabled: true, changedSignals: { p_meas: true, p_set: true, communication_state: true } });
  assert.equal(created.communication_state.unit, '');
  assert.equal(created.communication_state.scale_decimal, '1');
  assert.notEqual(created.communication_state.tag, '__communication_state');
  const preserved = buildAgcMemberSignals({ memberName: '改名', originalMember: member, existingMembers: [], changedSignals: { p_meas: false, p_set: false } });
  assert.deepEqual(preserved.communication_state, member.communication_state);
  const endpoint = { module_name: 'ModbusRTU', conn_name: '逆变器1', tag: '__communication_state' };
  assert.deepEqual(buildAgcMemberBindingEdits({ member, selected: { communication_state: [endpoint] } })[stateKey], [endpoint]);
  const cleared = { ...member, communication_state: null, communication_timeout_ms: 0 };
  assert.deepEqual(buildAgcMemberBindingEdits({ member: cleared, originalMember: member, selected: { communication_state: [] } })[stateKey], []);
  assert.ok(collectAgcMemberMappingFields([member]).some(field => field.tag === '通信输入' && field.direction === 'input'));
});

// 验证离线注册与成员归一化不会丢失通信状态配置，旧配置继续不关联。
test('通信状态配置通过离线标签与归一化保留', () => {
  const normalized = normalizeAgcMemberDecimalFields(member);
  assert.deepEqual(normalized.communication_state, member.communication_state);
  assert.equal(normalized.communication_timeout_ms, 30000);
  assert.ok(deriveConnTags({ module: 'AGC', config: { members: [member] } }).includes('通信输入'));
  assert.equal(memberCommunicationState({ controllable: true }, undefined, 101000, false).label, '未关联');
});

// 验证仅新鲜且质量有效的状态值 1 允许参与，异常、停止、缺失和超时均明确退出。
test('通信状态显示不将缓存正常或未知状态判为可参与', () => {
  for (const [value, label] of [[0, '未知'], [1, '通信正常'], [2, '通信异常'], [3, '已停止'], [4, '状态值无效']]) {
    const state = memberCommunicationState(member, point(value), 101000, false);
    assert.equal(state.label, label);
    assert.equal(state.eligible, value === 1);
  }
  assert.equal(memberCommunicationState(member, undefined, 101000, false).eligible, false);
  assert.equal(memberCommunicationState(member, point(1, { quality_flags: 128 }), 101000, false).label, '质量异常');
  assert.equal(memberCommunicationState(member, point(1, { quality_flags: 0 }), 101000, false).eligible, true);
  assert.equal(memberCommunicationState(member, point(1, { quality: 2 }), 101000, false).label, '质量异常');
  assert.equal(memberCommunicationState(member, point(1), 130001, false).label, '心跳超时');
  assert.equal(memberCommunicationState(member, point(1), 99000, false).eligible, false);
  assert.equal(memberCommunicationState(member, point(1), 101000, true).label, '查询异常');
  assert.equal(memberCommunicationState({ ...member, controllable: false }, point(1), 101000, false).eligible, false);
  assert.equal(memberCommunicationState(member, point('1.1'), 101000, false).eligible, false);
});


// 验证源端快照转换为监视缓存时仍保留品质位，避免转换过程误判正常。
test('通信状态监视快照保留品质位', () => {
  const updates = mergeControlRuntimeUpdates([], [{ conn_id: 1, tag: '通信输入', ...point(1, { quality_flags: 16 }) }]);
  assert.equal(updates['通信输入'].quality_flags, 16);
  assert.equal(memberCommunicationState(member, updates['通信输入'], 101000, false).eligible, false);
});


// 验证浏览器开发适配器同样暴露系统状态标签和成员本地通信输入。
test('浏览器开发适配器提供通信状态标签', () => {
  const source = readFileSync(new URL('../../src/adapters/browser.ts', import.meta.url), 'utf8');
  const rtu = source.slice(source.indexOf('  const modbus = [...modbusLinks.values()]'), source.indexOf('  const modbusTcp = [...modbusTcpLinks.values()]'));
  assert.match(rtu, /__communication_state/);
  const agc = source.slice(source.indexOf('  const agc = [...agcGroups.values()]'), source.indexOf('  const avc = [...avcGroups.values()]'));
  assert.match(agc, /collectSignalTag\(member\.communication_state, tags\)/);
});
