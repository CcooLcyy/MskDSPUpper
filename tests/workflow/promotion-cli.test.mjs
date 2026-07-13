import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
  });

  if (options.allowFailure) {
    return result;
  }

  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function prependPath(directory, env = {}) {
  return {
    ...env,
    PATH: `${directory}${path.delimiter}${process.env.PATH}`,
  };
}

test('evaluate-beta-promotion normalizes explicit beta refs', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mskdsp-upper-promote-eval-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const remoteDir = path.join(tempRoot, 'remote.git');
  const workDir = path.join(tempRoot, 'work');
  fs.mkdirSync(remoteDir, { recursive: true });
  run('git', ['init', '--bare', remoteDir], { cwd: tempRoot });
  run('git', ['clone', remoteDir, workDir], { cwd: tempRoot });
  run('git', ['config', 'user.name', 'Test User'], { cwd: workDir });
  run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: workDir });

  fs.writeFileSync(path.join(workDir, 'package.json'), '{"version":"0.1.0"}\n', 'utf8');
  run('git', ['add', 'package.json'], { cwd: workDir });
  run('git', ['commit', '-m', 'seed'], {
    cwd: workDir,
    env: {
      GIT_AUTHOR_DATE: '2026-04-05T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-04-05T00:00:00Z',
    },
  });
  run('git', ['switch', '-c', 'beta/0.1'], { cwd: workDir });
  run('git', ['push', '-u', 'origin', 'beta/0.1'], { cwd: workDir });
  run('git', ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*'], { cwd: workDir });

  const mockBin = path.join(tempRoot, 'bin');
  fs.mkdirSync(mockBin);
  fs.writeFileSync(
    path.join(mockBin, process.platform === 'win32' ? 'gh.cmd' : 'gh'),
    process.platform === 'win32' ? '@exit /b 1\r\n' : '#!/usr/bin/env sh\nexit 1\n',
    'utf8',
  );
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(mockBin, 'gh'), 0o755);
  }

  const outputPath = path.join(tempRoot, 'promotion.json');
  run(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'workflow', 'evaluate-beta-promotion.mjs'),
      '--beta-ref',
      'origin/beta/0.1',
      '--threshold-hours',
      '0',
      '--output',
      outputPath,
      '--now',
      '2026-04-08T00:00:00.000Z',
    ],
    { cwd: workDir, env: prependPath(mockBin) },
  );

  const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(output.evaluations[0].branchRef, 'beta/0.1');
  assert.equal(output.evaluations[0].version, '0.1.0');
  assert.equal(output.candidates[0].stableTag, 'v0.1.0');
  assert.equal(output.releaseDispatches[0].stableTag, 'v0.1.0');

  run('git', ['tag', 'v0.1.0'], { cwd: workDir });
  const dispatchOutputPath = path.join(tempRoot, 'promotion-dispatch.json');
  run(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'workflow', 'evaluate-beta-promotion.mjs'),
      '--beta-ref',
      'refs/heads/beta/0.1',
      '--threshold-hours',
      '0',
      '--output',
      dispatchOutputPath,
      '--now',
      '2026-04-08T00:00:00.000Z',
    ],
    { cwd: workDir, env: prependPath(mockBin) },
  );

  const dispatchOutput = JSON.parse(fs.readFileSync(dispatchOutputPath, 'utf8'));
  assert.equal(dispatchOutput.candidates.length, 0);
  assert.equal(dispatchOutput.evaluations[0].reason, 'stable_tag_exists_release_missing');
  assert.equal(dispatchOutput.evaluations[0].dispatchRelease, true);
  assert.equal(dispatchOutput.releaseDispatches[0].stableTag, 'v0.1.0');
});

test('promote-beta-tags dispatches an existing tag when its release is missing', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mskdsp-upper-promote-run-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const repoDir = path.join(tempRoot, 'repo');
  fs.mkdirSync(repoDir);
  run('git', ['init'], { cwd: repoDir });
  run('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'seed\n', 'utf8');
  run('git', ['add', 'README.md'], { cwd: repoDir });
  run('git', ['commit', '-m', 'seed'], { cwd: repoDir });
  run('git', ['tag', 'v0.1.0'], { cwd: repoDir });

  const inputPath = path.join(tempRoot, 'promotion.json');
  fs.writeFileSync(
    inputPath,
    JSON.stringify(
      {
        thresholdHours: 72,
        candidates: [],
        releaseDispatches: [
          {
            stableTag: 'v0.1.0',
            branchRef: 'beta/0.1',
            reason: 'stable_tag_exists_release_missing',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const githubOutput = path.join(tempRoot, 'github-output.txt');
  run(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'workflow', 'promote-beta-tags.mjs'), '--input', inputPath],
    { cwd: repoDir, env: { GITHUB_OUTPUT: githubOutput } },
  );

  const output = fs.readFileSync(githubOutput, 'utf8');
  assert.match(output, /^promoted_count=0$/m);
  assert.match(output, /^release_dispatch_count=1$/m);
  assert.match(output, /^release_dispatch_tags_json=\["v0\.1\.0"\]$/m);
});

test('promote-beta-tags deduplicates release dispatch tags', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mskdsp-upper-promote-dedupe-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const remoteDir = path.join(tempRoot, 'remote.git');
  const repoDir = path.join(tempRoot, 'repo');
  run('git', ['init', '--bare', remoteDir], { cwd: tempRoot });
  run('git', ['clone', remoteDir, repoDir], { cwd: tempRoot });
  run('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'seed\n', 'utf8');
  run('git', ['add', 'README.md'], { cwd: repoDir });
  run('git', ['commit', '-m', 'seed'], { cwd: repoDir });
  const commitSha = run('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).stdout.trim();

  const inputPath = path.join(tempRoot, 'promotion.json');
  fs.writeFileSync(
    inputPath,
    JSON.stringify(
      {
        thresholdHours: 72,
        candidates: [
          {
            stableTag: 'v0.4.0',
            branchRef: 'beta/0.4',
            commitSha,
            reason: 'eligible',
          },
          {
            stableTag: 'v0.4.0',
            branchRef: 'beta/0.4.0',
            commitSha,
            reason: 'eligible',
          },
        ],
        releaseDispatches: [
          {
            stableTag: 'v0.4.0',
            branchRef: 'beta/0.4',
            commitSha,
            reason: 'promoted',
          },
          {
            stableTag: 'v0.4.0',
            branchRef: 'beta/0.4.0',
            commitSha,
            reason: 'promoted',
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  const githubOutput = path.join(tempRoot, 'github-output.txt');
  run(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'workflow', 'promote-beta-tags.mjs'), '--input', inputPath],
    { cwd: repoDir, env: { GITHUB_OUTPUT: githubOutput } },
  );

  const output = fs.readFileSync(githubOutput, 'utf8');
  assert.match(output, /^promoted_count=1$/m);
  assert.match(output, /^release_dispatch_count=1$/m);
  assert.match(output, /^release_dispatch_tags_json=\["v0\.4\.0"\]$/m);
});
