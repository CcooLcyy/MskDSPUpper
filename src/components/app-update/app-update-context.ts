import { createContext, useContext } from 'react';
import type { AppUpdateInfo, AppUpdateStatus } from '../../adapters';

export interface AppUpdateCheckOptions {
  silent?: boolean;
}

/**
 * 安装动作的结果。
 *
 * `needs-choice`：安装前的最终检查发现通道已有与已下载包不同的版本，
 * 此时不自动安装，由用户在“仍安装已下载的包”和“改为安装通道最新版本”之间选择。
 */
export type AppUpdateInstallResult =
  | { kind: 'installed'; update: AppUpdateInfo }
  | { kind: 'needs-choice'; downloaded: AppUpdateInfo; latest: AppUpdateInfo };

export interface AppUpdateContextValue {
  appVersion: string;
  /** 通道最近一次检查给出的可用版本。 */
  availableUpdate: AppUpdateInfo | null;
  /** 当前进程中已下载、等待安装的那一份包（同一时刻最多一份）。 */
  downloadedUpdate: AppUpdateInfo | null;
  /** 已下载包的版本号，未下载完成时为 null。 */
  downloadedVersion: string | null;
  /** 已下载包之后通道又发布的版本，仅在安装前最终检查发现时出现。 */
  supersededUpdate: AppUpdateInfo | null;
  updateStatus: AppUpdateStatus;
  isCheckingUpdate: boolean;
  isDownloadingUpdate: boolean;
  isInstallingUpdate: boolean;
  isUpdateDownloaded: boolean;
  downloadedBytes: number;
  totalBytes: number | null;
  hasAvailableUpdate: boolean;
  checkForUpdate: (options?: AppUpdateCheckOptions) => Promise<AppUpdateInfo | null>;
  /** 安装前先做一次最终检查；发现不同版本时返回 `needs-choice`，不自动安装。 */
  installUpdate: () => Promise<AppUpdateInstallResult>;
  /** 跳过最终检查，直接安装已下载的那一份包。 */
  installDownloadedUpdate: () => Promise<AppUpdateInstallResult>;
  /** 改为下载并安装通道里最新的版本（先下后丢）。 */
  acceptLatestUpdate: () => Promise<AppUpdateInstallResult>;
  relaunchAfterUpdate: () => Promise<void>;
}

export const AppUpdateContext = createContext<AppUpdateContextValue | null>(null);

export function useAppUpdate() {
  const context = useContext(AppUpdateContext);

  if (!context) {
    throw new Error('useAppUpdate must be used within AppUpdateProvider');
  }

  return context;
}
