import React from 'react';
import { motion } from 'motion/react';
import { Calculator, History, BatteryCharging, Settings, Gauge } from 'lucide-react';
import { triggerHaptic } from '../utils/haptics';

export type TabType = 'calculator' | 'hud' | 'history' | 'charging' | 'settings';

interface NavigationProps {
  activeTab: TabType;
  onSelectTab: (tab: TabType) => void;
  hapticFeedback: boolean;
  historyCount: number;
  theme?: 'dark' | 'light' | 'oled';
  isHudTracking?: boolean;
}

export const Navigation: React.FC<NavigationProps> = ({
  activeTab,
  onSelectTab,
  hapticFeedback,
  historyCount,
  theme = 'dark',
  isHudTracking = false,
}) => {
  const isDark = theme !== 'light';
  const tabs: { id: TabType; label: string; icon: React.FC<{ className?: string }> }[] = [
    { id: 'calculator', label: 'Калькулятор', icon: Calculator },
    { id: 'hud', label: 'HUD Спидометр', icon: Gauge },
    { id: 'history', label: 'История', icon: History },
    { id: 'charging', label: 'Зарядка', icon: BatteryCharging },
    { id: 'settings', label: 'Настройки', icon: Settings },
  ];

  return (
    <nav
      id="bottom-navigation-bar"
      className={`fixed bottom-0 left-0 right-0 z-40 backdrop-blur-xl border-t px-2 pt-1.5 pb-[max(env(safe-area-inset-bottom,0px),8px)] transition-colors ${
        isDark
          ? 'bg-slate-950/95 border-slate-800/80'
          : 'bg-white/95 border-slate-200 shadow-lg'
      }`}
    >
      <div className="max-w-md mx-auto grid grid-cols-5 gap-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              id={`nav-tab-${tab.id}`}
              onClick={() => {
                triggerHaptic('light', hapticFeedback);
                onSelectTab(tab.id);
              }}
              className={`relative flex flex-col items-center justify-center py-1.5 px-1 rounded-xl transition-all select-none active:scale-95 ${
                isActive
                  ? isDark ? 'text-emerald-400 font-bold' : 'text-emerald-600 font-bold'
                  : isDark ? 'text-slate-400 hover:text-slate-200 font-medium' : 'text-slate-500 hover:text-slate-800 font-medium'
              }`}
            >
              {/* Active Indicator Top Pill */}
              {isActive && (
                <motion.div
                  layoutId="activeNavTabIndicator"
                  transition={{ type: 'spring', stiffness: 450, damping: 35 }}
                  className={`absolute -top-1.5 w-8 h-1 rounded-full ${
                    isDark 
                      ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' 
                      : 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]'
                  }`}
                />
              )}

              <div className="relative">
                <Icon className={`w-5 h-5 ${isActive ? 'stroke-[2.3]' : 'stroke-[1.8]'}`} />
                {tab.id === 'hud' && isHudTracking && (
                  <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse shadow-[0_0_8px_rgba(244,63,94,0.9)]" />
                )}
                {tab.id === 'history' && historyCount > 0 && (
                  <span className={`absolute -top-1 -right-2.5 px-1 min-w-[14px] h-3.5 rounded-full font-bold text-[9px] flex items-center justify-center ${
                    isDark ? 'bg-emerald-500 text-slate-950' : 'bg-emerald-600 text-white'
                  }`}>
                    {historyCount}
                  </span>
                )}
              </div>

              <span className="text-[9.5px] mt-1 tracking-tight leading-none whitespace-nowrap">
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
