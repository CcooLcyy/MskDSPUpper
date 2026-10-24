export type WorkbenchView = 'engineering' | 'runtime';

export const WORKBENCH_VIEW_STORAGE_KEY = 'mskdsp.workbench.view.v1';

type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function resolveWorkbenchView(preference: WorkbenchView, runtimeAvailable: boolean): WorkbenchView {
  return runtimeAvailable ? preference : 'engineering';
}

/** 工作视图只保存本机展示偏好，不持有设备接口或配置草稿。 */
export function createWorkbenchViewStore(storage?: ViewStorage) {
  let view: WorkbenchView = 'engineering';
  try {
    if (storage?.getItem(WORKBENCH_VIEW_STORAGE_KEY) === 'runtime') view = 'runtime';
  } catch {
    console.warn('[工作台] 无法读取工作视图偏好，使用工程配置');
  }
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setView(next: WorkbenchView) {
      if (next === view) return;
      view = next;
      try { storage?.setItem(WORKBENCH_VIEW_STORAGE_KEY, view); }
      catch { console.warn('[工作台] 无法保存工作视图偏好，本次切换仍然有效'); }
      console.info('[工作台] 已切换工作视图', { view });
      listeners.forEach(listener => listener());
    },
  };
}
