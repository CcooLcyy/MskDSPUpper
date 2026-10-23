import type { ModbusPoint } from '../../adapters/types';
import { parseTemplateBindings, pointSignature, positiveRevision } from './bindings.ts';
import { normalizeModbusPointEngineeringFields } from '../../pages/ModbusRTU/modbus-decimal.ts';
const signature = (points: ModbusPoint[]): string => JSON.stringify(points.map(normalizeModbusPointEngineeringFields).map(point => ({
  ...point,
  enum_value: point.enum_value ?? null
})).map(point => Object.fromEntries(Object.entries(point).sort(([left], [right]) => left.localeCompare(right)))).sort((left, right) => String(left.tag).localeCompare(String(right.tag))));

/** 保存前复读点表，避免页面上的旧快照覆盖其他操作添加或修改的点位。 */
export async function saveTemplatePoints<T>(options: {
  expected: ModbusPoint[];
  additions: ModbusPoint[];
  read: () => Promise<ModbusPoint[]>;
  save: (points: ModbusPoint[]) => Promise<T>;
  onChanged: (points: ModbusPoint[]) => void;
  verifyConnection?: () => Promise<void>;
}): Promise<{
  points: ModbusPoint[];
  result: T;
}> {
  if (!options.additions.length) throw new Error('没有可添加的点位');
  await options.verifyConnection?.();
  const latest = (await options.read()).map(normalizeModbusPointEngineeringFields);
  if (signature(latest) !== signature(options.expected)) {
    options.onChanged(latest);
    throw new Error('点表已变化，已刷新当前点表，请重新核对并应用模板');
  }
  const points = [...latest, ...options.additions];
  const result = await options.save(points);
  return {
    points,
    result
  };
}

/** 复读现场点表、来源记录及版本，再由下位机CAS原子保存。 */
export async function saveBoundTemplatePoints<T>(options: import('./bindings.ts').TemplateCommit & {
  read: () => Promise<import('../../adapters/types.ts').ModbusPointTable>;
  save: (points: ModbusPoint[], metadata: {
    expected_revision: string;
    template_bindings_json: string;
  }) => Promise<T>;
  verifyConnection?: () => Promise<void>;
}): Promise<{
  points: ModbusPoint[];
  result: T;
}> {
  const expected = options.expected;
  if (!expected.revision || !positiveRevision(expected.revision)) throw Error('当前下位机不支持模板来源记录及并发保护，请先更新下位机');
  const bindingsJson = JSON.stringify(options.bindings);
  parseTemplateBindings(bindingsJson);
  await options.verifyConnection?.();
  const latest = await options.read();
  const effectiveSignature = (points: ModbusPoint[]) => JSON.stringify(points.map(pointSignature).sort());
  if (latest.revision !== expected.revision || (latest.template_bindings_json ?? '') !== (expected.template_bindings_json ?? '') || effectiveSignature(latest.points) !== effectiveSignature(expected.points)) throw Error('设备点表或模板来源已变化，请关闭窗口并重新读取后核对');
  const result = await options.save(options.points, {
    expected_revision: expected.revision,
    template_bindings_json: bindingsJson
  });
  return {
    points: options.points,
    result
  };
}

/** 现场改名只迁移关联目标，保留原应用基线，以便之后识别现场修改。 */
export async function pointRenameSaveOptions(options: {
  expectedPoints: ModbusPoint[];
  oldTag: string;
  newTag: string;
  read: () => Promise<import('../../adapters/types.ts').ModbusPointTable>;
}): Promise<import('../../adapters/types.ts').ModbusPointTableSaveOptions | undefined> {
  if (options.oldTag === options.newTag) return undefined;
  const table = await options.read();
  const signatureOf = (points: ModbusPoint[]) => JSON.stringify(points.map(pointSignature).sort());
  if (signatureOf(table.points) !== signatureOf(options.expectedPoints)) throw Error('现场点表已变化，请重新加载后编辑');
  const bindings = parseTemplateBindings(table.template_bindings_json);
  if (!bindings.applications.some(app => app.mappings.some(mapping => mapping.target_tag === options.oldTag))) return undefined;
  if (!positiveRevision(table.revision)) throw Error('当前下位机不支持模板来源改名，请先更新下位机');
  const updated = {
    ...bindings,
    applications: bindings.applications.map(app => ({
      ...app,
      mappings: app.mappings.map(mapping => mapping.target_tag === options.oldTag ? {
        ...mapping,
        target_tag: options.newTag
      } : mapping)
    }))
  };
  const json = JSON.stringify(updated);
  parseTemplateBindings(json);
  return {
    expected_revision: table.revision,
    template_bindings_json: json
  };
}
