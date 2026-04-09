import { parseArgs } from 'node:util';

import { chooseResolvedBetaRef } from './lib/git.mjs';
import { parseBetaLine } from './lib/metadata.mjs';
import { appendGithubSummary, logInfo, logWarn, setGithubOutput } from './lib/runtime.mjs';

const { values } = parseArgs({
  options: {
    'allow-missing': { type: 'boolean' },
    'beta-ref': { type: 'string' },
    'current-ref': { type: 'string' },
    remote: { type: 'string' },
  },
});

const resolvedRef = chooseResolvedBetaRef(
  values['beta-ref'] ?? null,
  values['current-ref'] ?? null,
  values.remote ?? 'origin',
  { allowMissing: values['allow-missing'] ?? false },
);

if (!resolvedRef) {
  logWarn('No beta branch resolved for this run; beta workflow will be skipped', {
    currentRef: values['current-ref'] ?? null,
    remote: values.remote ?? 'origin',
  });
  appendGithubSummary([
    '## Beta workflow skipped',
    '',
    'No `beta/*` branch could be resolved for this run, so verification and publish jobs were skipped.',
  ]);
  setGithubOutput('should_run', 'false');
  setGithubOutput('beta_ref', '');
  setGithubOutput('beta_line', '');
  process.exit(0);
}

const betaLine = parseBetaLine(resolvedRef);

if (!betaLine) {
  throw new Error(`Unable to parse beta line from ref: ${resolvedRef}`);
}

logInfo('Resolved beta target branch', { resolvedRef, betaLine });
setGithubOutput('should_run', 'true');
setGithubOutput('beta_ref', resolvedRef);
setGithubOutput('beta_line', betaLine);
