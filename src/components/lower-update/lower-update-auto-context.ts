import { createContext, useContext } from 'react';
import type {
  LowerUpdateCachedPackage,
  LowerUpdateDownloadResult,
  LowerUpdateDownloadProgress,
  LowerUpdateManifest,
  LowerUpdateChannel,
} from '../../adapters';

export type LowerUpdateAutoStatusKind =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'cached'
  | 'error';

export interface LowerUpdateAutoChannelStatus {
  channel: LowerUpdateChannel;
  kind: LowerUpdateAutoStatusKind;
  message: string;
  manifest: LowerUpdateManifest | null;
  cachedPackage: LowerUpdateCachedPackage | null;
  downloadResult: LowerUpdateDownloadResult | null;
  progress: LowerUpdateDownloadProgress | null;
  lastCheckedAt: number | null;
}

export interface LowerUpdateAutoStatus {
  channels: Record<LowerUpdateChannel, LowerUpdateAutoChannelStatus>;
}

export interface LowerUpdateAutoContextValue extends LowerUpdateAutoStatus {
  ensureDownloaded(manifest: LowerUpdateManifest): Promise<LowerUpdateDownloadResult>;
}

function createInitialChannelStatus(channel: LowerUpdateChannel): LowerUpdateAutoChannelStatus {
  return {
    channel,
    kind: 'idle',
    message: '尚未检查下位机更新',
    manifest: null,
    cachedPackage: null,
    downloadResult: null,
    progress: null,
    lastCheckedAt: null,
  };
}

export const initialLowerUpdateAutoStatus: LowerUpdateAutoStatus = {
  channels: {
    stable: createInitialChannelStatus('stable'),
    beta: createInitialChannelStatus('beta'),
    nightly: createInitialChannelStatus('nightly'),
    ci: createInitialChannelStatus('ci'),
  },
};

const unavailableEnsureDownloaded = async (): Promise<LowerUpdateDownloadResult> => {
  throw new Error('下位机更新下载服务尚未初始化');
};

export const LowerUpdateAutoContext = createContext<LowerUpdateAutoContextValue>({
  ...initialLowerUpdateAutoStatus,
  ensureDownloaded: unavailableEnsureDownloaded,
});

export function useLowerUpdateAuto(): LowerUpdateAutoContextValue {
  return useContext(LowerUpdateAutoContext);
}
