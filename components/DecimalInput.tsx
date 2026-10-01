import React, { useState, useEffect } from 'react';

interface DecimalInputProps {
  id?: string;
  value: number;
  onChange: (val: number) => void;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  disabled?: boolean;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  autoSelectOnFocus?: boolean;
  // iOS's numeric/decimal keyboard has no minus key, so fields that allow negative
  // values (e.g. temperature) need an explicit sign toggle to stay usable on touch.
  allowNegative?: boolean;
}

export const DecimalInput: React.FC<DecimalInputProps> = ({
  id,
  value,
  onChange,
  placeholder = '0',
  min,
  max,
  step,
  className = '',
  disabled = false,
  prefix,
  suffix,
  autoSelectOnFocus = false,
  allowNegative = false,
}) => {
  // Keep local string state to allow natural typing of decimals on iOS/Android (e.g. "0.", "15,5")
  const [text, setText] = useState<string>(() => (value !== undefined && value !== null && !isNaN(value) ? String(value) : ''));
  const [isFocused, setIsFocused] = useState(false);

  // Synchronize when external value changes and input is not being actively typed into
  useEffect(() => {
    if (!isFocused) {
      if (value === undefined || value === null || isNaN(value)) {
        setText('');
      } else {
        setText(String(value));
      }
    }
  }, [value, isFocused]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    // Replace Russian/European comma with standard decimal dot
    const normalized = raw.replace(',', '.');

    // Only allow valid decimal number patterns: e.g. "", "-", "12", "12.", "12.34"
    if (normalized === '' || /^-?\d*\.?\d*$/.test(normalized)) {
      setText(normalized);

      // Parse float if it's a complete number
      if (normalized === '' || normalized === '-' || normalized === '.') {
        // User is mid-typing, keep text
      } else {
        const num = parseFloat(normalized);
        if (!isNaN(num)) {
          let bounded = num;
          if (min !== undefined && num < min && !normalized.endsWith('.')) {
            // keep typing
          }
          if (max !== undefined && num > max) {
            bounded = max;
          }
          onChange(bounded);
        }
      }
    }
  };

  const handleBlur = () => {
    setIsFocused(false);
    const normalized = text.replace(',', '.');
    if (normalized === '' || normalized === '-' || normalized === '.') {
      const fallback = min !== undefined ? min : 0;
      setText(String(fallback));
      onChange(fallback);
      return;
    }

    let num = parseFloat(normalized);
    if (isNaN(num)) {
      num = min !== undefined ? min : 0;
    } else {
      if (min !== undefined && num < min) num = min;
      if (max !== undefined && num > max) num = max;
    }
    setText(String(num));
    onChange(num);
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    setIsFocused(true);
    if (autoSelectOnFocus) {
      e.target.select();
    }
  };

  // iOS's "decimal" software keyboard never shows a minus key, so typing a negative
  // value (e.g. -15°C) is impossible on a phone even though the field logically
  // supports it (min < 0). Give those fields an explicit sign-toggle button instead.
  const toggleSign = () => {
    const current = parseFloat((text || '0').replace(',', '.'));
    const base = isNaN(current) ? 0 : current;
    const flipped = base === 0 ? base : -base;
    const bounded = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, flipped));
    setText(String(bounded));
    onChange(bounded);
  };

  const showSignToggle = allowNegative && !disabled;

  return (
    <div className="relative flex items-center w-full">
      {showSignToggle && (
        <button
          type="button"
          tabIndex={-1}
          onClick={toggleSign}
          aria-label="Сменить знак"
          className="absolute left-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-md text-xs font-bold text-slate-400 hover:text-slate-200 active:scale-90 transition-all"
        >
          ±
        </button>
      )}
      {prefix && !showSignToggle && (
        <div className="absolute left-3 pointer-events-none flex items-center z-10">
          {prefix}
        </div>
      )}
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        autoCorrect="off"
        spellCheck="false"
        disabled={disabled}
        value={text}
        placeholder={placeholder}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        className={`${prefix || showSignToggle ? 'pl-9 ' : ''}${suffix ? 'pr-12 ' : ''}${className}`}
      />
      {suffix && (
        <div className="absolute right-3 pointer-events-none flex items-center text-xs font-semibold opacity-60 z-10">
          {suffix}
        </div>
      )}
    </div>
  );
};
