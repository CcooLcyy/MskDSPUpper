import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../adapters';
import type {
  LowerUpdateCachedPackage,
  LowerUpdateDownloadProgress,
  LowerUpdateManifest,
} from '../../adapters';

const LOWER_UPDATE_CHECK_INTERVAL_MS = 30_000;

export type LowerUpdateAutoStatusKind =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'cached'
  | 'error';

export interface LowerUpdateAutoStatus {
  kind: LowerUpdateAutoStatusKind;
  message: string;
  manifest: LowerUpdateManifest | null;
  cachedPackage: LowerUpdateCachedPackage | null;
  progress: LowerUpdateDownloadProgress | null;
  lastCheckedAt: number | null;
}

const initialStatus: LowerUpdateAutoStatus = {
  kind: 'idle',
  message: '尚未检查下位机更新',
  manifest: null,
  cachedPackage: null,
  progress: null,
  lastCheckedAt: null,
};

const LowerUpdateAutoContext = createContext<LowerUpdateAutoStatus>(initialStatus);

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

export function useLowerUpdateAuto(): LowerUpdateAutoStatus {
  return useContext(LowerUpdateAutoContext);
}

export function LowerUpdateAutoProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LowerUpdateAutoStatus>(initialStatus);
  const mountedRef = useRef(true);
  const runningPromiseRef = useRef<Promise<void> | null>(null);
  const downloadedManifestKeyRef = useRef<string | null>(null);

  const runCheckAndDownload = useCallback(async (): Promise<void> => {
    if (runningPromiseRef.current) {
      return runningPromiseRef.current;
    }

    const promise = (async () => {
      const checkedAt = Date.now();
      if (mountedRef.current) {
        setStatus((previous) => ({
          ...previous,
          kind: 'checking',
          message: '正在检查下位机更新...',
          progress: null,
        }));
      }

      try {
        const manifest = await api.checkLowerUpdate('stable');
        const manifestKey = cacheKey(manifest);

        const cachedPackages = await api.listCachedLowerUpdates('stable');
        const cachedPackage = cachedPackages.find((item) => matchesManifest(manifest, item)) ?? null;
        if (cachedPackage || downloadedManifestKeyRef.current === manifestKey) {
          if (mountedRef.current) {
            setStatus({
              kind: 'cached',
              message: `下位机 ${manifest.version} 已缓存到上位机，可手动下发`,
              manifest,
              cachedPackage,
              progress: null,
              lastCheckedAt: checkedAt,
            });
          }
          return;
        }

        if (mountedRef.current) {
          setStatus((previous) => ({
            ...previous,
            kind: 'available',
            message: `发现下位机新版本 ${manifest.version}，准备自动下载`,
            manifest,
            cachedPackage: null,
            progress: null,
            lastCheckedAt: checkedAt,
          }));
        }

        const result = await api.downloadLowerUpdate(manifest, (progress) => {
          if (mountedRef.current) {
            setStatus((previous) => ({
              ...previous,
              kind: 'downloading',
              message: `正在下载下位机 ${manifest.version}`,
              manifest,
              progress,
              lastCheckedAt: checkedAt,
            }));
          }
        });

        const downloadedPackage: LowerUpdateCachedPackage = {
          downloaded_at: Math.floor(Date.now() / 1000),
          manifest,
          package_path: result.package_path,
          package_size: result.downloaded_bytes,
          sha256: result.sha256,
        };
        downloadedManifestKeyRef.current = manifestKey;
        if (mountedRef.current) {
          setStatus({
            kind: 'cached',
            message: `下位机 ${manifest.version} 已缓存到上位机，可手动下发`,
            manifest,
            cachedPackage: downloadedPackage,
            progress: null,
            lastCheckedAt: checkedAt,
          });
        }
      } catch (error) {
        if (mountedRef.current) {
          setStatus((previous) => ({
            ...previous,
            kind: 'error',
            message: `下位机自动更新失败: ${String(error)}`,
            progress: null,
            lastCheckedAt: checkedAt,
          }));
        }
      } finally {
        runningPromiseRef.current = null;
      }
    })();

    runningPromiseRef.current = promise;
    return promise;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void runCheckAndDownload();

    const timer = window.setInterval(() => {
      void runCheckAndDownload();
    }, LOWER_UPDATE_CHECK_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [runCheckAndDownload]);

  const contextValue = useMemo(() => status, [status]);
  return (
    <LowerUpdateAutoContext.Provider value={contextValue}>
      {children}
    </LowerUpdateAutoContext.Provider>
  );
}
