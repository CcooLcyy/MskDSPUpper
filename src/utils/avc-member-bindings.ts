import type { AvcMemberConfig, AvcSignalSpec, AvcValueSpec, DcEndpoint } from '../adapters';
import { controlMappingFieldKey } from './control-mapping-editor.ts';
import type { ControlMappingField } from './control-mapping-editor.ts';

export type AvcMemberPointKind = 'q_meas' | 'q_set' | 'base_tag';
export type AvcMemberEndpoints = Partial<Record<AvcMemberPointKind, DcEndpoint[]>>;

/** 成员只使用协议点表已经换算好的工程量，未换点的历史参数保持原样。 */
export function buildAvcMemberSignals(options: {
  memberName: string;
  existingMembers: AvcMemberConfig[];
  originalMember?: AvcMemberConfig;
  groupTags?: string[];
  changedSignals: { q_meas: boolean; q_set: boolean; base_tag?: boolean };
}): { q_meas: AvcSignalSpec; q_set: AvcValueSpec } {
  const occupied = new Set(options.groupTags?.map((tag) => tag.trim()) ?? []);
  for (const member of options.existingMembers) {
    for (const tag of [member.q_meas?.tag, member.q_set?.signal?.tag, member.q_set?.base_tag]) {
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
  const signalFor = (original: AvcSignalSpec | null | undefined, changed: boolean, suffix: string): AvcSignalSpec => {
    const tag = tagFor(original?.tag, suffix);
    if (original && !changed) return { ...original, tag };
    // decimal 扩展保留协议兼容性；历史点通过上面的展开保持全部原始字段。
    const signal = { tag, unit: 'kVar', scale: 1, offset: 0, scale_decimal: '1', offset_decimal: '0' };
    return signal;
  };
  // 先保留原有标签，防止为缺失信号生成的名称占用另一个历史信号。
  for (const tag of [options.originalMember?.q_meas?.tag, options.originalMember?.q_set?.signal?.tag, options.originalMember?.q_set?.base_tag]) {
    if (tag?.trim()) occupied.add(tag.trim());
  }
  const originalSet = options.originalMember?.q_set;
  const preserveBaseConversion = originalSet?.mode === 2 && originalSet.delta_base === 3
    && Boolean(originalSet.base_tag?.trim()) && !options.changedSignals.base_tag;
  const resetSetConversion = Boolean(options.changedSignals.base_tag)
    || (options.changedSignals.q_set && !preserveBaseConversion);
  const q_set: AvcValueSpec = {
    ...originalSet,
    // 换算参数用于 BASE_TAG 输入；仅换设定输出时保留旧基准换算，换新 kVar 基准时恢复恒等换算。
    signal: signalFor(originalSet?.signal, resetSetConversion, '无功功率设定'),
    mode: originalSet?.mode ?? 1,
    delta_base: originalSet?.delta_base ?? 0,
    base_tag: originalSet?.base_tag ?? '',
  };
  if (q_set.mode === 2 && q_set.delta_base === 3) {
    q_set.base_tag = tagFor(q_set.base_tag, '无功增量基准');
  }
  return {
    q_meas: signalFor(options.originalMember?.q_meas, options.changedSignals.q_meas, '无功功率测量'),
    q_set,
  };
}

/** 记录成员的全部本地路由字段，删除成员后仍可用这些字段清理旧映射。 */
export function collectAvcMemberMappingFields(members: AvcMemberConfig[]): ControlMappingField[] {
  const fields: ControlMappingField[] = [];
  for (const member of members) {
    if (member.q_meas?.tag) fields.push({ label: `${member.member_name} 无功测量`, tag: member.q_meas.tag, direction: 'input' });
    if (!member.controllable) continue;
    if (member.q_set?.signal?.tag) fields.push({ label: `${member.member_name} 无功设定`, tag: member.q_set.signal.tag, direction: 'output' });
    if (member.q_set?.mode === 2 && member.q_set.delta_base === 3 && member.q_set.base_tag) {
      fields.push({ label: `${member.member_name} 增量基准`, tag: member.q_set.base_tag, direction: 'input' });
    }
  }
  return fields;
}

/** 只替换明确选择的绑定；关闭控制或增量基准时解除对应旧路由。 */
export function buildAvcMemberBindingEdits(options: {
  member: AvcMemberConfig;
  originalMember?: AvcMemberConfig;
  selected: AvcMemberEndpoints;
}): Record<string, DcEndpoint[]> {
  const edits: Record<string, DcEndpoint[]> = {};
  const nextFields = collectAvcMemberMappingFields([options.member]);
  const nextKeys = new Set(nextFields.map(controlMappingFieldKey));
  for (const field of collectAvcMemberMappingFields(options.originalMember ? [options.originalMember] : [])) {
    const key = controlMappingFieldKey(field);
    if (!nextKeys.has(key)) edits[key] = [];
  }
  const put = (kind: AvcMemberPointKind, tag: string | null | undefined, direction: 'input' | 'output') => {
    const endpoints = options.selected[kind];
    if (!tag || endpoints === undefined) return;
    edits[controlMappingFieldKey({ label: '', tag, direction })] = endpoints.map((endpoint) => ({ ...endpoint }));
  };
  put('q_meas', options.member.q_meas?.tag, 'input');
  if (options.member.controllable) {
    put('q_set', options.member.q_set?.signal?.tag, 'output');
    if (options.member.q_set?.mode === 2 && options.member.q_set.delta_base === 3) {
      put('base_tag', options.member.q_set.base_tag, 'input');
    }
  }
  return edits;
}
