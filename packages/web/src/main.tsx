import '@fontsource-variable/mona-sans/standard.css';
import '@fontsource-variable/jetbrains-mono';
import './styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { applyTheme } from './store/ui';
import { MOCK } from './lib/api';
import { installHoverGroups } from './lib/hover';
import { installDesktopDrop } from './lib/fileDrop';

applyTheme();
installHoverGroups();
// files dropped on the Linux desktop app come through the app (lib/fileDrop.ts)
void installDesktopDrop().catch(() => undefined);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary scope="full">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

if (import.meta.env.PROD && !MOCK && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
