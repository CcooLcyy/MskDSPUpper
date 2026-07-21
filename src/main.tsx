import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initializeAppSettings } from './utils/app-settings';
import './index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}
const rootContainer = rootElement;
const bootSplash = document.getElementById('boot-splash');

async function bootstrap(): Promise<void> {
  try {
    await initializeAppSettings();
  } catch (error) {
    console.error('Failed to initialize persistent app settings:', error);
    const failure = document.createElement('div');
    failure.style.cssText = 'min-height:100vh;display:grid;place-content:center;padding:24px;color:#ff7875;background:#101214;font:14px sans-serif;text-align:center;';
    failure.textContent = `本地配置加载失败，已停止启动以避免覆盖现有配置。${String(error)}`;
    rootContainer.replaceChildren(failure);
    if (bootSplash) {
      bootSplash.remove();
    }
    return;
  }

  createRoot(rootContainer).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  if (bootSplash) {
    requestAnimationFrame(() => {
      bootSplash.classList.add('boot-splash--hidden');
      window.setTimeout(() => {
        bootSplash.remove();
      }, 180);
    });
  }
}

void bootstrap();
