import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ControlGroupRoutesError } from '../../utils/control-auto-routing';

// 在页面切换后保留部分成功计划，防止重试时重复创建控制组。
const pendingPlans = new Map<string, ControlGroupRoutesError>();
const listeners = new Set<() => void>();

/** 以可订阅快照同步页面切换前后的异步重试结果。 */
export const pendingControlRouteStore = {
  getSnapshot: (moduleName: 'AGC' | 'AVC'): ControlGroupRoutesError | null => pendingPlans.get(moduleName) ?? null,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  update: (moduleName: 'AGC' | 'AVC', next: ControlGroupRoutesError | null) => {
    if ((pendingPlans.get(moduleName) ?? null) === next) return;
    if (next) pendingPlans.set(moduleName, next);
    else pendingPlans.delete(moduleName);
    console.info('控制组待重试映射状态已同步', { 模块: moduleName, 状态: next ? '等待重试' : '已完成' });
    listeners.forEach((listener) => listener());
  },
};

export default function usePendingControlRoutes(moduleName: 'AGC' | 'AVC') {
  const getSnapshot = useCallback(() => pendingControlRouteStore.getSnapshot(moduleName), [moduleName]);
  const error = useSyncExternalStore(pendingControlRouteStore.subscribe, getSnapshot, getSnapshot);
  const update = useCallback((next: ControlGroupRoutesError | null) => {
    pendingControlRouteStore.update(moduleName, next);
  }, [moduleName]);
  useEffect(() => {
    if (!error) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [error]);
  return [error, update] as const;
}
