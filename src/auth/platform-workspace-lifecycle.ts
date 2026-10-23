type LogoutGuard = () => string | null;

const logoutGuards = new Set<LogoutGuard>();
let workspaceResetting = false;

/** 在退出确认执行时读取任务的最新状态，避免中断执行中的升级。 */
export function registerPlatformLogoutGuard(guard: LogoutGuard): () => void {
  logoutGuards.add(guard);
  return () => { logoutGuards.delete(guard); };
}

export function assertPlatformLogoutAllowed(): void {
  for (const guard of logoutGuards) {
    const reason = guard();
    if (reason) {
      console.info('当前任务尚未结束，已阻止退出平台账号。');
      throw new Error(reason);
    }
  }
}

export function isPlatformWorkspaceResetting(): boolean {
  return workspaceResetting;
}

/** 只重建界面以清空模块内存，桌面进程及已保存的配置继续保留。 */
export async function reloadPlatformWorkspace(reload: () => void = () => window.location.reload()): Promise<void> {
  workspaceResetting = true;
  try {
    console.info('正在清理当前账号的工作台并返回登录页。');
    reload();
  } catch (error) {
    workspaceResetting = false;
    throw error;
  }
  // 导航前始终禁止旧页面重新登录，避免新账号接触尚未卸载的草稿。
  await new Promise<void>(() => {});
}
