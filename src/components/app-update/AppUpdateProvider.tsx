import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../adapters';
import type { AppUpdateDownloadEvent, AppUpdateInfo, AppUpdateStatus } from '../../adapters';
import { AppUpdateContext } from './app-update-context';
import type { AppUpdateCheckOptions, AppUpdateContextValue } from './app-update-context';

const UPDATE_CHECK_INTERVAL_MS = 30_000;
const APP_UPDATE_METADATA_KEY = 'mskdsp.app-update.pending.v1';

const initialUpdateStatus: AppUpdateStatus = { kind: 'idle', message: '尚未检查客户端更新' };

function formatError(error: unknown): string {
  return String(error);
}

function loadPersistedUpdate(): AppUpdateInfo | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(APP_UPDATE_METADATA_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AppUpdateInfo>;
    if (typeof value.version !== 'string' || typeof value.currentVersion !== 'string') {
      window.localStorage.removeItem(APP_UPDATE_METADATA_KEY);
      return null;
    }
    return {
      currentVersion: value.currentVersion,
      version: value.version,
      date: typeof value.date === 'string' ? value.date : undefined,
      body: typeof value.body === 'string' ? value.body : undefined,
      rawJson: value.rawJson && typeof value.rawJson === 'object' ? value.rawJson as Record<string, unknown> : {},
    };
  } catch {
    return null;
  }
}

function persistUpdate(update: AppUpdateInfo): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(APP_UPDATE_METADATA_KEY, JSON.stringify(update)); } catch { /* 可选元数据持久化失败不影响更新。 */ }
}

function clearPersistedUpdate(): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(APP_UPDATE_METADATA_KEY); } catch { /* 可选元数据清理失败不影响运行。 */ }
}

