import { open, save } from '@tauri-apps/plugin-dialog';
import { api } from '../adapters';
import type {
  AgcGroupConfig,
  AvcGroupConfig,
  ConfigExportSectionId,
  DcRoute,
  Dlt645LinkConfig,
  Dlt645MqttConfig,
  FullConfigExportSnapshot,
  Iec104LinkConfig,
  ModbusLinkConfig,
  ModbusMqttConfig,
  ModuleInfo,
  StableDataBusEndpoint,
} from '../adapters';
import { buildDuplicateConnectionName } from './connection-copy';
import { loadStoredMqttConfig, saveStoredMqttConfig } from './mqtt';

const MANAGER_ADDR_KEY = 'mskdsp_manager_addr';
const DEFAULT_MANAGER_ADDR = '127.0.0.1:17000';
const MODBUS_MQTT_STORAGE_KEY = 'protocol.modbus_rtu.mqtt';
const DLT645_MQTT_STORAGE_KEY = 'protocol.dlt645.mqtt';

const MODULE_IEC104 = 'IEC104';
const MODULE_MODBUS_RTU = 'ModbusRTU';
const MODULE_DLT645 = 'DLT645';
const MODULE_AGC = 'AGC';
const MODULE_AVC = 'AVC';
const MODULE_DATA_CENTER = 'DataCenter';
const MODULE_CONFIG_PUSHER = 'ConfigPusher';
const UNCONTROLLED_MODULE_NAMES = new Set([MODULE_CONFIG_PUSHER.toLowerCase()]);

const MODULE_START_RETRY_COUNT = 10;
const MODULE_START_RETRY_INTERVAL_MS = 500;
const DATA_BUS_CONNECTION_RETRY_COUNT = 10;
const DATA_BUS_CONNECTION_RETRY_INTERVAL_MS = 500;

function isUpperControlledModuleName(moduleName: string): boolean {
  return !UNCONTROLLED_MODULE_NAMES.has(moduleName.toLowerCase());
}

const CONFIG_SECTION_DEFINITIONS = [
  {
    key: 'iec104',
    label: 'IEC104',
    groupLabel: '协议接入',
    moduleName: MODULE_IEC104,
    describe: (snapshot?: FullConfigExportSnapshot) =>
      snapshot ? `${snapshot.config.iec104.links.length} 条链路` : '链路与点表配置',
  },
  {
    key: 'modbus_rtu',
    label: 'ModbusRTU',
    groupLabel: '协议接入',
    moduleName: MODULE_MODBUS_RTU,
    describe: (snapshot?: FullConfigExportSnapshot) =>
      snapshot
        ? `${snapshot.config.modbus_rtu.links.length} 条链路${snapshot.config.modbus_rtu.mqtt ? '，含 MQTT 全局配置' : ''}`
        : '链路、点表与 MQTT 全局配置',
  },
  {
    key: 'dlt645',
    label: 'DLT645',
    groupLabel: '协议接入',
    moduleName: MODULE_DLT645,
    describe: (snapshot?: FullConfigExportSnapshot) =>
      snapshot
        ? `${snapshot.config.dlt645.links.length} 条链路${snapshot.config.dlt645.mqtt ? '，含 MQTT 全局配置' : ''}`
        : '链路、点表与 MQTT 全局配置',
  },
  {
    key: 'agc',
    label: 'AGC',
    groupLabel: '其他配置',
    moduleName: MODULE_AGC,
    describe: (snapshot?: FullConfigExportSnapshot) =>
      snapshot ? `${snapshot.config.agc.groups.length} 个控制组` : '控制组配置',
  },
  {
    key: 'avc',
    label: 'AVC',
    groupLabel: '其他配置',
    moduleName: MODULE_AVC,
    describe: (snapshot?: FullConfigExportSnapshot) =>
      snapshot ? `${snapshot.config.avc?.groups.length ?? 0} 个控制组` : '控制组配置',
  },
  {
    key: 'data_bus',
    label: '数据总线',
    groupLabel: '其他配置',
    moduleName: MODULE_DATA_CENTER,
    describe: (snapshot?: FullConfigExportSnapshot) =>
      snapshot ? `${snapshot.config.data_bus.routes.items.length} 条路由` : 'DataBus 路由配置',
  },
] as const;

const ALL_CONFIG_SECTION_IDS = CONFIG_SECTION_DEFINITIONS.map(
  (definition) => definition.key,
) as ConfigExportSectionId[];
const CONFIG_SECTION_SET = new Set<ConfigExportSectionId>(ALL_CONFIG_SECTION_IDS);

export interface FullConfigImportSelection {
  filePath: string;
  snapshot: FullConfigExportSnapshot;
}

export type ConfigImportMode = 'replace' | 'merge';

export interface ConfigSectionOption {
  key: ConfigExportSectionId;
  label: string;
  description: string;
  groupLabel?: string;
  disabled?: boolean;
}

