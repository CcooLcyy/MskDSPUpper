import { parseArgs } from 'node:util';

import { choosePreferredBetaRef, parseBetaLine } from './lib/metadata.mjs';
import { findContainingBetaRefs } from './lib/git.mjs';
import { logInfo, setGithubOutput } from './lib/runtime.mjs';

const { values } = parseArgs({
  options: {
    commit: { type: 'string' },
    remote: { type: 'string' },
  },
});

if (!values.commit) {
  throw new Error('--commit 必填');
}

const refs = findContainingBetaRefs(values.commit, values.remote ?? 'origin');
if (refs.length === 0) {
  throw new Error(`提交 ${values.commit} 不属于任何 beta/* 版本线`);
}

const preferredRef = choosePreferredBetaRef(refs) ?? refs[0];
const betaLine = parseBetaLine(preferredRef);

logInfo('已验证 stable tag 来源 beta 版本线', {
  commit: values.commit,
  preferredRef,
  refs,
});

setGithubOutput('beta_ref', preferredRef);
setGithubOutput('beta_line', betaLine ?? '');
