import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateControlAllocationShares,
  inferControlAllocationMode,
  resolveControlAllocationWeight,
} from '../../src/utils/control-allocation.ts';

test('control allocation detects equal weights among controllable members', () => {
  assert.equal(inferControlAllocationMode([
    { controllable: true, weight: 1, basis: 100 },
    { controllable: true, weight: 1, basis: 200 },
    { controllable: false, weight: 99, basis: 300 },
  ]), 'equal');
});

test('control allocation detects weights proportional to the selected basis', () => {
  assert.equal(inferControlAllocationMode([
    { controllable: true, weight: 2, basis: 100 },
    { controllable: true, weight: 5, basis: 250 },
  ]), 'proportional');
});

test('control allocation preserves custom ratios and resolves preset weights', () => {
  assert.equal(inferControlAllocationMode([
    { controllable: true, weight: 2, basis: 100 },
    { controllable: true, weight: 1, basis: 200 },
  ]), 'custom');
  assert.equal(resolveControlAllocationWeight('equal', 250, 7), 1);
  assert.equal(resolveControlAllocationWeight('proportional', 250, 7), 250);
  assert.equal(resolveControlAllocationWeight('custom', 250, 7), 7);
});

test('control allocation normalizes positive weights from controllable members', () => {
  const shares = calculateControlAllocationShares([
    { controllable: true, weight: 2, basis: 100 },
    { controllable: true, weight: 3, basis: 200 },
    { controllable: true, weight: 5, basis: 300 },
    { controllable: false, weight: 100, basis: 400 },
  ]);

  assert.deepEqual(shares, [0.2, 0.3, 0.5, 0]);
});

test('control allocation excludes invalid weights from normalized shares', () => {
  const shares = calculateControlAllocationShares([
    { controllable: true, weight: 0, basis: 100 },
    { controllable: true, weight: Number.NaN, basis: 200 },
    { controllable: true, weight: 4, basis: 300 },
  ]);

  assert.deepEqual(shares, [0, 0, 1]);
});
