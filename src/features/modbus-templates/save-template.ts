import type { ModbusPoint } from '../../adapters/types';
import { normalizeModbusPointEngineeringFields } from '../../pages/ModbusRTU/modbus-decimal.ts';

const signature = (points: ModbusPoint[]): string => JSON.stringify(points
  .map(normalizeModbusPointEngineeringFields)
  .map((point) => ({ ...point, enum_value: point.enum_value ?? null }))
  .map((point) => Object.fromEntries(Object.entries(point).sort(([left], [right]) => left.localeCompare(right))))
  .sort((left, right) => String(left.tag).localeCompare(String(right.tag))));

/** 保存前复读点表，避免页面上的旧快照覆盖其他操作添加或修改的点位。 */
export async function saveTemplatePoints<T>(options: {
  expected: ModbusPoint[];
  additions: ModbusPoint[];
  read: () => Promise<ModbusPoint[]>;
  save: (points: ModbusPoint[]) => Promise<T>;
  onChanged: (points: ModbusPoint[]) => void;
  verifyConnection?: () => Promise<void>;
}): Promise<{ points: ModbusPoint[]; result: T }> {
  if (!options.additions.length) throw new Error('没有可添加的点位');
  await options.verifyConnection?.();
  const latest = (await options.read()).map(normalizeModbusPointEngineeringFields);
  if (signature(latest) !== signature(options.expected)) {
    options.onChanged(latest);
    throw new Error('点表已变化，已刷新当前点表，请重新核对并应用模板');
  }
  const points = [...latest, ...options.additions];
  const result = await options.save(points);
  return { points, result };
}
