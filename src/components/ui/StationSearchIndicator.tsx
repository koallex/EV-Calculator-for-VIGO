import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { PlugZap } from 'lucide-react';

interface StationSearchIndicatorProps {
  isDark: boolean;
  /** true — поиск «всех станций на маршруте» (расширенный коридор), false — обычный автоподбор. */
  forced?: boolean;
}

const PHASES_DEFAULT = [
  'Ищем станции вдоль маршрута…',
  'Сверяем данные из нескольких источников…',
  'Отбираем станции с подходящими разъёмами…',
  'Подбираем комфортные остановки…',
];

const PHASES_FORCED = [
  'Расширяем зону поиска вдоль маршрута…',
  'Сверяем данные из нескольких источников…',
  'Отбираем станции с подходящими разъёмами…',
  'Собираем найденные станции…',
];

/**
 * Индикатор поиска зарядных станций вдоль маршрута.
 * Лёгкий по нагрузке: кольца-«радар» и полоса — только CSS transform/opacity (см. index.css),
 * один таймер на смену подписи. При prefers-reduced-motion анимации отключаются, остаётся текст.
 */
export const StationSearchIndicator: React.FC<StationSearchIndicatorProps> = ({ isDark, forced = false }) => {
  const phases = forced ? PHASES_FORCED : PHASES_DEFAULT;
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    setPhase(0);
    const id = window.setInterval(() => setPhase((p) => Math.min(p + 1, phases.length - 1)), 1700);
    return () => window.clearInterval(id);
  }, [phases]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`mt-2 flex items-center gap-3 rounded-xl border px-3 py-3 ${
        isDark ? 'border-cyan-500/20 bg-cyan-500/10' : 'border-cyan-200 bg-cyan-50'
      }`}
    >
      <div className="relative flex h-10 w-10 shrink-0 items-center justify-center">
        <span className="vigo-radar-ring absolute inset-0 rounded-full border-2 border-cyan-400/70" />
        <span className="vigo-radar-ring vigo-radar-ring--late absolute inset-0 rounded-full border-2 border-cyan-400/70" />
        <span
          className={`relative flex h-8 w-8 items-center justify-center rounded-full ${
            isDark ? 'bg-cyan-500/25 text-cyan-300' : 'bg-cyan-100 text-cyan-700'
          }`}
        >
          <PlugZap className="h-4 w-4" />
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <p className={`text-[13px] font-bold ${isDark ? 'text-cyan-200' : 'text-cyan-900'}`}>
          {forced ? 'Ищем все станции на маршруте' : 'Ищем зарядки на маршруте'}
        </p>
        <div className="relative h-[18px] overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={phase}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18 }}
              className={`absolute inset-x-0 truncate text-[12px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
            >
              {phases[phase]}
            </motion.p>
          </AnimatePresence>
        </div>
        <div className={`mt-1.5 h-1 overflow-hidden rounded-full ${isDark ? 'bg-white/10' : 'bg-cyan-100'}`}>
          <div className="vigo-indeterminate h-full w-1/3 rounded-full bg-cyan-400" />
        </div>
      </div>
    </div>
  );
};
