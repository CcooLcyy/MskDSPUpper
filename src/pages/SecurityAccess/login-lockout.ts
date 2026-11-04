import type { VerticalSecurityAccessMode, VerticalSecurityLoginLock } from '../../adapters/types.ts';

type LoginAccount = { mode: VerticalSecurityAccessMode; device_id?: string | null; username: string; role?: number };
export type LoginLock = Omit<VerticalSecurityLoginLock, 'lock_seconds'> & { deadline: number };

function sameAccount(lock: LoginLock, account: LoginAccount): boolean {
  return lock.mode === account.mode
    && lock.device_id === (account.mode === 'remote' ? account.device_id ?? null : null)
    && lock.username === account.username;
}

function validSeconds(seconds: number | null | undefined): seconds is number {
  return typeof seconds === 'number' && Number.isInteger(seconds) && seconds > 0 && seconds <= 0xffffffff;
}

// 使用单调时钟截止时间，后台暂停及定时器延迟不会累计倒计时误差。
export function restoreLoginLocks(locks: VerticalSecurityLoginLock[], now: number): LoginLock[] {
  return locks.filter(lock => validSeconds(lock.lock_seconds)).map(({ lock_seconds, ...account }) => ({
    ...account, deadline: now + lock_seconds * 1000,
  }));
}

export function updateLoginLock(locks: LoginLock[], account: LoginAccount, seconds: number | null | undefined, now: number): LoginLock[] {
  if (seconds === 0) return locks.map(lock => sameAccount(lock, account) ? { ...lock, deadline: now } : lock);
  if (!validSeconds(seconds)) return locks;
  return [...locks.filter(lock => !sameAccount(lock, account)), {
    mode: account.mode, device_id: account.mode === 'remote' ? account.device_id ?? null : null,
    username: account.username, deadline: now + seconds * 1000,
  }];
}

export function getLockSeconds(lock: LoginLock, now: number): number {
  return Math.max(0, Math.ceil((lock.deadline - now) / 1000));
}

export function getLoginLockSeconds(locks: LoginLock[], account: LoginAccount, now: number): number {
  return Math.max(0, ...locks.filter(lock => sameAccount(lock, account)).map(lock => getLockSeconds(lock, now)));
}

export function formatLockCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
