import { open, save } from '@tauri-apps/plugin-dialog';
import { api } from '../adapters';
import type {
  AgcGroupConfig,
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
import { loadStoredMqttConfig, saveStoredMqttConfig } from './mqtt';

const MANAGER_ADDR_KEY = 'mskdsp_manager_addr';
const DEFAULT_MANAGER_ADDR = '127.0.0.1:17000';
const MODBUS_MQTT_STORAGE_KEY = 'protocol.modbus_rtu.mqtt';
const DLT645_MQTT_STORAGE_KEY = 'protocol.dlt645.mqtt';

const MODULE_IEC104 = 'IEC104';
const MODULE_MODBUS_RTU = 'ModbusRTU';
const MODULE_DLT645 = 'DLT645';
const MODULE_AGC = 'AGC';
const MODULE_DATA_CENTER = 'DataCenter';

const MODULE_START_RETRY_COUNT = 10;
const MODULE_START_RETRY_INTERVAL_MS = 500;
const DATA_BUS_CONNECTION_RETRY_COUNT = 10;
const DATA_BUS_CONNECTION_RETRY_INTERVAL_MS = 500;

export interface FullConfigImportSelection {
  filePath: string;
  snapshot: FullConfigExportSnapshot;
}

export interface FullConfigImportResult {
  filePath: string;
  startedModules: string[];
  warnings: string[];
  summary: {
    iec104Links: number;
    modbusRtuLinks: number;
    dlt645Links: number;
    agcGroups: number;
    dataBusRoutes: number;
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
    throw new Error(`${moduleName} item #${index + 1} is missing config`);
  }

  return config;
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
    throw new Error('ModbusRTU MQTT config is missing from local storage');
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
    throw new Error('DLT645 MQTT config is missing from local storage');
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

function resolveStableDataBusEndpoint(
  connId: number,
  tag: string,
  connectionMap: Map<number, { module_name: string; conn_name: string }>,
): StableDataBusEndpoint {
  const connection = connectionMap.get(connId);

  if (!connection) {
    throw new Error(`Failed to resolve DataBus route endpoint for conn_id=${connId}`);
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

function buildExportFileName(exportedAt: string): string {
  const date = new Date(exportedAt);
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const sec = String(date.getSeconds()).padStart(2, '0');

  return `mskdsp-upper-config-${yyyy}${mm}${dd}-${hh}${min}${sec}.mskcfg`;
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
  const modules = new Set(snapshot.module_startup.modules);

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
      warnings.push(`Module ${moduleName} is missing from ModuleManager`);
      continue;
    }

    if (moduleInfo.manifest_error) {
      warnings.push(`Module ${moduleName} has manifest error and was skipped`);
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
      warnings.push(`Module ${moduleName} did not become ready in time`);
    }
  }

  return {
    runningModules,
    startedModules,
    warnings,
  };
}

async function syncIec104(snapshot: FullConfigExportSnapshot): Promise<void> {
  const targetNames = new Set(snapshot.config.iec104.links.map((task) => task.link.config.conn_name));
  const currentLinks = await api.iec104ListLinks();

  for (const currentLink of currentLinks) {
    const connName = currentLink.config?.conn_name;
    if (connName && !targetNames.has(connName)) {
      await api.iec104DeleteLink(connName);
    }
  }

  for (const task of snapshot.config.iec104.links) {
    await api.iec104UpsertLink(task.link.config, false);
    await api.iec104UpsertPointTable(task.point_table.conn_name, task.point_table.points, task.point_table.replace);
  }
}

async function syncModbusRtu(snapshot: FullConfigExportSnapshot): Promise<void> {
  if (snapshot.config.modbus_rtu.mqtt) {
    await api.modbusRtuUpdateConfig(snapshot.config.modbus_rtu.mqtt);
    saveStoredMqttConfig(MODBUS_MQTT_STORAGE_KEY, snapshot.config.modbus_rtu.mqtt);
  }

  const targetNames = new Set(snapshot.config.modbus_rtu.links.map((task) => task.link.config.conn_name));
  const currentLinks = await api.modbusRtuListLinks();

  for (const currentLink of currentLinks) {
    const connName = currentLink.config?.conn_name;
    if (connName && !targetNames.has(connName)) {
      await api.modbusRtuDeleteLink(connName);
    }
  }

  for (const task of snapshot.config.modbus_rtu.links) {
    await api.modbusRtuUpsertLink(task.link.config, false);
    await api.modbusRtuUpsertPointTable(task.point_table.conn_name, task.point_table.points, task.point_table.replace);
  }
}

async function syncDlt645(snapshot: FullConfigExportSnapshot): Promise<void> {
  if (snapshot.config.dlt645.mqtt) {
    await api.dlt645UpdateConfig(snapshot.config.dlt645.mqtt);
    saveStoredMqttConfig(DLT645_MQTT_STORAGE_KEY, snapshot.config.dlt645.mqtt);
  }

  const targetNames = new Set(snapshot.config.dlt645.links.map((task) => task.link.config.conn_name));
  const currentLinks = await api.dlt645ListLinks();

  for (const currentLink of currentLinks) {
    const connName = currentLink.config?.conn_name;
    if (connName && !targetNames.has(connName)) {
      await api.dlt645DeleteLink(connName);
    }
  }

  for (const task of snapshot.config.dlt645.links) {
    await api.dlt645UpsertLink(task.link.config, false);
    await api.dlt645UpsertPointTable(
      task.point_table.conn_name,
      task.point_table.points,
      task.point_table.blocks,
      task.point_table.replace,
    );
  }
}

async function syncAgc(snapshot: FullConfigExportSnapshot): Promise<void> {
  const targetNames = new Set(snapshot.config.agc.groups.map((task) => task.upsert.config.group_name));
  const currentGroups = await api.agcListGroups();

  for (const currentGroup of currentGroups) {
    const groupName = currentGroup.config?.group_name;
    if (groupName && !targetNames.has(groupName)) {
      await api.agcDeleteGroup(groupName);
    }
  }

  for (const task of snapshot.config.agc.groups) {
    await api.agcUpsertGroup(task.upsert.config, false);
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
      `DataBus route endpoint is unavailable: ${route.src.module_name}/${route.src.conn_name} -> ${route.dst.module_name}/${route.dst.conn_name}`,
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

async function syncDataBus(snapshot: FullConfigExportSnapshot): Promise<void> {
  const routeItems = snapshot.config.data_bus.routes.items;

  if (routeItems.length === 0) {
    await api.dcUpsertRoutes([], snapshot.config.data_bus.routes.replace);
    return;
  }

  const requiredKeys = new Set<string>();
  for (const route of routeItems) {
    requiredKeys.add(connectionKey(route.src.module_name, route.src.conn_name));
    requiredKeys.add(connectionKey(route.dst.module_name, route.dst.conn_name));
  }

  const connectionMap = await waitForConnectionMap(requiredKeys);
  const routes = routeItems.map((route) => toDcRoute(route, connectionMap));
  await api.dcUpsertRoutes(routes, snapshot.config.data_bus.routes.replace);
}

export async function buildFullConfigExportSnapshot(): Promise<FullConfigExportSnapshot> {
  const [appVersionResult, runningModulesInfo] = await Promise.all([
    api.getAppVersion().catch(() => null),
    api.getRunningModuleInfo(),
  ]);
  const runningModules = new Set(runningModulesInfo.map((moduleInfo) => moduleInfo.module_name));
  const exportedAt = new Date().toISOString();
  const [iec104, modbusRtu, dlt645, agc, dataBus] = await Promise.all([
    loadIec104Config(runningModules),
    loadModbusRtuConfig(runningModules),
    loadDlt645Config(runningModules),
    loadAgcConfig(runningModules),
    loadDataBusConfig(runningModules),
  ]);

  return {
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
      data_bus: dataBus,
    },
  };
}

export async function saveFullConfigExport(snapshot: FullConfigExportSnapshot): Promise<string | null> {
  const defaultFileName = buildExportFileName(snapshot.exported_at);
  const selectedPath = await save({
    title: 'Export Full Config',
    defaultPath: defaultFileName,
    filters: [
      {
        name: 'MskDSP Config',
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
    title: 'Import Full Config',
    multiple: false,
    directory: false,
    filters: [
      {
        name: 'MskDSP Config',
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

export async function applyFullConfigImport(selection: FullConfigImportSelection): Promise<FullConfigImportResult> {
  const warnings: string[] = [];
  await api.setManagerAddr(selection.snapshot.source.manager_addr);
  setStoredManagerAddr(selection.snapshot.source.manager_addr);

  const {
    runningModules,
    startedModules,
    warnings: moduleWarnings,
  } = await ensureModulesReady(selection.snapshot);
  warnings.push(...moduleWarnings);

  const desiredModules = collectDesiredModules(selection.snapshot);

  const syncTasks: Promise<void>[] = [];

  if (desiredModules.has(MODULE_IEC104) && runningModules.has(MODULE_IEC104)) {
    syncTasks.push(syncIec104(selection.snapshot));
  } else if (desiredModules.has(MODULE_IEC104)) {
    warnings.push('IEC104 is not running, skipped importing its links');
  }

  if (desiredModules.has(MODULE_MODBUS_RTU) && runningModules.has(MODULE_MODBUS_RTU)) {
    syncTasks.push(syncModbusRtu(selection.snapshot));
  } else if (desiredModules.has(MODULE_MODBUS_RTU)) {
    warnings.push('ModbusRTU is not running, skipped importing its links');
  }

  if (desiredModules.has(MODULE_DLT645) && runningModules.has(MODULE_DLT645)) {
    syncTasks.push(syncDlt645(selection.snapshot));
  } else if (desiredModules.has(MODULE_DLT645)) {
    warnings.push('DLT645 is not running, skipped importing its links');
  }

  if (desiredModules.has(MODULE_AGC) && runningModules.has(MODULE_AGC)) {
    syncTasks.push(syncAgc(selection.snapshot));
  } else if (desiredModules.has(MODULE_AGC)) {
    warnings.push('AGC is not running, skipped importing its groups');
  }

  await Promise.all(syncTasks);

  if (desiredModules.has(MODULE_DATA_CENTER) && runningModules.has(MODULE_DATA_CENTER)) {
    await syncDataBus(selection.snapshot);
  } else if (desiredModules.has(MODULE_DATA_CENTER)) {
    warnings.push('DataCenter is not running, skipped importing DataBus routes');
  }

  return {
    filePath: selection.filePath,
    startedModules,
    warnings,
    summary: {
      iec104Links: selection.snapshot.config.iec104.links.length,
      modbusRtuLinks: selection.snapshot.config.modbus_rtu.links.length,
      dlt645Links: selection.snapshot.config.dlt645.links.length,
      agcGroups: selection.snapshot.config.agc.groups.length,
      dataBusRoutes: selection.snapshot.config.data_bus.routes.items.length,
    },
  };
}
