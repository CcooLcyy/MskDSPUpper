import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../adapters';
import type { AppUpdateDownloadEvent, AppUpdateInfo, AppUpdateStatus } from '../../adapters';
import { AppUpdateContext } from './app-update-context';
import type { AppUpdateContextValue } from './app-update-context';

const initialUpdateStatus: AppUpdateStatus = {
  kind: 'idle',
  message: '尚未检查客户端更新',
};

function formatError(error: unknown): string {
  return String(error);
}

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const [appVersion, setAppVersion] = useState('-');
  const [availableUpdate, setAvailableUpdate] = useState<AppUpdateInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>(initialUpdateStatus);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const startupCheckStartedRef = useRef(false);
  const checkingPromiseRef = useRef<Promise<AppUpdateInfo | null> | null>(null);
  const installingPromiseRef = useRef<Promise<AppUpdateInfo> | null>(null);

  const checkForUpdate = useCallback(async () => {
    if (checkingPromiseRef.current) {
      return checkingPromiseRef.current;
    }

    const promise = (async () => {
      setIsCheckingUpdate(true);
      setDownloadedBytes(0);
      setTotalBytes(null);
      setUpdateStatus({ kind: 'checking', message: '正在检查客户端更新...' });

      try {
        const version = await api.getAppVersion();
        setAppVersion(version);

        const update = await api.checkAppUpdate();
        setAvailableUpdate(update);

        if (!update) {
          setUpdateStatus({ kind: 'up-to-date', message: '当前客户端已经是最新版本' });
          return null;
        }

        setUpdateStatus({
          kind: 'available',
          message: `发现新版本 ${update.version}，可以下载安装`,
        });
        return update;
      } catch (error) {
        setAvailableUpdate(null);
        setUpdateStatus({ kind: 'error', message: `检查更新失败: ${formatError(error)}` });
        throw error;
      } finally {
        setIsCheckingUpdate(false);
        checkingPromiseRef.current = null;
      }
    })();

    checkingPromiseRef.current = promise;
    return promise;
  }, []);

  const installUpdate = useCallback(async () => {
    if (installingPromiseRef.current) {
      return installingPromiseRef.current;
    }

    const promise = (async () => {
      setIsInstallingUpdate(true);
      setDownloadedBytes(0);
      setTotalBytes(null);
      setUpdateStatus({ kind: 'installing', message: '正在下载并安装客户端更新...' });

      try {
        const update = await api.downloadAndInstallAppUpdate((event: AppUpdateDownloadEvent) => {
          switch (event.event) {
            case 'Started':
              setTotalBytes(event.data.contentLength ?? null);
              setDownloadedBytes(0);
              setUpdateStatus({ kind: 'installing', message: '已开始下载更新包' });
              break;
            case 'Progress':
              setDownloadedBytes((previous) => previous + event.data.chunkLength);
              break;
            case 'Finished':
              setUpdateStatus({
                kind: 'installing',
                message: '更新包下载完成，正在安装',
              });
              break;
          }
        });

        setAvailableUpdate(update);
        setUpdateStatus({
          kind: 'ready-to-restart',
          message: `客户端 ${update.version} 已安装完成，如未自动重启，请手动重启应用`,
        });
        return update;
      } catch (error) {
        setUpdateStatus({ kind: 'error', message: `安装更新失败: ${formatError(error)}` });
        throw error;
      } finally {
        setIsInstallingUpdate(false);
        installingPromiseRef.current = null;
      }
    })();

    installingPromiseRef.current = promise;
    return promise;
  }, []);

  const relaunchAfterUpdate = useCallback(async () => {
    try {
      await api.relaunchApp();
    } catch (error) {
      setUpdateStatus({ kind: 'error', message: `重启客户端失败: ${formatError(error)}` });
      throw error;
    }
  }, []);

  useEffect(() => {
    if (startupCheckStartedRef.current) {
      return;
    }

    startupCheckStartedRef.current = true;
    void checkForUpdate().catch((error) => {
      console.warn('Failed to check app update on startup:', error);
    });
  }, [checkForUpdate]);

  useEffect(() => {
    return () => {
      void api.disposePendingAppUpdate();
    };
  }, []);

  const value = useMemo<AppUpdateContextValue>(
    () => ({
      appVersion,
      availableUpdate,
      updateStatus,
      isCheckingUpdate,
      isInstallingUpdate,
      downloadedBytes,
      totalBytes,
      hasAvailableUpdate: Boolean(availableUpdate),
      checkForUpdate,
      installUpdate,
      relaunchAfterUpdate,
    }),
    [
      appVersion,
      availableUpdate,
      checkForUpdate,
      downloadedBytes,
      installUpdate,
      isCheckingUpdate,
      isInstallingUpdate,
      relaunchAfterUpdate,
      totalBytes,
      updateStatus,
    ],
  );

  return <AppUpdateContext.Provider value={value}>{children}</AppUpdateContext.Provider>;
}
