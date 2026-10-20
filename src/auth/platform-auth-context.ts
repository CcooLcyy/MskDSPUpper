import { createContext, useContext } from 'react';
import type { PlatformAuthController, PlatformAuthSnapshot } from './platform-auth-controller.ts';

export const PlatformAuthContext = createContext<{
  controller: PlatformAuthController;
  snapshot: PlatformAuthSnapshot;
} | null>(null);

export function usePlatformAuth() {
  const context = useContext(PlatformAuthContext);
  if (!context) throw new Error('平台登录上下文未初始化');
  return context;
}
