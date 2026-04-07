import { invoke } from '@tauri-apps/api/core';
import type {
  ModuleInfo,
  ModuleRunningInfo,
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
} from './types';

export const api = {
  setManagerAddr: (addr: string) => invoke<void>('set_manager_addr', { addr }),
  getModuleInfo: () => invoke<ModuleInfo[]>('get_module_info'),
  getRunningModuleInfo: () => invoke<ModuleRunningInfo[]>('get_running_module_info'),
  startModule: (moduleInfo: ModuleInfo) => invoke<void>('start_module', { moduleInfo }),
  stopModule: (moduleInfo: ModuleInfo) => invoke<void>('stop_module', { moduleInfo }),

  iec104UpsertLink: (config: Iec104LinkConfig, createOnly: boolean) =>
    invoke<Iec104LinkInfo>('iec104_upsert_link', { config, createOnly }),
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
};
