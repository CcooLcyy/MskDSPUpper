import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api as tauriApi } from '../adapters/tauri.ts';
import { getAppSetting, saveAppSetting } from '../utils/app-settings.ts';
import { AppModeContext, type AppModeContextValue } from './app-mode-context.ts';
import { capabilitiesFor, type AppMode } from './capabilities.ts';
import {
  APP_MODE_SETTING_KEY,
  LAST_WORKSPACE_SETTING_KEY,
  getAppMode,
  normalizeAppMode,
  setAppMode,
  subscribeAppMode,
} from './mode.ts';
import {
  closeWorkspace,
  createWorkspace as createWorkspaceInStore,
  flushWorkspace,
  getWorkspace,
  getWorkspaceFilePath,
  hasWorkspace,
  listWorkspaceFiles,
  loadWorkspaceFile,
  resolveWorkspaceDirectory,
  saveWorkspaceTo,
  seedWorkspaceFromSnapshot,
  subscribeWorkspace,
} from './workspace/store.ts';
import { DEFAULT_WORKSPACE_NAME, type OfflineWorkspace } from './workspace/types.ts';

function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function deriveWorkspaceNameFromPath(filePath: string): string {
  const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const withoutExtension = fileName.replace(/\.mskcfg$/i, '').trim();

  return withoutExtension || DEFAULT_WORKSPACE_NAME;
}

/**
 * 运行模式 Provider。
 *
 * - 在线模式：`api` 走真实 Tauri 实现，行为与改造前一致；
 * - 离线工作区：`api` 走本地工作区实现，运行态能力被关闭；
 * - 切回在线前会把工作区落盘，避免丢失未保存的编辑。
 */
export function AppModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<AppMode>(() => getAppMode());
  const [workspace, setWorkspace] = useState<OfflineWorkspace | null>(() => (hasWorkspace() ? getWorkspace() : null));
  const [workspaceFilePath, setWorkspaceFilePath] = useState<string | null>(() => getWorkspaceFilePath());
  const [switching, setSwitching] = useState(false);
  const desktopRuntime = isDesktopRuntime();

  useEffect(() => subscribeAppMode(() => setMode(getAppMode())), []);

  useEffect(() => subscribeWorkspace(() => {
    setWorkspace(hasWorkspace() ? getWorkspace() : null);
    setWorkspaceFilePath(getWorkspaceFilePath());
  }), []);

  // 启动时恢复上次的离线会话；恢复失败则退回在线模式。
  useEffect(() => {
    if (!desktopRuntime) {
      return;
    }

    if (normalizeAppMode(getAppSetting(APP_MODE_SETTING_KEY)) !== 'offline') {
      return;
    }

    const lastFile = getAppSetting<string>(LAST_WORKSPACE_SETTING_KEY);

    void (async () => {
      try {
        if (typeof lastFile === 'string' && lastFile.trim()) {
          await loadWorkspaceFile(lastFile);
        } else {
          createWorkspaceInStore(DEFAULT_WORKSPACE_NAME);
        }

        setAppMode('offline');
      } catch (error) {
        console.warn('[离线工作区] 恢复上次工作区失败，已回到在线模式', error);
        closeWorkspace();
        setAppMode('online');
        await saveAppSetting(APP_MODE_SETTING_KEY, 'online');
      }
    })();
  }, [desktopRuntime]);

  const enterOfflineMode = useCallback(async () => {
    if (!desktopRuntime) {
      throw new Error('离线工作区仅在桌面版上位机可用');
    }

    setSwitching(true);

    try {
      if (!hasWorkspace()) {
        const lastFile = getAppSetting<string>(LAST_WORKSPACE_SETTING_KEY);

        if (typeof lastFile === 'string' && lastFile.trim()) {
          try {
            await loadWorkspaceFile(lastFile);
          } catch (error) {
            console.warn('[离线工作区] 上次工作区不可用，改为新建', error);
          }
        }

        if (!hasWorkspace()) {
          createWorkspaceInStore(DEFAULT_WORKSPACE_NAME);
        }
      }

      setAppMode('offline');
      await saveAppSetting(APP_MODE_SETTING_KEY, 'offline');
      console.info('[离线工作区] 已进入离线工作区');
    } finally {
      setSwitching(false);
    }
  }, [desktopRuntime]);

  const exitOfflineMode = useCallback(async () => {
    setSwitching(true);

    try {
      await flushWorkspace();
      setAppMode('online');
      await saveAppSetting(APP_MODE_SETTING_KEY, 'online');
      console.info('[离线工作区] 已切回在线模式，工作区不会被自动下发');
    } finally {
      setSwitching(false);
    }
  }, []);

  const createWorkspace = useCallback((name: string) => {
    createWorkspaceInStore(name);
  }, []);

  const openWorkspaceFile = useCallback(async (filePath: string) => {
    const opened = await loadWorkspaceFile(filePath);

    await saveAppSetting(LAST_WORKSPACE_SETTING_KEY, filePath);
    console.info('[离线工作区] 已打开工作区', { filePath, name: opened.workspace_name });
  }, []);

  const seedWorkspaceFromSnapshotFile = useCallback(async (filePath: string) => {
    const snapshot = await tauriApi.loadFullConfigExport(filePath);
    const name = deriveWorkspaceNameFromPath(filePath);
    const directory = await resolveWorkspaceDirectory();

    seedWorkspaceFromSnapshot(snapshot, name);
    const savedPath = await saveWorkspaceTo(`${directory}/${name}.mskwsp`);

    await saveAppSetting(LAST_WORKSPACE_SETTING_KEY, savedPath);
    console.info('[离线工作区] 已用 .mskcfg 打底', { filePath, savedPath });

    return savedPath;
  }, []);

  const saveWorkspaceAs = useCallback(async (filePath: string) => {
    const savedPath = await saveWorkspaceTo(filePath);

    await saveAppSetting(LAST_WORKSPACE_SETTING_KEY, savedPath);

    return savedPath;
  }, []);

  const listWorkspaces = useCallback(() => listWorkspaceFiles(), []);

  const capabilities = useMemo(() => capabilitiesFor(mode), [mode]);
  const can = useCallback((capability: Parameters<AppModeContextValue['can']>[0]) => capabilities[capability] === true, [capabilities]);

  const value = useMemo<AppModeContextValue>(() => ({
    mode,
    capabilities,
    can,
    workspace,
    workspaceFilePath,
    switching,
    desktopRuntime,
    enterOfflineMode,
    exitOfflineMode,
    listWorkspaces,
    createWorkspace,
    openWorkspaceFile,
    seedWorkspaceFromSnapshotFile,
    saveWorkspaceAs,
  }), [
    mode,
    capabilities,
    can,
    workspace,
    workspaceFilePath,
    switching,
    desktopRuntime,
    enterOfflineMode,
    exitOfflineMode,
    listWorkspaces,
    createWorkspace,
    openWorkspaceFile,
    seedWorkspaceFromSnapshotFile,
    saveWorkspaceAs,
  ]);

  return <AppModeContext.Provider value={value}>{children}</AppModeContext.Provider>;
}
