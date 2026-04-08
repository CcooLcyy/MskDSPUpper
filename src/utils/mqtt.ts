export const DEFAULT_MQTT_HOST = '127.0.0.1';

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
}) => ({
  host: DEFAULT_MQTT_HOST,
  port: options.port,
  client_id: createRandomMqttClientId(),
  username: '',
  password: '',
  keepalive_sec: options.keepalive_sec,
  clean_session: true,
  connect_timeout_ms: options.connect_timeout_ms,
});
