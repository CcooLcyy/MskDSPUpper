import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { logInfo, runCommand } from './runtime.mjs';

export function pathExists(targetPath) {
  return fs.existsSync(targetPath);
}

export function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

export function removeDir(targetPath) {
  if (!pathExists(targetPath)) {
    return;
  }

  fs.rmSync(targetPath, { recursive: true, force: true });
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function writeTextFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, value, 'utf8');
}

export function copyPath(sourcePath, destinationPath) {
  if (!pathExists(sourcePath)) {
    return false;
  }

  ensureDir(path.dirname(destinationPath));
  fs.cpSync(sourcePath, destinationPath, { recursive: true, force: true });
  return true;
}

export function listFilesRecursive(rootPath) {
  if (!pathExists(rootPath)) {
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

export function findFirstExisting(paths) {
  return paths.find((candidate) => pathExists(candidate)) ?? null;
}

export function computeSha256(filePath) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

export function zipDirectory(sourceDir, archiveFile) {
  ensureDir(path.dirname(archiveFile));
  if (pathExists(archiveFile)) {
    fs.rmSync(archiveFile, { force: true });
  }

  logInfo('打包目录为压缩包', { sourceDir, archiveFile });

  if (process.platform === 'win32') {
    runCommand('powershell', [
      '-NoLogo',
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path (Join-Path '${sourceDir}' '*') -DestinationPath '${archiveFile}' -Force`,
    ]);
    return;
  }

  runCommand('zip', ['-r', archiveFile, '.'], { cwd: sourceDir });
}
