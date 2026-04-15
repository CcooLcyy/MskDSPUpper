import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';
import type {
  AgcGroupConfig,
  AgcGroupInfo,
  AppUpdateDownloadEvent,
  AppUpdateInfo,
  DcConnTags,
  DcConnectionInfo,
  DcPointUpdate,
  DcRoute,
  Dlt645Block,
  Dlt645LinkConfig,
  Dlt645LinkInfo,
  Dlt645MqttConfig,
  Dlt645Point,
  Dlt645PointTable,
  Dlt645UpdateConfigResponse,
  FullConfigExportSnapshot,
  Iec104LinkConfig,
  Iec104LinkInfo,
  Iec104Point,
  Iec104PointTable,
  ModbusLinkConfig,
  ModbusLinkInfo,
  ModbusMqttConfig,
  ModbusPoint,
  ModbusPointTable,
  ModbusUpdateConfigResponse,
  ModuleInfo,
  ModuleRunningInfo,
} from './types';

type PendingAppUpdate = Awaited<ReturnType<typeof check>>;

let pendingAppUpdate: PendingAppUpdate = null;

async function disposePendingAppUpdate() {
  if (!pendingAppUpdate) {
    return;
  }

  const update = pendingAppUpdate;
  pendingAppUpdate = null;

  try {
    await update.close();
  } catch {
    // Best-effort resource cleanup for repeated checks.
  }
}

function toAppUpdateInfo(update: NonNullable<PendingAppUpdate>): AppUpdateInfo {
  return {
    currentVersion: update.currentVersion,
    version: update.version,
    date: update.date,
    body: update.body,
    rawJson: update.rawJson as Record<string, unknown>,
  };
}

