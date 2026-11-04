import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreLoginLocks, updateLoginLock, getLoginLockSeconds, getLockSeconds, formatLockCountdown } from '../../src/pages/SecurityAccess/login-lockout.ts';

const account = { mode: 'direct', device_id: null, username: 'fixture-user' };

test('装置剩余时间按截止时间计算并向上取整，计时器延迟不积累误差', () => {
  const [lock] = restoreLoginLocks([{ ...account, lock_seconds: 120 }], 1000);
  assert.equal(getLockSeconds(lock, 1000), 120);
  assert.equal(getLockSeconds(lock, 1001), 120);
  assert.equal(getLockSeconds(lock, 62001), 59);
  assert.equal(getLockSeconds(lock, 121000), 0);
  assert.equal(getLockSeconds(lock, 999999), 0);
  assert.equal(formatLockCountdown(598), '09:58');
  assert.equal(formatLockCountdown(3600), '60:00');
  assert.equal(formatLockCountdown(0), '00:00');
});

test('同账号跨角色共用锁定，用户名原样匹配且隔离目标', () => {
  const locks = restoreLoginLocks([{ ...account, lock_seconds: 60 }], 1000);
  assert.equal(getLoginLockSeconds(locks, { ...account, role: 1 }, 1000), 60);
  assert.equal(getLoginLockSeconds(locks, { ...account, role: 2 }, 1000), 60);
  assert.equal(getLoginLockSeconds(locks, { ...account, username: 'other-user' }, 1000), 0);
  assert.equal(getLoginLockSeconds(locks, { ...account, username: ' fixture-user' }, 1000), 0);
  assert.equal(getLoginLockSeconds(locks, { ...account, mode: 'remote', device_id: 'dsp-a' }, 1000), 0);
  const remote = restoreLoginLocks([{ ...account, mode: 'remote', device_id: 'dsp-a', lock_seconds: 60 }], 1000);
  assert.equal(getLoginLockSeconds(remote, { ...account, mode: 'remote', device_id: 'dsp-b' }, 1000), 0);
});

test('重取后端剩余时间可恢复倒计时，新锁定应答更新而非累加等待', () => {
  let locks = restoreLoginLocks([{ ...account, lock_seconds: 60 }], 1000);
  locks = updateLoginLock(locks, account, 10, 2000);
  assert.equal(locks.length, 1);
  assert.equal(getLoginLockSeconds(locks, account, 2000), 10);
  locks = updateLoginLock(locks, account, 90, 3000);
  assert.equal(getLoginLockSeconds(locks, account, 3000), 90);
  const restored = restoreLoginLocks([{ ...account, lock_seconds: 30 }], 63000);
  assert.equal(getLoginLockSeconds(restored, account, 63000), 30);
});

test('零秒、缺失及非法时长不产生虚构等待，只有装置明确返回零秒才结束等待', () => {
  for (const seconds of [0, null, undefined, -1, 1.5, NaN, Infinity, 4294967296]) {
    assert.deepEqual(restoreLoginLocks([{ ...account, lock_seconds: seconds }], 1000), []);
    assert.deepEqual(updateLoginLock([], account, seconds, 1000), []);
  }
  const locks = restoreLoginLocks([{ ...account, lock_seconds: 60 }], 1000);
  assert.equal(getLoginLockSeconds(updateLoginLock(locks, account, null, 2000), account, 2000), 59);
  assert.equal(getLoginLockSeconds(updateLoginLock(locks, account, 0, 2000), account, 2000), 0);
});