export interface ConfigImportModeOption {
  key: ConfigImportMode;
  label: string;
  description: string;
}

export interface FullConfigImportResult {
  filePath: string;
  mode: ConfigImportMode;
  startedModules: string[];
  warnings: string[];
  sections: ConfigExportSectionId[];
  summary: {
    iec104Links: number;
    modbusRtuLinks: number;
    dlt645Links: number;
    agcGroups: number;
    avcGroups: number;
    dataBusRoutes: number;
  };
}

interface ApplyConfigImportOptions {
  sections?: ConfigExportSectionId[];
  applyGlobals?: boolean;
  mode?: ConfigImportMode;
}

const DEFAULT_CONFIG_IMPORT_MODE: ConfigImportMode = 'merge';

const CONFIG_IMPORT_MODE_OPTIONS: ConfigImportModeOption[] = [
  {
    key: 'replace',
    label: '覆盖',
    description: '以文件为准同步所选模块，删除当前存在但文件中未包含的连接、控制组和路由。',
  },
  {
    key: 'merge',
    label: '合并',
    description: '保留当前已有配置；导入文件中的同名协议连接会自动重命名后追加，不主动删除未出现在文件中的项。',
  },
];

function cloneConfigSnapshot(snapshot: FullConfigExportSnapshot): FullConfigExportSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as FullConfigExportSnapshot;
}

function resolveProtocolMergeConflicts<
  TTask extends {
    link: {
      config: {
        conn_name: string;
      };
    };
    point_table: {
      conn_name: string;
    };
  },
>(
  moduleName: string,
  tasks: TTask[],
  existingNames: Iterable<string>,
  renamedConnections: Map<string, string>,
  warnings: string[],
): void {
  const usedNames = new Set(existingNames);

  for (const task of tasks) {
    const originalConnName = task.link.config.conn_name;
    if (!usedNames.has(originalConnName)) {
      usedNames.add(originalConnName);
      continue;
    }

    const renamedConnName = buildDuplicateConnectionName(originalConnName, usedNames);
    task.link.config.conn_name = renamedConnName;
    task.point_table.conn_name = renamedConnName;
    usedNames.add(renamedConnName);
    renamedConnections.set(connectionKey(moduleName, originalConnName), renamedConnName);
    warnings.push(`合并导入时已将 ${moduleName} 连接 ${originalConnName} 重命名为 ${renamedConnName}`);
  }
}

function rewriteDataBusRoutesForRenamedConnections(
  snapshot: FullConfigExportSnapshot,
  renamedConnections: Map<string, string>,
): void {
  for (const route of snapshot.config.data_bus.routes.items) {
    const srcConnName = renamedConnections.get(connectionKey(route.src.module_name, route.src.conn_name));
    if (srcConnName) {
      route.src.conn_name = srcConnName;
    }

    const dstConnName = renamedConnections.get(connectionKey(route.dst.module_name, route.dst.conn_name));
    if (dstConnName) {
      route.dst.conn_name = dstConnName;
    }
  }
}

async function preprocessMergeImportSnapshot(
  snapshot: FullConfigExportSnapshot,
  mode: ConfigImportMode,
  runningModules: Set<string>,
): Promise<{ snapshot: FullConfigExportSnapshot; warnings: string[] }> {
  if (mode !== 'merge') {
    return { snapshot, warnings: [] };
  }

  const adjustedSnapshot = cloneConfigSnapshot(snapshot);
  const warnings: string[] = [];
  const renamedConnections = new Map<string, string>();
  const [iec104CurrentLinks, modbusCurrentLinks, dlt645CurrentLinks] = await Promise.all([
    runningModules.has(MODULE_IEC104) && adjustedSnapshot.config.iec104.links.length > 0
      ? api.iec104ListLinks()
      : Promise.resolve([]),
    runningModules.has(MODULE_MODBUS_RTU) && adjustedSnapshot.config.modbus_rtu.links.length > 0
      ? api.modbusRtuListLinks()
      : Promise.resolve([]),
    runningModules.has(MODULE_DLT645) && adjustedSnapshot.config.dlt645.links.length > 0
      ? api.dlt645ListLinks()
      : Promise.resolve([]),
  ]);

  resolveProtocolMergeConflicts(
    MODULE_IEC104,
    adjustedSnapshot.config.iec104.links,
    iec104CurrentLinks
      .map((link) => link.config?.conn_name)
      .filter((connName): connName is string => Boolean(connName)),
    renamedConnections,
    warnings,
  );
  resolveProtocolMergeConflicts(
    MODULE_MODBUS_RTU,
    adjustedSnapshot.config.modbus_rtu.links,
    modbusCurrentLinks
      .map((link) => link.config?.conn_name)
      .filter((connName): connName is string => Boolean(connName)),
    renamedConnections,
    warnings,
  );
  resolveProtocolMergeConflicts(
    MODULE_DLT645,
    adjustedSnapshot.config.dlt645.links,
    dlt645CurrentLinks
      .map((link) => link.config?.conn_name)
      .filter((connName): connName is string => Boolean(connName)),
    renamedConnections,
    warnings,
  );
  rewriteDataBusRoutesForRenamedConnections(adjustedSnapshot, renamedConnections);

  return {
    snapshot: adjustedSnapshot,
    warnings,
  };
}

