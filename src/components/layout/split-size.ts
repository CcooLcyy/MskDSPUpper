/** 布局偏好缺失或不可读时保留默认尺寸，避免空值被当成零。 */
export function readSplitSize(
  storage: Pick<Storage, 'getItem'> | undefined,
  storageKey: string | undefined,
  defaultSize: number,
  minSize: number,
  maxSize: number,
): number {
  const clamp = (value: number) => Math.min(Math.max(value, minSize), maxSize);
  if (!storageKey || !storage) return clamp(defaultSize);
  try {
    const raw = storage.getItem(storageKey);
    if (raw === null || !raw.trim()) return clamp(defaultSize);
    const stored = Number(raw);
    return Number.isFinite(stored) ? clamp(stored) : clamp(defaultSize);
  } catch {
    return clamp(defaultSize);
  }
}