export const api = {
  setManagerAddr: (addr: string) => invoke<void>('set_manager_addr', { addr }),
  getModuleInfo: () => invoke<ModuleInfo[]>('get_module_info'),
  getRunningModuleInfo: () => invoke<ModuleRunningInfo[]>('get_running_module_info'),
  startModule: (moduleInfo: ModuleInfo) => invoke<void>('start_module', { moduleInfo }),
  stopModule: (moduleInfo: ModuleInfo) => invoke<void>('stop_module', { moduleInfo }),

  getAppVersion: () => getVersion(),
  checkAppUpdate: async (): Promise<AppUpdateInfo | null> => {
    await disposePendingAppUpdate();

    const update = await check();
    pendingAppUpdate = update;

    return update ? toAppUpdateInfo(update) : null;
  },
  downloadAndInstallAppUpdate: async (
    onEvent?: (event: AppUpdateDownloadEvent) => void,
  ): Promise<AppUpdateInfo> => {
    const update = pendingAppUpdate ?? (await check());

    if (!update) {
      throw new Error('No update available');
    }

    pendingAppUpdate = update;

    try {
      await update.downloadAndInstall((event) => {
        onEvent?.(event as AppUpdateDownloadEvent);
      });

      return toAppUpdateInfo(update);
    } finally {
      if (pendingAppUpdate === update) {
        pendingAppUpdate = null;
      }

      try {
        await update.close();
      } catch {
        // Windows install may terminate the app mid-flow, so cleanup is best-effort.
      }
    }
  },
  relaunchApp: () => relaunch(),
  disposePendingAppUpdate,

  iec104UpsertLink: (config: Iec104LinkConfig, createOnly: boolean) =>
    invoke<Iec104LinkInfo>('iec104_upsert_link', { config, createOnly }),
  iec104RenameLink: (oldConnName: string, newConnName: string) =>
    invoke<Iec104LinkInfo>('iec104_rename_link', { oldConnName, newConnName }),
  iec104GetLink: (connName: string) =>
    invoke<Iec104LinkInfo>('iec104_get_link', { connName }),
  iec104ListLinks: () => invoke<Iec104LinkInfo[]>('iec104_list_links'),
  iec104DeleteLink: (connName: string) =>
    invoke<void>('iec104_delete_link', { connName }),
  iec104StartLink: (connName: string) =>
    invoke<void>('iec104_start_link', { connName }),
  iec104StopLink: (connName: string) =>
    invoke<void>('iec104_stop_link', { connName }),
  iec104UpsertPointTable: (connName: string, points: Iec104Point[], replace: boolean) =>
    invoke<void>('iec104_upsert_point_table', { connName, points, replace }),
  iec104GetPointTable: (connName: string) =>
    invoke<Iec104PointTable>('iec104_get_point_table', { connName }),
  iec104SendTimeSync: (connName: string, tsMs: number) =>
    invoke<void>('iec104_send_time_sync', { connName, tsMs }),

  modbusRtuUpdateConfig: (mqtt: ModbusMqttConfig) =>
    invoke<ModbusUpdateConfigResponse>('modbus_rtu_update_config', { mqtt }),
  modbusRtuUpsertLink: (config: ModbusLinkConfig, createOnly: boolean) =>
    invoke<ModbusLinkInfo>('modbus_rtu_upsert_link', { config, createOnly }),
  modbusRtuRenameLink: (oldConnName: string, newConnName: string) =>
    invoke<ModbusLinkInfo>('modbus_rtu_rename_link', { oldConnName, newConnName }),
  modbusRtuGetLink: (connName: string) =>
    invoke<ModbusLinkInfo>('modbus_rtu_get_link', { connName }),
  modbusRtuListLinks: () => invoke<ModbusLinkInfo[]>('modbus_rtu_list_links'),
  modbusRtuDeleteLink: (connName: string) =>
    invoke<void>('modbus_rtu_delete_link', { connName }),
  modbusRtuStartLink: (connName: string) =>
    invoke<void>('modbus_rtu_start_link', { connName }),
  modbusRtuStopLink: (connName: string) =>
    invoke<void>('modbus_rtu_stop_link', { connName }),
  modbusRtuUpsertPointTable: (connName: string, points: ModbusPoint[], replace: boolean) =>
    invoke<void>('modbus_rtu_upsert_point_table', { connName, points, replace }),
  modbusRtuGetPointTable: (connName: string) =>
    invoke<ModbusPointTable>('modbus_rtu_get_point_table', { connName }),

  dlt645UpdateConfig: (mqtt: Dlt645MqttConfig) =>
    invoke<Dlt645UpdateConfigResponse>('dlt645_update_config', { mqtt }),
  dlt645UpsertLink: (config: Dlt645LinkConfig, createOnly: boolean) =>
    invoke<Dlt645LinkInfo>('dlt645_upsert_link', { config, createOnly }),
  dlt645RenameLink: (oldConnName: string, newConnName: string) =>
    invoke<Dlt645LinkInfo>('dlt645_rename_link', { oldConnName, newConnName }),
  dlt645GetLink: (connName: string) =>
    invoke<Dlt645LinkInfo>('dlt645_get_link', { connName }),
  dlt645ListLinks: () => invoke<Dlt645LinkInfo[]>('dlt645_list_links'),
  dlt645DeleteLink: (connName: string) =>
    invoke<void>('dlt645_delete_link', { connName }),
  dlt645StartLink: (connName: string) =>
    invoke<void>('dlt645_start_link', { connName }),
  dlt645StopLink: (connName: string) =>
    invoke<void>('dlt645_stop_link', { connName }),
  dlt645UpsertPointTable: (
    connName: string,
    points: Dlt645Point[],
    blocks: Dlt645Block[],
    replace: boolean,
  ) => invoke<void>('dlt645_upsert_point_table', { connName, points, blocks, replace }),
  dlt645GetPointTable: (connName: string) =>
    invoke<Dlt645PointTable>('dlt645_get_point_table', { connName }),

  dcListConnections: () => invoke<DcConnectionInfo[]>('dc_list_connections'),
  dcGetConnTags: (connId: number) =>
    invoke<DcConnTags>('dc_get_conn_tags', { connId }),
  dcListRoutes: (srcConnId: number, srcTag: string, dstConnId: number, dstTag: string) =>
    invoke<DcRoute[]>('dc_list_routes', { srcConnId, srcTag, dstConnId, dstTag }),
  dcUpsertRoutes: (routes: DcRoute[], replace: boolean) =>
    invoke<void>('dc_upsert_routes', { routes, replace }),
  dcDeleteRoutes: (routes: DcRoute[]) =>
    invoke<void>('dc_delete_routes', { routes }),
  dcGetLatest: (connId: number, tags: string[]) =>
    invoke<DcPointUpdate[]>('dc_get_latest', { connId, tags }),
  dcStartProtocolShadowStream: () =>
    invoke<void>('dc_start_protocol_shadow_stream'),
  dcGetProtocolShadowLatest: (sourceConnId: number, sourceTags: string[]) =>
    invoke<DcPointUpdate[]>('dc_get_protocol_shadow_latest', { sourceConnId, sourceTags }),

  agcUpsertGroup: (config: AgcGroupConfig, createOnly: boolean) =>
    invoke<AgcGroupInfo>('agc_upsert_group', { config, createOnly }),
  agcGetGroup: (groupName: string) =>
    invoke<AgcGroupInfo>('agc_get_group', { groupName }),
  agcListGroups: () => invoke<AgcGroupInfo[]>('agc_list_groups'),
  agcDeleteGroup: (groupName: string) =>
    invoke<void>('agc_delete_group', { groupName }),
  agcStartGroup: (groupName: string) =>
    invoke<void>('agc_start_group', { groupName }),
  agcStopGroup: (groupName: string) =>
    invoke<void>('agc_stop_group', { groupName }),

  saveFullConfigExport: (filePath: string, snapshot: FullConfigExportSnapshot) =>
    invoke<string>('save_full_config_export', { filePath, snapshot }),
  loadFullConfigExport: (filePath: string) =>
    invoke<FullConfigExportSnapshot>('load_full_config_export', { filePath }),
};
