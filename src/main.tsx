import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}
const rootContainer = rootElement;
const bootSplash = document.getElementById('boot-splash');

function bootstrap(): void {
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
