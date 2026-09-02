import React, { useState } from 'react';
import { motion } from 'motion/react';
import { LockKeyhole, LogIn, Loader2, Zap } from 'lucide-react';

export interface AuthUser {
  login: string;
  role: 'admin' | 'user';
}

interface LoginScreenProps {
  onLogin: (user: AuthUser) => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin }) => {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Не удалось выполнить вход.');
      onLogin(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка входа.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
      <motion.form
        onSubmit={submit}
        className="w-full max-w-sm rounded-3xl border border-slate-800 bg-slate-900/90 p-6 shadow-2xl"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="flex items-center gap-3 mb-6">
          <motion.div
            className="w-11 h-11 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white"
            initial={{ scale: 0.7, rotate: -12 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 18, delay: 0.08 }}
          >
            <Zap className="w-5 h-5 fill-current" />
          </motion.div>
          <div>
            <h1 className="text-base font-bold text-white">Dongfeng Vigo</h1>
            <p className="text-xs text-slate-400">Авторизация</p>
          </div>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-semibold text-slate-300">Логин</span>
            <input
              autoComplete="username"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-emerald-500 transition-colors"
              placeholder="Введите логин"
              required
            />
          </label>

          <label className="block">
            <span className="text-xs font-semibold text-slate-300">Пароль</span>
            <div className="relative mt-1.5">
              <LockKeyhole className="absolute left-3 top-3 w-4 h-4 text-slate-500" />
              <input
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 pl-9 pr-3 py-2.5 text-sm outline-none focus:border-emerald-500 transition-colors"
                placeholder="Введите пароль"
                required
              />
            </div>
          </label>
        </div>

        {error && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-3 rounded-xl border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-300"
          >
            {error}
          </motion.div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-5 w-full h-11 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-sm font-bold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
          {busy ? 'Вход…' : 'Войти'}
        </button>
      </motion.form>
    </div>
  );
};
