export type {
  AppUpdateDownloadEvent,
  AppUpdateInfo,
  AppUpdateStatus,
  AppUpdateStatusKind,
  AppSettingsMap,
  CacheClearResult,
  LowerUpdateChannel,
  LowerUpdateDownloadProgress,
  LowerUpdateDownloadResult,
  LowerUpdateDownloadStage,
  LowerUpdateInstallRequest,
  LowerUpdateInstallResult,
  LowerUpdateManifest,
  LowerUpdateRuntimeInfo,
  LowerUpdateRuntimeInfoRequest,
  LowerUpdateSshAuth,
  LowerUpdateUploadProgress,
  LowerUpdateUploadRequest,
  LowerUpdateUploadResult,
  LowerUpdateUploadStage,
  ModuleDependency,
  ModuleInfo,
  ModuleRunningInfo,
  ModuleVersion,
  RuntimeDirectoryKind,
  RuntimePaths,
} from './types';
export type {
  Iec104ApciParameters,
  Iec104Endpoint,
  Iec104LinkConfig,
  Iec104LinkInfo,
  Iec104Point,
  Iec104PointTable,
} from './types';
export type {
  ModbusLinkConfig,
  ModbusLinkInfo,
  ModbusMqttConfig,
  ModbusPoint,
  ModbusPointTable,
  ModbusReadBlock,
  ModbusReadPlan,
  ModbusSerialConfig,
  ModbusUpdateConfigResponse,
} from './types';
export type {
  Dlt645Block,
  Dlt645BlockItem,
  Dlt645LinkConfig,
  Dlt645LinkInfo,
  Dlt645MqttConfig,
  Dlt645Point,
  Dlt645PointTable,
  Dlt645UpdateConfigResponse,
} from './types';
export type {
  DcConnTags,
  DcConnectionInfo,
  DcEndpoint,
  DcPointUpdate,
  DcPointValue,
  DcRoute,
} from './types';
export type {
  AvcDefaultPointInfo,
  AvcGroupConfig,
  AvcGroupInfo,
  AvcMemberConfig,
  AvcSignalSpec,
  AvcStrategyConfig,
  AvcValueSpec,
  AvcVoltageControlConfig,
  ConfigExportMetadata,
  ConfigExportSectionId,
  AgcDerivedOutputs,
  AgcExportTask,
  AgcGroupConfig,
  AgcGroupInfo,
  AgcMemberConfig,
  AgcSignalSpec,
  AgcStrategyConfig,
  AgcValueSpec,
  Dlt645ExportTask,
  FullConfigExportSnapshot,
  Iec104ExportTask,
  ModbusRtuExportTask,
  StableDataBusEndpoint,
  StableDataBusRoute,
} from './types';
import { browserApi } from './browser';
import { api as tauriApi } from './tauri';

function hasTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const api: typeof tauriApi = hasTauriRuntime() ? tauriApi : browserApi;
