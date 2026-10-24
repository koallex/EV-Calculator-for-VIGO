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
// Повторный расчёт того же маршрута (в том числе после смены скорости, климата и т. п.) в течение этого окна
// обновляет последнюю запись, пока в ней не введён факт: запись всегда отражает последний расчёт на экране.
const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;
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
  /**
   * Теневой прогноз: тот же маршрут и вводные, но профиль скорости «крейсер по максимуму»
   * (см. buildCruiseRoadSpeeds в storage.ts). На экране Калькулятора не показывается — только здесь,
   * чтобы по фактам понять, какой метод ближе к реальности, прежде чем переключать основной.
   */
  shadow?: ForecastShadow;
  /** Средняя скорость маршрута по данным самого маршрутизатора (без пробок и остановок): для будущего автоподбора средней. */
  osrmAvgSpeedKmH?: number;
  /** Метод профиля скорости основного прогноза (в старых записях не указан — это был legacy). */
  profileMode?: ProfileMode;
  /** Ёмкость батареи, с которой считался прогноз (для сверки «кВт·ч на 100% SoC»). */
  batteryCapacityKwh?: number;
  /** Заполняется вручную после поездки. */
  actualEndSoc?: number;
  actualAvgSpeedKmH?: number;
  actualMaxSpeedKmH?: number;
  /** Фактическая дистанция по одометру/бортовому компьютеру авто. */
  actualDistanceKm?: number;
  /** Расход по счётчику авто за поездку, кВт·ч/100 км (отделяет физику от показаний шкалы SoC). */
  actualConsumptionKwh100?: number;
  /** cold — выезд с прогревом батареи и салона, warm — «с колёс» (всё уже тёплое). Только для анализа, модель не меняет. */
  startType?: StartType;
}

export type ProfileMode = 'legacy' | 'cruise';

export interface ForecastShadow {
  /** Метод профиля скорости теневого прогноза (в старых записях не указан — это был cruise). */
  mode?: ProfileMode;
  forecastEndSoc: number;
  energyKwh: number;
  consumptionPer100Km: number;
  durationHours: number;
  calcAvgSpeedKmH?: number;
  calcMaxSpeedKmH?: number;
  speedProfile: Array<{ distanceKm: number; speedKmH: number }>;
}

export type StartType = 'cold' | 'warm';
type ActualNumericFields =
  | 'actualEndSoc' | 'actualAvgSpeedKmH' | 'actualMaxSpeedKmH' | 'actualDistanceKm' | 'actualConsumptionKwh100';
type ActualFields = ActualNumericFields | 'startType';
export type ForecastActualsPatch =
  Partial<Record<ActualNumericFields, number | undefined>> & { startType?: StartType | undefined };
export type NewForecastLogEntry = Omit<ForecastLogEntry, 'id' | 'createdAt' | 'updatedAt' | ActualFields | 'calcAvgSpeedKmH' | 'calcMaxSpeedKmH' | 'shadow'> & {
  shadow?: Omit<ForecastShadow, 'calcAvgSpeedKmH' | 'calcMaxSpeedKmH'>;
};

/** Есть ли у записи хоть один введённый вручную фактический показатель. */
export const hasActuals = (e: ForecastLogEntry) =>
  e.actualEndSoc !== undefined || e.actualAvgSpeedKmH !== undefined || e.actualMaxSpeedKmH !== undefined ||
  e.actualDistanceKm !== undefined || e.actualConsumptionKwh100 !== undefined || e.startType !== undefined;

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

export interface ForecastLogStatus {
  ok: boolean;
  at: number;
  action?: 'created' | 'updated' | 'start_soc' | 'actuals' | 'deleted';
  /** Причина, если сохранить не удалось (например, QuotaExceededError — хранилище браузера переполнено). */
  message?: string;
}
let lastStatus: ForecastLogStatus | null = null;
/** Итог последней записи в журнал — карточка в Истории показывает его, чтобы сбой сохранения не оставался незамеченным. */
export const getForecastLogStatus = (): ForecastLogStatus | null => lastStatus;

