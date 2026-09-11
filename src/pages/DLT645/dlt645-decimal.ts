import type { Dlt645Block, Dlt645BlockItem, Dlt645Point } from '../../adapters';
import { toLegacyDecimalNumber } from '../../utils/decimal-input';

export type Dlt645EngineeringField = 'scale' | 'offset' | 'deadband';

export type Dlt645EngineeringDecimalValues = {
  scale: string;
  offset: string;
  deadband: string;
};

export const DEFAULT_DLT645_ENGINEERING_DECIMALS: Dlt645EngineeringDecimalValues = {
  scale: '1',
  offset: '0',
  deadband: '0',
};

type Dlt645EngineeringEntity = Dlt645Point | Dlt645BlockItem;

export const resolveDlt645EngineeringDecimalText = (
  entity: Dlt645EngineeringEntity,
  field: Dlt645EngineeringField,
): string => {
  const decimalValue = field === 'scale'
    ? entity.scale_decimal
    : field === 'offset'
      ? entity.offset_decimal
      : entity.deadband_decimal;
  return decimalValue || String(entity[field]);
};

export const createDlt645EngineeringFields = (
  values: Dlt645EngineeringDecimalValues,
): Pick<
  Dlt645Point,
  'scale' | 'offset' | 'deadband' | 'scale_decimal' | 'offset_decimal' | 'deadband_decimal'
> => ({
  scale: toLegacyDecimalNumber(values.scale),
  offset: toLegacyDecimalNumber(values.offset),
  deadband: toLegacyDecimalNumber(values.deadband),
  scale_decimal: values.scale,
  offset_decimal: values.offset,
  deadband_decimal: values.deadband,
});

export const normalizeDlt645PointEngineeringFields = <T extends Dlt645Point>(point: T): T => ({
  ...point,
  ...createDlt645EngineeringFields({
    scale: resolveDlt645EngineeringDecimalText(point, 'scale'),
    offset: resolveDlt645EngineeringDecimalText(point, 'offset'),
    deadband: resolveDlt645EngineeringDecimalText(point, 'deadband'),
  }),
});

export const normalizeDlt645BlockItemEngineeringFields = <T extends Dlt645BlockItem>(item: T): T => ({
  ...item,
  ...createDlt645EngineeringFields({
    scale: resolveDlt645EngineeringDecimalText(item, 'scale'),
    offset: resolveDlt645EngineeringDecimalText(item, 'offset'),
    deadband: resolveDlt645EngineeringDecimalText(item, 'deadband'),
  }),
});

export const normalizeDlt645Block = (block: Dlt645Block): Dlt645Block => ({
  ...block,
  items: block.items.map(normalizeDlt645BlockItemEngineeringFields),
});