function getStoredManagerAddr(): string {
  try {
    return globalThis.localStorage?.getItem(MANAGER_ADDR_KEY) || DEFAULT_MANAGER_ADDR;
  } catch {
    return DEFAULT_MANAGER_ADDR;
  }
}

function setStoredManagerAddr(addr: string): void {
  try {
    globalThis.localStorage?.setItem(MANAGER_ADDR_KEY, addr);
  } catch {
    // Ignore storage failures and keep the import flow usable.
  }
}

function assertModuleConfig<T>(moduleName: string, index: number, config: T | null): T {
  if (!config) {
    throw new Error(`${moduleName} 第 ${index + 1} 项缺少配置`);
  }

  return config;
}

function dedupeConfigSections(sections: readonly ConfigExportSectionId[]): ConfigExportSectionId[] {
  const ordered = new Set<ConfigExportSectionId>();

  for (const section of ALL_CONFIG_SECTION_IDS) {
    if (sections.includes(section)) {
      ordered.add(section);
    }
  }

  return Array.from(ordered);
}

function isConfigSectionId(value: string): value is ConfigExportSectionId {
  return CONFIG_SECTION_SET.has(value as ConfigExportSectionId);
}

function isFullSectionSelection(sections: readonly ConfigExportSectionId[]): boolean {
  return dedupeConfigSections(sections).length === ALL_CONFIG_SECTION_IDS.length;
}

function buildConfigExportMetadata(sections: readonly ConfigExportSectionId[]): FullConfigExportSnapshot['metadata'] {
  const includedSections = dedupeConfigSections(sections);

  return {
    scope: isFullSectionSelection(includedSections) ? 'full' : 'partial',
    included_sections: includedSections,
  };
}

function getSectionModuleNames(sections: readonly ConfigExportSectionId[]): Set<string> {
  return new Set(
    CONFIG_SECTION_DEFINITIONS.filter((definition) => sections.includes(definition.key)).map(
      (definition) => definition.moduleName,
    ),
  );
}

function scopeConfigSnapshot(
  snapshot: FullConfigExportSnapshot,
  sections: readonly ConfigExportSectionId[],
): FullConfigExportSnapshot {
  const includedSections = dedupeConfigSections(sections);

  if (includedSections.length === 0) {
    throw new Error('至少需要选择一个配置分区');
  }

  const isFull = isFullSectionSelection(includedSections);
  const allowedModules = isFull ? null : getSectionModuleNames(includedSections);
  const includedSectionSet = new Set(includedSections);
  const startupModules = snapshot.module_startup.modules.filter(isUpperControlledModuleName);

  return {
    ...snapshot,
    module_startup: {
      ...snapshot.module_startup,
      modules: isFull
        ? startupModules
        : startupModules.filter((moduleName) => allowedModules?.has(moduleName)),
    },
    config: {
      iec104: includedSectionSet.has('iec104') ? snapshot.config.iec104 : { links: [] },
      modbus_rtu: includedSectionSet.has('modbus_rtu')
        ? snapshot.config.modbus_rtu
        : { mqtt: null, links: [] },
      dlt645: includedSectionSet.has('dlt645') ? snapshot.config.dlt645 : { mqtt: null, links: [] },
      agc: includedSectionSet.has('agc') ? snapshot.config.agc : { groups: [] },
      avc: includedSectionSet.has('avc') ? snapshot.config.avc ?? { groups: [] } : { groups: [] },
      data_bus: includedSectionSet.has('data_bus')
        ? snapshot.config.data_bus
        : {
            routes: {
              replace: true,
              items: [],
            },
          },
    },
    metadata: buildConfigExportMetadata(includedSections),
  };
}

export function getAllConfigSectionIds(): ConfigExportSectionId[] {
  return [...ALL_CONFIG_SECTION_IDS];
}

export function getConfigSectionOptions(snapshot?: FullConfigExportSnapshot): ConfigSectionOption[] {
  const includedSections = snapshot ? new Set(getIncludedConfigSections(snapshot)) : null;

  return CONFIG_SECTION_DEFINITIONS.map((definition) => ({
    key: definition.key,
    label: definition.label,
    description: definition.describe(snapshot),
    groupLabel: definition.groupLabel,
    disabled: includedSections ? !includedSections.has(definition.key) : false,
  }));
}

export function getConfigSectionLabel(section: ConfigExportSectionId): string {
  return CONFIG_SECTION_DEFINITIONS.find((definition) => definition.key === section)?.label ?? section;
}

export function getConfigImportModeOptions(): ConfigImportModeOption[] {
  return CONFIG_IMPORT_MODE_OPTIONS.map((option) => ({ ...option }));
}

