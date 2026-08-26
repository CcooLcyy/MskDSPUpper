import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';
import type {
  AgcControlProfile,
  AgcGroupConfig,
  AgcGroupInfo,
  AgcTuningConfig,
  AgcTuningStatus,
  AppUpdateDownloadEvent,
  AppUpdateInfo,
  AppSettingsMap,
  AvcGroupConfig,
  AvcGroupInfo,
  DcConnTags,
  DcConnectionInfo,
  DcPointUpdate,
  DcSourcePointUpdate,
  DcRoute,
  DataBusThroughputSnapshot,
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
  Iec104SimulationSnapshot,
  Iec104SimulationGenerateOptions,
  Iec61850IedConfig,
  Iec61850IedInfo,
  Iec61850ImportResult,
  Iec61850ModelSummary,
  Iec61850PointMapping,
  Iec61850PointMappings,
  Iec61850RuntimeStatistics,
  LowerUpdateChannel,
  LowerUpdateCachedPackage,
  LowerUpdateDownloadProgress,
  LowerUpdateDownloadResult,
  LowerUpdateInstallRequest,
  LowerUpdateInstallResult,
  LowerUpdateManifest,
  LowerUpdateRuntimeInfo,
  LowerUpdateRuntimeInfoRequest,
  LowerUpdateUploadProgress,
  LowerUpdateUploadRequest,
  LowerUpdateUploadResult,
  VerticalSecurityDeployRequest,
  VerticalSecurityDeployResult,
  VerticalSecurityStatusRequest,
  VerticalSecurityStatusResult,
  ModbusLinkConfig,
  ModbusLinkInfo,
  ModbusMqttConfig,
  ModbusPoint,
  ModbusPointTable,
  ModbusUpdateConfigResponse,
  ModuleInfo,
  ModuleRunningInfo,
  RuntimeDirectoryKind,
  RuntimePaths,
  CacheClearResult,
  CalcGroupConfig,
  CalcGroupInfo,
} from './types';
import { getLowerUpdateStaticBaseUrl } from './lower-update-source';

type PendingAppUpdate = Awaited<ReturnType<typeof check>>;

let pendingAppUpdate: PendingAppUpdate = null;
let downloadedAppUpdate: PendingAppUpdate = null;
const LOWER_UPDATE_DOWNLOAD_PROGRESS_EVENT = 'lower-update-download-progress';
const LOWER_UPDATE_UPLOAD_PROGRESS_EVENT = 'lower-update-upload-progress';

