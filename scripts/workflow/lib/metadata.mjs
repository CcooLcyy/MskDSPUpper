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

// 元数据继续保存 UTC；版本和文件名固定显示北京时间，不依赖 Runner 时区。
export function formatBeijingTimestamp(timestamp) {
  const value = normalizeTimestamp(timestamp);
  const match = value.match(/^(\d{4})(\d{2})(\d{2})t(\d{2})(\d{2})(\d{2})z$/);
  const instant = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
  if (!Number.isFinite(instant.getTime())) {
    throw new Error(`不支持的时间戳格式: ${timestamp}`);
  }
  return formatUtcTimestamp(new Date(instant.getTime() + 8 * 60 * 60 * 1000)).replace(/z$/, '');
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
  const normalizedTimestamp = formatBeijingTimestamp(timestamp);
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
      return `nightly-${formatBeijingTimestamp(timestamp)}-utc8-${shortenSha(shortSha)}`;
    case 'ci':
      return `ci-${formatBeijingTimestamp(timestamp)}-utc8-${shortenSha(shortSha)}`;
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
    `${formatBeijingTimestamp(timestamp)}-utc8`,
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
