import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../adapters';
import type {
  LowerUpdateCachedPackage,
  LowerUpdateChannel,
  LowerUpdateDownloadResult,
  LowerUpdateManifest,
} from '../../adapters';
import {
  initialLowerUpdateAutoStatus,
  LowerUpdateAutoContext,
} from './lower-update-auto-context';
import type {
  LowerUpdateAutoContextValue,
  LowerUpdateAutoStatus,
} from './lower-update-auto-context';

const LOWER_UPDATE_CHECK_INTERVAL_MS = 30_000;
const LOWER_UPDATE_CHANNELS: LowerUpdateChannel[] = ['stable', 'beta', 'nightly', 'ci'];

function cacheKey(manifest: LowerUpdateManifest): string {
  return [
    manifest.channel,
    manifest.platform,
    manifest.version,
    manifest.image_id?.trim().toLowerCase() ?? '',
    manifest.asset.name,
    manifest.asset.size,
    manifest.asset.sha256,
  ]
    .join(':')
    .toLowerCase();
}

function matchesManifest(
  manifest: LowerUpdateManifest,
  cachedPackage: LowerUpdateCachedPackage,
): boolean {
  return cacheKey(manifest) === cacheKey(cachedPackage.manifest)
    && cachedPackage.sha256.toLowerCase() === manifest.asset.sha256.toLowerCase()
    && cachedPackage.package_size === manifest.asset.size;
}

function resultFromCachedPackage(cachedPackage: LowerUpdateCachedPackage): LowerUpdateDownloadResult {
  return {
    package_name: cachedPackage.manifest.asset.name,
    package_path: cachedPackage.package_path,
    downloaded_bytes: cachedPackage.package_size,
    sha256: cachedPackage.sha256,
  };
}

function cachedPackageFromResult(
  manifest: LowerUpdateManifest,
  result: LowerUpdateDownloadResult,
): LowerUpdateCachedPackage {
  return {
    downloaded_at: Math.floor(Date.now() / 1000),
    manifest,
    package_path: result.package_path,
    package_size: result.downloaded_bytes,
    sha256: result.sha256,
  };
}

