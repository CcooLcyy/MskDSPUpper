import { RouterProvider } from 'react-router-dom';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { AppUpdateProvider } from './components/app-update/AppUpdateProvider';
import { LowerUpdateAutoProvider } from './components/lower-update/LowerUpdateAutoProvider';
import { LowerUpdateDeploymentProvider } from './components/lower-update/LowerUpdateDeploymentProvider';
import { LowerUpdateDeploymentUi } from './components/lower-update/LowerUpdateDeploymentUi';
import { AppModeProvider } from './offline/AppModeProvider.tsx';
import { darkTheme } from './theme/dark';
import { router } from './router';
import { PlatformAuthProvider } from './auth/PlatformAuthProvider';
import { PlatformAuthGate } from './auth/PlatformAuthGate';
import { PlatformTemplateMonitor } from './features/modbus-templates/PlatformTemplateMonitor';
import { WorkbenchProvider } from './workbench/WorkbenchProvider';

function App() {
  return (
    <ConfigProvider theme={darkTheme} locale={zhCN}>
      <AntApp>
        <PlatformAuthProvider>
          <PlatformTemplateMonitor />
          <PlatformAuthGate>
            <AppModeProvider>
              <WorkbenchProvider>
                <AppUpdateProvider>
                  <LowerUpdateAutoProvider>
                    <LowerUpdateDeploymentProvider>
                      <RouterProvider router={router} />
                      <LowerUpdateDeploymentUi />
                    </LowerUpdateDeploymentProvider>
                  </LowerUpdateAutoProvider>
                </AppUpdateProvider>
              </WorkbenchProvider>
            </AppModeProvider>
          </PlatformAuthGate>
        </PlatformAuthProvider>
      </AntApp>
    </ConfigProvider>
  );
}

export default App;
