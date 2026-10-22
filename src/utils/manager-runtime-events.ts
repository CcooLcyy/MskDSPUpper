const MANAGER_RUNTIME_REFRESHED_EVENT = 'manager-runtime-refreshed';
const managerRuntimeEvents = new EventTarget();

/** 后端已完成连接恢复后通知页面，只重新读取数据，不再次重连或切换目标。 */
export function notifyManagerRuntimeRefreshed(target: EventTarget = managerRuntimeEvents): void {
  target.dispatchEvent(new Event(MANAGER_RUNTIME_REFRESHED_EVENT));
}

/** 页面卸载时调用返回函数，避免后续更新通知触发已离开的页面。 */
export function subscribeManagerRuntimeRefreshed(
  listener: () => void,
  target: EventTarget = managerRuntimeEvents,
): () => void {
  target.addEventListener(MANAGER_RUNTIME_REFRESHED_EVENT, listener);
  return () => target.removeEventListener(MANAGER_RUNTIME_REFRESHED_EVENT, listener);
}
