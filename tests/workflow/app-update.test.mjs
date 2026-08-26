import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const providerSource = readFileSync(
  new URL('../../src/components/app-update/AppUpdateProvider.tsx', import.meta.url),
  'utf8',
);
const tauriSource = readFileSync(
  new URL('../../src/adapters/tauri.ts', import.meta.url),
  'utf8',
);
const contextSource = readFileSync(
  new URL('../../src/components/app-update/app-update-context.ts', import.meta.url),
  'utf8',
);

test('upper updater keeps the 30-second single-task schedule', () => {
  assert.match(providerSource, /const UPDATE_CHECK_INTERVAL_MS = 30_000/);
  assert.match(providerSource, /isUpdateDownloadedRef\.current \|\| isDownloadingUpdateRef\.current \|\| isInstallingUpdateRef\.current/);
  assert.match(providerSource, /downloadingPromiseRef\.current/);
});

test('upper updater downloads automatically but only installs after explicit action', () => {
  assert.match(providerSource, /await api\.downloadAppUpdate/);
  assert.match(providerSource, /await api\.installAppUpdate\(\)/);
  assert.doesNotMatch(providerSource, /downloadAndInstallAppUpdate/);
  assert.match(tauriSource, /await update\.download\(/);
  assert.match(tauriSource, /await update\.install\(\)/);
  assert.doesNotMatch(tauriSource, /downloadAndInstallAppUpdate: async[\s\S]*?checkAppUpdate/);
});

test('upper updater persists metadata while documenting process-local download lifetime', () => {
  assert.match(providerSource, /APP_UPDATE_METADATA_KEY/);
  assert.match(providerSource, /persistUpdate\(downloaded\)/);
  assert.match(providerSource, /ready-to-install/);
  assert.match(contextSource, /isUpdateDownloaded: boolean/);
});
