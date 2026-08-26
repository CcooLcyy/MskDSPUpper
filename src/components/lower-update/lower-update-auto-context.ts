import { createContext, useContext } from 'react';
import type {
  LowerUpdateCachedPackage,
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
  progress: LowerUpdateDownloadProgress | null;
  lastCheckedAt: number | null;
}

export interface LowerUpdateAutoStatus {
  channels: Record<LowerUpdateChannel, LowerUpdateAutoChannelStatus>;
}

function createInitialChannelStatus(channel: LowerUpdateChannel): LowerUpdateAutoChannelStatus {
  return {
    channel,
    kind: 'idle',
    message: '尚未检查下位机更新',
    manifest: null,
    cachedPackage: null,
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

export const LowerUpdateAutoContext = createContext<LowerUpdateAutoStatus>(
  initialLowerUpdateAutoStatus,
);

export function useLowerUpdateAuto(): LowerUpdateAutoStatus {
  return useContext(LowerUpdateAutoContext);
}
