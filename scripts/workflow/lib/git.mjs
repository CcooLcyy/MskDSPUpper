import { choosePreferredBetaRef, normalizeGitRef, parseBetaLine } from './metadata.mjs';
import { runCommand } from './runtime.mjs';

export function git(args, options = {}) {
  return runCommand('git', args, options);
}

export function listRemoteBetaRefs(remote = 'origin') {
  const result = git(
    ['for-each-ref', `refs/remotes/${remote}/beta/*`, '--format=%(refname:short)'],
  );

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizeGitRef);
}

export function resolveBetaRef(explicitRef, currentRef, remoteRefs = [], options = {}) {
  const { allowMissing = false } = options;
  const normalizedExplicitRef = explicitRef?.trim() ? normalizeGitRef(explicitRef) : null;
  if (normalizedExplicitRef) {
    if (!parseBetaLine(normalizedExplicitRef)) {
      throw new Error(`Invalid explicit beta ref: ${explicitRef}`);
    }

    return normalizedExplicitRef;
  }

  const normalizedCurrentRef = currentRef?.trim() ? normalizeGitRef(currentRef) : null;
  if (normalizedCurrentRef && parseBetaLine(normalizedCurrentRef)) {
    return normalizedCurrentRef;
  }

  const resolved = choosePreferredBetaRef(remoteRefs);
  if (!resolved) {
    if (allowMissing) {
      return null;
    }

    throw new Error('No usable beta/* branch was found');
  }

  return resolved;
}

export function resolveLatestStableTag() {
  const result = git(['tag', '--sort=-version:refname', '--list', 'v*']);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

export function chooseResolvedBetaRef(explicitRef, currentRef, remote = 'origin', options = {}) {
  const remoteRefs = listRemoteBetaRefs(remote);
  return resolveBetaRef(explicitRef, currentRef, remoteRefs, options);
}

export function findContainingBetaRefs(commit, remote = 'origin') {
  const result = git([
    'for-each-ref',
    `refs/remotes/${remote}/beta/*`,
    '--contains',
    commit,
    '--format=%(refname:short)',
  ]);

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizeGitRef)
    .filter((ref) => parseBetaLine(ref));
}
