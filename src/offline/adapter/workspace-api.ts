/**
 * 离线工作区适配器。
 *
 * 与 `adapters/browser.ts`（浏览器开发模式 mock）不同，这里不是内存假数据：
 * 配置类接口一律读写当前离线工作区文件承载的配置；未覆盖的接口转发真实 Tauri
 * 实现（设置、运行目录、更新包、纵密脚本、`.mskcfg` 文件读写等），
 * 而 IEC61850 与控制编排这类没有下位机就无法成立的操作显式报错。
 *
 * 与在线语义的关键差异：
 * 1. `conn_id` 由本地注册表按 `module_name + conn_name` 稳定分配，跨会话不变、删除不回收；
 * 2. `conn_tags` 以点表/分组派生为准（`deriveConnTags`），不从会话内临时数据推导；
 * 3. 运行态接口一律中性化：链路/分组恒为已停止，控制类接口 no-op，实时数据为空。
 *
 * 协议页保存流程是 `stopLink → 等 state≠2 → 写点表/配置 → startLink`，
 * 因此运行控制类接口必须成功返回而不是抛错，否则离线编辑会整体失败。
 */

import { api as tauriApi } from '../../adapters/tauri.ts';
import type {
  AgcControlProfile,
  AgcDefaultPointInfo,
  AgcExportTask,
  AgcGroupConfig,
  AgcGroupInfo,
  AgcTuningStatus,
  AvcExportTask,
  AvcGroupConfig,
  AvcGroupInfo,
  CalcExportTask,
  CalcGroupConfig,
  CalcGroupInfo,
  CalcItemInfo,
  CalcOperandStatus,
  DataBusThroughputSnapshot,
  DcConnTags,
  DcConnectionInfo,
  DcPointUpdate,
  DcRoute,
  DcSourcePointUpdate,
  Dlt645Block,
  Dlt645BlockItem,
  Dlt645ExportTask,
  Dlt645LinkConfig,
  Dlt645LinkInfo,
  Dlt645MqttConfig,
  Dlt645MqttConfigStatus,
  Dlt645Point,
  Dlt645PointTable,
  Dlt645UpdateConfigResponse,
  Iec104ExportTask,
  Iec104LinkConfig,
  Iec104LinkInfo,
  Iec104Point,
  Iec104PointTable,
  Iec104SimulationSnapshot,
  Iec104SoePage,
  ModbusLinkConfig,
  ModbusLinkInfo,
  ModbusMqttConfig,
  ModbusMqttConfigStatus,
  ModbusPoint,
  ModbusPointTable,
  ModbusRtuExportTask,
  ModbusTcpExportTask,
  ModbusTcpLinkConfig,
  ModbusTcpLinkInfo,
  ModbusUpdateConfigResponse,
  ModuleInfo,
  ModuleRunningInfo,
  StableDataBusEndpoint,
  StableDataBusRoute,
} from '../../adapters/types.ts';
import {
  normalizeAgcControlProfileDecimalFields,
  normalizeAgcGroupConfigDecimalFields,
} from '../../utils/agc-decimal.ts';
import {
  AGC_DEFAULT_POINT_TAGS,
  AVC_DEFAULT_POINT_TAGS,
  deriveConnTags,
  sortTags,
  type DeriveTagsInput,
} from '../workspace/derive-tags.ts';
import {
  CONNECTION_KEY_SEPARATOR,
  ensureConnectionId,
  findConnectionId,
  listConnections,
  removeConnectionId,
  type WorkspaceConnection,
} from '../workspace/registry.ts';
import { getWorkspace, mutateWorkspace } from '../workspace/store.ts';
import type { OfflineWorkspace, WorkspaceConnIdRegistry } from '../workspace/types.ts';
import { unsupported } from './unsupported.ts';

/** 覆盖实现的全部接口名（顺序与 `adapters/tauri.ts` 一致）。 */
export const WORKSPACE_OVERRIDE_METHODS = [
  'setManagerAddr',
  'getModuleInfo',
  'getRunningModuleInfo',
  'startModule',
  'stopModule',
  'iec104UpsertLink',
  'iec104RenameLink',
  'iec104GetLink',
  'iec104ListLinks',
  'iec104DeleteLink',
  'iec104StartLink',
  'iec104StopLink',
  'iec104UpsertPointTable',
  'iec104GetPointTable',
  'iec104SendTimeSync',
  'iec104GetSimulationSnapshot',
  'iec104GenerateSimulationValues',
  'iec104ApplySimulationValues',
  'iec104ClearSimulationValues',
  'iec104QuerySoe',
  'modbusRtuUpdateConfig',
  'modbusRtuGetConfig',
  'modbusRtuUpsertLink',
  'modbusRtuRenameLink',
  'modbusRtuGetLink',
  'modbusRtuListLinks',
  'modbusRtuDeleteLink',
  'modbusRtuStartLink',
  'modbusRtuStopLink',
  'modbusRtuUpsertPointTable',
  'modbusRtuGetPointTable',
  'modbusTcpUpsertLink',
  'modbusTcpRenameLink',
  'modbusTcpGetLink',
  'modbusTcpListLinks',
  'modbusTcpDeleteLink',
  'modbusTcpStartLink',
  'modbusTcpStopLink',
  'modbusTcpUpsertPointTable',
  'modbusTcpGetPointTable',
  'dlt645UpdateConfig',
  'dlt645GetConfig',
  'dlt645UpsertLink',
  'dlt645RenameLink',
  'dlt645GetLink',
  'dlt645ListLinks',
  'dlt645DeleteLink',
  'dlt645StartLink',
  'dlt645StopLink',
  'dlt645UpsertPointTable',
  'dlt645GetPointTable',
  'dcListConnections',
  'dcGetOrCreateConnection',
  'dcGetConnTags',
  'dcUpsertConnTags',
  'dcListRoutes',
  'dcUpsertRoutes',
  'dcDeleteRoutes',
  'dcGetLatest',
  'dcGetSourceLatest',
  'getDataBusThroughputSnapshot',
  'calcUpsertGroup',
  'calcRenameGroup',
  'calcGetGroup',
  'calcListGroups',
  'calcDeleteGroup',
  'calcStartGroup',
  'calcStopGroup',
  'agcUpsertGroup',
  'agcGetGroup',
  'agcListGroups',
  'agcDeleteGroup',
  'agcStartGroup',
  'agcStopGroup',
  'agcStartTuning',
  'agcStopTuning',
  'agcGetTuningStatus',
  'agcGetControlProfile',
  'agcConfirmControlProfile',
  'avcUpsertGroup',
  'avcRenameGroup',
  'avcGetGroup',
  'avcListGroups',
  'avcDeleteGroup',
  'avcStartGroup',
  'avcStopGroup',
  'iec61850ImportScl',
  'iec61850ListModels',
  'iec61850DeleteModel',
  'iec61850UpsertIed',
  'iec61850GetIed',
  'iec61850ListIeds',
  'iec61850DeleteIed',
  'iec61850StartIed',
  'iec61850StopIed',
  'iec61850UpsertPointMappings',
  'iec61850GetPointMappings',
  'iec61850GetRuntimeStatistics',
  'controlOrchestratorUpsertSequence',
  'controlOrchestratorGetSequence',
  'controlOrchestratorListSequences',
  'controlOrchestratorDeleteSequence',
  'controlOrchestratorExecuteSequence',
] as const satisfies readonly (keyof typeof tauriApi)[];

/** 直接转发真实 Tauri 实现的接口名（本地文件与本地能力，不依赖下位机）。 */
export const DELEGATED_API_METHODS = [
  'loadAppSettings',
  'saveAppSetting',
  'migrateLegacyAppSettings',
  'getRuntimePaths',
  'openRuntimeDirectory',
  'clearLowerUpdateCache',
  'listCachedLowerUpdates',
  'getAppVersion',
  'checkAppUpdate',
  'downloadAppUpdate',
  'installAppUpdate',
  'downloadAndInstallAppUpdate',
  'relaunchApp',
  'disposePendingAppUpdate',
  'checkLowerUpdate',
  'downloadLowerUpdate',
  'uploadLowerUpdatePackage',
  'installLowerUpdatePackage',
  'getLowerUpdateRuntimeInfo',
  'getLowerUpdatePassword',
  'clearLowerUpdatePassword',
  'deployVerticalSecurityScript',
  'getVerticalSecurityStatus',
  'saveFullConfigExport',
  'saveVerticalSecurityScript',
  'loadFullConfigExport',
  'listWorkspaces',
  'loadWorkspace',
  'saveWorkspace',
  'deleteWorkspace',
] as const satisfies readonly (keyof typeof tauriApi)[];

/** 显式不支持的接口：离线没有下位机可执行，必须报错而不是静默成功。 */
const UNSUPPORTED_METHODS = [
  'iec61850ImportScl',
  'iec61850ListModels',
  'iec61850DeleteModel',
  'iec61850UpsertIed',
  'iec61850GetIed',
  'iec61850ListIeds',
  'iec61850DeleteIed',
  'iec61850StartIed',
  'iec61850StopIed',
  'iec61850UpsertPointMappings',
  'iec61850GetPointMappings',
  'iec61850GetRuntimeStatistics',
  'controlOrchestratorUpsertSequence',
  'controlOrchestratorGetSequence',
  'controlOrchestratorListSequences',
  'controlOrchestratorDeleteSequence',
  'controlOrchestratorExecuteSequence',
] as const;

type OverrideMethodName = (typeof WORKSPACE_OVERRIDE_METHODS)[number];
type UnsupportedMethodName = (typeof UNSUPPORTED_METHODS)[number];

/** 未覆盖的接口：原样转发真实 Tauri 实现。 */
type DelegatedApi = Omit<typeof tauriApi, OverrideMethodName>;
/** 离线覆盖实现的接口集合，类型上必须与 `WORKSPACE_OVERRIDE_METHODS` 完全一致。 */
type OverriddenApi = Pick<typeof tauriApi, OverrideMethodName>;

