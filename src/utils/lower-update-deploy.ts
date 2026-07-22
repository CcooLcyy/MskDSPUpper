export type LowerUpdateImageComparison = 'same' | 'different' | 'unknown';

function normalizeImageId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (!normalized || normalized === '-') {
    return null;
  }

  return normalized;
}

export function compareLowerUpdateImages(
  expectedImageId: string | null | undefined,
  actualImageId: string | null | undefined,
): LowerUpdateImageComparison {
  const expected = normalizeImageId(expectedImageId);
  const actual = normalizeImageId(actualImageId);
  if (!expected || !actual) {
    return 'unknown';
  }

  return expected === actual ? 'same' : 'different';
}
