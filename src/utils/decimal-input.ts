const DECIMAL_TEXT_PATTERN = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?)(\d+))?$/;
const MAX_DECIMAL_INPUT_LENGTH = 4096;
const MAX_DECIMAL_INTEGER_DIGITS = 100n;
const MAX_DECIMAL_EXPONENT = 100000n;

export const toDecimalInputText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
};

export const getDecimalTextError = (value: unknown, label: string): string | undefined => {
  if (typeof value !== 'string' || !value) return `${label} 不能为空`;
  if (value.length > MAX_DECIMAL_INPUT_LENGTH) return `${label} 文本过长`;

  const match = DECIMAL_TEXT_PATTERN.exec(value);
  if (!match) return `${label} 必须是完整十进制数，可使用科学计数法且不能包含空白`;

  const integerPart = match[2] ?? '';
  const fractionalPart = match[3] ?? match[4] ?? '';
  const exponentMagnitudeText = (match[6] ?? '0').replace(/^0+/, '') || '0';
  if (exponentMagnitudeText.length > 6 || BigInt(exponentMagnitudeText) > MAX_DECIMAL_EXPONENT) {
    return `${label} 的科学计数法指数绝对值不能超过 100000`;
  }

  const significantDigits = `${integerPart}${fractionalPart}`.replace(/^0+/, '');
  if (!significantDigits) return undefined;

  const exponentMagnitude = BigInt(exponentMagnitudeText);
  const exponent = match[5] === '-' ? -exponentMagnitude : exponentMagnitude;
  const integerDigits = BigInt(significantDigits.length) + exponent - BigInt(fractionalPart.length);
  if (integerDigits > MAX_DECIMAL_INTEGER_DIGITS) return `${label} 的整数部分最多 100 位`;
  return undefined;
};

export const isDecimalTextZero = (value: string): boolean => {
  const match = DECIMAL_TEXT_PATTERN.exec(value);
  if (!match) return false;
  const digits = `${match[2] ?? ''}${match[3] ?? match[4] ?? ''}`;
  return digits.length > 0 && [...digits].every((digit) => digit === '0');
};

export const toLegacyDecimalNumber = (value: string): number => Number(value);
