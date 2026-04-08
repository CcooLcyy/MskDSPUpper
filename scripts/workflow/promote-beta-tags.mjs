import path from 'node:path';
import { parseArgs } from 'node:util';

import { git } from './lib/git.mjs';
import { readJsonFile } from './lib/filesystem.mjs';
import { appendGithubSummary, logInfo, resolveRepoRoot, setGithubOutput } from './lib/runtime.mjs';

const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    remote: { type: 'string' },
  },
});

if (!values.input) {
  throw new Error('--input 必填');
}

const repoRoot = resolveRepoRoot(import.meta.url);
const input = readJsonFile(path.resolve(repoRoot, values.input));
const remote = values.remote ?? 'origin';

const promoted = [];
const skipped = [];

for (const candidate of input.candidates ?? []) {
  const existingTag = git(['rev-parse', '-q', '--verify', `refs/tags/${candidate.stableTag}`], {
    allowFailure: true,
  });

  if (existingTag.status === 0) {
    skipped.push({ ...candidate, reason: 'stable_tag_exists' });
    continue;
  }

  git([
    'tag',
    '-a',
    candidate.stableTag,
    candidate.commitSha,
    '-m',
    `Auto promote ${candidate.branchRef} after ${input.thresholdHours}h idle window`,
  ]);

  const pushed = git(['push', remote, `refs/tags/${candidate.stableTag}`], { allowFailure: true });
  if (pushed.status !== 0) {
    skipped.push({ ...candidate, reason: 'push_failed' });
    git(['tag', '-d', candidate.stableTag], { allowFailure: true });
    continue;
  }

  promoted.push(candidate);
}

appendGithubSummary([
  '',
  '## Beta 自动晋升执行结果',
  '',
  `- 成功创建 tag 数: ${promoted.length}`,
  `- 跳过数: ${skipped.length}`,
  '',
  ...promoted.map((entry) => `- promoted ${entry.branchRef} -> ${entry.stableTag}`),
  ...skipped.map((entry) => `- skipped ${entry.branchRef} -> ${entry.stableTag}: ${entry.reason}`),
]);

logInfo('已完成 beta 自动晋升执行', {
  promoted: promoted.map((entry) => entry.stableTag),
  skipped: skipped.map((entry) => ({ tag: entry.stableTag, reason: entry.reason })),
});

setGithubOutput('promoted_count', String(promoted.length));
