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

export function resolveLatestStableTag() {
  const result = git(['tag', '--sort=-version:refname', '--list', 'v*']);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

export function chooseResolvedBetaRef(explicitRef, currentRef, remote = 'origin') {
  const explicitBetaLine = explicitRef ? parseBetaLine(explicitRef) : null;
  if (explicitBetaLine) {
    return normalizeGitRef(explicitRef);
  }

  const currentBetaLine = currentRef ? parseBetaLine(currentRef) : null;
  if (currentBetaLine) {
    return normalizeGitRef(currentRef);
  }

  const remoteRefs = listRemoteBetaRefs(remote);
  const resolved = choosePreferredBetaRef(remoteRefs);
  if (!resolved) {
    throw new Error('未找到可用的 beta/* 分支');
  }

  return resolved;
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
