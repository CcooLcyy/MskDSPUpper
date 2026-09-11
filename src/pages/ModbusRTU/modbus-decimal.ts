import type { ModbusPoint } from '../../adapters';
import { toLegacyDecimalNumber } from '../../utils/decimal-input';

export type ModbusEngineeringField = 'scale' | 'offset' | 'deadband';

export type ModbusEngineeringDecimalValues = {
  scale: string;
  offset: string;
  deadband: string;
};

export const DEFAULT_MODBUS_ENGINEERING_DECIMALS: ModbusEngineeringDecimalValues = {
  scale: '1',
  offset: '0',
  deadband: '0',
};

export const resolveModbusPointDecimalText = (
  point: ModbusPoint,
  field: ModbusEngineeringField,
): string => {
  const decimalValue = field === 'scale'
    ? point.scale_decimal
    : field === 'offset'
      ? point.offset_decimal
      : point.deadband_decimal;
  return decimalValue || String(point[field]);
};

export const createModbusEngineeringFields = (
  values: ModbusEngineeringDecimalValues,
): Pick<
  ModbusPoint,
  'scale' | 'offset' | 'deadband' | 'scale_decimal' | 'offset_decimal' | 'deadband_decimal'
> => ({
  scale: toLegacyDecimalNumber(values.scale),
  offset: toLegacyDecimalNumber(values.offset),
  deadband: toLegacyDecimalNumber(values.deadband),
  scale_decimal: values.scale,
  offset_decimal: values.offset,
  deadband_decimal: values.deadband,
});

export const normalizeModbusPointEngineeringFields = <T extends ModbusPoint>(point: T): T => ({
  ...point,
  ...createModbusEngineeringFields({
    scale: resolveModbusPointDecimalText(point, 'scale'),
    offset: resolveModbusPointDecimalText(point, 'offset'),
    deadband: resolveModbusPointDecimalText(point, 'deadband'),
  }),
});
