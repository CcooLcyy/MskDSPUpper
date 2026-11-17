import type { Iec104Point } from '../../adapters';
import {
  DEFAULT_IEC104_ENGINEERING_DECIMALS,
  createIec104EngineeringFieldPatch,
  createIec104EngineeringFields,
  getIec104DecimalTextError,
  type Iec104EngineeringField,
} from './decimal-input.ts';
import { canUseIec104FixedValue, getIec104FixedValueError } from './fixed-value.ts';
import {
  getIoaCategoryRange,
  getPointBusinessTypeByIoa,
  type IoaBusinessCategoryKey,
} from './ioa-category.ts';
import { DEFAULT_REMOTE_CONTROL_FIELDS, isRemoteControlBusinessType, normalizeRemoteControlFields } from './remote-control.ts';

export const POINT_TYPE_FLOAT = 1;
export const POINT_TYPE_SINGLE = 2;
export const POINT_TYPE_LABELS: Record<number, string> = {
  [POINT_TYPE_FLOAT]: 'FLOAT (短浮点值)',
  [POINT_TYPE_SINGLE]: 'SINGLE (单点值)',
};

export type Iec104BatchEdit = Partial<Record<Iec104EngineeringField, string>> & {
  ioaCategory?: IoaBusinessCategoryKey;
  businessType?: number;
  pointType?: number;
  remoteControlType?: number;
  commandExecutionMode?: number;
  fixedValueEnabled?: boolean;
  fixedValue?: string;
};

export const BATCH_ENGINEERING_FIELDS = [
  { key: 'scale', label: 'Scale (倍率)' },
  { key: 'offset', label: 'Offset (偏移)' },
  { key: 'deadband', label: 'Deadband (死区)' },
] as const;

const defaultEngineeringFields = createIec104EngineeringFields(DEFAULT_IEC104_ENGINEERING_DECIMALS);

function planIoaChanges(points: readonly Iec104Point[], selected: ReadonlySet<string>, category?: IoaBusinessCategoryKey) {
  const changes = new Map<string, number>();
  const range = category && getIoaCategoryRange(category);
  if (!range) return { changes };

  // 目标地址段内的点位保留原地址。先接续已有地址，再填补空号。
  const occupied = new Set<number>();
  const moving: Iec104Point[] = [];
  let lastUsed = range.start - 1;
  for (const point of points) {
    if (point.ioa >= range.start && point.ioa <= range.end) {
      occupied.add(point.ioa);
      lastUsed = Math.max(lastUsed, point.ioa);
    } else if (selected.has(point.tag)) {
      moving.push(point);
    }
  }
  if (moving.length > range.end - range.start + 1 - occupied.size) {
    return { changes, error: `目标 IOA 地址段没有足够的空闲地址，无法迁移 ${moving.length} 个点位` };
  }
  let next = lastUsed + 1;
  for (const point of moving) {
    if (next > range.end) next = range.start;
    while (occupied.has(next)) next += 1;
    changes.set(point.tag, next);
    occupied.add(next);
    next += 1;
  }
  return { changes };
}

