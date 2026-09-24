import React, { useEffect, useState } from 'react';
import { Plus, ShieldCheck, Trash2, UserRound, X, RefreshCw, LogOut, BarChart3 } from 'lucide-react';

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

interface LoginStatUser {
  login: string;
  total: number;
  lastLoginAt?: string | null;
  last30Days: number;
}

interface LoginStats {
  daily: { day: string; count: number }[];
  users: LoginStatUser[];
}

interface UsageStatUser {
  login: string;
  total: number;
  lastOpenAt?: string | null;
  last30Days: number;
}

interface UsageStats {
  daily: { day: string; opens: number; anonymousOpens: number; unique: number }[];
  totals: {
    opens30Days: number;
    anonymousOpens30Days: number;
    uniqueVisitors30Days: number;
  };
  users: UsageStatUser[];
}

export const AdminPanel: React.FC<AdminPanelProps> = ({ currentLogin, onClose, onLogout }) => {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loginStats, setLoginStats] = useState<LoginStats>({ daily: [], users: [] });
  const [usageStats, setUsageStats] = useState<UsageStats>({
    daily: [],
    totals: { opens30Days: 0, anonymousOpens30Days: 0, uniqueVisitors30Days: 0 },
    users: [],
  });

  const loadUsers = async () => {
    setError('');
    try {
      const response = await fetch('/api/admin/users');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось загрузить пользователей.');
      setUsers(data.users || []);
      setLoginStats(data.loginStats || { daily: [], users: [] });
      setUsageStats(data.usageStats || {
        daily: [],
        totals: { opens30Days: 0, anonymousOpens30Days: 0, uniqueVisitors30Days: 0 },
        users: [],
      });
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
              <ShieldCheck className="w-5 h-5 text-cyan-400" />
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
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-cyan-500" required />
          <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Пароль (мин. 8 символов)" type="password" autoComplete="new-password"
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-cyan-500" required minLength={8} />
        </div>
        <button disabled={busy} className="h-10 px-4 rounded-xl bg-cyan-600 text-white text-xs font-bold flex items-center gap-2 disabled:opacity-60">
          <Plus className="w-4 h-4" /> Создать
        </button>
      </form>

      {message && <div className="rounded-xl border border-cyan-900/60 bg-cyan-950/30 px-3 py-2 text-xs text-cyan-300">{message}</div>}
      {error && <div className="rounded-xl border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">{error}</div>}

      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center gap-2 mb-3">
          <BarChart3 className="w-4 h-4 text-cyan-400" />
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">Использование приложения</h3>
            <p className="mt-1 text-[10px] text-slate-500">Все открытия приложения, включая посетителей без входа</p>
          </div>
        </div>

        {(() => {
          const maxDaily = Math.max(1, ...usageStats.daily.map(item => item.opens));
          return (
            <>
              <div className="grid grid-cols-3 gap-2 mb-4">
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                  <div className="text-[10px] text-slate-500">Открытий за 30 дней</div>
                  <div className="mt-1 text-xl font-black text-white">{usageStats.totals.opens30Days}</div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                  <div className="text-[10px] text-slate-500">Уникальных посетителей</div>
                  <div className="mt-1 text-xl font-black text-white">{usageStats.totals.uniqueVisitors30Days}</div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                  <div className="text-[10px] text-slate-500">Без входа</div>
                  <div className="mt-1 text-xl font-black text-white">{usageStats.totals.anonymousOpens30Days}</div>
                </div>
              </div>

              {usageStats.daily.length > 0 && (
                <div className="h-28 flex items-end gap-1 mb-4">
                  {usageStats.daily.map(item => (
                    <div key={item.day} className="flex-1 h-full flex flex-col justify-end items-center gap-1"
                      title={`${new Date(`${item.day}T00:00:00`).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}: ${item.opens} открытий · ${item.unique} уникальных`}>
                      <div className="w-full rounded-t bg-cyan-500/70 min-h-[2px]" style={{ height: `${Math.max(2, (item.opens / maxDaily) * 100)}%` }} />
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-2">
                {usageStats.users.map(stat => (
                  <div key={stat.login} className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white truncate">{stat.login}</div>
                      <div className="text-[10px] text-slate-500">
                        Открытий: {stat.total} · за 30 дней: {stat.last30Days}
                        {stat.lastOpenAt ? ` · последнее ${new Date(stat.lastOpenAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ' · ещё не открывал'}
                      </div>
                    </div>
                    <div className="text-lg font-black text-cyan-400 shrink-0">{stat.last30Days}</div>
                  </div>
                ))}
              </div>
            </>
          );
        })()}
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center gap-2 mb-3">
          <BarChart3 className="w-4 h-4 text-cyan-400" />
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">Статистика входов</h3>
            <p className="mt-1 text-[10px] text-slate-500">Успешные входы пользователей за последние 30 дней</p>
          </div>
        </div>

        {(() => {
          const maxDaily = Math.max(1, ...loginStats.daily.map(item => item.count));
          const total30 = loginStats.daily.reduce((sum, item) => sum + item.count, 0);
          const active30 = loginStats.users.filter(item => item.last30Days > 0).length;
          return (
            <>
              <div className="grid grid-cols-2 gap-2 mb-4">
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                  <div className="text-[10px] text-slate-500">Входов за 30 дней</div>
                  <div className="mt-1 text-xl font-black text-white">{total30}</div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                  <div className="text-[10px] text-slate-500">Активных пользователей</div>
                  <div className="mt-1 text-xl font-black text-white">{active30}</div>
                </div>
              </div>

              {loginStats.daily.length > 0 && (
                <div className="h-28 flex items-end gap-1 mb-4">
                  {loginStats.daily.map(item => (
                    <div key={item.day} className="flex-1 h-full flex flex-col justify-end items-center gap-1" title={`${new Date(`${item.day}T00:00:00`).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}: ${item.count} входов`}>
                      <div className="w-full rounded-t bg-cyan-500/70 min-h-[2px]" style={{ height: `${Math.max(2, (item.count / maxDaily) * 100)}%` }} />
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-2">
                {loginStats.users.map(stat => (
                  <div key={stat.login} className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white truncate">{stat.login}</div>
                      <div className="text-[10px] text-slate-500">
                        Всего: {stat.total} · за 30 дней: {stat.last30Days}
                        {stat.lastLoginAt ? ` · последний вход ${new Date(stat.lastLoginAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ' · входов ещё не было'}
                      </div>
                    </div>
                    <div className="text-lg font-black text-cyan-400 shrink-0">{stat.last30Days}</div>
                  </div>
                ))}
              </div>
            </>
          );
        })()}
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">Пользователи</h3>
          <button onClick={() => void loadUsers()} className="p-2 rounded-xl border border-slate-700 text-slate-300" title="Обновить">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-cyan-900/50 bg-cyan-950/20 p-3">
            <div className="flex items-center gap-3">
              <ShieldCheck className="w-4 h-4 text-cyan-400" />
              <div>
                <div className="text-sm font-semibold text-white">{currentLogin}</div>
                <div className="text-[10px] text-cyan-400">Администратор</div>
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
