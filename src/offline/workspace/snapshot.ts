/**
 * 离线工作区 ⇄ `.mskcfg` 快照转换。
 *
 * 两个方向的转换都是纯函数：
 * - `workspaceToSnapshot`：导出前把工作区裁剪成 `FullConfigExportSnapshot`，
 *   并剥离运行态 `conn_id`（下位机换设备会重新分配，见设计文档 §4.6）；
 * - `snapshotToWorkspace`：载入现场 `.mskcfg` 打底，重建本地连接编号注册表。
 */

import type {
  ConfigExportSectionId,
  FullConfigExportSnapshot,
  StableDataBusEndpoint,
  StableDataBusRoute,
} from '../../adapters/types.ts';
import { createConnIdRegistry, ensureConnectionId } from './registry.ts';
import { buildConfigExportMetadata, dedupeConfigSections, scopeWorkspaceConfig } from './sections.ts';
import type { OfflineWorkspace, WorkspaceConfig, WorkspaceConnIdRegistry } from './types.ts';

const MODULE_IEC104 = 'IEC104';
const MODULE_MODBUS_RTU = 'ModbusRTU';
const MODULE_MODBUS_TCP = 'ModbusTCP';
const MODULE_DLT645 = 'DLT645';
const MODULE_AGC = 'AGC';
const MODULE_AVC = 'AVC';
const MODULE_CALC = 'Calc';
const MODULE_DATA_CENTER = 'DataCenter';

const EXPORTED_AT_SOURCE = 'get_running_module_info';

export interface BuildSnapshotOptions {
  sections?: readonly ConfigExportSectionId[];
  exportedAtIso: string;
  appVersion?: string;
}

export interface SeedWorkspaceOptions {
  nowIso: string;
}

/** 由工作区内容推导需要确保在线的模块清单（供现场导入流程使用）。 */
export function collectWorkspaceModules(config: WorkspaceConfig): string[] {
  const modules = new Set<string>();

  if (config.iec104.links.length > 0) {
    modules.add(MODULE_IEC104);
  }

  if (config.modbus_rtu.links.length > 0 || config.modbus_rtu.mqtt) {
    modules.add(MODULE_MODBUS_RTU);
  }

  if (config.modbus_tcp.links.length > 0) {
    modules.add(MODULE_MODBUS_TCP);
  }

  if (config.dlt645.links.length > 0 || config.dlt645.mqtt) {
    modules.add(MODULE_DLT645);
  }

  if (config.agc.groups.length > 0) {
    modules.add(MODULE_AGC);
  }

  if (config.avc.groups.length > 0) {
    modules.add(MODULE_AVC);
  }

  if (config.calc.groups.length > 0) {
    modules.add(MODULE_CALC);
  }

  if (
    config.data_bus.connections.length > 0
    || config.data_bus.conn_tags.length > 0
    || config.data_bus.routes.items.length > 0
  ) {
    modules.add(MODULE_DATA_CENTER);
  }

  return Array.from(modules).sort();
}

/** 把工作区导出成现场可导入的快照；未选择分区时拒绝生成。 */
export function workspaceToSnapshot(
  workspace: OfflineWorkspace,
  options: BuildSnapshotOptions,
): FullConfigExportSnapshot {
  const sections = dedupeConfigSections(options.sections ?? workspace.metadata.included_sections);

  if (sections.length === 0) {
    throw new Error('至少需要选择一个配置分区');
  }

  const config = stripRuntimeConnIds(scopeWorkspaceConfig(workspace.config, sections));

  return {
    schema_version: 1,
    exported_at: options.exportedAtIso,
    source: {
      ...(options.appVersion ? { app_version: options.appVersion } : {}),
      // 与在线导出一致：完整导出不携带本机 ModuleManager 地址。
      manager_addr: '',
    },
    module_startup: {
      // 该字段在 .mskcfg 协议里是枚举，仅接受这个取值；modules 由工作区内容推导。
      source: EXPORTED_AT_SOURCE,
      modules: collectWorkspaceModules(config),
    },
    config,
    agc_control_profiles: sections.includes('agc') ? clone(workspace.agc_control_profiles) : [],
    metadata: buildConfigExportMetadata(sections),
  };
}

/** 用现场 `.mskcfg` 载入的配置替换工作区内容，并重建本地连接编号。 */
export function snapshotToWorkspace(
  workspace: OfflineWorkspace,
  snapshot: FullConfigExportSnapshot,
  options: SeedWorkspaceOptions,
): OfflineWorkspace {
  const config = clone(snapshot.config);

  return {
    ...workspace,
    updated_at: options.nowIso,
    base: {
      source: 'device-snapshot',
      exported_at: snapshot.exported_at,
      included_sections: [...snapshot.metadata.included_sections],
    },
    conn_ids: rebuildConnIdRegistry(config),
    config,
    agc_control_profiles: clone(snapshot.agc_control_profiles ?? []),
    metadata: {
      scope: snapshot.metadata.scope,
      included_sections: [...snapshot.metadata.included_sections],
    },
  };
}

/** 连接登记顺序固定：先连接注册表，再各协议链路，最后控制/计算分组。 */
function rebuildConnIdRegistry(config: WorkspaceConfig): WorkspaceConnIdRegistry {
  let registry = createConnIdRegistry();

  const register = (moduleName: string, connName: string | null | undefined): void => {
    if (!moduleName || !connName) {
      return;
    }

    registry = ensureConnectionId(registry, moduleName, connName).registry;
  };

  for (const connection of config.data_bus.connections) {
    register(connection.module_name, connection.conn_name);
  }

  for (const task of config.iec104.links) {
    register(MODULE_IEC104, task.link?.config?.conn_name ?? task.point_table?.conn_name);
  }

  for (const task of config.modbus_rtu.links) {
    register(MODULE_MODBUS_RTU, task.link?.config?.conn_name ?? task.point_table?.conn_name);
  }

  for (const task of config.modbus_tcp.links) {
    register(MODULE_MODBUS_TCP, task.link?.config?.conn_name ?? task.point_table?.conn_name);
  }

  for (const task of config.dlt645.links) {
    register(MODULE_DLT645, task.link?.config?.conn_name ?? task.point_table?.conn_name);
  }

  for (const task of config.agc.groups) {
    register(MODULE_AGC, task.upsert?.config?.group_name);
  }

  for (const task of config.avc.groups) {
    register(MODULE_AVC, task.upsert?.config?.group_name);
  }

  for (const task of config.calc.groups) {
    register(MODULE_CALC, task.upsert?.config?.group_name);
  }

  return registry;
}

function stripRuntimeConnIds(config: WorkspaceConfig): WorkspaceConfig {
  return {
    ...config,
    data_bus: {
      connections: clone(config.data_bus.connections),
      conn_tags: clone(config.data_bus.conn_tags),
      routes: {
        replace: true,
        items: config.data_bus.routes.items.map(stripRouteConnId),
      },
    },
  };
}

function stripRouteConnId(route: StableDataBusRoute): StableDataBusRoute {
  return { src: stripEndpointConnId(route.src), dst: stripEndpointConnId(route.dst) };
}

function stripEndpointConnId(endpoint: StableDataBusEndpoint): StableDataBusEndpoint {
  return {
    module_name: endpoint.module_name,
    conn_name: endpoint.conn_name,
    tag: endpoint.tag,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