export function planIec104BatchEdit(
  points: readonly Iec104Point[],
  selected: ReadonlySet<string>,
  patch: Iec104BatchEdit,
  slaveStation: boolean,
) {
  const { changes, error: ioaError } = planIoaChanges(points, selected, patch.ioaCategory);
  const issues: string[] = ioaError ? [ioaError] : [];
  const engineeringPatch: Partial<Iec104Point> = {};
  for (const { key, label } of BATCH_ENGINEERING_FIELDS) {
    const value = patch[key];
    if (value === undefined) continue;
    const error = getIec104DecimalTextError(value, label);
    if (error) issues.push(error);
    else Object.assign(engineeringPatch, createIec104EngineeringFieldPatch(key, value));
  }
  const fixedValueError = patch.fixedValue === undefined
    ? undefined : getIec104DecimalTextError(patch.fixedValue, '固定报文数值');
  if (fixedValueError) issues.push(fixedValueError);
  const fixedValue = patch.fixedValue === undefined || fixedValueError ? undefined : Number(patch.fixedValue);

  const ioaChanges: { tag: string; before: number; after: number }[] = [];
  let changedCount = 0;
  let remoteControlCount = 0;
  let floatCount = 0;
  let fixedValueCount = 0;
  let singleFixedValueCount = 0;
  let releasedFixedValueCount = 0;
  let businessTypeChangedCount = 0;
  const fixedValueErrors = new Map<string, { firstTag: string; count: number }>();
  const newPoints = points.map((point) => {
    if (!selected.has(point.tag)) return point;

    const ioa = changes.get(point.tag) ?? point.ioa;
    if (ioa !== point.ioa) ioaChanges.push({ tag: point.tag, before: point.ioa, after: ioa });
    const previousBusinessType = point.business_type || getPointBusinessTypeByIoa(point.ioa);
    // 迁址保留已确定的业务类型；未分类的点仍可按新地址推导。
    const businessType = patch.businessType ?? (ioa !== point.ioa ? previousBusinessType : point.business_type);
    const effectiveBusinessType = businessType || getPointBusinessTypeByIoa(ioa);
    if (effectiveBusinessType !== previousBusinessType) businessTypeChangedCount += 1;
    const pointType = patch.pointType ?? point.point_type;
    let next: Iec104Point = { ...point, ioa, business_type: businessType, point_type: pointType };
    if (pointType !== point.point_type) Object.assign(next, defaultEngineeringFields);
    if (pointType === POINT_TYPE_FLOAT) {
      floatCount += 1;
      Object.assign(next, engineeringPatch);
    }

    if (isRemoteControlBusinessType(effectiveBusinessType)) {
      remoteControlCount += 1;
      if (!isRemoteControlBusinessType(previousBusinessType)) next = normalizeRemoteControlFields(next);
      if (patch.remoteControlType !== undefined) next.remote_control_type = patch.remoteControlType;
      if (patch.commandExecutionMode !== undefined) next.command_execution_mode = patch.commandExecutionMode;
    } else if (isRemoteControlBusinessType(previousBusinessType)) {
      Object.assign(next, DEFAULT_REMOTE_CONTROL_FIELDS);
    }

    const canUseFixedValue = canUseIec104FixedValue(next, slaveStation);
    if (canUseFixedValue) {
      fixedValueCount += 1;
      if (pointType === POINT_TYPE_SINGLE) singleFixedValueCount += 1;
      if (patch.fixedValueEnabled !== undefined) next.fixed_value_enabled = patch.fixedValueEnabled;
      if (fixedValue !== undefined) next.fixed_value = fixedValue;
      if (patch.fixedValueEnabled === true && next.fixed_value === undefined) next.fixed_value = 0;
      // 显式填写的报文值必须合法，即使此次只保存数值、尚未启用。
      if (!fixedValueError && (patch.fixedValueEnabled === true || fixedValue !== undefined)) {
        const error = pointType === POINT_TYPE_SINGLE && patch.fixedValue !== undefined && !/^[01]$/.test(patch.fixedValue)
          ? '遥信 SINGLE 固定值只允许 0 或 1'
          : getIec104FixedValueError({ ...next, fixed_value_enabled: true });
        if (error) {
          const group = fixedValueErrors.get(error);
          if (group) group.count += 1;
          else fixedValueErrors.set(error, { firstTag: point.tag, count: 1 });
        }
      }
    }
    if (next.fixed_value_enabled && (effectiveBusinessType !== previousBusinessType || pointType !== point.point_type)
      && (!canUseFixedValue
      || (patch.fixedValueEnabled === undefined && patch.fixedValue === undefined && getIec104FixedValueError(next)))) {
      next.fixed_value_enabled = false;
      releasedFixedValueCount += 1;
    }

    if (JSON.stringify(next) === JSON.stringify(point)) return point;
    changedCount += 1;
    return next;
  });

  fixedValueErrors.forEach(({ firstTag, count }, error) => {
    issues.push(`${firstTag}${count > 1 ? ` 等 ${count} 个点位` : ''}：${error}`);
  });
  if (!floatCount && BATCH_ENGINEERING_FIELDS.some(({ key }) => patch[key] !== undefined)) {
    issues.push('没有适用的 FLOAT 点位，请清空工程参数或调整点位类型');
  }
  if (!fixedValueCount && (patch.fixedValueEnabled !== undefined || patch.fixedValue !== undefined)) {
    issues.push('没有可设置固定值的从站遥测或遥信点，请清空固定值配置');
  }
  if (!remoteControlCount && (patch.remoteControlType !== undefined || patch.commandExecutionMode !== undefined)) {
    issues.push('没有适用的遥控点位，请清空遥控配置或调整业务类型');
  }

  return {
    newPoints, issues, ioaChanges, changedCount, floatCount, remoteControlCount,
    fixedValueCount, singleFixedValueCount, releasedFixedValueCount, businessTypeChangedCount,
  };
}
