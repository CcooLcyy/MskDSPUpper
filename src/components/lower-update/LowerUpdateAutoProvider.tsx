import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../adapters';
import type {
  LowerUpdateCachedPackage,
  LowerUpdateChannel,
  LowerUpdateDownloadResult,
  LowerUpdateManifest,
  LowerUpdatePlatform,
} from '../../adapters';
import {
  initialLowerUpdateAutoStatus,
  LowerUpdateAutoContext,
} from './lower-update-auto-context';
import { assertLowerUpdateManifest, getLowerUpdateChannels } from '../../utils/lower-update-platform';
import type {
  LowerUpdateAutoContextValue,
  LowerUpdateAutoStatus,
} from './lower-update-auto-context';

const LOWER_UPDATE_CHECK_INTERVAL_MS = 30_000;

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
  const [platform, updatePlatform] = useState<LowerUpdatePlatform>('linux-arm64');
  const [statuses, setStatuses] = useState<Record<LowerUpdatePlatform, LowerUpdateAutoStatus>>({
    'linux-arm64': initialLowerUpdateAutoStatus,
    'linux-x64': initialLowerUpdateAutoStatus,
  });
  const mountedRef = useRef(true);
  const runningPromiseRef = useRef<Partial<Record<string, Promise<void>>>>({});
  const downloadTasksRef = useRef(new Map<string, Promise<LowerUpdateDownloadResult>>());
  const activeChannelDownloadRef = useRef<Partial<Record<string, Promise<LowerUpdateDownloadResult>>>>({});

  const setPlatform = useCallback((next: LowerUpdatePlatform) => {
    getLowerUpdateChannels(next);
    console.info('切换下位机自动更新架构', { platform: next });
    updatePlatform(next);
  }, []);

  const updateChannelStatus = useCallback(
    (platform: LowerUpdatePlatform, channel: LowerUpdateChannel, next: Partial<LowerUpdateAutoStatus['channels'][LowerUpdateChannel]>) => {
      if (!mountedRef.current) {
        return;
      }
      setStatuses((previous) => ({
        ...previous,
        [platform]: {
          channels: {
            ...previous[platform].channels,
            [channel]: {
              ...previous[platform].channels[channel],
              ...next,
            },
          },
        },
      }));
    },
    [],
  );

  const ensureDownloaded = useCallback((manifest: LowerUpdateManifest): Promise<LowerUpdateDownloadResult> => {
    const platform = manifest.platform as LowerUpdatePlatform;
    assertLowerUpdateManifest(manifest, platform, manifest.channel);
    const manifestKey = cacheKey(manifest);
    const runningTask = downloadTasksRef.current.get(manifestKey);
    if (runningTask) {
      return runningTask;
    }

    const channel = manifest.channel;
    const channelKey = `${platform}:${channel}`;
    const activeChannelTask = activeChannelDownloadRef.current[channelKey];
    if (activeChannelTask) {
      return activeChannelTask
        .catch(() => undefined)
        .then(() => ensureDownloaded(manifest));
    }
    const checkedAt = Date.now();
    updateChannelStatus(platform, channel, {
      kind: 'downloading',
      message: `正在准备下位机 ${channel} 通道 ${manifest.version} 下载`,
      manifest,
      cachedPackage: null,
      downloadResult: null,
      progress: null,
      lastCheckedAt: checkedAt,
    });
    // 保留任务标识，防止旧下载结束时删除后续任务。
    const taskRef: { promise?: Promise<LowerUpdateDownloadResult> } = {};
    const taskPromise = (async () => {
      try {
        const cachedPackages = await api.listCachedLowerUpdates(channel, platform);
        const cachedPackage = cachedPackages.find((item) => matchesManifest(manifest, item)) ?? null;
        if (cachedPackage) {
          const result = resultFromCachedPackage(cachedPackage);
          updateChannelStatus(platform, channel, {
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
          updateChannelStatus(platform, channel, {
            kind: 'downloading',
            message: `正在下载下位机 ${channel} 通道 ${manifest.version}`,
            manifest,
            progress,
            lastCheckedAt: checkedAt,
          });
        });
        const downloadedPackage = cachedPackageFromResult(manifest, result);
        updateChannelStatus(platform, channel, {
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
        updateChannelStatus(platform, channel, {
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
        if (activeChannelDownloadRef.current[channelKey] === taskRef.promise) {
          delete activeChannelDownloadRef.current[channelKey];
        }
      }
    })();
    taskRef.promise = taskPromise;

    // 返回前注册任务，让自动与手动下载复用同一请求。
    downloadTasksRef.current.set(manifestKey, taskPromise);
    activeChannelDownloadRef.current[channelKey] = taskPromise;
    return taskPromise;
  }, [updateChannelStatus]);

  const runChannelCheckAndDownload = useCallback(async (platform: LowerUpdatePlatform, channel: LowerUpdateChannel): Promise<void> => {
    const channelKey = `${platform}:${channel}`;
    const activeDownload = activeChannelDownloadRef.current[channelKey];
    if (activeDownload) {
      await activeDownload.catch(() => undefined);
      return;
    }
    const runningPromise = runningPromiseRef.current[channelKey];
    if (runningPromise) {
      return runningPromise;
    }

    // 保留检查标识，防止旧检查结束时删除后续任务。
    const promiseRef: { promise?: Promise<void> } = {};
    const promise = (async () => {
      const checkedAt = Date.now();
      updateChannelStatus(platform, channel, {
        kind: 'checking',
        message: `正在检查下位机 ${channel} 通道更新...`,
        progress: null,
      });

      try {
        const manifest = await api.checkLowerUpdate(channel, platform);
        assertLowerUpdateManifest(manifest, platform, channel);
        const cachedPackages = await api.listCachedLowerUpdates(channel, platform);
        const cachedPackage = cachedPackages.find((item) => matchesManifest(manifest, item)) ?? null;
        if (cachedPackage) {
          const result = resultFromCachedPackage(cachedPackage);
          updateChannelStatus(platform, channel, {
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

        const newlyActiveDownload = activeChannelDownloadRef.current[channelKey];
        if (newlyActiveDownload) {
          await newlyActiveDownload;
          return;
        }

        updateChannelStatus(platform, channel, {
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
        updateChannelStatus(platform, channel, {
          kind: 'error',
          message: `下位机 ${channel} 通道自动更新失败: ${String(error)}`,
          progress: null,
          lastCheckedAt: checkedAt,
        });
      } finally {
        if (runningPromiseRef.current[channelKey] === promiseRef.promise) {
          delete runningPromiseRef.current[channelKey];
        }
      }
    })();
    promiseRef.promise = promise;

    runningPromiseRef.current[channelKey] = promise;
    return promise;
  }, [ensureDownloaded, updateChannelStatus]);

  const runAllChannels = useCallback(async (): Promise<void> => {
    await Promise.all(getLowerUpdateChannels(platform).map((channel) => runChannelCheckAndDownload(platform, channel)));
  }, [platform, runChannelCheckAndDownload]);

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
    () => ({ ...statuses[platform], platform, setPlatform, ensureDownloaded }),
    [ensureDownloaded, statuses, platform, setPlatform],
  );
  return (
    <LowerUpdateAutoContext.Provider value={contextValue}>
      {children}
    </LowerUpdateAutoContext.Provider>
  );
}