/**
 * 工作区持久化结构：`config` 段与 `FullConfigExportSnapshot.config` 同构，
 * 每个链路/分组条目既有导出用的 `link`/`upsert` + `point_table`，
 * 也额外携带本地运行态字段（`conn_id`/`state`/`last_error`）。
 *
 * 注意：`WorkspaceConfig` 里的链路数组类型只声明了导出字段（运行态字段存在于
 * 工作区文件里但未进入类型），因此这里显式补上运行态字段，读写都带上它，
 * 避免出现"声明有 conn_id、实际丢了编号"的半吊子结构。
 */
interface LinkRuntime {
  conn_id: number;
  state: number;
  last_error: string;
}

interface GroupRuntime {
  conn_id: number;
  state: number;
  last_error: string;
}

/** 运行态字段在工作区文件里真实存在，但 `WorkspaceConfig` 的类型只声明了导出字段，故此处合并。 */
type LinkInstance<T> = T & LinkRuntime;
type GroupInstance<T> = T & GroupRuntime;

type Iec104Link = LinkInstance<Iec104ExportTask>;
type ModbusRtuLink = LinkInstance<ModbusRtuExportTask>;
type ModbusTcpLink = LinkInstance<ModbusTcpExportTask>;
type Dlt645Link = LinkInstance<Dlt645ExportTask>;
type AgcGroup = GroupInstance<AgcExportTask>;
type AvcGroup = GroupInstance<AvcExportTask>;
type CalcGroup = GroupInstance<CalcExportTask>;

/** 改名时需要同时更新链路配置与点表 conn_name。 */
interface LinkCarrier {
  link: { config: { conn_name: string } };
  point_table: { conn_name: string };
}

/** 分组条目的分组名。 */
interface GroupCarrier {
  upsert: { config: { group_name: string } };
}

type SyncConnTagsInput = DeriveTagsInput | { module: 'DataCenter'; tags: readonly string[] };

const MODULE_IEC104 = 'IEC104';
const MODULE_MODBUS_RTU = 'ModbusRTU';
const MODULE_MODBUS_TCP = 'ModbusTCP';
const MODULE_DLT645 = 'DLT645';
const MODULE_AGC = 'AGC';
const MODULE_AVC = 'AVC';
const MODULE_CALC = 'Calc';
const MODULE_DATA_CENTER = 'DataCenter';
const MODULE_DEVICE_INFO = 'DeviceInfo';
const MODULE_BOARD_IO = 'BoardIO';

/** 链路/分组在离线模式恒为已停止。 */
const LINK_STATE_STOPPED = 1;
/** IEC104 TCP 会话状态：断开。 */
const IEC104_CONNECTION_STATE_DISCONNECTED = 1;
/** ModbusRTU / DLT645 现场通信状态：未知。 */
const COMMUNICATION_STATE_UNSPECIFIED = 0;

const IEC104_BUSINESS_TYPE_TELEINDICATION = 1;
const IEC104_BUSINESS_TYPE_TELEMETRY = 2;
const IEC104_BUSINESS_TYPE_REMOTE_ADJUST = 3;
const IEC104_BUSINESS_TYPE_REMOTE_CONTROL = 4;
const IEC104_BUSINESS_TYPE_PARAMETER = 5;
const IEC104_REMOTE_CONTROL_TYPE_SINGLE = 1;
const IEC104_COMMAND_EXECUTION_MODE_SELECT_EXECUTE = 2;

/** 聚合运算符（求和/求平均）按 1-based 编号派生 input_N。 */
const CALC_AGGREGATE_OPERATOR_KINDS = [9, 10];

const DEFAULT_AGC_CONTROL_MODE = 1;
const DEFAULT_AGC_PERIOD_SECONDS = 1;
const DEFAULT_AGC_COMMAND_PERIOD_SECONDS = 4;

export function createWorkspaceApi(): typeof tauriApi {
  return {
    ...delegatedApi(),
    ...unsupportedApi(),
    ...workspaceOverrides(),
  };
}

/** 真实 Tauri 实现去掉被覆盖的接口；设置、运行目录、更新包、`.mskcfg` 读写照常可用。 */
function delegatedApi(): DelegatedApi {
  const delegated: Record<string, unknown> = { ...tauriApi };

  for (const method of WORKSPACE_OVERRIDE_METHODS) {
    delete delegated[method];
  }

  return delegated as unknown as DelegatedApi;
}

/** 不支持的接口统一走 `unsupported`，保证错误信息与日志一致。 */
function unsupportedApi(): Pick<typeof tauriApi, UnsupportedMethodName> {
  const handlers = {} as Record<UnsupportedMethodName, () => never>;

  for (const method of UNSUPPORTED_METHODS) {
    handlers[method] = unsupported(method);
  }

  return handlers as unknown as Pick<typeof tauriApi, UnsupportedMethodName>;
}

