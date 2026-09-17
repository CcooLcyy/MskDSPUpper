/**
 * 离线工作区文件的序列化与解析。
 *
 * 解析采用"缺省补齐 + 严格校验版本与配置段"的策略：
 * - 未知版本、缺少配置段、注册表非法一律拒绝并给出中文原因；
 * - 可选字段缺失按空集合补齐，保证旧文件与手工编辑的文件仍可载入。
 */

import type {
  AgcControlProfile,
  AgcExportTask,
  AvcExportTask,
  CalcExportTask,
  ConfigExportMetadata,
  ConfigExportSectionId,
  Dlt645ExportTask,
  Dlt645MqttConfig,
  Iec104ExportTask,
  ModbusMqttConfig,
  ModbusRtuExportTask,
  ModbusTcpExportTask,
  StableDataBusConnection,
  StableDataBusConnTags,
  StableDataBusRoute,
} from '../../adapters/types.ts';
import { DEFAULT_FIRST_CONN_ID } from './registry.ts';
import {
  DEFAULT_WORKSPACE_NAME,
  WORKSPACE_FILE_EXTENSION,
  WORKSPACE_SCHEMA_VERSION,
  createEmptyWorkspaceConfig,
  type OfflineWorkspace,
  type WorkspaceBase,
  type WorkspaceConfig,
  type WorkspaceConnIdRegistry,
} from './types.ts';

export function serializeWorkspace(workspace: OfflineWorkspace): string {
  return `${JSON.stringify(workspace, null, 2)}\n`;
}

export function parseWorkspace(raw: string): OfflineWorkspace {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`工作区文件不是合法 JSON: ${formatErrorText(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('工作区文件内容必须是 JSON 对象');
  }

  if (parsed.schema_version !== WORKSPACE_SCHEMA_VERSION) {
    throw new Error(`不支持的工作区文件版本: ${String(parsed.schema_version)}`);
  }

  if (!isRecord(parsed.config)) {
    throw new Error('工作区文件缺少配置数据');
  }

  return {
    schema_version: WORKSPACE_SCHEMA_VERSION,
    workspace_name: normalizeWorkspaceName(parsed.workspace_name),
    created_at: asText(parsed.created_at),
    updated_at: asText(parsed.updated_at),
    base: normalizeBase(parsed.base),
    conn_ids: normalizeConnIdRegistry(parsed.conn_ids),
    config: normalizeConfig(parsed.config),
    agc_control_profiles: asArray<AgcControlProfile>(parsed.agc_control_profiles),
    metadata: normalizeMetadata(parsed.metadata),
  };
}

/** 统一工作区文件名：缺扩展名时补 `.mskwsp`，空名称回退为默认名。 */
export function ensureWorkspaceFileName(name: string): string {
  const trimmed = name.trim() || DEFAULT_WORKSPACE_NAME;
  const suffix = `.${WORKSPACE_FILE_EXTENSION}`;

  return trimmed.toLowerCase().endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
}

function normalizeWorkspaceName(value: unknown): string {
  const text = asText(value).trim();

  return text || DEFAULT_WORKSPACE_NAME;
}

function normalizeBase(value: unknown): WorkspaceBase {
  const record = isRecord(value) ? value : {};

  return {
    source: record.source === 'device-snapshot' ? 'device-snapshot' : 'empty',
    exported_at: asText(record.exported_at),
    included_sections: asArray<ConfigExportSectionId>(record.included_sections),
    conn_tags: asArray<StableDataBusConnTags>(record.conn_tags),
  };
}

function normalizeMetadata(value: unknown): ConfigExportMetadata {
  const record = isRecord(value) ? value : {};

  return {
    scope: record.scope === 'partial' ? 'partial' : 'full',
    included_sections: asArray<ConfigExportSectionId>(record.included_sections),
  };
}

function normalizeConnIdRegistry(value: unknown): WorkspaceConnIdRegistry {
  if (value === undefined || value === null) {
    return { map: {}, next_conn_id: DEFAULT_FIRST_CONN_ID };
  }

  if (!isRecord(value) || !isRecord(value.map)) {
    throw new Error('工作区连接编号注册表不合法');
  }

  const map: Record<string, number> = {};

  for (const [key, entry] of Object.entries(value.map)) {
    if (!Number.isInteger(entry)) {
      throw new Error(`工作区连接编号注册表不合法: ${key}`);
    }

    map[key] = entry as number;
  }

  if (value.next_conn_id !== undefined && !Number.isInteger(value.next_conn_id)) {
    throw new Error('工作区连接编号注册表不合法: next_conn_id');
  }

  return {
    map,
    next_conn_id: typeof value.next_conn_id === 'number' ? value.next_conn_id : DEFAULT_FIRST_CONN_ID,
  };
}

/** 缺失的分区按空集合补齐，已存在的分区原样保留（包括链路内的字段）。 */
function normalizeConfig(value: Record<string, unknown>): WorkspaceConfig {
  const defaults = createEmptyWorkspaceConfig();
  const iec104 = asRecord(value.iec104);
  const modbusRtu = asRecord(value.modbus_rtu);
  const modbusTcp = asRecord(value.modbus_tcp);
  const dlt645 = asRecord(value.dlt645);
  const agc = asRecord(value.agc);
  const avc = asRecord(value.avc);
  const calc = asRecord(value.calc);
  const dataBus = asRecord(value.data_bus);
  const routes = asRecord(dataBus?.routes);

  return {
    iec104: { links: asArray<Iec104ExportTask>(iec104?.links) },
    modbus_rtu: {
      mqtt: asNullable<ModbusMqttConfig>(modbusRtu?.mqtt),
      links: asArray<ModbusRtuExportTask>(modbusRtu?.links),
    },
    modbus_tcp: { links: asArray<ModbusTcpExportTask>(modbusTcp?.links) },
    dlt645: {
      mqtt: asNullable<Dlt645MqttConfig>(dlt645?.mqtt),
      links: asArray<Dlt645ExportTask>(dlt645?.links),
    },
    agc: { groups: asArray<AgcExportTask>(agc?.groups) },
    avc: { groups: asArray<AvcExportTask>(avc?.groups) },
    calc: { groups: asArray<CalcExportTask>(calc?.groups) },
    data_bus: {
      connections: asArray<StableDataBusConnection>(dataBus?.connections),
      conn_tags: asArray<StableDataBusConnTags>(dataBus?.conn_tags),
      routes: {
        replace: true,
        items: routes ? asArray<StableDataBusRoute>(routes.items) : defaults.data_bus.routes.items,
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asNullable<T>(value: unknown): T | null {
  return value === undefined || value === null ? null : (value as T);
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function formatErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
