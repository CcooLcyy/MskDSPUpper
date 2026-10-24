import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useAppMode } from '../offline/app-mode-context';
import { WorkbenchContext } from './workbench-context';
import { createWorkbenchViewStore, resolveWorkbenchView, type WorkbenchView } from './workbench-view';

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const { can } = useAppMode();
  const runtimeAvailable = can('runtime.read');
  const [store] = useState(() => {
    try { return createWorkbenchViewStore(window.localStorage); }
    catch { return createWorkbenchViewStore(); }
  });
  const preference = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const view = resolveWorkbenchView(preference, runtimeAvailable);
  const setView = useCallback((next: WorkbenchView) => {
    if (!runtimeAvailable) return;
    store.setView(next);
  }, [runtimeAvailable, store]);
  const value = useMemo(() => ({ view, setView, runtimeAvailable }), [view, setView, runtimeAvailable]);
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}
