/**
 * 配置分区裁剪与导出文件名。
 *
 * 与 `src/utils/config-export.ts` 的在线导出语义保持一致（同一固定顺序、
 * 同一 full/partial 判定、同一文件名时间戳格式），但这里是纯函数，
 * 不依赖适配器，因此离线导出可以独立使用与测试。
 */

import type { ConfigExportMetadata, ConfigExportSectionId } from '../../adapters/types.ts';
import { DEFAULT_WORKSPACE_NAME, createEmptyWorkspaceConfig, type WorkspaceConfig } from './types.ts';

/** 分区固定顺序；`.mskcfg` 的 included_sections 与文件名都依赖它。 */
export const ALL_CONFIG_SECTION_IDS: readonly ConfigExportSectionId[] = [
  'iec104',
  'modbus_rtu',
  'modbus_tcp',
  'dlt645',
  'agc',
  'avc',
  'calc',
  'data_bus',
];

/** 去重并按固定顺序输出。 */
export function dedupeConfigSections(sections: readonly ConfigExportSectionId[]): ConfigExportSectionId[] {
  return ALL_CONFIG_SECTION_IDS.filter((section) => sections.includes(section));
}

export function isFullSectionSelection(sections: readonly ConfigExportSectionId[]): boolean {
  return dedupeConfigSections(sections).length === ALL_CONFIG_SECTION_IDS.length;
}

export function buildConfigExportMetadata(sections: readonly ConfigExportSectionId[]): ConfigExportMetadata {
  const includedSections = dedupeConfigSections(sections);

  return {
    scope: isFullSectionSelection(includedSections) ? 'full' : 'partial',
    included_sections: includedSections,
  };
}

/** 未选中的分区清空，选中的分区深拷贝，保证导出结果与工作区互相独立。 */
export function scopeWorkspaceConfig(
  config: WorkspaceConfig,
  sections: readonly ConfigExportSectionId[],
): WorkspaceConfig {
  const included = new Set(dedupeConfigSections(sections));
  const empty = createEmptyWorkspaceConfig();

  return {
    iec104: included.has('iec104') ? clone(config.iec104) : empty.iec104,
    modbus_rtu: included.has('modbus_rtu') ? clone(config.modbus_rtu) : empty.modbus_rtu,
    modbus_tcp: included.has('modbus_tcp') ? clone(config.modbus_tcp) : empty.modbus_tcp,
    dlt645: included.has('dlt645') ? clone(config.dlt645) : empty.dlt645,
    agc: included.has('agc') ? clone(config.agc) : empty.agc,
    avc: included.has('avc') ? clone(config.avc) : empty.avc,
    calc: included.has('calc') ? clone(config.calc) : empty.calc,
    data_bus: included.has('data_bus') ? clone(config.data_bus) : empty.data_bus,
  };
}

/** 工作区导出文件名：`<工作区名>[-分区标识]-YYYYMMDD-HHMMSS.mskcfg`。 */
export function buildWorkspaceExportFileName(
  workspaceName: string,
  exportedAtIso: string,
  sections: readonly ConfigExportSectionId[],
): string {
  const date = new Date(exportedAtIso);
  const timestamp = [
    String(date.getFullYear()),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('') + '-' + [pad2(date.getHours()), pad2(date.getMinutes()), pad2(date.getSeconds())].join('');

  const normalizedSections = dedupeConfigSections(sections);
  const name = sanitizeFileNamePart(workspaceName) || DEFAULT_WORKSPACE_NAME;
  const prefix = isFullSectionSelection(normalizedSections)
    ? name
    : `${name}-${normalizedSections.join('-').replaceAll('_', '-')}`;

  return `${prefix}-${timestamp}.mskcfg`;
}

export function ensureMskcfgExtension(filePath: string): string {
  return /\.mskcfg$/i.test(filePath) ? filePath : `${filePath}.mskcfg`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function sanitizeFileNamePart(value: string): string {
  // 控制字符逐字符替换，避免使用带控制字符的正则（no-control-regex）。
  const printable = Array.from(value)
    .map((char) => (char.charCodeAt(0) < 0x20 ? '-' : char))
    .join('');

  return printable
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-\s]+/, '')
    .replace(/[-\s]+$/, '');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
