import React from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import { Calculator, History, BatteryCharging, Settings, Gauge, Maximize, Minimize } from 'lucide-react';
import { triggerHaptic } from '../utils/haptics';
import { useCarMode, useFullscreen, isFullscreenSupported, toggleFullscreen } from '../utils/carMode';

export type TabType = 'calculator' | 'hud' | 'history' | 'charging' | 'settings';

interface NavigationProps {
  activeTab: TabType;
  onSelectTab: (tab: TabType) => void;
  hapticFeedback: boolean;
  historyCount: number;
  theme?: 'dark' | 'light' | 'oled';
  isHudTracking?: boolean;
  floating?: boolean;
  visible?: boolean;
  onRequestClose?: () => void;
}

export const Navigation: React.FC<NavigationProps> = ({
  activeTab,
  onSelectTab,
  hapticFeedback,
  historyCount,
  theme = 'dark',
  isHudTracking = false,
  floating = true,
  visible = true,
  onRequestClose,
}) => {
  const isDark = theme !== 'light';
  const car = useCarMode();
  const fullscreen = useFullscreen();
  const showFullscreenButton = car.active && isFullscreenSupported();
  const tabs: { id: TabType; label: string; icon: React.FC<{ className?: string }> }[] = [
    { id: 'calculator', label: 'Калькулятор', icon: Calculator },
    { id: 'hud', label: 'HUD', icon: Gauge },
    { id: 'history', label: 'История', icon: History },
    { id: 'charging', label: 'ЭЗС', icon: BatteryCharging },
    { id: 'settings', label: 'Ещё', icon: Settings },
  ];

  const shell = (
    <nav
      id="main-bottom-nav"
      data-native-bottom-nav
      className={
        floating
          ? `pointer-events-auto mx-auto w-[min(420px,calc(100%-1.5rem))] rounded-full border px-1.5 py-1.5 shadow-2xl backdrop-blur-xl ${
              isDark
                ? 'bg-slate-950/70 border-white/10 shadow-black/40'
                : 'bg-white/75 border-slate-200/80 shadow-slate-300/40'
            }`
          : `fixed bottom-0 left-0 right-0 z-40 border-t px-2 pt-1.5 pb-[max(env(safe-area-inset-bottom,0px),8px)] backdrop-blur-xl ${
              isDark ? 'bg-slate-950/95 border-slate-800/80' : 'bg-white/95 border-slate-200 shadow-lg'
            }`
      }
    >
      <LayoutGroup id="vigo-bottom-nav">
        <div className={`grid grid-cols-5 gap-0.5 ${floating ? '' : 'max-w-md mx-auto'}`}>
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;

            return (
              <button
                key={tab.id}
                id={`nav-tab-${tab.id}`}
                type="button"
                onClick={() => {
                  triggerHaptic('light', hapticFeedback);
                  onSelectTab(tab.id);
                  onRequestClose?.();
                }}
                className={`relative flex flex-col items-center justify-center rounded-full transition-colors select-none active:scale-95 py-1.5 px-1 ${
                  isActive
                    ? isDark
                      ? 'text-cyan-300 font-bold'
                      : 'text-cyan-600 font-bold'
                    : isDark
                      ? 'text-slate-400 hover:text-slate-200 font-medium'
                      : 'text-slate-500 hover:text-slate-800 font-medium'
                }`}
              >
                {isActive && (
                  <motion.div
                    layoutId="vigoNavActivePill"
                    transition={{ type: 'spring', stiffness: 480, damping: 34 }}
                    className={`absolute inset-0 rounded-full ${
                      isDark ? 'bg-white/12' : 'bg-cyan-50'
                    }`}
                    style={{ zIndex: 0 }}
                  />
                )}

                <div className="relative z-[1]">
                  <motion.div
                    animate={{ scale: isActive ? 1.08 : 1 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 28 }}
                  >
                    <Icon className={`w-5 h-5 ${isActive ? 'stroke-[2.3]' : 'stroke-[1.8]'}`} />
                  </motion.div>
                  {tab.id === 'hud' && isHudTracking && (
                    <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse shadow-[0_0_8px_rgba(244,63,94,0.9)]" />
                  )}
                  {tab.id === 'history' && historyCount > 0 && (
                    <span
                      className={`absolute -top-1 -right-2.5 px-1 min-w-[14px] h-3.5 rounded-full font-bold text-[9px] flex items-center justify-center ${
                        isDark ? 'bg-cyan-500 text-slate-950' : 'bg-cyan-600 text-white'
                      }`}
                    >
                      {historyCount}
                    </span>
                  )}
                </div>

                <span className="relative z-[1] text-[9px] mt-0.5 tracking-tight leading-none whitespace-nowrap">
                  {tab.label}
                </span>
              </button>
            );
          })}
        </div>
      </LayoutGroup>
    </nav>
  );

  if (!floating) {
    return shell;
  }

  return (
    <div id="main-bottom-nav-wrap" className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center pb-[max(env(safe-area-inset-bottom,0px),12px)]">
      <AnimatePresence>
        {visible && (
          <motion.div
            key="floating-nav"
            initial={{ y: 24, opacity: 0, scale: 0.96 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            className="pointer-events-auto"
          >
            {shell}
          </motion.div>
        )}
      </AnimatePresence>
      {/* Режим авто: «во весь экран» убирает строку браузера и вкладки — карте достаётся ещё ~120 px высоты. */}
      {showFullscreenButton && visible && (
        <button
          type="button"
          id="car-fullscreen-btn"
          aria-label={fullscreen ? 'Выйти из полноэкранного режима' : 'Во весь экран'}
          onClick={() => {
            triggerHaptic('light', hapticFeedback);
            void toggleFullscreen();
          }}
          className={`pointer-events-auto absolute bottom-[max(env(safe-area-inset-bottom,0px),12px)] left-3 flex h-12 w-12 items-center justify-center rounded-full border shadow-2xl backdrop-blur-xl active:scale-95 ${
            isDark
              ? 'bg-slate-950/70 border-white/10 text-slate-200 shadow-black/40'
              : 'bg-white/75 border-slate-200/80 text-slate-700 shadow-slate-300/40'
          }`}
        >
          {fullscreen ? <Minimize className="h-6 w-6" /> : <Maximize className="h-6 w-6" />}
        </button>
      )}
    </div>
  );
};
