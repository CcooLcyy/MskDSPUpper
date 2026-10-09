import { getPointBusinessTypeByIoa } from './ioa-category.ts';

type FixedValuePoint = {
  ioa?: number;
  point_type?: number;
  business_type?: number;
  fixed_value_enabled?: boolean;
  fixed_value?: number;
};

export const DEFAULT_IEC104_FIXED_VALUE_FIELDS = { fixed_value_enabled: false, fixed_value: 0 };

/** 固定值只覆盖从站遥测/遥信报文，兼容旧点表按 IOA 推导业务类型。 */
export function canUseIec104FixedValue(point: FixedValuePoint, slaveStation: boolean): boolean {
  const businessType = point.business_type || getPointBusinessTypeByIoa(point.ioa);
  return slaveStation && (businessType === 1 || businessType === 2)
    && (point.point_type === 1 || point.point_type === 2);
}

/** 固定值是报文值，不能经过倍率或偏移换算。 */
export function getIec104FixedValueError(point: FixedValuePoint): string | undefined {
  if (!point.fixed_value_enabled) return undefined;
  if (!canUseIec104FixedValue(point, true)) return '仅遥测或遥信上报点允许启用固定值';
  const value = point.fixed_value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return '固定值必须为有限数值';
  if (point.point_type === 2 && value !== 0 && value !== 1) return '遥信 SINGLE 固定值只允许 0 或 1';
  if (point.point_type === 1 && (Math.abs(value) > 3.4028234663852886e38 || !Number.isFinite(Math.fround(value)))) {
    return '固定值超出 IEC104 有限单精度浮点范围';
  }
  return undefined;
}

/** 旧点表补齐缺省值；类型、业务或角色变化时解除非法固定模式，保留用户输入和工程量参数。 */
export function normalizeIec104FixedValueFields<T extends FixedValuePoint>(point: T, slaveStation = true): T & {
  fixed_value_enabled: boolean;
  fixed_value: number;
} {
  const normalized = {
    ...point,
    fixed_value_enabled: point.fixed_value_enabled ?? false,
    fixed_value: point.fixed_value ?? 0,
  };
  if (!canUseIec104FixedValue(normalized, slaveStation) || getIec104FixedValueError(normalized)) {
    normalized.fixed_value_enabled = false;
  }
  return normalized;
}
