import React, { useState } from 'react';
import {
  BatteryCharging,
  Zap,
  Coins,
  Sparkles,
  Percent,
} from 'lucide-react';
import { UserSettings } from '../types';
import { getOperatorLabel } from '../utils/storage';
import { BatteryVisual } from './BatteryVisual';
import { DecimalInput } from './DecimalInput';
import { triggerHaptic } from '../utils/haptics';

interface ChargingTabProps {
  settings: UserSettings;
}

export const ChargingTab: React.FC<ChargingTabProps> = ({ settings }) => {
  const [calcMode, setCalcMode] = useState<'soc' | 'kwh'>('soc');
  const [currentSoc, setCurrentSoc] = useState<number>(20);
  const [targetSoc, setTargetSoc] = useState<number>(80);
  const [manualKwh, setManualKwh] = useState<number>(25);
  const [lossPercent, setLossPercent] = useState<number>(8); // Default 8% charging loss
  const [selectedTariff, setSelectedTariff] = useState<
    'malanka_dc' | 'evika' | 'batteryfly' | 'zaryadka_day' | 'zaryadka_night' | 'home_night' | 'home' | 'custom'
  >('malanka_dc');
  const [customTariffRate, setCustomTariffRate] = useState<number>(
    settings.malankaDcTariff ?? settings.fastDayTariff
  );

  const batteryCap = settings.batteryCapacityKwh || 51.87;

  // Calculate net kWh into battery
  const deltaPercent = Math.max(0, targetSoc - currentSoc);
  const netEnergyKwh = calcMode === 'soc'
    ? (deltaPercent / 100) * batteryCap
    : manualKwh;

  // Calculate gross kWh consumed from station meter (accounting for efficiency loss)
  const lossKwh = lossPercent > 0
    ? Number(((netEnergyKwh / (1 - lossPercent / 100)) - netEnergyKwh).toFixed(2))
    : 0;
  const grossEnergyKwh = Number((netEnergyKwh + lossKwh).toFixed(2));

  // Active tariff rate
  let activeTariffRate = settings.malankaDcTariff ?? settings.fastDayTariff;
  if (selectedTariff === 'evika') {
    activeTariffRate = settings.evikaTariff ?? settings.malankaAcTariff ?? settings.slowPublicTariff;
  } else if (selectedTariff === 'batteryfly') {
    activeTariffRate = settings.batteryFlyTariff ?? 0.6;
  } else if (selectedTariff === 'zaryadka_day') {
    activeTariffRate = settings.zaryadkaDayTariff ?? settings.zaryadkaTariff ?? settings.zaryadkaDcTariff ?? 0.56;
  } else if (selectedTariff === 'zaryadka_night') {
    activeTariffRate = settings.zaryadkaNightTariff ?? 0.43;
  } else if (selectedTariff === 'home_night') {
    activeTariffRate = settings.homeNightTariff ?? 0.16;
  } else if (selectedTariff === 'home') {
    activeTariffRate = settings.homeTariff;
  } else if (selectedTariff === 'custom') {
    activeTariffRate = customTariffRate;
  }

  // Total cost billed at the station (by gross kWh)
  const totalCost = Number((grossEnergyKwh * activeTariffRate).toFixed(2));
  const netCost = Number((netEnergyKwh * activeTariffRate).toFixed(2));
  const lossCost = Number((lossKwh * activeTariffRate).toFixed(2));

  // Est range added (assuming ~15.0 kWh/100km)
  const estRangeAddedKm = netEnergyKwh > 0 ? (netEnergyKwh / 15.0) * 100 : 0;

  const isDark = settings.theme !== 'light';

  return (
    <div id="charging-tab-container" className="space-y-4 pb-12 max-w-2xl mx-auto">
      {/* 1. Main Result Display (Energy & Total Cost with Station Losses) */}
      <div
        className={`border rounded-2xl p-4 space-y-4 transition-colors ${
          isDark
            ? 'bg-slate-900/60 border-slate-800/80'
            : 'bg-white border-slate-200/80 shadow-xs'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className={`p-2 rounded-xl shrink-0 ${
                isDark ? 'bg-emerald-500/15 text-emerald-400' : 'bg-emerald-50 text-emerald-600'
              }`}
            >
              <BatteryCharging className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className={`text-sm font-bold tracking-tight truncate ${isDark ? 'text-white' : 'text-slate-900'}`}>
                Калькулятор зарядки ЭЗС
              </h2>
              <p className={`text-[11px] truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Dongfeng Vigo ({batteryCap} кВт⋅ч)
              </p>
            </div>
          </div>

          <div
            className={`flex p-1 rounded-xl border shrink-0 ${
              isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-100 border-slate-200'
            }`}
          >
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light', settings.hapticFeedback);
                setCalcMode('soc');
              }}
              className={`px-2.5 sm:px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                calcMode === 'soc'
                  ? 'bg-emerald-600 text-white shadow-xs font-bold'
                  : isDark
                  ? 'text-slate-400 hover:text-white'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              По %
            </button>
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light', settings.hapticFeedback);
                setCalcMode('kwh');
              }}
              className={`px-2.5 sm:px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                calcMode === 'kwh'
                  ? 'bg-emerald-600 text-white shadow-xs font-bold'
                  : isDark
                  ? 'text-slate-400 hover:text-white'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              По кВт⋅ч
            </button>
          </div>
        </div>

        {/* Clean Stats Grid */}
        <div className="grid grid-cols-2 gap-3">
          <div
            className={`border rounded-xl p-3.5 flex flex-col justify-between transition-colors ${
              isDark ? 'bg-slate-950/70 border-slate-800' : 'bg-slate-50 border-slate-200/90 shadow-xs'
            }`}
          >
            <span
              className={`text-[11px] font-semibold uppercase tracking-wider flex items-center gap-1.5 ${
                isDark ? 'text-slate-400' : 'text-slate-500'
              }`}
            >
              <Zap className={`w-3.5 h-3.5 ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`} />
              Энергия
            </span>
            <div className="mt-2">
              <div className={`text-2xl sm:text-3xl font-extrabold font-mono ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                {grossEnergyKwh.toFixed(1)}
              </div>
              <span className={`text-[11px] block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                кВт⋅ч со счетчика ЭЗС
              </span>
              {lossPercent > 0 && (
                <span className={`text-[10px] block mt-0.5 ${isDark ? 'text-emerald-400/80' : 'text-emerald-700'}`}>
                  (в батарею: {netEnergyKwh.toFixed(1)} + {lossKwh.toFixed(1)} потери)
                </span>
              )}
            </div>
          </div>

          <div
            className={`border rounded-xl p-3.5 flex flex-col justify-between transition-colors ${
              isDark ? 'bg-slate-950/70 border-slate-800' : 'bg-slate-50 border-slate-200/90 shadow-xs'
            }`}
          >
            <span
              className={`text-[11px] font-semibold uppercase tracking-wider flex items-center gap-1.5 ${
                isDark ? 'text-slate-400' : 'text-slate-500'
              }`}
            >
              <Coins className={`w-3.5 h-3.5 ${isDark ? 'text-amber-400' : 'text-amber-600'}`} />
              Стоимость
            </span>
            <div className="mt-2">
              <div className={`text-2xl sm:text-3xl font-extrabold font-mono ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                {totalCost.toFixed(2)}
              </div>
              <span className={`text-[11px] block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {settings.currency} (по {activeTariffRate} {settings.currency}/кВт⋅ч)
              </span>
              {lossPercent > 0 && (
                <span className={`text-[10px] block mt-0.5 ${isDark ? 'text-amber-400/80' : 'text-amber-700'}`}>
                  (включая {lossCost.toFixed(2)} {settings.currency} потерь)
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Range boost highlight */}
        <div
          className={`p-3 rounded-xl border flex items-center justify-between transition-colors ${
            isDark
              ? 'bg-teal-950/25 border-teal-800/40 text-teal-300'
              : 'bg-teal-50 border-teal-200 text-teal-900'
          }`}
        >
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-teal-500 shrink-0" />
            <div>
              <div className="text-xs font-bold">Прибавит к запасу хода:</div>
              <div className={`text-[10px] ${isDark ? 'text-teal-400/80' : 'text-teal-700'}`}>
                при среднем расходе ~15.0 кВт⋅ч/100км
              </div>
            </div>
          </div>
          <div className="text-sm font-extrabold font-mono">
            +{estRangeAddedKm.toFixed(0)} км
          </div>
        </div>
      </div>

      {/* 2. Interactive Input Controls */}
      {calcMode === 'soc' ? (
        <div
          className={`border rounded-2xl p-4 space-y-4 transition-colors ${
            isDark
              ? 'bg-slate-900/60 border-slate-800/80'
              : 'bg-white border-slate-200/80 shadow-xs'
          }`}
        >
          <BatteryVisual currentPercent={targetSoc} capacityKwh={batteryCap} theme={settings.theme} />

          {/* Current SoC */}
          <div
            className={`p-3 rounded-xl border space-y-2 ${
              isDark ? 'bg-slate-950/60 border-slate-800' : 'bg-slate-50/80 border-slate-200'
            }`}
          >
            <div className="flex items-center justify-between text-xs">
              <span className={`font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                Текущий процент (Старт):
              </span>
              <span className={`font-bold font-mono ${isDark ? 'text-teal-400' : 'text-teal-600'}`}>
                {currentSoc}% ({((currentSoc / 100) * batteryCap).toFixed(1)} кВт⋅ч)
              </span>
            </div>

            <input
              type="range"
              min={0}
              max={targetSoc - 1}
              value={currentSoc}
              onChange={(e) => {
                setCurrentSoc(Number(e.target.value));
                triggerHaptic('light', settings.hapticFeedback);
              }}
              className="w-full accent-emerald-500 h-2 bg-slate-800 rounded-lg cursor-pointer"
            />

            <div className="flex items-center justify-between gap-1.5 pt-1">
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light', settings.hapticFeedback);
                  setCurrentSoc((p) => Math.max(0, p - 5));
                }}
                className={`flex-1 py-1 rounded-lg border text-xs font-semibold active:scale-95 transition-all ${
                  isDark
                    ? 'bg-slate-900 border-slate-800 text-slate-300'
                    : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100 shadow-xs'
                }`}
              >
                -5%
              </button>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light', settings.hapticFeedback);
                  setCurrentSoc(10);
                }}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold border ${
                  currentSoc === 10
                    ? 'bg-emerald-600 text-white border-emerald-600 font-bold'
                    : isDark
                    ? 'bg-slate-900 text-slate-400 border-slate-800'
                    : 'bg-white text-slate-600 border-slate-200'
                }`}
              >
                10%
              </button>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light', settings.hapticFeedback);
                  setCurrentSoc(20);
                }}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold border ${
                  currentSoc === 20
                    ? 'bg-emerald-600 text-white border-emerald-600 font-bold'
                    : isDark
                    ? 'bg-slate-900 text-slate-400 border-slate-800'
                    : 'bg-white text-slate-600 border-slate-200'
                }`}
              >
                20%
              </button>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light', settings.hapticFeedback);
                  setCurrentSoc((p) => Math.min(targetSoc - 1, p + 5));
                }}
                className={`flex-1 py-1 rounded-lg border text-xs font-semibold active:scale-95 transition-all ${
                  isDark
                    ? 'bg-slate-900 border-slate-800 text-slate-300'
                    : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100 shadow-xs'
                }`}
              >
                +5%
              </button>
            </div>
          </div>

          {/* Target SoC */}
          <div
            className={`p-3 rounded-xl border space-y-2 ${
              isDark ? 'bg-slate-950/60 border-slate-800' : 'bg-slate-50/80 border-slate-200'
            }`}
          >
            <div className="flex items-center justify-between text-xs">
              <span className={`font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                Целевой заряд (Финиш):
              </span>
              <div className="flex items-center gap-1.5">
                <span className={`font-bold font-mono ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                  {targetSoc}% ({((targetSoc / 100) * batteryCap).toFixed(1)} кВт⋅ч)
                </span>
                {targetSoc === 80 && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-semibold ${
                    isDark
                      ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                      : 'bg-emerald-50 text-emerald-700 border-emerald-300'
                  }`}>
                    80% Оптимум
                  </span>
                )}
              </div>
            </div>

            <input
              type="range"
              min={currentSoc + 1}
              max={100}
              value={targetSoc}
              onChange={(e) => {
                setTargetSoc(Number(e.target.value));
                triggerHaptic('light', settings.hapticFeedback);
              }}
              className="w-full accent-emerald-500 h-2 bg-slate-800 rounded-lg cursor-pointer"
            />

            <div className="flex items-center justify-between gap-1.5 pt-1">
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light', settings.hapticFeedback);
                  setTargetSoc((p) => Math.max(currentSoc + 1, p - 5));
                }}
                className={`flex-1 py-1 rounded-lg border text-xs font-semibold active:scale-95 transition-all ${
                  isDark
                    ? 'bg-slate-900 border-slate-800 text-slate-300'
                    : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100 shadow-xs'
                }`}
              >
                -5%
              </button>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light', settings.hapticFeedback);
                  setTargetSoc(80);
                }}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold border ${
                  targetSoc === 80
                    ? 'bg-emerald-600 text-white border-emerald-600 font-bold'
                    : isDark
                    ? 'bg-slate-900 text-slate-400 border-slate-800'
                    : 'bg-white text-slate-600 border-slate-200'
                }`}
              >
                80%
              </button>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light', settings.hapticFeedback);
                  setTargetSoc(100);
                }}
                className={`px-2.5 py-1 rounded-lg text-xs font-semibold border ${
                  targetSoc === 100
                    ? 'bg-emerald-600 text-white border-emerald-600 font-bold'
                    : isDark
                    ? 'bg-slate-900 text-slate-400 border-slate-800'
                    : 'bg-white text-slate-600 border-slate-200'
                }`}
              >
                100%
              </button>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light', settings.hapticFeedback);
                  setTargetSoc((p) => Math.min(100, p + 5));
                }}
                className={`flex-1 py-1 rounded-lg border text-xs font-semibold active:scale-95 transition-all ${
                  isDark
                    ? 'bg-slate-900 border-slate-800 text-slate-300'
                    : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100 shadow-xs'
                }`}
              >
                +5%
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Manual kWh Entry with DecimalInput */
        <div
          className={`border rounded-2xl p-4 space-y-3 transition-colors ${
            isDark
              ? 'bg-slate-900/60 border-slate-800/80'
              : 'bg-white border-slate-200/80 shadow-xs'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className={`text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Количество киловатт-часов:
            </span>
            <div className="w-28">
              <DecimalInput
                value={manualKwh}
                onChange={(val) => setManualKwh(Math.max(0.1, val))}
                suffix="кВт⋅ч"
                className={`w-full text-right px-2 py-1 rounded-lg text-base font-bold font-mono focus:outline-none border ${
                  isDark
                    ? 'bg-slate-950 border-slate-700 text-emerald-400'
                    : 'bg-slate-50 border-slate-200 text-emerald-600'
                }`}
              />
            </div>
          </div>

          <input
            type="range"
            min={1}
            max={batteryCap}
            step={0.5}
            value={manualKwh}
            onChange={(e) => {
              setManualKwh(parseFloat(e.target.value) || 1);
              triggerHaptic('light', settings.hapticFeedback);
            }}
            className="w-full accent-emerald-500 h-2 bg-slate-800 rounded-lg cursor-pointer"
          />

          <div className="grid grid-cols-5 gap-1.5 pt-1">
            {[10, 20, 30, 40, 50].map((val) => (
              <button
                key={val}
                type="button"
                onClick={() => {
                  triggerHaptic('light', settings.hapticFeedback);
                  setManualKwh(val);
                }}
                className={`py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                  manualKwh === val
                    ? 'bg-emerald-600 text-white border-emerald-600 font-bold'
                    : isDark
                    ? 'bg-slate-900 text-slate-400 border-slate-800'
                    : 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200'
                }`}
              >
                {val}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 3. Charging Loss / Efficiency Loss Settings */}
      <div
        className={`border rounded-2xl p-4 space-y-3 transition-colors ${
          isDark
            ? 'bg-slate-900/60 border-slate-800/80'
            : 'bg-white border-slate-200/80 shadow-xs'
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Percent className={`w-4 h-4 ${isDark ? 'text-amber-400' : 'text-amber-600'}`} />
            <span className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Потери при зарядке на ЭЗС (%)
            </span>
          </div>
          <div className="w-24">
            <DecimalInput
              value={lossPercent}
              onChange={(val) => setLossPercent(Math.max(0, Math.min(40, val)))}
              suffix="%"
              className={`w-full text-right px-2 py-1 rounded-lg text-sm font-bold font-mono focus:outline-none border ${
                isDark
                  ? 'bg-slate-950 border-slate-700 text-amber-400'
                  : 'bg-slate-50 border-slate-200 text-amber-600'
              }`}
            />
          </div>
        </div>

        <p className={`text-[11px] leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          Учитывает потери на преобразование тока, охлаждение/обогрев батареи и сопротивление кабеля станции.
        </p>

        {/* Loss Preset Buttons */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 pt-1">
          {[
            { label: '0% (Без потерь)', val: 0 },
            { label: '5% (DC Быстрая)', val: 5 },
            { label: '8% (Штатная DC)', val: 8 },
            { label: '10% (AC Обычная)', val: 10 },
            { label: '15% (Зима/Подогрев)', val: 15 },
          ].map((preset) => (
            <button
              key={preset.val}
              type="button"
              onClick={() => {
                triggerHaptic('light', settings.hapticFeedback);
                setLossPercent(preset.val);
              }}
              className={`py-1.5 px-2 rounded-xl text-xs font-semibold border transition-all text-center ${
                lossPercent === preset.val
                  ? isDark
                    ? 'bg-amber-950/70 border-amber-500 text-amber-300 font-bold shadow-xs'
                    : 'bg-amber-500 text-white border-amber-600 font-bold shadow-xs'
                  : isDark
                  ? 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* 4. Tariff / Operator Selector */}
      <div
        className={`border rounded-2xl p-4 space-y-3 transition-colors ${
          isDark
            ? 'bg-slate-900/60 border-slate-800/80'
            : 'bg-white border-slate-200/80 shadow-xs'
        }`}
      >
        <div className="flex items-center justify-between">
          <span className={`text-xs font-bold uppercase tracking-wider block ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
            Тариф для расчета ({settings.currency}/кВт⋅ч)
          </span>
          <span className={`text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Нажмите для выбора</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {/* Malanka DC */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light', settings.hapticFeedback);
              setSelectedTariff('malanka_dc');
            }}
            className={`p-2.5 rounded-xl border text-left transition-all ${
              selectedTariff === 'malanka_dc'
                ? isDark
                  ? 'bg-amber-950/60 border-amber-500/80 text-white shadow-xs'
                  : 'bg-amber-50 border-amber-400 text-amber-900 shadow-xs font-semibold'
                : isDark
                ? 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="text-xs font-semibold block">⚡ {getOperatorLabel('malanka_dc', settings.regionPreset)}</span>
            <span className={`text-sm font-bold font-mono ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
              {settings.malankaDcTariff ?? settings.fastDayTariff} {settings.currency}
            </span>
          </button>

          {/* AC / Evika */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light', settings.hapticFeedback);
              setSelectedTariff('evika');
            }}
            className={`p-2.5 rounded-xl border text-left transition-all ${
              selectedTariff === 'evika'
                ? isDark
                  ? 'bg-teal-950/60 border-teal-500/80 text-white shadow-xs'
                  : 'bg-teal-50 border-teal-400 text-teal-900 shadow-xs font-semibold'
                : isDark
                ? 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="text-xs font-semibold block">🔌 {getOperatorLabel('evika', settings.regionPreset)}</span>
            <span className={`text-sm font-bold font-mono ${isDark ? 'text-teal-400' : 'text-teal-600'}`}>
              {settings.evikaTariff ?? settings.slowPublicTariff} {settings.currency}
            </span>
          </button>

          {/* BatteryFly */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light', settings.hapticFeedback);
              setSelectedTariff('batteryfly');
            }}
            className={`p-2.5 rounded-xl border text-left transition-all ${
              selectedTariff === 'batteryfly'
                ? isDark
                  ? 'bg-cyan-950/60 border-cyan-500/80 text-white shadow-xs'
                  : 'bg-cyan-50 border-cyan-400 text-cyan-900 shadow-xs font-semibold'
                : isDark
                ? 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="text-xs font-semibold block">🔋 {getOperatorLabel('batteryfly', settings.regionPreset)}</span>
            <span className={`text-sm font-bold font-mono ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`}>
              {settings.batteryFlyTariff ?? 0.6} {settings.currency}
            </span>
          </button>

          {/* Zaryadka Day */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light', settings.hapticFeedback);
              setSelectedTariff('zaryadka_day');
            }}
            className={`p-2.5 rounded-xl border text-left transition-all ${
              selectedTariff === 'zaryadka_day'
                ? isDark
                  ? 'bg-orange-950/60 border-orange-500/80 text-white shadow-xs'
                  : 'bg-orange-50 border-orange-400 text-orange-900 shadow-xs font-semibold'
                : isDark
                ? 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="text-xs font-semibold block">☀️ {getOperatorLabel('zaryadka_day', settings.regionPreset)}</span>
            <span className={`text-sm font-bold font-mono ${isDark ? 'text-orange-400' : 'text-orange-600'}`}>
              {settings.zaryadkaDayTariff ?? settings.zaryadkaTariff ?? settings.zaryadkaDcTariff ?? 0.56} {settings.currency}
            </span>
          </button>

          {/* Zaryadka Night */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light', settings.hapticFeedback);
              setSelectedTariff('zaryadka_night');
            }}
            className={`p-2.5 rounded-xl border text-left transition-all ${
              selectedTariff === 'zaryadka_night'
                ? isDark
                  ? 'bg-amber-950/60 border-amber-500/80 text-white shadow-xs'
                  : 'bg-amber-50 border-amber-400 text-amber-900 shadow-xs font-semibold'
                : isDark
                ? 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="text-xs font-semibold block">🌙 {getOperatorLabel('zaryadka_night', settings.regionPreset)}</span>
            <span className={`text-sm font-bold font-mono ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
              {settings.zaryadkaNightTariff ?? 0.43} {settings.currency}
            </span>
          </button>

          {/* Home Night */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light', settings.hapticFeedback);
              setSelectedTariff('home_night');
            }}
            className={`p-2.5 rounded-xl border text-left transition-all ${
              selectedTariff === 'home_night'
                ? isDark
                  ? 'bg-emerald-950/60 border-emerald-500/80 text-white shadow-xs'
                  : 'bg-emerald-50 border-emerald-400 text-emerald-900 shadow-xs font-semibold'
                : isDark
                ? 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="text-xs font-semibold block">🌙 Дом Ночь</span>
            <span className={`text-sm font-bold font-mono ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
              {settings.homeNightTariff ?? 0.16} {settings.currency}
            </span>
          </button>

          {/* Home Day */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light', settings.hapticFeedback);
              setSelectedTariff('home');
            }}
            className={`p-2.5 rounded-xl border text-left transition-all ${
              selectedTariff === 'home'
                ? isDark
                  ? 'bg-emerald-950/60 border-emerald-500/80 text-white shadow-xs'
                  : 'bg-emerald-50 border-emerald-400 text-emerald-900 shadow-xs font-semibold'
                : isDark
                ? 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="text-xs font-semibold block">🏠 Дом День</span>
            <span className={`text-sm font-bold font-mono ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
              {settings.homeTariff} {settings.currency}
            </span>
          </button>

          {/* Custom Tariff */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light', settings.hapticFeedback);
              setSelectedTariff('custom');
            }}
            className={`p-2.5 rounded-xl border text-left transition-all ${
              selectedTariff === 'custom'
                ? isDark
                  ? 'bg-slate-800 border-slate-600 text-white shadow-xs'
                  : 'bg-slate-200 border-slate-400 text-slate-900 shadow-xs font-semibold'
                : isDark
                ? 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="text-xs font-semibold block">⚙️ Свой тариф</span>
            <span className={`text-sm font-bold font-mono ${isDark ? 'text-white' : 'text-slate-900'}`}>
              {customTariffRate.toFixed(2)} {settings.currency}
            </span>
          </button>
        </div>

        {/* Custom Tariff Input when active */}
        {selectedTariff === 'custom' && (
          <div className="pt-2">
            <label className={`text-xs font-semibold block mb-1 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Введите ваш тариф ({settings.currency}/кВт⋅ч):
            </label>
            <DecimalInput
              value={customTariffRate}
              onChange={(val) => setCustomTariffRate(val)}
              suffix={settings.currency}
              className={`w-full border px-3 py-2 rounded-xl text-sm font-mono font-bold focus:outline-none ${
                isDark
                  ? 'bg-slate-950 border-slate-700 text-white'
                  : 'bg-slate-50 border-slate-200 text-slate-900'
              }`}
            />
          </div>
        )}
      </div>
    </div>
  );
};
