import { parseArgs } from 'node:util';

import { chooseResolvedBetaRef } from './lib/git.mjs';
import { parseBetaLine } from './lib/metadata.mjs';
import { logInfo, setGithubOutput } from './lib/runtime.mjs';

const { values } = parseArgs({
  options: {
    'beta-ref': { type: 'string' },
    'current-ref': { type: 'string' },
    remote: { type: 'string' },
  },
});

const resolvedRef = chooseResolvedBetaRef(
  values['beta-ref'] ?? null,
  values['current-ref'] ?? null,
  values.remote ?? 'origin',
);
const betaLine = parseBetaLine(resolvedRef);

if (!betaLine) {
  throw new Error(`无法解析 beta 版本线: ${resolvedRef}`);
}

logInfo('已解析 beta 目标分支', { resolvedRef, betaLine });
setGithubOutput('beta_ref', resolvedRef);
setGithubOutput('beta_line', betaLine);
