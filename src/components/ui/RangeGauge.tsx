import React from 'react';
import { AnimatedNumber } from './AnimatedNumber';

interface RangeGaugeProps {
  /** 0–100 */
  percent: number;
  size?: number;
  strokeWidth?: number;
  isDark: boolean;
  /** Small caption under the number, e.g. "на финише" */
  caption?: string;
  /** Secondary line under the caption, e.g. "сейчас 54%" */
  subValue?: React.ReactNode;
  className?: string;
}

/**
 * Circular instrument-style readout, replacing a flat "big number" with an
 * animated arc. Same colour thresholds used elsewhere for SOC (danger <20,
 * warn <40, ok otherwise) so it drops in without changing the app's logic —
 * only how the result is displayed.
 */
export function socGaugeColor(percent: number, isDark: boolean): string {
  if (percent < 20) return '#f43f5e'; // rose-500
  if (percent < 40) return '#f59e0b'; // amber-500
  return isDark ? '#22d3ee' : '#0891b2'; // cyan-400 / cyan-600
}

export const RangeGauge: React.FC<RangeGaugeProps> = ({
  percent,
  size = 96,
  strokeWidth = 8,
  isDark,
  caption,
  subValue,
  className = '',
}) => {
  const clamped = Math.max(0, Math.min(100, percent));
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - clamped / 100);
  const color = socGaugeColor(clamped, isDark);

  return (
    <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={isDark ? '#1e293b' : '#e2e8f0'}
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          style={{
            transition: 'stroke-dashoffset 1.1s cubic-bezier(.16,1,.3,1), stroke .3s ease',
            filter: `drop-shadow(0 0 6px ${color}66)`,
          }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center px-1">
        <span
          className="font-mono font-black tabular-nums leading-none"
          style={{ fontSize: size * 0.26, color }}
        >
          <AnimatedNumber value={clamped} decimals={0} suffix="%" />
        </span>
        {caption && (
          <span
            className={`mt-0.5 text-center text-[9px] font-semibold leading-tight ${
              isDark ? 'text-slate-500' : 'text-slate-400'
            }`}
          >
            {caption}
          </span>
        )}
        {subValue && (
          <span className={`text-[10px] font-mono leading-tight ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            {subValue}
          </span>
        )}
      </div>
    </div>
  );
};
