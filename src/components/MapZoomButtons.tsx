import React from 'react';
import { Minus, Plus } from 'lucide-react';

/**
 * Крупные кнопки «+» / «−» для карты. Нужны там, где нет мультитача (CarPlay и т.п.) и щипком не приблизить.
 * Только отрисовка: позицию задаёт вызывающий компонент, сам масштаб меняет `zoomMapBundle` (utils/mapZoom).
 * Размер задаётся в index.css (.map-zoom-btn): 56 px, на низких ландшафтных экранах — компактнее.
 */
export const MapZoomButtons: React.FC<{
  onZoom: (delta: number) => void;
  isDark: boolean;
  disabled?: boolean;
  className?: string;
}> = ({ onZoom, isDark, disabled = false, className = '' }) => (
  <div className={`map-zoom-group pointer-events-auto flex select-none flex-col gap-2 ${className}`}>
    {([
      { delta: 1, label: 'Увеличить масштаб карты', Icon: Plus },
      { delta: -1, label: 'Уменьшить масштаб карты', Icon: Minus },
    ] as const).map(({ delta, label, Icon }) => (
      <button
        key={delta}
        type="button"
        disabled={disabled}
        onClick={() => onZoom(delta)}
        aria-label={label}
        title={label}
        className={`map-zoom-btn flex h-14 w-14 touch-manipulation items-center justify-center rounded-2xl border shadow-xl active:scale-95 disabled:opacity-40 ${
          isDark ? 'border-slate-600 bg-slate-900/90 text-slate-100' : 'border-slate-300 bg-white/95 text-slate-800'
        }`}
      >
        <Icon className="h-7 w-7" strokeWidth={2.5} />
      </button>
    ))}
  </div>
);
