import { runCommand } from './runtime.mjs';

export function git(args, options = {}) {
  return runCommand('git', args, options);
}

export function resolveLatestStableTag() {
  const result = git(['tag', '--sort=-version:refname', '--list', 'v*']);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}
