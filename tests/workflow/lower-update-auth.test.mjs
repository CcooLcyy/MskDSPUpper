import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveLowerUpdateSudoPassword } from '../../src/utils/lower-update-auth.ts';

// 验证密码 SSH 模式可以显式复用 SSH 密码作为 sudo 密码。
test('lower update reuses SSH password only when requested', () => {
  assert.equal(resolveLowerUpdateSudoPassword({
    sshAuthMethod: 'password',
    sshPassword: 'ssh-secret',
    reuseSshPassword: true,
    sudoPassword: 'sudo-secret',
  }), 'ssh-secret');
});

// 验证关闭复用后始终使用独立 sudo 密码。
test('lower update uses independent sudo password when reuse is disabled', () => {
  assert.equal(resolveLowerUpdateSudoPassword({
    sshAuthMethod: 'password',
    sshPassword: 'ssh-secret',
    reuseSshPassword: false,
    sudoPassword: 'sudo-secret',
  }), 'sudo-secret');
});

// 验证证书 SSH 模式没有可复用密码，必须使用独立 sudo 密码。
test('certificate SSH authentication always uses independent sudo password', () => {
  assert.equal(resolveLowerUpdateSudoPassword({
    sshAuthMethod: 'certificate',
    sshPassword: 'unused-secret',
    reuseSshPassword: true,
    sudoPassword: 'sudo-secret',
  }), 'sudo-secret');
});
