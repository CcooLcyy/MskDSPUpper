import path from 'node:path';
import { parseArgs } from 'node:util';

import { git, listRemoteBetaRefs } from './lib/git.mjs';
import { readJsonFile, writeJsonFile } from './lib/filesystem.mjs';
import { evaluatePromotionCandidate } from './lib/promotion.mjs';
import { appendGithubSummary, logInfo, resolveRepoRoot, setGithubOutput } from './lib/runtime.mjs';

function readPackageVersionAtRef(ref) {
  const result = git(['show', `origin/${ref}:package.json`], { allowFailure: true });
  if (result.status !== 0 || !result.stdout.trim()) {
    return null;
  }

  return JSON.parse(result.stdout).version ?? null;
}

function readHeadInfo(ref) {
  const result = git(['log', '-1', '--format=%H%n%cI', `origin/${ref}`], { allowFailure: true });
  if (result.status !== 0) {
    return { sha: null, committedAt: null };
  }

  const [sha, committedAt] = result.stdout.trim().split(/\r?\n/);
  return {
    sha: sha ?? null,
    committedAt: committedAt ?? null,
  };
}

const { values } = parseArgs({
  options: {
    remote: { type: 'string' },
    'threshold-hours': { type: 'string' },
    output: { type: 'string' },
    'beta-ref': { type: 'string' },
    now: { type: 'string' },
  },
});

const repoRoot = resolveRepoRoot(import.meta.url);
const outputPath = path.resolve(
  repoRoot,
  values.output ?? path.join('package', 'promotion', 'beta-promotion-candidates.json'),
);
const thresholdHours = Number(values['threshold-hours'] ?? '72');
const now = values.now ? new Date(values.now) : new Date();
const stableTags = git(['tag', '--list', 'v*'])
  .stdout.split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const betaRefs = values['beta-ref']
  ? [values['beta-ref']]
  : listRemoteBetaRefs(values.remote ?? 'origin');

const evaluations = betaRefs.map((ref) => {
  const version = readPackageVersionAtRef(ref);
  const headInfo = readHeadInfo(ref);
  const decision = evaluatePromotionCandidate({
    branchRef: ref,
    version,
    lastCommitAt: headInfo.committedAt,
    existingStableTags: stableTags,
    now,
    thresholdHours,
  });

  return {
    branchRef: ref,
    version,
    commitSha: headInfo.sha,
    committedAt: headInfo.committedAt,
    stableTag: decision.stableTag,
    betaLine: decision.betaLine ?? null,
    idleHours: Number.isFinite(decision.idleHours)
      ? Number(decision.idleHours.toFixed(2))
      : null,
    eligible: decision.eligible,
    reason: decision.reason,
  };
});

const candidates = evaluations.filter((entry) => entry.eligible);
writeJsonFile(outputPath, {
  thresholdHours,
  generatedAt: now.toISOString(),
  candidates,
  evaluations,
});

appendGithubSummary([
  '## Beta 自动晋升检查',
  '',
  `- 阈值: ${thresholdHours} 小时`,
  `- 检查分支数: ${evaluations.length}`,
  `- 可晋升数: ${candidates.length}`,
  '',
  ...evaluations.map(
    (entry) =>
      `- ${entry.branchRef}: ${entry.reason} | version=${entry.version ?? '-'} | idleHours=${entry.idleHours ?? '-'} | tag=${entry.stableTag ?? '-'}`,
  ),
]);

logInfo('已完成 beta 自动晋升评估', {
  thresholdHours,
  candidateCount: candidates.length,
  outputPath,
});

setGithubOutput('candidates_file', outputPath);
setGithubOutput('has_candidates', candidates.length > 0 ? 'true' : 'false');
setGithubOutput('candidate_count', String(candidates.length));
