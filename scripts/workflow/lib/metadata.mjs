function assertNonEmpty(name, value) {
  if (!value) {
    throw new Error(`${name} 不能为空`);
  }
}

export function normalizeGitRef(ref) {
  return ref
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/tags\//, '')
    .replace(/^origin\//, '')
    .replace(/^remotes\/origin\//, '');
}

export function sanitizeSegment(value, options = {}) {
  const { replaceDots = false } = options;
  assertNonEmpty('value', value);
  let normalized = value.toLowerCase().trim();
  normalized = replaceDots ? normalized.replace(/\./g, '-') : normalized;
  normalized = normalized.replace(/[^a-z0-9.+-]+/g, '-');
  normalized = normalized.replace(/\++/g, '_');
  normalized = normalized.replace(/-+/g, '-');
  normalized = normalized.replace(/^[-_.]+|[-_.]+$/g, '');
  return normalized;
}

export function normalizeTimestamp(value) {
  assertNonEmpty('timestamp', value);
  const normalized = value.toLowerCase().replace(/[^0-9tz]/g, '');
  if (!/^\d{8}t\d{6}z$/.test(normalized)) {
    throw new Error(`不支持的时间戳格式: ${value}`);
  }

  return normalized;
}

export function formatUtcTimestamp(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}t${hour}${minute}${second}z`;
}

export function shortenSha(sha) {
  assertNonEmpty('sha', sha);
  return sha.slice(0, 7).toLowerCase();
}

export function createChannelLabel(channel) {
  if (!['ci', 'nightly', 'stable'].includes(channel)) {
    throw new Error(`不支持的渠道: ${channel}`);
  }
  return channel;
}

export function createEffectiveVersion({
  baseVersion,
  channel,
  timestamp,
  shortSha,
}) {
  assertNonEmpty('baseVersion', baseVersion);
  const normalizedTimestamp = normalizeTimestamp(timestamp).replace(/z$/, '');
  const normalizedSha = shortenSha(shortSha);
  switch (channel) {
    case 'stable':
      return baseVersion;
    case 'ci':
      return `${baseVersion}-ci.${normalizedTimestamp}+sha.${normalizedSha}`;
    case 'nightly':
      return `${baseVersion}-nightly.${normalizedTimestamp}+sha.${normalizedSha}`;
    default:
      throw new Error(`不支持的渠道: ${channel}`);
  }
}

export function createReleaseTag({
  channel,
  baseVersion,
  timestamp,
  shortSha,
}) {
  switch (channel) {
    case 'stable':
      return `v${baseVersion}`;
    case 'nightly':
      return `nightly-${normalizeTimestamp(timestamp)}-${shortenSha(shortSha)}`;
    case 'ci':
      return `ci-${normalizeTimestamp(timestamp)}-${shortenSha(shortSha)}`;
    default:
      throw new Error(`不支持的渠道: ${channel}`);
  }
}

export function createArtifactBaseName({
  projectSlug,
  productName,
  effectiveVersion,
  channelLabel,
  timestamp,
  shortSha,
  platform,
}) {
  if (channelLabel === 'stable') {
    // 正式包对外只展示品牌和版本；来源及架构继续保存在元数据中。
    const brand = (productName ?? projectSlug).replace(/\s+/g, '');
    return `${sanitizeSegment(brand)}-${sanitizeSegment(effectiveVersion)}`;
  }
  return [
    sanitizeSegment(projectSlug),
    sanitizeSegment(effectiveVersion),
    sanitizeSegment(channelLabel),
    normalizeTimestamp(timestamp),
    shortenSha(shortSha),
    sanitizeSegment(platform),
  ].join('-');
}

export function createReleaseTitle({
  productName,
  channelLabel,
  effectiveVersion,
}) {
  return `${productName} ${channelLabel} ${effectiveVersion}`;
}

export function ensureStableTagMatchesVersion(tag, version) {
  const normalizedTag = normalizeGitRef(tag);
  const expectedTag = `v${version}`;
  if (normalizedTag !== expectedTag) {
    throw new Error(`正式发布 tag 必须与版本一致，期望 ${expectedTag}，实际 ${normalizedTag}`);
  }
}
