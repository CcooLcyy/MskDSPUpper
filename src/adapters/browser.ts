import type { api as tauriApi } from './tauri';
import type {
  AgcGroupConfig,
  AgcGroupInfo,
  AppUpdateDownloadEvent,
  AvcDefaultPointInfo,
  AvcGroupConfig,
  AvcGroupInfo,
  DcConnTags,
  DcConnectionInfo,
  DcPointUpdate,
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
} from './types';
import { buildLowerUpdateLatestUrl } from './lower-update-source';

const DEFAULT_MANAGER_ADDR = '127.0.0.1:17000';
const MANAGER_ADDR_KEY = 'mskdsp_manager_addr';

let managerAddr = localStorage.getItem(MANAGER_ADDR_KEY) || DEFAULT_MANAGER_ADDR;
let nextConnId = 100;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

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
  makeModuleInfo('MQTTManager'),
];

const runningModules = new Set(['ModuleManager', 'DataCenter', 'IEC104', 'ModbusRTU', 'DLT645', 'AGC', 'AVC']);
const iec104Links = new Map<string, Iec104LinkInfo>();
const iec104Tables = new Map<string, Iec104PointTable>();
const modbusLinks = new Map<string, ModbusLinkInfo>();
const modbusTables = new Map<string, ModbusPointTable>();
const dlt645Links = new Map<string, Dlt645LinkInfo>();
const dlt645Tables = new Map<string, Dlt645PointTable>();
const agcGroups = new Map<string, AgcGroupInfo>();
const avcGroups = new Map<string, AvcGroupInfo>();
let routes: DcRoute[] = [];
let modbusMqtt: ModbusMqttConfig | null = null;
let dlt645Mqtt: Dlt645MqttConfig | null = null;
const exportSnapshots = new Map<string, FullConfigExportSnapshot>();

function makeModuleInfo(moduleName: string): ModuleInfo {
  return {
    module_name: moduleName,
    version: {
      major: '0',
      minor: '4',
      patch: '0',
      version: '0.4.0-dev',
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
    dst_conn_id: 0,
    dst_tag: '',
    value: makePointValue(ts / 1000 + index),
    ts_ms: ts,
    quality: 0,
  })));
}

function makeDefaultAvcPoints(groupName: string): AvcDefaultPointInfo[] {
  return [
    { kind: 1, tag: `${groupName}.voltage_meas`, name: '电压测量值', description: '浏览器开发模式 mock 点' },
    { kind: 2, tag: `${groupName}.q_total_cmd`, name: '无功总指令', description: '浏览器开发模式 mock 点' },
    { kind: 3, tag: `${groupName}.q_total_meas`, name: '无功总测量值', description: '浏览器开发模式 mock 点' },
  ];
}

function seedDemoData() {
  const iecConfig: Iec104LinkConfig = {
    conn_name: 'iec104-demo',
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
    time_sync_tag: 'TIME_SYNC',
    station_role: 0,
    point_with_time: false,
  };
  iec104Links.set(iecConfig.conn_name, { config: iecConfig, conn_id: nextId(), state: 1, last_error: '' });
  iec104Tables.set(iecConfig.conn_name, {
    conn_name: iecConfig.conn_name,
    points: [
      { tag: 'P_MEAS', ioa: 1001, point_type: 9, scale: 1, offset: 0, deadband: 0 },
      { tag: 'Q_MEAS', ioa: 1002, point_type: 9, scale: 1, offset: 0, deadband: 0 },
    ],
  });

  const agcConfig: AgcGroupConfig = {
    group_name: 'agc-demo',
    p_cmd: { signal: { tag: 'P_CMD', unit: 'kW', scale: 1, offset: 0 }, mode: 0, delta_base: 0, base_tag: '' },
    strategy: { strategy_type: 'average' },
    members: [
      {
        member_name: 'pcs-1',
        controllable: true,
        capacity_kw: 100,
        weight: 1,
        min_kw: 0,
        max_kw: 100,
        p_meas: { tag: 'PCS1_P', unit: 'kW', scale: 1, offset: 0 },
        p_set: { signal: { tag: 'PCS1_P_SET', unit: 'kW', scale: 1, offset: 0 }, mode: 0, delta_base: 0, base_tag: '' },
      },
    ],
    outputs: {
      p_total_meas: { tag: 'AGC_P_TOTAL', unit: 'kW', scale: 1, offset: 0 },
      p_total_target: { tag: 'AGC_P_TARGET', unit: 'kW', scale: 1, offset: 0 },
      p_total_error: { tag: 'AGC_P_ERROR', unit: 'kW', scale: 1, offset: 0 },
    },
  };
  agcGroups.set(agcConfig.group_name, { config: agcConfig, conn_id: nextId(), state: 1, last_error: '' });
}

