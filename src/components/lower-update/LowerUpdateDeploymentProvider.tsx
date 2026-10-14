import { useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../adapters';
import { createLowerUpdateDeploymentController } from '../../utils/lower-update-deployment';
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
import { LowerUpdateDeploymentContext } from './lower-update-deployment-context';

function createApplicationController(): LowerUpdateDeploymentController {
  return createLowerUpdateDeploymentController({
    queryRuntime: api.getLowerUpdateRuntimeInfo,
    upload: api.uploadLowerUpdatePackage,
    install: api.installLowerUpdatePackage,
    cleanup: api.cleanupLowerUpdatePackages,
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
    openDetails: controller.openDetails,
    closeDetails: controller.closeDetails,
    dismissResult: controller.dismissResult,
  }), [controller, snapshot]);
  return <LowerUpdateDeploymentContext.Provider value={value}>{children}</LowerUpdateDeploymentContext.Provider>;
}
