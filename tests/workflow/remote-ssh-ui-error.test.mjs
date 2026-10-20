import test from 'node:test';
import assert from 'node:assert/strict';
import { sshUiError } from '../../src/utils/remote-ssh-ui-error.ts';

test('SSH error feedback masks entered credentials and preserves a readable message', () => {
  const password = 'entered-private-password';
  const message = sshUiError(new Error(`设备拒绝认证：${password}`), [password]);
  assert.match(message, /设备拒绝认证/);
  assert.doesNotMatch(message, /entered-private-password/);
});

test('SSH errors normalize unknown IPC shapes without blank or object-object feedback', () => {
  assert.equal(sshUiError({ message: '连接失败，请重试' }), '连接失败，请重试');
  assert.match(sshUiError({ unexpected: true }), /失败/);
  assert.match(sshUiError(''), /失败/);
  assert.doesNotMatch(sshUiError({ unexpected: true }), /object Object/);
  assert.ok(sshUiError('x'.repeat(10000)).length <= 512);
});
