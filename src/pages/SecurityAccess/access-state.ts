import type { VerticalSecurityLoginResult } from '../../adapters/types.ts';

// 页面切换后仍保留版本号，防止先前检查覆盖后续已确认的连接失败。
let revision = 0;
const listeners = new Set<() => void>();

export function getAccessCheckRevision(): number { return revision; }

export function subscribeAccessCheckInvalidation(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function invalidateAccessCheck(): void {
  revision += 1;
  console.info('[纵密访问检查] 已撤销旧检查结果');
  for (const listener of listeners) listener();
}

export function reportLoginConnectionFailure(result: VerticalSecurityLoginResult): void {
  if (result.mode === 'direct' && result.target_ip === '11.22.33.44'
    && result.steps.some(step => (step.id === 'connect' || step.id === 'tls') && step.state === 'failed')) {
    invalidateAccessCheck();
  }
}
