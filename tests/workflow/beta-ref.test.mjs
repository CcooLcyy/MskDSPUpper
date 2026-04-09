import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveBetaRef } from '../../scripts/workflow/lib/git.mjs';
import {
  choosePreferredBetaRef,
  compareVersionLine,
  parseBetaLine,
} from '../../scripts/workflow/lib/metadata.mjs';

test('parseBetaLine accepts supported beta ref naming', () => {
  assert.equal(parseBetaLine('refs/heads/beta/1.2'), '1.2');
  assert.equal(parseBetaLine('origin/beta/1.2.3'), '1.2.3');
  assert.equal(parseBetaLine('feature/demo'), null);
});

test('compareVersionLine sorts higher beta line first', () => {
  assert.ok(compareVersionLine('1.3', '1.2') > 0);
  assert.ok(compareVersionLine('1.2.4', '1.2') > 0);
});

test('choosePreferredBetaRef picks newest beta branch', () => {
  const ref = choosePreferredBetaRef([
    'origin/beta/1.2',
    'origin/beta/1.3',
    'origin/beta/1.2.9',
  ]);

  assert.equal(ref, 'beta/1.3');
});

test('resolveBetaRef allows scheduled beta runs to skip when no beta branch exists', () => {
  const ref = resolveBetaRef(null, 'main', [], { allowMissing: true });
  assert.equal(ref, null);
});

test('resolveBetaRef rejects invalid explicit beta refs', () => {
  assert.throws(() => {
    resolveBetaRef('feature/demo', 'main', ['beta/1.2']);
  });
});
