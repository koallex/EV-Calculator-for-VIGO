import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Lightweight, dependency-free replacement for window.alert / window.confirm:
 *  - toast({ message, actionLabel, onAction })  → transient message with optional "Отменить"-style action
 *  - ask({ title, message, actions })           → modal dialog resolving with the chosen action id (or null)
 *  - confirm({ ... })                           → boolean shortcut over ask()
 * Native dialogs look foreign inside the APK WebView and can't offer "undo"; this keeps one consistent UI.
 */

export interface ToastOptions {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  durationMs?: number;
  tone?: 'default' | 'success' | 'error';
}

export interface DialogAction {
  id: string;
  label: string;
  tone?: 'primary' | 'danger' | 'neutral';
}

export interface AskOptions {
  title: string;
  message?: React.ReactNode;
  actions: DialogAction[];
}

export interface ConfirmOptions {
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface FeedbackApi {
  toast: (opts: ToastOptions) => void;
  ask: (opts: AskOptions) => Promise<string | null>;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const noop: FeedbackApi = {
  toast: () => {},
  ask: async () => null,
  confirm: async () => false,
};

const FeedbackContext = createContext<FeedbackApi>(noop);
export const useFeedback = () => useContext(FeedbackContext);

interface ToastItem extends ToastOptions { id: number }
interface DialogState extends AskOptions { resolve: (id: string | null) => void }

const isLightTheme = () =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('light');

export const FeedbackProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const idRef = useRef(0);
  const timersRef = useRef<Map<number, number>>(new Map());

  const dismiss = useCallback((id: number) => {
    const t = timersRef.current.get(id);
    if (t) window.clearTimeout(t);
    timersRef.current.delete(id);
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback((opts: ToastOptions) => {
    const id = ++idRef.current;
    // Keep at most 2 toasts on screen — newest wins.
    setToasts((prev) => [...prev.slice(-1), { ...opts, id }]);
    const duration = opts.durationMs ?? (opts.actionLabel ? 6000 : 3000);
    timersRef.current.set(id, window.setTimeout(() => dismiss(id), duration));
  }, [dismiss]);

  const ask = useCallback((opts: AskOptions) => new Promise<string | null>((resolve) => {
    setDialog((prev) => {
      prev?.resolve(null); // never leave a previous promise hanging
      return { ...opts, resolve };
    });
  }), []);

  const confirm = useCallback(async (opts: ConfirmOptions) => {
    const result = await ask({
      title: opts.title,
      message: opts.message,
      actions: [
        { id: 'cancel', label: opts.cancelLabel ?? 'Отмена', tone: 'neutral' },
        { id: 'ok', label: opts.confirmLabel ?? 'Подтвердить', tone: opts.danger ? 'danger' : 'primary' },
      ],
    });
    return result === 'ok';
  }, [ask]);

  const closeDialog = useCallback((id: string | null) => {
    setDialog((prev) => {
      prev?.resolve(id);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDialog(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, closeDialog]);

  useEffect(() => () => { timersRef.current.forEach((t) => window.clearTimeout(t)); }, []);

  const api = useMemo<FeedbackApi>(() => ({ toast, ask, confirm }), [toast, ask, confirm]);
  const light = isLightTheme();

  return (
    <FeedbackContext.Provider value={api}>
      {children}

      {/* Toasts — sit above the floating bottom nav */}
      <div
        className="pointer-events-none fixed inset-x-0 z-[80] flex flex-col items-center gap-2 px-3"
        style={{ bottom: 'calc(max(env(safe-area-inset-bottom, 0px), 12px) + 76px)' }}
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto w-full max-w-md rounded-2xl border px-4 py-3 shadow-2xl flex items-center gap-3 text-sm ${
              light
                ? 'bg-white border-slate-200 text-slate-800 shadow-slate-400/30'
                : 'bg-slate-900 border-slate-700 text-slate-100 shadow-black/50'
            } ${t.tone === 'error' ? (light ? 'border-rose-300' : 'border-rose-800') : ''}`}
          >
            <span className="flex-1 min-w-0">{t.message}</span>
            {t.actionLabel && (
              <button
                type="button"
                onClick={() => { t.onAction?.(); dismiss(t.id); }}
                className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold text-cyan-500 hover:bg-cyan-500/10 active:scale-95"
              >
                {t.actionLabel}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Modal dialog */}
      {dialog && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-black/60"
          onClick={() => closeDialog(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={dialog.title}
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-sm rounded-3xl border p-5 shadow-2xl ${
              light ? 'bg-white border-slate-200 text-slate-900' : 'bg-slate-900 border-slate-700 text-slate-100'
            }`}
          >
            <h2 className="text-base font-bold">{dialog.title}</h2>
            {dialog.message && (
              <div className={`mt-2 text-sm leading-relaxed ${light ? 'text-slate-600' : 'text-slate-300'}`}>
                {dialog.message}
              </div>
            )}
            <div className="mt-5 flex flex-col gap-2">
              {dialog.actions.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => closeDialog(a.id)}
                  className={`h-11 rounded-xl text-sm font-bold active:scale-[0.98] ${
                    a.tone === 'danger'
                      ? 'bg-rose-600 hover:bg-rose-500 text-white'
                      : a.tone === 'primary'
                        ? 'bg-cyan-600 hover:bg-cyan-500 text-white'
                        : light
                          ? 'bg-slate-100 hover:bg-slate-200 text-slate-800'
                          : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                  }`}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </FeedbackContext.Provider>
  );
};
