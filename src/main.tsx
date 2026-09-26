import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { initNativeApp } from './utils/nativeApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// After first paint — never block UI; ignore errors (APK only)
requestAnimationFrame(() => {
  void initNativeApp().catch((e) => console.warn('[native]', e));
});
