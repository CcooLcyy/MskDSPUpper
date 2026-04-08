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

export function parseBetaLine(ref) {
  const normalized = normalizeGitRef(ref);
  const match = normalized.match(/^beta\/([0-9]+(?:\.[0-9]+){1,2})$/);
  return match ? match[1] : null;
}

export function compareVersionLine(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? -1;
    const rightValue = rightParts[index] ?? -1;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }

  return 0;
}

export function choosePreferredBetaRef(refs) {
  const candidates = refs
    .map((ref) => ({
      ref: normalizeGitRef(ref),
      betaLine: parseBetaLine(ref),
    }))
    .filter((candidate) => candidate.betaLine);

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => compareVersionLine(right.betaLine, left.betaLine));
  return candidates[0].ref;
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

export function createChannelLabel(channel, betaLine) {
  if (channel === 'beta') {
    assertNonEmpty('betaLine', betaLine);
    return `beta-${betaLine}`;
  }

  return channel;
}

export function createEffectiveVersion({
  baseVersion,
  channel,
  timestamp,
  shortSha,
  betaLine,
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
    case 'beta':
      assertNonEmpty('betaLine', betaLine);
      return `${baseVersion}-beta.${betaLine}.${normalizedTimestamp}+sha.${normalizedSha}`;
    default:
      throw new Error(`不支持的渠道: ${channel}`);
  }
}

export function createReleaseTag({
  channel,
  baseVersion,
  timestamp,
  shortSha,
  betaLine,
}) {
  switch (channel) {
    case 'stable':
      return `v${baseVersion}`;
    case 'nightly':
      return `nightly-${normalizeTimestamp(timestamp)}-${shortenSha(shortSha)}`;
    case 'beta':
      return `beta-${sanitizeSegment(betaLine, { replaceDots: true })}-${normalizeTimestamp(timestamp)}-${shortenSha(shortSha)}`;
    case 'ci':
      return `ci-${normalizeTimestamp(timestamp)}-${shortenSha(shortSha)}`;
    default:
      throw new Error(`不支持的渠道: ${channel}`);
  }
}

export function createArtifactBaseName({
  projectSlug,
  effectiveVersion,
  channelLabel,
  timestamp,
  shortSha,
  platform,
}) {
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
  channel,
  channelLabel,
  effectiveVersion,
}) {
  const label = channel === 'beta' ? channelLabel.replace('-', '/') : channelLabel;
  return `${productName} ${label} ${effectiveVersion}`;
}

export function ensureStableTagMatchesVersion(tag, version) {
  const normalizedTag = normalizeGitRef(tag);
  const expectedTag = `v${version}`;
  if (normalizedTag !== expectedTag) {
    throw new Error(`正式发布 tag 必须与版本一致，期望 ${expectedTag}，实际 ${normalizedTag}`);
  }
}
