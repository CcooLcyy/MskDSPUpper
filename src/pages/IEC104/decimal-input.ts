import type { Iec104Point } from '../../adapters';
import {
  getDecimalTextError,
  toDecimalInputText,
  toLegacyDecimalNumber,
} from '../../utils/decimal-input';

export { toDecimalInputText, toLegacyDecimalNumber };

export type Iec104EngineeringField = 'scale' | 'offset' | 'deadband';

export type Iec104EngineeringDecimalValues = {
  scale: string;
  offset: string;
  deadband: string;
};

export const DEFAULT_IEC104_ENGINEERING_DECIMALS: Iec104EngineeringDecimalValues = {
  scale: '1',
  offset: '0',
  deadband: '0',
};

export const getIec104DecimalTextError = getDecimalTextError;

export const resolveIec104PointDecimalText = (
  point: Iec104Point,
  field: Iec104EngineeringField,
): string => {
  const decimalValue = field === 'scale'
    ? point.scale_decimal
    : field === 'offset'
      ? point.offset_decimal
      : point.deadband_decimal;
  return decimalValue || String(point[field]);
};

export const createIec104EngineeringFields = (
  values: Iec104EngineeringDecimalValues,
): Pick<
  Iec104Point,
  'scale' | 'offset' | 'deadband' | 'scale_decimal' | 'offset_decimal' | 'deadband_decimal'
> => ({
  scale: toLegacyDecimalNumber(values.scale),
  offset: toLegacyDecimalNumber(values.offset),
  deadband: toLegacyDecimalNumber(values.deadband),
  scale_decimal: values.scale,
  offset_decimal: values.offset,
  deadband_decimal: values.deadband,
});

export const createIec104EngineeringFieldPatch = (
  field: Iec104EngineeringField,
  value: string,
): Partial<Iec104Point> => {
  if (field === 'scale') {
    return { scale: toLegacyDecimalNumber(value), scale_decimal: value };
  }
  if (field === 'offset') {
    return { offset: toLegacyDecimalNumber(value), offset_decimal: value };
  }
  return { deadband: toLegacyDecimalNumber(value), deadband_decimal: value };
};

export const normalizeIec104PointEngineeringFields = <T extends Iec104Point>(point: T): T => ({
  ...point,
  ...createIec104EngineeringFields({
    scale: resolveIec104PointDecimalText(point, 'scale'),
    offset: resolveIec104PointDecimalText(point, 'offset'),
    deadband: resolveIec104PointDecimalText(point, 'deadband'),
  }),
});
