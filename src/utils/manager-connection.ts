export type ManagerReconnectOperations<T> = {
  setManagerAddr: (addr: string, forceReconnect: boolean) => Promise<void>;
  refreshManagerState: () => Promise<T>;
  startRealtimeStream: () => Promise<void>;
};

export async function reconnectManagerRuntime<T>(
  addr: string,
  operations: ManagerReconnectOperations<T>,
): Promise<T> {
  await operations.setManagerAddr(addr, true);
  let result: T;
  try {
    result = await operations.refreshManagerState();
  } catch (error) {
    try {
      await operations.startRealtimeStream();
    } catch {
      // 后台流启动失败不覆盖更直接的模块地址刷新错误。
    }
    throw error;
  }
  await operations.startRealtimeStream();
  return result;
}
