#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { createStaticAssetUrl } from './lib/updater-manifest.mjs';

const { values } = parseArgs({
  options: {
    'package-output-dir': { type: 'string' },
    'channel-path': { type: 'string' },
    platform: { type: 'string', default: 'windows-x64' },
    'base-url': { type: 'string' },
  },
});

function assertNonEmpty(name, value) {
  if (!value) {
    throw new Error(`${name} 不能为空`);
  }
}

function resolveAssetNameFromUrl(url) {
  assertNonEmpty('platforms.*.url', url);

  try {
    const parsed = new URL(url);
    const encodedName = parsed.pathname.split('/').filter(Boolean).at(-1);
    if (encodedName) {
      return decodeURIComponent(encodedName);
    }
  } catch {
    const encodedName = url.split('/').filter(Boolean).at(-1);
    if (encodedName) {
      return decodeURIComponent(encodedName);
    }
  }

  throw new Error(`无法从 updater URL 解析资产名: ${url}`);
}

function rewriteManifestUrls({ manifest, packageOutputDir, assetBaseUrl }) {
  if (!manifest.platforms || Object.keys(manifest.platforms).length === 0) {
    throw new Error('latest.json platforms 不能为空');
  }

  const resolvedAssetNames = new Set();
  for (const [target, entry] of Object.entries(manifest.platforms)) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`latest.json platforms.${target} 不是对象`);
    }

    const assetName = resolveAssetNameFromUrl(entry.url);
    if (assetName.includes('/') || assetName.includes('\\')) {
      throw new Error(`latest.json 引用的资产名不能包含路径分隔符: ${assetName}`);
    }

    const assetPath = path.join(packageOutputDir, assetName);
    if (!fs.existsSync(assetPath)) {
      throw new Error(`latest.json 引用的资产不存在: ${assetName}`);
    }

    entry.url = createStaticAssetUrl({ assetBaseUrl, assetName });
    resolvedAssetNames.add(assetName);
  }

  return [...resolvedAssetNames];
}

const packageOutputDir = values['package-output-dir'];
const channelPath = values['channel-path'];
const platform = values.platform;
const baseUrl = values['base-url'];

assertNonEmpty('package-output-dir', packageOutputDir);
assertNonEmpty('channel-path', channelPath);
assertNonEmpty('platform', platform);
assertNonEmpty('base-url', baseUrl);

const latestJsonPath = path.join(packageOutputDir, 'latest.json');
if (!fs.existsSync(latestJsonPath)) {
  throw new Error(`latest.json 不存在: ${latestJsonPath}`);
}

const manifest = JSON.parse(fs.readFileSync(latestJsonPath, 'utf8'));
const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
const normalizedChannelPath = channelPath.replace(/^\/+|\/+$/g, '');
const normalizedPlatform = platform.replace(/^\/+|\/+$/g, '');
const assetBaseUrl = `${normalizedBaseUrl}/${normalizedChannelPath}/${normalizedPlatform}`;
const assetNames = rewriteManifestUrls({ manifest, packageOutputDir, assetBaseUrl });

fs.writeFileSync(latestJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`Rewrote latest.json asset URLs to ${assetBaseUrl}`);
for (const assetName of assetNames) {
  console.log(`- ${assetName}`);
}
