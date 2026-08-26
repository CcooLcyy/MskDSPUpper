import { createContext, useContext } from 'react';
import type {
  LowerUpdateCachedPackage,
  LowerUpdateDownloadProgress,
  LowerUpdateManifest,
} from '../../adapters';

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

export const initialLowerUpdateAutoStatus: LowerUpdateAutoStatus = {
  kind: 'idle',
  message: '尚未检查下位机更新',
  manifest: null,
  cachedPackage: null,
  progress: null,
  lastCheckedAt: null,
};

export const LowerUpdateAutoContext = createContext<LowerUpdateAutoStatus>(
  initialLowerUpdateAutoStatus,
);

export function useLowerUpdateAuto(): LowerUpdateAutoStatus {
  return useContext(LowerUpdateAutoContext);
}
