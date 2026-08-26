import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../adapters';
import type {
  LowerUpdateCachedPackage,
  LowerUpdateChannel,
  LowerUpdateManifest,
} from '../../adapters';
import {
  initialLowerUpdateAutoStatus,
  LowerUpdateAutoContext,
} from './lower-update-auto-context';
import type { LowerUpdateAutoStatus } from './lower-update-auto-context';

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

export function LowerUpdateAutoProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LowerUpdateAutoStatus>(initialLowerUpdateAutoStatus);
  const mountedRef = useRef(true);
  const runningPromiseRef = useRef<Partial<Record<LowerUpdateChannel, Promise<void>>>>({});
  const downloadedManifestKeyRef = useRef<Partial<Record<LowerUpdateChannel, string>>>({});

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

  const runChannelCheckAndDownload = useCallback(async (channel: LowerUpdateChannel): Promise<void> => {
    const runningPromise = runningPromiseRef.current[channel];
    if (runningPromise) {
      return runningPromise;
    }

    const promise = (async () => {
      const checkedAt = Date.now();
      updateChannelStatus(channel, {
        kind: 'checking',
        message: `正在检查下位机 ${channel} 通道更新...`,
        progress: null,
      });

      try {
        const manifest = await api.checkLowerUpdate(channel);
        const manifestKey = cacheKey(manifest);

        const cachedPackages = await api.listCachedLowerUpdates(channel);
        const cachedPackage = cachedPackages.find((item) => matchesManifest(manifest, item)) ?? null;
        if (cachedPackage || downloadedManifestKeyRef.current[channel] === manifestKey) {
          updateChannelStatus(channel, {
            kind: 'cached',
            message: `下位机 ${channel} 通道 ${manifest.version} 已缓存到上位机，可手动下发`,
            manifest,
            cachedPackage,
            progress: null,
            lastCheckedAt: checkedAt,
          });
          return;
        }

        updateChannelStatus(channel, {
          kind: 'available',
          message: `发现下位机 ${channel} 通道新版本 ${manifest.version}，准备自动下载`,
          manifest,
          cachedPackage: null,
          progress: null,
          lastCheckedAt: checkedAt,
        });

        const result = await api.downloadLowerUpdate(manifest, (progress) => {
          updateChannelStatus(channel, {
            kind: 'downloading',
            message: `正在下载下位机 ${channel} 通道 ${manifest.version}`,
            manifest,
            progress,
            lastCheckedAt: checkedAt,
          });
        });

        const downloadedPackage: LowerUpdateCachedPackage = {
          downloaded_at: Math.floor(Date.now() / 1000),
          manifest,
          package_path: result.package_path,
          package_size: result.downloaded_bytes,
          sha256: result.sha256,
        };
        downloadedManifestKeyRef.current[channel] = manifestKey;
        updateChannelStatus(channel, {
          kind: 'cached',
          message: `下位机 ${channel} 通道 ${manifest.version} 已缓存到上位机，可手动下发`,
          manifest,
          cachedPackage: downloadedPackage,
          progress: null,
          lastCheckedAt: checkedAt,
        });
      } catch (error) {
        updateChannelStatus(channel, {
          kind: 'error',
          message: `下位机 ${channel} 通道自动更新失败: ${String(error)}`,
          progress: null,
          lastCheckedAt: checkedAt,
        });
      } finally {
        delete runningPromiseRef.current[channel];
      }
    })();

    runningPromiseRef.current[channel] = promise;
    return promise;
  }, [updateChannelStatus]);

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

  const contextValue = useMemo(() => status, [status]);
  return (
    <LowerUpdateAutoContext.Provider value={contextValue}>
      {children}
    </LowerUpdateAutoContext.Provider>
  );
}
