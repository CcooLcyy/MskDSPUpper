import { useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../adapters';
import { createLowerUpdateDeploymentController } from '../../utils/lower-update-deployment';
import { notifyManagerRuntimeRefreshed } from '../../utils/manager-runtime-events';
import type { LowerUpdateDeploymentController } from '../../utils/lower-update-deployment';
import {
  lowerUpdateCredentialCoordinator,
  persistSuccessfulLowerUpdateConnection,
  readLowerUpdateConnectionHistory,
  upsertLowerUpdateConnectionHistory,
} from '../../utils/lower-update-connection';
import {
  cacheAppSetting,
  getAppSetting,
  LOWER_UPDATE_CONNECTION_HISTORY_SETTING_KEY,
  LOWER_UPDATE_CONNECTION_SETTING_KEY,
} from '../../utils/app-settings';
import { LOWER_UPDATE_PENDING_KEY, readLowerUpdatePendingTask } from '../../utils/lower-update-pending';
import { LowerUpdateDeploymentContext } from './lower-update-deployment-context';

function createApplicationController(): LowerUpdateDeploymentController {
  return createLowerUpdateDeploymentController({
    submitTask: api.submitLowerUpdateTask,
    queryTask: api.getLowerUpdateTask,
    loadPending: () => {
      try { return JSON.parse(localStorage.getItem(LOWER_UPDATE_PENDING_KEY) ?? 'null'); }
      catch { return { invalid: true }; }
    },
    savePending: async (record) => {
      if (record) {
        const safe = readLowerUpdatePendingTask(record);
        if (!safe) throw new Error('远程更新恢复记录无效');
        localStorage.setItem(LOWER_UPDATE_PENDING_KEY, JSON.stringify(safe));
      } else localStorage.removeItem(LOWER_UPDATE_PENDING_KEY);
    },
    queryRuntime: api.getLowerUpdateRuntimeInfo,
    upload: api.uploadLowerUpdatePackage,
    install: api.installLowerUpdatePackage,
    cleanup: api.cleanupLowerUpdatePackages,
    reconnectRuntime: async (request) => {
      const refreshed = await api.reconnectLowerUpdateRuntime(request);
      if (refreshed) notifyManagerRuntimeRefreshed();
      return refreshed;
    },
    credentialRevision: (account) => lowerUpdateCredentialCoordinator.revision(account),
    sleep: (duration) => new Promise((resolve) => globalThis.setTimeout(resolve, duration)),
    log: (text) => console.info(text),
    saveConnection: async (connection, revision) => {
      await lowerUpdateCredentialCoordinator.run(connection.settings.upload_account, async () => {
        let warning: string | null = null;
        await persistSuccessfulLowerUpdateConnection(connection, {
          save: api.saveLowerUpdateConnection,
          canRemember: () => revision === lowerUpdateCredentialCoordinator.revision(connection.settings.upload_account),
          cache: (settings) => {
            const history = upsertLowerUpdateConnectionHistory(readLowerUpdateConnectionHistory(
              getAppSetting(LOWER_UPDATE_CONNECTION_HISTORY_SETTING_KEY), getAppSetting(LOWER_UPDATE_CONNECTION_SETTING_KEY),
            ), settings);
            cacheAppSetting(LOWER_UPDATE_CONNECTION_SETTING_KEY, settings);
            cacheAppSetting(LOWER_UPDATE_CONNECTION_HISTORY_SETTING_KEY, history);
          },
          warn: (text) => { warning = text; },
        });
        if (warning) throw new Error(warning);
      });
    },
  });
}

/** 放在路由外，页面卸载只撤销订阅，不影响已经开始的任务。 */
export function LowerUpdateDeploymentProvider({ children, controller: suppliedController }: { children: ReactNode; controller?: LowerUpdateDeploymentController }) {
  const [controller] = useState(() => suppliedController ?? createApplicationController());
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const value = useMemo(() => ({
    ...snapshot,
    start: controller.start,
    retry: controller.retry,
    resumeRemote: controller.resumeRemote,
    openDetails: controller.openDetails,
    closeDetails: controller.closeDetails,
    dismissResult: controller.dismissResult,
  }), [controller, snapshot]);
  return <LowerUpdateDeploymentContext.Provider value={value}>{children}</LowerUpdateDeploymentContext.Provider>;
}
