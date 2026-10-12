import type { AgcMemberConfig, AgcSignalSpec, AgcValueSpec, DcEndpoint } from '../adapters';
import { controlMappingFieldKey } from './control-mapping-editor.ts';
import type { ControlMappingField } from './control-mapping-editor.ts';

export type AgcMemberPointKind = 'p_meas' | 'p_set' | 'base_tag';
export type AgcMemberEndpoints = Partial<Record<AgcMemberPointKind, DcEndpoint[]>>;

/** 成员只使用协议点表已经换算好的工程量，未换点的历史参数保持原样。 */
export function buildAgcMemberSignals(options: {
  memberName: string;
  existingMembers: AgcMemberConfig[];
  originalMember?: AgcMemberConfig;
  groupTags?: string[];
  changedSignals: { p_meas: boolean; p_set: boolean; base_tag?: boolean };
}): { p_meas: AgcSignalSpec; p_set: AgcValueSpec } {
  const occupied = new Set(options.groupTags?.map((tag) => tag.trim()) ?? []);
  for (const member of options.existingMembers) {
    for (const tag of [member.p_meas?.tag, member.p_set?.signal?.tag, member.p_set?.base_tag]) {
      if (tag?.trim()) occupied.add(tag.trim());
    }
  }
  const name = options.memberName.trim().replace(/[\\/:\s]+/g, '_') || '成员';
  const tagFor = (original: string | undefined, suffix: string) => {
    if (original?.trim()) {
      occupied.add(original.trim());
      return original.trim();
    }
    const base = `${name}_${suffix}`;
    let tag = base;
    let index = 2;
    while (occupied.has(tag)) tag = `${base}_${index++}`;
    occupied.add(tag);
    return tag;
  };
  const signalFor = (original: AgcSignalSpec | null | undefined, changed: boolean, suffix: string): AgcSignalSpec => {
    const tag = tagFor(original?.tag, suffix);
    if (original && !changed) return { ...original, tag };
    return { tag, unit: 'kW', scale: 1, offset: 0, scale_decimal: '1', offset_decimal: '0' };
  };
  // 先保留原有标签，防止为缺失信号生成的名称占用另一个历史信号。
  for (const tag of [options.originalMember?.p_meas?.tag, options.originalMember?.p_set?.signal?.tag, options.originalMember?.p_set?.base_tag]) {
    if (tag?.trim()) occupied.add(tag.trim());
  }
  const originalSet = options.originalMember?.p_set;
  const preserveBaseConversion = originalSet?.mode === 2 && originalSet.delta_base === 3
    && Boolean(originalSet.base_tag?.trim()) && !options.changedSignals.base_tag;
  const resetSetConversion = Boolean(options.changedSignals.base_tag)
    || (options.changedSignals.p_set && !preserveBaseConversion);
  const p_set: AgcValueSpec = {
    // 换算参数用于 BASE_TAG 输入；仅换设定输出时保留旧基准换算，换新 kW 基准时恢复恒等换算。
    signal: signalFor(originalSet?.signal, resetSetConversion, '有功功率设定'),
    mode: originalSet?.mode ?? 1,
    delta_base: originalSet?.delta_base ?? 0,
    base_tag: originalSet?.base_tag ?? '',
  };
  if (p_set.mode === 2 && p_set.delta_base === 3) {
    p_set.base_tag = tagFor(p_set.base_tag, '有功增量基准');
  }
  return {
    p_meas: signalFor(options.originalMember?.p_meas, options.changedSignals.p_meas, '有功功率测量'),
    p_set,
  };
}

/** 记录成员的全部本地路由字段，删除成员后仍可用这些字段清理旧映射。 */
export function collectAgcMemberMappingFields(members: AgcMemberConfig[]): ControlMappingField[] {
  const fields: ControlMappingField[] = [];
  for (const member of members) {
    if (member.p_meas?.tag) fields.push({ label: `${member.member_name} 有功测量`, tag: member.p_meas.tag, direction: 'input' });
    if (!member.controllable) continue;
    if (member.p_set?.signal?.tag) fields.push({ label: `${member.member_name} 有功设定`, tag: member.p_set.signal.tag, direction: 'output' });
    if (member.p_set?.mode === 2 && member.p_set.delta_base === 3 && member.p_set.base_tag) {
      fields.push({ label: `${member.member_name} 增量基准`, tag: member.p_set.base_tag, direction: 'input' });
    }
  }
  return fields;
}

/** 只替换明确选择的绑定；关闭控制或增量基准时解除对应旧路由。 */
export function buildAgcMemberBindingEdits(options: {
  member: AgcMemberConfig;
  originalMember?: AgcMemberConfig;
  selected: AgcMemberEndpoints;
}): Record<string, DcEndpoint[]> {
  const edits: Record<string, DcEndpoint[]> = {};
  const nextFields = collectAgcMemberMappingFields([options.member]);
  const nextKeys = new Set(nextFields.map(controlMappingFieldKey));
  for (const field of collectAgcMemberMappingFields(options.originalMember ? [options.originalMember] : [])) {
    const key = controlMappingFieldKey(field);
    if (!nextKeys.has(key)) edits[key] = [];
  }
  const put = (kind: AgcMemberPointKind, tag: string | null | undefined, direction: 'input' | 'output') => {
    const endpoints = options.selected[kind];
    if (!tag || endpoints === undefined) return;
    edits[controlMappingFieldKey({ label: '', tag, direction })] = endpoints.map((endpoint) => ({ ...endpoint }));
  };
  put('p_meas', options.member.p_meas?.tag, 'input');
  if (options.member.controllable) {
    put('p_set', options.member.p_set?.signal?.tag, 'output');
    if (options.member.p_set?.mode === 2 && options.member.p_set.delta_base === 3) {
      put('base_tag', options.member.p_set.base_tag, 'input');
    }
  }
  return edits;
}