export function LowerUpdateAutoProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LowerUpdateAutoStatus>(initialLowerUpdateAutoStatus);
  const mountedRef = useRef(true);
  const runningPromiseRef = useRef<Partial<Record<LowerUpdateChannel, Promise<void>>>>({});
  const downloadTasksRef = useRef(new Map<string, Promise<LowerUpdateDownloadResult>>());
  const activeChannelDownloadRef = useRef<Partial<Record<LowerUpdateChannel, Promise<LowerUpdateDownloadResult>>>>({});

  const updateChannelStatus = useCallback(
    (channel: LowerUpdateChannel, next: Partial<LowerUpdateAutoStatus['channels'][LowerUpdateChannel]>) => {
      if (!mountedRef.current) {
        return;
      }
      setStatus((previous) => ({
        channels: {
          ...previous.channels,
          [channel]: {
            ...previous.channels[channel],
            ...next,
          },
        },
      }));
    },
    [],
  );

  const ensureDownloaded = useCallback((manifest: LowerUpdateManifest): Promise<LowerUpdateDownloadResult> => {
    const manifestKey = cacheKey(manifest);
    const runningTask = downloadTasksRef.current.get(manifestKey);
    if (runningTask) {
      return runningTask;
    }

    const channel = manifest.channel;
    const activeChannelTask = activeChannelDownloadRef.current[channel];
    if (activeChannelTask) {
      return activeChannelTask
        .catch(() => undefined)
        .then(() => ensureDownloaded(manifest));
    }
    const checkedAt = Date.now();
    updateChannelStatus(channel, {
      kind: 'downloading',
      message: `正在准备下位机 ${channel} 通道 ${manifest.version} 下载`,
      manifest,
      cachedPackage: null,
      downloadResult: null,
      progress: null,
      lastCheckedAt: checkedAt,
    });
    // Keep an identity holder so stale tasks cannot delete a newer task.
    const taskRef: { promise?: Promise<LowerUpdateDownloadResult> } = {};
    const taskPromise = (async () => {
      try {
        const cachedPackages = await api.listCachedLowerUpdates(channel);
        const cachedPackage = cachedPackages.find((item) => matchesManifest(manifest, item)) ?? null;
        if (cachedPackage) {
          const result = resultFromCachedPackage(cachedPackage);
          updateChannelStatus(channel, {
            kind: 'cached',
            message: `下位机 ${channel} 通道 ${manifest.version} 已缓存到上位机，可手动下发`,
            manifest,
            cachedPackage,
            downloadResult: result,
            progress: null,
            lastCheckedAt: checkedAt,
          });
          return result;
        }

        const result = await api.downloadLowerUpdate(manifest, (progress) => {
          updateChannelStatus(channel, {
            kind: 'downloading',
            message: `正在下载下位机 ${channel} 通道 ${manifest.version}`,
            manifest,
            progress,
            lastCheckedAt: checkedAt,
          });
        });
        const downloadedPackage = cachedPackageFromResult(manifest, result);
        updateChannelStatus(channel, {
          kind: 'cached',
          message: `下位机 ${channel} 通道 ${manifest.version} 已缓存到上位机，可手动下发`,
          manifest,
          cachedPackage: downloadedPackage,
          downloadResult: result,
          progress: null,
          lastCheckedAt: checkedAt,
        });
        return result;
      } catch (error) {
        updateChannelStatus(channel, {
          kind: 'error',
          message: `下位机 ${channel} 通道下载失败: ${String(error)}`,
          manifest,
          progress: null,
          lastCheckedAt: checkedAt,
        });
        throw error;
      } finally {
        if (downloadTasksRef.current.get(manifestKey) === taskRef.promise) {
          downloadTasksRef.current.delete(manifestKey);
        }
        if (activeChannelDownloadRef.current[channel] === taskRef.promise) {
          delete activeChannelDownloadRef.current[channel];
        }
      }
    })();
    taskRef.promise = taskPromise;

    // Register before returning so automatic and manual callers share this task.
    downloadTasksRef.current.set(manifestKey, taskPromise);
    activeChannelDownloadRef.current[channel] = taskPromise;
    return taskPromise;
  }, [updateChannelStatus]);

  const runChannelCheckAndDownload = useCallback(async (channel: LowerUpdateChannel): Promise<void> => {
    const activeDownload = activeChannelDownloadRef.current[channel];
    if (activeDownload) {
      await activeDownload.catch(() => undefined);
      return;
    }
    const runningPromise = runningPromiseRef.current[channel];
    if (runningPromise) {
      return runningPromise;
    }

    // Keep an identity holder so stale checks cannot delete a newer check.
    const promiseRef: { promise?: Promise<void> } = {};
    const promise = (async () => {
      const checkedAt = Date.now();
      updateChannelStatus(channel, {
        kind: 'checking',
        message: `正在检查下位机 ${channel} 通道更新...`,
        progress: null,
      });

      try {
        const manifest = await api.checkLowerUpdate(channel);
        const cachedPackages = await api.listCachedLowerUpdates(channel);
        const cachedPackage = cachedPackages.find((item) => matchesManifest(manifest, item)) ?? null;
        if (cachedPackage) {
          const result = resultFromCachedPackage(cachedPackage);
          updateChannelStatus(channel, {
            kind: 'cached',
            message: `下位机 ${channel} 通道 ${manifest.version} 已缓存到上位机，可手动下发`,
            manifest,
            cachedPackage,
            downloadResult: result,
            progress: null,
            lastCheckedAt: checkedAt,
          });
          return;
        }

        const newlyActiveDownload = activeChannelDownloadRef.current[channel];
        if (newlyActiveDownload) {
          await newlyActiveDownload;
          return;
        }

        updateChannelStatus(channel, {
          kind: 'available',
          message: `发现下位机 ${channel} 通道新版本 ${manifest.version}，准备自动下载`,
          manifest,
          cachedPackage: null,
          downloadResult: null,
          progress: null,
          lastCheckedAt: checkedAt,
        });
        await ensureDownloaded(manifest);
      } catch (error) {
        updateChannelStatus(channel, {
          kind: 'error',
          message: `下位机 ${channel} 通道自动更新失败: ${String(error)}`,
          progress: null,
          lastCheckedAt: checkedAt,
        });
      } finally {
        if (runningPromiseRef.current[channel] === promiseRef.promise) {
          delete runningPromiseRef.current[channel];
        }
      }
    })();
    promiseRef.promise = promise;

    runningPromiseRef.current[channel] = promise;
    return promise;
  }, [ensureDownloaded, updateChannelStatus]);

  const runAllChannels = useCallback(async (): Promise<void> => {
    await Promise.all(LOWER_UPDATE_CHANNELS.map((channel) => runChannelCheckAndDownload(channel)));
  }, [runChannelCheckAndDownload]);

  useEffect(() => {
    mountedRef.current = true;
    void runAllChannels();

    const timer = window.setInterval(() => {
      void runAllChannels();
    }, LOWER_UPDATE_CHECK_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [runAllChannels]);

  const contextValue = useMemo<LowerUpdateAutoContextValue>(
    () => ({ ...status, ensureDownloaded }),
    [ensureDownloaded, status],
  );
  return (
    <LowerUpdateAutoContext.Provider value={contextValue}>
      {children}
    </LowerUpdateAutoContext.Provider>
  );
}
