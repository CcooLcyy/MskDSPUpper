import test from 'node:test';
import assert from 'node:assert/strict';
import { createSshOutputAcks } from '../../src/utils/remote-ssh-output.ts';

test('SSH output consumed before open returns repays all pending credits after session binding', () => {
  const acknowledgements = [];
  const output = createSshOutputAcks(id => acknowledgements.push(id), () => true);
  for (let index = 0; index < 8; index += 1) output.consumed();
  assert.deepEqual(acknowledgements, []);
  output.bind('session-a');
  assert.deepEqual(acknowledgements, Array(8).fill('session-a'));
  output.consumed();
  assert.equal(acknowledgements.length, 9);
});

test('late SSH output callbacks cannot acknowledge a newer session after device switch', () => {
  let active = true;
  const acknowledgements = [];
  const output = createSshOutputAcks(id => acknowledgements.push(id), () => active);
  output.consumed();
  active = false;
  output.bind('old-session');
  output.consumed();
  assert.deepEqual(acknowledgements, []);
});
