import { save } from '@tauri-apps/plugin-dialog';
import { api } from '../adapters';
import type {
  AgcGroupConfig,
  Dlt645LinkConfig,
  Dlt645MqttConfig,
  FullConfigExportSnapshot,
  Iec104LinkConfig,
  ModbusLinkConfig,
  ModbusMqttConfig,
  StableDataBusEndpoint,
} from '../adapters';
import { loadStoredMqttConfig } from './mqtt';

const MANAGER_ADDR_KEY = 'mskdsp_manager_addr';
const DEFAULT_MANAGER_ADDR = '127.0.0.1:17000';
const MODBUS_MQTT_STORAGE_KEY = 'protocol.modbus_rtu.mqtt';
const DLT645_MQTT_STORAGE_KEY = 'protocol.dlt645.mqtt';

const MODULE_IEC104 = 'IEC104';
const MODULE_MODBUS_RTU = 'ModbusRTU';
const MODULE_DLT645 = 'DLT645';
const MODULE_AGC = 'AGC';
const MODULE_DATA_CENTER = 'DataCenter';

function getStoredManagerAddr(): string {
  try {
    return globalThis.localStorage?.getItem(MANAGER_ADDR_KEY) || DEFAULT_MANAGER_ADDR;
  } catch {
    return DEFAULT_MANAGER_ADDR;
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

function ensureExportExtension(filePath: string): string {
  return /\.mskcfg$/i.test(filePath) ? filePath : `${filePath}.mskcfg`;
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