function tryWrite(entries: ForecastLogEntry[]): string | null {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    return null;
  } catch (e) {
    return e instanceof Error ? (e.name || e.message) : String(e);
  }
}

/**
 * Пишет журнал. Если браузерное хранилище переполнено, сначала сжимает старые записи (убирает профили скорости),
 * затем выбрасывает самые старые записи без введённого факта. Результат попадает в lastStatus.
 */
function writeAll(entries: ForecastLogEntry[], action: ForecastLogStatus['action'] = 'updated'): boolean {
  let work = entries;
  let err = tryWrite(work);
  if (err) {
    work = entries.map((e, i) => (i < 3 ? e : { ...e, speedProfile: [], shadow: e.shadow ? { ...e.shadow, speedProfile: [] } : undefined }));
    err = tryWrite(work);
  }
  while (err && work.length > 1) {
    let idx = -1;
    for (let i = work.length - 1; i > 0; i--) { if (!hasActuals(work[i])) { idx = i; break; } }
    work = work.filter((_, i) => i !== (idx === -1 ? work.length - 1 : idx));
    err = tryWrite(work);
  }
  lastStatus = err ? { ok: false, at: Date.now(), action, message: err } : { ok: true, at: Date.now(), action };
  try { window.dispatchEvent(new Event(CHANGE_EVENT)); } catch { /* ignore */ }
  return !err;
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

// Один и тот же маршрут (откуда, куда, длина) — записи сливаются; скорости, климат, погода и заряд в запись просто
// обновляются. Другой маршрут — новая запись.
const sameRoute = (a: NewForecastLogEntry, b: ForecastLogEntry) =>
  a.to === b.to && a.from === b.from && Math.abs(a.distanceKm - b.distanceKm) < 0.5;

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
    shadow: input.shadow
      ? {
          ...input.shadow,
          calcAvgSpeedKmH: input.shadow.durationHours > 0 ? Math.round(input.distanceKm / input.shadow.durationHours) : undefined,
          calcMaxSpeedKmH: (() => {
            const m = (input.shadow.speedProfile ?? []).reduce((mx, p) => Math.max(mx, p.speedKmH), 0);
            return m > 0 ? Math.round(m) : undefined;
          })(),
          speedProfile: downsampleProfile(input.shadow.speedProfile),
        }
      : undefined,
  };
  const all = readAll().sort((a, b) => b.createdAt - a.createdAt);
  const latest = all[0];
  if (latest && !hasActuals(latest) && now - latest.updatedAt < DEDUPE_WINDOW_MS && sameRoute(entry, latest)) {
    all[0] = { ...latest, ...entry, id: latest.id, createdAt: latest.createdAt, updatedAt: now };
    writeAll(all, 'updated');
    return;
  }
  all.unshift({ ...entry, id: `fc_${now}_${Math.random().toString(36).slice(2, 6)}`, createdAt: now, updatedAt: now });
  // Лимит: сначала выбрасываем самые старые записи БЕЗ фактического результата — размеченные ценнее.
  while (all.length > MAX_ENTRIES) {
    let idx = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      if (!hasActuals(all[i])) { idx = i; break; }
    }
    all.splice(idx === -1 ? all.length - 1 : idx, 1);
  }
  writeAll(all, 'created');
}

/** Обновляет фактические показатели записи; ключ со значением undefined очищает поле. */
export function setForecastActuals(id: string, patch: ForecastActualsPatch): void {
  const all = readAll();
  const i = all.findIndex((e) => e.id === id);
  if (i === -1) return;
  const next = { ...all[i], ...patch, updatedAt: Date.now() };
  (Object.keys(patch) as ActualFields[]).forEach((k) => { if (patch[k] === undefined) delete next[k]; });
  all[i] = next;
  writeAll(all, 'actuals');
}

export function setForecastActualEndSoc(id: string, actualEndSoc: number | undefined): void {
  setForecastActuals(id, { actualEndSoc });
}

