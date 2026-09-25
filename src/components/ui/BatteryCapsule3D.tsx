import React, { useRef, useState } from 'react';
import { motion } from 'motion/react';

interface BatteryCapsule3DProps {
  /** 0–100 */
  percent: number;
  isDark: boolean;
  width?: number;
  height?: number;
  className?: string;
}

function fillColors(percent: number): [string, string] {
  if (percent < 20) return ['#fb7185', '#be123c'];
  if (percent < 40) return ['#fbbf24', '#b45309'];
  return ['#22d3ee', '#0891b2'];
}

const REST_TILT = { ry: -14, rx: 5 };

/**
 * Vertical "instrument" battery: a tilted 3D capsule with a liquid fill,
 * instead of the flat horizontal bar used for the interactive charge slider.
 * Meant for read-only display contexts (current charge state), not for the
 * draggable target-SoC control in ChargingTab, which keeps BatteryVisual.
 */
export const BatteryCapsule3D: React.FC<BatteryCapsule3DProps> = ({
  percent,
  isDark,
  width = 72,
  height = 112,
  className = '',
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState(REST_TILT);
  const clamped = Math.max(0, Math.min(100, percent));
  const [c1, c2] = fillColors(clamped);

  const handleMove = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    setTilt({ ry: REST_TILT.ry + px * 20, rx: REST_TILT.rx - py * 14 });
  };
  const reset = () => setTilt(REST_TILT);

  return (
    <div style={{ perspective: 900 }} className={className}>
      <div
        ref={ref}
        onPointerMove={handleMove}
        onPointerLeave={reset}
        style={{
          width,
          height,
          borderRadius: 16,
          position: 'relative',
          transform: `rotateY(${tilt.ry}deg) rotateX(${tilt.rx}deg)`,
          transition: 'transform .5s cubic-bezier(.16,1,.3,1)',
          background: isDark
            ? 'linear-gradient(160deg,#131e2f,#0d1420)'
            : 'linear-gradient(160deg,#ffffff,#f1f5f9)',
          border: `1px solid ${isDark ? '#1c2940' : '#dbe3ef'}`,
          boxShadow: '18px 22px 36px -18px rgba(0,0,0,.45)',
        }}
      >
        {/* glass highlight */}
        <div
          style={{
            position: 'absolute',
            inset: 1,
            borderRadius: 15,
            pointerEvents: 'none',
            background: 'linear-gradient(115deg, rgba(255,255,255,.12), transparent 40%)',
          }}
        />
        <motion.div
          initial={false}
          animate={{ height: `${Math.max(4, clamped)}%` }}
          transition={{ type: 'spring', stiffness: 90, damping: 20, mass: 0.9 }}
          style={{
            position: 'absolute',
            left: 6,
            right: 6,
            bottom: 6,
            borderRadius: 10,
            background: `linear-gradient(180deg, ${c1}, ${c2})`,
            boxShadow: `0 0 16px ${c1}80`,
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: -1,
              left: 0,
              right: 0,
              height: 3,
              background: 'rgba(255,255,255,.5)',
              borderRadius: 2,
            }}
          />
        </motion.div>
        <div className="absolute inset-x-0 bottom-1 flex justify-center pointer-events-none">
          <span
            className="font-mono font-bold text-[11px] drop-shadow"
            style={{ color: clamped > 45 ? '#ffffff' : isDark ? '#e8eef7' : '#0b1220' }}
          >
            {Math.round(clamped)}%
          </span>
        </div>
      </div>
    </div>
  );
};
