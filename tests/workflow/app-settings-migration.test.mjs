import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collectLegacySettings,
  DLT645_MQTT_SETTING_KEY,
  MANAGER_ADDR_SETTING_KEY,
  MODBUS_MQTT_SETTING_KEY,
} from '../../src/utils/app-settings-core.ts';

test('legacy settings collection preserves manager address and parses mqtt objects', () => {
  const values = new Map([
    [MANAGER_ADDR_SETTING_KEY, '192.168.1.8:17000'],
    [MODBUS_MQTT_SETTING_KEY, JSON.stringify({ host: 'mqtt.local', password: 'secret' })],
    [DLT645_MQTT_SETTING_KEY, JSON.stringify({ host: 'dlt.local', password: '' })],
  ]);

  const legacy = collectLegacySettings((key) => values.get(key) ?? null);

  assert.equal(legacy[MANAGER_ADDR_SETTING_KEY], '192.168.1.8:17000');
  assert.deepEqual(legacy[MODBUS_MQTT_SETTING_KEY], { host: 'mqtt.local', password: 'secret' });
  assert.deepEqual(legacy[DLT645_MQTT_SETTING_KEY], { host: 'dlt.local', password: '' });
});

test('legacy settings collection ignores malformed mqtt json without dropping other values', () => {
  const values = new Map([
    [MANAGER_ADDR_SETTING_KEY, '127.0.0.1:17000'],
    [MODBUS_MQTT_SETTING_KEY, '{broken'],
  ]);

  const legacy = collectLegacySettings((key) => values.get(key) ?? null);

  assert.deepEqual(legacy, { [MANAGER_ADDR_SETTING_KEY]: '127.0.0.1:17000' });
});
