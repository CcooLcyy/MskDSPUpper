/**
 * 离线工作区文件类型。
 *
 * 工作区的 `config` 段与 `FullConfigExportSnapshot.config` 完全同构，
 * 因此"载入 .mskcfg / 导出 .mskcfg"都不需要额外格式转换。
 */

import type {
  AgcControlProfile,
  ConfigExportMetadata,
  ConfigExportSectionId,
  FullConfigExportSnapshot,
} from '../../adapters/types.ts';

export const WORKSPACE_SCHEMA_VERSION = 1;
export const WORKSPACE_FILE_EXTENSION = 'mskwsp';
export const DEFAULT_WORKSPACE_NAME = '未命名工作区';

export type WorkspaceConfig = FullConfigExportSnapshot['config'];

/** 工作区数据来源：来自设备导出的快照，还是全新建。 */
export type WorkspaceBaseSource = 'device-snapshot' | 'empty';

export interface WorkspaceBase {
  source: WorkspaceBaseSource;
  /** 打底快照的导出时间；新建工作区为空串。 */
  exported_at: string;
  /** 打底快照包含的分区。 */
  included_sections: ConfigExportSectionId[];
}

/** 稳定键(module_name + conn_name) → 本地 conn_id 的注册表。 */
export interface WorkspaceConnIdRegistry {
  map: Record<string, number>;
  next_conn_id: number;
}

export interface OfflineWorkspace {
  schema_version: typeof WORKSPACE_SCHEMA_VERSION;
  workspace_name: string;
  created_at: string;
  updated_at: string;
  base: WorkspaceBase;
  conn_ids: WorkspaceConnIdRegistry;
  config: WorkspaceConfig;
  agc_control_profiles: AgcControlProfile[];
  metadata: ConfigExportMetadata;
}

/** 生成空的分区配置，八个分区全部存在但均为空集合。 */
export function createEmptyWorkspaceConfig(): WorkspaceConfig {
  return {
    iec104: { links: [] },
    modbus_rtu: { mqtt: null, links: [] },
    modbus_tcp: { links: [] },
    dlt645: { mqtt: null, links: [] },
    agc: { groups: [] },
    avc: { groups: [] },
    calc: { groups: [] },
    data_bus: {
      connections: [],
      conn_tags: [],
      routes: { replace: true, items: [] },
    },
  };
}

/**
 * 新建空工作区。
 *
 * `included_sections` 默认为空：空工作区不代表"目标态为空"，
 * 导出时必须由用户显式选择分区，避免误用覆盖模式清空现场配置。
 */
export function createEmptyWorkspace(workspaceName: string, nowIso: string): OfflineWorkspace {
  return {
    schema_version: WORKSPACE_SCHEMA_VERSION,
    workspace_name: workspaceName,
    created_at: nowIso,
    updated_at: nowIso,
    base: { source: 'empty', exported_at: '', included_sections: [] },
    conn_ids: { map: {}, next_conn_id: 1 },
    config: createEmptyWorkspaceConfig(),
    agc_control_profiles: [],
    metadata: { scope: 'full', included_sections: [] },
  };
}
