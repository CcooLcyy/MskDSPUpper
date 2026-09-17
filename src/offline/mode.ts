/**
 * 上位机运行模式（在线 / 离线工作区）。
 *
 * 只依赖纯常量的 `utils/app-settings-core.ts`：`adapters/index.ts` 需要按模式选择实现，
 * 如果这里反向依赖适配器会形成循环导入。
 */

import {
  APP_MODE_SETTING_KEY,
  LAST_WORKSPACE_SETTING_KEY,
} from '../utils/app-settings-core.ts';
import type { AppMode } from './capabilities.ts';

export { APP_MODE_SETTING_KEY, LAST_WORKSPACE_SETTING_KEY };

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
