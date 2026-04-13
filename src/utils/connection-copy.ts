const COPY_SUFFIX = '_copy';
const MIN_PORT = 1;
const MAX_PORT = 65535;

function extractCopyBaseName(sourceName: string): string {
  const matched = sourceName.match(/^(.*)_copy(?:_\d+)?$/);
  return matched?.[1] ? matched[1] : sourceName;
}

export function buildDuplicateConnectionName(sourceName: string, existingNames: Iterable<string>): string {
  const baseName = extractCopyBaseName(sourceName);
  const copyPrefix = `${baseName}${COPY_SUFFIX}`;
  let maxSuffix = 0;

  for (const existingName of existingNames) {
    if (existingName === copyPrefix) {
      maxSuffix = Math.max(maxSuffix, 1);
      continue;
    }

    if (!existingName.startsWith(`${copyPrefix}_`)) {
      continue;
    }

    const suffixText = existingName.slice(copyPrefix.length + 1);
    const suffix = Number.parseInt(suffixText, 10);
    if (Number.isInteger(suffix) && suffix >= 2) {
      maxSuffix = Math.max(maxSuffix, suffix);
    }
  }

  return maxSuffix === 0 ? copyPrefix : `${copyPrefix}_${maxSuffix + 1}`;
}

export function findNextAvailablePort(
  preferredPort: number,
  usedPorts: Iterable<number>,
): number | null {
  if (!Number.isInteger(preferredPort) || preferredPort < MIN_PORT || preferredPort > MAX_PORT) {
    return null;
  }

  const occupiedPorts = new Set<number>();
  for (const usedPort of usedPorts) {
    if (Number.isInteger(usedPort) && usedPort >= MIN_PORT && usedPort <= MAX_PORT) {
      occupiedPorts.add(usedPort);
    }
  }

  for (let offset = 0; offset < MAX_PORT; offset += 1) {
    const candidate = ((preferredPort - MIN_PORT + offset) % MAX_PORT) + MIN_PORT;
    if (!occupiedPorts.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function isNotFoundError(error: unknown): boolean {
  return `${error}`.toUpperCase().includes('NOT_FOUND');
}
