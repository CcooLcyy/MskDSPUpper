import type { ModbusPoint, ModbusPointTable } from '../../adapters/types.ts';
import { normalizeModbusPointEngineeringFields } from '../../pages/ModbusRTU/modbus-decimal.ts';
import { getDecimalTextError } from '../../utils/decimal-input.ts';
import { createTemplateFromPoints, isTemplateWritePoint, planTemplateApplication, validateModbusTemplate } from './model.ts';
import type { ModbusTemplate, ModbusTemplatePoint, TemplateApplicationRow } from './model.ts';
export interface TemplateMapping {
  source_point_id: string;
  target_tag: string;
  baseline: ModbusPoint;
  source_revision: string;
  source_snapshot: ModbusTemplatePoint;
}
export interface TemplateApplication {
  application_id: string;
  platform_id: string;
  template_id: string;
  revision: string;
  template_snapshot: ModbusTemplate;
  prefix: string;
  address_base: number;
  /** 初次未选择或来源已迁出的点，区别于随后接受平台删除的点。 */
  excluded_source_ids?: string[];
  mappings: TemplateMapping[];
}
export interface TemplateBindings {
  schema_version: 1;
  applications: TemplateApplication[];
}
export interface TemplateCommit {
  expected: ModbusPointTable;
  points: ModbusPoint[];
  bindings: TemplateBindings;
}
export interface TemplateUpdateRow {
  id: string;
  kind: 'added' | 'modified' | 'deleted' | 'conflict';
  selected: boolean;
  current?: ModbusPoint;
  next?: ModbusPoint;
  source?: ModbusTemplatePoint;
  fields: string[];
  blocked?: string;
}
const stable = (value: unknown): string => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
/** 对齐下位机Decimal20：精确20位小数，半数远离零，避免f64和表示形式造成假冲突。 */
export function decimal20Units(value: string): string {
  const error = getDecimalTextError(value, '工程参数');
  if (error) throw Error(error);
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value)!;
  const fraction = match[3] ?? match[4] ?? '';
  const digits = ((match[2] ?? '') + fraction).replace(/^0+/, '');
  if (!digits) return '0';
  const shift = 20 + Number(match[5] ?? '0') - fraction.length;
  let units: bigint;
  if (shift >= 0) units = BigInt(digits) * 10n ** BigInt(shift);else {
    const cut = digits.length + shift;
    units = cut > 0 ? BigInt(digits.slice(0, cut)) : 0n;
    if (cut >= 0 && digits[cut] >= '5') units += 1n;
  }
  return (match[1] === '-' ? -units : units).toString();
}
export const pointSignature = (point: ModbusPoint) => {
  const normalized = normalizeModbusPointEngineeringFields(point);
  const bool = point.data_type === 1;
  const plainBool = bool && point.bit_index == null && point.enum_value == null;
  const scale = bool ? '100000000000000000000' : decimal20Units(normalized.scale_decimal);
  return stable({
    tag: point.tag,
    function: point.function,
    address: point.address,
    data_type: point.data_type,
    reg_count: plainBool ? 1 : point.reg_count || ([3, 5].includes(point.data_type) ? 2 : 1),
    word_order: plainBool || [2, 4].includes(point.data_type) ? 1 : point.word_order === 0 ? 1 : point.word_order,
    byte_order: plainBool ? 1 : point.byte_order === 0 ? 1 : point.byte_order,
    bit_index: point.bit_index ?? null,
    enum_value: point.enum_value ?? null,
    scale: scale === '0' ? '100000000000000000000' : scale,
    offset: bool ? '0' : decimal20Units(normalized.offset_decimal),
    deadband: bool ? '0' : decimal20Units(normalized.deadband_decimal)
  });
};
export const positiveRevision = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value) && value.length <= 20 && BigInt(value) <= 18446744073709551615n;
const validText = (value: unknown, max = 256): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0');
/** 非法或未来版本来源记录必须阻断模板操作，避免覆盖无法解释的记录。 */
export function parseTemplateBindings(json: string | null | undefined): TemplateBindings {
  if (!json) return {
    schema_version: 1,
    applications: []
  };
  try {
    if (new TextEncoder().encode(json).length > 32 * 1024 * 1024) throw Error('超过32MiB');
    const data = JSON.parse(json) as TemplateBindings;
    if (data.schema_version !== 1 || !Array.isArray(data.applications) || data.applications.length > 1000) throw Error('结构不支持');
    const ids = new Set<string>(),
      tags = new Set<string>();
    let total = 0;
    for (const app of data.applications) {
      if (!validText(app.application_id) || ids.has(app.application_id) || !validText(app.platform_id, 2048) || !validText(app.template_id) || !positiveRevision(app.revision) || typeof app.prefix !== 'string' || app.prefix.length > 256 || ![1, 2].includes(app.address_base) || !Array.isArray(app.mappings)) throw Error('应用记录不合法');
      ids.add(app.application_id);
      if (app.excluded_source_ids !== undefined && (!Array.isArray(app.excluded_source_ids) || app.excluded_source_ids.length > 10000 || app.excluded_source_ids.some(id => !validText(id, 128)) || new Set(app.excluded_source_ids).size !== app.excluded_source_ids.length)) throw Error('初次排除的点位ID不合法');
      validateModbusTemplate(app.template_snapshot);
      const sources = new Set<string>();
      for (const mapping of app.mappings) {
        if (++total > 10000 || !validText(mapping.source_point_id, 128) || sources.has(mapping.source_point_id) || !validText(mapping.target_tag) || !positiveRevision(mapping.source_revision) || !validText(mapping.baseline?.tag) || mapping.source_snapshot?.id !== mapping.source_point_id) throw Error('点位映射不合法或重复');
        if (tags.has(mapping.target_tag)) throw Error(`点位映射重复：标签“${mapping.target_tag}”已关联其他模板应用`);
        sources.add(mapping.source_point_id);
        tags.add(mapping.target_tag);
        validateModbusTemplate({
          ...app.template_snapshot,
          points: [mapping.source_snapshot]
        });
        createTemplateFromPoints({
          id: 'validate',
          name: '校验',
          addressBase: app.address_base,
          points: [mapping.baseline]
        });
      }
    }
    return data;
  } catch (error) {
    throw Error(`模板来源记录无效：${String(error)}`);
  }
}
const recommended = (source: ModbusTemplatePoint) => !isTemplateWritePoint(source) && !source.condition && source.default_selected !== false;
export function createApplication(options: {
  platformId: string;
  templateId: string;
  revision: string;
  template: ModbusTemplate;
  addressBase: number;
  prefix: string;
  selectedIds: string[];
  existingPoints: ModbusPoint[];
  applicationId?: string;
}): {
  application: TemplateApplication;
  points: ModbusPoint[];
} {
  if (!positiveRevision(options.revision)) throw Error('平台模板版本无效');
  const plan = planTemplateApplication(options.template, options);
  const selected = plan.rows.filter(row => row.selected && !row.conflict);
  if (!selected.length) throw Error('没有可应用的点位');
  return {
    points: plan.points,
    application: {
      application_id: options.applicationId ?? crypto.randomUUID(),
      platform_id: options.platformId,
      template_id: options.templateId,
      revision: options.revision,
      template_snapshot: options.template,
      prefix: options.prefix,
      address_base: options.addressBase,
      excluded_source_ids: options.template.points.filter(point => !selected.some(row => row.id === point.id)).map(point => point.id),
      mappings: selected.map(row => ({
        source_point_id: row.id,
        target_tag: row.point.tag,
        baseline: row.point,
        source_revision: options.revision,
        source_snapshot: row.source
      }))
    }
  };
}
export interface TemplateSourceTransfer {
  target_tag: string;
  application_id: string;
  source_point_id: string;
}
/** 仅转移本次重新添加且现场已删除的标签来源，旧应用排除迁出点，防止之后重新认领。 */
export function planTemplateSourceTransfers(bindings: TemplateBindings, current: ModbusPoint[], additions: ModbusPoint[]): {
  bindings: TemplateBindings;
  transfers: TemplateSourceTransfer[];
} {
  const currentTags = new Set(current.map(point => point.tag));
  const selectedTags = new Set<string>();
  for (const point of additions) {
    if (currentTags.has(point.tag)) throw Error(`标签“${point.tag}”与已有点位重复，不能重新添加或迁移来源`);
    if (selectedTags.has(point.tag)) throw Error(`所选点位标签“${point.tag}”重复`);
    selectedTags.add(point.tag);
  }
  const transfers: TemplateSourceTransfer[] = [];
  const applications = bindings.applications.map(app => {
    const moved = app.mappings.filter(mapping => selectedTags.has(mapping.target_tag));
    if (!moved.length) return app;
    const mappedIds = new Set(app.mappings.map(mapping => mapping.source_point_id));
    const excluded = new Set(app.excluded_source_ids ?? app.template_snapshot.points.filter(source => !mappedIds.has(source.id)).map(source => source.id));
    for (const mapping of moved) {
      excluded.add(mapping.source_point_id);
      transfers.push({ target_tag: mapping.target_tag, application_id: app.application_id, source_point_id: mapping.source_point_id });
    }
    return {
      ...app,
      mappings: app.mappings.filter(mapping => !selectedTags.has(mapping.target_tag)),
      excluded_source_ids: [...excluded]
    };
  });
  return { bindings: transfers.length ? { ...bindings, applications } : bindings, transfers };
}
export interface TemplateAdditionRow extends TemplateApplicationRow {
  applied: boolean;
}
/** 补加只处理现场不存在的模板点；已添加点展示现场配置，不参与更新或覆盖。 */
export function planApplicationAdditions(application: TemplateApplication, current: ModbusPoint[], latest: ModbusTemplate, revision: string, addressBase: number, allowHistorical = false, selectedIds?: string[]): TemplateAdditionRow[] {
  if (!positiveRevision(revision)) throw Error('平台模板版本无效');
  if (!allowHistorical && [application.revision, ...application.mappings.map(mapping => mapping.source_revision)].some(applied => BigInt(applied) > BigInt(revision))) throw Error('当前平台或缓存版本旧于已应用版本，请刷新平台目录后再核对，不能以旧缓存回退现场点表');
  if (addressBase !== application.address_base) throw Error('连接地址基准与模板应用记录不一致，请先恢复或核对连接配置');
  const currentByTag = new Map(current.map(point => [point.tag, point]));
  const applied = new Map<string, ModbusPoint>();
  for (const mapping of application.mappings) {
    const point = currentByTag.get(mapping.target_tag);
    if (point) applied.set(mapping.source_point_id, point);
  }
  // 先校验完整模板，再只对可补加点检查现有点及同批选择冲突。
  const candidates = latest.points.length ? planTemplateApplication(latest, { existingPoints: [], addressBase, prefix: application.prefix, selectedIds: [] }).rows : [];
  const missing = latest.points.filter(point => !applied.has(point.id));
  const planned = missing.length ? planTemplateApplication({ ...latest, points: missing }, { existingPoints: current, addressBase, prefix: application.prefix, selectedIds }).rows : [];
  const missingById = new Map(planned.map(row => [row.id, row]));
  return candidates.map(candidate => {
    const point = applied.get(candidate.id);
    return point ? { ...candidate, point, finalTag: point.tag, conflict: null, selected: false, applied: true } : { ...missingById.get(candidate.id)!, applied: false };
  });
}
/** 补加沿用原应用；仅记录本次接受点的来源，不推进整表版本或改写其他点基线。 */
export function applyApplicationAdditions(application: TemplateApplication, current: ModbusPoint[], latest: ModbusTemplate, revision: string, selectedIds: string[], addressBase: number, allowHistorical = false): { application: TemplateApplication; points: ModbusPoint[] } {
  const rows = planApplicationAdditions(application, current, latest, revision, addressBase, allowHistorical, selectedIds);
  if (!selectedIds.length) throw Error('请选择需要添加的点位');
  const chosenIds = new Set(selectedIds);
  if (chosenIds.size !== selectedIds.length || selectedIds.some(id => !rows.some(row => row.id === id))) throw Error('所选点位不存在或包含无效重复选择');
  const chosen = rows.filter(row => chosenIds.has(row.id));
  if (chosen.some(row => row.applied)) throw Error('所选点位已添加，不能重复添加');
  if (chosen.some(row => row.conflict)) throw Error('所选点位存在标签或地址冲突，请核对后重试');
  // 同标签旧来源已无现场点时，补加应迁移来源，避免一份记录内重复认领标签。
  const moved = application.mappings.filter(mapping => chosen.some(row => row.point.tag === mapping.target_tag && row.id !== mapping.source_point_id));
  const mappings = application.mappings.filter(mapping => !moved.includes(mapping));
  for (const row of chosen) {
    const mapping: TemplateMapping = { source_point_id: row.id, target_tag: row.point.tag, baseline: row.point, source_revision: revision, source_snapshot: row.source };
    const index = mappings.findIndex(previous => previous.source_point_id === row.id);
    if (index < 0) mappings.push(mapping);else mappings[index] = mapping;
  }
  const previousIds = new Set(application.mappings.map(mapping => mapping.source_point_id));
  const excluded = application.excluded_source_ids ?? application.template_snapshot.points.filter(source => !previousIds.has(source.id)).map(source => source.id);
  return {
    points: [...current, ...chosen.map(row => row.point)],
    application: { ...application, mappings, excluded_source_ids: [...new Set([...excluded, ...moved.map(mapping => mapping.source_point_id)])].filter(id => !chosenIds.has(id)) }
  };
}
export function planApplicationUpdate(application: TemplateApplication, current: ModbusPoint[], latest: ModbusTemplate, revision: string, addressBase: number, allowHistorical = false): TemplateUpdateRow[] {
  if (!positiveRevision(revision)) throw Error('平台模板版本无效');
  if (!allowHistorical && [application.revision, ...application.mappings.map(mapping => mapping.source_revision)].some(applied => BigInt(applied) > BigInt(revision))) throw Error('当前平台或缓存版本旧于已应用版本，请刷新平台目录后再核对，不能以旧缓存回退现场点表');
  if (addressBase !== application.address_base) throw Error('连接地址基准与模板应用记录不一致，请先恢复或核对连接配置');
  const mappings = new Map(application.mappings.map(item => [item.source_point_id, item]));
  const initiallyExcluded = new Set(application.excluded_source_ids ?? application.template_snapshot.points.filter(source => !mappings.has(source.id)).map(source => source.id));
  const candidates = latest.points.length ? planTemplateApplication(latest, {
    existingPoints: [],
    addressBase,
    prefix: application.prefix,
    selectedIds: []
  }).rows : [];
  const rows: TemplateUpdateRow[] = [];
  for (const candidate of candidates) {
    const mapping = mappings.get(candidate.id);
    const now = mapping ? current.find(point => point.tag === mapping.target_tag) : undefined;
    if (!mapping && initiallyExcluded.has(candidate.id)) continue;
    const sourceChanged = !!mapping && stable(mapping.source_snapshot) !== stable(candidate.source);
    if (mapping && !sourceChanged && pointSignature(mapping.baseline) === pointSignature(candidate.point)) continue;
    const ownExcluded = mapping ? current.filter(point => point.tag !== mapping.target_tag) : current;
    const check = planTemplateApplication({
      ...latest,
      points: [candidate.source]
    }, {
      existingPoints: ownExcluded,
      addressBase,
      prefix: application.prefix,
      selectedIds: [candidate.id]
    }).rows[0];
    const conflict = !!mapping && (!now || pointSignature(now) !== pointSignature(mapping.baseline));
    const fields = mapping ? Object.keys(candidate.point).filter(key => stable(candidate.point[key as keyof ModbusPoint]) !== stable(mapping.baseline[key as keyof ModbusPoint])) : ['新增点位'];
    rows.push({
      id: candidate.id,
      kind: mapping ? conflict ? 'conflict' : 'modified' : 'added',
      selected: !conflict && !check.conflict && recommended(candidate.source),
      current: now,
      next: candidate.point,
      source: candidate.source,
      fields: fields.length ? fields : ['模板说明或适用条件'],
      blocked: check.conflict ?? undefined
    });
  }
  for (const mapping of application.mappings) {
    if (latest.points.some(source => source.id === mapping.source_point_id)) continue;
    const now = current.find(point => point.tag === mapping.target_tag);
    rows.push({
      id: mapping.source_point_id,
      kind: now && pointSignature(now) !== pointSignature(mapping.baseline) ? 'conflict' : 'deleted',
      selected: false,
      current: now,
      fields: ['平台已删除点位']
    });
  }
  return rows;
}
/** 仅推进明确接受点的来源基线；未接受差异继续保留旧基线供下次检查。 */
export function applyApplicationUpdate(application: TemplateApplication, current: ModbusPoint[], latest: ModbusTemplate, revision: string, selectedIds: string[], addressBase: number, allowHistorical = false): {
  application: TemplateApplication;
  points: ModbusPoint[];
} {
  const rows = planApplicationUpdate(application, current, latest, revision, addressBase, allowHistorical);
  if (!rows.length) return {
    application: {
      ...application,
      revision,
      template_snapshot: latest
    },
    points: [...current]
  };
  const chosen = rows.filter(row => selectedIds.includes(row.id));
  if (!chosen.length) throw Error('请选择需要更新的差异');
  if (chosen.some(row => row.blocked)) throw Error('所选点位存在标签或地址冲突，请核对后重试');
  let points = [...current];
  const mappings = [...application.mappings];
  for (const row of chosen) {
    const index = mappings.findIndex(item => item.source_point_id === row.id);
    const previous = mappings[index];
    if (previous) points = points.filter(point => point.tag !== previous.target_tag);
    if (!row.next) {
      if (index >= 0) mappings.splice(index, 1);
      continue;
    }
    points.push(row.next);
    const mapping = {
      source_point_id: row.id,
      target_tag: row.next.tag,
      baseline: row.next,
      source_revision: revision,
      source_snapshot: row.source!
    };
    if (index >= 0) mappings[index] = mapping;else mappings.push(mapping);
  }
  for (const row of chosen.filter(item => item.next)) {
    const other = points.filter(point => point !== row.next);
    const validation = planTemplateApplication({
      ...latest,
      points: [row.source!]
    }, {
      existingPoints: other,
      addressBase,
      prefix: application.prefix,
      selectedIds: [row.id]
    });
    if (validation.rows[0].conflict) throw Error(`更新点位冲突：${validation.rows[0].conflict}`);
  }
  const next = {
    ...application,
    mappings
  };
  const pending = planApplicationUpdate(next, points, latest, revision, addressBase, allowHistorical);
  if (!pending.length) {
    next.revision = revision;
    next.template_snapshot = latest;
  }
  return {
    application: next,
    points
  };
}

