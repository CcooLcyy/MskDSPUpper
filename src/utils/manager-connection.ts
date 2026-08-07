export type ManagerReconnectOperations<T> = {
  setManagerAddr: (addr: string, forceReconnect: boolean) => Promise<void>;
  refreshManagerState: () => Promise<T>;
};

export async function reconnectManagerRuntime<T>(
  addr: string,
  operations: ManagerReconnectOperations<T>,
): Promise<T> {
  await operations.setManagerAddr(addr, true);
  return operations.refreshManagerState();
}
