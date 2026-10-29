import { api } from '../../adapters';
import type { VerticalSecurityLoginResult } from '../../adapters';

// 仅保留已校验的认证结果；密码、改密挑战及未完成请求始终归页面管理。
let retained: VerticalSecurityLoginResult | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let checking: { session: VerticalSecurityLoginResult; promise: Promise<VerticalSecurityLoginResult | null> } | null = null;
const listeners = new Set<(sessionId: string, invalidated: boolean) => void>();

export function getRetainedLogin(): VerticalSecurityLoginResult | null { return retained; }

export function subscribeRetainedLoginInvalidation(listener: (sessionId: string, invalidated: boolean) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function clearRetainedLogin(sessionId: string, invalidated = false): void {
  if (retained?.session_id !== sessionId) return;
  retained = null;
  clearInterval(timer);
  timer = undefined;
  console.info(invalidated ? '[纵密会话] 连接失效，已清除共享身份' : '[纵密会话] 已退出并清除共享身份');
  for (const listener of listeners) listener(sessionId, invalidated);
}

export async function checkRetainedLogin(): Promise<VerticalSecurityLoginResult | null> {
  const session = retained;
  if (!session?.session_id) return null;
  if (checking?.session === session) return checking.promise;
  const promise = (async () => {
    let active = false;
    try { active = await api.isVerticalSecurityLoginActive(session.session_id!); } catch { /* 状态不明确时撤销身份。 */ }
    // 旧会话的迟到检查不能撤销后来建立的新会话。
    if (retained !== session) return null;
    if (!active) {
      clearRetainedLogin(session.session_id!, true);
      void api.logoutVerticalSecurity(session.session_id!).catch(() => {});
      return null;
    }
    return session;
  })();
  checking = { session, promise };
  try { return await promise; }
  finally { if (checking?.promise === promise) checking = null; }
}

export function retainLogin(session: VerticalSecurityLoginResult): void {
  retained = session;
  clearInterval(timer);
  timer = setInterval(() => { void checkRetainedLogin(); }, 3000);
  console.info('[纵密会话] 已保留认证结果，切页后继续检查原连接');
}