export interface TemplateChangeRow extends Omit<TemplateUpdateRow, 'kind'> {
  kind: TemplateUpdateRow['kind'] | 'applied' | 'readded';
}
/** 统一展示补加和平台差异；选择仅用于组合冲突校验，不产生自动勾选。 */
export function planApplicationChanges(application: TemplateApplication, current: ModbusPoint[], latest: ModbusTemplate, revision: string, addressBase: number, allowHistorical = false, selectedIds: string[] = []): TemplateChangeRow[] {
  const updates = planApplicationUpdate(application, current, latest, revision, addressBase, allowHistorical);
  const updateById = new Map(updates.map(row => [row.id, row]));
  const mappings = new Map(application.mappings.map(mapping => [mapping.source_point_id, mapping]));
  const candidates = latest.points.length ? planTemplateApplication(latest, { existingPoints: [], addressBase, prefix: application.prefix, selectedIds: [] }).rows : [];
  const rows: TemplateChangeRow[] = candidates.map(candidate => {
    const mapping = mappings.get(candidate.id);
    const now = mapping ? current.find(point => point.tag === mapping.target_tag) : undefined;
    const update = updateById.get(candidate.id);
    if (now && !update) return { id: candidate.id, kind: 'applied', current: now, next: now, source: candidate.source, selected: false, fields: [] };
    const validation = planTemplateApplication({ ...latest, points: [candidate.source] }, { existingPoints: current.filter(point => point !== now), addressBase, prefix: application.prefix, selectedIds: [candidate.id] }).rows[0];
    return {
      ...update,
      id: candidate.id,
      kind: !now ? mapping ? 'readded' : 'added' : update!.kind,
      current: now,
      next: candidate.point,
      source: candidate.source,
      selected: false,
      fields: update?.fields ?? ['新增点位'],
      blocked: validation.conflict ?? undefined
    };
  });
  rows.push(...updates.filter(row => !row.next).map(row => ({ ...row, selected: false })));
  // 同次接受的更新/删除释放旧点后，统一校验所选新点，避免顺序影响混合操作。
  const chosen = rows.filter(row => selectedIds.includes(row.id) && row.kind !== 'applied');
  const replacedTags = new Set(chosen.map(row => mappings.get(row.id)?.target_tag).filter(tag => tag !== undefined));
  const nextSources = chosen.flatMap(row => row.next && row.source ? [row.source] : []);
  if (nextSources.length) {
    const planned = planTemplateApplication({ ...latest, points: nextSources }, { existingPoints: current.filter(point => !replacedTags.has(point.tag)), addressBase, prefix: application.prefix, selectedIds }).rows;
    for (const validation of planned) rows.find(row => row.id === validation.id)!.blocked = validation.conflict ?? undefined;
  }
  return rows;
}