/**
 * Заряд на старте поменяли на экране уже после расчёта (быстрый путь без полного пересчёта): обновляем
 * последнюю запись без введённого факта — старт и прогноз финиша (основной и для сравнения) по уже посчитанной энергии.
 */
export function updateLatestForecastStartSoc(startSoc: number): void {
  const all = readAll().sort((a, b) => b.createdAt - a.createdAt);
  const e = all[0];
  if (!e || hasActuals(e)) return;
  const cap = e.batteryCapacityKwh ?? 51.87;
  const endSoc = (energyKwh: number) => Math.max(0, Number((startSoc - (energyKwh / cap) * 100).toFixed(1)));
  all[0] = {
    ...e,
    startSoc,
    forecastEndSoc: endSoc(e.energyKwh),
    shadow: e.shadow ? { ...e.shadow, forecastEndSoc: endSoc(e.shadow.energyKwh) } : undefined,
    updatedAt: Date.now(),
  };
  writeAll(all, 'start_soc');
}

export function deleteForecastLogEntry(id: string): void {
  writeAll(readAll().filter((e) => e.id !== id), 'deleted');
}

/**
 * Отклонение факта от прогноза. deltaPp = факт − прогноз: минус — финиш оказался НИЖЕ прогноза
 * (прогноз был оптимистичным). per100Km нормирует на длину маршрута.
 */
export function forecastDelta(entry: ForecastLogEntry): { deltaPp: number; per100Km: number } | null {
  const km = entry.actualDistanceKm ?? entry.distanceKm;
  if (entry.actualEndSoc === undefined || !Number.isFinite(entry.actualEndSoc) || km <= 0) return null;
  const deltaPp = entry.actualEndSoc - entry.forecastEndSoc;
  return { deltaPp, per100Km: (deltaPp / km) * 100 };
}

/**
 * Сверка по счётчику энергии авто. energyDelta* — физический недобор/перебор прогноза (кВт·ч/100 км,
 * плюс = авто потратило больше прогноза). kwhPer100Soc — сколько кВт·ч приходится на 100% SoC в этой поездке:
 * заметное отличие от номинала указывает на шкалу SoC (холодная батарея, верх шкалы LFP), а не на физику.
 */
export function forecastEnergyCheck(entry: ForecastLogEntry): {
  energyDelta: number;
  energyDeltaPct: number;
  kwhPer100Soc: number | null;
  capacityDevPct: number | null;
} | null {
  const cons = entry.actualConsumptionKwh100;
  if (cons === undefined || !Number.isFinite(cons) || entry.consumptionPer100Km <= 0) return null;
  const energyDelta = cons - entry.consumptionPer100Km;
  const km = entry.actualDistanceKm ?? entry.distanceKm;
  const socDrop = entry.actualEndSoc !== undefined ? entry.startSoc - entry.actualEndSoc : NaN;
  const cap = entry.batteryCapacityKwh ?? 51.87;
  let kwhPer100Soc: number | null = null;
  let capacityDevPct: number | null = null;
  if (Number.isFinite(socDrop) && socDrop > 0 && km > 0) {
    kwhPer100Soc = ((cons * km) / 100 / socDrop) * 100;
    capacityDevPct = (kwhPer100Soc / cap - 1) * 100;
  }
  return { energyDelta, energyDeltaPct: (energyDelta / entry.consumptionPer100Km) * 100, kwhPer100Soc, capacityDevPct };
}

const mainModeOf = (e: ForecastLogEntry): ProfileMode => e.profileMode ?? 'legacy';
const shadowModeOf = (e: ForecastLogEntry): ProfileMode => e.shadow?.mode ?? 'cruise';

/**
 * Сравнение основного и сравнительного (теневого) прогноза с фактом. Ошибка = факт − прогноз (п.п.):
 * минус — прогноз оптимистичнее. Отдельно считается ошибка по методам (legacy / cruise) независимо от того,
 * какой из них в этой записи был основным — роли менялись, а сравнивать надо методы.
 */
