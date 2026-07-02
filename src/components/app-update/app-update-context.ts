import { createContext, useContext } from 'react';
import type { AppUpdateInfo, AppUpdateStatus } from '../../adapters';

export interface AppUpdateContextValue {
  appVersion: string;
  availableUpdate: AppUpdateInfo | null;
  updateStatus: AppUpdateStatus;
  isCheckingUpdate: boolean;
  isInstallingUpdate: boolean;
  downloadedBytes: number;
  totalBytes: number | null;
  hasAvailableUpdate: boolean;
  checkForUpdate: () => Promise<AppUpdateInfo | null>;
  installUpdate: () => Promise<AppUpdateInfo>;
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
