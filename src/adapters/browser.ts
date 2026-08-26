import type { api as tauriApi } from './tauri';
import type {
  AgcControlProfile,
  AgcDefaultPointInfo,
  AgcGroupConfig,
  AgcGroupInfo,
  AgcTuningConfig,
  AgcTuningStatus,
  AppUpdateDownloadEvent,
  AppSettingsMap,
  CalcGroupConfig,
  CalcGroupInfo,
  CalcItemInfo,
  CalcOperandSpec,
  CalcOperandStatus,
  AvcDefaultPointInfo,
  AvcGroupConfig,
  AvcGroupInfo,
  DcConnTags,
  DcConnectionInfo,
  DcPointUpdate,
  DcSourcePointUpdate,
  DcPointValue,
  DcRoute,
  DataBusThroughputSample,
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
  LowerUpdateUploadProgress,
  LowerUpdateUploadRequest,
  LowerUpdateUploadResult,
  VerticalSecurityDeployRequest,
  VerticalSecurityDeployResult,
  VerticalSecurityStatusResult,
  ModbusLinkConfig,
  ModbusLinkInfo,
  ModbusMqttConfig,
  ModbusPoint,
  ModbusPointTable,
  ModbusUpdateConfigResponse,
  ModuleInfo,
  ModuleRunningInfo,
  RuntimePaths,
} from './types';
import { buildLowerUpdateLatestUrl } from './lower-update-source';

const DEFAULT_MANAGER_ADDR = '127.0.0.1:17000';
const BROWSER_SETTINGS_KEY = 'mskdsp_browser_app_settings_v1';
const BROWSER_THROUGHPUT_HISTORY_SIZE = 48;

// IEC104 LinkState values mirror IEC104.proto.
const IEC104_LINK_STATE = {
  UNSPECIFIED: 0,
  STOPPED: 1,
  RUNNING: 2,
  PENDING_DELETE: 3,
} as const;

let managerAddr = DEFAULT_MANAGER_ADDR;
let nextConnId = 100;
const browserThroughputSamples: DataBusThroughputSample[] = [];
const browserThroughputProcessStartTime = Date.now();

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function loadBrowserSettings(): AppSettingsMap {
  try {
    const raw = localStorage.getItem(BROWSER_SETTINGS_KEY);
    return raw ? JSON.parse(raw) as AppSettingsMap : {};
  } catch {
    return {};
  }
}

