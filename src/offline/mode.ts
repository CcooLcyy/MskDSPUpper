/**
 * 上位机运行模式（在线 / 离线工作区）。
 *
 * 刻意保持零依赖：`adapters/index.ts` 需要按模式选择实现，
 * 如果这里反向依赖适配器会形成循环导入。
 */

import type { AppMode } from './capabilities.ts';

export const MANAGER_ADDR_SETTING_KEY = 'mskdsp_manager_addr';
export const APP_MODE_SETTING_KEY = 'mskdsp_app_mode';
export const LAST_WORKSPACE_SETTING_KEY = 'mskdsp_last_workspace';

let currentMode: AppMode = 'online';
const modeListeners = new Set<() => void>();

export function getAppMode(): AppMode {
  return currentMode;
}

export function setAppMode(nextMode: AppMode): void {
  if (currentMode === nextMode) {
    return;
  }

  currentMode = nextMode;
  console.info('[离线工作区] 运行模式已切换', { mode: nextMode });

  for (const listener of modeListeners) {
    listener();
  }
}

export function subscribeAppMode(listener: () => void): () => void {
  modeListeners.add(listener);

  return () => {
    modeListeners.delete(listener);
  };
}

export function normalizeAppMode(value: unknown): AppMode {
  return value === 'offline' ? 'offline' : 'online';
}
