import type {
  Iec104LinkConfig,
  Iec104ManualSimulationPoint,
  Iec104Point,
  Iec104SimulationSnapshot,
} from '../../adapters/types.ts';
import { getPointBusinessTypeByIoa } from './ioa-category.ts';

export interface ManualSimulationDraft extends Iec104Point {
  selected: boolean;
  value: number | boolean | undefined;
}

/** 固定上报独立于临时模拟；这里只列出可使用临时模拟的遥测和遥信。 */
export function canManuallySimulatePoint(point: Iec104Point): boolean {
  const businessType = point.business_type || getPointBusinessTypeByIoa(point.ioa);
  return !point.fixed_value_enabled
    && ((businessType === 1 && point.point_type === 2) || (businessType === 2 && point.point_type === 1));
}

export function buildManualSimulationDraft(
  points: Iec104Point[],
  snapshot?: Iec104SimulationSnapshot | null,
): ManualSimulationDraft[] {
  const values = new Map(snapshot?.points.map((point) => [point.tag, point]));
  return points.filter(canManuallySimulatePoint).sort((a, b) => a.ioa - b.ioa).map((point) => {
    const current = values.get(point.tag);
    const value = current?.point_type !== point.point_type ? undefined
      : point.point_type === 2 ? current.bool_value ?? undefined : current.double_value ?? undefined;
    return { ...point, selected: value !== undefined, value };
  });
}

function validateValue(point: Iec104Point, value: Iec104ManualSimulationPoint): Iec104ManualSimulationPoint {
  if (point.point_type !== value.point_type) throw new Error(`${point.tag} 的模拟类型与点表不一致`);
  if (point.point_type === 2) {
    if (typeof value.bool_value !== 'boolean' || value.double_value != null) {
      throw new Error(`${point.tag} 的遥信模拟值请选择 0 或 1`);
    }
    return { tag: point.tag, point_type: 2, bool_value: value.bool_value };
  }
  if (typeof value.double_value !== 'number' || !Number.isFinite(value.double_value) || value.bool_value != null) {
    throw new Error(`${point.tag} 的遥测模拟值必须填写有限数值`);
  }
  const configuredScale = Number(point.scale_decimal?.trim() || point.scale);
  const offset = Number(point.offset_decimal?.trim() || point.offset);
  if (!Number.isFinite(configuredScale) || !Number.isFinite(offset)) throw new Error(`${point.tag} 的倍率或偏移无效`);
  const raw = (value.double_value - offset) / (configuredScale || 1);
  if (!Number.isFinite(raw) || Math.abs(raw) > 3.4028234663852886e38 || !Number.isFinite(Math.fround(raw))) {
    throw new Error(`${point.tag} 换算后的模拟值超出 IEC104 有限单精度浮点范围`);
  }
  return { tag: point.tag, point_type: 1, double_value: value.double_value };
}

export function buildManualSimulationPoints(rows: ManualSimulationDraft[]): Iec104ManualSimulationPoint[] {
  const selected = rows.filter((row) => row.selected);
  if (selected.length === 0) throw new Error('请至少选择一个点；全部退出模拟请使用“清除模拟值”');
  return selected.map((row) => {
    if (!canManuallySimulatePoint(row)) throw new Error(`${row.tag} 不支持临时模拟`);
    return validateValue(row, row.point_type === 2
      ? { tag: row.tag, point_type: 2, bool_value: row.value as boolean | undefined }
      : { tag: row.tag, point_type: 1, double_value: row.value as number | undefined });
  });
}

/** 浏览器 mock 同样先验证整个请求，成功后调用方才可一次性替换快照。 */
export function buildManualSimulationSnapshot(
  connName: string,
  config: Pick<Iec104LinkConfig, 'station_role' | 'role'> | null | undefined,
  points: Iec104Point[],
  values: Iec104ManualSimulationPoint[],
  tsMs: number,
): Iec104SimulationSnapshot {
  if (!config || !(config.station_role === 2 || (config.station_role === 0 && config.role === 1))) {
    throw new Error('仅 IEC104 从站支持临时模拟');
  }
  if (values.length === 0) throw new Error('请至少选择一个点；全部退出模拟请使用“清除模拟值”');
  const byTag = new Map(points.map((point) => [point.tag, point]));
  const seen = new Set<string>();
  const validated = values.map((value) => {
    if (seen.has(value.tag)) throw new Error(`模拟点 ${value.tag} 重复`);
    seen.add(value.tag);
    const point = byTag.get(value.tag);
    if (!point || !canManuallySimulatePoint(point)) throw new Error(`${value.tag} 不存在或不支持临时模拟`);
    return { ...validateValue(point, value), quality: 0, ts_ms: tsMs };
  });
  return { conn_name: connName, points: validated };
}