const persistedUpdate = loadPersistedUpdate();

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const [appVersion, setAppVersion] = useState('-');
  const [availableUpdate, setAvailableUpdate] = useState<AppUpdateInfo | null>(persistedUpdate);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>(
    persistedUpdate
      ? { kind: 'available', message: `发现待恢复的客户端更新 ${persistedUpdate.version}，正在重新下载` }
      : initialUpdateStatus,
  );
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isDownloadingUpdate, setIsDownloadingUpdate] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [isUpdateDownloaded, setIsUpdateDownloaded] = useState(false);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const startupCheckStartedRef = useRef(false);
  const checkingPromiseRef = useRef<Promise<AppUpdateInfo | null> | null>(null);
  const downloadingPromiseRef = useRef<Promise<AppUpdateInfo> | null>(null);
  const installingPromiseRef = useRef<Promise<AppUpdateInfo> | null>(null);
  const availableUpdateRef = useRef<AppUpdateInfo | null>(availableUpdate);
  const isDownloadingUpdateRef = useRef(false);
  const isUpdateDownloadedRef = useRef(false);
  const isInstallingUpdateRef = useRef(false);

  const downloadUpdate = useCallback(async (update?: AppUpdateInfo): Promise<AppUpdateInfo> => {
    if (downloadingPromiseRef.current) return downloadingPromiseRef.current;
    const target = update ?? availableUpdateRef.current;
    if (!target) throw new Error('当前没有可下载的客户端更新');
    const promise = (async () => {
      isDownloadingUpdateRef.current = true;
      setIsDownloadingUpdate(true);
      setIsUpdateDownloaded(false);
      isUpdateDownloadedRef.current = false;
      setDownloadedBytes(0);
      setTotalBytes(null);
      setUpdateStatus({ kind: 'downloading', message: `正在自动下载客户端 ${target.version}...` });
      try {
        const downloaded = await api.downloadAppUpdate((event: AppUpdateDownloadEvent) => {
          switch (event.event) {
            case 'Started':
              setTotalBytes(event.data.contentLength ?? null);
              setDownloadedBytes(0);
              setUpdateStatus({ kind: 'downloading', message: '已开始下载客户端更新包' });
              break;
            case 'Progress':
              setDownloadedBytes((previous) => previous + event.data.chunkLength);
              break;
            case 'Finished':
              setUpdateStatus({ kind: 'downloading', message: '客户端更新包下载完成，等待安装' });
              break;
          }
        });
        setAvailableUpdate(downloaded);
        availableUpdateRef.current = downloaded;
        setIsUpdateDownloaded(true);
        isUpdateDownloadedRef.current = true;
        persistUpdate(downloaded);
        setUpdateStatus({ kind: 'ready-to-install', message: `客户端 ${downloaded.version} 已下载完成，等待手动安装` });
        return downloaded;
      } catch (error) {
        setIsUpdateDownloaded(false);
        isUpdateDownloadedRef.current = false;
        setUpdateStatus({ kind: 'error', message: `下载客户端更新失败: ${formatError(error)}` });
        throw error;
      } finally {
        isDownloadingUpdateRef.current = false;
        setIsDownloadingUpdate(false);
        downloadingPromiseRef.current = null;
      }
    })();
    downloadingPromiseRef.current = promise;
    return promise;
  }, []);

  const checkForUpdate = useCallback(async (options: AppUpdateCheckOptions = {}) => {
    if (checkingPromiseRef.current) return checkingPromiseRef.current;
    const silent = options.silent === true;
    const promise = (async () => {
      let checkedUpdate: AppUpdateInfo | null = null;
      if (!silent) {
        setIsCheckingUpdate(true);
        setDownloadedBytes(0);
        setTotalBytes(null);
        setUpdateStatus({ kind: 'checking', message: '正在检查客户端更新...' });
      }
      try {
        setAppVersion(await api.getAppVersion());
        checkedUpdate = await api.checkAppUpdate();
        setAvailableUpdate(checkedUpdate);
        availableUpdateRef.current = checkedUpdate;
        setIsUpdateDownloaded(false);
        isUpdateDownloadedRef.current = false;
        if (!checkedUpdate) {
          clearPersistedUpdate();
          if (!silent) setUpdateStatus({ kind: 'up-to-date', message: '当前客户端已经是最新版本' });
          return null;
        }
        persistUpdate(checkedUpdate);
        await downloadUpdate(checkedUpdate);
        return checkedUpdate;
      } catch (error) {
        if (!checkedUpdate && !silent) {
          setUpdateStatus({ kind: 'error', message: `检查更新失败: ${formatError(error)}` });
        }
        throw error;
      } finally {
        if (!silent) setIsCheckingUpdate(false);
        checkingPromiseRef.current = null;
      }
    })();
    checkingPromiseRef.current = promise;
    return promise;
  }, [downloadUpdate]);

  useEffect(() => { availableUpdateRef.current = availableUpdate; }, [availableUpdate]);
  useEffect(() => { isInstallingUpdateRef.current = isInstallingUpdate; }, [isInstallingUpdate]);

  const installUpdate = useCallback(async () => {
    if (installingPromiseRef.current) return installingPromiseRef.current;
    if (!isUpdateDownloadedRef.current) return Promise.reject(new Error('客户端更新包尚未下载完成，请等待自动下载'));
    const promise = (async () => {
      isInstallingUpdateRef.current = true;
      setIsInstallingUpdate(true);
      setUpdateStatus({ kind: 'installing', message: '正在安装客户端更新...' });
      try {
        const update = await api.installAppUpdate();
        setAvailableUpdate(update);
        availableUpdateRef.current = update;
        setIsUpdateDownloaded(false);
        isUpdateDownloadedRef.current = false;
        clearPersistedUpdate();
        setUpdateStatus({ kind: 'ready-to-restart', message: `客户端 ${update.version} 已安装完成，如未自动重启，请手动重启应用` });
        return update;
      } catch (error) {
        setUpdateStatus({ kind: 'error', message: `安装客户端更新失败: ${formatError(error)}` });
        throw error;
      } finally {
        isInstallingUpdateRef.current = false;
        setIsInstallingUpdate(false);
        installingPromiseRef.current = null;
      }
    })();
    installingPromiseRef.current = promise;
    return promise;
  }, []);

  const relaunchAfterUpdate = useCallback(async () => {
    try { await api.relaunchApp(); } catch (error) {
      setUpdateStatus({ kind: 'error', message: `重启客户端失败: ${formatError(error)}` });
      throw error;
    }
  }, []);

  useEffect(() => {
    if (startupCheckStartedRef.current) return;
    startupCheckStartedRef.current = true;
    void checkForUpdate().catch((error) => { console.warn('客户端启动更新检查失败:', error); });
  }, [checkForUpdate]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (isUpdateDownloadedRef.current || isDownloadingUpdateRef.current || isInstallingUpdateRef.current) return;
      void checkForUpdate({ silent: true }).catch((error) => { console.warn('客户端后台更新检查失败:', error); });
    }, UPDATE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [checkForUpdate]);

  useEffect(() => () => { void api.disposePendingAppUpdate(); }, []);

  const value = useMemo<AppUpdateContextValue>(() => ({
    appVersion,
    availableUpdate,
    updateStatus,
    isCheckingUpdate,
    isDownloadingUpdate,
    isInstallingUpdate,
    isUpdateDownloaded,
    downloadedBytes,
    totalBytes,
    hasAvailableUpdate: Boolean(availableUpdate),
    checkForUpdate,
    installUpdate,
    relaunchAfterUpdate,
  }), [appVersion, availableUpdate, checkForUpdate, downloadedBytes, installUpdate, isCheckingUpdate,
    isDownloadingUpdate, isInstallingUpdate, isUpdateDownloaded, relaunchAfterUpdate, totalBytes, updateStatus]);

  return <AppUpdateContext.Provider value={value}>{children}</AppUpdateContext.Provider>;
}
