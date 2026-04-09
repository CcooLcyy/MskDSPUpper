import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

const bootSplash = document.getElementById('boot-splash');

if (bootSplash) {
  requestAnimationFrame(() => {
    bootSplash.classList.add('boot-splash--hidden');
    window.setTimeout(() => {
      bootSplash.remove();
    }, 180);
  });
}
