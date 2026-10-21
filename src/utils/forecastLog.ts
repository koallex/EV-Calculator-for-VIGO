// Журнал предрейсовых прогнозов Калькулятора.
//
// Зачем: routeForecastBridge хранит ОДИН прогноз и стирает его, когда HUD записывает поездку, —
// архива нет. Для калибровки модели нужно сравнивать «что показал Калькулятор перед выездом»
// с фактическим SoC на финише, особенно на длинных поездках (на 40-50 км целые проценты SoC
// слишком грубые, чтобы увидеть смещение в 2-3 п.п. на 100 км).
//
// Модуль без зависимостей от storage.ts (чтобы не было циклического импорта): storage.ts
// импортирует отсюда loadForecastLog для бэкапа.

const STORAGE_KEY = 'vigo_forecast_log_v1';
const CHANGE_EVENT = 'vigo-forecast-log-changed';
const MAX_ENTRIES = 40;
// Повторный расчёт того же маршрута с теми же вводными в течение этого окна обновляет
// последнюю запись, а не плодит дубли (Калькулятор пересчитывается при любой правке).
const DEDUPE_WINDOW_MS = 30 * 60 * 1000;
const MAX_PROFILE_POINTS = 30;

export interface ForecastLogParts {
  baseKwh: number;
  temperatureKwh: number;
  windKwh: number;
  precipitationKwh: number;
  driverKwh: number;
  elevationKwh: number;
  climateKwh: number;
  regenKwh: number;
}

export interface ForecastLogEntry {
  id: string;
  createdAt: number;
  updatedAt: number;
  from: string;
  to: string;
  distanceKm: number;
  durationHours: number;
  startSoc: number;
  forecastEndSoc: number;
  energyKwh: number;
  consumptionPer100Km: number;
  plannedSpeedKmH: number;
  plannedMaxSpeedKmH: number;
  weatherMode: 'current' | 'planning';
  temperatureC: number;
  windKmH: number;
  /** Угол ветра относительно движения: 0° — встречный, 90° — справа, 180° — попутный, 270° — слева. */
  relativeWindAngleDeg: number;
  windLabel: string;
  precipitationMmH: number;
  precipitationLabel: string;
  weatherCode: number;
  climateOn: boolean;
  climatePowerKw: number;
  passengers: number;
  elevationGainM: number;
  elevationLossM: number;
  parts: ForecastLogParts;
  speedProfile: Array<{ distanceKm: number; speedKmH: number }>;
  /** Расчётные скорости модели: средняя = дистанция / расчётное время, максимальная = пик профиля скорости. */
  calcAvgSpeedKmH?: number;
  calcMaxSpeedKmH?: number;
  /** Заполняется вручную после поездки. */
  actualEndSoc?: number;
  actualAvgSpeedKmH?: number;
  actualMaxSpeedKmH?: number;
}

type ActualFields = 'actualEndSoc' | 'actualAvgSpeedKmH' | 'actualMaxSpeedKmH';
export type ForecastActualsPatch = Partial<Record<ActualFields, number | undefined>>;
export type NewForecastLogEntry = Omit<ForecastLogEntry, 'id' | 'createdAt' | 'updatedAt' | ActualFields | 'calcAvgSpeedKmH' | 'calcMaxSpeedKmH'>;

/** Есть ли у записи хоть один введённый вручную фактический показатель. */
export const hasActuals = (e: ForecastLogEntry) =>
  e.actualEndSoc !== undefined || e.actualAvgSpeedKmH !== undefined || e.actualMaxSpeedKmH !== undefined;

function readAll(): ForecastLogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ForecastLogEntry[]) : [];
  } catch {
    return [];
  }
}

function writeAll(entries: ForecastLogEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // localStorage недоступен/переполнен — журнал вспомогательный, расчёт маршрута из-за него не ломаем.
  }
}

/** Новые записи — первыми. */
export function loadForecastLog(): ForecastLogEntry[] {
  if (typeof window === 'undefined') return [];
  return readAll().sort((a, b) => b.createdAt - a.createdAt);
}

export function subscribeForecastLog(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

function downsampleProfile(profile: Array<{ distanceKm: number; speedKmH: number }>) {
  if (!Array.isArray(profile) || profile.length <= MAX_PROFILE_POINTS) {
    return (profile ?? []).map((p) => ({ distanceKm: Number(p.distanceKm.toFixed(1)), speedKmH: Math.round(p.speedKmH) }));
  }
  const step = (profile.length - 1) / (MAX_PROFILE_POINTS - 1);
  const out: Array<{ distanceKm: number; speedKmH: number }> = [];
  for (let i = 0; i < MAX_PROFILE_POINTS; i++) {
    const p = profile[Math.round(i * step)];
    out.push({ distanceKm: Number(p.distanceKm.toFixed(1)), speedKmH: Math.round(p.speedKmH) });
  }
  return out;
}

const sameRoute = (a: NewForecastLogEntry, b: ForecastLogEntry) =>
  a.to === b.to &&
  a.from === b.from &&
  Math.abs(a.distanceKm - b.distanceKm) < 0.5 &&
  a.plannedSpeedKmH === b.plannedSpeedKmH &&
  a.plannedMaxSpeedKmH === b.plannedMaxSpeedKmH &&
  a.startSoc === b.startSoc &&
  a.climateOn === b.climateOn &&
  a.weatherMode === b.weatherMode;

/** Сохраняет прогноз; почти мгновенный повторный расчёт того же маршрута обновляет последнюю запись. */
export function upsertForecastLogEntry(input: NewForecastLogEntry): void {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  const profileMax = (input.speedProfile ?? []).reduce((m, p) => Math.max(m, p.speedKmH), 0);
  const entry = {
    ...input,
    calcAvgSpeedKmH: input.durationHours > 0 ? Math.round(input.distanceKm / input.durationHours) : undefined,
    calcMaxSpeedKmH: profileMax > 0 ? Math.round(profileMax) : undefined,
    speedProfile: downsampleProfile(input.speedProfile),
  };
  const all = readAll().sort((a, b) => b.createdAt - a.createdAt);
  const latest = all[0];
  if (latest && !hasActuals(latest) && now - latest.updatedAt < DEDUPE_WINDOW_MS && sameRoute(entry, latest)) {
    all[0] = { ...latest, ...entry, id: latest.id, createdAt: latest.createdAt, updatedAt: now };
    writeAll(all);
    return;
  }
  all.unshift({ ...entry, id: `fc_${now}`, createdAt: now, updatedAt: now });
  // Лимит: сначала выбрасываем самые старые записи БЕЗ фактического результата — размеченные ценнее.
  while (all.length > MAX_ENTRIES) {
    let idx = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      if (!hasActuals(all[i])) { idx = i; break; }
    }
    all.splice(idx === -1 ? all.length - 1 : idx, 1);
  }
  writeAll(all);
}