function workspaceOverrides(): OverriddenApi {
  return {
    setManagerAddr: async (): Promise<void> => {
      console.info('[离线工作区] 已忽略设置 ModuleManager 地址：离线模式不连接下位机');
    },

    getModuleInfo: async (): Promise<ModuleInfo[]> => [],
    getRunningModuleInfo: async (): Promise<ModuleRunningInfo[]> => [],
    startModule: async (): Promise<void> => {},
    stopModule: async (): Promise<void> => {},

    iec104UpsertLink: async (config: Iec104LinkConfig, createOnly: boolean): Promise<Iec104LinkInfo> => {
      mutateWorkspace((workspace) => {
        const entry = upsertLink(workspace, MODULE_IEC104, workspace.config.iec104.links, config.conn_name, createOnly);

        entry.link.config = { ...clone(entry.link.config), ...clone(config) } as typeof config;
        syncConnTags(workspace, MODULE_IEC104, config.conn_name, {
          module: 'IEC104',
          points: entry.point_table.points,
          timeSyncTag: config.time_sync_tag,
        });

        return workspace;
      });

      return requireIec104LinkInfo(config.conn_name);
    },
    iec104RenameLink: async (oldConnName: string, newConnName: string): Promise<Iec104LinkInfo> => {
      renameProtocolLink(MODULE_IEC104, oldConnName, newConnName);

      return requireIec104LinkInfo(newConnName);
    },
    iec104GetLink: async (connName: string): Promise<Iec104LinkInfo> => {
      const link = requireFind(workspaceIec104Links(), MODULE_IEC104, connName);

      return iec104LinkInfo(link, requireConnId(link, MODULE_IEC104, connName));
    },
    iec104ListLinks: async (): Promise<Iec104LinkInfo[]> =>
      workspaceIec104Links().map((link) =>
        iec104LinkInfo(link, requireConnId(link, MODULE_IEC104, link.link.config.conn_name))),
    iec104DeleteLink: async (connName: string): Promise<void> => {
      deleteProtocolLink(MODULE_IEC104, connName);
    },
    iec104StartLink: async (): Promise<void> => {},
    iec104StopLink: async (): Promise<void> => {},
    iec104UpsertPointTable: async (connName: string, points: Iec104Point[], replace: boolean): Promise<void> => {
      upsertIec104PointTable(connName, points, replace);
    },
    iec104GetPointTable: async (connName: string): Promise<Iec104PointTable> =>
      clone(requireFind(workspaceIec104Links(), MODULE_IEC104, connName).point_table),
    iec104SendTimeSync: async (): Promise<void> => {},
    iec104GetSimulationSnapshot: async (connName: string): Promise<Iec104SimulationSnapshot> => ({
      conn_name: connName,
      points: [],
    }),
    // 仿真值是纯运行态数据：离线不生成、不发送、不清理，也不失败。
    iec104GenerateSimulationValues: async (connName: string): Promise<Iec104SimulationSnapshot> => ({
      conn_name: connName,
      points: [],
    }),
    iec104ApplySimulationValues: async (): Promise<void> => {},
    iec104ClearSimulationValues: async (): Promise<void> => {},
    iec104QuerySoe: async (): Promise<Iec104SoePage> => emptySoePage(),

    modbusRtuUpdateConfig: async (mqtt: ModbusMqttConfig): Promise<ModbusUpdateConfigResponse> =>
      updateMqttConfig('modbus_rtu', mqtt),
    modbusRtuGetConfig: async (): Promise<ModbusMqttConfigStatus> => mqttConfigStatus('modbus_rtu'),
    modbusRtuUpsertLink: async (config: ModbusLinkConfig, createOnly: boolean): Promise<ModbusLinkInfo> => {
      mutateWorkspace((workspace) => {
        const entry = upsertLink(
          workspace,
          MODULE_MODBUS_RTU,
          workspace.config.modbus_rtu.links,
          config.conn_name,
          createOnly,
        );

        entry.link.config = { ...clone(entry.link.config), ...clone(config) } as typeof config;
        syncConnTags(workspace, MODULE_MODBUS_RTU, config.conn_name, {
          module: 'ModbusRTU',
          points: entry.point_table.points,
        });

        return workspace;
      });

      return requireModbusRtuLinkInfo(config.conn_name);
    },
    modbusRtuRenameLink: async (oldConnName: string, newConnName: string): Promise<ModbusLinkInfo> => {
      renameProtocolLink(MODULE_MODBUS_RTU, oldConnName, newConnName);

      return requireModbusRtuLinkInfo(newConnName);
    },
    modbusRtuGetLink: async (connName: string): Promise<ModbusLinkInfo> => {
      const link = requireFind(workspaceModbusRtuLinks(), MODULE_MODBUS_RTU, connName);

      return modbusRtuLinkInfo(link, requireConnId(link, MODULE_MODBUS_RTU, connName));
    },
    modbusRtuListLinks: async (): Promise<ModbusLinkInfo[]> =>
      workspaceModbusRtuLinks().map((link) =>
        modbusRtuLinkInfo(link, requireConnId(link, MODULE_MODBUS_RTU, link.link.config.conn_name))),
    modbusRtuDeleteLink: async (connName: string): Promise<void> => {
      deleteProtocolLink(MODULE_MODBUS_RTU, connName);
    },
    modbusRtuStartLink: async (): Promise<void> => {},
    modbusRtuStopLink: async (): Promise<void> => {},
    modbusRtuUpsertPointTable: async (connName: string, points: ModbusPoint[], replace: boolean): Promise<void> => {
      upsertModbusPointTable(MODULE_MODBUS_RTU, connName, points, replace);
    },
    modbusRtuGetPointTable: async (connName: string): Promise<ModbusPointTable> =>
      clone(requireFind(workspaceModbusRtuLinks(), MODULE_MODBUS_RTU, connName).point_table),

    modbusTcpUpsertLink: async (config: ModbusTcpLinkConfig, createOnly: boolean): Promise<ModbusTcpLinkInfo> => {
      mutateWorkspace((workspace) => {
        const entry = upsertLink(
          workspace,
          MODULE_MODBUS_TCP,
          workspace.config.modbus_tcp.links,
          config.conn_name,
          createOnly,
        );

        entry.link.config = { ...clone(entry.link.config), ...clone(config) } as typeof config;
        syncConnTags(workspace, MODULE_MODBUS_TCP, config.conn_name, {
          module: 'ModbusTCP',
          points: entry.point_table.points,
        });

        return workspace;
      });

      return requireModbusTcpLinkInfo(config.conn_name);
    },
    modbusTcpRenameLink: async (oldConnName: string, newConnName: string): Promise<ModbusTcpLinkInfo> => {
      renameProtocolLink(MODULE_MODBUS_TCP, oldConnName, newConnName);

      return requireModbusTcpLinkInfo(newConnName);
    },
    modbusTcpGetLink: async (connName: string): Promise<ModbusTcpLinkInfo> => {
      const link = requireFind(workspaceModbusTcpLinks(), MODULE_MODBUS_TCP, connName);

      return modbusTcpLinkInfo(link, requireConnId(link, MODULE_MODBUS_TCP, connName));
    },
    modbusTcpListLinks: async (): Promise<ModbusTcpLinkInfo[]> =>
      workspaceModbusTcpLinks().map((link) =>
        modbusTcpLinkInfo(link, requireConnId(link, MODULE_MODBUS_TCP, link.link.config.conn_name))),
    modbusTcpDeleteLink: async (connName: string): Promise<void> => {
      deleteProtocolLink(MODULE_MODBUS_TCP, connName);
    },
    modbusTcpStartLink: async (): Promise<void> => {},
    modbusTcpStopLink: async (): Promise<void> => {},
    modbusTcpUpsertPointTable: async (connName: string, points: ModbusPoint[], replace: boolean): Promise<void> => {
      upsertModbusPointTable(MODULE_MODBUS_TCP, connName, points, replace);
    },
    modbusTcpGetPointTable: async (connName: string): Promise<ModbusPointTable> =>
      clone(requireFind(workspaceModbusTcpLinks(), MODULE_MODBUS_TCP, connName).point_table),

    dlt645UpdateConfig: async (mqtt: Dlt645MqttConfig): Promise<Dlt645UpdateConfigResponse> =>
      updateMqttConfig('dlt645', mqtt),
    dlt645GetConfig: async (): Promise<Dlt645MqttConfigStatus> => mqttConfigStatus('dlt645'),
    dlt645UpsertLink: async (config: Dlt645LinkConfig, createOnly: boolean): Promise<Dlt645LinkInfo> => {
      mutateWorkspace((workspace) => {
        const entry = upsertLink(
          workspace,
          MODULE_DLT645,
          workspace.config.dlt645.links,
          config.conn_name,
          createOnly,
        );

        entry.link.config = { ...clone(entry.link.config), ...clone(config) } as typeof config;
        syncConnTags(workspace, MODULE_DLT645, config.conn_name, {
          module: 'DLT645',
          points: entry.point_table.points,
          blocks: entry.point_table.blocks,
        });

        return workspace;
      });

      return requireDlt645LinkInfo(config.conn_name);
    },
    dlt645RenameLink: async (oldConnName: string, newConnName: string): Promise<Dlt645LinkInfo> => {
      renameProtocolLink(MODULE_DLT645, oldConnName, newConnName);

      return requireDlt645LinkInfo(newConnName);
    },
    dlt645GetLink: async (connName: string): Promise<Dlt645LinkInfo> => {
      const link = requireFind(workspaceDlt645Links(), MODULE_DLT645, connName);

      return dlt645LinkInfo(link, requireConnId(link, MODULE_DLT645, connName));
    },
    dlt645ListLinks: async (): Promise<Dlt645LinkInfo[]> =>
      workspaceDlt645Links().map((link) =>
        dlt645LinkInfo(link, requireConnId(link, MODULE_DLT645, link.link.config.conn_name))),
    dlt645DeleteLink: async (connName: string): Promise<void> => {
      deleteProtocolLink(MODULE_DLT645, connName);
    },
    dlt645StartLink: async (): Promise<void> => {},
    dlt645StopLink: async (): Promise<void> => {},
    dlt645UpsertPointTable: async (
      connName: string,
      points: Dlt645Point[],
      blocks: Dlt645Block[],
      replace: boolean,
    ): Promise<void> => {
      upsertDlt645PointTable(connName, points, blocks, replace);
    },
    dlt645GetPointTable: async (connName: string): Promise<Dlt645PointTable> =>
      clone(requireFind(workspaceDlt645Links(), MODULE_DLT645, connName).point_table),

    dcListConnections: async (): Promise<DcConnectionInfo[]> => listWorkspaceConnections(getWorkspace()),
    dcGetOrCreateConnection: async (moduleName: string, connName: string): Promise<DcConnectionInfo> => {
      mutateWorkspace((workspace) => {
        ensureConnection(workspace, moduleName, connName);
        ensureConnectionEntry(workspace, moduleName, connName);

        return workspace;
      });

      return {
        conn_id: requireConnectionId(getWorkspace(), moduleName, connName),
        module_name: moduleName,
        conn_name: connName,
      };
    },
    dcGetConnTags: async (connId: number): Promise<DcConnTags> => ({
      conn_id: connId,
      tags: getRegisteredTags(getWorkspace(), connId),
    }),
    dcUpsertConnTags: async (connId: number, tags: string[], replace: boolean): Promise<void> => {
      upsertConnTags(connId, tags, replace);
    },
    dcListRoutes: async (
      srcConnId: number,
      srcTag: string,
      dstConnId: number,
      dstTag: string,
    ): Promise<DcRoute[]> => listRoutes(srcConnId, srcTag, dstConnId, dstTag),
    dcUpsertRoutes: async (routes: DcRoute[], replace: boolean): Promise<void> => {
      upsertRoutes(routes, replace);
    },
    dcDeleteRoutes: async (routes: DcRoute[]): Promise<void> => {
      deleteRoutes(routes);
    },
    dcGetLatest: async (): Promise<DcPointUpdate[]> => [],
    dcGetSourceLatest: async (): Promise<DcSourcePointUpdate[]> => [],
    getDataBusThroughputSnapshot: async (): Promise<DataBusThroughputSnapshot> => ({
      source: 'unavailable',
      process_start_time_ms: null,
      samples: [],
      current_points_per_second: 0,
      peak_points_per_second: 0,
      updated_at_ms: null,
    }),

    calcUpsertGroup: async (config: CalcGroupConfig, createOnly: boolean): Promise<CalcGroupInfo> => {
      mutateWorkspace((workspace) => {
        const group = upsertGroup(
          workspace,
          MODULE_CALC,
          workspace.config.calc.groups,
          config.group_name,
          createOnly,
        );

        group.upsert.config = normalizeCalcGroupConfig(config);
        syncConnTags(workspace, MODULE_CALC, config.group_name, { module: 'Calc', config: group.upsert.config });

        return workspace;
      });

      return requireCalcGroupInfo(config.group_name);
    },
    calcRenameGroup: async (oldGroupName: string, newGroupName: string): Promise<CalcGroupInfo> => {
      renameControlGroup(MODULE_CALC, oldGroupName, newGroupName);

      return requireCalcGroupInfo(newGroupName);
    },
    calcGetGroup: async (groupName: string): Promise<CalcGroupInfo> => requireCalcGroupInfo(groupName),
    calcListGroups: async (): Promise<CalcGroupInfo[]> =>
      workspaceCalcGroups().map((group) => calcGroupInfo(group)),
    calcDeleteGroup: async (groupName: string): Promise<void> => {
      deleteControlGroup(MODULE_CALC, groupName);
    },
    calcStartGroup: async (): Promise<void> => {},
    calcStopGroup: async (): Promise<void> => {},

    agcUpsertGroup: async (config: AgcGroupConfig, createOnly: boolean): Promise<AgcGroupInfo> => {
      mutateWorkspace((workspace) => {
        const group = upsertGroup(workspace, MODULE_AGC, workspace.config.agc.groups, config.group_name, createOnly);

        group.upsert.config = normalizeAgcGroupConfig(config);
        syncConnTags(workspace, MODULE_AGC, config.group_name, { module: 'AGC', config: group.upsert.config });

        return workspace;
      });

      return requireAgcGroupInfo(config.group_name);
    },
    agcGetGroup: async (groupName: string): Promise<AgcGroupInfo> => requireAgcGroupInfo(groupName),
    agcListGroups: async (): Promise<AgcGroupInfo[]> =>
      workspaceAgcGroups().map((group) => agcGroupInfo(group)),
    agcDeleteGroup: async (groupName: string): Promise<void> => {
      deleteControlGroup(MODULE_AGC, groupName);
    },
    agcStartGroup: async (): Promise<void> => {},
    agcStopGroup: async (): Promise<void> => {},
    // 调试是纯运行态操作：离线下必须 no-op 成功，不能因为组不存在打断保存流程。
    agcStartTuning: async (groupName: string): Promise<AgcTuningStatus> => neutralTuningStatus(groupName),
    agcStopTuning: async (groupName: string): Promise<AgcTuningStatus> => neutralTuningStatus(groupName),
    agcGetTuningStatus: async (groupName: string): Promise<AgcTuningStatus> => neutralTuningStatus(groupName),
    agcGetControlProfile: async (groupName: string): Promise<AgcControlProfile> => {
      const profile = getWorkspace().agc_control_profiles.find((item) => item.group_name === groupName);

      return profile ? normalizeAgcControlProfileDecimalFields(clone(profile)) : emptyControlProfile(groupName);
    },
    agcConfirmControlProfile: async (profile: AgcControlProfile): Promise<AgcControlProfile> => {
      const normalized = normalizeAgcControlProfileDecimalFields(clone(profile));
      const confirmed: AgcControlProfile = {
        ...normalized,
        confirmed_at_ms: normalized.confirmed_at_ms > 0 ? normalized.confirmed_at_ms : Date.now(),
      };

      mutateWorkspace((workspace) => {
        const index = workspace.agc_control_profiles.findIndex((item) => item.group_name === confirmed.group_name);

        if (index >= 0) {
          workspace.agc_control_profiles[index] = { ...confirmed };
        } else {
          workspace.agc_control_profiles.push({ ...confirmed });
        }

        return workspace;
      });
      console.info('[离线工作区] 已保存 AGC 控制参数', { groupName: confirmed.group_name });

      return confirmed;
    },

    avcUpsertGroup: async (config: AvcGroupConfig, createOnly: boolean): Promise<AvcGroupInfo> => {
      mutateWorkspace((workspace) => {
        const group = upsertGroup(workspace, MODULE_AVC, workspace.config.avc.groups, config.group_name, createOnly);

        group.upsert.config = normalizeAvcGroupConfig(config);
        syncConnTags(workspace, MODULE_AVC, config.group_name, { module: 'AVC', config: group.upsert.config });

        return workspace;
      });

      return requireAvcGroupInfo(config.group_name);
    },
    avcRenameGroup: async (oldGroupName: string, newGroupName: string): Promise<AvcGroupInfo> => {
      renameControlGroup(MODULE_AVC, oldGroupName, newGroupName);

      return requireAvcGroupInfo(newGroupName);
    },
    avcGetGroup: async (groupName: string): Promise<AvcGroupInfo> => requireAvcGroupInfo(groupName),
    avcListGroups: async (): Promise<AvcGroupInfo[]> =>
      workspaceAvcGroups().map((group) => avcGroupInfo(group)),
    avcDeleteGroup: async (groupName: string): Promise<void> => {
      deleteControlGroup(MODULE_AVC, groupName);
    },
    avcStartGroup: async (): Promise<void> => {},
    avcStopGroup: async (): Promise<void> => {},

    iec61850ImportScl: async () => unsupported('iec61850ImportScl')(),
    iec61850ListModels: async () => unsupported('iec61850ListModels')(),
    iec61850DeleteModel: async () => unsupported('iec61850DeleteModel')(),
    iec61850UpsertIed: async () => unsupported('iec61850UpsertIed')(),
    iec61850GetIed: async () => unsupported('iec61850GetIed')(),
    iec61850ListIeds: async () => unsupported('iec61850ListIeds')(),
    iec61850DeleteIed: async () => unsupported('iec61850DeleteIed')(),
    iec61850StartIed: async () => unsupported('iec61850StartIed')(),
    iec61850StopIed: async () => unsupported('iec61850StopIed')(),
    iec61850UpsertPointMappings: async () => unsupported('iec61850UpsertPointMappings')(),
    iec61850GetPointMappings: async () => unsupported('iec61850GetPointMappings')(),
    iec61850GetRuntimeStatistics: async () => unsupported('iec61850GetRuntimeStatistics')(),
    controlOrchestratorUpsertSequence: async () => unsupported('controlOrchestratorUpsertSequence')(),
    controlOrchestratorGetSequence: async () => unsupported('controlOrchestratorGetSequence')(),
    controlOrchestratorListSequences: async () => unsupported('controlOrchestratorListSequences')(),
    controlOrchestratorDeleteSequence: async () => unsupported('controlOrchestratorDeleteSequence')(),
    controlOrchestratorExecuteSequence: async () => unsupported('controlOrchestratorExecuteSequence')(),
  };
}

