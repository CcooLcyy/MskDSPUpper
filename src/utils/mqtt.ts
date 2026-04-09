export const DEFAULT_MQTT_HOST = '127.0.0.1';

interface BaseMqttConfig {
  host: string;
  port: number;
  client_id: string;
  username: string;
  password: string;
  keepalive_sec: number;
  clean_session: boolean;
  connect_timeout_ms: number;
}

const randomToken = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID().replace(/-/g, '');
  }

  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
};

export const createRandomMqttClientId = (prefix = 'mskdsp'): string =>
  `${prefix}-${randomToken().slice(0, 12)}`;

export const createDefaultMqttConfig = (options: {
  port: number;
  keepalive_sec: number;
  connect_timeout_ms: number;
  client_id?: string;
}) => ({
  host: DEFAULT_MQTT_HOST,
  port: options.port,
  client_id: options.client_id ?? createRandomMqttClientId(),
  username: '',
  password: '',
  keepalive_sec: options.keepalive_sec,
  clean_session: true,
  connect_timeout_ms: options.connect_timeout_ms,
});

const isMqttConfigLike = (value: unknown): value is BaseMqttConfig => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.host === 'string'
    && typeof candidate.port === 'number'
    && typeof candidate.client_id === 'string'
    && typeof candidate.username === 'string'
    && typeof candidate.password === 'string'
    && typeof candidate.keepalive_sec === 'number'
    && typeof candidate.clean_session === 'boolean'
    && typeof candidate.connect_timeout_ms === 'number';
};

export const loadStoredMqttConfig = <T extends BaseMqttConfig>(storageKey: string): T | null => {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey);
    if (!raw) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);
    return isMqttConfigLike(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
};

export const saveStoredMqttConfig = <T extends BaseMqttConfig>(storageKey: string, config: T): void => {
  try {
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(config));
  } catch {
    // Ignore storage failures and keep the UX functional.
  }
};
