import { RouterProvider } from 'react-router-dom';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { AppUpdateProvider } from './components/app-update/AppUpdateProvider';
import { LowerUpdateAutoProvider } from './components/lower-update/LowerUpdateAutoProvider';
import { darkTheme } from './theme/dark';
import { router } from './router';

function App() {
  return (
    <ConfigProvider theme={darkTheme} locale={zhCN}>
      <AntApp>
        <AppUpdateProvider>
          <LowerUpdateAutoProvider>
            <RouterProvider router={router} />
          </LowerUpdateAutoProvider>
        </AppUpdateProvider>
      </AntApp>
    </ConfigProvider>
  );
}

export default App;
