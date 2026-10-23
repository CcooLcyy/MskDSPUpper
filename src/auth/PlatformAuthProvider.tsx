import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { initializeAppSettings } from '../utils/app-settings';
import { platformAuthApi } from './platform-auth-api.ts';
import { createPlatformAuthController, type PlatformAuthController } from './platform-auth-controller.ts';
import { PlatformAuthContext } from './platform-auth-context.ts';
import { expandConfigurationWindow } from './platform-window';
import { assertPlatformLogoutAllowed, reloadPlatformWorkspace } from './platform-workspace-lifecycle';

const defaultController = createPlatformAuthController(platformAuthApi, initializeAppSettings, Date.now, {
  prepareLogout: assertPlatformLogoutAllowed,
  resetWorkspace: reloadPlatformWorkspace,
});

export function PlatformAuthProvider({ children, controller = defaultController }: {
  children: ReactNode;
  controller?: PlatformAuthController;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const expanded = useRef(false);
  useEffect(() => {
    if (!snapshot.workspaceReady || snapshot.phase !== 'authenticated' || expanded.current) return;
    expanded.current = true;
    try {
      // 退出只重建界面，同一窗口内后续登录保留用户手动调整的大小。
      const key = 'mskdsp.configuration-window-expanded';
      if (window.sessionStorage.getItem(key) === '1') return;
      window.sessionStorage.setItem(key, '1');
    } catch {
      console.warn('无法记录工作台窗口状态，将按首次登录调整窗口。');
    }
    void expandConfigurationWindow().catch(() => {
      console.warn('自动调整工作台窗口大小失败，可手动调整窗口。');
    });
  }, [snapshot.workspaceReady, snapshot.phase]);
  useEffect(() => {
    void controller.start();
    const interval = window.setInterval(() => { void controller.poll(); }, 2000);
    const tick = window.setInterval(controller.tick, 250);
    const check = () => { controller.tick(); void controller.poll(); };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearInterval(interval);
      window.clearInterval(tick);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [controller]);
  return <PlatformAuthContext.Provider value={{ controller, snapshot }}>{children}</PlatformAuthContext.Provider>;
}