seedDemoData();

export const browserApi: typeof tauriApi = {
  setManagerAddr: async (addr: string) => {
    managerAddr = addr;
    localStorage.setItem(MANAGER_ADDR_KEY, addr);
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

  getAppVersion: async () => '0.4.0-browser-dev',
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
    return await response.json() as LowerUpdateManifest;
  },
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
    return {
      package_name: request.package_name,
      remote_path: remotePath,
      command,
      success: true,
      exit_code: 0,
      stdout: 'browser-dev: install command simulated\n',
      stderr: '',
    };
  },

  iec104UpsertLink: async (config: Iec104LinkConfig, createOnly: boolean) =>
    upsertByName(iec104Links, config.conn_name, createOnly, (connId, previous) => ({
      config: clone(config),
      conn_id: connId,
      state: previous?.state ?? 0,
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
  iec104StartLink: async (connName: string) => setLinkState(iec104Links, connName, 1),
  iec104StopLink: async (connName: string) => setLinkState(iec104Links, connName, 0),
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
      state: previous?.state ?? 0,
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
  modbusRtuStartLink: async (connName: string) => setLinkState(modbusLinks, connName, 1),
  modbusRtuStopLink: async (connName: string) => setLinkState(modbusLinks, connName, 0),
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
    routes = replace ? clone(nextRoutes) : clone([...routes, ...nextRoutes]);
  },
  dcDeleteRoutes: async (deleteRoutes: DcRoute[]) => {
    const keys = new Set(deleteRoutes.map((route) => JSON.stringify(route)));
    routes = routes.filter((route) => !keys.has(JSON.stringify(route)));
  },
  dcGetLatest: getLatestUpdates,
  dcStartProtocolShadowStream: async () => {},
  dcGetProtocolShadowLatest: getLatestUpdates,

  agcUpsertGroup: async (config: AgcGroupConfig, createOnly: boolean) => {
    const previous = agcGroups.get(config.group_name);
    ensureUnique(createOnly, Boolean(previous), config.group_name);
    const value: AgcGroupInfo = {
      config: clone(config),
      conn_id: previous?.conn_id ?? nextId(),
      state: previous?.state ?? 0,
      last_error: '',
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
  agcStartGroup: async (groupName: string) => setLinkState(agcGroups, groupName, 1),
  agcStopGroup: async (groupName: string) => setLinkState(agcGroups, groupName, 0),

  avcUpsertGroup: async (config: AvcGroupConfig, createOnly: boolean) => {
    const previous = avcGroups.get(config.group_name);
    ensureUnique(createOnly, Boolean(previous), config.group_name);
    const value: AvcGroupInfo = {
      config: clone(config),
      conn_id: previous?.conn_id ?? nextId(),
      state: previous?.state ?? 0,
      last_error: '',
      default_points: previous?.default_points ?? makeDefaultAvcPoints(config.group_name),
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
    renamed.default_points = makeDefaultAvcPoints(newGroupName);
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
  avcStartGroup: async (groupName: string) => setLinkState(avcGroups, groupName, 1),
  avcStopGroup: async (groupName: string) => setLinkState(avcGroups, groupName, 0),

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
