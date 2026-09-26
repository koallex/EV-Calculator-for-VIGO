import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { initNativeApp } from './utils/nativeApp';

class RootErrorBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: '100vh',
            background: '#0b1220',
            color: '#fca5a5',
            padding: 24,
            fontFamily: 'system-ui, sans-serif',
            fontSize: 14,
          }}
        >
          <p style={{ fontWeight: 700, marginBottom: 8 }}>Ошибка интерфейса</p>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#e2e8f0' }}>{this.state.error}</pre>
          <button
            type="button"
            style={{
              marginTop: 16,
              padding: '10px 16px',
              background: '#0891b2',
              color: '#fff',
              border: 0,
              borderRadius: 8,
              fontWeight: 700,
            }}
            onClick={() => window.location.reload()}
          >
            Обновить
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);

setTimeout(() => {
  void initNativeApp().catch((e) => console.warn('[native]', e));
}, 300);