export function forecastShadowCompare(entry: ForecastLogEntry): {
  mainErrPp: number;
  shadowErrPp: number;
  legacyErrPp: number;
  cruiseErrPp: number;
  closer: 'main' | 'shadow' | 'equal';
  closerMethod: ProfileMode | 'equal';
} | null {
  if (!entry.shadow || entry.actualEndSoc === undefined || !Number.isFinite(entry.actualEndSoc)) return null;
  const mainErrPp = entry.actualEndSoc - entry.forecastEndSoc;
  const shadowErrPp = entry.actualEndSoc - entry.shadow.forecastEndSoc;
  const diff = Math.abs(mainErrPp) - Math.abs(shadowErrPp);
  const closer = Math.abs(diff) < 0.3 ? 'equal' : diff > 0 ? 'shadow' : 'main';
  const mainIsCruise = mainModeOf(entry) === 'cruise';
  const cruiseErrPp = mainIsCruise ? mainErrPp : shadowErrPp;
  const legacyErrPp = mainIsCruise ? shadowErrPp : mainErrPp;
  const closerMethod: ProfileMode | 'equal' =
    closer === 'equal' ? 'equal' : (closer === 'main' ? mainModeOf(entry) : shadowModeOf(entry));
  return { mainErrPp, shadowErrPp, legacyErrPp, cruiseErrPp, closer, closerMethod };
}

/** Итог по записям с фактом и двумя методами: смещение и средняя абсолютная ошибка, п.п. на 100 км. */
export function forecastShadowSummary(entries: ForecastLogEntry[]): {
  n: number;
  legacyBias: number;
  cruiseBias: number;
  legacyMae: number;
  cruiseMae: number;
  cruiseCloser: number;
  legacyCloser: number;
} | null {
  const rows = entries
    .map((e) => ({ e, c: forecastShadowCompare(e) }))
    .filter((x): x is { e: ForecastLogEntry; c: NonNullable<ReturnType<typeof forecastShadowCompare>> } => x.c !== null);
  if (rows.length === 0) return null;
  const per100 = (e: ForecastLogEntry, v: number) => (v / (e.actualDistanceKm ?? e.distanceKm)) * 100;
  const legacy = rows.map(({ e, c }) => per100(e, c.legacyErrPp));
  const cruise = rows.map(({ e, c }) => per100(e, c.cruiseErrPp));
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  return {
    n: rows.length,
    legacyBias: mean(legacy),
    cruiseBias: mean(cruise),
    legacyMae: mean(legacy.map(Math.abs)),
    cruiseMae: mean(cruise.map(Math.abs)),
    cruiseCloser: rows.filter(({ c }) => c.closerMethod === 'cruise').length,
    legacyCloser: rows.filter(({ c }) => c.closerMethod === 'legacy').length,
  };
}

