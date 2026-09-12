import type { DcPointValue } from '../adapters';
import { getDecimalTextError } from './decimal-input.ts';

export type EditablePointValueType = 'Bool' | 'Int' | 'Double' | 'Decimal' | 'String';

export const EDITABLE_POINT_VALUE_TYPES: EditablePointValueType[] = [
  'Bool', 'Int', 'Double', 'Decimal', 'String',
];

export const resolveEditablePointValueType = (
  value: DcPointValue | null | undefined,
): EditablePointValueType => {
  if (!value || value.type === 'Bytes') return 'Decimal';
  return value.type;
};

export const parseEditablePointValue = (
  type: EditablePointValueType,
  text: string,
): DcPointValue => {
  if (type === 'Bool') {
    return { type: 'Bool', value: text === 'true' || text === '1' };
  }
  if (type === 'Int') {
    return { type: 'Int', value: Number.parseInt(text, 10) || 0 };
  }
  if (type === 'Double') {
    return { type: 'Double', value: Number.parseFloat(text) || 0 };
  }
  if (type === 'Decimal') {
    const error = getDecimalTextError(text, '十进制命令值');
    if (error) throw new Error(error);
    return { type: 'Decimal', value: text };
  }
  return { type: 'String', value: text };
};