export function getConfigImportModeLabel(mode: ConfigImportMode): string {
  return CONFIG_IMPORT_MODE_OPTIONS.find((option) => option.key === mode)?.label ?? mode;
}

export function getIncludedConfigSections(snapshot: FullConfigExportSnapshot): ConfigExportSectionId[] {
  const includedSections = snapshot.metadata?.included_sections?.filter(isConfigSectionId) ?? [];

  if (includedSections.length > 0) {
    return dedupeConfigSections(includedSections);
  }

  return getAllConfigSectionIds();
}

function normalizeConfigImportMode(mode?: ConfigImportMode): ConfigImportMode {
  return mode ?? DEFAULT_CONFIG_IMPORT_MODE;
}

async function loadIec104Config(runningModules: Set<string>): Promise<FullConfigExportSnapshot['config']['iec104']> {
  if (!runningModules.has(MODULE_IEC104)) {
    return { links: [] };
  }

  const links = await api.iec104ListLinks();
  const tasks = await Promise.all(
    links.map(async (linkInfo, index) => {
      const config = assertModuleConfig<Iec104LinkConfig>(MODULE_IEC104, index, linkInfo.config);
      const pointTable = await api.iec104GetPointTable(config.conn_name);

      return {
        link: { config },
        point_table: {
          conn_name: pointTable.conn_name,
          points: pointTable.points,
          replace: true as const,
        },
      };
    }),
  );

  return { links: tasks };
}

async function loadModbusRtuConfig(
  runningModules: Set<string>,
): Promise<FullConfigExportSnapshot['config']['modbus_rtu']> {
  if (!runningModules.has(MODULE_MODBUS_RTU)) {
    return { mqtt: null, links: [] };
  }

  const links = await api.modbusRtuListLinks();
  const mqtt = loadStoredMqttConfig<ModbusMqttConfig>(MODBUS_MQTT_STORAGE_KEY);

  if (links.some((item) => item.config?.transport_type === 2) && !mqtt) {
    throw new Error('本地存储中缺少 ModbusRTU 的 MQTT 配置');
  }

  const tasks = await Promise.all(
    links.map(async (linkInfo, index) => {
      const config = assertModuleConfig<ModbusLinkConfig>(MODULE_MODBUS_RTU, index, linkInfo.config);
      const pointTable = await api.modbusRtuGetPointTable(config.conn_name);

      return {
        link: { config },
        point_table: {
          conn_name: pointTable.conn_name,
          points: pointTable.points,
          replace: true as const,
        },
      };
    }),
  );

  return { mqtt, links: tasks };
}

async function loadDlt645Config(runningModules: Set<string>): Promise<FullConfigExportSnapshot['config']['dlt645']> {
  if (!runningModules.has(MODULE_DLT645)) {
    return { mqtt: null, links: [] };
  }

  const links = await api.dlt645ListLinks();
  const mqtt = loadStoredMqttConfig<Dlt645MqttConfig>(DLT645_MQTT_STORAGE_KEY);

  if (links.length > 0 && !mqtt) {
    throw new Error('本地存储中缺少 DLT645 的 MQTT 配置');
  }

  const tasks = await Promise.all(
    links.map(async (linkInfo, index) => {
      const config = assertModuleConfig<Dlt645LinkConfig>(MODULE_DLT645, index, linkInfo.config);
      const pointTable = await api.dlt645GetPointTable(config.conn_name);

      return {
        link: { config },
        point_table: {
          conn_name: pointTable.conn_name,
          points: pointTable.points,
          blocks: pointTable.blocks,
          replace: true as const,
        },
      };
    }),
  );

  return { mqtt, links: tasks };
}

async function loadAgcConfig(runningModules: Set<string>): Promise<FullConfigExportSnapshot['config']['agc']> {
  if (!runningModules.has(MODULE_AGC)) {
    return { groups: [] };
  }

  const groups = await api.agcListGroups();

  return {
    groups: groups.map((groupInfo, index) => ({
      upsert: {
        config: assertModuleConfig<AgcGroupConfig>(MODULE_AGC, index, groupInfo.config),
      },
    })),
  };
}

async function loadAvcConfig(runningModules: Set<string>): Promise<FullConfigExportSnapshot['config']['avc']> {
  if (!runningModules.has(MODULE_AVC)) {
    return { groups: [] };
  }

  const groups = await api.avcListGroups();

  return {
    groups: groups.map((groupInfo, index) => ({
      upsert: {
        config: assertModuleConfig<AvcGroupConfig>(MODULE_AVC, index, groupInfo.config),
      },
    })),
  };
}

function resolveStableDataBusEndpoint(
  connId: number,
  tag: string,
  connectionMap: Map<number, { module_name: string; conn_name: string }>,
): StableDataBusEndpoint {
  const connection = connectionMap.get(connId);

  if (!connection) {
    throw new Error(`无法解析 DataBus 路由端点，conn_id=${connId}`);
  }

  return {
    module_name: connection.module_name,
    conn_name: connection.conn_name,
    tag,
  };
}

