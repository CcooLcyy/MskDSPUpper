export const MANAGER_ADDR_SETTING_KEY = 'mskdsp_manager_addr';
export const MODBUS_MQTT_SETTING_KEY = 'protocol.modbus_rtu.mqtt';
/** Modbus：用户持久化的个人点表模板，与软件内置模板隔离。 */
export const MODBUS_TEMPLATES_SETTING_KEY = 'protocol.modbus.templates.personal';
export const DLT645_MQTT_SETTING_KEY = 'protocol.dlt645.mqtt';
/** 离线工作区：上次使用的运行模式（online / offline）。 */
export const APP_MODE_SETTING_KEY = 'mskdsp_app_mode';
/** 离线工作区：上次打开的工作区文件路径。 */
export const LAST_WORKSPACE_SETTING_KEY = 'mskdsp_last_workspace';
/** 下位机更新：最近一次成功下发的连接配置，禁止包含密码。 */
export const LOWER_UPDATE_CONNECTION_SETTING_KEY = 'mskdsp_lower_update_connection';
/** 下位机更新：最近成功使用的连接历史，不包含密码。 */
export const LOWER_UPDATE_CONNECTION_HISTORY_SETTING_KEY = 'mskdsp_lower_update_connection_history';

export const LEGACY_SETTING_KEYS = [
  MANAGER_ADDR_SETTING_KEY,
  MODBUS_MQTT_SETTING_KEY,
  DLT645_MQTT_SETTING_KEY,
] as const;

export function collectLegacySettings(
  readValue: (key: string) => string | null,
): Record<string, unknown> {
  const legacy: Record<string, unknown> = {};
  for (const key of LEGACY_SETTING_KEYS) {
    const raw = readValue(key);
    if (raw == null) {
      continue;
    }
    if (key === MANAGER_ADDR_SETTING_KEY) {
      legacy[key] = raw;
      continue;
    }
    try {
      legacy[key] = JSON.parse(raw) as unknown;
    } catch {
      // Malformed legacy data is left in storage for diagnosis.
    }
  }
  return legacy;
}
