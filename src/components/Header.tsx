import React from 'react';
import { Car, Plus } from 'lucide-react';
import { UserSettings } from '../types';
import { triggerHaptic } from '../utils/haptics';
import { getVehicleProfile } from '../data/vehicleProfiles';

interface HeaderProps {
  settings: UserSettings;
  onUpdateSettings: (newSettings: UserSettings) => void;
  onOpenAddTrip: () => void;
  currentUser?: { login: string; role: 'admin' | 'user' };
  onOpenAdmin?: () => void;
  onLogout?: () => void;
  onOpenAbout?: () => void;
}

/**
 * Slim header: brand + primary CTA only.
 * Theme, About, Admin, Logout live under Settings («Ещё») so landscape
 * (where this header is hidden) still has a path via the bottom nav.
 */
export const Header: React.FC<HeaderProps> = ({
  settings,
  onOpenAddTrip,
}) => {
  const isDark = settings.theme !== 'light';
  const profile = getVehicleProfile(settings.vehicleProfileId);
  const carTitle = profile.isCustom ? 'Свой автомобиль' : profile.displayName;

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
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-cyan-500 to-teal-600 flex items-center justify-center shadow-sm shadow-cyan-500/20 text-white shrink-0">
            <Car className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className={`text-sm font-bold tracking-tight truncate ${isDark ? 'text-white' : 'text-slate-900'}`}>
                {carTitle}
              </h1>
              <span
                className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-md border shrink-0 ${
                  isDark
                    ? 'bg-cyan-950/60 text-cyan-400 border-cyan-800/50'
                    : 'bg-cyan-50 text-cyan-700 border-cyan-200'
                }`}
              >
                {settings.batteryCapacityKwh} кВт⋅ч
              </span>
            </div>
            <p className={`text-[11px] font-medium truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Планировщик поездок по Беларуси
            </p>
          </div>
        </div>

        <button
          id="quick-add-trip-button"
          type="button"
          onClick={() => {
            triggerHaptic('medium', settings.hapticFeedback);
            onOpenAddTrip();
          }}
          aria-label="Добавить поездку"
          className="flex items-center gap-1.5 h-9 min-h-[44px] px-3 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold active:scale-95 transition-all shadow-sm shadow-cyan-600/20"
        >
          <Plus className="w-4 h-4 stroke-[2.5]" />
          <span>Добавить</span>
        </button>
      </div>
    </header>
  );
};
