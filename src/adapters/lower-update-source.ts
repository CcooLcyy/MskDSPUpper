import type { LowerUpdateChannel, LowerUpdatePlatform } from './types';
import { getLowerUpdateChannels } from '../utils/lower-update-platform';

const DEFAULT_LOWER_UPDATE_STATIC_BASE_URL =
  'https://update.clsclear.top/mskdsp-lower';
const DEFAULT_LOWER_UPDATE_X64_STATIC_BASE_URL =
  'https://update.clsclear.top/mskdsp-lower-x64';

export function getLowerUpdateStaticBaseUrl(platform: LowerUpdatePlatform = 'linux-arm64'): string {
  getLowerUpdateChannels(platform);
  const configured = (platform === 'linux-x64'
    ? import.meta.env.VITE_LOWER_UPDATE_X64_STATIC_BASE_URL
    : import.meta.env.VITE_LOWER_UPDATE_STATIC_BASE_URL)?.trim();
  const fallback = platform === 'linux-x64' ? DEFAULT_LOWER_UPDATE_X64_STATIC_BASE_URL : DEFAULT_LOWER_UPDATE_STATIC_BASE_URL;
  return (configured || fallback).replace(/\/+$/, '');
}

export function buildLowerUpdateLatestUrl(channel: LowerUpdateChannel, platform: LowerUpdatePlatform = 'linux-arm64'): string {
  if (!getLowerUpdateChannels(platform).includes(channel)) throw new Error('所选架构不支持该下位机更新通道');
  return `${getLowerUpdateStaticBaseUrl(platform)}/${channel}/latest.json`;
}