/** 一次接受增改删；只推进已选择点的基线，保留未选择的现场值和来源。 */
export function applyApplicationChanges(application: TemplateApplication, current: ModbusPoint[], latest: ModbusTemplate, revision: string, selectedIds: string[], addressBase: number, allowHistorical = false): { application: TemplateApplication; points: ModbusPoint[] } {
  const rows = planApplicationChanges(application, current, latest, revision, addressBase, allowHistorical, selectedIds);
  const ids = new Set(selectedIds);
  if (ids.size !== selectedIds.length || selectedIds.some(id => !rows.some(row => row.id === id))) throw Error('所选点位不存在或包含无效重复选择');
  if (!selectedIds.length) {
    if (planApplicationUpdate(application, current, latest, revision, addressBase, allowHistorical).length) throw Error('请选择需要应用的变更');
    return { application: { ...application, revision, template_snapshot: latest }, points: [...current] };
  }
  const chosen = rows.filter(row => ids.has(row.id));
  if (chosen.some(row => row.kind === 'applied')) throw Error('所选点位已添加且没有平台变更，不能重复选择');
  if (chosen.some(row => row.blocked)) throw Error('所选点位存在标签或地址冲突，请核对后重试');
  const replacedTags = new Set(application.mappings.filter(mapping => ids.has(mapping.source_point_id)).map(mapping => mapping.target_tag));
  const points = [...current.filter(point => !replacedTags.has(point.tag)), ...chosen.flatMap(row => row.next ? [row.next] : [])];
  const oldIds = new Set(application.mappings.map(mapping => mapping.source_point_id));
  const excluded = new Set(application.excluded_source_ids ?? application.template_snapshot.points.filter(source => !oldIds.has(source.id)).map(source => source.id));
  // 新源使用现场已删除的旧标签时，同时迁出旧映射，避免一份应用重复认领。
  const transferred = application.mappings.filter(mapping => !ids.has(mapping.source_point_id) && !current.some(point => point.tag === mapping.target_tag) && chosen.some(row => row.next?.tag === mapping.target_tag));
  for (const mapping of transferred) excluded.add(mapping.source_point_id);
  const mappings = application.mappings.filter(mapping => !ids.has(mapping.source_point_id) && !transferred.includes(mapping));
  for (const row of chosen) {
    if (!row.next) continue;
    excluded.delete(row.id);
    mappings.push({ source_point_id: row.id, target_tag: row.next.tag, baseline: row.next, source_revision: revision, source_snapshot: row.source! });
  }
  const next = { ...application, mappings, excluded_source_ids: [...excluded] };
  if (!planApplicationUpdate(next, points, latest, revision, addressBase, allowHistorical).length) {
    next.revision = revision;
    next.template_snapshot = latest;
  }
  return { application: next, points };
}