/** Обновляет фактические показатели записи; ключ со значением undefined очищает поле. */
export function setForecastActuals(id: string, patch: ForecastActualsPatch): void {
  const all = readAll();
  const i = all.findIndex((e) => e.id === id);
  if (i === -1) return;
  const next = { ...all[i], ...patch, updatedAt: Date.now() };
  (Object.keys(patch) as ActualFields[]).forEach((k) => { if (patch[k] === undefined) delete next[k]; });
  all[i] = next;
  writeAll(all);
}

export function setForecastActualEndSoc(id: string, actualEndSoc: number | undefined): void {
  setForecastActuals(id, { actualEndSoc });
}

export function deleteForecastLogEntry(id: string): void {
  writeAll(readAll().filter((e) => e.id !== id));
}

/**
 * Отклонение факта от прогноза. deltaPp = факт − прогноз: минус — финиш оказался НИЖЕ прогноза
 * (прогноз был оптимистичным). per100Km нормирует на длину маршрута.
 */
export function forecastDelta(entry: ForecastLogEntry): { deltaPp: number; per100Km: number } | null {
  if (entry.actualEndSoc === undefined || !Number.isFinite(entry.actualEndSoc) || entry.distanceKm <= 0) return null;
  const deltaPp = entry.actualEndSoc - entry.forecastEndSoc;
  return { deltaPp, per100Km: (deltaPp / entry.distanceKm) * 100 };
}

export function forecastLogToCSV(entries: ForecastLogEntry[]): string {
  const headers = [
    'Дата', 'Откуда', 'Куда', 'Дистанция (км)', 'Старт %', 'Прогноз финиш %', 'Факт финиш %',
    'Откл. (п.п.)', 'Откл. (п.п./100км)', 'Прогноз кВт⋅ч', 'Прогноз кВт⋅ч/100км',
    'План: скорость сред. (км/ч)', 'План: скорость макс. (км/ч)', 'Модель: скорость сред. (км/ч)', 'Модель: скорость макс. (км/ч)',
    'Факт: скорость сред. (км/ч)', 'Факт: скорость макс. (км/ч)', 'Время (ч)', 'Погода: режим', 'Темп. °C',
    'Ветер км/ч', 'Угол ветра °', 'Ветер (подпись)', 'Осадки мм/ч', 'Осадки (подпись)', 'Климат',
    'Климат кВт', 'Пассажиры', 'Набор м', 'Спуск м', 'База кВт⋅ч', 'Темп. кВт⋅ч', 'Ветер кВт⋅ч',
    'Осадки кВт⋅ч', 'Стиль кВт⋅ч', 'Рельеф кВт⋅ч', 'Климат кВт⋅ч', 'Рекуперация кВт⋅ч', 'Профиль скорости (JSON)',
  ];
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = entries.map((e) => {
    const d = forecastDelta(e);
    return [
      new Date(e.createdAt).toISOString().slice(0, 16).replace('T', ' '), e.from, e.to, e.distanceKm, e.startSoc,
      e.forecastEndSoc, e.actualEndSoc ?? '', d ? d.deltaPp.toFixed(1) : '', d ? d.per100Km.toFixed(2) : '',
      e.energyKwh, e.consumptionPer100Km, e.plannedSpeedKmH, e.plannedMaxSpeedKmH, e.calcAvgSpeedKmH ?? '', e.calcMaxSpeedKmH ?? '',
      e.actualAvgSpeedKmH ?? '', e.actualMaxSpeedKmH ?? '', e.durationHours.toFixed(2),
      e.weatherMode === 'current' ? 'прогноз' : 'ручной', e.temperatureC, e.windKmH, Math.round(e.relativeWindAngleDeg),
      e.windLabel, e.precipitationMmH, e.precipitationLabel, e.climateOn ? 'Вкл' : 'Выкл', e.climatePowerKw,
      e.passengers, Math.round(e.elevationGainM), Math.round(e.elevationLossM), e.parts.baseKwh, e.parts.temperatureKwh,
      e.parts.windKwh, e.parts.precipitationKwh, e.parts.driverKwh, e.parts.elevationKwh, e.parts.climateKwh,
      e.parts.regenKwh, JSON.stringify(e.speedProfile),
    ].map(esc).join(';');
  });
  return '\uFEFF' + [headers.join(';'), ...rows].join('\n');
}
