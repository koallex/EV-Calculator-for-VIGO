import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Zap, Moon, Sun, Plus, ShieldCheck, LogOut } from 'lucide-react';
import { UserSettings } from '../types';
import { triggerHaptic } from '../utils/haptics';

interface CurrentUser { login: string; role: 'admin' | 'user'; }

interface HeaderProps {
  settings: UserSettings;
  onUpdateSettings: (newSettings: UserSettings) => void;
  onOpenAddTrip: () => void;
  currentUser?: CurrentUser;
  onOpenAdmin?: () => void;
  onLogout?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  settings,
  onUpdateSettings,
  onOpenAddTrip,
  currentUser,
  onOpenAdmin,
  onLogout,
}) => {
  const toggleTheme = () => {
    triggerHaptic('light', settings.hapticFeedback);
    const nextTheme = settings.theme === 'dark' ? 'light' : 'dark';
    onUpdateSettings({ ...settings, theme: nextTheme });
  };

  const isDark = settings.theme !== 'light';

  return (
    <header
      id="main-header"
      className={`sticky top-0 z-30 backdrop-blur-md px-4 pt-[max(env(safe-area-inset-top,0px),12px)] pb-3 border-b transition-colors ${
        isDark
          ? 'bg-slate-950/80 border-slate-800/60 text-slate-100'
          : 'bg-white/80 border-slate-200/80 text-slate-900 shadow-xs'
      }`}
    >
      <div className="max-w-4xl mx-auto flex items-center justify-between gap-3">
        {/* Brand & Car Model */}
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-sm shadow-emerald-500/20 text-white shrink-0">
            <Zap className="w-4 h-4 fill-current" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className={`text-sm font-bold tracking-tight truncate ${isDark ? 'text-white' : 'text-slate-900'}`}>
                Dongfeng Vigo
              </h1>
              <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-md border shrink-0 ${
                isDark 
                  ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800/50' 
                  : 'bg-emerald-50 text-emerald-700 border-emerald-200'
              }`}>
                {settings.batteryCapacityKwh} кВт⋅ч
              </span>
            </div>
            <p className={`text-[11px] font-medium truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Калькулятор расхода и зарядки EV
            </p>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Theme toggle with icon rotation */}
          <button
            id="theme-toggle-button"
            onClick={toggleTheme}
            title={isDark ? 'Включить светлую тему' : 'Включить темную тему'}
            className={`w-9 h-9 rounded-xl flex items-center justify-center active:scale-95 transition-all border overflow-hidden ${
              isDark
                ? 'bg-slate-900/90 hover:bg-slate-800 text-amber-400 border-slate-800'
                : 'bg-slate-100 hover:bg-slate-200 text-amber-600 border-slate-200'
            }`}
          >
            <AnimatePresence mode="wait" initial={false}>
              {isDark ? (
                <motion.span
                  key="sun"
                  initial={{ rotate: -90, opacity: 0, scale: 0.6 }}
                  animate={{ rotate: 0, opacity: 1, scale: 1 }}
                  exit={{ rotate: 90, opacity: 0, scale: 0.6 }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                  className="inline-flex"
                >
                  <Sun className="w-4 h-4" />
                </motion.span>
              ) : (
                <motion.span
                  key="moon"
                  initial={{ rotate: 90, opacity: 0, scale: 0.6 }}
                  animate={{ rotate: 0, opacity: 1, scale: 1 }}
                  exit={{ rotate: -90, opacity: 0, scale: 0.6 }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                  className="inline-flex"
                >
                  <Moon className="w-4 h-4 text-slate-700" />
                </motion.span>
              )}
            </AnimatePresence>
          </button>

          {/* Quick Add Trip (Primary CTA) */}
          <button
            id="quick-add-trip-button"
            onClick={() => {
              triggerHaptic('medium', settings.hapticFeedback);
              onOpenAddTrip();
            }}
            className="flex items-center gap-1.5 h-9 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold active:scale-95 transition-all shadow-sm shadow-emerald-600/20"
          >
            <Plus className="w-4 h-4 stroke-[2.5]" />
            <span>Запись</span>
          </button>

          {currentUser?.role === 'admin' && (
            <button
              id="admin-panel-button"
              onClick={onOpenAdmin}
              title="Админ-панель"
              className={`w-9 h-9 rounded-xl flex items-center justify-center border active:scale-95 ${
                isDark ? 'bg-slate-900/90 border-slate-800 text-emerald-400' : 'bg-slate-100 border-slate-200 text-emerald-600'
              }`}
            >
              <ShieldCheck className="w-4 h-4" />
            </button>
          )}

          <button
            id="logout-button"
            onClick={onLogout}
            title={`Выйти (${currentUser?.login ?? ''})`}
            className={`w-9 h-9 rounded-xl flex items-center justify-center border active:scale-95 ${
              isDark ? 'bg-slate-900/90 border-slate-800 text-slate-400' : 'bg-slate-100 border-slate-200 text-slate-500'
            }`}
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
};