/** Локальное время устройства (ГГГГ-ММ-ДД ЧЧ:ММ). toISOString() давал UTC — со сдвигом на часовой пояс. */
function localDateTime(ts: number): string {
  const d = new Date(ts);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function forecastLogToCSV(entries: ForecastLogEntry[]): string {
  const headers = [
    'Дата', 'Откуда', 'Куда', 'Дистанция (км)', 'Старт %', 'Прогноз финиш %', 'Факт финиш %',
    'Откл. (п.п.)', 'Откл. (п.п./100км)', 'Факт: дистанция авто (км)', 'Факт: расход авто (кВт⋅ч/100км)', 'Откл. расхода (кВт⋅ч/100км)', 'Откл. расхода (%)', 'кВт⋅ч на 100% SoC', 'Ёмкость в расчёте (кВт⋅ч)', 'Тип старта', 'Прогноз кВт⋅ч', 'Прогноз кВт⋅ч/100км',
    'План: скорость сред. (км/ч)', 'План: скорость макс. (км/ч)', 'Модель: скорость сред. (км/ч)', 'Модель: скорость макс. (км/ч)',
    'Факт: скорость сред. (км/ч)', 'Факт: скорость макс. (км/ч)', 'Время (ч)', 'Погода: режим', 'Темп. °C',
    'Ветер км/ч', 'Угол ветра °', 'Ветер (подпись)', 'Осадки мм/ч', 'Осадки (подпись)', 'Климат',
    'Климат кВт', 'Пассажиры', 'Набор м', 'Спуск м', 'База кВт⋅ч', 'Темп. кВт⋅ч', 'Ветер кВт⋅ч',
    'Осадки кВт⋅ч', 'Стиль кВт⋅ч', 'Рельеф кВт⋅ч', 'Климат кВт⋅ч', 'Рекуперация кВт⋅ч', 'Профиль скорости (JSON)',
    'Теневой: прогноз финиш %', 'Теневой: расход (кВт⋅ч/100км)', 'Теневой: энергия (кВт⋅ч)', 'Теневой: скорость сред. модели (км/ч)',
    'Теневой: скорость макс. модели (км/ч)', 'Теневой: откл. (п.п.)', 'Ближе к факту (метод)', 'Теневой: профиль скорости (JSON)',
    'Метод основного', 'Метод теневого', 'Средняя по данным маршрута (км/ч)',
  ];
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = entries.map((e) => {
    const d = forecastDelta(e);
    const en = forecastEnergyCheck(e);
    const sc = forecastShadowCompare(e);
    return [
      localDateTime(e.createdAt), e.from, e.to, e.distanceKm, e.startSoc,
      e.forecastEndSoc, e.actualEndSoc ?? '', d ? d.deltaPp.toFixed(1) : '', d ? d.per100Km.toFixed(2) : '',
      e.actualDistanceKm ?? '', e.actualConsumptionKwh100 ?? '', en ? en.energyDelta.toFixed(2) : '', en ? en.energyDeltaPct.toFixed(1) : '',
      en && en.kwhPer100Soc !== null ? en.kwhPer100Soc.toFixed(1) : '', e.batteryCapacityKwh ?? '',
      e.startType === 'cold' ? 'с прогревом' : e.startType === 'warm' ? 'с колёс' : '',
      e.energyKwh, e.consumptionPer100Km, e.plannedSpeedKmH, e.plannedMaxSpeedKmH, e.calcAvgSpeedKmH ?? '', e.calcMaxSpeedKmH ?? '',
      e.actualAvgSpeedKmH ?? '', e.actualMaxSpeedKmH ?? '', e.durationHours.toFixed(2),
      e.weatherMode === 'current' ? 'прогноз' : 'ручной', e.temperatureC, e.windKmH, Math.round(e.relativeWindAngleDeg),
      e.windLabel, e.precipitationMmH, e.precipitationLabel, e.climateOn ? 'Вкл' : 'Выкл', e.climatePowerKw,
      e.passengers, Math.round(e.elevationGainM), Math.round(e.elevationLossM), e.parts.baseKwh, e.parts.temperatureKwh,
      e.parts.windKwh, e.parts.precipitationKwh, e.parts.driverKwh, e.parts.elevationKwh, e.parts.climateKwh,
      e.parts.regenKwh, JSON.stringify(e.speedProfile),
      e.shadow?.forecastEndSoc ?? '', e.shadow?.consumptionPer100Km ?? '', e.shadow?.energyKwh ?? '',
      e.shadow?.calcAvgSpeedKmH ?? '', e.shadow?.calcMaxSpeedKmH ?? '',
      sc ? sc.shadowErrPp.toFixed(1) : '',
      sc ? (sc.closerMethod === 'cruise' ? 'крейсер' : sc.closerMethod === 'legacy' ? 'прежний' : 'одинаково') : '',
      e.shadow ? JSON.stringify(e.shadow.speedProfile) : '',
      mainModeOf(e) === 'cruise' ? 'крейсер' : 'прежний', e.shadow ? (shadowModeOf(e) === 'cruise' ? 'крейсер' : 'прежний') : '',
      e.osrmAvgSpeedKmH ?? '',
    ].map(esc).join(';');
  });
  return '\uFEFF' + [headers.join(';'), ...rows].join('\n');
}
