import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { initNativeApp } from './utils/nativeApp';

// Capacitor only: status bar insets + GPS bridge. No-op in browser.
void initNativeApp();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
