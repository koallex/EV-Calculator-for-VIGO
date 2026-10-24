import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown, ClipboardList, FileSpreadsheet, Trash2 } from 'lucide-react';
import {
  ForecastLogEntry,
  deleteForecastLogEntry,
  forecastDelta,
  forecastEnergyCheck,
  forecastShadowCompare,
  forecastShadowSummary,
  getForecastLogStatus,
  type ForecastLogStatus,
  forecastLogToCSV,
  loadForecastLog,
  setForecastActuals,
  subscribeForecastLog,
} from '../utils/forecastLog';
import { saveTextFile } from '../utils/storage';
import { triggerHaptic } from '../utils/haptics';

interface ForecastLogCardProps {
  isDark: boolean;
  hapticFeedback: boolean;
}

const fmtDate = (ts: number) =>
  new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtSigned = (n: number, digits = 1) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(digits).replace('.', ',')}`;

interface ActualFieldProps {
  id: string;
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  isDark: boolean;
  haptic: boolean;
  onCommit: (v: number | undefined) => void;
}

/** Поле ввода фактического значения: сохраняет по уходу фокуса/Enter, пустое — очищает. */
const ActualField: React.FC<ActualFieldProps> = ({ id, label, value, min, max, isDark, haptic, onCommit }) => {
  const [draft, setDraft] = useState(value !== undefined ? String(value) : '');
  // Если запись обновилась снаружи (например, удалили/изменили в другой вкладке) — подтягиваем значение.
  useEffect(() => { setDraft(value !== undefined ? String(value) : ''); }, [value]);

  const commit = () => {
    const raw = draft.trim().replace(',', '.');
    if (raw === '') {
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const v = Number(raw);
    if (!Number.isFinite(v) || v < min || v > max) {
      setDraft(value !== undefined ? String(value) : '');
      return;
    }
    if (v !== value) {
      triggerHaptic('light', haptic);
      onCommit(v);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={`text-[11px] font-semibold ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{label}</label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        placeholder="—"
        className={`w-full rounded-lg border px-2 py-1 text-center text-[13px] font-bold outline-none focus:ring-2 focus:ring-cyan-500/50 ${
          isDark ? 'border-slate-700 bg-slate-950 text-white' : 'border-slate-300 bg-white text-slate-900'
        }`}
      />
    </div>
  );
};

