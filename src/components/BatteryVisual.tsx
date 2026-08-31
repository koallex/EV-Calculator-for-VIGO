import React from 'react';

interface BatteryVisualProps {
  currentPercent: number;
  startPercent?: number;
  capacityKwh: number;
  className?: string;
  showAnimation?: boolean;
  theme?: 'dark' | 'light' | 'oled';
}

export const BatteryVisual: React.FC<BatteryVisualProps> = ({
  currentPercent,
  startPercent,
  capacityKwh,
  className = '',
  theme = 'dark',
}) => {
  const isDark = theme !== 'light';
  const clampedCurrent = Math.max(0, Math.min(100, currentPercent));
  const remainingKwh = ((clampedCurrent / 100) * capacityKwh).toFixed(1);

  // Color gradient according to battery percentage
  const getBatteryColor = (pct: number) => {
    if (pct > 50) return 'from-emerald-500 to-teal-500 text-emerald-400';
    if (pct > 25) return 'from-amber-500 to-yellow-400 text-amber-400';
    return 'from-rose-500 to-red-600 text-rose-400';
  };

  const getBorderGlow = (pct: number) => {
    if (isDark) {
      if (pct > 50) return 'border-emerald-500/40 shadow-emerald-500/10';
      if (pct > 25) return 'border-amber-500/40 shadow-amber-500/10';
      return 'border-rose-500/40 shadow-rose-500/20';
    }
    if (pct > 50) return 'border-emerald-300 shadow-sm';
    if (pct > 25) return 'border-amber-300 shadow-sm';
    return 'border-rose-300 shadow-sm';
  };

  return (
    <div id="battery-visual-container" className={`relative flex items-center gap-3 ${className}`}>
      {/* Battery outline container */}
      <div
        className={`relative flex-1 h-11 rounded-xl p-1 border shadow-md flex items-center transition-colors ${
          isDark ? 'bg-slate-900/90' : 'bg-slate-100 border-slate-300'
        } ${getBorderGlow(clampedCurrent)}`}
      >
        {/* Fill bar */}
        <div
          className={`h-full rounded-lg bg-gradient-to-r ${getBatteryColor(
            clampedCurrent
          )} transition-all duration-500 relative flex items-center justify-end px-2 overflow-hidden shadow-inner`}
          style={{ width: `${Math.max(6, clampedCurrent)}%` }}
        >
          {/* Subtle shine effect */}
          <div className="absolute inset-0 bg-white/15 opacity-60" />
        </div>

        {/* Center label inside battery */}
        <div className="absolute inset-0 flex items-center justify-between px-3.5 pointer-events-none">
          <span className={`text-xs font-bold drop-shadow flex items-center gap-1.5 ${
            isDark ? 'text-white' : 'text-slate-900'
          }`}>
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-sm" />
            {remainingKwh} кВт⋅ч
          </span>
          <span className={`text-sm font-extrabold font-mono drop-shadow tracking-tight ${
            isDark ? 'text-white' : 'text-slate-900'
          }`}>
            {clampedCurrent}%
          </span>
        </div>
      </div>

      {/* Battery terminal tip */}
      <div className={`w-1.5 h-5 rounded-r-sm shadow-xs ${isDark ? 'bg-slate-700' : 'bg-slate-400'}`} />
    </div>
  );
};

