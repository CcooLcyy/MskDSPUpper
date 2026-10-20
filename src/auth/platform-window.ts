import { currentMonitor, getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { isPlatformDesktop } from './platform-auth-api';

export async function expandConfigurationWindow(): Promise<void> {
  if (!isPlatformDesktop()) return;
  const window = getCurrentWindow();
  // 用户已手动最大化时保留当前状态；普通窗口只在首次进入工作台时展开。
  if (await window.isMaximized()) return;
  const monitor = await currentMonitor();
  const width = monitor ? Math.min(1440, monitor.workArea.size.width / monitor.scaleFactor - 24) : 1440;
  const height = monitor ? Math.min(900, monitor.workArea.size.height / monitor.scaleFactor - 48) : 900;
  await window.setSize(new LogicalSize(Math.max(1, width), Math.max(1, height)));
  await window.center();
}
