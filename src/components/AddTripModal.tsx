import React, { useState } from 'react';
import {
  X,
  PlusCircle,
  Zap,
} from 'lucide-react';
import { TripSession, UserSettings, RoadType } from '../types';
import { DecimalInput } from './DecimalInput';
import { getTariffForType } from '../utils/storage';
import { triggerHaptic } from '../utils/haptics';

interface AddTripModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: UserSettings;
  onSave: (tripData: Omit<TripSession, 'id' | 'createdAt'>) => void;
  initialData?: Partial<TripSession>;
}

export const AddTripModal: React.FC<AddTripModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSave,
  initialData,
}) => {
  const [date, setDate] = useState<string>(
    initialData?.date || new Date().toISOString().split('T')[0]
  );
  const [title, setTitle] = useState<string>(initialData?.title || '');
  const [startSoc, setStartSoc] = useState<number>(initialData?.startSoc ?? 100);
  const [endSoc, setEndSoc] = useState<number>(initialData?.endSoc ?? 30);
  const [distanceKm, setDistanceKm] = useState<number>(initialData?.distanceKm ?? 190);
  const [roadType, setRoadType] = useState<RoadType>(initialData?.roadType || 'city');
  const [climateOn, setClimateOn] = useState<boolean>(initialData?.climateOn ?? false);
  const [chargingType, setChargingType] = useState<TripSession['chargingType']>(
    initialData?.chargingType || 'malanka_dc'
  );
  const [note, setNote] = useState<string>(initialData?.note || '');

  if (!isOpen) return null;

  const batteryCap = settings.batteryCapacityKwh || 51.87;
  const socUsed = Math.max(0.1, startSoc - endSoc);
  const energyUsedKwh = (socUsed / 100) * batteryCap;
  const safeDistance = Math.max(0.1, distanceKm);
  const consumptionPer100Km = (energyUsedKwh / safeDistance) * 100;
  const kmPerKwh = safeDistance / energyUsedKwh;

  const tariff = getTariffForType(chargingType, settings);
  const totalCost = energyUsedKwh * tariff;
  const gasCostEquivalent = (safeDistance / 100) * settings.gasEquivalentL100km * settings.gasPricePerLiter;
  const moneySaved = Math.max(0, gasCostEquivalent - totalCost);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    triggerHaptic('success', settings.hapticFeedback);
    onSave({
      date,
      title: title.trim() || undefined,
      startSoc,
      endSoc,
      distanceKm,
      energyUsedKwh: Number(energyUsedKwh.toFixed(2)),
      consumptionPer100Km: Number(consumptionPer100Km.toFixed(2)),
      kmPerKwh: Number(kmPerKwh.toFixed(2)),
      chargingType,
      totalCost: Number(totalCost.toFixed(2)),
      gasCostEquivalent: Number(gasCostEquivalent.toFixed(2)),
      moneySaved: Number(moneySaved.toFixed(2)),
      roadType,
      climateOn,
      note: note.trim() || undefined,
    });
    onClose();
  };

  const isDark = settings.theme !== 'light';

  return (
    <div
      id="add-trip-modal-overlay"
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
    >
      <div
        className={`border rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[92vh] overflow-y-auto p-4 sm:p-5 shadow-2xl space-y-4 animate-in slide-in-from-bottom duration-200 transition-colors ${
          isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900'
        }`}
      >
        <div
          className={`flex items-center justify-between border-b pb-3 ${
            isDark ? 'border-slate-800/80' : 'border-slate-100'
          }`}
        >
          <div className="flex items-center gap-2">
            <div
              className={`p-1.5 rounded-lg ${
                isDark ? 'bg-emerald-500/15 text-emerald-400' : 'bg-emerald-50 text-emerald-600'
              }`}
            >
              <PlusCircle className="w-4 h-4" />
            </div>
            <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
              Добавить поездку в журнал
            </h3>
          </div>
          <button
            onClick={() => {
              triggerHaptic('light', settings.hapticFeedback);
              onClose();
            }}
            className={`p-1.5 rounded-lg transition-colors ${
              isDark ? 'bg-slate-800 text-slate-400 hover:text-white' : 'bg-slate-100 text-slate-600 hover:text-slate-900'
            }`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
          {/* Quick Calculated Preview */}
          <div
            className={`p-3 rounded-xl border flex items-center justify-between transition-colors ${
              isDark
                ? 'bg-slate-950/60 border-slate-800'
                : 'bg-emerald-50/70 border-emerald-200'
            }`}
          >
            <div>
              <span
                className={`text-[10px] uppercase tracking-wider font-bold ${
                  isDark ? 'text-emerald-300' : 'text-emerald-700'
                }`}
              >
                Расчетный расход:
              </span>
              <div
                className={`text-xl font-extrabold font-mono ${
                  isDark ? 'text-emerald-400' : 'text-emerald-600'
                }`}
              >
                {consumptionPer100Km.toFixed(1)}{' '}
                <span className={`text-xs font-normal ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  кВт⋅ч/100км
                </span>
              </div>
            </div>
            <div className="text-right">
              <span className={`text-[11px] block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Энергия: {energyUsedKwh.toFixed(1)} кВт⋅ч
              </span>
              <span className={`text-xs font-bold font-mono ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                {totalCost.toFixed(2)} {settings.currency}
              </span>
              <span className={`text-[10px] block font-semibold ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
                Экономия: +{moneySaved.toFixed(2)} {settings.currency}
              </span>
            </div>
          </div>

          {/* Date & Title */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div className="space-y-1">
              <label className={`font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Дата поездки:</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={`w-full border px-3 py-1.5 rounded-lg font-medium focus:outline-none transition-colors ${
                  isDark
                    ? 'bg-slate-950 border-slate-700 text-white focus:border-emerald-500'
                    : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-emerald-500'
                }`}
                required
              />
            </div>
            <div className="space-y-1">
              <label className={`font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Маршрут / Заголовок:</label>
              <input
                type="text"
                placeholder="например: Минск — Заславль"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className={`w-full border px-3 py-1.5 rounded-lg font-medium focus:outline-none transition-colors ${
                  isDark
                    ? 'bg-slate-950 border-slate-700 text-white focus:border-emerald-500'
                    : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-emerald-500'
                }`}
              />
            </div>
          </div>

          {/* SoC & Distance using DecimalInput */}
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <label className={`font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Старт SoC %:</label>
              <DecimalInput
                value={startSoc}
                onChange={(val) => setStartSoc(Math.min(100, Math.max(1, val)))}
                suffix="%"
                className={`w-full border px-2.5 py-1.5 rounded-lg font-mono font-bold text-sm focus:outline-none ${
                  isDark
                    ? 'bg-slate-950 border-slate-700 text-teal-400 focus:border-teal-500'
                    : 'bg-slate-50 border-slate-200 text-teal-600 focus:border-teal-500'
                }`}
              />
            </div>
            <div className="space-y-1">
              <label className={`font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Финиш SoC %:</label>
              <DecimalInput
                value={endSoc}
                onChange={(val) => setEndSoc(Math.min(startSoc - 1, Math.max(0, val)))}
                suffix="%"
                className={`w-full border px-2.5 py-1.5 rounded-lg font-mono font-bold text-sm focus:outline-none ${
                  isDark
                    ? 'bg-slate-950 border-slate-700 text-emerald-400 focus:border-emerald-500'
                    : 'bg-slate-50 border-slate-200 text-emerald-600 focus:border-emerald-500'
                }`}
              />
            </div>
            <div className="space-y-1">
              <label className={`font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Дистанция:</label>
              <DecimalInput
                value={distanceKm}
                onChange={(val) => setDistanceKm(Math.max(0.1, val))}
                suffix="км"
                className={`w-full border px-2.5 py-1.5 rounded-lg font-mono font-bold text-sm focus:outline-none ${
                  isDark
                    ? 'bg-slate-950 border-slate-700 text-white focus:border-emerald-500'
                    : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-emerald-500'
                }`}
              />
            </div>
          </div>

          {/* Road Type & Charging Operator */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div className="space-y-1">
              <label className={`font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Тип дороги:</label>
              <select
                value={roadType}
                onChange={(e) => setRoadType(e.target.value as RoadType)}
                className={`w-full border px-3 py-1.5 rounded-lg font-medium focus:outline-none ${
                  isDark
                    ? 'bg-slate-950 border-slate-700 text-slate-200 focus:border-emerald-500'
                    : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500'
                }`}
              >
                <option value="city">🏙️ Городской режим</option>
                <option value="highway">🛣️ Загородная трасса</option>
                <option value="mixed">🔀 Смешанный цикл</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className={`font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Тариф / Оператор:</label>
              <select
                value={chargingType}
                onChange={(e) => setChargingType(e.target.value as TripSession['chargingType'])}
                className={`w-full border px-3 py-1.5 rounded-lg font-medium focus:outline-none ${
                  isDark
                    ? 'bg-slate-950 border-slate-700 text-slate-200 focus:border-emerald-500'
                    : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-emerald-500'
                }`}
              >
                <option value="malanka_dc">⚡ Маланка DC ({settings.malankaDcTariff ?? settings.fastDayTariff ?? 0.56} {settings.currency})</option>
                <option value="malanka_ac">🔌 Маланка AC ({settings.malankaAcTariff ?? settings.slowPublicTariff ?? 0.43} {settings.currency})</option>
                <option value="evika">🔌 Evika ({settings.evikaTariff ?? 0.43} {settings.currency})</option>
                <option value="batteryfly">🔋 BatteryFly ({settings.batteryFlyTariff ?? 0.60} {settings.currency})</option>
                <option value="zaryadka_day">☀️ Зарядка День ({settings.zaryadkaDayTariff ?? settings.zaryadkaTariff ?? 0.56} {settings.currency})</option>
                <option value="zaryadka_night">🌙 Зарядка Ночь ({settings.zaryadkaNightTariff ?? 0.43} {settings.currency})</option>
                <option value="home_night">🌙 Домашняя Ночь ({settings.homeNightTariff ?? 0.16} {settings.currency})</option>
                <option value="home">🏠 Домашняя День ({settings.homeTariff} {settings.currency})</option>
                <option value="free">🎁 Бесплатная зарядка</option>
              </select>
            </div>
          </div>

          {/* Climate & Note */}
          <div
            className={`flex items-center gap-2.5 p-2 rounded-lg border ${
              isDark ? 'bg-slate-950/70 border-slate-800' : 'bg-slate-50 border-slate-200'
            }`}
          >
            <input
              type="checkbox"
              id="climateToggle"
              checked={climateOn}
              onChange={(e) => setClimateOn(e.target.checked)}
              className="w-4 h-4 accent-emerald-500 rounded cursor-pointer"
            />
            <label
              htmlFor="climateToggle"
              className={`cursor-pointer font-medium text-xs ${isDark ? 'text-slate-300' : 'text-slate-700'}`}
            >
              Включен климат-контроль / кондиционер / печка
            </label>
          </div>

          <div className="space-y-1">
            <label className={`font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Заметка к поездке:</label>
            <input
              type="text"
              placeholder="например: резина зимняя, пассажиры в салоне"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={`w-full border px-3 py-1.5 rounded-lg font-medium focus:outline-none ${
                isDark
                  ? 'bg-slate-950 border-slate-700 text-white focus:border-emerald-500'
                  : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-emerald-500'
              }`}
            />
          </div>

          {/* Submit */}
          <button
            type="submit"
            className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-sm shadow-emerald-600/20 active:scale-[0.99] transition-all"
          >
            Сохранить поездку в журнал
          </button>
        </form>
      </div>
    </div>
  );
};
