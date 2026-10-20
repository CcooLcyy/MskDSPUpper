import { invoke } from '@tauri-apps/api/core';
import type { PlatformAuthApi } from './platform-auth-controller.ts';

export const isPlatformDesktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function desktopInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isPlatformDesktop()) throw new Error('平台登录需要桌面版上位机，请在桌面程序中打开。');
  return invoke<T>(command, args);
}

export const platformAuthApi: PlatformAuthApi = {
  getSettings: () => desktopInvoke('get_platform_login_settings'),
  saveSettings: settings => desktopInvoke('save_platform_login_settings', { settings }),
  login: (username, password, autoLogin) => desktopInvoke('platform_login', { username, password, autoLogin }),
  autoLogin: () => desktopInvoke('platform_auto_login'),
  getStatus: () => desktopInvoke('get_platform_auth_status'),
  logout: () => desktopInvoke('platform_logout'),
};