async function disposePendingAppUpdate() {
  const updates = [pendingAppUpdate, downloadedAppUpdate].filter(
    (update, index, all): update is NonNullable<PendingAppUpdate> => Boolean(update) && all.indexOf(update) === index,
  );
  pendingAppUpdate = null;
  downloadedAppUpdate = null;

  if (updates.length === 0) {
    return;
  }

  for (const update of updates) {
    try {
      await update.close();
    } catch {
      // 更新资源清理失败不影响后续检查。
    }
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

async function downloadAppUpdate(
  onEvent?: (event: AppUpdateDownloadEvent) => void,
): Promise<AppUpdateInfo> {
  const update = pendingAppUpdate ?? (await check());

  if (!update) {
    throw new Error('没有可下载的客户端更新');
  }

  pendingAppUpdate = update;
  try {
    await update.download((event) => {
      onEvent?.(event as AppUpdateDownloadEvent);
    });
    downloadedAppUpdate = update;
    return toAppUpdateInfo(update);
  } catch (error) {
    downloadedAppUpdate = null;
    throw error;
  }
}

async function installAppUpdate(): Promise<AppUpdateInfo> {
  const update = downloadedAppUpdate;
  if (!update) {
    throw new Error('没有已下载的客户端更新包');
  }

  try {
    await update.install();
    return toAppUpdateInfo(update);
  } finally {
    if (pendingAppUpdate === update) {
      pendingAppUpdate = null;
    }
    if (downloadedAppUpdate === update) {
      downloadedAppUpdate = null;
    }

    try {
      await update.close();
    } catch {
      // 安装可能触发进程退出，资源清理失败可忽略。
    }
  }
}

async function downloadAndInstallAppUpdate(
  onEvent?: (event: AppUpdateDownloadEvent) => void,
): Promise<AppUpdateInfo> {
  await downloadAppUpdate(onEvent);
  return installAppUpdate();
}

export const api = {
  loadAppSettings: () => invoke<AppSettingsMap>('load_app_settings'),
  migrateLegacyAppSettings: (legacy: AppSettingsMap) =>
    invoke<AppSettingsMap>('migrate_legacy_app_settings', { legacy }),
  saveAppSetting: (key: string, value: unknown) =>
    invoke<void>('save_app_setting', { key, value }),
  getRuntimePaths: () => invoke<RuntimePaths>('get_runtime_paths'),
  openRuntimeDirectory: (kind: RuntimeDirectoryKind) =>
    invoke<void>('open_runtime_directory', { kind }),
  clearLowerUpdateCache: () => invoke<CacheClearResult>('clear_lower_update_cache'),
  listCachedLowerUpdates: (channel?: LowerUpdateChannel) =>
    invoke<LowerUpdateCachedPackage[]>('list_cached_lower_updates', { channel: channel ?? null }),

  setManagerAddr: (addr: string, forceReconnect = false) =>
    invoke<void>('set_manager_addr', { addr, forceReconnect }),
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
  downloadAppUpdate,
  installAppUpdate,
  // 保留旧适配器接口，供外部集成在升级期间平滑迁移。
  downloadAndInstallAppUpdate,
  relaunchApp: () => relaunch(),
  disposePendingAppUpdate,
  checkLowerUpdate: (channel: LowerUpdateChannel) =>
    invoke<LowerUpdateManifest>('check_lower_update', {
      channel,
      baseUrl: getLowerUpdateStaticBaseUrl(),
    }),
  downloadLowerUpdate: async (
    manifest: LowerUpdateManifest,
    onProgress?: (progress: LowerUpdateDownloadProgress) => void,
  ): Promise<LowerUpdateDownloadResult> => {
    const unlisten = onProgress
      ? await listen<LowerUpdateDownloadProgress>(LOWER_UPDATE_DOWNLOAD_PROGRESS_EVENT, (event) => {
          onProgress(event.payload);
        })
      : null;

    try {
      return await invoke<LowerUpdateDownloadResult>('download_lower_update', { manifest });
    } finally {
      unlisten?.();
    }
  },
  uploadLowerUpdatePackage: async (
    request: LowerUpdateUploadRequest,
    onProgress?: (progress: LowerUpdateUploadProgress) => void,
  ): Promise<LowerUpdateUploadResult> => {
    const unlisten = onProgress
      ? await listen<LowerUpdateUploadProgress>(LOWER_UPDATE_UPLOAD_PROGRESS_EVENT, (event) => {
          onProgress(event.payload);
        })
      : null;

    try {
      return await invoke<LowerUpdateUploadResult>('upload_lower_update_package', { request });
    } finally {
      unlisten?.();
    }
  },
  installLowerUpdatePackage: (request: LowerUpdateInstallRequest) =>
    invoke<LowerUpdateInstallResult>('install_lower_update_package', { request }),
  getLowerUpdateRuntimeInfo: (request: LowerUpdateRuntimeInfoRequest) =>
    invoke<LowerUpdateRuntimeInfo>('get_lower_update_runtime_info', { request }),
  getLowerUpdatePassword: (uploadAccount: string) =>
    invoke<string | null>('get_lower_update_password', { uploadAccount }),
  clearLowerUpdatePassword: (uploadAccount: string) =>
    invoke<void>('clear_lower_update_password', { uploadAccount }),
  deployVerticalSecurityScript: (request: VerticalSecurityDeployRequest) =>
    invoke<VerticalSecurityDeployResult>('deploy_vertical_security_script', { request }),
  getVerticalSecurityStatus: (request: VerticalSecurityStatusRequest) =>
    invoke<VerticalSecurityStatusResult>('get_vertical_security_status', { request }),

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
  iec104GenerateSimulationValues: (connName: string, options: Iec104SimulationGenerateOptions) =>
    invoke<Iec104SimulationSnapshot>('iec104_generate_simulation_values', {
      connName,
      mode: options.mode,
      boolMode: options.boolMode,
    }),
  iec104GetSimulationSnapshot: (connName: string) =>
    invoke<Iec104SimulationSnapshot>('iec104_get_simulation_snapshot', { connName }),
  iec104ApplySimulationValues: (connName: string) =>
    invoke<void>('iec104_apply_simulation_values', { connName }),
  iec104ClearSimulationValues: (connName: string) =>
    invoke<void>('iec104_clear_simulation_values', { connName }),

  iec61850ImportScl: (modelName: string, sourceName: string, content: number[], validateOnly: boolean, replace: boolean) =>
    invoke<Iec61850ImportResult>('iec61850_import_scl', {
      modelName,
      sourceName,
      content,
      validateOnly,
      replace,
    }),
  iec61850ListModels: () => invoke<Iec61850ModelSummary[]>('iec61850_list_models'),
  iec61850DeleteModel: (modelName: string) =>
    invoke<void>('iec61850_delete_model', { modelName }),
  iec61850UpsertIed: (config: Iec61850IedConfig, createOnly: boolean) =>
    invoke<Iec61850IedInfo>('iec61850_upsert_ied', { config, createOnly }),
  iec61850GetIed: (connName: string) =>
    invoke<Iec61850IedInfo>('iec61850_get_ied', { connName }),
  iec61850ListIeds: () => invoke<Iec61850IedInfo[]>('iec61850_list_ieds'),
  iec61850DeleteIed: (connName: string) =>
    invoke<void>('iec61850_delete_ied', { connName }),
  iec61850StartIed: (connName: string) =>
    invoke<void>('iec61850_start_ied', { connName }),
  iec61850StopIed: (connName: string) =>
    invoke<void>('iec61850_stop_ied', { connName }),
  iec61850UpsertPointMappings: (connName: string, points: Iec61850PointMapping[], replace: boolean) =>
    invoke<void>('iec61850_upsert_point_mappings', { connName, points, replace }),
  iec61850GetPointMappings: (connName: string) =>
    invoke<Iec61850PointMappings>('iec61850_get_point_mappings', { connName }),
  iec61850GetRuntimeStatistics: (connName: string) =>
    invoke<Iec61850RuntimeStatistics>('iec61850_get_runtime_statistics', { connName }),

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
  dcGetSourceLatest: (connId: number, tags: string[]) =>
    invoke<DcSourcePointUpdate[]>('dc_get_source_latest', { connId, tags }),
  getDataBusThroughputSnapshot: async (): Promise<DataBusThroughputSnapshot> => {
    const snapshot = await invoke<Omit<DataBusThroughputSnapshot, 'source'>>(
      'dc_get_throughput_snapshot',
    );
    return {
      source: 'backend',
      process_start_time_ms:
        snapshot.process_start_time_ms !== null && snapshot.process_start_time_ms > 0
          ? snapshot.process_start_time_ms
          : null,
      samples: snapshot.samples,
      current_points_per_second: snapshot.current_points_per_second,
      peak_points_per_second: snapshot.peak_points_per_second,
      updated_at_ms:
        snapshot.updated_at_ms !== null && snapshot.updated_at_ms > 0
          ? snapshot.updated_at_ms
          : null,
    };
  },

  calcUpsertGroup: (config: CalcGroupConfig, createOnly: boolean) =>
    invoke<CalcGroupInfo>('calc_upsert_group', { config, createOnly }),
  calcRenameGroup: (oldGroupName: string, newGroupName: string) =>
    invoke<CalcGroupInfo>('calc_rename_group', { oldGroupName, newGroupName }),
  calcGetGroup: (groupName: string) =>
    invoke<CalcGroupInfo>('calc_get_group', { groupName }),
  calcListGroups: () => invoke<CalcGroupInfo[]>('calc_list_groups'),
  calcDeleteGroup: (groupName: string) =>
    invoke<void>('calc_delete_group', { groupName }),
  calcStartGroup: (groupName: string) =>
    invoke<void>('calc_start_group', { groupName }),
  calcStopGroup: (groupName: string) =>
    invoke<void>('calc_stop_group', { groupName }),

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
  agcStartTuning: (groupName: string, config: AgcTuningConfig) =>
    invoke<AgcTuningStatus>('agc_start_tuning', { groupName, config }),
  agcStopTuning: (groupName: string) =>
    invoke<AgcTuningStatus>('agc_stop_tuning', { groupName }),
  agcGetTuningStatus: (groupName: string) =>
    invoke<AgcTuningStatus>('agc_get_tuning_status', { groupName }),
  agcGetControlProfile: (groupName: string) =>
    invoke<AgcControlProfile>('agc_get_control_profile', { groupName }),
  agcConfirmControlProfile: (profile: AgcControlProfile) =>
    invoke<AgcControlProfile>('agc_confirm_control_profile', { profile }),

  avcUpsertGroup: (config: AvcGroupConfig, createOnly: boolean) =>
    invoke<AvcGroupInfo>('avc_upsert_group', { config, createOnly }),
  avcRenameGroup: (oldGroupName: string, newGroupName: string) =>
    invoke<AvcGroupInfo>('avc_rename_group', { oldGroupName, newGroupName }),
  avcGetGroup: (groupName: string) =>
    invoke<AvcGroupInfo>('avc_get_group', { groupName }),
  avcListGroups: () => invoke<AvcGroupInfo[]>('avc_list_groups'),
  avcDeleteGroup: (groupName: string) =>
    invoke<void>('avc_delete_group', { groupName }),
  avcStartGroup: (groupName: string) =>
    invoke<void>('avc_start_group', { groupName }),
  avcStopGroup: (groupName: string) =>
    invoke<void>('avc_stop_group', { groupName }),

  saveFullConfigExport: (filePath: string, snapshot: FullConfigExportSnapshot) =>
    invoke<string>('save_full_config_export', { filePath, snapshot }),
  saveVerticalSecurityScript: (filePath: string, content: string) =>
    invoke<string>('save_vertical_security_script', { filePath, content }),
  loadFullConfigExport: (filePath: string) =>
    invoke<FullConfigExportSnapshot>('load_full_config_export', { filePath }),
};