async function loadDataBusConfig(
  runningModules: Set<string>,
): Promise<FullConfigExportSnapshot['config']['data_bus']> {
  if (!runningModules.has(MODULE_DATA_CENTER)) {
    return {
      routes: {
        replace: true,
        items: [],
      },
    };
  }

  const [connections, routes] = await Promise.all([
    api.dcListConnections(),
    api.dcListRoutes(0, '', 0, ''),
  ]);

  const connectionMap = new Map(
    connections.map((connection) => [
      connection.conn_id,
      {
        module_name: connection.module_name,
        conn_name: connection.conn_name,
      },
    ]),
  );

  return {
    routes: {
      replace: true,
      items: routes.map((route) => ({
        src: resolveStableDataBusEndpoint(route.src.conn_id, route.src.tag, connectionMap),
        dst: resolveStableDataBusEndpoint(route.dst.conn_id, route.dst.tag, connectionMap),
      })),
    },
  };
}

function buildExportFileName(exportedAt: string, sections: readonly ConfigExportSectionId[]): string {
  const date = new Date(exportedAt);
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const sec = String(date.getSeconds()).padStart(2, '0');
  const normalizedSections = dedupeConfigSections(sections);
  const prefix = isFullSectionSelection(normalizedSections)
    ? 'mskdsp-upper-config'
    : `mskdsp-upper-config-${normalizedSections.join('-').replaceAll('_', '-')}`;

  return `${prefix}-${yyyy}${mm}${dd}-${hh}${min}${sec}.mskcfg`;
}

function ensureExportExtension(filePath: string): string {
  return /\.mskcfg$/i.test(filePath) ? filePath : `${filePath}.mskcfg`;
}

