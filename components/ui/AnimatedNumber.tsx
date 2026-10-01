import React, { useEffect, useRef, useState } from 'react';
import { motion, useSpring, useTransform, AnimatePresence } from 'motion/react';

interface AnimatedNumberProps {
  value: number;
  /** Fixed decimal places. Omit for integers. */
  decimals?: number;
  /** Optional suffix rendered after the number (e.g. "%") */
  suffix?: string;
  className?: string;
  /** Soft scale pulse when value changes */
  pulse?: boolean;
}

/**
 * Displays a number with a brief scale pulse on change.
 * Keeps tabular-nums friendly formatting; no continuous counting
 * (would be distracting for live SOC / speed).
 */
export const AnimatedNumber: React.FC<AnimatedNumberProps> = ({
  value,
  decimals,
  suffix = '',
  className = '',
  pulse = true,
}) => {
  const [pulseKey, setPulseKey] = useState(0);
  const prev = useRef(value);

  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      if (pulse) setPulseKey((k) => k + 1);
    }
  }, [value, pulse]);

  const formatted =
    decimals !== undefined ? value.toFixed(decimals) : String(Math.round(value * 1000) / 1000);

  return (
    <motion.span
      key={pulseKey}
      className={`inline-block tabular-nums ${className}`}
      initial={pulseKey > 0 ? { scale: 1.06, opacity: 0.85 } : false}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 28, mass: 0.6 }}
    >
      {formatted}
      {suffix}
    </motion.span>
  );
};

interface AnimatedPresenceNumberProps {
  value: number | string;
  className?: string;
}

/** Crossfade when a display string/number fully replaces another (e.g. status labels). */
export const FadeSwap: React.FC<AnimatedPresenceNumberProps> = ({ value, className = '' }) => (
  <AnimatePresence mode="wait" initial={false}>
    <motion.span
      key={String(value)}
      className={`inline-block ${className}`}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
    >
      {value}
    </motion.span>
  </AnimatePresence>
);
