export type {
  AppUpdateDownloadEvent,
  AppUpdateInfo,
  AppUpdateStatus,
  AppUpdateStatusKind,
  AppSettingsMap,
  CacheClearResult,
  LowerUpdateChannel,
  LowerUpdateCachedPackage,
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
  VerticalSecurityDeployRequest,
  VerticalSecurityDeployResult,
  VerticalSecurityStatusRequest,
  VerticalSecurityStatusResult,
  VerticalSecurityStepResult,
  VerticalSecurityStepState,
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
  Iec104SimulationPoint,
  Iec104SimulationSnapshot,
  Iec104SimulationGenerateOptions,
  Iec104SimulationMode,
  Iec104SimulationBoolMode,
  Iec104SoeRecord,
  Iec104SoeQuery,
  Iec104SoePage,
} from './types';
export type {
  Iec61850ChannelInfo,
  Iec61850IedConfig,
  Iec61850IedInfo,
  Iec61850ImportResult,
  Iec61850ModelSummary,
  Iec61850SclConnectedApSummary,
  Iec61850SclAccessPointSummary,
  Iec61850SclIedSummary,
  Iec61850NetworkChannelConfig,
  Iec61850PointMapping,
  Iec61850PointMappings,
  Iec61850ProtectionRule,
  Iec61850RuntimeStatistics,
  Iec61850ValidationIssue,
} from './types';
export type {
  ModbusLinkConfig,
  ModbusLinkInfo,
  ModbusMqttConfig,
  ModbusMqttConfigStatus,
  ModbusPoint,
  ModbusPointTable,
  ModbusReadBlock,
  ModbusReadPlan,
  ModbusSerialConfig,
  ModbusUpdateConfigResponse,
  ModbusTcpConfig,
  ModbusTcpLinkConfig,
  ModbusTcpLinkInfo,
} from './types';
export type {
  Dlt645Block,
  Dlt645BlockItem,
  Dlt645LinkConfig,
  Dlt645LinkInfo,
  Dlt645MqttConfig,
  Dlt645MqttConfigStatus,
  Dlt645Point,
  Dlt645PointTable,
  Dlt645UpdateConfigResponse,
} from './types';
export type {
  DcConnTags,
  DcConnectionInfo,
  DcEndpoint,
  DcPointUpdate,
  DcSourcePointUpdate,
  DcPointValue,
  DcRoute,
  DataBusThroughputSample,
  DataBusThroughputSnapshot,
  DataBusThroughputSource,
  ControlOrchestratorCommandStep,
  ControlOrchestratorStepVerification,
  ControlOrchestratorFailureAction,
  ControlOrchestratorWorkflowConfig,
  ControlOrchestratorExecuteRequest,
  ControlOrchestratorExecuteResponse,
} from './types';
export type {
  CalcGroupConfig,
  CalcGroupInfo,
  CalcItemConfig,
  CalcItemInfo,
  CalcOperandStatus,
  CalcOperandSpec,
  CalcTypedConstant,
} from './types';
export type {
  AgcDefaultPointInfo,
  AgcControlProfile,
  AgcMemberControlProfile,
  AgcTuningConfig,
  AgcTuningStatus,
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
  CalcExportTask,
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
  ModbusTcpExportTask,
  StableDataBusEndpoint,
  StableDataBusConnection,
  StableDataBusConnTags,
  StableDataBusRoute,
} from './types';
import { createWorkspaceApi } from '../offline/adapter/workspace-api.ts';
import { getAppMode } from '../offline/mode.ts';
import { browserApi } from './browser';
import { api as tauriApi } from './tauri';

function hasTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

let workspaceApi: typeof tauriApi | null = null;

/**
 * 按当前运行模式解析实际实现。
 *
 * 在线模式与改造前完全一致（就是 tauriApi）；离线工作区只在桌面端生效，
 * 浏览器开发模式仍然使用内存 mock。
 */
export function resolveApiImplementation(): typeof tauriApi {
  if (!hasTauriRuntime()) {
    return browserApi;
  }

  if (getAppMode() === 'offline') {
    workspaceApi ??= createWorkspaceApi();

    return workspaceApi;
  }

  return tauriApi;
}

/**
 * 端口代理：页面继续 `api.xxx()` 调用，实现在访问时按模式分发。
 * 这样离线模式不需要修改任何页面的取数方式。
 */
export const api: typeof tauriApi = new Proxy({} as typeof tauriApi, {
  get(_target, property) {
    if (typeof property !== 'string') {
      return undefined;
    }

    const implementation = resolveApiImplementation() as unknown as Record<string, unknown>;
    const value = implementation[property];

    return typeof value === 'function' ? value.bind(implementation) : value;
  },
});
