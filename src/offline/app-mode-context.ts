/**
 * 运行模式上下文：页面只查询"能力"，不判断"模式"。
 */

import { createContext, useContext } from 'react';
import type { WorkspaceSummary } from '../adapters/types.ts';
import type { AppMode, Capability, CapabilityMatrix } from './capabilities.ts';
import type { OfflineWorkspace } from './workspace/types.ts';

export interface AppModeContextValue {
  mode: AppMode;
  capabilities: CapabilityMatrix;
  can: (capability: Capability) => boolean;
  workspace: OfflineWorkspace | null;
  workspaceFilePath: string | null;
  switching: boolean;
  /** 是否运行在桌面端（离线工作区依赖文件系统）。 */
  desktopRuntime: boolean;
  enterOfflineMode: () => Promise<void>;
  exitOfflineMode: () => Promise<void>;
  listWorkspaces: () => Promise<WorkspaceSummary[]>;
  createWorkspace: (name: string) => void;
  openWorkspaceFile: (filePath: string) => Promise<void>;
  seedWorkspaceFromSnapshotFile: (filePath: string) => Promise<string>;
  saveWorkspaceAs: (filePath: string) => Promise<string>;
}

export const AppModeContext = createContext<AppModeContextValue | null>(null);

export function useAppMode(): AppModeContextValue {
  const context = useContext(AppModeContext);

  if (!context) {
    throw new Error('useAppMode 必须在 AppModeProvider 内使用');
  }

  return context;
}
