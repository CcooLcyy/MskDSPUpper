import { createContext, useContext } from 'react';
import type { WorkbenchView } from './workbench-view';

export interface WorkbenchContextValue {
  view: WorkbenchView;
  setView: (view: WorkbenchView) => void;
  runtimeAvailable: boolean;
}

// 独立的模板预览只展示工程配置，完整应用由 Provider 提供可切换的上下文。
export const WorkbenchContext = createContext<WorkbenchContextValue>({
  view: 'engineering',
  setView: () => {},
  runtimeAvailable: false,
});

export function useWorkbench(): WorkbenchContextValue {
  return useContext(WorkbenchContext);
}
