import type { Iec61850PointMapping } from '../adapters/types';
import {
  getDecimalTextError,
  toLegacyDecimalNumber,
} from './decimal-input';

export type Iec61850EngineeringField = 'scale' | 'offset' | 'deadband';

export type Iec61850EngineeringDecimalValues = {
  scale: string;
  offset: string;
  deadband: string;
};

export const DEFAULT_IEC61850_ENGINEERING_DECIMALS: Iec61850EngineeringDecimalValues = {
  scale: '1',
  offset: '0',
  deadband: '0',
};

const DECIMAL_FIELD_NAMES: Record<Iec61850EngineeringField, keyof Iec61850PointMapping> = {
  scale: 'scale_decimal',
  offset: 'offset_decimal',
  deadband: 'deadband_decimal',
};

const DECIMAL_FIELD_LABELS: Record<Iec61850EngineeringField, string> = {
  scale: '倍率',
  offset: '偏移',
  deadband: '死区',
};

export const resolveIec61850PointDecimalText = (
  point: Iec61850PointMapping,
  field: Iec61850EngineeringField,
): string => {
  const decimalValue = point[DECIMAL_FIELD_NAMES[field]];
  return typeof decimalValue === 'string' && decimalValue !== ''
    ? decimalValue
    : String(point[field]);
};

export const createIec61850EngineeringFields = (
  values: Iec61850EngineeringDecimalValues,
): Pick<
  Iec61850PointMapping,
  'scale' | 'offset' | 'deadband' | 'scale_decimal' | 'offset_decimal' | 'deadband_decimal'
> => ({
  scale: toLegacyDecimalNumber(values.scale),
  offset: toLegacyDecimalNumber(values.offset),
  deadband: toLegacyDecimalNumber(values.deadband),
  scale_decimal: values.scale,
  offset_decimal: values.offset,
  deadband_decimal: values.deadband,
});

export const createIec61850EngineeringField = (
  field: Iec61850EngineeringField,
  value: string,
): Partial<Iec61850PointMapping> => {
  const legacyValue = toLegacyDecimalNumber(value);
  if (field === 'scale') return { scale: legacyValue, scale_decimal: value };
  if (field === 'offset') return { offset: legacyValue, offset_decimal: value };
  return { deadband: legacyValue, deadband_decimal: value };
};

export const normalizeIec61850PointEngineeringFields = <T extends Iec61850PointMapping>(
  point: T,
): T => ({
  ...point,
  ...createIec61850EngineeringFields({
    scale: resolveIec61850PointDecimalText(point, 'scale'),
    offset: resolveIec61850PointDecimalText(point, 'offset'),
    deadband: resolveIec61850PointDecimalText(point, 'deadband'),
  }),
});

export const getIec61850PointEngineeringError = (
  point: Iec61850PointMapping,
): string | undefined => {
  for (const field of ['scale', 'offset', 'deadband'] as const) {
    const error = getDecimalTextError(
      point[DECIMAL_FIELD_NAMES[field]],
      DECIMAL_FIELD_LABELS[field],
    );
    if (error) return error;
  }
  return undefined;
};
