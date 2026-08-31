import React, { useEffect, useState } from 'react';
import { Plus, ShieldCheck, Trash2, UserRound, X, RefreshCw, LogOut } from 'lucide-react';

interface AdminPanelProps {
  currentLogin: string;
  onClose: () => void;
  onLogout: () => void;
}

interface AdminUser {
  login: string;
  role: 'admin' | 'user';
  createdAt?: string;
  disabled?: boolean;
}

export const AdminPanel: React.FC<AdminPanelProps> = ({ currentLogin, onClose, onLogout }) => {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadUsers = async () => {
    setError('');
    try {
      const response = await fetch('/api/admin/users');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось загрузить пользователей.');
      setUsers(data.users || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки.');
    }
  };

  useEffect(() => { void loadUsers(); }, []);

  const addUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setBusy(true);
    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось создать пользователя.');
      setLogin('');
      setPassword('');
      setMessage('Пользователь создан.');
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка создания.');
    } finally {
      setBusy(false);
    }
  };

  const removeUser = async (userLogin: string) => {
    if (!window.confirm(`Удалить пользователя «${userLogin}»? Он больше не сможет войти.`)) return;
    setError('');
    try {
      const response = await fetch(`/api/admin/users?login=${encodeURIComponent(userLogin)}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось удалить пользователя.');
      setMessage('Пользователь удалён.');
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления.');
    }
  };

  return (
    <div className="space-y-4 pb-12">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
              <h2 className="text-sm font-bold text-white">Админ-панель</h2>
            </div>
            <p className="mt-1 text-xs text-slate-400">Управление доступом пользователей</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl border border-slate-700 text-slate-300">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <form onSubmit={addUser} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">Добавить пользователя</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="Логин" autoComplete="off"
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-emerald-500" required />
          <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Пароль (мин. 8 символов)" type="password" autoComplete="new-password"
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-emerald-500" required minLength={8} />
        </div>
        <button disabled={busy} className="h-10 px-4 rounded-xl bg-emerald-600 text-white text-xs font-bold flex items-center gap-2 disabled:opacity-60">
          <Plus className="w-4 h-4" /> Создать
        </button>
      </form>

      {message && <div className="rounded-xl border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">{message}</div>}
      {error && <div className="rounded-xl border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">{error}</div>}

      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">Пользователи</h3>
          <button onClick={() => void loadUsers()} className="p-2 rounded-xl border border-slate-700 text-slate-300" title="Обновить">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-900/50 bg-emerald-950/20 p-3">
            <div className="flex items-center gap-3">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <div>
                <div className="text-sm font-semibold text-white">{currentLogin}</div>
                <div className="text-[10px] text-emerald-400">Администратор</div>
              </div>
            </div>
          </div>

          {users.map((user) => (
            <div key={user.login} className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
              <div className="flex items-center gap-3 min-w-0">
                <UserRound className="w-4 h-4 text-slate-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white truncate">{user.login}</div>
                  <div className="text-[10px] text-slate-500">Создан: {user.createdAt ? new Date(user.createdAt).toLocaleDateString('ru-RU') : '—'}</div>
                </div>
              </div>
              <button onClick={() => void removeUser(user.login)} className="p-2 rounded-xl border border-rose-900/50 text-rose-400 hover:bg-rose-950/40" title="Удалить">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          {!users.length && <p className="text-xs text-slate-500 py-2">Обычных пользователей пока нет.</p>}
        </div>
      </div>

      <button onClick={onLogout} className="w-full h-10 rounded-xl border border-slate-700 text-slate-300 text-xs font-bold flex items-center justify-center gap-2">
        <LogOut className="w-4 h-4" /> Выйти
      </button>
    </div>
  );
};
