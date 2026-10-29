import { getCurrentWindow } from '@tauri-apps/api/window';
import { isPlatformDesktop } from './platform-auth-api';

export async function expandConfigurationWindow(): Promise<void> {
  if (!isPlatformDesktop()) return;
  const window = getCurrentWindow();
  // 用户已手动最大化时保留当前状态；普通窗口只在首次进入工作台时最大化。
  if (await window.isMaximized()) return;
  await window.maximize();
}
