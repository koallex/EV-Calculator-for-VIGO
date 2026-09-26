import React, { useState } from 'react';
import { LockKeyhole, LogIn, Loader2, Zap, UserPlus } from 'lucide-react';

export interface AuthUser {
  login: string;
  role: 'admin' | 'user';
}

interface LoginScreenProps {
  onLogin: (user: AuthUser) => void;
}

// Self-service registration has no approval step and asks for nothing beyond a login and
// password (no email, no phone, no ID) — this keeps the app within Yandex Maps API's
// free-tier "open access" condition, which allows registration as long as it's open to
// everyone with no extra restrictions (payment, identity documents, etc).
export const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const switchMode = (next: 'login' | 'register') => {
    if (next === mode) return;
    setMode(next);
    setError('');
    setPasswordConfirm('');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');

    if (mode === 'register' && password !== passwordConfirm) {
      setError('Пароли не совпадают.');
      return;
    }

    setBusy(true);
    try {
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || (mode === 'login' ? 'Не удалось выполнить вход.' : 'Не удалось создать аккаунт.'));
      }
      onLogin(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Произошла ошибка.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen relative flex items-center justify-center p-4 overflow-hidden bg-slate-950 text-slate-100">
      {/* Hero background photo. object-position favors the upper-middle of the frame so the
          car's face stays visible behind the login card on narrow (mobile) viewports, where
          bg-cover would otherwise crop it out. */}
      <div
        className="absolute inset-0 bg-cover"
        style={{ backgroundImage: "url('/vigo-hero.webp')", backgroundPosition: '50% 20%' }}
        aria-hidden="true"
      />
      {/* Gradient overlay: darkest behind the form card, fading out toward the edges so the
          photo still reads at the top/sides while the card keeps full contrast. */}
      <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/80 to-slate-950/30" aria-hidden="true" />

      <form onSubmit={submit} className="relative w-full max-w-sm rounded-3xl border border-slate-800 bg-slate-900/90 backdrop-blur-sm p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-cyan-500 to-teal-600 flex items-center justify-center text-white">
            <Zap className="w-5 h-5 fill-current" />
          </div>
          <div>
            <h1 className="text-base font-bold text-white">EV Calculator</h1>
            <p className="text-xs text-slate-400">
              {mode === 'login' ? 'Физическая модель расхода · автопоиск ЭЗС' : 'Регистрация'}
            </p>
          </div>
        </div>

        {/* Mode toggle — registration is open to anyone, no invitation required. */}
        <div className="grid grid-cols-2 gap-1 p-1 mb-5 rounded-xl bg-slate-950 border border-slate-800">
          <button
            type="button"
            onClick={() => switchMode('login')}
            className={`h-8 rounded-lg text-xs font-bold transition-colors ${mode === 'login' ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
          >
            Вход
          </button>
          <button
            type="button"
            onClick={() => switchMode('register')}
            className={`h-8 rounded-lg text-xs font-bold transition-colors ${mode === 'register' ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
          >
            Регистрация
          </button>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-semibold text-slate-300">Логин</span>
            <input
              autoComplete="username"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-cyan-500"
              placeholder="Введите логин"
              required
            />
          </label>

          <label className="block">
            <span className="text-xs font-semibold text-slate-300">Пароль</span>
            <div className="relative mt-1.5">
              <LockKeyhole className="absolute left-3 top-3 w-4 h-4 text-slate-500" />
              <input
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 pl-9 pr-3 py-2.5 text-sm outline-none focus:border-cyan-500"
                placeholder={mode === 'login' ? 'Введите пароль' : 'Минимум 8 символов'}
                minLength={mode === 'register' ? 8 : undefined}
                required
              />
            </div>
          </label>

          {mode === 'register' && (
            <label className="block">
              <span className="text-xs font-semibold text-slate-300">Повторите пароль</span>
              <div className="relative mt-1.5">
                <LockKeyhole className="absolute left-3 top-3 w-4 h-4 text-slate-500" />
                <input
                  autoComplete="new-password"
                  type="password"
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 pl-9 pr-3 py-2.5 text-sm outline-none focus:border-cyan-500"
                  placeholder="Повторите пароль"
                  minLength={8}
                  required
                />
              </div>
            </label>
          )}
        </div>

        {error && (
          <div className="mt-3 rounded-xl border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-5 w-full h-11 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-60 text-white text-sm font-bold flex items-center justify-center gap-2"
        >
          {busy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : mode === 'login' ? (
            <LogIn className="w-4 h-4" />
          ) : (
            <UserPlus className="w-4 h-4" />
          )}
          {busy ? (mode === 'login' ? 'Вход…' : 'Создаём аккаунт…') : mode === 'login' ? 'Войти' : 'Создать аккаунт'}
        </button>

        {mode === 'login' && (
          <p className="mt-3 text-center text-[11px] text-slate-500">
            Нет аккаунта?{' '}
            <button type="button" onClick={() => switchMode('register')} className="text-cyan-400 font-semibold hover:underline">
              Зарегистрироваться
            </button>
          </p>
        )}
      </form>
    </div>
  );
};