export interface ConnectionTemplateOptions {
  bindings: TemplateBindings;
  current: ModbusPoint[];
  latest: ModbusTemplate;
  revision: string;
  platformId: string;
  templateId: string;
  addressBase: number;
  allowHistorical?: boolean;
  selectedIds?: string[];
}
interface ConnectionTemplateRow extends TemplateChangeRow {
  application_id?: string;
  source_point_id: string;
}
const connectionApplications = (options: ConnectionTemplateOptions) => options.bindings.applications.filter(app => app.platform_id === options.platformId && app.template_id === options.templateId);
const excludedSources = (app: TemplateApplication): string[] => app.excluded_source_ids ?? app.template_snapshot.points.filter(source => !app.mappings.some(mapping => mapping.source_point_id === source.id)).map(source => source.id);
/** 一个连接统一比较全部历史来源；旧记录仅保留基线用途，不再要求用户选择。 */
export function planConnectionTemplateChanges(options: ConnectionTemplateOptions): { rows: ConnectionTemplateRow[]; acknowledgeOnly: boolean } {
  const { bindings, current, latest, revision, addressBase, allowHistorical, selectedIds = [] } = options;
  if (!positiveRevision(revision)) throw Error('平台模板版本无效');
  validateModbusTemplate(latest);
  const applications = connectionApplications(options);
  const currentByTag = new Map(current.map(point => [point.tag, point]));
  const sourceById = new Map(latest.points.map(point => [point.id, point]));
  const mappedIds = new Set(applications.flatMap(app => app.mappings.map(mapping => mapping.source_point_id)));
  const liveIds = new Set(applications.flatMap(app => app.mappings.filter(mapping => currentByTag.has(mapping.target_tag)).map(mapping => mapping.source_point_id)));
  const rows: ConnectionTemplateRow[] = [];
  for (const app of applications) {
    if (addressBase !== app.address_base) throw Error('连接地址基准与模板应用记录不一致，请先恢复或核对连接配置');
    if (!allowHistorical && [app.revision, ...app.mappings.map(mapping => mapping.source_revision)].some(value => BigInt(value) > BigInt(revision))) throw Error('当前平台或缓存版本旧于已应用版本，请刷新平台目录后再核对，不能以旧缓存回退现场点表');
    for (const mapping of app.mappings) {
      const source = sourceById.get(mapping.source_point_id);
      const now = currentByTag.get(mapping.target_tag);
      const id = JSON.stringify([app.application_id, mapping.source_point_id]);
      if (!source) {
        rows.push({ id, application_id: app.application_id, source_point_id: mapping.source_point_id, kind: now && pointSignature(now) !== pointSignature(mapping.baseline) ? 'conflict' : 'deleted', current: now, selected: false, fields: ['平台已删除点位'] });
        continue;
      }
      // 同源的现场点已由另一条旧记录维护时，不重复补回已删除的历史副本。
      if (!now && liveIds.has(mapping.source_point_id)) continue;
      const candidate = planTemplateApplication({ ...latest, points: [source] }, { existingPoints: [], addressBase, selectedIds: [] }).rows[0].point;
      // 来源标签未改名时保留已有现场标签（包括历史前缀和人工改名）。
      const next = { ...candidate, tag: now && source.tag === mapping.source_snapshot.tag ? mapping.target_tag : candidate.tag };
      const baseline = { ...mapping.baseline, tag: mapping.target_tag };
      const changed = stable(mapping.source_snapshot) !== stable(source) || pointSignature(baseline) !== pointSignature(next);
      const kind = !now ? 'readded' : !changed ? 'applied' : pointSignature(now) !== pointSignature(mapping.baseline) ? 'conflict' : 'modified';
      const fields = Object.keys(next).filter(key => stable(next[key as keyof ModbusPoint]) !== stable(mapping.baseline[key as keyof ModbusPoint]));
      rows.push({ id, application_id: app.application_id, source_point_id: mapping.source_point_id, kind, current: now, next: kind === 'applied' ? now : next, source, selected: false, fields: kind === 'applied' ? [] : fields.length ? fields : ['模板说明或适用条件'] });
    }
  }
  for (const source of latest.points) {
    if (mappedIds.has(source.id)) continue;
    const next = planTemplateApplication({ ...latest, points: [source] }, { existingPoints: [], addressBase, selectedIds: [] }).rows[0].point;
    const stale = bindings.applications.some(app => app.mappings.some(mapping => mapping.target_tag === next.tag)) && !currentByTag.has(next.tag);
    rows.push({ id: JSON.stringify(['', source.id]), source_point_id: source.id, kind: stale ? 'readded' : 'added', next, source, selected: false, fields: ['新增点位'] });
  }
  const chosen = rows.filter(row => selectedIds.includes(row.id) && row.kind !== 'applied');
  const replacedTags = new Set(chosen.flatMap(row => row.current ? [row.current.tag] : []));
  // 每个未选候选独立检查；已选项一次性释放旧点后统一检查，允许跨记录地址交换。
  const validate = (batch: ConnectionTemplateRow[], existing: ModbusPoint[]) => {
    const candidates = batch.filter(row => row.next && row.source);
    if (!candidates.length) return;
    const points = candidates.map((row, index) => ({ ...row.source!, id: `candidate-${index}`, tag: row.next!.tag }));
    if (new Set(points.map(point => point.tag)).size !== points.length) {
      // 历史同源映射可能同时改成同名标签，逐行报冲突以保留可取消的预览。
      candidates.forEach((candidate, index) => {
        const row = planTemplateApplication({ ...latest, points: [points[index]] }, { existingPoints: [...existing, ...candidates.flatMap((other, otherIndex) => otherIndex !== index ? [other.next!] : [])], addressBase, selectedIds: [points[index].id] }).rows[0];
        candidate.blocked = row.conflict ?? undefined;
      });
      return;
    }
    const plan = planTemplateApplication({ ...latest, points }, { existingPoints: existing, addressBase, selectedIds: points.map(point => point.id) });
    plan.rows.forEach((row, index) => { candidates[index].blocked = row.conflict ?? undefined; });
  };
  for (const row of rows.filter(row => row.kind !== 'applied' && !selectedIds.includes(row.id))) validate([row], current.filter(point => point !== row.current));
  validate(chosen, current.filter(point => !replacedTags.has(point.tag)));
  const noPending = rows.every(row => row.kind === 'applied' || !row.application_id && applications.every(app => excludedSources(app).includes(row.source_point_id)));
  return { rows, acknowledgeOnly: !!applications.length && noPending && applications.some(app => app.revision !== revision) };
}

