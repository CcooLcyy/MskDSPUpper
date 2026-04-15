const MAX_AUTO_DECIMALS = 4;
const ROUNDING_FACTOR = 10 ** MAX_AUTO_DECIMALS;
const SMALL_VALUE_THRESHOLD = 1 / ROUNDING_FACTOR;

function normalizeNegativeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

export function formatAutoRealtimeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }

  const normalizedValue = normalizeNegativeZero(value);
  if (normalizedValue === 0) {
    return '0';
  }

  // Preserve tiny non-zero values instead of rounding them down to 0.
  if (Math.abs(normalizedValue) < SMALL_VALUE_THRESHOLD) {
    return normalizeNegativeZero(Number(normalizedValue.toPrecision(MAX_AUTO_DECIMALS))).toString();
  }

  const roundedValue = normalizeNegativeZero(
    Math.round(normalizedValue * ROUNDING_FACTOR) / ROUNDING_FACTOR,
  );

  return roundedValue
    .toFixed(MAX_AUTO_DECIMALS)
    .replace(/(?:\.0+|(\.\d*?[1-9])0+)$/, '$1');
}
