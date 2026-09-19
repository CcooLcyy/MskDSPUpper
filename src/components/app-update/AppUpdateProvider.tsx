import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../adapters';
import type { AppUpdateDownloadEvent, AppUpdateInfo, AppUpdateStatus } from '../../adapters';
import { AppUpdateContext } from './app-update-context';
import type {
  AppUpdateCheckOptions,
  AppUpdateContextValue,
  AppUpdateInstallResult,
} from './app-update-context';

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
  const [downloadedUpdate, setDownloadedUpdate] = useState<AppUpdateInfo | null>(null);
  const [supersededUpdate, setSupersededUpdate] = useState<AppUpdateInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>(
    persistedUpdate
      ? { kind: 'available', message: `发现待恢复的客户端更新 ${persistedUpdate.version}，正在重新下载` }
      : initialUpdateStatus,
  );
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isDownloadingUpdate, setIsDownloadingUpdate] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const startupCheckStartedRef = useRef(false);
  const checkingPromiseRef = useRef<Promise<AppUpdateInfo | null> | null>(null);
  const downloadingPromiseRef = useRef<Promise<AppUpdateInfo> | null>(null);
  const installingPromiseRef = useRef<Promise<AppUpdateInstallResult> | null>(null);
  const availableUpdateRef = useRef<AppUpdateInfo | null>(availableUpdate);
  const downloadedUpdateRef = useRef<AppUpdateInfo | null>(null);
  const supersededUpdateRef = useRef<AppUpdateInfo | null>(null);
  const isDownloadingUpdateRef = useRef(false);
  const isInstallingUpdateRef = useRef(false);

  const downloadUpdate = useCallback(async (
    update?: AppUpdateInfo,
    replacingVersion?: string,
  ): Promise<AppUpdateInfo> => {
    if (downloadingPromiseRef.current) return downloadingPromiseRef.current;
    const target = update ?? availableUpdateRef.current ?? downloadedUpdateRef.current;
    if (!target) throw new Error('当前没有可下载的客户端更新');
    const promise = (async () => {
      isDownloadingUpdateRef.current = true;
      setIsDownloadingUpdate(true);
      setDownloadedBytes(0);
      setTotalBytes(null);
      setUpdateStatus({
        kind: 'downloading',
        message: replacingVersion
          ? `发现客户端 ${target.version}，正在替换已下载的客户端 ${replacingVersion}`
          : `正在下载客户端 ${target.version}...`,
      });
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
        setDownloadedUpdate(downloaded);
        downloadedUpdateRef.current = downloaded;
        setAvailableUpdate(downloaded);
        availableUpdateRef.current = downloaded;
        setSupersededUpdate(null);
        supersededUpdateRef.current = null;
        persistUpdate(downloaded);
        setUpdateStatus({ kind: 'ready-to-install', message: `客户端 ${downloaded.version} 已下载完成，等待手动安装` });
        return downloaded;
      } catch (error) {
        // 先下后丢：新包下载失败时旧包仍在，下一轮 30 秒检查会继续重试。
        const preserved = downloadedUpdateRef.current;
        setUpdateStatus({
          kind: 'error',
          message: preserved
            ? `下载客户端 ${target.version} 失败，已保留已下载的客户端 ${preserved.version}，将于下一轮重试: ${formatError(error)}`
            : `下载客户端更新失败: ${formatError(error)}`,
        });
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
        const version = await api.getAppVersion();
        setAppVersion(version);

        // 已经运行到持久化记录的版本时该元数据已失效（Windows 上安装成功后进程被安装器接管退出，
        // 清理逻辑可能来不及执行），直接丢弃，避免下次启动显示待恢复的旧更新。
        const persisted = loadPersistedUpdate();
        if (persisted && persisted.version === version) {
          clearPersistedUpdate();
        }

        checkedUpdate = await api.checkAppUpdate();
        setAvailableUpdate(checkedUpdate);
        availableUpdateRef.current = checkedUpdate;
        const downloaded = downloadedUpdateRef.current;

        if (!checkedUpdate) {
          // 通道没有再给出更新版本：已下载的待安装包必须保留，丢了就一份可安装的都没有了。
          clearPersistedUpdate();
          if (downloaded) {
            setUpdateStatus({ kind: 'ready-to-install', message: `通道当前没有更新版本，已保留已下载的客户端 ${downloaded.version}，仍可安装` });
            return null;
          }
          if (!silent) setUpdateStatus({ kind: 'up-to-date', message: '当前客户端已经是最新版本' });
          return null;
        }

        if (downloaded && downloaded.version === checkedUpdate.version) {
          // 版本一致：复用已下载的包，只刷新清单元数据，不重复下载。
          const latest = checkedUpdate;
          setAvailableUpdate(latest);
          availableUpdateRef.current = latest;
          setSupersededUpdate(null);
          supersededUpdateRef.current = null;
          persistUpdate(latest);
          setUpdateStatus({ kind: 'ready-to-install', message: `客户端 ${downloaded.version} 已下载完成，等待手动安装` });
          return latest;
        }

        // 版本不同：先下载新包，成功后再由适配器释放旧包。
        persistUpdate(checkedUpdate);
        await downloadUpdate(checkedUpdate, downloaded?.version);
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
  useEffect(() => { downloadedUpdateRef.current = downloadedUpdate; }, [downloadedUpdate]);
  useEffect(() => { supersededUpdateRef.current = supersededUpdate; }, [supersededUpdate]);

  const performInstall = useCallback(async (): Promise<AppUpdateInstallResult> => {
    setSupersededUpdate(null);
    supersededUpdateRef.current = null;
    setUpdateStatus({ kind: 'installing', message: '正在安装客户端更新...' });
    const update = await api.installAppUpdate();
    setDownloadedUpdate(null);
    downloadedUpdateRef.current = null;
    clearPersistedUpdate();
    setUpdateStatus({ kind: 'ready-to-restart', message: `客户端 ${update.version} 已安装完成，如未自动重启，请手动重启应用` });
    return { kind: 'installed', update };
  }, []);

  const runInstallFlow = useCallback(
    (flow: () => Promise<AppUpdateInstallResult>): Promise<AppUpdateInstallResult> => {
      if (installingPromiseRef.current) return installingPromiseRef.current;
      const promise = (async () => {
        isInstallingUpdateRef.current = true;
        setIsInstallingUpdate(true);
        try {
          return await flow();
        } catch (error) {
          // 下载流程已写入更具体的失败原因时保留它，避免被这里的通用文案覆盖。
          setUpdateStatus((previous) => previous.kind === 'error'
            ? previous
            : { kind: 'error', message: `安装客户端更新失败: ${formatError(error)}` });
          throw error;
        } finally {
          isInstallingUpdateRef.current = false;
          setIsInstallingUpdate(false);
          installingPromiseRef.current = null;
        }
      })();
      installingPromiseRef.current = promise;
      return promise;
    },
    [],
  );

  const installUpdate = useCallback(
    () => runInstallFlow(async () => {
      // 后台检查可能正在进行，先等它结束，避免两处并发访问同一份 updater 资源。
      if (checkingPromiseRef.current) {
        await checkingPromiseRef.current.catch(() => undefined);
      }

      const downloaded = downloadedUpdateRef.current;
      if (!downloaded) throw new Error('客户端更新包尚未下载完成，请等待自动下载');

      // 安装前的最终检查：避免刚装完就又被提示另一个更新版本。
      setUpdateStatus({ kind: 'checking', message: '正在确认通道是否已有更新的版本...' });
      let latest: AppUpdateInfo | null = null;
      try {
        latest = await api.checkAppUpdate();
        setAvailableUpdate(latest);
        availableUpdateRef.current = latest;
      } catch (error) {
        // 最终检查失败不阻塞安装，按已下载的版本继续。
        console.warn('安装前检查客户端更新失败，将直接安装已下载的版本:', error);
        return performInstall();
      }

      if (latest && latest.version !== downloaded.version) {
        persistUpdate(latest);
        setSupersededUpdate(latest);
        supersededUpdateRef.current = latest;
        setUpdateStatus({ kind: 'ready-to-install', message: `已下载 ${downloaded.version}，通道已有 ${latest.version}，请选择要安装的版本` });
        return { kind: 'needs-choice', downloaded, latest } as AppUpdateInstallResult;
      }

      return performInstall();
    }),
    [performInstall, runInstallFlow],
  );

  const installDownloadedUpdate = useCallback(
    () => runInstallFlow(() => performInstall()),
    [performInstall, runInstallFlow],
  );

  const acceptLatestUpdate = useCallback(
    () => runInstallFlow(async () => {
      const latest = supersededUpdateRef.current ?? availableUpdateRef.current;
      if (!latest) throw new Error('通道当前没有可用的客户端更新版本');
      await downloadUpdate(latest, downloadedUpdateRef.current?.version);
      return performInstall();
    }),
    [downloadUpdate, performInstall, runInstallFlow],
  );

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
      // 已下载的待安装包不再冻结后台检查：仍要发现通道后续发布的版本；
      // 只有正在下载或安装时才跳过本轮，避免并发任务。
      if (isDownloadingUpdateRef.current || isInstallingUpdateRef.current) return;
      void checkForUpdate({ silent: true }).catch((error) => { console.warn('客户端后台更新检查失败:', error); });
    }, UPDATE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [checkForUpdate]);

  useEffect(() => () => { void api.disposePendingAppUpdate(); }, []);

  const value = useMemo<AppUpdateContextValue>(() => ({
    appVersion,
    availableUpdate,
    downloadedUpdate,
    downloadedVersion: downloadedUpdate?.version ?? null,
    supersededUpdate,
    updateStatus,
    isCheckingUpdate,
    isDownloadingUpdate,
    isInstallingUpdate,
    isUpdateDownloaded: downloadedUpdate !== null,
    downloadedBytes,
    totalBytes,
    hasAvailableUpdate: Boolean(availableUpdate) || downloadedUpdate !== null,
    checkForUpdate,
    installUpdate,
    installDownloadedUpdate,
    acceptLatestUpdate,
    relaunchAfterUpdate,
  }), [acceptLatestUpdate, appVersion, availableUpdate, checkForUpdate, downloadedBytes, downloadedUpdate,
    installDownloadedUpdate, installUpdate, isCheckingUpdate, isDownloadingUpdate, isInstallingUpdate,
    relaunchAfterUpdate, supersededUpdate, totalBytes, updateStatus]);

  return <AppUpdateContext.Provider value={value}>{children}</AppUpdateContext.Provider>;
}
