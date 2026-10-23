import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeLowerUpdateRecoveryOptions } from '../../src/utils/lower-update-recovery.ts';

test('恢复连接只归一化额外直连地址，保持原用户且过滤其他字段', () => {
  assert.deepEqual(normalizeLowerUpdateRecoveryOptions(undefined, 'megsky@remote:22'), {});
  assert.deepEqual(normalizeLowerUpdateRecoveryOptions({ recovery_direct_account: ' megsky@192.168.1.219:010022 ', password: 'secret' }, 'megsky@remote:22'), { recovery_direct_account: 'megsky@192.168.1.219:10022' });
  assert.deepEqual(normalizeLowerUpdateRecoveryOptions({ recovery_direct_account: 'megsky@device.example:22' }, 'megsky@remote:22'), { recovery_direct_account: 'megsky@device.example:22' });
});

test('恢复直连拒绝其他用户、remote占位符和非法主机端口', () => {
  for (const address of ['', 'daniel@192.168.1.219:10022', 'Megsky@192.168.1.219:10022',
    'megsky@remote:22', 'megsky@REMOTE:22', 'megsky@192.168.1.219:0', 'megsky@192.168.1.219:65536',
    'megsky@256.1.1.1:22', 'megsky@host:xx', 'megsky@host name:22', 'megsky@host/path:22',
    'megsky@host;id:22', 'megsky@host:22\nother', 'megsky@https://host:22', 'megsky@:22']) {
    assert.throws(() => normalizeLowerUpdateRecoveryOptions({ recovery_direct_account: address }, 'megsky@remote:22'), /直连|原任务/);
  }
});
