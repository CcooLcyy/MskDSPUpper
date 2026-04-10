function assertNonEmpty(name, value) {
  if (!value) {
    throw new Error(`${name} 不能为空`);
  }
}

export function formatTimestampAsRfc3339(timestamp) {
  assertNonEmpty('timestamp', timestamp);
  const match = timestamp.match(
    /^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})t(?<hour>\d{2})(?<minute>\d{2})(?<second>\d{2})z$/,
  );
  if (!match?.groups) {
    throw new Error(`不支持的时间戳格式: ${timestamp}`);
  }

  const { year, month, day, hour, minute, second } = match.groups;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

export function createGithubReleaseAssetUrl({ repository, releaseTag, assetName }) {
  assertNonEmpty('repository', repository);
  assertNonEmpty('releaseTag', releaseTag);
  assertNonEmpty('assetName', assetName);

  return `https://github.com/${repository}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(assetName)}`;
}

export function resolveUpdaterTargetBase(targetTriple) {
  assertNonEmpty('targetTriple', targetTriple);

  const [arch, , os] = targetTriple.split('-', 3);
  const normalizedOs =
    os === 'windows' ? 'windows' : os === 'unknown' || os === 'linux' ? 'linux' : os;

  const normalizedArch = {
    x86_64: 'x86_64',
    i686: 'i686',
    aarch64: 'aarch64',
    armv7: 'armv7',
    riscv64gc: 'riscv64',
  }[arch];

  if (!normalizedArch) {
    throw new Error(`无法识别的目标架构: ${targetTriple}`);
  }

  if (!['windows', 'linux', 'apple', 'darwin'].includes(normalizedOs)) {
    throw new Error(`无法识别的目标平台: ${targetTriple}`);
  }

  const updaterOs = normalizedOs === 'apple' ? 'darwin' : normalizedOs;
  return `${updaterOs}-${normalizedArch}`;
}

export function normalizeUpdaterBundleType(bundleType) {
  if (!bundleType) {
    return null;
  }

  const normalized = bundleType.toLowerCase();
  return ['app', 'appimage', 'deb', 'msi', 'nsis', 'rpm'].includes(normalized)
    ? normalized
    : null;
}

export function createUpdaterTargets(targetTriple, bundleType = null) {
  const baseTarget = resolveUpdaterTargetBase(targetTriple);
  const targets = [];
  const normalizedBundleType = normalizeUpdaterBundleType(bundleType);

  if (normalizedBundleType) {
    targets.push(`${baseTarget}-${normalizedBundleType}`);
  }

  targets.push(baseTarget);
  return [...new Set(targets)];
}

export function createStaticUpdaterManifest({ version, notes = null, pubDate, platforms }) {
  assertNonEmpty('version', version);
  assertNonEmpty('pubDate', pubDate);

  if (!platforms || Object.keys(platforms).length === 0) {
    throw new Error('platforms 不能为空');
  }

  return {
    version,
    notes,
    pub_date: pubDate,
    platforms,
  };
}
