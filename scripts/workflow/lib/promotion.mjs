import { parseBetaLine } from './metadata.mjs';

function isStableReleaseVersion(version) {
  return /^\d+\.\d+\.\d+$/.test(version ?? '');
}

export function versionMatchesBetaLine(version, betaLine) {
  if (!isStableReleaseVersion(version) || !betaLine) {
    return false;
  }

  const versionParts = version.split('.');
  const betaParts = betaLine.split('.');
  if (betaParts.length === 2) {
    return (
      versionParts.length >= 2 &&
      versionParts[0] === betaParts[0] &&
      versionParts[1] === betaParts[1]
    );
  }

  return version === betaLine;
}

export function calculateIdleHours(lastCommitAt, now = new Date()) {
  const lastCommitDate = new Date(lastCommitAt);
  const nowDate = now instanceof Date ? now : new Date(now);
  const diffMs = nowDate.getTime() - lastCommitDate.getTime();
  return diffMs / (1000 * 60 * 60);
}

export function evaluatePromotionCandidate({
  branchRef,
  version,
  lastCommitAt,
  existingStableTags = [],
  now = new Date(),
  thresholdHours = 72,
}) {
  const betaLine = parseBetaLine(branchRef);
  const stableTag = version ? `v${version}` : null;
  const idleHours = calculateIdleHours(lastCommitAt, now);

  if (!betaLine) {
    return { eligible: false, reason: 'invalid_beta_ref', stableTag, idleHours };
  }

  if (!isStableReleaseVersion(version)) {
    return { eligible: false, reason: 'non_stable_version', stableTag, idleHours, betaLine };
  }

  if (!versionMatchesBetaLine(version, betaLine)) {
    return { eligible: false, reason: 'version_mismatch', stableTag, idleHours, betaLine };
  }

  if (!Number.isFinite(idleHours)) {
    return { eligible: false, reason: 'invalid_commit_time', stableTag, idleHours, betaLine };
  }

  if (existingStableTags.includes(stableTag)) {
    return { eligible: false, reason: 'stable_tag_exists', stableTag, idleHours, betaLine };
  }

  if (idleHours < thresholdHours) {
    return { eligible: false, reason: 'not_idle_enough', stableTag, idleHours, betaLine };
  }

  return {
    eligible: true,
    reason: 'eligible',
    stableTag,
    idleHours,
    betaLine,
  };
}
