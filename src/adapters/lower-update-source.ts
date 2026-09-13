import type { LowerUpdateChannel } from './types';

const DEFAULT_LOWER_UPDATE_STATIC_BASE_URL =
  'https://pub-19f3d71852b04011b120b1b814141c12.r2.dev/mskdsp-lower';

export function getLowerUpdateStaticBaseUrl(): string {
  const configured = import.meta.env.VITE_LOWER_UPDATE_STATIC_BASE_URL?.trim();
  return (configured || DEFAULT_LOWER_UPDATE_STATIC_BASE_URL).replace(/\/+$/, '');
}

export function buildLowerUpdateLatestUrl(channel: LowerUpdateChannel): string {
  return `${getLowerUpdateStaticBaseUrl()}/${channel}/latest.json`;
}
