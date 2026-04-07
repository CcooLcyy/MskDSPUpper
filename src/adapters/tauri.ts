import { invoke } from '@tauri-apps/api/core';
import type { ModuleInfo, ModuleRunningInfo } from './types';

export const api = {
  setManagerAddr: (addr: string) => invoke<void>('set_manager_addr', { addr }),
  getModuleInfo: () => invoke<ModuleInfo[]>('get_module_info'),
  getRunningModuleInfo: () => invoke<ModuleRunningInfo[]>('get_running_module_info'),
  startModule: (moduleInfo: ModuleInfo) => invoke<void>('start_module', { moduleInfo }),
  stopModule: (moduleInfo: ModuleInfo) => invoke<void>('stop_module', { moduleInfo }),
};
