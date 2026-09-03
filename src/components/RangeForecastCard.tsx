import React, { useState } from 'react';
import {
  Compass,
  Zap,
  ShieldCheck,
  TrendingUp,
  AlertTriangle,
  Info,
  Car,
} from 'lucide-react';
import { UserSettings } from '../types';
import { triggerHaptic } from '../utils/haptics';

interface RangeForecastCardProps {
  settings?: UserSettings;
  theme?: 'dark' | 'light';
  currentConsumption?: number; // in kWh/100km
  consumptionPer100Km?: number; // alias for currentConsumption
  currentSoc?: number; // Current remaining battery %
  endSoc?: number; // alias for currentSoc
  batteryCapacityKwh?: number;
}

export const RangeForecastCard: React.FC<RangeForecastCardProps> = ({
  settings,
  theme,
  currentConsumption,
  consumptionPer100Km,
  currentSoc,
  endSoc,
  batteryCapacityKwh,
}) => {
  const activeTheme = theme || settings?.theme || 'dark';
  const isDark = activeTheme !== 'light';
  const batteryCap = batteryCapacityKwh || settings?.batteryCapacityKwh || 51.87;
  const initialSoc = currentSoc ?? endSoc ?? 50;

  // Local override if driver wants to test "what if I have X% SoC"
  const [customSoc, setCustomSoc] = useState<number | null>(null);

  const activeSoc = customSoc !== null ? customSoc : initialSoc;
  const remainingEnergyKwh = (activeSoc / 100) * batteryCap;

  // Baseline calculated range with current consumption
  const effectiveConsInput = currentConsumption ?? consumptionPer100Km ?? 15.5;
  const effectiveConsumption = effectiveConsInput > 0 ? effectiveConsInput : 15.5;
  const calculatedRangeKm = (remainingEnergyKwh / effectiveConsumption) * 100;

  // Safe buffer range: reserve until 10% battery
  const safeSoc = Math.max(0, activeSoc - 10);
  const safeEnergyKwh = (safeSoc / 100) * batteryCap;
  const safeRangeKm = (safeEnergyKwh / effectiveConsumption) * 100;

  // Scenarios for different driving conditions with Dongfeng Vigo
  const scenarios = [
    {
      id: 'eco_city',
      title: 'Город / ЭКО',
      icon: '🏙️',
      rate: 13.0,
      description: 'До 60 км/ч, плавный разгон, без резких ускорений',
      range: (remainingEnergyKwh / 13.0) * 100,
    },
    {
      id: 'current',
      title: 'Текущий темп',
      icon: '⚡',
      rate: effectiveConsumption,
      description: `Расчет по вашим данным (${effectiveConsumption.toFixed(1)} кВт⋅ч/100км)`,
      range: calculatedRangeKm,
      isCurrent: true,
    },
    {
      id: 'highway',
      title: 'Трасса 105-115 км/ч',
      icon: '🛣️',
      rate: 18.5,
      description: 'Высокая скорость, аэродинамическое сопротивление',
      range: (remainingEnergyKwh / 18.5) * 100,
    },
    {
      id: 'winter',
      title: 'Зима / Обогрев',
      icon: '❄️',
      rate: 22.0,
      description: 'Минусовая температура, активная печка и подогревы',
      range: (remainingEnergyKwh / 22.0) * 100,
    },
  ];

  const handleSocPreset = (soc: number) => {
    triggerHaptic('light', settings?.hapticFeedback ?? true);
    setCustomSoc(soc === initialSoc ? null : soc);
  };

  return (
    <div
      id="range-forecast-card"
      className={`border rounded-3xl p-4 sm:p-5 shadow-xl space-y-4 transition-colors ${
        isDark ? 'bg-slate-900/90 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`p-2 rounded-xl ${isDark ? 'bg-emerald-500/15 text-emerald-400' : 'bg-emerald-50 text-emerald-600'}`}>
            <Compass className="w-5 h-5" />
          </div>
          <div>
            <h3 className={`text-sm font-bold tracking-wide ${isDark ? 'text-white' : 'text-slate-900'}`}>
              Расчетный остаток км
            </h3>
            <p className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Прогноз запаса хода при текущем расходе и заряде
            </p>
          </div>
        </div>

        {customSoc !== null && (
          <button
            onClick={() => setCustomSoc(null)}
            className={`text-[11px] px-2.5 py-1 rounded-lg border font-medium active:scale-95 transition-all ${
              isDark
                ? 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
                : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300'
            }`}
          >
            Сброс к {Math.round(currentSoc ?? 0)}%
          </button>
        )}
      </div>

      {/* Main Forecast Hero Panel */}
      <div className={`p-4 rounded-2xl border transition-all ${
        isDark
          ? 'bg-gradient-to-br from-emerald-950/40 via-slate-950 to-slate-950 border-emerald-500/30 shadow-inner'
          : 'bg-gradient-to-br from-emerald-50/80 to-teal-50/40 border-emerald-200 shadow-xs'
      }`}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <span className={`text-[11px] font-bold uppercase tracking-wider block mb-1 ${
              isDark ? 'text-emerald-300' : 'text-emerald-800'
            }`}>
              Прогнозируемый остаток хода:
            </span>
            <div className="flex items-baseline gap-2">
              <span className={`text-4xl sm:text-5xl font-black font-mono tracking-tight ${
                isDark ? 'text-emerald-400' : 'text-emerald-600'
              }`}>
                {Math.round(calculatedRangeKm)}
              </span>
              <span className={`text-base font-bold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                км
              </span>
            </div>
            <p className={`text-xs mt-1 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
              при расходе <span className="font-semibold text-emerald-500">{effectiveConsumption.toFixed(1)} кВт⋅ч/100км</span>
            </p>
          </div>

          {/* Quick info boxes on right */}
          <div className="grid grid-cols-2 sm:flex sm:flex-col gap-2 min-w-[170px]">
            <div className={`p-2.5 rounded-xl border ${
              isDark ? 'bg-slate-900/80 border-slate-800' : 'bg-white border-emerald-200/80 shadow-xs'
            }`}>
              <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-slate-400">
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                <span>Остаток энергии:</span>
              </div>
              <div className={`text-base font-extrabold font-mono mt-0.5 ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                {remainingEnergyKwh.toFixed(1)} <span className="text-xs font-normal">кВт⋅ч</span> ({Math.round(activeSoc)}%)
              </div>
            </div>

            <div className={`p-2.5 rounded-xl border ${
              isDark ? 'bg-slate-900/80 border-slate-800' : 'bg-white border-emerald-200/80 shadow-xs'
            }`}>
              <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-slate-400">
                <ShieldCheck className="w-3.5 h-3.5 text-teal-400" />
                <span>До буфера 10%:</span>
              </div>
              <div className={`text-base font-extrabold font-mono mt-0.5 ${isDark ? 'text-teal-300' : 'text-teal-700'}`}>
                {Math.round(safeRangeKm)} <span className="text-xs font-normal">км</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Quick battery test selector */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className={`font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
            Остаток заряда батареи (SoC):
          </span>
          <span className={`font-mono font-bold ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
            {Math.round(activeSoc)}% ({remainingEnergyKwh.toFixed(1)} кВт⋅ч)
          </span>
        </div>

        {/* Range Slider for Interactive What-If testing */}
        <input
          type="range"
          min={1}
          max={100}
          value={activeSoc}
          onChange={(e) => {
            setCustomSoc(Number(e.target.value));
            triggerHaptic('light', settings.hapticFeedback);
          }}
          className="w-full accent-emerald-500 h-2 bg-slate-800 rounded-lg cursor-pointer"
        />

        {/* SoC Quick Buttons */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none pt-0.5">
          <span className={`text-[10px] font-semibold shrink-0 mr-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            Уровень:
          </span>
          {[10, 20, 30, 45, 60, 80, 100].map((soc) => (
            <button
              key={soc}
              onClick={() => handleSocPreset(soc)}
              className={`px-2 py-1 rounded-lg text-xs font-mono font-semibold border shrink-0 active:scale-95 transition-all ${
                activeSoc === soc
                  ? isDark
                    ? 'bg-emerald-500 text-slate-950 border-emerald-400 font-bold'
                    : 'bg-emerald-600 text-white border-emerald-700 font-bold shadow-xs'
                  : isDark
                  ? 'bg-slate-950 hover:bg-slate-800 text-slate-300 border-slate-800'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200'
              }`}
            >
              {soc}%
            </button>
          ))}
        </div>
      </div>

      {/* Comparison Grid: Range under different driving styles */}
      <div className="space-y-2 pt-1">
        <span className={`text-xs font-bold uppercase tracking-wider block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          Прогноз хода при разных стилях езды ({remainingEnergyKwh.toFixed(1)} кВт⋅ч):
        </span>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {scenarios.map((sc) => (
            <div
              key={sc.id}
              className={`p-3 rounded-2xl border flex items-center justify-between transition-all ${
                sc.isCurrent
                  ? isDark
                    ? 'bg-emerald-950/40 border-emerald-500/50 shadow-sm'
                    : 'bg-emerald-50/70 border-emerald-300 shadow-xs'
                  : isDark
                  ? 'bg-slate-950/60 border-slate-800/80 hover:border-slate-700'
                  : 'bg-slate-50 border-slate-200 hover:bg-slate-100/80'
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="text-xl shrink-0">{sc.icon}</span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-xs font-bold truncate ${
                      sc.isCurrent
                        ? isDark ? 'text-emerald-300' : 'text-emerald-800'
                        : isDark ? 'text-white' : 'text-slate-900'
                    }`}>
                      {sc.title}
                    </span>
                    {sc.isCurrent && (
                      <span className={`text-[9px] px-1.5 py-0.2 rounded font-bold uppercase ${
                        isDark ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-100 text-emerald-800'
                      }`}>
                        Текущий
                      </span>
                    )}
                  </div>
                  <span className={`text-[10px] block truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    ~{sc.rate.toFixed(1)} кВт⋅ч/100км
                  </span>
                </div>
              </div>

              <div className="text-right shrink-0 pl-2">
                <div className={`text-lg font-black font-mono ${
                  sc.isCurrent
                    ? isDark ? 'text-emerald-400' : 'text-emerald-600'
                    : isDark ? 'text-slate-200' : 'text-slate-800'
                }`}>
                  ~{Math.round(sc.range)} <span className="text-xs font-normal">км</span>
                </div>
                <span className={`text-[10px] ${
                  sc.range >= calculatedRangeKm
                    ? isDark ? 'text-emerald-400' : 'text-emerald-600'
                    : isDark ? 'text-rose-400' : 'text-rose-600'
                }`}>
                  {sc.range >= calculatedRangeKm ? '+' : ''}
                  {Math.round(sc.range - calculatedRangeKm)} км
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
