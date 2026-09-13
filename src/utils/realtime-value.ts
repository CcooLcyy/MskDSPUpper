const MAX_AUTO_DECIMALS = 2;

const DECIMAL_TEXT_PATTERN = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?)(\d+))?$/;
const MAX_DISPLAY_EXPONENT = 100000n;

function normalizeNegativeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

export function formatAutoRealtimeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }

  const normalizedValue = normalizeNegativeZero(value);
  return formatDecimalDisplay(String(normalizedValue), MAX_AUTO_DECIMALS);
}

/**
 * 将十进制文本格式化为只读展示值。该函数只用于界面显示，不得用于配置保存或下发。
 * 使用 BigInt 舍入，避免 Decimal 文本先转换为 JavaScript number 后丢失精度。
 */
export function formatDecimalDisplay(value: string, fractionDigits = MAX_AUTO_DECIMALS): string {
  if (fractionDigits < 0 || !Number.isSafeInteger(fractionDigits) || typeof value !== 'string') {
    return value;
  }

  const match = DECIMAL_TEXT_PATTERN.exec(value);
  if (!match) {
    return value;
  }

  const sign = match[1] === '-' ? '-' : '';
  const integerPart = match[2] ?? '';
  const fractionalPart = match[3] ?? match[4] ?? '';
  const exponentMagnitude = BigInt((match[6] ?? '0').replace(/^0+/, '') || '0');
  if (exponentMagnitude > MAX_DISPLAY_EXPONENT) {
    return value;
  }
  const exponent = match[5] === '-' ? -exponentMagnitude : exponentMagnitude;
  const digits = `${integerPart}${fractionalPart}`;
  const coefficient = BigInt(digits || '0');
  const decimalPower = BigInt(integerPart.length) + exponent - BigInt(digits.length) + BigInt(fractionDigits);
  let scaledInteger: bigint;
  if (decimalPower >= 0n) {
    scaledInteger = coefficient * (10n ** decimalPower);
  } else {
    const divisor = 10n ** (-decimalPower);
    let quotient = coefficient / divisor;
    const remainder = coefficient % divisor;
    if (remainder * 2n >= divisor) {
      quotient += 1n;
    }
    scaledInteger = quotient;
  }

  const scale = 10n ** BigInt(fractionDigits);
  const integerText = (scaledInteger / scale).toString();
  const fractionText = fractionDigits === 0
    ? ''
    : (scaledInteger % scale).toString().padStart(fractionDigits, '0');
  const isZero = scaledInteger === 0n;
  const unsignedText = fractionDigits === 0 ? integerText : `${integerText}.${fractionText}`;
  return isZero ? unsignedText : `${sign}${unsignedText}`;
}
