import { RouterProvider } from 'react-router-dom';
import { ConfigProvider, App as AntApp } from 'antd';
import { AppUpdateProvider } from './components/app-update/AppUpdateProvider';
import { LowerUpdateAutoProvider } from './components/lower-update/LowerUpdateAutoProvider';
import { LowerUpdateDeploymentProvider } from './components/lower-update/LowerUpdateDeploymentProvider';
import { LowerUpdateDeploymentUi } from './components/lower-update/LowerUpdateDeploymentUi';
import { AppModeProvider } from './offline/AppModeProvider.tsx';
import { darkTheme } from './theme/dark';
import { appLocale } from './theme/locale';
import { router } from './router';
import { PlatformAuthProvider } from './auth/PlatformAuthProvider';
import { PlatformAuthGate } from './auth/PlatformAuthGate';
import { PlatformTemplateMonitor } from './features/modbus-templates/PlatformTemplateMonitor';

function App() {
  return (
    <ConfigProvider theme={darkTheme} locale={appLocale}>
      <AntApp>
        <PlatformAuthProvider>
          <PlatformTemplateMonitor />
          <PlatformAuthGate>
            <AppModeProvider>
              <AppUpdateProvider>
                <LowerUpdateAutoProvider>
                  <LowerUpdateDeploymentProvider>
                    <RouterProvider router={router} />
                    <LowerUpdateDeploymentUi />
                  </LowerUpdateDeploymentProvider>
                </LowerUpdateAutoProvider>
              </AppUpdateProvider>
            </AppModeProvider>
          </PlatformAuthGate>
        </PlatformAuthProvider>
      </AntApp>
    </ConfigProvider>
  );
}

export default App;