const EntryRow: React.FC<{ entry: ForecastLogEntry; isDark: boolean; haptic: boolean }> = ({ entry, isDark, haptic }) => {
  const delta = forecastDelta(entry);
  const energy = forecastEnergyCheck(entry);
  const shadowCmp = forecastShadowCompare(entry);
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const strong = isDark ? 'text-slate-100' : 'text-slate-900';

  const p = entry.parts;
  const sign = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1).replace('.', ',')}`;
  const windSide = entry.windKmH > 0 ? `${Math.round(entry.windKmH)} км/ч` : 'штиль';
  // Модельная средняя (дистанция / расчётное время) может отличаться от введённой плановой — показываем, если разница заметна.
  const modelAvgDiffers = entry.calcAvgSpeedKmH !== undefined && Math.abs(entry.calcAvgSpeedKmH - entry.plannedSpeedKmH) >= 2;
  const speedDiff = (actual: number | undefined, planned: number) =>
    actual === undefined ? null : `${actual - planned === 0 ? '±0' : fmtSigned(actual - planned, 0)} км/ч`;
  const avgDiff = speedDiff(entry.actualAvgSpeedKmH, entry.plannedSpeedKmH);
  const maxDiff = speedDiff(entry.actualMaxSpeedKmH, entry.plannedMaxSpeedKmH);

  return (
    <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-white'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={`truncate text-[13px] font-bold ${strong}`}>
            {entry.from} → {entry.to}
          </p>
          <p className={`text-[11px] ${muted}`}>
            {fmtDate(entry.createdAt)} · {Math.round(entry.distanceKm)} км
          </p>
        </div>
        <button
          type="button"
          aria-label="Удалить запись журнала"
          onClick={() => { triggerHaptic('light', haptic); deleteForecastLogEntry(entry.id); }}
          className={`vigo-press shrink-0 rounded-lg p-1.5 ${isDark ? 'text-slate-500 hover:text-rose-400' : 'text-slate-400 hover:text-rose-600'}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <p className={`mt-1.5 text-[12px] ${muted}`}>
        Старт <b className={strong}>{entry.startSoc}%</b> → прогноз финиша <b className={strong}>{entry.forecastEndSoc}%</b> ·{' '}
        {entry.consumptionPer100Km.toFixed(1).replace('.', ',')} кВт⋅ч/100 км
      </p>
      <p className={`text-[12px] ${muted}`}>
        Расчётная скорость: средняя <b className={strong}>{entry.plannedSpeedKmH}</b> · макс. <b className={strong}>{entry.plannedMaxSpeedKmH}</b> км/ч
        {modelAvgDiffers && <span className="text-[11px]"> (по времени модели ≈ {entry.calcAvgSpeedKmH})</span>}
        {entry.osrmAvgSpeedKmH !== undefined && <span className="text-[11px]"> · по данным маршрута ≈ {entry.osrmAvgSpeedKmH}</span>}
      </p>
      <p className={`text-[11px] ${muted}`}>
        {entry.temperatureC >= 0 ? '+' : ''}{Math.round(entry.temperatureC)}°C · ветер {windSide}
        {entry.windKmH > 0 ? ` (${entry.windLabel})` : ''} · {entry.precipitationLabel} · климат {entry.climateOn ? `${entry.climatePowerKw.toFixed(1).replace('.', ',')} кВт` : 'выкл'}
      </p>
      <p className={`text-[10px] ${muted}`}>
        кВт⋅ч: база {p.baseKwh.toFixed(1)} · темп. {sign(p.temperatureKwh)} · ветер {sign(p.windKwh)} · осадки {sign(p.precipitationKwh)} · стиль {sign(p.driverKwh)} · рельеф {sign(p.elevationKwh)} · климат {p.climateKwh.toFixed(1)}
      </p>

      {entry.shadow && (
        <div className={`mt-2 rounded-lg border border-dashed px-2.5 py-2 ${isDark ? 'border-violet-500/40 bg-violet-500/5' : 'border-violet-300 bg-violet-50/60'}`}>
          <p className={`text-[11px] font-bold ${isDark ? 'text-violet-300' : 'text-violet-700'}`}>
            Прогноз для сравнения · {(entry.shadow.mode ?? 'cruise') === 'legacy' ? 'прежний метод (профиль без крейсера)' : 'профиль «крейсер по максимуму»'}
            {' '}<span className="font-normal">(основной: {(entry.profileMode ?? 'legacy') === 'cruise' ? 'крейсер' : 'прежний'})</span>
          </p>
          <p className={`text-[12px] ${muted}`}>
            Финиш <b className={strong}>{entry.shadow.forecastEndSoc}%</b>{' '}
            ({fmtSigned(entry.shadow.forecastEndSoc - entry.forecastEndSoc)} п.п. к основному) ·{' '}
            {entry.shadow.consumptionPer100Km.toFixed(1).replace('.', ',')} кВт⋅ч/100 км
          </p>
          <p className={`text-[11px] ${muted}`}>
            Скорость по модели: средняя {entry.shadow.calcAvgSpeedKmH ?? '—'} · макс. {entry.shadow.calcMaxSpeedKmH ?? '—'} км/ч
            {entry.calcMaxSpeedKmH !== undefined && <> (основной: ср. {entry.calcAvgSpeedKmH ?? '—'} · макс. {entry.calcMaxSpeedKmH})</>}
          </p>
        </div>
      )}

      <div className={`mt-2.5 border-t pt-2.5 ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
        <p className={`mb-1.5 text-[11px] font-bold uppercase tracking-wide ${muted}`}>Фактически</p>
        <div className="grid grid-cols-3 gap-2">
          <ActualField
            id={`fc-soc-${entry.id}`} label="Финиш, %" value={entry.actualEndSoc} min={0} max={100}
            isDark={isDark} haptic={haptic}
            onCommit={(v) => setForecastActuals(entry.id, { actualEndSoc: v })}
          />
          <ActualField
            id={`fc-avg-${entry.id}`} label="Средняя, км/ч" value={entry.actualAvgSpeedKmH} min={5} max={200}
            isDark={isDark} haptic={haptic}
            onCommit={(v) => setForecastActuals(entry.id, { actualAvgSpeedKmH: v })}
          />
          <ActualField
            id={`fc-max-${entry.id}`} label="Макс., км/ч" value={entry.actualMaxSpeedKmH} min={5} max={250}
            isDark={isDark} haptic={haptic}
            onCommit={(v) => setForecastActuals(entry.id, { actualMaxSpeedKmH: v })}
          />
          <ActualField
            id={`fc-dist-${entry.id}`} label="Дистанция авто, км" value={entry.actualDistanceKm} min={1} max={3000}
            isDark={isDark} haptic={haptic}
            onCommit={(v) => setForecastActuals(entry.id, { actualDistanceKm: v })}
          />
          <ActualField
            id={`fc-cons-${entry.id}`} label="Расход авто, кВт⋅ч/100" value={entry.actualConsumptionKwh100} min={3} max={80}
            isDark={isDark} haptic={haptic}
            onCommit={(v) => setForecastActuals(entry.id, { actualConsumptionKwh100: v })}
          />
          <div className="flex flex-col gap-1">
            <span className={`text-[11px] font-semibold ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>Старт</span>
            <div className={`flex overflow-hidden rounded-lg border text-[11px] font-bold ${isDark ? 'border-slate-700' : 'border-slate-300'}`}>
              {(['cold', 'warm'] as const).map((t) => {
                const on = entry.startType === t;
                return (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      triggerHaptic('light', haptic);
                      setForecastActuals(entry.id, { startType: on ? undefined : t });
                    }}
                    className={`vigo-press flex-1 px-1 py-1.5 ${
                      on
                        ? 'bg-cyan-600 text-white'
                        : isDark ? 'bg-slate-950 text-slate-400' : 'bg-white text-slate-500'
                    }`}
                  >
                    {t === 'cold' ? 'Прогрев' : 'С колёс'}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {(delta || avgDiff || maxDiff || energy || shadowCmp) && (
            <motion.div
              key="deltas"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18 }}
              style={{ overflow: 'hidden' }}
            >
              <div className="mt-2 space-y-0.5">
                {delta && (
                  <p
                    className={`text-[12px] font-bold ${
                      Math.abs(delta.deltaPp) < 1
                        ? isDark ? 'text-emerald-400' : 'text-emerald-600'
                        : delta.deltaPp < 0
                          ? isDark ? 'text-amber-400' : 'text-amber-600'
                          : isDark ? 'text-cyan-400' : 'text-cyan-600'
                    }`}
                  >
                    {fmtSigned(delta.deltaPp)} п.п. ({fmtSigned(delta.per100Km)} на 100 км)
                    <span className={`ml-1 font-normal ${muted}`}>
                      {Math.abs(delta.deltaPp) < 1 ? 'в норме' : delta.deltaPp < 0 ? 'прогноз оптимистичнее' : 'прогноз пессимистичнее'}
                    </span>
                  </p>
                )}
                {shadowCmp && (
                  <p className={`text-[12px] ${muted}`}>
                    Прежний метод: <b className={strong}>{fmtSigned(shadowCmp.legacyErrPp)} п.п.</b> · крейсер: <b className={strong}>{fmtSigned(shadowCmp.cruiseErrPp)} п.п.</b> к факту ·{' '}
                    <b className={isDark ? 'text-violet-300' : 'text-violet-700'}>
                      {shadowCmp.closerMethod === 'cruise' ? 'ближе к факту крейсер' : shadowCmp.closerMethod === 'legacy' ? 'ближе к факту прежний' : 'оба одинаково близки'}
                    </b>
                  </p>
                )}
                {energy && (
                  <p className={`text-[12px] ${muted}`}>
                    Расход по авто <b className={strong}>{fmtSigned(energy.energyDelta, 2)} кВт⋅ч/100 км</b> ({fmtSigned(energy.energyDeltaPct)}%) к прогнозу
                    {energy.kwhPer100Soc !== null && energy.capacityDevPct !== null && (
                      <>
                        {' · '}на 100% SoC ≈ <b className={strong}>{energy.kwhPer100Soc.toFixed(1).replace('.', ',')} кВт⋅ч</b>
                        <span className={Math.abs(energy.capacityDevPct) > 4 ? (isDark ? ' text-amber-400' : ' text-amber-600') : ''}>
                          {' '}({fmtSigned(energy.capacityDevPct, 0)}% к номиналу)
                        </span>
                      </>
                    )}
                  </p>
                )}
                {(avgDiff || maxDiff) && (
                  <p className={`text-[11px] ${muted}`}>
                    Скорость факт к расчёту:
                    {avgDiff && <> средняя <b className={strong}>{avgDiff}</b></>}
                    {avgDiff && maxDiff && ' ·'}
                    {maxDiff && <> макс. <b className={strong}>{maxDiff}</b></>}
                  </p>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

export const ForecastLogCard: React.FC<ForecastLogCardProps> = ({ isDark, hapticFeedback }) => {
  const [entries, setEntries] = useState<ForecastLogEntry[]>(() => loadForecastLog());
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ForecastLogStatus | null>(() => getForecastLogStatus());

  useEffect(
    () => subscribeForecastLog(() => { setEntries(loadForecastLog()); setStatus(getForecastLogStatus()); }),
    [],
  );

  const filled = entries.filter((e) => e.actualEndSoc !== undefined).length;
  const summary = forecastShadowSummary(entries);

  return (
    <div className={`rounded-2xl border ${isDark ? 'border-slate-800 bg-slate-900/90' : 'border-slate-200 bg-white shadow-sm'}`}>
      <button
        type="button"
        onClick={() => { triggerHaptic('light', hapticFeedback); setOpen((v) => !v); }}
        aria-expanded={open}
        className="vigo-press flex w-full items-center gap-2 p-4 text-left"
      >
        <div className={`rounded-lg p-1.5 ${isDark ? 'bg-cyan-500/10 text-cyan-400' : 'bg-cyan-50 text-cyan-600'}`}>
          <ClipboardList className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>Журнал прогнозов</h3>
          <p className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            {entries.length === 0
              ? 'Появится после первого расчёта маршрута'
              : `Расчётов: ${entries.length} · с фактом: ${filled}`}
          </p>
          {status && !status.ok && (
            <p className={`text-[11px] font-semibold ${isDark ? 'text-rose-400' : 'text-rose-600'}`}>
              Не удалось сохранить журнал{status.message ? ` (${status.message})` : ''} — хранилище браузера переполнено?
            </p>
          )}
          {status && status.ok && (status.action === 'created' || status.action === 'updated' || status.action === 'start_soc') && (
            <p className={`text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {status.action === 'created' ? 'Записан расчёт' : 'Запись обновлена'} в{' '}
              {new Date(status.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
            </p>
          )}
        </div>
        <ChevronDown className={`h-4 w-4 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''} ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div className="space-y-2 px-4 pb-4">
              <p className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Расчёт маршрута сохраняется здесь; при смене параметров (скорость, климат, погода, заряд) запись обновляется. После поездки впишите фактический SoC на финише и скорости — приложение
                покажет отклонение от прогноза. Минус означает, что финиш оказался ниже прогноза. Фактические скорости, дистанцию и расход берите из бортового компьютера или энергоцентра авто: по расходу в кВт⋅ч приложение отделяет физику от показаний шкалы SoC. Тип старта («Прогрев» — выезд с прогревом батареи и салона, «С колёс» — всё уже тёплое) только записывается для анализа и на расчёт не влияет.
              </p>
              {entries.length === 0 ? null : (
                <>
                  {summary && (
                    <div className={`rounded-xl border px-3 py-2 text-[12px] ${isDark ? 'border-violet-500/30 bg-violet-500/5 text-slate-300' : 'border-violet-200 bg-violet-50/60 text-slate-700'}`}>
                      <p className={`text-[11px] font-bold ${isDark ? 'text-violet-300' : 'text-violet-700'}`}>
                        Прежний метод и крейсер · поездок с фактом: {summary.n}
                      </p>
                      <p>
                        Смещение (п.п./100 км, минус — прогноз оптимистичнее): прежний{' '}
                        <b>{fmtSigned(summary.legacyBias)}</b>, крейсер <b>{fmtSigned(summary.cruiseBias)}</b>
                      </p>
                      <p>
                        Средняя ошибка: прежний <b>{summary.legacyMae.toFixed(1).replace('.', ',')}</b>, крейсер{' '}
                        <b>{summary.cruiseMae.toFixed(1).replace('.', ',')}</b> · крейсер ближе в {summary.cruiseCloser} из {summary.n}
                        {summary.legacyCloser > 0 && `, прежний в ${summary.legacyCloser}`}
                      </p>
                      {summary.n < 4 && <p className={`text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>Пока мало поездок для выводов — нужно хотя бы 4–5.</p>}
                    </div>
                  )}
                  <div className="max-h-[60vh] space-y-2 overflow-y-auto">
                    {entries.map((e) => (
                      <EntryRow key={e.id} entry={e} isDark={isDark} haptic={hapticFeedback} />
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('light', hapticFeedback);
                      void saveTextFile(
                        `vigo_forecast_log_${new Date().toISOString().slice(0, 10)}.csv`,
                        'text/csv;charset=utf-8',
                        forecastLogToCSV(entries),
                      );
                    }}
                    className={`vigo-press flex w-full items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold ${
                      isDark ? 'border-slate-800 bg-slate-900 text-cyan-400' : 'border-slate-200 bg-white text-cyan-700'
                    }`}
                  >
                    <FileSpreadsheet className="h-3.5 w-3.5" />
                    Экспорт журнала в CSV
                  </button>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