/** 原子构造点位和全部来源；仅接受所选变更，历史映射与未选择基线继续保留。 */
export function applyConnectionTemplateChanges(options: ConnectionTemplateOptions): { bindings: TemplateBindings; points: ModbusPoint[]; transfers: TemplateSourceTransfer[] } {
  const { current, latest, revision, addressBase, selectedIds = [] } = options;
  const plan = planConnectionTemplateChanges(options);
  const ids = new Set(selectedIds);
  if (ids.size !== selectedIds.length || selectedIds.some(id => !plan.rows.some(row => row.id === id))) throw Error('所选点位不存在或包含无效重复选择');
  if (!ids.size && !plan.acknowledgeOnly) throw Error('请选择需要应用的变更');
  const chosen = plan.rows.filter(row => ids.has(row.id));
  if (chosen.some(row => row.kind === 'applied')) throw Error('所选点位已添加且没有平台变更，不能重复选择');
  if (chosen.some(row => row.blocked)) throw Error('所选点位存在标签或地址冲突，请核对后重试');
  const additions = chosen.flatMap(row => row.next && !row.current ? [row.next] : []);
  const transfer = planTemplateSourceTransfers(options.bindings, current, additions);
  const matching = connectionApplications(options);
  let applications: TemplateApplication[] = transfer.bindings.applications.map(app => matching.some(previous => previous.application_id === app.application_id) ? { ...app, mappings: [...app.mappings], excluded_source_ids: [...excludedSources(app)] } : app);
  const pendingAdditions = chosen.filter(row => !row.application_id && row.next);
  let target = applications.find(app => matching.some(previous => previous.application_id === app.application_id) && app.prefix === '');
  if (pendingAdditions.length && !target) {
    target = { application_id: crypto.randomUUID(), platform_id: options.platformId, template_id: options.templateId, revision, template_snapshot: latest, address_base: addressBase, prefix: '', mappings: [], excluded_source_ids: latest.points.map(source => source.id) };
    applications.push(target);
  }
  for (const row of chosen) {
    const app = row.application_id ? applications.find(item => item.application_id === row.application_id)! : target!;
    app.mappings = app.mappings.filter(mapping => mapping.source_point_id !== row.source_point_id);
    if (row.next) {
      app.mappings.push({ source_point_id: row.source_point_id, target_tag: row.next.tag, baseline: row.next, source_revision: revision, source_snapshot: row.source! });
      app.excluded_source_ids = excludedSources(app).filter(id => id !== row.source_point_id);
    }
  }
  const replacedTags = new Set(chosen.flatMap(row => row.current ? [row.current.tag] : []));
  const points = [...current.filter(point => !replacedTags.has(point.tag)), ...chosen.flatMap(row => row.next ? [row.next] : [])];
  applications = applications.map(app => {
    if (!matching.some(previous => previous.application_id === app.application_id)) return app;
    const touched = !ids.size || chosen.some(row => row.application_id === app.application_id || !row.application_id && app === target);
    const pendingOwn = plan.rows.some(row => row.application_id === app.application_id && row.kind !== 'applied' && !ids.has(row.id));
    const pendingNew = plan.rows.some(row => !row.application_id && !ids.has(row.id) && !excludedSources(app).includes(row.source_point_id));
    return touched && !pendingOwn && !pendingNew ? { ...app, revision, template_snapshot: latest } : app;
  });
  const bindings: TemplateBindings = { ...options.bindings, applications };
  parseTemplateBindings(JSON.stringify(bindings));
  console.info('连接模板所选变更已合并历史来源', { templateId: options.templateId, applications: matching.length, count: chosen.length, transfers: transfer.transfers.length });
  return { bindings, points, transfers: transfer.transfers };
}
