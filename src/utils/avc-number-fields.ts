/**
 * AVC 接口优先读取 decimal。保留未改数值的历史精度，改值时同步 decimal，
 * 避免展开旧配置后残留的高精度字段覆盖当前编辑值。
 */
export function synchronizeAvcNumberFields<T extends object>(
  next: T,
  original: T | undefined,
  fields: readonly string[],
): T {
  const synchronized = { ...next };
  for (const field of fields) {
    const value: unknown = Reflect.get(next, field);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`AVC 参数 ${field} 必须是有限数值`);
    }
    const decimalField = `${field}_decimal`;
    const decimal: unknown = Reflect.get(next, decimalField);
    const unchanged = original !== undefined && Object.is(value, Reflect.get(original, field));
    if (unchanged && typeof decimal === 'string' && decimal.trim()) continue;
    Reflect.set(synchronized, decimalField, String(value));
  }
  return synchronized;
}
