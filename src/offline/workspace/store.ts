/**
 * 离线工作区状态与持久化。
 *
 * 这里是唯一的"当前工作区"持有者：适配器通过 `getWorkspace` / `mutateWorkspace`
 * 读写配置，UI 通过订阅接口感知变化。文件读写一律走真实 Tauri 命令
 * （直接导入 `adapters/tauri.ts`，避免经过按模式分发的 `api` 代理造成递归）。
 */

import type { FullConfigExportSnapshot, WorkspaceSummary } from '../../adapters/types.ts';
import { api as tauriApi } from '../../adapters/tauri.ts';
import { ensureWorkspaceFileName, parseWorkspace, serializeWorkspace } from './serialize.ts';
import { snapshotToWorkspace } from './snapshot.ts';
import { createEmptyWorkspace, type OfflineWorkspace } from './types.ts';

/** 编辑防抖落盘间隔。 */
const AUTOSAVE_DELAY_MS = 1000;

let currentWorkspace: OfflineWorkspace | null = null;
let currentFilePath: string | null = null;
let saveTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
const workspaceListeners = new Set<() => void>();

export function hasWorkspace(): boolean {
  return currentWorkspace !== null;
}

export function getWorkspace(): OfflineWorkspace {
  if (!currentWorkspace) {
    throw new Error('未打开离线工作区');
  }

  return currentWorkspace;
}

export function getWorkspaceFilePath(): string | null {
  return currentFilePath;
}

export function subscribeWorkspace(listener: () => void): () => void {
  workspaceListeners.add(listener);

  return () => {
    workspaceListeners.delete(listener);
  };
}

/** 打开/切换当前工作区；`filePath` 为空表示尚未落盘的新建工作区。 */
export function openWorkspace(workspace: OfflineWorkspace, filePath: string | null): OfflineWorkspace {
  currentWorkspace = workspace;
  currentFilePath = filePath;
  notifyWorkspaceChanged();

  return currentWorkspace;
}

export function closeWorkspace(): void {
  currentWorkspace = null;
  currentFilePath = null;
  notifyWorkspaceChanged();
}

/** 新建空工作区（未落盘）。 */
export function createWorkspace(workspaceName: string, nowIso: string = new Date().toISOString()): OfflineWorkspace {
  return openWorkspace(createEmptyWorkspace(workspaceName, nowIso), null);
}

/** 用现场 `.mskcfg` 载入的配置打底，替换当前工作区内容。 */
export function seedWorkspaceFromSnapshot(
  snapshot: FullConfigExportSnapshot,
  workspaceName: string,
  nowIso: string = new Date().toISOString(),
): OfflineWorkspace {
  const base = currentWorkspace ?? createEmptyWorkspace(workspaceName, nowIso);
  const seeded = snapshotToWorkspace({ ...base, workspace_name: workspaceName }, snapshot, { nowIso });

  return openWorkspace(seeded, currentFilePath);
}

/**
 * 修改当前工作区。
 *
 * 内部先深拷贝再交给 updater，因此 updater 可以原地修改并返回；
 * 变更会标记脏并在防抖后落盘（未落盘的新工作区不写盘）。
 */
export function mutateWorkspace(updater: (workspace: OfflineWorkspace) => OfflineWorkspace): OfflineWorkspace {
  const draft = clone(getWorkspace());
  const next = updater(draft) ?? draft;

  currentWorkspace = { ...next, updated_at: new Date().toISOString() };
  notifyWorkspaceChanged();
  scheduleAutosave();

  return currentWorkspace;
}

/** 立即落盘（导出前、关闭前、切换模式前调用）。 */
export async function flushWorkspace(): Promise<void> {
  cancelAutosave();

  if (!currentWorkspace || !currentFilePath) {
    return;
  }

  const filePath = ensureWorkspaceFileName(currentFilePath);
  const savedPath = await tauriApi.saveWorkspace(filePath, serializeWorkspace(currentWorkspace));

  currentFilePath = savedPath;
}

/** 另存为指定路径，并把它设为当前文件。 */
export async function saveWorkspaceTo(filePath: string): Promise<string> {
  const workspace = getWorkspace();
  const savedPath = await tauriApi.saveWorkspace(ensureWorkspaceFileName(filePath), serializeWorkspace(workspace));

  currentFilePath = savedPath;
  notifyWorkspaceChanged();

  return savedPath;
}

export async function listWorkspaceFiles(): Promise<WorkspaceSummary[]> {
  const directory = await resolveWorkspaceDirectory();

  return tauriApi.listWorkspaces(directory);
}

export async function loadWorkspaceFile(filePath: string): Promise<OfflineWorkspace> {
  const content = await tauriApi.loadWorkspace(filePath);
  const workspace = parseWorkspace(content);

  return openWorkspace(workspace, filePath);
}

export async function deleteWorkspaceFile(filePath: string): Promise<void> {
  await tauriApi.deleteWorkspace(filePath);

  if (currentFilePath === filePath) {
    currentFilePath = null;
    notifyWorkspaceChanged();
  }
}

/**
 * 工作区目录：`<运行数据目录>/workspaces`。
 *
 * 目录由 Rust 侧 `RuntimePaths::workspaces_dir()` 计算并通过 `workspaces_dir` 下发，
 * 前端不重复拼接子目录名，避免两处硬编码漂移。
 */
export async function resolveWorkspaceDirectory(): Promise<string> {
  const paths = await tauriApi.getRuntimePaths();
  const directory = (paths.workspaces_dir ?? '').trim().replace(/[\\/]+$/, '');

  if (!directory) {
    throw new Error('未获取到离线工作区目录，请确认上位机后端与前端版本一致');
  }

  return directory;
}

function scheduleAutosave(): void {
  if (!currentFilePath) {
    return;
  }

  cancelAutosave();
  saveTimer = globalThis.setTimeout(() => {
    saveTimer = null;
    void flushWorkspace().catch((error: unknown) => {
      console.error('[离线工作区] 自动保存失败', error);
    });
  }, AUTOSAVE_DELAY_MS);
}

function cancelAutosave(): void {
  if (saveTimer !== null) {
    globalThis.clearTimeout(saveTimer);
    saveTimer = null;
  }
}

function notifyWorkspaceChanged(): void {
  for (const listener of workspaceListeners) {
    listener();
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