function normalizeSelectedImportPath(selectedPath: string | string[]): string | null {
  if (Array.isArray(selectedPath)) {
    return selectedPath[0] ?? null;
  }

  return selectedPath;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function collectDesiredModules(snapshot: FullConfigExportSnapshot): Set<string> {
  const modules = new Set(snapshot.module_startup.modules.filter(isUpperControlledModuleName));

  if (snapshot.config.iec104.links.length > 0) {
    modules.add(MODULE_IEC104);
  }

  if (snapshot.config.modbus_rtu.links.length > 0 || snapshot.config.modbus_rtu.mqtt) {
    modules.add(MODULE_MODBUS_RTU);
  }

  if (snapshot.config.dlt645.links.length > 0 || snapshot.config.dlt645.mqtt) {
    modules.add(MODULE_DLT645);
  }

  if (snapshot.config.agc.groups.length > 0) {
    modules.add(MODULE_AGC);
  }

  if (snapshot.config.avc.groups.length > 0) {
    modules.add(MODULE_AVC);
  }

  if (snapshot.config.data_bus.routes.items.length > 0) {
    modules.add(MODULE_DATA_CENTER);
  }

  return modules;
}

function sortModulesByDependency(targetModules: Set<string>, moduleMap: Map<string, ModuleInfo>): string[] {
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (moduleName: string) => {
    if (!targetModules.has(moduleName) || visited.has(moduleName) || visiting.has(moduleName)) {
      return;
    }

    visiting.add(moduleName);

    const moduleInfo = moduleMap.get(moduleName);
    for (const dependency of moduleInfo?.dependencies ?? []) {
      visit(dependency.module_name);
    }

    visiting.delete(moduleName);
    visited.add(moduleName);
    ordered.push(moduleName);
  };

  for (const moduleName of targetModules) {
    visit(moduleName);
  }

  return ordered;
}

function connectionKey(moduleName: string, connName: string): string {
  return `${moduleName}\u0000${connName}`;
}

async function waitForRunningModules(targetModules: string[]): Promise<Set<string>> {
  let runningModules = new Set<string>();

  for (let attempt = 0; attempt < MODULE_START_RETRY_COUNT; attempt += 1) {
    const runningInfo = await api.getRunningModuleInfo();
    runningModules = new Set(runningInfo.map((item) => item.module_name));

    if (targetModules.every((moduleName) => runningModules.has(moduleName))) {
      break;
    }

    if (attempt < MODULE_START_RETRY_COUNT - 1) {
      await sleep(MODULE_START_RETRY_INTERVAL_MS);
    }
  }

  return runningModules;
}

async function ensureModulesReady(snapshot: FullConfigExportSnapshot): Promise<{
  runningModules: Set<string>;
  startedModules: string[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const desiredModules = collectDesiredModules(snapshot);
  const [moduleInfoList, runningInfoList] = await Promise.all([
    api.getModuleInfo(),
    api.getRunningModuleInfo(),
  ]);

  const moduleMap = new Map(moduleInfoList.map((moduleInfo) => [moduleInfo.module_name, moduleInfo]));
  const initialRunning = new Set(runningInfoList.map((item) => item.module_name));
  const orderedModules = sortModulesByDependency(desiredModules, moduleMap);
  const startedModules: string[] = [];
  const waitTargets: string[] = [];

  for (const moduleName of orderedModules) {
    const moduleInfo = moduleMap.get(moduleName);

    if (!moduleInfo) {
      warnings.push(`模块 ${moduleName} 未在 ModuleManager 中注册`);
      continue;
    }

    if (moduleInfo.manifest_error) {
      warnings.push(`模块 ${moduleName} 存在 manifest 错误，已跳过`);
      continue;
    }

    if (initialRunning.has(moduleName)) {
      waitTargets.push(moduleName);
      continue;
    }

    await api.startModule(moduleInfo);
    startedModules.push(moduleName);
    waitTargets.push(moduleName);
  }

  const runningModules = waitTargets.length > 0 ? await waitForRunningModules(waitTargets) : initialRunning;

  for (const moduleName of waitTargets) {
    if (!runningModules.has(moduleName)) {
      warnings.push(`模块 ${moduleName} 未在限定时间内就绪`);
    }
  }

  return {
    runningModules,
    startedModules,
    warnings,
  };
}

async function syncIec104(snapshot: FullConfigExportSnapshot, mode: ConfigImportMode): Promise<void> {
  const replace = mode === 'replace';
  const targetNames = new Set(snapshot.config.iec104.links.map((task) => task.link.config.conn_name));
  const currentLinks = await api.iec104ListLinks();

  if (replace) {
    for (const currentLink of currentLinks) {
      const connName = currentLink.config?.conn_name;
      if (connName && !targetNames.has(connName)) {
        await api.iec104DeleteLink(connName);
      }
    }
  }

  for (const task of snapshot.config.iec104.links) {
    await api.iec104UpsertLink(task.link.config, false);
    await api.iec104UpsertPointTable(task.point_table.conn_name, task.point_table.points, replace);
  }
}

async function syncModbusRtu(snapshot: FullConfigExportSnapshot, mode: ConfigImportMode): Promise<void> {
  const replace = mode === 'replace';
  if (snapshot.config.modbus_rtu.mqtt) {
    await api.modbusRtuUpdateConfig(snapshot.config.modbus_rtu.mqtt);
    saveStoredMqttConfig(MODBUS_MQTT_STORAGE_KEY, snapshot.config.modbus_rtu.mqtt);
  }

  const targetNames = new Set(snapshot.config.modbus_rtu.links.map((task) => task.link.config.conn_name));
  const currentLinks = await api.modbusRtuListLinks();

  if (replace) {
    for (const currentLink of currentLinks) {
      const connName = currentLink.config?.conn_name;
      if (connName && !targetNames.has(connName)) {
        await api.modbusRtuDeleteLink(connName);
      }
    }
  }

  for (const task of snapshot.config.modbus_rtu.links) {
    await api.modbusRtuUpsertLink(task.link.config, false);
    await api.modbusRtuUpsertPointTable(task.point_table.conn_name, task.point_table.points, replace);
  }
}

async function syncDlt645(snapshot: FullConfigExportSnapshot, mode: ConfigImportMode): Promise<void> {
  const replace = mode === 'replace';
  if (snapshot.config.dlt645.mqtt) {
    await api.dlt645UpdateConfig(snapshot.config.dlt645.mqtt);
    saveStoredMqttConfig(DLT645_MQTT_STORAGE_KEY, snapshot.config.dlt645.mqtt);
  }

  const targetNames = new Set(snapshot.config.dlt645.links.map((task) => task.link.config.conn_name));
  const currentLinks = await api.dlt645ListLinks();

  if (replace) {
    for (const currentLink of currentLinks) {
      const connName = currentLink.config?.conn_name;
      if (connName && !targetNames.has(connName)) {
        await api.dlt645DeleteLink(connName);
      }
    }
  }

  for (const task of snapshot.config.dlt645.links) {
    await api.dlt645UpsertLink(task.link.config, false);
    await api.dlt645UpsertPointTable(
      task.point_table.conn_name,
      task.point_table.points,
      task.point_table.blocks,
      replace,
    );
  }
}

async function syncAgc(snapshot: FullConfigExportSnapshot, mode: ConfigImportMode): Promise<void> {
  const targetNames = new Set(snapshot.config.agc.groups.map((task) => task.upsert.config.group_name));
  const currentGroups = await api.agcListGroups();

  if (mode === 'replace') {
    for (const currentGroup of currentGroups) {
      const groupName = currentGroup.config?.group_name;
      if (groupName && !targetNames.has(groupName)) {
        await api.agcDeleteGroup(groupName);
      }
    }
  }

  for (const task of snapshot.config.agc.groups) {
    await api.agcUpsertGroup(task.upsert.config, false);
  }
}

async function syncAvc(snapshot: FullConfigExportSnapshot, mode: ConfigImportMode): Promise<void> {
  const targetNames = new Set(snapshot.config.avc.groups.map((task) => task.upsert.config.group_name));
  const currentGroups = await api.avcListGroups();

  if (mode === 'replace') {
    for (const currentGroup of currentGroups) {
      const groupName = currentGroup.config?.group_name;
      if (groupName && !targetNames.has(groupName)) {
        await api.avcDeleteGroup(groupName);
      }
    }
  }

  for (const task of snapshot.config.avc.groups) {
    await api.avcUpsertGroup(task.upsert.config, false);
  }
}

async function waitForConnectionMap(requiredKeys: Set<string>): Promise<Map<string, number>> {
  let connectionMap = new Map<string, number>();

  for (let attempt = 0; attempt < DATA_BUS_CONNECTION_RETRY_COUNT; attempt += 1) {
    const connections = await api.dcListConnections();
    connectionMap = new Map(
      connections.map((connection) => [connectionKey(connection.module_name, connection.conn_name), connection.conn_id]),
    );

    const allReady = Array.from(requiredKeys).every((key) => connectionMap.has(key));
    if (allReady) {
      break;
    }

    if (attempt < DATA_BUS_CONNECTION_RETRY_COUNT - 1) {
      await sleep(DATA_BUS_CONNECTION_RETRY_INTERVAL_MS);
    }
  }

  return connectionMap;
}

function toDcRoute(
  route: FullConfigExportSnapshot['config']['data_bus']['routes']['items'][number],
  connectionMap: Map<string, number>,
): DcRoute {
  const srcConnId = connectionMap.get(connectionKey(route.src.module_name, route.src.conn_name));
  const dstConnId = connectionMap.get(connectionKey(route.dst.module_name, route.dst.conn_name));

  if (srcConnId === undefined || dstConnId === undefined) {
    throw new Error(
      `DataBus 路由端点不可用：${route.src.module_name}/${route.src.conn_name} -> ${route.dst.module_name}/${route.dst.conn_name}`,
    );
  }

  return {
    src: {
      conn_id: srcConnId,
      tag: route.src.tag,
    },
    dst: {
      conn_id: dstConnId,
      tag: route.dst.tag,
    },
  };
}

async function syncDataBus(snapshot: FullConfigExportSnapshot, mode: ConfigImportMode): Promise<void> {
  const replace = mode === 'replace';
  const routeItems = snapshot.config.data_bus.routes.items;

  if (routeItems.length === 0) {
    await api.dcUpsertRoutes([], replace);
    return;
  }

  const requiredKeys = new Set<string>();
  for (const route of routeItems) {
    requiredKeys.add(connectionKey(route.src.module_name, route.src.conn_name));
    requiredKeys.add(connectionKey(route.dst.module_name, route.dst.conn_name));
  }

  const connectionMap = await waitForConnectionMap(requiredKeys);
  const routes = routeItems.map((route) => toDcRoute(route, connectionMap));
  await api.dcUpsertRoutes(routes, replace);
}

export async function buildConfigExportSnapshot(
  sections: readonly ConfigExportSectionId[] = ALL_CONFIG_SECTION_IDS,
): Promise<FullConfigExportSnapshot> {
  const [appVersionResult, runningModulesInfo] = await Promise.all([
    api.getAppVersion().catch(() => null),
    api.getRunningModuleInfo(),
  ]);
  const runningModules = new Set(
    runningModulesInfo
      .map((moduleInfo) => moduleInfo.module_name)
      .filter(isUpperControlledModuleName),
  );
  const exportedAt = new Date().toISOString();
  const [iec104, modbusRtu, dlt645, agc, avc, dataBus] = await Promise.all([
    loadIec104Config(runningModules),
    loadModbusRtuConfig(runningModules),
    loadDlt645Config(runningModules),
    loadAgcConfig(runningModules),
    loadAvcConfig(runningModules),
    loadDataBusConfig(runningModules),
  ]);

  const snapshot: FullConfigExportSnapshot = {
    schema_version: 1,
    exported_at: exportedAt,
    source: {
      ...(appVersionResult ? { app_version: appVersionResult } : {}),
      manager_addr: getStoredManagerAddr(),
    },
    module_startup: {
      source: 'get_running_module_info',
      modules: Array.from(runningModules).sort((left, right) => left.localeCompare(right)),
    },
    config: {
      iec104,
      modbus_rtu: modbusRtu,
      dlt645,
      agc,
      avc,
      data_bus: dataBus,
    },
    metadata: buildConfigExportMetadata(ALL_CONFIG_SECTION_IDS),
  };

  return scopeConfigSnapshot(snapshot, sections);
}

export async function buildFullConfigExportSnapshot(): Promise<FullConfigExportSnapshot> {
  return buildConfigExportSnapshot();
}

export async function saveFullConfigExport(snapshot: FullConfigExportSnapshot): Promise<string | null> {
  const defaultFileName = buildExportFileName(snapshot.exported_at, getIncludedConfigSections(snapshot));
  const selectedPath = await save({
    title: '导出完整配置',
    defaultPath: defaultFileName,
    filters: [
      {
        name: 'MskDSP 配置',
        extensions: ['mskcfg'],
      },
    ],
  });

  if (!selectedPath) {
    return null;
  }

  const finalPath = ensureExportExtension(selectedPath);
  return api.saveFullConfigExport(finalPath, snapshot);
}

export async function selectFullConfigImport(): Promise<FullConfigImportSelection | null> {
  const selectedPath = await open({
    title: '导入完整配置',
    multiple: false,
    directory: false,
    filters: [
      {
        name: 'MskDSP 配置',
        extensions: ['mskcfg'],
      },
    ],
  });

  if (!selectedPath) {
    return null;
  }

  const filePath = normalizeSelectedImportPath(selectedPath);
  if (!filePath) {
    return null;
  }

  const snapshot = await api.loadFullConfigExport(filePath);
  return { filePath, snapshot };
}

export async function applyConfigImport(
  selection: FullConfigImportSelection,
  options: ApplyConfigImportOptions = {},
): Promise<FullConfigImportResult> {
  const sections = dedupeConfigSections(options.sections ?? getIncludedConfigSections(selection.snapshot));
  const mode = normalizeConfigImportMode(options.mode);
  const scopedSnapshot = scopeConfigSnapshot(selection.snapshot, sections);
  const warnings: string[] = [];
  const shouldApplyGlobals = options.applyGlobals ?? scopedSnapshot.metadata.scope !== 'partial';

  if (shouldApplyGlobals) {
    await api.setManagerAddr(scopedSnapshot.source.manager_addr);
    setStoredManagerAddr(scopedSnapshot.source.manager_addr);
  }

  const {
    runningModules,
    startedModules,
    warnings: moduleWarnings,
  } = await ensureModulesReady(scopedSnapshot);
  warnings.push(...moduleWarnings);

  const {
    snapshot,
    warnings: mergeWarnings,
  } = await preprocessMergeImportSnapshot(scopedSnapshot, mode, runningModules);
  warnings.push(...mergeWarnings);

  const desiredModules = collectDesiredModules(snapshot);

  const syncTasks: Promise<void>[] = [];

  if (desiredModules.has(MODULE_IEC104) && runningModules.has(MODULE_IEC104)) {
    syncTasks.push(syncIec104(snapshot, mode));
  } else if (desiredModules.has(MODULE_IEC104)) {
    warnings.push('IEC104 未运行，已跳过其链路导入');
  }

  if (desiredModules.has(MODULE_MODBUS_RTU) && runningModules.has(MODULE_MODBUS_RTU)) {
    syncTasks.push(syncModbusRtu(snapshot, mode));
  } else if (desiredModules.has(MODULE_MODBUS_RTU)) {
    warnings.push('ModbusRTU 未运行，已跳过其链路导入');
  }

  if (desiredModules.has(MODULE_DLT645) && runningModules.has(MODULE_DLT645)) {
    syncTasks.push(syncDlt645(snapshot, mode));
  } else if (desiredModules.has(MODULE_DLT645)) {
    warnings.push('DLT645 未运行，已跳过其链路导入');
  }

  if (desiredModules.has(MODULE_AGC) && runningModules.has(MODULE_AGC)) {
    syncTasks.push(syncAgc(snapshot, mode));
  } else if (desiredModules.has(MODULE_AGC)) {
    warnings.push('AGC 未运行，已跳过其控制组导入');
  }

  if (desiredModules.has(MODULE_AVC) && runningModules.has(MODULE_AVC)) {
    syncTasks.push(syncAvc(snapshot, mode));
  } else if (desiredModules.has(MODULE_AVC)) {
    warnings.push('AVC 未运行，已跳过其控制组导入');
  }

  await Promise.all(syncTasks);

  if (desiredModules.has(MODULE_DATA_CENTER) && runningModules.has(MODULE_DATA_CENTER)) {
    await syncDataBus(snapshot, mode);
  } else if (desiredModules.has(MODULE_DATA_CENTER)) {
    warnings.push('DataCenter 未运行，已跳过 DataBus 路由导入');
  }

  return {
    filePath: selection.filePath,
    mode,
    startedModules,
    warnings,
    sections,
    summary: {
      iec104Links: snapshot.config.iec104.links.length,
      modbusRtuLinks: snapshot.config.modbus_rtu.links.length,
      dlt645Links: snapshot.config.dlt645.links.length,
      agcGroups: snapshot.config.agc.groups.length,
      avcGroups: snapshot.config.avc.groups.length,
      dataBusRoutes: snapshot.config.data_bus.routes.items.length,
    },
  };
}

export async function applyFullConfigImport(
  selection: FullConfigImportSelection,
  options: Omit<ApplyConfigImportOptions, 'sections' | 'applyGlobals'> = {},
): Promise<FullConfigImportResult> {
  return applyConfigImport(selection, options);
}
