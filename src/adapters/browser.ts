import type { api as tauriApi } from './tauri';
import type {
  AgcDefaultPointInfo,
  AgcGroupConfig,
  AgcGroupInfo,
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
  LowerUpdateChannel,
  LowerUpdateDownloadProgress,
  LowerUpdateDownloadResult,
  LowerUpdateInstallRequest,
  LowerUpdateInstallResult,
  LowerUpdateManifest,
  LowerUpdateRuntimeInfo,
  LowerUpdateUploadProgress,
  LowerUpdateUploadRequest,
  LowerUpdateUploadResult,
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

// IEC104 LinkState values mirror IEC104.proto.
const IEC104_LINK_STATE = {
  UNSPECIFIED: 0,
  STOPPED: 1,
  RUNNING: 2,
  PENDING_DELETE: 3,
} as const;

let managerAddr = DEFAULT_MANAGER_ADDR;
let nextConnId = 100;

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
  makeModuleInfo('ModbusRTU'),
  makeModuleInfo('DLT645'),
  makeModuleInfo('AGC'),
  makeModuleInfo('AVC'),
  makeModuleInfo('Calc'),
  makeModuleInfo('MQTTManager'),
];

const runningModules = new Set(['ModuleManager', 'DataCenter', 'IEC104', 'ModbusRTU', 'DLT645', 'AGC', 'AVC', 'Calc']);
const iec104Links = new Map<string, Iec104LinkInfo>();
const iec104Tables = new Map<string, Iec104PointTable>();
const modbusLinks = new Map<string, ModbusLinkInfo>();
const modbusTables = new Map<string, ModbusPointTable>();
const dlt645Links = new Map<string, Dlt645LinkInfo>();
const dlt645Tables = new Map<string, Dlt645PointTable>();
const agcGroups = new Map<string, AgcGroupInfo>();
const avcGroups = new Map<string, AvcGroupInfo>();
const calcGroups = new Map<string, CalcGroupInfo>();
let routes: DcRoute[] = [];
let modbusMqtt: ModbusMqttConfig | null = null;
let dlt645Mqtt: Dlt645MqttConfig | null = null;
let browserLatestLowerManifest: LowerUpdateManifest | null = null;
let browserRunningLowerImageId = `sha256:${'0'.repeat(64)}`;
const exportSnapshots = new Map<string, FullConfigExportSnapshot>();

function makeModuleInfo(moduleName: string): ModuleInfo {
  return {
    module_name: moduleName,
    version: {
      major: '0',
      minor: '4',
      patch: '1',
      version: '0.4.1-dev',
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
    quality: 1,
    sequence: ts + index,
  })));
}

function makeDefaultAgcPoints(): AgcDefaultPointInfo[] {
  return [
    { kind: 1, tag: '理论可调有功下限', name: '理论可调有功下限', description: '浏览器开发模式 mock 点' },
    { kind: 2, tag: '理论可调有功上限', name: '理论可调有功上限', description: '浏览器开发模式 mock 点' },
    { kind: 3, tag: '当前可调有功下限', name: '当前可调有功下限', description: '浏览器开发模式 mock 点' },
    { kind: 4, tag: '当前可调有功上限', name: '当前可调有功上限', description: '浏览器开发模式 mock 点' },
    { kind: 5, tag: '调节返回值', name: '调节返回值', description: '浏览器开发模式 mock 点' },
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
      { tag: '有功功率', ioa: 1001, point_type: 1, scale: 1, offset: 0, deadband: 0 },
      { tag: '无功功率', ioa: 1002, point_type: 1, scale: 1, offset: 0, deadband: 0 },
      { tag: '有功设定', ioa: 1101, point_type: 1, scale: 1, offset: 0, deadband: 0 },
      { tag: '运行状态', ioa: 2001, point_type: 2, scale: 1, offset: 0, deadband: 0 },
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
      { tag: '全站有功', ioa: 3001, point_type: 1, scale: 1, offset: 0, deadband: 0.1 },
      { tag: '全站无功', ioa: 3002, point_type: 1, scale: 1, offset: 0, deadband: 0.1 },
      { tag: '母线电压', ioa: 3003, point_type: 1, scale: 0.001, offset: 0, deadband: 0.01 },
      { tag: '断路器状态', ioa: 4001, point_type: 2, scale: 1, offset: 0, deadband: 0 },
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
  clearLowerUpdateCache: async () => ({ removed_files: 0, reclaimed_bytes: 0 }),

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

  getAppVersion: async () => '0.4.1-browser-dev',
  checkAppUpdate: async () => null,
  downloadAndInstallAppUpdate: async (onEvent?: (event: AppUpdateDownloadEvent) => void) => {
    onEvent?.({ event: 'Started', data: { contentLength: 0 } });
    onEvent?.({ event: 'Finished' });
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
    iec104Tables.set(connName, { conn_name: connName, points: replace ? clone(points) : mergeByTag(previous, points) });
  },
  iec104GetPointTable: async (connName: string) => clone(iec104Tables.get(connName) ?? { conn_name: connName, points: [] }),
  iec104SendTimeSync: async () => {},

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
  dcStartProtocolShadowStream: async () => {},
  dcGetProtocolShadowLatest: getLatestUpdates,

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

  avcUpsertGroup: async (config: AvcGroupConfig, createOnly: boolean) => {
    const previous = avcGroups.get(config.group_name);
    ensureUnique(createOnly, Boolean(previous), config.group_name);
    const value: AvcGroupInfo = {
      config: clone(config),
      conn_id: previous?.conn_id ?? nextId(),
      state: previous?.state ?? 0,
      last_error: '',
      default_points: previous?.default_points ?? makeDefaultAvcPoints(),
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
  loadFullConfigExport: async (filePath: string) => {
    const snapshot = exportSnapshots.get(filePath);
    if (!snapshot) {
      throw new Error(`浏览器开发模式 mock 未找到导出快照: ${filePath}`);
    }
    return clone(snapshot);
  },
};
