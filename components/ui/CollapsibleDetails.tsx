import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown } from 'lucide-react';

interface CollapsibleDetailsProps {
  isDark: boolean;
  label: React.ReactNode;
  icon?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  className?: string;
}

// Единый паттерн "подробнее" для всего проекта: заголовок-кнопка со стрелкой + содержимое,
// раскрывающееся по тапу. Заменяет разные варианты сворачиваемых блоков в HUD/Calculator
// одним переиспользуемым компонентом, чтобы карточка выглядела и вела себя одинаково
// на любой вкладке.
export const CollapsibleDetails: React.FC<CollapsibleDetailsProps> = ({
  isDark,
  label,
  icon,
  open,
  onToggle,
  children,
  className = '',
}) => (
  <div className={className}>
    <button
      type="button"
      onClick={onToggle}
      className={`w-full flex items-center justify-between rounded-xl border px-3 py-3 text-sm font-bold transition-colors active:scale-[0.99] ${
        isDark ? 'bg-slate-950 border-slate-800 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-700'
      }`}
    >
      <span className="inline-flex items-center gap-2">{icon}{label}</span>
      <motion.span
        animate={{ rotate: open ? 180 : 0 }}
        transition={{ type: 'spring', stiffness: 400, damping: 28 }}
        className="inline-flex shrink-0"
      >
        <ChevronDown className="w-4 h-4" />
      </motion.span>
    </button>
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="content"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          <div className="mt-2">{children}</div>
        </motion.div>
      )}
    </AnimatePresence>
  </div>
);

interface SecondaryStat {
  label: React.ReactNode;
  value: React.ReactNode;
}

// Компактная строка из 2-3 вторичных чисел под главным показателем — вместо сетки
// одинаковых по весу плиток. Используется, когда значения важны сразу, но не главные.
export const SecondaryStatRow: React.FC<{ items: SecondaryStat[]; isDark: boolean; className?: string }> = ({
  items,
  isDark,
  className = '',
}) => (
  <div className={`flex justify-center gap-6 flex-wrap py-1 ${className}`}>
    {items.map((item, i) => (
      <div key={i} className="text-center">
        <div className={`text-lg font-bold font-mono leading-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
          {item.value}
        </div>
        <div className={`text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{item.label}</div>
      </div>
    ))}
  </div>
);

// Компактная строка чипов для контекстных факторов (погода, стиль, климат) — используется
// внутри CollapsibleDetails вместо таблицы или сетки плиток с рамками.
export const ChipRow: React.FC<{ items: SecondaryStat[]; isDark: boolean; className?: string }> = ({
  items,
  isDark,
  className = '',
}) => (
  <div className={`flex flex-wrap gap-1.5 ${className}`}>
    {items.map((item, i) => (
      <span
        key={i}
        className={`text-[11px] px-2.5 py-1.5 rounded-full border ${
          isDark ? 'bg-slate-900 border-slate-800 text-slate-300' : 'bg-white border-slate-200 text-slate-600'
        }`}
      >
        {item.label} <b className={isDark ? 'text-white' : 'text-slate-900'}>{item.value}</b>
      </span>
    ))}
  </div>
);