/* ------------------------------------------------------------------ *
 * 工作区查找
 * ------------------------------------------------------------------ */

/**
 * 工作区文件里的链路/分组条目同时带有本地运行态字段，但 `WorkspaceConfig`
 * 的类型只声明了导出字段，因此这里在读写边界上做一次形状收窄。
 */
function asLinkInstances<T>(links: T[]): LinkInstance<T>[] {
  return links as LinkInstance<T>[];
}

function asGroupInstances<T>(groups: T[]): GroupInstance<T>[] {
  return groups as GroupInstance<T>[];
}

function workspaceIec104Links(): Iec104Link[] {
  return asLinkInstances(getWorkspace().config.iec104.links);
}

function workspaceModbusRtuLinks(): ModbusRtuLink[] {
  return asLinkInstances(getWorkspace().config.modbus_rtu.links);
}

function workspaceModbusTcpLinks(): ModbusTcpLink[] {
  return asLinkInstances(getWorkspace().config.modbus_tcp.links);
}

function workspaceDlt645Links(): Dlt645Link[] {
  return asLinkInstances(getWorkspace().config.dlt645.links);
}

function workspaceAgcGroups(): AgcGroup[] {
  return asGroupInstances(getWorkspace().config.agc.groups);
}

function workspaceAvcGroups(): AvcGroup[] {
  return asGroupInstances(getWorkspace().config.avc.groups);
}

function workspaceCalcGroups(): CalcGroup[] {
  return asGroupInstances(getWorkspace().config.calc.groups);
}

function linksForModule(workspace: OfflineWorkspace, moduleName: string): Iec104Link[] | ModbusRtuLink[] | ModbusTcpLink[] | Dlt645Link[] {
  switch (moduleName) {
    case MODULE_IEC104:
      return asLinkInstances(workspace.config.iec104.links);
    case MODULE_MODBUS_RTU:
      return asLinkInstances(workspace.config.modbus_rtu.links);
    case MODULE_MODBUS_TCP:
      return asLinkInstances(workspace.config.modbus_tcp.links);
    case MODULE_DLT645:
      return asLinkInstances(workspace.config.dlt645.links);
    default:
      return [];
  }
}

function groupsForModule(workspace: OfflineWorkspace, moduleName: string): GroupCarrier[] {
  switch (moduleName) {
    case MODULE_AGC:
      return asGroupInstances(workspace.config.agc.groups);
    case MODULE_AVC:
      return asGroupInstances(workspace.config.avc.groups);
    case MODULE_CALC:
      return asGroupInstances(workspace.config.calc.groups);
    default:
      throw new Error(`离线工作区暂不支持该模块的分组: ${moduleName}`);
  }
}

function findLink<T extends LinkCarrier>(links: T[], connName: string): T | null;
function findLink(links: LinkCarrier[], connName: string): LinkCarrier | null;
function findLink(links: LinkCarrier[], connName: string): LinkCarrier | null {
  return links.find((entry) => entry.link.config.conn_name === connName) ?? null;
}

function requireFind<T extends LinkCarrier>(links: T[], moduleName: string, connName: string): T {
  const entry = findLink(links, connName);

  if (!entry) {
    throw new Error(`未找到连接 ${connName}${moduleName ? ` (${moduleName})` : ''}`);
  }

  return entry;
}

function requireIec104Link(connName: string): Iec104Link {
  return requireFind(workspaceIec104Links(), MODULE_IEC104, connName);
}

function requireModbusRtuLink(connName: string): ModbusRtuLink {
  return requireFind(workspaceModbusRtuLinks(), MODULE_MODBUS_RTU, connName);
}

function requireModbusTcpLink(connName: string): ModbusTcpLink {
  return requireFind(workspaceModbusTcpLinks(), MODULE_MODBUS_TCP, connName);
}

function requireDlt645Link(connName: string): Dlt645Link {
  return requireFind(workspaceDlt645Links(), MODULE_DLT645, connName);
}

function findAgcGroup(groupName: string): AgcGroup | null {
  return workspaceAgcGroups().find((group) => group.upsert.config.group_name === groupName) ?? null;
}

function findAvcGroup(groupName: string): AvcGroup | null {
  return workspaceAvcGroups().find((group) => group.upsert.config.group_name === groupName) ?? null;
}

function findCalcGroup(groupName: string): CalcGroup | null {
  return workspaceCalcGroups().find((group) => group.upsert.config.group_name === groupName) ?? null;
}

function requireAgcGroup(groupName: string): AgcGroup {
  const group = findAgcGroup(groupName);

  if (!group) {
    throw new Error(`未找到分组 ${groupName}`);
  }

  return group;
}

function requireAvcGroup(groupName: string): AvcGroup {
  const group = findAvcGroup(groupName);

  if (!group) {
    throw new Error(`未找到分组 ${groupName}`);
  }

  return group;
}

function requireCalcGroup(groupName: string): CalcGroup {
  const group = findCalcGroup(groupName);

  if (!group) {
    throw new Error(`未找到分组 ${groupName}`);
  }

  return group;
}

/* ------------------------------------------------------------------ *
 * 连接编号注册表
 * ------------------------------------------------------------------ */

function requireConnectionId(workspace: OfflineWorkspace, moduleName: string, connName: string): number {
  const connId = findConnectionId(workspace.conn_ids, moduleName, connName);

  if (connId === null) {
    throw new Error(`未找到连接 ${connName}`);
  }

  return connId;
}

