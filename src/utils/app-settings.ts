import { api } from '../adapters';
import type { AppSettingsMap } from '../adapters';
import {
  collectLegacySettings,
  MANAGER_ADDR_SETTING_KEY,
} from './app-settings-core';

export {
  MANAGER_ADDR_SETTING_KEY,
  MODBUS_MQTT_SETTING_KEY,
  DLT645_MQTT_SETTING_KEY,
} from './app-settings-core';

let settingsSnapshot: AppSettingsMap = {};

function readLegacySettings(): AppSettingsMap {
  return collectLegacySettings((key) => globalThis.localStorage?.getItem(key) ?? null);
}

export async function initializeAppSettings(): Promise<void> {
  const legacy = readLegacySettings();
  settingsSnapshot = { ...legacy };
  const migrated = await api.migrateLegacyAppSettings(legacy);
  settingsSnapshot = migrated;
  for (const key of Object.keys(legacy)) {
    globalThis.localStorage?.removeItem(key);
  }
}

export function getAppSetting<T>(key: string): T | null {
  const value = settingsSnapshot[key];
  return value == null ? null : value as T;
}

export async function saveAppSetting<T>(key: string, value: T): Promise<void> {
  await api.saveAppSetting(key, value);
  settingsSnapshot = { ...settingsSnapshot, [key]: value };
}

export function getStoredManagerAddress(defaultAddress: string): string {
  const value = getAppSetting<unknown>(MANAGER_ADDR_SETTING_KEY);
  return typeof value === 'string' && value.trim() ? value : defaultAddress;
}

export function saveManagerAddress(address: string): Promise<void> {
  return saveAppSetting(MANAGER_ADDR_SETTING_KEY, address);
}
