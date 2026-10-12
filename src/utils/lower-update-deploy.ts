import type { LowerUpdateCachedPackage, LowerUpdateDownloadResult, LowerUpdateManifest } from '../adapters/types';

// 选定本地版本后，只使用该版本自己的文件，避免后台最新包污染安装目标。
export function resolveLowerUpdateDownloadResult(
  selected: LowerUpdateManifest | null,
  selectedResult: LowerUpdateDownloadResult | null,
  autoManifest: LowerUpdateManifest | null,
  autoResult: LowerUpdateDownloadResult | null,
): LowerUpdateDownloadResult | null {
  if (!selected) return null;
  const matches = (result: LowerUpdateDownloadResult | null): boolean => Boolean(result
    && result.package_name === selected.asset.name
    && result.downloaded_bytes === selected.asset.size
    && result.sha256.toLowerCase() === selected.asset.sha256.toLowerCase());
  if (matches(selectedResult)) return selectedResult;
  if (selected.local_import || !autoManifest) return null;
  return selected.platform === autoManifest.platform
    && selected.channel === autoManifest.channel
    && selected.version === autoManifest.version
    && selected.image_id === autoManifest.image_id
    && selected.asset.name === autoManifest.asset.name
    && selected.asset.size === autoManifest.asset.size
    && selected.asset.sha256.toLowerCase() === autoManifest.asset.sha256.toLowerCase()
    && matches(autoResult) ? autoResult : null;
}

export type LowerUpdateImageComparison = 'same' | 'different' | 'unknown';
export type LowerUpdateCacheFreshness = 'unknown' | 'current' | 'stale' | 'unavailable';

// 只允许使用当前选择的架构和通道，阻止切换后误用另一份更新包。
export function matchesLowerUpdateSelection(
  manifest: Pick<LowerUpdateManifest, 'platform' | 'channel'> | null | undefined,
  platform: string,
  channel: string,
): boolean {
  return manifest?.platform === platform && manifest.channel === channel;
}

function normalizeImageId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (!normalized || normalized === '-') {
    return null;
  }

  return normalized;
}

export function compareLowerUpdateImages(
  expectedImageId: string | null | undefined,
  actualImageId: string | null | undefined,
): LowerUpdateImageComparison {
  const expected = normalizeImageId(expectedImageId);
  const actual = normalizeImageId(actualImageId);
  if (!expected || !actual) {
    return 'unknown';
  }

  return expected === actual ? 'same' : 'different';
}

function normalizeChecksum(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  return normalized || null;
}

export function assessLowerUpdateCacheFreshness(
  onlineManifest: Pick<LowerUpdateManifest, 'channel' | 'platform' | 'image_id' | 'asset'> | null | undefined,
  cachedPackage: Pick<LowerUpdateCachedPackage, 'manifest' | 'sha256'> | null | undefined,
): LowerUpdateCacheFreshness {
  if (!onlineManifest) {
    return 'unknown';
  }
  if (!cachedPackage) {
    return 'unavailable';
  }

  const onlineImageId = normalizeImageId(onlineManifest.image_id);
  const cachedImageId = normalizeImageId(cachedPackage.manifest.image_id);
  const onlineSha256 = normalizeChecksum(onlineManifest.asset.sha256);
  const cachedManifestSha256 = normalizeChecksum(cachedPackage.manifest.asset.sha256);
  const cachedPackageSha256 = normalizeChecksum(cachedPackage.sha256);
  const onlineChannel = onlineManifest.channel?.trim();
  const cachedChannel = cachedPackage.manifest.channel?.trim();
  const onlinePlatform = onlineManifest.platform?.trim();
  const cachedPlatform = cachedPackage.manifest.platform?.trim();

  if (
    !onlineImageId
    || !cachedImageId
    || !onlineSha256
    || !cachedManifestSha256
    || !cachedPackageSha256
    || !onlineChannel
    || !cachedChannel
    || !onlinePlatform
    || !cachedPlatform
    || cachedManifestSha256 !== cachedPackageSha256
  ) {
    return 'unknown';
  }

  return onlineChannel === cachedChannel
    && onlinePlatform === cachedPlatform
    && onlineImageId === cachedImageId
    && onlineSha256 === cachedManifestSha256
    ? 'current'
    : 'stale';
}
