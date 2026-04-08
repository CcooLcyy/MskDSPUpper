import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function emit(level, message, detail) {
  const prefix = `[workflow][${new Date().toISOString()}][${level}]`;
  if (detail === undefined) {
    console.log(`${prefix} ${message}`);
    return;
  }

  if (typeof detail === 'string') {
    console.log(`${prefix} ${message}: ${detail}`);
    return;
  }

  console.log(`${prefix} ${message}: ${JSON.stringify(detail, null, 2)}`);
}

export function logInfo(message, detail) {
  emit('INFO', message, detail);
}

export function logWarn(message, detail) {
  emit('WARN', message, detail);
}

export function logError(message, detail) {
  emit('ERROR', message, detail);
}

function quoteArg(value) {
  if (!/[^\w./:=+-]/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

export function formatCommand(command, args = []) {
  return [command, ...args].map(quoteArg).join(' ');
}

export function runCommand(command, args = [], options = {}) {
  const { cwd, env, input, allowFailure = false } = options;
  const rendered = formatCommand(command, args);
  logInfo('执行命令', { cwd: cwd ?? process.cwd(), command: rendered });

  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0 && !allowFailure) {
    throw new Error(`命令执行失败 (${result.status}): ${rendered}`);
  }

  return {
    status: result.status ?? 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function setGithubOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    logInfo('写入输出变量', { name, value });
    return;
  }

  fs.appendFileSync(outputFile, `${name}=${value}\n`, 'utf8');
}

export function appendGithubSummary(lines) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) {
    return;
  }

  const text = Array.isArray(lines) ? `${lines.join('\n')}\n` : `${lines}\n`;
  fs.appendFileSync(summaryFile, text, 'utf8');
}

export function resolveRepoRoot(importMetaUrl) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), '..', '..');
}