function saveBrowserSettings(settings: AppSettingsMap): void {
  localStorage.setItem(BROWSER_SETTINGS_KEY, JSON.stringify(settings));
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function buildRemotePackagePath(installDir: string, packageName: string): string {
  const normalizedDir = installDir.trim().replace(/\/+$/, '') || '/';
  return normalizedDir === '/' ? `/${packageName}` : `${normalizedDir}/${packageName}`;
}

const moduleInfos: ModuleInfo[] = [
  makeModuleInfo('ModuleManager'),
  makeModuleInfo('DataCenter'),
  makeModuleInfo('IEC104'),
  makeModuleInfo('IEC61850'),
  makeModuleInfo('ModbusRTU'),
  makeModuleInfo('DLT645'),
  makeModuleInfo('AGC'),
  makeModuleInfo('AVC'),
  makeModuleInfo('Calc'),
  makeModuleInfo('MQTTManager'),
];

const runningModules = new Set(['ModuleManager', 'DataCenter', 'IEC104', 'IEC61850', 'ModbusRTU', 'DLT645', 'AGC', 'AVC', 'Calc']);
const iec104Links = new Map<string, Iec104LinkInfo>();
const iec104Tables = new Map<string, Iec104PointTable>();
const iec104Simulation = new Map<string, Iec104SimulationSnapshot>();
const modbusLinks = new Map<string, ModbusLinkInfo>();
const modbusTables = new Map<string, ModbusPointTable>();
const dlt645Links = new Map<string, Dlt645LinkInfo>();
const dlt645Tables = new Map<string, Dlt645PointTable>();
const iec61850Models = new Map<string, Iec61850ModelSummary>();
const iec61850Ieds = new Map<string, Iec61850IedInfo>();
const iec61850Mappings = new Map<string, Iec61850PointMappings>();
const agcGroups = new Map<string, AgcGroupInfo>();
const agcTuningStatuses = new Map<string, AgcTuningStatus>();
const avcGroups = new Map<string, AvcGroupInfo>();
const calcGroups = new Map<string, CalcGroupInfo>();
let routes: DcRoute[] = [];
let modbusMqtt: ModbusMqttConfig | null = null;
let dlt645Mqtt: Dlt645MqttConfig | null = null;
let browserLatestLowerManifest: LowerUpdateManifest | null = null;
let browserRunningLowerImageId = `sha256:${'0'.repeat(64)}`;
const browserCachedLowerPackages = new Map<LowerUpdateChannel, LowerUpdateCachedPackage>();
const exportSnapshots = new Map<string, FullConfigExportSnapshot>();

const IEC104_BUSINESS_TYPE_TELEINDICATION = 1;
const IEC104_BUSINESS_TYPE_TELEMETRY = 2;
const IEC104_BUSINESS_TYPE_REMOTE_ADJUST = 3;
const IEC104_BUSINESS_TYPE_REMOTE_CONTROL = 4;
const IEC104_BUSINESS_TYPE_PARAMETER = 5;

const inferIec104BusinessType = (point: Iec104Point): number => {
  if (point.business_type) return point.business_type;
  if (point.ioa >= 1 && point.ioa <= 0x4000) return IEC104_BUSINESS_TYPE_TELEINDICATION;
  if (point.ioa >= 0x4001 && point.ioa <= 0x5000) return IEC104_BUSINESS_TYPE_TELEMETRY;
  if (point.ioa >= 0x6001 && point.ioa <= 0x6100) return IEC104_BUSINESS_TYPE_REMOTE_CONTROL;
  if (point.ioa >= 0x6201 && point.ioa <= 0x6400) return IEC104_BUSINESS_TYPE_REMOTE_ADJUST;
  if (point.ioa >= 0xA000 && point.ioa <= 0xBFFF) return IEC104_BUSINESS_TYPE_PARAMETER;
  return 0;
};

const isIec104SimulationPoint = (point: Iec104Point): boolean => {
  const businessType = inferIec104BusinessType(point);
  return businessType === IEC104_BUSINESS_TYPE_TELEINDICATION
    || businessType === IEC104_BUSINESS_TYPE_TELEMETRY;
};

function makeModuleInfo(moduleName: string): ModuleInfo {
  return {
    module_name: moduleName,
    version: {
      major: '0',
      minor: '5',
      patch: '0',
      version: '0.5.0-dev',
    },
    lib_name: moduleName,
    dependencies: [],
    manifest_error: '',
  };
}

function makeRunningInfo(moduleName: string): ModuleRunningInfo {
  const index = Math.max(0, moduleInfos.findIndex((item) => item.module_name === moduleName));
  return {
    module_name: moduleName,
    version: makeModuleInfo(moduleName).version,
    lib_name: moduleName,
    inner_grpc_server: `unix:///tmp/mskdsp-${moduleName}.sock`,
    outer_grpc_server: moduleName === 'ModuleManager' ? managerAddr : `127.0.0.1:${17001 + index}`,
  };
}

function ensureUnique(createOnly: boolean, exists: boolean, name: string) {
  if (createOnly && exists) {
    throw new Error(`浏览器开发模式 mock 已存在: ${name}`);
  }
}

function nextId() {
  nextConnId += 1;
  return nextConnId;
}

function upsertByName<T extends { conn_id: number; state: number; last_error: string }>(
  store: Map<string, T>,
  name: string,
  createOnly: boolean,
  makeValue: (connId: number, previous?: T) => T,
) {
  const previous = store.get(name);
  ensureUnique(createOnly, Boolean(previous), name);
  const value = makeValue(previous?.conn_id ?? nextId(), previous);
  store.set(name, value);
  return clone(value);
}

function renameByName<T extends { config: { conn_name: string } | null }>(
  store: Map<string, T>,
  oldName: string,
  newName: string,
) {
  const value = store.get(oldName);
  if (!value) {
    throw new Error(`浏览器开发模式 mock 未找到: ${oldName}`);
  }
  if (store.has(newName)) {
    throw new Error(`浏览器开发模式 mock 已存在: ${newName}`);
  }
  store.delete(oldName);
  const renamed = clone(value);
  if (renamed.config) {
    renamed.config.conn_name = newName;
  }
  store.set(newName, renamed);
  return clone(renamed);
}

function deleteByName<T>(store: Map<string, T>, name: string) {
  store.delete(name);
}

function setLinkState<T extends { state: number }>(store: Map<string, T>, name: string, state: number) {
  const value = store.get(name);
  if (!value) {
    throw new Error(`浏览器开发模式 mock 未找到: ${name}`);
  }
  value.state = state;
}

function mergeByTag<T extends { tag: string }>(previous: T[], next: T[]) {
  const values = new Map(previous.map((item) => [item.tag, item]));
  next.forEach((item) => values.set(item.tag, item));
  return [...values.values()];
}

function connectionInfo(moduleName: string, connName: string, connId: number): DcConnectionInfo {
  return {
    module_name: moduleName,
    conn_name: connName,
    conn_id: connId,
  };
}

function listConnections(): DcConnectionInfo[] {
  return [
    ...[...iec104Links.values()].map((item) => connectionInfo('IEC104', item.config?.conn_name ?? '', item.conn_id)),
    ...[...iec61850Ieds.values()].map((item) => connectionInfo('IEC61850', item.config?.conn_name ?? '', item.conn_id)),
    ...[...modbusLinks.values()].map((item) => connectionInfo('ModbusRTU', item.config?.conn_name ?? '', item.conn_id)),
    ...[...dlt645Links.values()].map((item) => connectionInfo('DLT645', item.config?.conn_name ?? '', item.conn_id)),
    ...[...agcGroups.values()].map((item) => connectionInfo('AGC', item.config?.group_name ?? '', item.conn_id)),
    ...[...avcGroups.values()].map((item) => connectionInfo('AVC', item.config?.group_name ?? '', item.conn_id)),
    ...[...calcGroups.values()].map((item) => connectionInfo('Calc', item.config?.group_name ?? '', item.conn_id)),
  ].filter((item) => item.conn_name);
}

function collectSignalTag(signal: { tag: string } | null | undefined, tags: Set<string>) {
  if (signal?.tag) {
    tags.add(signal.tag);
  }
}

function collectValueSpec(value: { signal: { tag: string } | null; base_tag: string } | null | undefined, tags: Set<string>) {
  collectSignalTag(value?.signal, tags);
  if (value?.base_tag) {
    tags.add(value.base_tag);
  }
}

function tagsForConnection(connId: number): string[] {
  const iec104 = [...iec104Links.values()].find((item) => item.conn_id === connId);
  if (iec104?.config) {
    return (iec104Tables.get(iec104.config.conn_name)?.points ?? []).map((item) => item.tag);
  }

  const modbus = [...modbusLinks.values()].find((item) => item.conn_id === connId);
  if (modbus?.config) {
    return (modbusTables.get(modbus.config.conn_name)?.points ?? []).map((item) => item.tag);
  }

  const iec61850 = [...iec61850Ieds.values()].find((item) => item.conn_id === connId);
  if (iec61850?.config) {
    return (iec61850Mappings.get(iec61850.config.conn_name)?.points ?? []).map((item) => item.tag);
  }

  const dlt645 = [...dlt645Links.values()].find((item) => item.conn_id === connId);
  if (dlt645?.config) {
    const table = dlt645Tables.get(dlt645.config.conn_name);
    return [
      ...(table?.points ?? []).map((item) => item.tag),
      ...(table?.blocks ?? []).flatMap((block) => block.items.map((item) => item.tag)),
    ];
  }

  const agc = [...agcGroups.values()].find((item) => item.conn_id === connId);
  if (agc?.config) {
    const tags = new Set<string>();
    collectValueSpec(agc.config.p_cmd, tags);
    collectSignalTag(agc.config.outputs?.p_total_meas, tags);
    collectSignalTag(agc.config.outputs?.p_total_target, tags);
    collectSignalTag(agc.config.outputs?.p_total_error, tags);
    agc.default_points.forEach((point) => tags.add(point.tag));
    agc.config.members.forEach((member) => {
      collectSignalTag(member.p_meas, tags);
      collectValueSpec(member.p_set, tags);
    });
    return [...tags];
  }

  const avc = [...avcGroups.values()].find((item) => item.conn_id === connId);
  if (avc?.config) {
    const tags = new Set(avc.default_points.map((item) => item.tag));
    collectSignalTag(avc.config.voltage_meas, tags);
    collectSignalTag(avc.config.voltage_cmd, tags);
    collectValueSpec(avc.config.q_total_cmd, tags);
    avc.config.members.forEach((member) => {
      collectSignalTag(member.q_meas, tags);
      collectValueSpec(member.q_set, tags);
    });
    return [...tags];
  }

  const calc = [...calcGroups.values()].find((item) => item.conn_id === connId);
  if (calc?.items) {
    return calc.items.flatMap((item) => {
      // input_tags is authoritative for aggregate items. Keep the fallback for
      // values created by an older browser session before this field existed.
      const inputTags = item.input_tags?.length
        ? item.input_tags
        : [item.left_input_tag, item.right_input_tag];
      return [...inputTags, item.result_tag].filter(Boolean);
    });
  }

  return [];
}

function makePointValue(seed: number): DcPointValue {
  return {
    type: 'Double',
    value: Number((Math.sin(seed / 10) * 10 + 50).toFixed(3)),
  };
}

function getLatestUpdates(connId: number, tags: string[]): Promise<DcPointUpdate[]> {
  const activeTags = tags.length > 0 ? tags : tagsForConnection(connId);
  const ts = Date.now();
  return Promise.resolve(activeTags.map((tag, index) => ({
    src_conn_id: connId,
    src_tag: tag,
    dst_conn_id: connId,
    dst_tag: tag,
    value: makePointValue(ts / 1000 + index),
    ts_ms: ts,
    quality: 0,
  })));
}

function getSourceLatestUpdates(connId: number, tags: string[]): Promise<DcSourcePointUpdate[]> {
  const activeTags = tags.length > 0 ? tags : tagsForConnection(connId);
  const ts = Date.now();
  return Promise.resolve(activeTags.map((tag, index) => ({
    conn_id: connId,
    tag,
    value: makePointValue(ts / 1000 + index),
    ts_ms: ts,
    quality: 0,
    sequence: index + 1,
  })));
}

function getBrowserThroughputValue(timestamp: number): number {
  const seconds = timestamp / 1000;
  return Math.max(
    0,
    Math.round(110 + Math.sin(seconds / 7) * 16 + Math.sin(seconds / 2.4) * 5),
  );
}

function seedBrowserThroughputSamples(timestamp: number): void {
  if (browserThroughputSamples.length > 0) {
    return;
  }

  for (let index = BROWSER_THROUGHPUT_HISTORY_SIZE; index >= 1; index -= 1) {
    const sampleTimestamp = timestamp - index * 1000;
    browserThroughputSamples.push({
      timestamp_ms: sampleTimestamp,
      routed_points_per_second: getBrowserThroughputValue(sampleTimestamp),
    });
  }
}

function getBrowserThroughputSnapshot(): Promise<DataBusThroughputSnapshot> {
  const timestamp = Date.now();
  seedBrowserThroughputSamples(timestamp);
  const routedPointsPerSecond = getBrowserThroughputValue(timestamp);
  browserThroughputSamples.push({
    timestamp_ms: timestamp,
    routed_points_per_second: routedPointsPerSecond,
  });

  if (browserThroughputSamples.length > 60) {
    browserThroughputSamples.shift();
  }

  const samples = clone(browserThroughputSamples);
  return Promise.resolve({
    source: 'browser-demo',
    process_start_time_ms: browserThroughputProcessStartTime,
    samples,
    current_points_per_second: routedPointsPerSecond,
    peak_points_per_second: Math.max(...samples.map((sample) => sample.routed_points_per_second)),
    updated_at_ms: timestamp,
  });
}

function makeDefaultAgcPoints(): AgcDefaultPointInfo[] {
  return [
    { kind: 1, tag: '理论可调有功下限', name: '理论可调有功下限', description: '浏览器开发模式 mock 点' },
    { kind: 2, tag: '理论可调有功上限', name: '理论可调有功上限', description: '浏览器开发模式 mock 点' },
    { kind: 3, tag: '当前可调有功下限', name: '当前可调有功下限', description: '浏览器开发模式 mock 点' },
    { kind: 4, tag: '当前可调有功上限', name: '当前可调有功上限', description: '浏览器开发模式 mock 点' },
    { kind: 5, tag: '调节返回值', name: '调节返回值', description: '浏览器开发模式 mock 点' },
    { kind: 6, tag: 'AGC装机容量', name: 'AGC装机容量', description: '浏览器开发模式 mock 点' },
    { kind: 7, tag: 'AGC功能投入', name: 'AGC功能投入', description: '浏览器开发模式 mock 点' },
    { kind: 8, tag: 'AGC远方操作', name: 'AGC远方操作', description: '浏览器开发模式 mock 点' },
  ];
}

function makeDefaultAvcPoints(): AvcDefaultPointInfo[] {
  return [
    { kind: 1, tag: '理论可调无功下限', name: '理论可调无功下限', description: '浏览器开发模式 mock 点' },
    { kind: 2, tag: '理论可调无功上限', name: '理论可调无功上限', description: '浏览器开发模式 mock 点' },
    { kind: 3, tag: '当前可调无功下限', name: '当前可调无功下限', description: '浏览器开发模式 mock 点' },
    { kind: 4, tag: '当前可调无功上限', name: '当前可调无功上限', description: '浏览器开发模式 mock 点' },
    { kind: 5, tag: '调节返回值', name: '调节返回值', description: '浏览器开发模式 mock 点' },
    { kind: 6, tag: '当前电压', name: '当前电压', description: '浏览器开发模式 mock 点' },
    { kind: 7, tag: '总无功目标', name: '总无功目标', description: '浏览器开发模式 mock 点' },
    { kind: 8, tag: '总无功实测', name: '总无功实测', description: '浏览器开发模式 mock 点' },
    { kind: 9, tag: '总无功偏差', name: '总无功偏差', description: '浏览器开发模式 mock 点' },
    { kind: 10, tag: '电压偏差', name: '电压偏差', description: '浏览器开发模式 mock 点' },
    { kind: 11, tag: 'AVC功能投入', name: 'AVC功能投入', description: '浏览器开发模式 mock 点' },
    { kind: 12, tag: 'AVC远方操作', name: 'AVC远方操作', description: '浏览器开发模式 mock 点' },
  ];
}

function makeCalcItems(config: CalcGroupConfig): CalcItemInfo[] {
  return config.items.map((item) => {
    const isAggregate = item.operator_kind === 9 || item.operator_kind === 10;
    const operands = item.operands ?? [];
    const leftInputTag = isAggregate ? '' : `${item.item_name}/left_input`;
    const rightInputTag = isAggregate ? '' : `${item.item_name}/right_input`;
    const inputTags = isAggregate
      ? operands.map((_, index) => `${item.item_name}/input_${index + 1}`)
      : [leftInputTag, rightInputTag];
    const statusOperands: Array<{ operand: CalcOperandSpec | null | undefined; index: number; tag: string }> = isAggregate
      ? operands.map((operand, index) => ({ operand, index, tag: inputTags[index] }))
      : [
        { operand: item.left_operand, index: 0, tag: leftInputTag },
        ...(item.right_operand ? [{ operand: item.right_operand, index: 1, tag: rightInputTag }] : []),
      ];
    const operandStatus: CalcOperandStatus[] = statusOperands.map(({ operand, index, tag }) => {
      const isConstant = operand?.source_kind === 2;
      return {
        index,
        input_tag: tag,
        ready: isConstant,
        reason: isConstant ? '' : '尚未收到输入数据',
        quality: isConstant ? 1 : 0,
        ts_ms: 0,
      };
    });
    const missingTags = operandStatus.filter((status) => !status.ready).map((status) => status.input_tag);
    return {
      config: clone(item),
      left_input_tag: leftInputTag,
      right_input_tag: rightInputTag,
      result_tag: `${item.item_name}/result`,
      input_tags: inputTags,
      operand_status: operandStatus,
      last_error: missingTags.length > 0
        ? `item_name=${item.item_name} 等待输入: ${missingTags.join(', ')} 尚未收到数据`
        : '',
    };
  });
}

function seedDemoData() {
  // Keep the browser adapter useful as a small, multi-protocol playground.
  // The records intentionally cover stopped/running states, serial/MQTT
  // transports, scalar points, block points, and cross-module routes.
  const iecConfig: Iec104LinkConfig = {
    conn_name: '调度中心-IEC104',
    role: 1,
    local: { ip: '0.0.0.0', port: 2404 },
    remote: { ip: '127.0.0.1', port: 2404 },
    ca: 1,
    oa: 0,
    apci: { k: 12, w: 8, t0: 30, t1: 15, t2: 10, t3: 20 },
    point_batch_window_ms: 20,
    point_max_asdu_bytes: 240,
    point_use_standard_limit: true,
    point_dedupe: true,
    time_sync_tag: '时钟同步',
    station_role: 0,
    point_with_time: false,
  };
  iec104Links.set(iecConfig.conn_name, {
    config: iecConfig,
    conn_id: nextId(),
    state: IEC104_LINK_STATE.STOPPED,
    last_error: '',
  });
  iec104Tables.set(iecConfig.conn_name, {
    conn_name: iecConfig.conn_name,
    points: [
      { tag: '有功功率', ioa: 1001, point_type: 1, business_type: 2, scale: 1, offset: 0, deadband: 0 },
      { tag: '无功功率', ioa: 1002, point_type: 1, business_type: 2, scale: 1, offset: 0, deadband: 0 },
      { tag: '有功设定', ioa: 1101, point_type: 1, business_type: 3, scale: 1, offset: 0, deadband: 0 },
      { tag: '运行状态', ioa: 2001, point_type: 2, business_type: 1, scale: 1, offset: 0, deadband: 0 },
    ],
  });

  const iecSecondaryConfig: Iec104LinkConfig = {
    conn_name: '变电站-IEC104',
    role: 2,
    local: { ip: '192.168.10.20', port: 2404 },
    remote: { ip: '192.168.10.11', port: 2404 },
    ca: 2,
    oa: 1,
    apci: { k: 10, w: 6, t0: 30, t1: 15, t2: 10, t3: 20 },
    point_batch_window_ms: 50,
    point_max_asdu_bytes: 253,
    point_use_standard_limit: true,
    point_dedupe: false,
    time_sync_tag: '变电站时钟同步',
    station_role: 2,
    point_with_time: true,
  };
  const iecSecondaryId = nextId();
  iec104Links.set(iecSecondaryConfig.conn_name, {
    config: iecSecondaryConfig,
    conn_id: iecSecondaryId,
    state: IEC104_LINK_STATE.RUNNING,
    last_error: '',
  });
  iec104Tables.set(iecSecondaryConfig.conn_name, {
    conn_name: iecSecondaryConfig.conn_name,
    points: [
      { tag: '全站有功', ioa: 3001, point_type: 1, business_type: 2, scale: 1, offset: 0, deadband: 0.1 },
      { tag: '全站无功', ioa: 3002, point_type: 1, business_type: 2, scale: 1, offset: 0, deadband: 0.1 },
      { tag: '母线电压', ioa: 3003, point_type: 1, business_type: 2, scale: 0.001, offset: 0, deadband: 0.01 },
      { tag: '断路器状态', ioa: 4001, point_type: 2, business_type: 1, scale: 1, offset: 0, deadband: 0 },
    ],
  });

  modbusMqtt = {
    host: '127.0.0.1',
    port: 1883,
    client_id: 'mskdsp-browser-modbus',
    username: 'demo',
    password: 'demo',
    keepalive_sec: 60,
    clean_session: true,
    connect_timeout_ms: 3000,
  };
  const modbusConfig: ModbusLinkConfig = {
    conn_name: '储能变流器-Modbus',
    serial: { device: '', baud_rate: 115200, data_bits: 8, parity: 1, stop_bits: 1, read_timeout_ms: 500 },
    device_id: 1,
    poll_interval_ms: 1000,
    address_base: 1,
    read_plan: { mode: 2, blocks: [{ function: 2, start: 40001, quantity: 8 }, { function: 3, start: 30001, quantity: 4 }] },
    transport_type: 2,
    serial_port: 'RS485-PCS',
    request_timeout_ms: 3000,
    serial_byte_timeout_ms: 100,
    serial_frame_timeout_ms: 100,
    serial_est_size: 256,
  };
  const modbusId = nextId();
  modbusLinks.set(modbusConfig.conn_name, {
    config: modbusConfig,
    conn_id: modbusId,
    state: 2,
    last_error: '',
  });
  modbusTables.set(modbusConfig.conn_name, {
    conn_name: modbusConfig.conn_name,
    points: [
      { tag: '储能有功', function: 2, address: 40001, data_type: 3, scale: 0.1, offset: 0, deadband: 0.2, reg_count: 2, word_order: 1, byte_order: 1, bit_index: null },
      { tag: '储能无功', function: 2, address: 40003, data_type: 3, scale: 0.1, offset: 0, deadband: 0.2, reg_count: 2, word_order: 1, byte_order: 1, bit_index: null },
      { tag: '储能荷电率', function: 3, address: 30001, data_type: 4, scale: 0.1, offset: 0, deadband: 0.1, reg_count: 1, word_order: 0, byte_order: 0, bit_index: null },
      { tag: '储能可用', function: 1, address: 1, data_type: 1, scale: 1, offset: 0, deadband: 0, reg_count: 1, word_order: 0, byte_order: 0, bit_index: null },
      { tag: '储能告警码', function: 3, address: 30002, data_type: 2, scale: 1, offset: 0, deadband: 0, reg_count: 1, word_order: 0, byte_order: 0, bit_index: null },
    ],
  });

  const modbusSerialConfig: ModbusLinkConfig = {
    conn_name: '现场电表-Modbus',
    serial: { device: '/dev/ttyUSB0', baud_rate: 9600, data_bits: 8, parity: 1, stop_bits: 1, read_timeout_ms: 800 },
    device_id: 12,
    poll_interval_ms: 2000,
    address_base: 1,
    read_plan: { mode: 1, blocks: [] },
    transport_type: 1,
    serial_port: 'COM3',
    request_timeout_ms: 4000,
    serial_byte_timeout_ms: 150,
    serial_frame_timeout_ms: 200,
    serial_est_size: 128,
  };
  const modbusSerialId = nextId();
  modbusLinks.set(modbusSerialConfig.conn_name, {
    config: modbusSerialConfig,
    conn_id: modbusSerialId,
    state: 1,
    last_error: '',
  });
  modbusTables.set(modbusSerialConfig.conn_name, {
    conn_name: modbusSerialConfig.conn_name,
    points: [
      { tag: '电表电压', function: 3, address: 1, data_type: 4, scale: 0.1, offset: 0, deadband: 0.1, reg_count: 1, word_order: 0, byte_order: 0, bit_index: null },
      { tag: '电表电流', function: 3, address: 2, data_type: 4, scale: 0.01, offset: 0, deadband: 0.02, reg_count: 1, word_order: 0, byte_order: 0, bit_index: null },
      { tag: '电表电量', function: 3, address: 10, data_type: 3, scale: 0.01, offset: 0, deadband: 0.1, reg_count: 2, word_order: 1, byte_order: 1, bit_index: null },
    ],
  });

  dlt645Mqtt = {
    host: '127.0.0.1',
    port: 1883,
    client_id: 'mskdsp-browser-dlt645',
    username: 'demo',
    password: 'demo',
    keepalive_sec: 60,
    clean_session: true,
    connect_timeout_ms: 3000,
  };
  const dltConfig: Dlt645LinkConfig = {
    conn_name: '一号电表-DLT645',
    protocol_variant: 1,
    meter_addr: '000000000001',
    device_no: '01',
    transport_type: 1,
    comm_mode: 3,
    poll_interval_ms: 3000,
    poll_item_interval_ms: 500,
    request_timeout_ms: 3000,
    serial_port: '',
    serial_baud_rate: 0,
    serial_data_bits: 0,
    serial_parity: 0,
    serial_stop_bits: 0,
    serial_byte_timeout_ms: 0,
    serial_frame_timeout_ms: 0,
    serial_est_size: 0,
  };
  const dltId = nextId();
  dlt645Links.set(dltConfig.conn_name, {
    config: dltConfig,
    conn_id: dltId,
    state: 2,
    last_error: '',
  });
  dlt645Tables.set(dltConfig.conn_name, {
    conn_name: dltConfig.conn_name,
    points: [
      { tag: '总有功电量', di: '00000000', data_len: 4, data_type: 4, access: 1, scale: 0.01, offset: 0, deadband: 0, byte_index: null, bit_index: null },
      { tag: '表计电压', di: '02010100', data_len: 2, data_type: 4, access: 1, scale: 0.1, offset: 0, deadband: 0.1, byte_index: null, bit_index: null },
      { tag: '表计电流', di: '02020100', data_len: 3, data_type: 4, access: 1, scale: 0.001, offset: 0, deadband: 0.01, byte_index: null, bit_index: null },
    ],
    blocks: [{
      block_di: '00010000',
      block_data_len: 12,
      items: [
        { tag: 'A相功率', data_len: 4, data_type: 4, access: 1, scale: 0.001, offset: 0, deadband: 0.01, trim_right_space: null, byte_index: null, bit_index: null },
        { tag: 'B相功率', data_len: 4, data_type: 4, access: 1, scale: 0.001, offset: 0, deadband: 0.01, trim_right_space: null, byte_index: null, bit_index: null },
        { tag: 'C相功率', data_len: 4, data_type: 4, access: 1, scale: 0.001, offset: 0, deadband: 0.01, trim_right_space: null, byte_index: null, bit_index: null },
      ],
    }],
  });

  const dltSerialConfig: Dlt645LinkConfig = {
    conn_name: '二号电表-DLT645',
    protocol_variant: 2,
    meter_addr: '000000000002',
    device_no: '02',
    transport_type: 1,
    comm_mode: 2,
    poll_interval_ms: 5000,
    poll_item_interval_ms: 800,
    request_timeout_ms: 5000,
    serial_port: '/dev/ttyUSB1',
    serial_baud_rate: 9600,
    serial_data_bits: 8,
    serial_parity: 1,
    serial_stop_bits: 1,
    serial_byte_timeout_ms: 200,
    serial_frame_timeout_ms: 500,
    serial_est_size: 128,
  };
  const dltSerialId = nextId();
  dlt645Links.set(dltSerialConfig.conn_name, {
    config: dltSerialConfig,
    conn_id: dltSerialId,
    state: 1,
    last_error: '',
  });
  dlt645Tables.set(dltSerialConfig.conn_name, {
    conn_name: dltSerialConfig.conn_name,
    points: [
      { tag: '二号表有功', di: '02030000', data_len: 3, data_type: 4, access: 1, scale: 0.001, offset: 0, deadband: 0.01, byte_index: null, bit_index: null },
      { tag: '二号表功率因数', di: '02060000', data_len: 2, data_type: 4, access: 1, scale: 0.001, offset: 0, deadband: 0.005, byte_index: null, bit_index: null },
    ],
    blocks: [],
  });

  const agcConfig: AgcGroupConfig = {
    group_name: '储能有功控制',
    p_cmd: { signal: { tag: '有功调度指令', unit: 'kW', scale: 1, offset: 0 }, mode: 0, delta_base: 0, base_tag: '' },
    strategy: { strategy_type: 'weighted' },
    members: [
      {
        member_name: '储能-1',
        controllable: true,
        capacity_kw: 100,
        weight: 1,
        min_kw: 0,
        max_kw: 100,
        p_meas: { tag: '储能1有功', unit: 'kW', scale: 1, offset: 0 },
        p_set: { signal: { tag: '储能1有功设定', unit: 'kW', scale: 1, offset: 0 }, mode: 0, delta_base: 0, base_tag: '' },
      },
    ],
    outputs: {
      p_total_meas: { tag: '总有功实测', unit: 'kW', scale: 1, offset: 0 },
      p_total_target: { tag: '总有功目标', unit: 'kW', scale: 1, offset: 0 },
      p_total_error: { tag: '总有功偏差', unit: 'kW', scale: 1, offset: 0 },
    },
  };
  agcGroups.set(agcConfig.group_name, {
    config: agcConfig,
    conn_id: nextId(),
    state: 1,
    last_error: '',
    default_points: makeDefaultAgcPoints(),
    function_enabled: true,
    remote_enabled: true,
  });

  const agcSecondaryConfig: AgcGroupConfig = {
    group_name: '风场有功控制',
    p_cmd: { signal: { tag: '风场有功指令', unit: 'kW', scale: 1, offset: 0 }, mode: 2, delta_base: 3, base_tag: '风场有功基准' },
    strategy: { strategy_type: 'weighted' },
    members: [
      {
        member_name: '风机-1', controllable: true, capacity_kw: 250, weight: 2, min_kw: 20, max_kw: 250,
        p_meas: { tag: '风机1有功', unit: 'kW', scale: 1, offset: 0 },
        p_set: { signal: { tag: '风机1有功设定', unit: 'kW', scale: 1, offset: 0 }, mode: 1, delta_base: 0, base_tag: '' },
      },
      {
        member_name: '风机-2', controllable: false, capacity_kw: 180, weight: 1, min_kw: 0, max_kw: 180,
        p_meas: { tag: '风机2有功', unit: 'kW', scale: 1, offset: 0 },
        p_set: null,
      },
    ],
    outputs: {
      p_total_meas: { tag: '风场总有功', unit: 'kW', scale: 1, offset: 0 },
      p_total_target: { tag: '风场有功目标', unit: 'kW', scale: 1, offset: 0 },
      p_total_error: { tag: '风场有功偏差', unit: 'kW', scale: 1, offset: 0 },
    },
  };
  agcGroups.set(agcSecondaryConfig.group_name, {
    config: agcSecondaryConfig,
    conn_id: nextId(),
    state: 2,
    last_error: '',
    default_points: makeDefaultAgcPoints(),
    function_enabled: true,
    remote_enabled: true,
  });

  const avcConfig: AvcGroupConfig = {
    group_name: '变电站电压控制',
    voltage_meas: { tag: '母线电压实测', unit: 'kV', scale: 1, offset: 0 },
    voltage_cmd: { tag: '母线电压目标', unit: 'kV', scale: 1, offset: 0 },
    q_total_cmd: { signal: { tag: '总无功指令', unit: 'kVar', scale: 1, offset: 0 }, mode: 1, delta_base: 0, base_tag: '' },
    voltage_control: { kp: 80, deadband: 0.02 },
    strategy: { strategy_type: 'weighted' },
    members: [
      {
        member_name: '无功补偿-1', controllable: true, weight: 2, q_min_kvar: -500, q_max_kvar: 500,
        q_meas: { tag: '补偿装置1无功', unit: 'kVar', scale: 1, offset: 0 },
        q_set: { signal: { tag: '补偿装置1无功设定', unit: 'kVar', scale: 1, offset: 0 }, mode: 1, delta_base: 0, base_tag: '' },
      },
      {
        member_name: '无功补偿-2', controllable: true, weight: 1, q_min_kvar: -300, q_max_kvar: 300,
        q_meas: { tag: '补偿装置2无功', unit: 'kVar', scale: 1, offset: 0 },
        q_set: { signal: { tag: '补偿装置2无功设定', unit: 'kVar', scale: 1, offset: 0 }, mode: 2, delta_base: 2, base_tag: '' },
      },
    ],
  };
  avcGroups.set(avcConfig.group_name, {
    config: avcConfig,
    conn_id: nextId(),
    state: 2,
    last_error: '',
    default_points: makeDefaultAvcPoints(),
    function_enabled: true,
    remote_enabled: true,
  });

  const avcSecondaryConfig: AvcGroupConfig = {
    group_name: '园区电压控制',
    voltage_meas: { tag: '园区母线电压', unit: 'kV', scale: 1, offset: 0 },
    voltage_cmd: null,
    q_total_cmd: { signal: { tag: '园区总无功指令', unit: 'kVar', scale: 1, offset: 0 }, mode: 1, delta_base: 0, base_tag: '' },
    voltage_control: { kp: 45, deadband: 0.05 },
    strategy: { strategy_type: 'weighted' },
    members: [{
      member_name: '园区补偿装置', controllable: true, weight: 1, q_min_kvar: -200, q_max_kvar: 200,
      q_meas: { tag: '园区补偿无功', unit: 'kVar', scale: 1, offset: 0 },
      q_set: { signal: { tag: '园区补偿无功设定', unit: 'kVar', scale: 1, offset: 0 }, mode: 1, delta_base: 0, base_tag: '' },
    }],
  };
  avcGroups.set(avcSecondaryConfig.group_name, {
    config: avcSecondaryConfig,
    conn_id: nextId(),
    state: 1,
    last_error: '',
    default_points: makeDefaultAvcPoints(),
    function_enabled: true,
    remote_enabled: true,
  });

  const calcConfig: CalcGroupConfig = {
    group_name: '计算示例',
    items: [
      {
        item_name: '有功加常量',
        operator_kind: 1,
        left_operand: { source_kind: 1, constant: null },
        right_operand: { source_kind: 2, constant: { double_value: 5 } },
        operands: [],
      },
    ],
  };
  calcGroups.set(calcConfig.group_name, {
    config: calcConfig,
    conn_id: nextId(),
    state: 1,
    last_error: '',
    items: makeCalcItems(calcConfig),
  });

  const calcSecondaryConfig: CalcGroupConfig = {
    group_name: '遥测汇总',
    items: [
      {
        item_name: '总有功',
        operator_kind: 9,
        left_operand: null,
        right_operand: null,
        operands: [
          { source_kind: 1, constant: null },
          { source_kind: 1, constant: null },
          { source_kind: 1, constant: null },
        ],
      },
      {
        item_name: '功率因数正常',
        operator_kind: 6,
        left_operand: { source_kind: 1, constant: null },
        right_operand: { source_kind: 2, constant: { bool_value: true } },
        operands: [],
      },
    ],
  };
  calcGroups.set(calcSecondaryConfig.group_name, {
    config: calcSecondaryConfig,
    conn_id: nextId(),
    state: 2,
    last_error: '',
    items: makeCalcItems(calcSecondaryConfig),
  });

  const endpoint = (moduleName: string, connName: string, connId: number, tag: string): DcRoute['src'] => ({
    module_name: moduleName,
    conn_name: connName,
    conn_id: connId,
    tag,
  });
  const agcId = agcGroups.get(agcConfig.group_name)?.conn_id ?? 0;
  const agcWindId = agcGroups.get(agcSecondaryConfig.group_name)?.conn_id ?? 0;
  const avcId = avcGroups.get(avcConfig.group_name)?.conn_id ?? 0;
  const avcParkId = avcGroups.get(avcSecondaryConfig.group_name)?.conn_id ?? 0;
  const calcId = calcGroups.get(calcConfig.group_name)?.conn_id ?? 0;
  const calcTelemetryId = calcGroups.get(calcSecondaryConfig.group_name)?.conn_id ?? 0;
  routes = [
    { src: endpoint('IEC104', iecConfig.conn_name, iec104Links.get(iecConfig.conn_name)?.conn_id ?? 0, '有功功率'), dst: endpoint('AGC', agcConfig.group_name, agcId, '有功调度指令') },
    { src: endpoint('ModbusRTU', modbusConfig.conn_name, modbusId, '储能有功'), dst: endpoint('AGC', agcSecondaryConfig.group_name, agcWindId, '风场有功指令') },
    { src: endpoint('IEC104', iecSecondaryConfig.conn_name, iecSecondaryId, '母线电压'), dst: endpoint('AVC', avcConfig.group_name, avcId, '母线电压实测') },
    { src: endpoint('DLT645', dltConfig.conn_name, dltId, '表计电压'), dst: endpoint('AVC', avcSecondaryConfig.group_name, avcParkId, '园区母线电压') },
    { src: endpoint('ModbusRTU', modbusConfig.conn_name, modbusId, '储能有功'), dst: endpoint('Calc', calcConfig.group_name, calcId, '有功加常量/left_input') },
    { src: endpoint('DLT645', dltConfig.conn_name, dltId, '总有功电量'), dst: endpoint('Calc', calcSecondaryConfig.group_name, calcTelemetryId, '总有功/input_1') },
    { src: endpoint('ModbusRTU', modbusSerialConfig.conn_name, modbusSerialId, '电表电量'), dst: endpoint('Calc', calcSecondaryConfig.group_name, calcTelemetryId, '总有功/input_2') },
    { src: endpoint('DLT645', dltConfig.conn_name, dltId, 'A相功率'), dst: endpoint('Calc', calcSecondaryConfig.group_name, calcTelemetryId, '总有功/input_3') },
    { src: endpoint('AGC', agcConfig.group_name, agcId, '总有功实测'), dst: endpoint('IEC104', iecConfig.conn_name, iec104Links.get(iecConfig.conn_name)?.conn_id ?? 0, '有功设定') },
  ];
}

seedDemoData();

export const browserApi: typeof tauriApi = {
  loadAppSettings: async () => clone(loadBrowserSettings()),
  migrateLegacyAppSettings: async (legacy: AppSettingsMap) => {
    const settings = loadBrowserSettings();
    for (const [key, value] of Object.entries(legacy)) {
      if (!(key in settings)) {
        settings[key] = clone(value);
      }
    }
    saveBrowserSettings(settings);
    return clone(settings);
  },
  saveAppSetting: async (key: string, value: unknown) => {
    const settings = loadBrowserSettings();
    settings[key] = clone(value);
    saveBrowserSettings(settings);
  },
  getRuntimePaths: async (): Promise<RuntimePaths> => ({
    executable_dir: 'browser-dev://',
    data_dir: 'browser-dev://localStorage',
    cache_dir: 'browser-dev://memory-cache',
    log_dir: 'browser-dev://console',
    using_fallback: false,
  }),
  openRuntimeDirectory: async () => {
    throw new Error('浏览器开发模式不支持打开本地目录');
  },
  clearLowerUpdateCache: async () => {
    const removedFiles = browserCachedLowerPackages.size;
    browserCachedLowerPackages.clear();
    return { removed_files: removedFiles, reclaimed_bytes: 0 };
  },
  listCachedLowerUpdates: async (channel?: LowerUpdateChannel): Promise<LowerUpdateCachedPackage[]> => {
    const values = [...browserCachedLowerPackages.values()]
      .filter((item) => Boolean(item.manifest.image_id?.trim()));
    return clone(channel ? values.filter((item) => item.manifest.channel === channel) : values);
  },

  setManagerAddr: async (addr: string) => {
    managerAddr = addr;
  },
  getModuleInfo: async () => clone(moduleInfos),
  getRunningModuleInfo: async () => [...runningModules].map(makeRunningInfo),
  startModule: async (moduleInfo: ModuleInfo) => {
    runningModules.add(moduleInfo.module_name);
  },
  stopModule: async (moduleInfo: ModuleInfo) => {
    if (moduleInfo.module_name !== 'ModuleManager') {
      runningModules.delete(moduleInfo.module_name);
    }
  },

  getAppVersion: async () => '0.5.0-browser-dev',
  checkAppUpdate: async () => null,
  downloadAppUpdate: async (onEvent?: (event: AppUpdateDownloadEvent) => void) => {
    onEvent?.({ event: 'Started', data: { contentLength: 0 } });
    onEvent?.({ event: 'Finished' });
    throw new Error('浏览器开发模式不支持下载客户端更新');
  },
  installAppUpdate: async () => {
    throw new Error('浏览器开发模式不支持安装客户端更新');
  },
  downloadAndInstallAppUpdate: async () => {
    throw new Error('浏览器开发模式不支持下载安装客户端更新');
  },
  relaunchApp: async () => {},
  disposePendingAppUpdate: async () => {},
  checkLowerUpdate: async (channel: LowerUpdateChannel): Promise<LowerUpdateManifest> => {
    const response = await fetch(buildLowerUpdateLatestUrl(channel), { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`获取下位机更新清单失败: HTTP ${response.status}`);
    }
    const manifest = await response.json() as LowerUpdateManifest;
    browserLatestLowerManifest = manifest;
    return manifest;
  },
  getLowerUpdateRuntimeInfo: async (): Promise<LowerUpdateRuntimeInfo> => ({
    container_name: 'mskdsp',
    exists: true,
    running: true,
    image_id: browserRunningLowerImageId,
  }),
  downloadLowerUpdate: async (
    manifest: LowerUpdateManifest,
    onProgress?: (progress: LowerUpdateDownloadProgress) => void,
  ): Promise<LowerUpdateDownloadResult> => {
    onProgress?.({
      package_name: manifest.asset.name,
      downloaded_bytes: 0,
      total_bytes: manifest.asset.size,
      percent: 0,
      stage: 'started',
    });

    const response = await fetch(manifest.asset.url);
    if (!response.ok) {
      throw new Error(`下载下位机更新包失败: HTTP ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== manifest.asset.size) {
      throw new Error(`下位机更新包大小不匹配: 期望 ${manifest.asset.size} 字节，实际 ${bytes.byteLength} 字节`);
    }

    onProgress?.({
      package_name: manifest.asset.name,
      downloaded_bytes: bytes.byteLength,
      total_bytes: manifest.asset.size,
      percent: 100,
      stage: 'verifying',
    });

    const digest = bytesToHex(await crypto.subtle.digest('SHA-256', bytes));
    if (digest.toLowerCase() !== manifest.asset.sha256.toLowerCase()) {
      throw new Error(`下位机更新包校验失败: 期望 ${manifest.asset.sha256}，实际 ${digest}`);
    }

    browserLatestLowerManifest = clone(manifest);
    browserCachedLowerPackages.set(manifest.channel, {
      downloaded_at: Math.floor(Date.now() / 1000),
      manifest: clone(manifest),
      package_path: `browser-cache://${manifest.asset.name}`,
      package_size: bytes.byteLength,
      sha256: digest,
    });

    onProgress?.({
      package_name: manifest.asset.name,
      downloaded_bytes: bytes.byteLength,
      total_bytes: manifest.asset.size,
      percent: 100,
      stage: 'finished',
    });
    return {
      package_name: manifest.asset.name,
      package_path: `browser-cache://${manifest.asset.name}`,
      downloaded_bytes: bytes.byteLength,
      sha256: digest,
    };
  },
  uploadLowerUpdatePackage: async (
    request: LowerUpdateUploadRequest,
    onProgress?: (progress: LowerUpdateUploadProgress) => void,
  ): Promise<LowerUpdateUploadResult> => {
    const remotePath = buildRemotePackagePath(request.install_dir, request.package_name);
    const totalBytes = request.package_size;
    onProgress?.({
      package_name: request.package_name,
      remote_path: remotePath,
      uploaded_bytes: 0,
      total_bytes: totalBytes,
      percent: 0,
      stage: 'started',
    });

    for (const percent of [25, 50, 75, 100]) {
      await sleep(120);
      onProgress?.({
        package_name: request.package_name,
        remote_path: remotePath,
        uploaded_bytes: Math.round((totalBytes * percent) / 100),
        total_bytes: totalBytes,
        percent,
        stage: percent === 100 ? 'finished' : 'uploading',
      });
    }

    return {
      package_name: request.package_name,
      remote_path: remotePath,
      uploaded_bytes: totalBytes,
    };
  },
  installLowerUpdatePackage: async (request: LowerUpdateInstallRequest): Promise<LowerUpdateInstallResult> => {
    const remotePath = buildRemotePackagePath(request.install_dir, request.package_name);
    const command = `set -e; cd '${request.install_dir}' && chmod +x './${request.package_name}' && './${request.package_name}' start`;
    await sleep(500);
    if (browserRunningLowerImageId.trim().toLowerCase() === request.expected_image_id.trim().toLowerCase()) {
      return {
        package_name: request.package_name,
        remote_path: remotePath,
        command: '未执行安装命令，目标机已运行待安装构建',
        already_current: true,
        success: true,
        exit_code: 0,
        stdout: 'browser-dev: target already runs expected image\n',
        stderr: '',
      };
    }
    if (browserLatestLowerManifest?.image_id) {
      browserRunningLowerImageId = browserLatestLowerManifest.image_id;
    }
    return {
      package_name: request.package_name,
      remote_path: remotePath,
      command,
      already_current: false,
      success: true,
      exit_code: 0,
      stdout: 'browser-dev: install command simulated\n',
      stderr: '',
    };
  },
  getLowerUpdatePassword: async (): Promise<string | null> => null,
  clearLowerUpdatePassword: async (): Promise<void> => {},

  iec104UpsertLink: async (config: Iec104LinkConfig, createOnly: boolean) =>
    upsertByName(iec104Links, config.conn_name, createOnly, (connId, previous) => ({
      config: clone(config),
      conn_id: connId,
      state: previous?.state ?? IEC104_LINK_STATE.STOPPED,
      last_error: '',
    })),
  iec104RenameLink: async (oldConnName: string, newConnName: string) =>
    renameByName(iec104Links, oldConnName, newConnName),
  iec104GetLink: async (connName: string) => {
    const value = iec104Links.get(connName);
    if (!value) throw new Error(`浏览器开发模式 mock 未找到: ${connName}`);
    return clone(value);
  },
  iec104ListLinks: async () => clone([...iec104Links.values()]),
  iec104DeleteLink: async (connName: string) => deleteByName(iec104Links, connName),
  iec104StartLink: async (connName: string) => setLinkState(iec104Links, connName, IEC104_LINK_STATE.RUNNING),
  iec104StopLink: async (connName: string) => setLinkState(iec104Links, connName, IEC104_LINK_STATE.STOPPED),
  iec104UpsertPointTable: async (connName: string, points: Iec104Point[], replace: boolean) => {
    const previous = iec104Tables.get(connName)?.points ?? [];
    const normalizePoint = (point: Iec104Point): Iec104Point => ({
      ...point,
      business_type: inferIec104BusinessType(point),
    });
    const nextPoints = replace ? points : mergeByTag(previous, points);
    iec104Tables.set(connName, { conn_name: connName, points: clone(nextPoints.map(normalizePoint)) });
  },
  iec104GetPointTable: async (connName: string) => clone(iec104Tables.get(connName) ?? { conn_name: connName, points: [] }),
  iec104SendTimeSync: async () => {},
  iec104GenerateSimulationValues: async (connName: string, options: Iec104SimulationGenerateOptions): Promise<Iec104SimulationSnapshot> => {
    const table = iec104Tables.get(connName);
    if (!table || table.points.length === 0) throw new Error('浏览器开发模式 mock 点表为空');
    const tsMs = Date.now();
    let floatIndex = 0;
    const points = table.points
      .filter(isIec104SimulationPoint)
      .sort((left, right) => left.ioa - right.ioa);
    if (points.length === 0) throw new Error('浏览器开发模式 mock 点表中没有可模拟的遥信或遥测点');
    const previous = iec104Simulation.get(connName);
    const previousBoolValues = new Map(
      (previous?.points ?? [])
        .filter((point) => point.point_type === 2 && point.bool_value != null)
        .map((point) => [point.tag, point.bool_value as boolean]),
    );
    if (options.boolMode === 'invert_current') {
      const missingTag = points.find(
        (point) => point.point_type === 2 && !previousBoolValues.has(point.tag),
      )?.tag;
      if (missingTag) {
        throw new Error(`浏览器开发模式 mock 没有遥信 ${missingTag} 的当前值`);
      }
    }
    const resolveBoolValue = (tag: string): boolean => {
      switch (options.boolMode) {
        case 'all_true':
          return true;
        case 'all_false':
          return false;
        case 'invert_current':
          return !previousBoolValues.get(tag);
        case 'random':
        default:
          return Math.random() >= 0.5;
      }
    };
    const snapshot: Iec104SimulationSnapshot = {
      conn_name: connName,
      points: points.map((point) => point.point_type === 2
        ? {
          tag: point.tag,
          point_type: point.point_type,
          bool_value: resolveBoolValue(point.tag),
          double_value: null,
          quality: 0,
          ts_ms: tsMs,
        }
        : { tag: point.tag, point_type: point.point_type, bool_value: null, double_value: options.mode === 'increment' ? 1 + floatIndex++ : Math.random() * 100, quality: 0, ts_ms: tsMs }),
    };
    iec104Simulation.set(connName, snapshot);
    console.info('IEC104 浏览器开发模式已生成模拟值', {
      connName,
      floatMode: options.mode,
      boolMode: options.boolMode,
      pointCount: snapshot.points.length,
    });
    return clone(snapshot);
  },
  iec104GetSimulationSnapshot: async (connName: string) => clone(iec104Simulation.get(connName) ?? { conn_name: connName, points: [] }),
  iec104ApplySimulationValues: async (connName: string) => {
    if (!iec104Simulation.has(connName)) throw new Error('浏览器开发模式 mock 没有模拟值');
  },
  iec104ClearSimulationValues: async (connName: string) => { iec104Simulation.delete(connName); },

  iec61850ImportScl: async (modelName: string, sourceName: string, content: number[], validateOnly: boolean, replace: boolean): Promise<Iec61850ImportResult> => {
    if (!modelName.trim() || content.length === 0) throw new Error('浏览器开发模式 mock：模型名称和 SCL 文件内容不能为空');
    const summary: Iec61850ModelSummary = {
      model_name: modelName.trim(), source_name: sourceName || modelName, document_kind: 1,
      source_checksum: `browser-${content.length.toString(16)}`, ied_count: 1, logical_node_count: 12,
      data_attribute_count: 96, data_set_count: 4, report_control_count: 3, gse_control_count: 2,
      sampled_value_control_count: 1, external_reference_count: 8,
    };
    if (!validateOnly) {
      if (!replace && iec61850Models.has(summary.model_name)) throw new Error(`浏览器开发模式 mock 已存在模型: ${summary.model_name}`);
      iec61850Models.set(summary.model_name, clone(summary));
    }
    return { summary: clone(summary), issues: [] };
  },
  iec61850ListModels: async () => clone([...iec61850Models.values()]),
  iec61850DeleteModel: async (modelName: string) => {
    if ([...iec61850Ieds.values()].some((ied) => ied.config?.model_name === modelName)) throw new Error('模型仍被 IED 配置引用，无法删除');
    iec61850Models.delete(modelName);
  },
  iec61850UpsertIed: async (config: Iec61850IedConfig, createOnly: boolean): Promise<Iec61850IedInfo> => {
    if (!config.conn_name.trim() || !config.model_name.trim() || !config.ied_name.trim()) throw new Error('IED 连接名、模型名和 IED 名称不能为空');
    if (!iec61850Models.has(config.model_name)) throw new Error(`浏览器开发模式 mock 未找到模型: ${config.model_name}`);
    return upsertByName(iec61850Ieds, config.conn_name, createOnly, (connId, previous) => ({
      config: clone(config), conn_id: connId, state: previous?.state ?? 1, active_channel: previous?.active_channel ?? 0,
      channels: config.channels.map((item) => ({ config: clone(item), state: item.enabled ? 2 : 1, last_error: '' })),
      last_error: '', data_center_available: true,
    }));
  },
  iec61850GetIed: async (connName: string) => {
    const value = iec61850Ieds.get(connName); if (!value) throw new Error(`浏览器开发模式 mock 未找到 IED: ${connName}`); return clone(value);
  },
  iec61850ListIeds: async () => clone([...iec61850Ieds.values()]),
  iec61850DeleteIed: async (connName: string) => { iec61850Ieds.delete(connName); iec61850Mappings.delete(connName); },
  iec61850StartIed: async (connName: string) => setLinkState(iec61850Ieds, connName, 3),
  iec61850StopIed: async (connName: string) => setLinkState(iec61850Ieds, connName, 1),
  iec61850UpsertPointMappings: async (connName: string, points: Iec61850PointMapping[], replace: boolean) => {
    if (!iec61850Ieds.has(connName)) throw new Error(`浏览器开发模式 mock 未找到 IED: ${connName}`);
    const previous = iec61850Mappings.get(connName)?.points ?? [];
    iec61850Mappings.set(connName, { conn_name: connName, points: clone(replace ? points : mergeByTag(previous, points)) });
  },
  iec61850GetPointMappings: async (connName: string) => clone(iec61850Mappings.get(connName) ?? { conn_name: connName, points: [] }),
  iec61850GetRuntimeStatistics: async (connName: string): Promise<Iec61850RuntimeStatistics> => {
    if (!iec61850Ieds.has(connName)) throw new Error(`浏览器开发模式 mock 未找到 IED: ${connName}`);
    return { conn_name: connName, mms_reports_received: 1248, mms_events_dropped: 0, mms_queue_high_watermark: 18, data_center_batches_published: 642, data_center_publish_failures: 0, goose_frames_received: 320, goose_frames_sent: 24, goose_frames_invalid: 0, goose_timeouts: 0, sv_frames_received: 12000, sv_frames_invalid: 0, sv_samples_dropped: 0, reconnect_count: 2, last_event_ts_ms: Date.now(), mms_values_unmapped: 3, mms_values_type_mismatch: 0, mms_values_invalid: 0, mms_values_deadband_filtered: 56, mms_values_oversized: 0, mms_reports_oversized: 0, mms_queue_bytes_high_watermark: 4096 };
  },

  modbusRtuUpdateConfig: async (mqtt: ModbusMqttConfig): Promise<ModbusUpdateConfigResponse> => {
    modbusMqtt = clone(mqtt);
    return { ok: true, message: '浏览器开发模式 mock 已保存 ModbusRTU MQTT 配置' };
  },
  modbusRtuUpsertLink: async (config: ModbusLinkConfig, createOnly: boolean) =>
    upsertByName(modbusLinks, config.conn_name, createOnly, (connId, previous) => ({
      config: clone(config),
      conn_id: connId,
      state: previous?.state ?? 1,
      last_error: modbusMqtt ? '' : '浏览器开发模式 mock 未连接真实 MQTT',
    })),
  modbusRtuRenameLink: async (oldConnName: string, newConnName: string) =>
    renameByName(modbusLinks, oldConnName, newConnName),
  modbusRtuGetLink: async (connName: string) => {
    const value = modbusLinks.get(connName);
    if (!value) throw new Error(`浏览器开发模式 mock 未找到: ${connName}`);
    return clone(value);
  },
  modbusRtuListLinks: async () => clone([...modbusLinks.values()]),
  modbusRtuDeleteLink: async (connName: string) => deleteByName(modbusLinks, connName),
  modbusRtuStartLink: async (connName: string) => setLinkState(modbusLinks, connName, 2),
  modbusRtuStopLink: async (connName: string) => setLinkState(modbusLinks, connName, 1),
  modbusRtuUpsertPointTable: async (connName: string, points: ModbusPoint[], replace: boolean) => {
    const previous = modbusTables.get(connName)?.points ?? [];
    modbusTables.set(connName, { conn_name: connName, points: replace ? clone(points) : mergeByTag(previous, points) });
  },
  modbusRtuGetPointTable: async (connName: string) =>
    clone(modbusTables.get(connName) ?? { conn_name: connName, points: [] }),

  dlt645UpdateConfig: async (mqtt: Dlt645MqttConfig): Promise<Dlt645UpdateConfigResponse> => {
    dlt645Mqtt = clone(mqtt);
    return { ok: true, message: '浏览器开发模式 mock 已保存 DLT645 MQTT 配置' };
  },
  dlt645UpsertLink: async (config: Dlt645LinkConfig, createOnly: boolean) =>
    upsertByName(dlt645Links, config.conn_name, createOnly, (connId, previous) => ({
      config: clone(config),
      conn_id: connId,
      state: previous?.state ?? 0,
      last_error: dlt645Mqtt ? '' : '浏览器开发模式 mock 未连接真实 MQTT',
    })),
  dlt645RenameLink: async (oldConnName: string, newConnName: string) =>
    renameByName(dlt645Links, oldConnName, newConnName),
  dlt645GetLink: async (connName: string) => {
    const value = dlt645Links.get(connName);
    if (!value) throw new Error(`浏览器开发模式 mock 未找到: ${connName}`);
    return clone(value);
  },
  dlt645ListLinks: async () => clone([...dlt645Links.values()]),
  dlt645DeleteLink: async (connName: string) => deleteByName(dlt645Links, connName),
  dlt645StartLink: async (connName: string) => setLinkState(dlt645Links, connName, 1),
  dlt645StopLink: async (connName: string) => setLinkState(dlt645Links, connName, 0),
  dlt645UpsertPointTable: async (connName: string, points: Dlt645Point[], blocks: Dlt645Block[], replace: boolean) => {
    const previous = dlt645Tables.get(connName) ?? { conn_name: connName, points: [], blocks: [] };
    dlt645Tables.set(connName, {
      conn_name: connName,
      points: replace ? clone(points) : mergeByTag(previous.points, points),
      blocks: replace ? clone(blocks) : clone([...previous.blocks, ...blocks]),
    });
  },
  dlt645GetPointTable: async (connName: string) =>
    clone(dlt645Tables.get(connName) ?? { conn_name: connName, points: [], blocks: [] }),

  dcListConnections: async () => clone(listConnections()),
  dcGetConnTags: async (connId: number): Promise<DcConnTags> => ({ conn_id: connId, tags: tagsForConnection(connId) }),
  dcListRoutes: async (srcConnId: number, srcTag: string, dstConnId: number, dstTag: string) =>
    clone(routes.filter((route) => {
      const srcMatches = !srcConnId || route.src.conn_id === srcConnId;
      const dstMatches = !dstConnId || route.dst.conn_id === dstConnId;
      const srcTagMatches = !srcTag || route.src.tag === srcTag;
      const dstTagMatches = !dstTag || route.dst.tag === dstTag;
      return srcMatches && dstMatches && srcTagMatches && dstTagMatches;
    })),
  dcUpsertRoutes: async (nextRoutes: DcRoute[], replace: boolean) => {
    const mergedRoutes = replace ? clone(nextRoutes) : [...routes, ...nextRoutes];
    const uniqueRoutes = new Map<string, DcRoute>();
    for (const route of mergedRoutes) {
      const key = JSON.stringify({
        src: {
          module_name: route.src.module_name,
          conn_name: route.src.conn_name,
          tag: route.src.tag,
        },
        dst: {
          module_name: route.dst.module_name,
          conn_name: route.dst.conn_name,
          tag: route.dst.tag,
        },
      });
      uniqueRoutes.set(key, route);
    }
    routes = clone([...uniqueRoutes.values()]);
  },
  dcDeleteRoutes: async (deleteRoutes: DcRoute[]) => {
    const keys = new Set(deleteRoutes.map((route) => JSON.stringify(route)));
    routes = routes.filter((route) => !keys.has(JSON.stringify(route)));
  },
  dcGetLatest: getLatestUpdates,
  dcGetSourceLatest: getSourceLatestUpdates,
  getDataBusThroughputSnapshot: getBrowserThroughputSnapshot,

  calcUpsertGroup: async (config: CalcGroupConfig, createOnly: boolean) => {
    const previous = calcGroups.get(config.group_name);
    ensureUnique(createOnly, Boolean(previous), config.group_name);
    const value: CalcGroupInfo = {
      config: clone(config),
      conn_id: previous?.conn_id ?? nextId(),
      state: previous?.state ?? 1,
      last_error: '',
      items: makeCalcItems(config),
    };
    calcGroups.set(config.group_name, value);
    return clone(value);
  },
  calcRenameGroup: async (oldGroupName: string, newGroupName: string) => {
    const value = calcGroups.get(oldGroupName);
    if (!value) throw new Error(`浏览器开发模式 mock 未找到: ${oldGroupName}`);
    if (calcGroups.has(newGroupName)) throw new Error(`浏览器开发模式 mock 已存在: ${newGroupName}`);
    calcGroups.delete(oldGroupName);
    const renamed = clone(value);
    if (renamed.config) renamed.config.group_name = newGroupName;
    calcGroups.set(newGroupName, renamed);
    return clone(renamed);
  },
  calcGetGroup: async (groupName: string) => {
    const value = calcGroups.get(groupName);
    if (!value) throw new Error(`浏览器开发模式 mock 未找到: ${groupName}`);
    return clone(value);
  },
  calcListGroups: async () => clone([...calcGroups.values()]),
  calcDeleteGroup: async (groupName: string) => deleteByName(calcGroups, groupName),
  calcStartGroup: async (groupName: string) => setLinkState(calcGroups, groupName, 2),
  calcStopGroup: async (groupName: string) => setLinkState(calcGroups, groupName, 1),

  agcUpsertGroup: async (config: AgcGroupConfig, createOnly: boolean) => {
    const previous = agcGroups.get(config.group_name);
    ensureUnique(createOnly, Boolean(previous), config.group_name);
    const value: AgcGroupInfo = {
      config: clone(config),
      conn_id: previous?.conn_id ?? nextId(),
      state: previous?.state ?? 0,
      last_error: '',
      default_points: previous?.default_points ?? makeDefaultAgcPoints(),
      function_enabled: previous?.function_enabled ?? true,
      remote_enabled: previous?.remote_enabled ?? true,
    };
    agcGroups.set(config.group_name, value);
    return clone(value);
  },
  agcGetGroup: async (groupName: string) => {
    const value = agcGroups.get(groupName);
    if (!value) throw new Error(`浏览器开发模式 mock 未找到: ${groupName}`);
    return clone(value);
  },
  agcListGroups: async () => clone([...agcGroups.values()]),
  agcDeleteGroup: async (groupName: string) => deleteByName(agcGroups, groupName),
  agcStartGroup: async (groupName: string) => setLinkState(agcGroups, groupName, 2),
  agcStopGroup: async (groupName: string) => setLinkState(agcGroups, groupName, 1),
  agcStartTuning: async (groupName: string, config: AgcTuningConfig): Promise<AgcTuningStatus> => {
    const status: AgcTuningStatus = {
      group_name: groupName,
      state: 2,
      direction: 1,
      completed_up_tests: 0,
      completed_down_tests: 0,
      started_at_ms: Date.now(),
      elapsed_ms: 0,
      current_target_kw: config.target_lower_kw,
      current_total_meas_kw: 0,
      target_entry_elapsed_seconds: 0,
      stable_elapsed_seconds: 0,
      last_error: '',
      candidate_profile: null,
    };
    agcTuningStatuses.set(groupName, status);
    return clone(status);
  },
  agcStopTuning: async (groupName: string): Promise<AgcTuningStatus> => {
    const status = agcTuningStatuses.get(groupName) ?? {
      group_name: groupName, state: 1, direction: 0, completed_up_tests: 0, completed_down_tests: 0,
      started_at_ms: 0, elapsed_ms: 0, current_target_kw: 0, current_total_meas_kw: 0,
      target_entry_elapsed_seconds: 0, stable_elapsed_seconds: 0, last_error: '', candidate_profile: null,
    };
    status.state = 4;
    status.last_error = '浏览器开发模式未执行真实调试';
    agcTuningStatuses.set(groupName, status);
    return clone(status);
  },
  agcGetTuningStatus: async (groupName: string): Promise<AgcTuningStatus> => {
    const status = agcTuningStatuses.get(groupName) ?? {
      group_name: groupName, state: 1, direction: 0, completed_up_tests: 0, completed_down_tests: 0,
      started_at_ms: 0, elapsed_ms: 0, current_target_kw: 0, current_total_meas_kw: 0,
      target_entry_elapsed_seconds: 0, stable_elapsed_seconds: 0, last_error: '', candidate_profile: null,
    };
    if (status.state === 2 && status.started_at_ms > 0) {
      status.elapsed_ms = Math.max(0, Date.now() - status.started_at_ms);
    }
    return clone(status);
  },
  agcGetControlProfile: async (groupName: string): Promise<AgcControlProfile> => ({
    group_name: groupName,
    members: [],
    version: 0,
    confirmed_at_ms: 0,
  }),
  agcConfirmControlProfile: async (profile: AgcControlProfile): Promise<AgcControlProfile> => clone(profile),

  avcUpsertGroup: async (config: AvcGroupConfig, createOnly: boolean) => {
    const previous = avcGroups.get(config.group_name);
    ensureUnique(createOnly, Boolean(previous), config.group_name);
    const value: AvcGroupInfo = {
      config: clone(config),
      conn_id: previous?.conn_id ?? nextId(),
      state: previous?.state ?? 0,
      last_error: '',
      default_points: previous?.default_points ?? makeDefaultAvcPoints(),
      function_enabled: previous?.function_enabled ?? true,
      remote_enabled: previous?.remote_enabled ?? true,
    };
    avcGroups.set(config.group_name, value);
    return clone(value);
  },
  avcRenameGroup: async (oldGroupName: string, newGroupName: string) => {
    const value = avcGroups.get(oldGroupName);
    if (!value) {
      throw new Error(`浏览器开发模式 mock 未找到: ${oldGroupName}`);
    }
    if (avcGroups.has(newGroupName)) {
      throw new Error(`浏览器开发模式 mock 已存在: ${newGroupName}`);
    }
    avcGroups.delete(oldGroupName);
    const renamed = clone(value);
    if (renamed.config) {
      renamed.config.group_name = newGroupName;
    }
    renamed.default_points = makeDefaultAvcPoints();
    avcGroups.set(newGroupName, renamed);
    return clone(renamed);
  },
  avcGetGroup: async (groupName: string) => {
    const value = avcGroups.get(groupName);
    if (!value) throw new Error(`浏览器开发模式 mock 未找到: ${groupName}`);
    return clone(value);
  },
  avcListGroups: async () => clone([...avcGroups.values()]),
  avcDeleteGroup: async (groupName: string) => deleteByName(avcGroups, groupName),
  avcStartGroup: async (groupName: string) => setLinkState(avcGroups, groupName, 2),
  avcStopGroup: async (groupName: string) => setLinkState(avcGroups, groupName, 1),

  saveFullConfigExport: async (filePath: string, snapshot: FullConfigExportSnapshot) => {
    const key = filePath || 'browser-dev-export.json';
    exportSnapshots.set(key, clone(snapshot));
    return key;
  },
  saveVerticalSecurityScript: async (filePath: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filePath.split(/[\\/]/).pop() || 'mskdsp-vertical-security.sh';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    return filePath;
  },
  deployVerticalSecurityScript: async (
    request: VerticalSecurityDeployRequest,
  ): Promise<VerticalSecurityDeployResult> => ({
    remote_path: `${request.install_dir.replace(/\/+$/, '') || '/'}/mskdsp-vertical-security.sh`,
    service_name: 'mskdsp-vertical-security.service',
    exit_code: 0,
    success: true,
    stdout: '浏览器开发模式已模拟脚本上传、服务安装和启动\n',
    stderr: '',
  }),
  getVerticalSecurityStatus: async (): Promise<VerticalSecurityStatusResult> => ({
    service_name: 'mskdsp-vertical-security.service',
    active_state: 'active',
    sub_state: 'exited',
    result: 'success',
    exit_code: 0,
    restart_count: 0,
    steps: [
      ['precheck', '系统预检查', '必要命令和网络接口检查完成'],
      ['fixed_network', '101 固定网络', '101 固定网络和 SNAT 配置完成'],
      ['local_security', '107 本地纵密链路', '107 本地纵密链路配置完成'],
      ['local_rtu', '108 本地 RTU 链路', '108 本地 RTU 链路配置完成'],
      ['ppp0_wait', 'PPP 链路', '已获取 ppp0 IPv4 地址'],
      ['remote_security_route', '远程纵密路由', '远程纵密路由配置完成'],
      ['dnat', 'DNAT 规则', 'DNAT 规则配置完成'],
      ['conntrack', '连接跟踪超时', '连接跟踪超时已恢复为 600 秒'],
      ['save_config', '配置保存', '纵密配置文件保存完成'],
    ].map(([step_id, name, message]) => ({
      step_id,
      name,
      state: 'success',
      message,
      updated_at: Math.floor(Date.now() / 1000),
    })),
  }),
  loadFullConfigExport: async (filePath: string) => {
    const snapshot = exportSnapshots.get(filePath);
    if (!snapshot) {
      throw new Error(`浏览器开发模式 mock 未找到导出快照: ${filePath}`);
    }
    return clone(snapshot);
  },
};
