import { createContext, useContext } from 'react';
import type { LowerUpdateDeploymentInput, LowerUpdateDeploymentRetryMode, LowerUpdateDeploymentSnapshot } from '../../utils/lower-update-deployment';

export interface LowerUpdateDeploymentContextValue extends LowerUpdateDeploymentSnapshot {
  start(input: LowerUpdateDeploymentInput): Promise<void>;
  retry(mode: LowerUpdateDeploymentRetryMode): Promise<void>;
  openDetails(): void;
  closeDetails(): void;
  dismissResult(): void;
}

export const LowerUpdateDeploymentContext = createContext<LowerUpdateDeploymentContextValue | null>(null);

export function useLowerUpdateDeployment(): LowerUpdateDeploymentContextValue {
  const value = useContext(LowerUpdateDeploymentContext);
  if (!value) throw new Error('下位机更新后台任务服务尚未初始化');
  return value;
}