/** 确保稳定键已分配本地编号；已分配时原样保留编号（跨会话稳定、删除不回收）。 */
function ensureConnection(workspace: OfflineWorkspace, moduleName: string, connName: string): number {
  const result = ensureConnectionId(workspace.conn_ids, moduleName, connName);

  workspace.conn_ids = result.registry;

  return result.connId;
}

/** `dcListConnections` 的唯一数据来源：本地编号注册表。 */
function listWorkspaceConnections(workspace: OfflineWorkspace): DcConnectionInfo[] {
  return listConnections(workspace.conn_ids).map(connectionInfo);
}

function connectionInfo(connection: WorkspaceConnection): DcConnectionInfo {
  return {
    conn_id: connection.conn_id,
    module_name: connection.module_name,
    conn_name: connection.conn_name,
  };
}

/* ------------------------------------------------------------------ *
 * 数据总线登记：connections / conn_tags
 * ------------------------------------------------------------------ */

/** 确保 `config.data_bus.connections` 里有对应条目；导入时下位机要求连接先声明。 */
function ensureConnectionEntry(workspace: OfflineWorkspace, moduleName: string, connName: string): void {
  if (!moduleName || !connName) {
    return;
  }

  const exists = workspace.config.data_bus.connections.some(
    (connection) => connection.module_name === moduleName && connection.conn_name === connName,
  );

  if (!exists) {
    workspace.config.data_bus.connections.push({ module_name: moduleName, conn_name: connName });
  }
}

function removeConnectionEntry(workspace: OfflineWorkspace, moduleName: string, connName: string): void {
  workspace.config.data_bus.connections = workspace.config.data_bus.connections.filter(
    (connection) => !(connection.module_name === moduleName && connection.conn_name === connName),
  );
}

/** 按稳定键改名：连接条目与标签条目都要跟着改，否则导出会缺声明。 */
function renameConnectionMeta(
  workspace: OfflineWorkspace,
  moduleName: string,
  oldName: string,
  newName: string,
): void {
  for (const connection of workspace.config.data_bus.connections) {
    if (connection.module_name === moduleName && connection.conn_name === oldName) {
      connection.conn_name = newName;
    }
  }

  for (const entry of workspace.config.data_bus.conn_tags) {
    if (entry.module_name === moduleName && entry.conn_name === oldName) {
      entry.conn_name = newName;
    }
  }
}

/**
 * 重算连接的标签注册表并写回工作区。
 *
 * 点表/分组是标签的唯一事实来源：写入后必须以派生结果覆盖旧标签，
 * 否则导出时下位机会按旧注册表静默剪除指向新增点的路由。
 */
function syncConnTags(
  workspace: OfflineWorkspace,
  moduleName: string,
  connName: string,
  input: SyncConnTagsInput,
): void {
  if (!moduleName || !connName) {
    return;
  }

  const tags = deriveTagsFor(input);
  const connTags = workspace.config.data_bus.conn_tags;
  const existing = connTags.find(
    (entry) => entry.module_name === moduleName && entry.conn_name === connName,
  );

  if (existing) {
    existing.tags = tags;
  } else {
    connTags.push({ module_name: moduleName, conn_name: connName, tags });
  }

  ensureConnectionEntry(workspace, moduleName, connName);
}

function deriveTagsFor(input: SyncConnTagsInput): string[] {
  return input.module === MODULE_DATA_CENTER ? sortTags(input.tags) : deriveConnTags(input);
}

function removeConnTags(workspace: OfflineWorkspace, moduleName: string, connName: string): void {
  workspace.config.data_bus.conn_tags = workspace.config.data_bus.conn_tags.filter(
    (entry) => !(entry.module_name === moduleName && entry.conn_name === connName),
  );
}

/** 读取当前登记的标签：注册表标签与点表派生标签取并集，避免导出时缺标签被剪路由。 */
function getRegisteredTags(workspace: OfflineWorkspace, connId: number): string[] {
  const connection = listConnections(workspace.conn_ids).find((item) => item.conn_id === connId);

  if (!connection) {
    console.warn('[离线工作区] 读取标签的连接不在本地注册表中', { connId });

    return [];
  }

  const tags = new Set<string>(readConnTags(workspace, connection.module_name, connection.conn_name));

  for (const tag of deriveKnownTags(workspace, connection.module_name, connection.conn_name)) {
    tags.add(tag);
  }

  return sortTags([...tags]);
}

function readConnTags(workspace: OfflineWorkspace, moduleName: string, connName: string): string[] {
  const entry = workspace.config.data_bus.conn_tags.find(
    (item) => item.module_name === moduleName && item.conn_name === connName,
  );

  return entry ? [...entry.tags] : [];
}

function upsertConnTags(connId: number, tags: string[], replace: boolean): void {
  mutateWorkspace((workspace) => {
    const connection = listConnections(workspace.conn_ids).find((item) => item.conn_id === connId);
    const moduleName = connection?.module_name ?? MODULE_DATA_CENTER;
    const connName = connection?.conn_name ?? `conn-${connId}`;
    const nextTags = replace
      ? sortTags(tags)
      : sortTags([...readConnTags(workspace, moduleName, connName), ...tags]);
    const entry = workspace.config.data_bus.conn_tags.find(
      (item) => item.module_name === moduleName && item.conn_name === connName,
    );

    if (entry) {
      entry.tags = nextTags;
    } else {
      workspace.config.data_bus.conn_tags.push({ module_name: moduleName, conn_name: connName, tags: nextTags });
    }

    ensureConnectionEntry(workspace, moduleName, connName);

    if (!connection) {
      console.warn('[离线工作区] 标签写入的连接不在本地注册表中，已按本地标签条目记录', {
        connId,
        moduleName,
        connName,
      });
    }

    return workspace;
  });
}

/** 用点表/分组推导某个连接的标签；未知模块或缺少配置时返回空数组。 */
function deriveKnownTags(workspace: OfflineWorkspace, moduleName: string, connName: string): string[] {
  try {
    return deriveConnTags(deriveInputFor(workspace, moduleName, connName));
  } catch (error) {
    console.warn('[离线工作区] 标签派生失败，已跳过该连接', { moduleName, connName, error });

    return [];
  }
}

