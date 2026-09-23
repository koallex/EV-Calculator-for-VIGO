import React, { useEffect, useRef, useState } from 'react';
import { searchAddressSuggestions, AddressSuggestion } from '../services/routeElevation';
import { Loader2 } from 'lucide-react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSelect: (s: AddressSuggestion) => void;
  placeholder: string;
  isDark: boolean;
  inputClassName: string;
  /** Optional leading icon already outside — we only render input + dropdown */
}

export const AddressAutocomplete: React.FC<Props> = ({
  value,
  onChange,
  onSelect,
  placeholder,
  isDark,
  inputClassName,
}) => {
  const [items, setItems] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const blurTimer = useRef<number | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    const q = value.trim();
    if (q.length < 3) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const id = ++reqId.current;
    const timer = window.setTimeout(() => {
      void searchAddressSuggestions(q, 5)
        .then((list) => {
          if (id !== reqId.current) return;
          setItems(list);
          setOpen(list.length > 0);
        })
        .catch(() => {
          if (id !== reqId.current) return;
          setItems([]);
        })
        .finally(() => {
          if (id === reqId.current) setLoading(false);
        });
    }, 380);
    return () => window.clearTimeout(timer);
  }, [value]);

  return (
    <div className="relative w-full">
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (items.length) setOpen(true);
        }}
        onBlur={() => {
          blurTimer.current = window.setTimeout(() => setOpen(false), 180);
        }}
        placeholder={placeholder}
        autoComplete="off"
        className={inputClassName}
      />
      {loading && (
        <Loader2 className="absolute right-12 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-slate-500 pointer-events-none" />
      )}
      {open && items.length > 0 && (
        <ul
          className={`absolute z-30 left-0 right-0 mt-1 max-h-48 overflow-auto rounded-xl border shadow-lg ${
            isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
          }`}
          onMouseDown={(e) => e.preventDefault()}
        >
          {items.map((s) => (
            <li key={`${s.lat},${s.lon},${s.displayName}`}>
              <button
                type="button"
                className={`w-full text-left px-3 py-2.5 text-[12px] leading-snug ${
                  isDark ? 'text-slate-200 hover:bg-slate-800' : 'text-slate-800 hover:bg-slate-50'
                }`}
                onClick={() => {
                  if (blurTimer.current) window.clearTimeout(blurTimer.current);
                  onSelect(s);
                  setOpen(false);
                  setItems([]);
                }}
              >
                {s.displayName}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
