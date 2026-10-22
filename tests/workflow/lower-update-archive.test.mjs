import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendLowerUpdateArchive } from '../../src/utils/lower-update-archive.ts';

function record(id = '00000000-0000-4000-8000-000000000000') {
  return { task: {
    operation_id: id, upload_account: 'user@remote:22', install_dir: '/home/user',
    remote_target: { endpoint: 'https://platform', device_id: 'device-a' },
    package_name: 'pkg', package_sha256: 'c'.repeat(64), expected_image_id: `sha256:${'a'.repeat(64)}`, version: '1',
  }, actual_image_id: `sha256:${'b'.repeat(64)}`, closed_at: '2026-10-22T10:00:00.000Z', reason: 'task_not_found' };
}

test('任务归档白名单过滤凭据、保留原目标并最多保存20条', () => {
  let archive = [];
  for (let index = 0; index < 22; index++) {
    const next = record(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    next.auth = { password: 'secret' };
    next.task.sudo_password = 'secret';
    archive = appendLowerUpdateArchive(archive, next);
  }
  assert.equal(archive.length, 20);
  assert.equal(archive[0].task.operation_id, '00000000-0000-4000-8000-000000000002');
  assert.equal(archive[19].task.operation_id, '00000000-0000-4000-8000-000000000021');
  assert.equal(JSON.stringify(archive).includes('secret'), false);
  assert.equal(archive[0].task.remote_target.device_id, 'device-a');
  assert.deepEqual(appendLowerUpdateArchive(archive, record(archive[19].task.operation_id)), archive);
});

test('损坏归档或新记录不覆盖已有备份', () => {
  for (const existing of [{}, [false], [{ ...record(), reason: 'unknown' }]]) {
    assert.throws(() => appendLowerUpdateArchive(existing, record()), /归档/);
  }
  for (const next of [{}, { ...record(), actual_image_id: 'invalid' }, { ...record(), closed_at: 'invalid' }]) {
    assert.throws(() => appendLowerUpdateArchive([], next), /归档/);
  }
});