function deriveInputFor(workspace: OfflineWorkspace, moduleName: string, connName: string): DeriveTagsInput {
  switch (moduleName) {
    case MODULE_IEC104: {
      const link = findLink(asLinkInstances(workspace.config.iec104.links), connName);

      return {
        module: 'IEC104',
        points: link?.point_table.points ?? [],
        timeSyncTag: link?.link.config.time_sync_tag,
      };
    }
    case MODULE_MODBUS_RTU:
      return {
        module: 'ModbusRTU',
        points: findLink(asLinkInstances(workspace.config.modbus_rtu.links), connName)?.point_table.points ?? [],
      };
    case MODULE_MODBUS_TCP:
      return {
        module: 'ModbusTCP',
        points: findLink(asLinkInstances(workspace.config.modbus_tcp.links), connName)?.point_table.points ?? [],
      };
    case MODULE_DLT645: {
      const link = findLink(asLinkInstances(workspace.config.dlt645.links), connName);

      return {
        module: 'DLT645',
        points: link?.point_table.points ?? [],
        blocks: link?.point_table.blocks ?? [],
      };
    }
    case MODULE_AGC:
      return { module: 'AGC', config: requireAgcGroup(connName).upsert.config };
    case MODULE_AVC:
      return { module: 'AVC', config: requireAvcGroup(connName).upsert.config };
    case MODULE_CALC:
      return { module: 'Calc', config: requireCalcGroup(connName).upsert.config };
    case MODULE_DEVICE_INFO:
      return { module: 'DeviceInfo' };
    case MODULE_BOARD_IO:
      return { module: 'BoardIO', connName };
    default:
      throw new Error(`离线工作区暂不支持派生该模块的标签: ${moduleName}`);
  }
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

function routeKey(route: StableDataBusRoute): string {
  return `${endpointKey(route.src)}→${endpointKey(route.dst)}`;
}

function endpointKey(endpoint: StableDataBusEndpoint): string {
  return JSON.stringify([endpoint.module_name, endpoint.conn_name, endpoint.tag]);
}

function toStableRoute(workspace: OfflineWorkspace, route: DcRoute): StableDataBusRoute {
  return {
    src: toStableEndpoint(workspace, route.src),
    dst: toStableEndpoint(workspace, route.dst),
  };
}

function toStableEndpoint(workspace: OfflineWorkspace, endpoint: StableDataBusEndpoint): StableDataBusEndpoint {
  const connId = resolveEndpointConnId(workspace, endpoint);

  return {
    module_name: endpoint.module_name,
    conn_name: endpoint.conn_name,
    tag: endpoint.tag,
    ...(connId > 0 ? { conn_id: connId } : {}),
  };
}

function toRuntimeRoute(workspace: OfflineWorkspace, route: StableDataBusRoute): DcRoute {
  return {
    src: {
      module_name: route.src.module_name,
      conn_name: route.src.conn_name,
      tag: route.src.tag,
      conn_id: resolveEndpointConnId(workspace, route.src),
    },
    dst: {
      module_name: route.dst.module_name,
      conn_name: route.dst.conn_name,
      tag: route.dst.tag,
      conn_id: resolveEndpointConnId(workspace, route.dst),
    },
  };
}

/** 路由端点的 conn_id 以本地注册表为准；注册表缺失时退回工作区里携带的编号。 */
function resolveEndpointConnId(workspace: OfflineWorkspace, endpoint: StableDataBusEndpoint): number {
  const known = findConnectionId(workspace.conn_ids, endpoint.module_name, endpoint.conn_name);

  if (known !== null) {
    return known;
  }

  return typeof endpoint.conn_id === 'number' && Number.isInteger(endpoint.conn_id) ? endpoint.conn_id : 0;
}

function listRoutes(srcConnId: number, srcTag: string, dstConnId: number, dstTag: string): DcRoute[] {
  const workspace = getWorkspace();

  return clone(
    workspace.config.data_bus.routes.items
      .map((route) => toRuntimeRoute(workspace, route))
      .filter((route) => {
        const srcMatches = !srcConnId || route.src.conn_id === srcConnId;
        const dstMatches = !dstConnId || route.dst.conn_id === dstConnId;
        const srcTagMatches = !srcTag || route.src.tag === srcTag;
        const dstTagMatches = !dstTag || route.dst.tag === dstTag;

        return srcMatches && dstMatches && srcTagMatches && dstTagMatches;
      }),
  );
}

function upsertRoutes(routes: DcRoute[], replace: boolean): void {
  mutateWorkspace((workspace) => {
    registerRouteConnections(workspace, routes);

    const merged = [
      ...(replace ? [] : workspace.config.data_bus.routes.items),
      ...routes.map((route) => toStableRoute(workspace, route)),
    ];
    const unique = new Map<string, StableDataBusRoute>();

    for (const route of merged) {
      unique.set(routeKey(route), route);
    }

    workspace.config.data_bus.routes = { replace: true, items: [...unique.values()] };

    return workspace;
  });
}

function deleteRoutes(routes: DcRoute[]): void {
  mutateWorkspace((workspace) => {
    const keys = new Set(routes.map((route) => routeKey(toStableRoute(workspace, route))));

    workspace.config.data_bus.routes = {
      replace: true,
      items: workspace.config.data_bus.routes.items.filter((route) => !keys.has(routeKey(route))),
    };

    return workspace;
  });
}

/** 路由端点也要登记，否则改名前它只是路由里的孤儿名字。 */
function registerRouteConnections(workspace: OfflineWorkspace, routes: DcRoute[]): void {
  for (const route of routes) {
    for (const endpoint of [route.src, route.dst]) {
      if (!endpoint.module_name || !endpoint.conn_name) {
        continue;
      }

      ensureConnection(workspace, endpoint.module_name, endpoint.conn_name);
      ensureConnectionEntry(workspace, endpoint.module_name, endpoint.conn_name);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 链路与分组：新增 / 改名 / 删除
 * ------------------------------------------------------------------ */

function upsertLink<T extends LinkCarrier>(
  workspace: OfflineWorkspace,
  moduleName: string,
  links: T[],
  connName: string,
  createOnly: boolean,
): T {
  const existing = findLink(links, connName);

  if (existing) {
    if (createOnly) {
      throw new Error(`连接已存在 ${connName}`);
    }

    ensureConnection(workspace, moduleName, connName);
    ensureConnectionEntry(workspace, moduleName, connName);

    return existing;
  }

  const connId = ensureConnection(workspace, moduleName, connName);
  const created = createNeutralLink(moduleName, connName, connId) as unknown as T;

  links.push(created);
  ensureConnectionEntry(workspace, moduleName, connName);

  return created;
}

/** 新建链路的中性运行态：state=已停止、last_error 为空、通信/会话状态为断开或未知。 */
function createNeutralLink(
  moduleName: string,
  connName: string,
  connId: number,
): Iec104Link | ModbusRtuLink | ModbusTcpLink | Dlt645Link {
  const runtime = { conn_id: connId, state: LINK_STATE_STOPPED, last_error: '' };
  const pointTable = { conn_name: connName, points: [] };

  switch (moduleName) {
    case MODULE_IEC104: {
      const link: Iec104Link = {
        link: { config: { conn_name: connName } as Iec104LinkConfig },
        point_table: { ...pointTable, replace: true },
      } as unknown as Iec104Link;

      Object.assign(link, runtime, { connection_state: IEC104_CONNECTION_STATE_DISCONNECTED });

      return link;
    }
    case MODULE_MODBUS_RTU: {
      const link: ModbusRtuLink = {
        link: { config: { conn_name: connName } as ModbusLinkConfig },
        point_table: { ...pointTable, replace: true },
      } as unknown as ModbusRtuLink;

      Object.assign(link, runtime, { communication_state: COMMUNICATION_STATE_UNSPECIFIED });

      return link;
    }
    case MODULE_MODBUS_TCP: {
      const link: ModbusTcpLink = {
        link: { config: { conn_name: connName } as ModbusTcpLinkConfig },
        point_table: { ...pointTable, replace: true },
      } as unknown as ModbusTcpLink;

      Object.assign(link, runtime);

      return link;
    }
    case MODULE_DLT645: {
      const link: Dlt645Link = {
        link: { config: { conn_name: connName } as Dlt645LinkConfig },
        point_table: { ...pointTable, blocks: [], replace: true },
      } as unknown as Dlt645Link;

      Object.assign(link, runtime, { communication_state: COMMUNICATION_STATE_UNSPECIFIED });

      return link;
    }
    default:
      throw new Error(`离线工作区暂不支持该模块的链路: ${moduleName}`);
  }
}

function upsertGroup<T extends GroupCarrier>(
  workspace: OfflineWorkspace,
  moduleName: string,
  groups: T[],
  groupName: string,
  createOnly: boolean,
): T {
  const existing = groups.find((group) => group.upsert.config.group_name === groupName);

  if (existing) {
    if (createOnly) {
      throw new Error(`分组已存在 ${groupName}`);
    }

    ensureConnection(workspace, moduleName, groupName);
    ensureConnectionEntry(workspace, moduleName, groupName);

    return existing;
  }

  const connId = ensureConnection(workspace, moduleName, groupName);
  const created = createNeutralGroup(groupName, connId) as unknown as T;

  groups.push(created);
  ensureConnectionEntry(workspace, moduleName, groupName);

  return created;
}

/** 新建分组的中性运行态：state=已停止、last_error 为空。 */
function createNeutralGroup(groupName: string, connId: number): GroupCarrier & GroupRuntime {
  return {
    conn_id: connId,
    upsert: { config: { group_name: groupName } },
    state: LINK_STATE_STOPPED,
    last_error: '',
  };
}

function removeRuntimeEntry<T extends { conn_id: number }>(entries: T[], connId: number | null): void {
  if (connId === null) {
    return;
  }

  const index = entries.findIndex((entry) => entry.conn_id === connId);

  if (index >= 0) {
    entries.splice(index, 1);
  }
}

/** 删除连接的痕迹：链路/分组、注册表键、connections、conn_tags 与引用它的路由。 */
function removeConnectionEverywhere(workspace: OfflineWorkspace, moduleName: string, connName: string): void {
  const connId = findConnectionId(workspace.conn_ids, moduleName, connName);

  switch (moduleName) {
    case MODULE_IEC104:
      removeRuntimeEntry(asLinkInstances(workspace.config.iec104.links) as { conn_id: number }[], connId);
      break;
    case MODULE_MODBUS_RTU:
      removeRuntimeEntry(asLinkInstances(workspace.config.modbus_rtu.links) as { conn_id: number }[], connId);
      break;
    case MODULE_MODBUS_TCP:
      removeRuntimeEntry(asLinkInstances(workspace.config.modbus_tcp.links) as { conn_id: number }[], connId);
      break;
    case MODULE_DLT645:
      removeRuntimeEntry(asLinkInstances(workspace.config.dlt645.links) as { conn_id: number }[], connId);
      break;
    case MODULE_AGC:
      removeRuntimeEntry(asLinkInstances(workspace.config.agc.groups) as { conn_id: number }[], connId);
      break;
    case MODULE_AVC:
      removeRuntimeEntry(asLinkInstances(workspace.config.avc.groups) as { conn_id: number }[], connId);
      break;
    case MODULE_CALC:
      removeRuntimeEntry(asLinkInstances(workspace.config.calc.groups) as { conn_id: number }[], connId);
      break;
    default:
      break;
  }

  // 编号不回收：只删注册表键，自增号继续往前走。
  workspace.conn_ids = removeConnectionId(workspace.conn_ids, moduleName, connName);
  removeConnectionEntry(workspace, moduleName, connName);
  removeConnTags(workspace, moduleName, connName);
  removeRoutesForConnection(workspace, moduleName, connName);
}

function removeRoutesForConnection(workspace: OfflineWorkspace, moduleName: string, connName: string): void {
  workspace.config.data_bus.routes = {
    replace: true,
    items: workspace.config.data_bus.routes.items.filter(
      (route) =>
        !(route.src.module_name === moduleName && route.src.conn_name === connName)
        && !(route.dst.module_name === moduleName && route.dst.conn_name === connName),
    ),
  };
}

/** 链路改名：链路配置、点表 conn_name、注册表键（保持同一编号）、connections、conn_tags、路由端点。 */
function renameProtocolLink(moduleName: string, oldConnName: string, newConnName: string): void {
  mutateWorkspace((workspace) => {
    const links = linksForModule(workspace, moduleName);

    if (links.length === 0) {
      throw new Error(`离线工作区暂不支持该模块的链路: ${moduleName}`);
    }

    const target = findLink(links, oldConnName);

    if (!target) {
      throw new Error(`未找到连接 ${oldConnName}`);
    }

    if (findLink(links, newConnName)) {
      throw new Error(`连接已存在 ${newConnName}`);
    }

    // 先改名再收尾，收尾时的标签派生才能按新名字读到已更新的点表。
    target.link.config.conn_name = newConnName;
    target.point_table.conn_name = newConnName;
    applyConnectionRename(
      workspace,
      moduleName,
      oldConnName,
      newConnName,
      deriveInputFor(workspace, moduleName, newConnName),
    );

    return workspace;
  });
}

/** 分组改名：分组配置、注册表键（保持同一编号）、connections、conn_tags 与路由端点。 */
function renameControlGroup(moduleName: string, oldGroupName: string, newGroupName: string): void {
  mutateWorkspace((workspace) => {
    const groups = groupsForModule(workspace, moduleName);
    const target = groups.find((group) => group.upsert.config.group_name === oldGroupName);

    if (!target) {
      throw new Error(`未找到分组 ${oldGroupName}`);
    }

    if (groups.some((group) => group.upsert.config.group_name === newGroupName)) {
      throw new Error(`分组已存在 ${newGroupName}`);
    }

    target.upsert.config.group_name = newGroupName;
    applyConnectionRename(
      workspace,
      moduleName,
      oldGroupName,
      newGroupName,
      deriveInputFor(workspace, moduleName, newGroupName),
    );

    if (moduleName === MODULE_AGC) {
      // AGC 控制参数按组名存档，改名后必须跟着走，否则参数会丢。
      for (const profile of workspace.agc_control_profiles) {
        if (profile.group_name === oldGroupName) {
          profile.group_name = newGroupName;
        }
      }
    }

    return workspace;
  });
}

/** 改名收尾：注册表换键但保留编号，connections/conn_tags/路由端点同步，标签按新点表重算。 */
function applyConnectionRename(
  workspace: OfflineWorkspace,
  moduleName: string,
  oldName: string,
  newName: string,
  deriveInput: DeriveTagsInput,
): void {
  const connId = findConnectionId(workspace.conn_ids, moduleName, oldName);

  if (connId === null) {
    throw new Error(`未找到连接 ${oldName}`);
  }

  const withoutOld = removeConnectionId(workspace.conn_ids, moduleName, oldName);
  const registry: WorkspaceConnIdRegistry = {
    map: { ...withoutOld.map, [`${moduleName}${CONNECTION_KEY_SEPARATOR}${newName}`]: connId },
    next_conn_id: withoutOld.next_conn_id,
  };

  workspace.conn_ids = registry;
  renameConnectionMeta(workspace, moduleName, oldName, newName);
  renameRoutesForConnection(workspace, moduleName, oldName, newName);
  syncConnTags(workspace, moduleName, newName, deriveInput);
}

function renameRoutesForConnection(
  workspace: OfflineWorkspace,
  moduleName: string,
  oldName: string,
  newName: string,
): void {
  for (const route of workspace.config.data_bus.routes.items) {
    for (const endpoint of [route.src, route.dst]) {
      if (endpoint.module_name === moduleName && endpoint.conn_name === oldName) {
        endpoint.conn_name = newName;
      }
    }
  }
}

function deleteProtocolLink(moduleName: string, connName: string): void {
  mutateWorkspace((workspace) => {
    if (!findLink(linksForModule(workspace, moduleName), connName)) {
      throw new Error(`未找到连接 ${connName}`);
    }

    removeConnectionEverywhere(workspace, moduleName, connName);

    return workspace;
  });
}

function deleteControlGroup(moduleName: string, groupName: string): void {
  mutateWorkspace((workspace) => {
    const groups = groupsForModule(workspace, moduleName);

    if (!groups.some((group) => group.upsert.config.group_name === groupName)) {
      throw new Error(`未找到分组 ${groupName}`);
    }

    removeConnectionEverywhere(workspace, moduleName, groupName);

    if (moduleName === MODULE_AGC) {
      workspace.agc_control_profiles = workspace.agc_control_profiles.filter(
        (profile) => profile.group_name !== groupName,
      );
    }

    return workspace;
  });
}

/* ------------------------------------------------------------------ *
 * 点表
 * ------------------------------------------------------------------ */

function upsertIec104PointTable(connName: string, points: Iec104Point[], replace: boolean): void {
  mutateWorkspace((workspace) => {
    const entry = requireIec104Link(connName);
    const nextPoints = (replace ? points : mergeByTag(entry.point_table.points, points)).map(normalizeIec104Point);

    entry.point_table = { conn_name: connName, points: nextPoints, replace: true };
    syncConnTags(workspace, MODULE_IEC104, connName, {
      module: 'IEC104',
      points: nextPoints,
      timeSyncTag: entry.link.config.time_sync_tag,
    });

    return workspace;
  });
}

function upsertModbusPointTable(
  moduleName: typeof MODULE_MODBUS_RTU | typeof MODULE_MODBUS_TCP,
  connName: string,
  points: ModbusPoint[],
  replace: boolean,
): void {
  mutateWorkspace((workspace) => {
    const entry: ModbusRtuLink | ModbusTcpLink = moduleName === MODULE_MODBUS_RTU
      ? requireModbusRtuLink(connName)
      : requireModbusTcpLink(connName);
    const nextPoints = (replace ? points : mergeByTag(entry.point_table.points, points)).map(normalizeModbusPoint);

    entry.point_table = { conn_name: connName, points: nextPoints, replace: true };
    syncConnTags(workspace, moduleName, connName, {
      module: moduleName === MODULE_MODBUS_RTU ? 'ModbusRTU' : 'ModbusTCP',
      points: nextPoints,
    });

    return workspace;
  });
}

function upsertDlt645PointTable(
  connName: string,
  points: Dlt645Point[],
  blocks: Dlt645Block[],
  replace: boolean,
): void {
  mutateWorkspace((workspace) => {
    const entry = requireDlt645Link(connName);
    const previous = entry.point_table;
    const nextPoints = (replace ? points : mergeByTag(previous.points, points)).map(normalizeDlt645Point);
    const nextBlocks = (replace ? blocks : [...previous.blocks, ...blocks]).map(normalizeDlt645Block);

    entry.point_table = { conn_name: connName, points: nextPoints, blocks: nextBlocks, replace: true };
    syncConnTags(workspace, MODULE_DLT645, connName, {
      module: 'DLT645',
      points: nextPoints,
      blocks: nextBlocks,
    });

    return workspace;
  });
}

function mergeByTag<T extends { tag: string }>(previous: readonly T[], next: readonly T[]): T[] {
  const values = new Map(previous.map((item) => [item.tag, item]));

  for (const item of next) {
    values.set(item.tag, item);
  }

  return [...values.values()];
}

function inferIec104BusinessType(point: Iec104Point): number {
  if (point.business_type) {
    return point.business_type;
  }

  if (point.ioa >= 1 && point.ioa <= 0x4000) {
    return IEC104_BUSINESS_TYPE_TELEINDICATION;
  }

  if (point.ioa >= 0x4001 && point.ioa <= 0x5000) {
    return IEC104_BUSINESS_TYPE_TELEMETRY;
  }

  if (point.ioa >= 0x6001 && point.ioa <= 0x6100) {
    return IEC104_BUSINESS_TYPE_REMOTE_CONTROL;
  }

  if (point.ioa >= 0x6201 && point.ioa <= 0x6400) {
    return IEC104_BUSINESS_TYPE_REMOTE_ADJUST;
  }

  if (point.ioa >= 0xA000 && point.ioa <= 0xBFFF) {
    return IEC104_BUSINESS_TYPE_PARAMETER;
  }

  return 0;
}

function normalizeIec104Point(point: Iec104Point): Iec104Point {
  const scaleDecimal = point.scale_decimal || String(point.scale);
  const offsetDecimal = point.offset_decimal || String(point.offset);
  const deadbandDecimal = point.deadband_decimal || String(point.deadband);

  return {
    ...point,
    business_type: inferIec104BusinessType(point),
    remote_control_type: point.remote_control_type || IEC104_REMOTE_CONTROL_TYPE_SINGLE,
    command_execution_mode: point.command_execution_mode || IEC104_COMMAND_EXECUTION_MODE_SELECT_EXECUTE,
    scale: Number(scaleDecimal),
    offset: Number(offsetDecimal),
    deadband: Number(deadbandDecimal),
    scale_decimal: scaleDecimal,
    offset_decimal: offsetDecimal,
    deadband_decimal: deadbandDecimal,
  };
}

function normalizeModbusPoint(point: ModbusPoint): ModbusPoint {
  const scaleDecimal = point.scale_decimal || String(point.scale);
  const offsetDecimal = point.offset_decimal || String(point.offset);
  const deadbandDecimal = point.deadband_decimal || String(point.deadband);

  return {
    ...point,
    scale: Number(scaleDecimal),
    offset: Number(offsetDecimal),
    deadband: Number(deadbandDecimal),
    scale_decimal: scaleDecimal,
    offset_decimal: offsetDecimal,
    deadband_decimal: deadbandDecimal,
  };
}

function normalizeDlt645Point(point: Dlt645Point): Dlt645Point {
  const scaleDecimal = point.scale_decimal || String(point.scale);
  const offsetDecimal = point.offset_decimal || String(point.offset);
  const deadbandDecimal = point.deadband_decimal || String(point.deadband);

  return {
    ...point,
    scale: Number(scaleDecimal),
    offset: Number(offsetDecimal),
    deadband: Number(deadbandDecimal),
    scale_decimal: scaleDecimal,
    offset_decimal: offsetDecimal,
    deadband_decimal: deadbandDecimal,
  };
}

function normalizeDlt645BlockItem(item: Dlt645BlockItem): Dlt645BlockItem {
  const scaleDecimal = item.scale_decimal || String(item.scale);
  const offsetDecimal = item.offset_decimal || String(item.offset);
  const deadbandDecimal = item.deadband_decimal || String(item.deadband);

  return {
    ...item,
    scale: Number(scaleDecimal),
    offset: Number(offsetDecimal),
    deadband: Number(deadbandDecimal),
    scale_decimal: scaleDecimal,
    offset_decimal: offsetDecimal,
    deadband_decimal: deadbandDecimal,
  };
}

function normalizeDlt645Block(block: Dlt645Block): Dlt645Block {
  return { ...block, items: block.items.map(normalizeDlt645BlockItem) };
}

/* ------------------------------------------------------------------ *
 * 运行态中性化的读取结果
 * ------------------------------------------------------------------ */

/** 链路读取结果：state 恒为已停止（1）、last_error 恒为空串。 */
function iec104LinkInfo(link: Iec104Link, connId: number): Iec104LinkInfo {
  return {
    config: clone(link.link.config),
    conn_id: connId,
    state: LINK_STATE_STOPPED,
    connection_state: IEC104_CONNECTION_STATE_DISCONNECTED,
    last_error: '',
  };
}

function modbusRtuLinkInfo(link: ModbusRtuLink, connId: number): ModbusLinkInfo {
  return {
    config: clone(link.link.config),
    conn_id: connId,
    state: LINK_STATE_STOPPED,
    last_error: '',
    communication_state: COMMUNICATION_STATE_UNSPECIFIED,
  };
}

function modbusTcpLinkInfo(link: ModbusTcpLink, connId: number): ModbusTcpLinkInfo {
  return {
    config: clone(link.link.config),
    conn_id: connId,
    state: LINK_STATE_STOPPED,
    last_error: '',
  };
}

function dlt645LinkInfo(link: Dlt645Link, connId: number): Dlt645LinkInfo {
  return {
    config: clone(link.link.config),
    conn_id: connId,
    state: LINK_STATE_STOPPED,
    last_error: '',
    communication_state: COMMUNICATION_STATE_UNSPECIFIED,
  };
}

/** 读取编号时以注册表为准，注册表缺失才回退到链路记录（例如手工编辑过的工作区文件）。 */
function requireConnId(
  entry: { conn_id: number },
  moduleName: string,
  connName: string,
): number {
  const registered = findConnectionId(getWorkspace().conn_ids, moduleName, connName);

  if (registered === null) {
    console.warn('[离线工作区] 连接未在本地注册表中登记，已回退到链路记录的编号', {
      moduleName,
      connName,
      connId: entry.conn_id,
    });

    return entry.conn_id;
  }

  return registered;
}

function requireIec104LinkInfo(connName: string): Iec104LinkInfo {
  const link = requireIec104Link(connName);

  return iec104LinkInfo(link, requireConnId(link, MODULE_IEC104, connName));
}

function requireModbusRtuLinkInfo(connName: string): ModbusLinkInfo {
  const link = requireModbusRtuLink(connName);

  return modbusRtuLinkInfo(link, requireConnId(link, MODULE_MODBUS_RTU, connName));
}

function requireModbusTcpLinkInfo(connName: string): ModbusTcpLinkInfo {
  const link = requireModbusTcpLink(connName);

  return modbusTcpLinkInfo(link, requireConnId(link, MODULE_MODBUS_TCP, connName));
}

function requireDlt645LinkInfo(connName: string): Dlt645LinkInfo {
  const link = requireDlt645Link(connName);

  return dlt645LinkInfo(link, requireConnId(link, MODULE_DLT645, connName));
}

/** 分组读取结果：state 恒为已停止（1）、last_error 恒为空串。 */
function agcGroupInfo(group: AgcGroup): AgcGroupInfo {
  return {
    config: clone(normalizeAgcGroupConfigDecimalFields(group.upsert.config)),
    conn_id: requireConnId(group, MODULE_AGC, group.upsert.config.group_name),
    state: LINK_STATE_STOPPED,
    last_error: '',
    default_points: buildDefaultPoints(AGC_DEFAULT_POINT_TAGS),
    function_enabled: true,
    remote_enabled: true,
  };
}

function avcGroupInfo(group: AvcGroup): AvcGroupInfo {
  return {
    config: clone(normalizeAvcGroupConfig(group.upsert.config)),
    conn_id: requireConnId(group, MODULE_AVC, group.upsert.config.group_name),
    state: LINK_STATE_STOPPED,
    last_error: '',
    default_points: buildDefaultPoints(AVC_DEFAULT_POINT_TAGS),
    function_enabled: true,
    remote_enabled: true,
  };
}

function calcGroupInfo(group: CalcGroup): CalcGroupInfo {
  const config = normalizeCalcGroupConfig(group.upsert.config);

  return {
    config: clone(config),
    conn_id: requireConnId(group, MODULE_CALC, config.group_name),
    state: LINK_STATE_STOPPED,
    last_error: '',
    items: buildCalcItems(config),
  };
}

function requireAgcGroupInfo(groupName: string): AgcGroupInfo {
  return agcGroupInfo(requireAgcGroup(groupName));
}

function requireAvcGroupInfo(groupName: string): AvcGroupInfo {
  return avcGroupInfo(requireAvcGroup(groupName));
}

function requireCalcGroupInfo(groupName: string): CalcGroupInfo {
  return calcGroupInfo(requireCalcGroup(groupName));
}

/** 固定默认点：组名不参与命名，kind 按数组顺序从 1 开始。 */
function buildDefaultPoints(tags: readonly string[]): AgcDefaultPointInfo[] {
  return tags.map((tag, index) => ({
    kind: index + 1,
    tag,
    name: tag,
    description: '离线工作区默认点',
  }));
}

function emptyControlProfile(groupName: string): AgcControlProfile {
  return { group_name: groupName, members: [], version: 0, confirmed_at_ms: 0 };
}

/** 调试状态在离线下没有意义，统一返回已停止且无错误。 */
function neutralTuningStatus(groupName: string): AgcTuningStatus {
  return {
    group_name: groupName,
    state: LINK_STATE_STOPPED,
    direction: 0,
    completed_up_tests: 0,
    completed_down_tests: 0,
    started_at_ms: 0,
    elapsed_ms: 0,
    current_target_kw: 0,
    current_total_meas_kw: 0,
    current_target_kw_decimal: '0',
    current_total_meas_kw_decimal: '0',
    target_entry_elapsed_seconds: 0,
    stable_elapsed_seconds: 0,
    last_error: '',
    candidate_profile: null,
  };
}

function emptySoePage(): Iec104SoePage {
  return {
    events: [],
    has_more: false,
    next_event_sequence: null,
    total_count: 0,
    unacknowledged_count: 0,
  };
}

/* ------------------------------------------------------------------ *
 * 配置归一化与 MQTT
 * ------------------------------------------------------------------ */

function normalizeCalcGroupConfig(config: CalcGroupConfig): CalcGroupConfig {
  return {
    ...clone(config),
    trigger_mode: config.trigger_mode ?? 0,
    period_ms: config.period_ms ?? 0,
    items: clone(config.items ?? []),
  };
}

function normalizeAgcGroupConfig(config: AgcGroupConfig): AgcGroupConfig {
  return normalizeAgcGroupConfigDecimalFields({
    ...clone(config),
    control_mode: config.control_mode ?? DEFAULT_AGC_CONTROL_MODE,
    calculation_execution_period_seconds:
      config.calculation_execution_period_seconds ?? DEFAULT_AGC_PERIOD_SECONDS,
    command_control_period_seconds:
      config.command_control_period_seconds ?? DEFAULT_AGC_COMMAND_PERIOD_SECONDS,
    members: clone(config.members ?? []),
  });
}

function normalizeAvcGroupConfig(config: AvcGroupConfig): AvcGroupConfig {
  return {
    ...clone(config),
    control_mode: config.control_mode ?? DEFAULT_AGC_CONTROL_MODE,
    calculation_execution_period_seconds:
      config.calculation_execution_period_seconds ?? DEFAULT_AGC_PERIOD_SECONDS,
    command_control_period_seconds:
      config.command_control_period_seconds ?? DEFAULT_AGC_COMMAND_PERIOD_SECONDS,
    members: clone(config.members ?? []),
  };
}

/** MQTT 配置：离线只存工作区，不连接 broker。 */
function updateMqttConfig(
  section: 'modbus_rtu' | 'dlt645',
  mqtt: ModbusMqttConfig | Dlt645MqttConfig,
): ModbusUpdateConfigResponse & Dlt645UpdateConfigResponse {
  mutateWorkspace((workspace) => {
    if (section === 'modbus_rtu') {
      workspace.config.modbus_rtu.mqtt = clone(mqtt as ModbusMqttConfig);
    } else {
      workspace.config.dlt645.mqtt = clone(mqtt as Dlt645MqttConfig);
    }

    return workspace;
  });

  return { ok: true, message: '离线工作区已保存 MQTT 配置（不会连接 broker）' };
}

function mqttConfigStatus(section: 'modbus_rtu' | 'dlt645'): ModbusMqttConfigStatus & Dlt645MqttConfigStatus {
  const { config } = getWorkspace();
  const mqtt = section === 'modbus_rtu' ? config.modbus_rtu.mqtt : config.dlt645.mqtt;

  return {
    configured: mqtt !== null,
    mqtt: mqtt ? clone(mqtt) : null,
    message: mqtt ? 'MQTT 配置已配置（离线工作区）' : 'MQTT 配置未配置',
  };
}

/** 计算项信息：离线没有实时数据，输入恒为未就绪。 */
function buildCalcItems(config: CalcGroupConfig): CalcItemInfo[] {
  return (config.items ?? []).map((item) => {
    const itemName = String(item.item_name ?? '');
    const isAggregate = CALC_AGGREGATE_OPERATOR_KINDS.includes(Number(item.operator_kind));
    const operands = item.operands ?? [];
    const leftInputTag = isAggregate ? '' : `${itemName}/left_input`;
    const rightInputTag = isAggregate ? '' : `${itemName}/right_input`;
    const inputTags = isAggregate
      ? operands.map((_, index) => `${itemName}/input_${index + 1}`)
      : [leftInputTag, rightInputTag];
    const operandStatus: CalcOperandStatus[] = inputTags.map((inputTag, index) => ({
      index,
      input_tag: inputTag,
      ready: false,
      reason: '离线工作区没有实时数据',
      quality: 0,
      ts_ms: 0,
    }));

    return {
      config: clone(item),
      left_input_tag: leftInputTag,
      right_input_tag: rightInputTag,
      result_tag: `${itemName}/result`,
      input_tags: inputTags,
      operand_status: operandStatus,
      last_error: inputTags.length > 0
        ? `item_name=${itemName} 等待输入: ${inputTags.join(', ')}（离线工作区无实时数据）`
        : '',
    };
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
