import { UserSettings, TripSession } from '../types';

// Single reference point for "average/expected" Dongfeng Vigo consumption (kWh/100km), used
// everywhere a calculation needs to compare against a baseline — driver-style scoring (both the
// live-trip factor and the all-time History tab badge) and the speed-only impact percentage.
// Previously three different numbers (14.0 / 14.5 / 14.8) were used for conceptually the same
// reference, which could make related percentages disagree with each other.
export const BENCHMARK_CONSUMPTION_KWH_100KM = 14.5;

// Unified real-world speed consumption curve for Dongfeng Vigo.
// Kept in one place so Calculator, HUD and segmented-route calculations cannot drift apart.
// High-speed points are intentionally steeper from ~90 km/h because aerodynamic drag becomes
// the dominant road-load component for this crossover. The curve is calibrated conservatively
// from observed highway behaviour and should be refined as more real trips are logged.
export const VIGO_SPEED_CONSUMPTION_CURVE: Array<[number, number]> = [
  [30, 11.2], [50, 12.0], [60, 12.8], [70, 13.5], [80, 14.2],
  [90, 15.5], [100, 17.5], [110, 20.0], [120, 22.8], [130, 25.6],
  [140, 28.5], [150, 31.5],
];

export function interpolateVigoSpeedConsumption(speedKmH: number): number {
  const speed = Math.max(15, Math.min(150, speedKmH));
  if (speed <= VIGO_SPEED_CONSUMPTION_CURVE[0][0]) return VIGO_SPEED_CONSUMPTION_CURVE[0][1];
  const last = VIGO_SPEED_CONSUMPTION_CURVE[VIGO_SPEED_CONSUMPTION_CURVE.length - 1];
  if (speed >= last[0]) return last[1];

  for (let i = 1; i < VIGO_SPEED_CONSUMPTION_CURVE.length; i++) {
    const [s1, c1] = VIGO_SPEED_CONSUMPTION_CURVE[i - 1];
    const [s2, c2] = VIGO_SPEED_CONSUMPTION_CURVE[i];
    if (speed <= s2) {
      const t = (speed - s1) / (s2 - s1);
      return c1 + (c2 - c1) * t;
    }
  }
  return last[1];
}

export const DEFAULT_SETTINGS: UserSettings = {
  batteryCapacityKwh: 51.87,
  currency: 'Br',
  regionPreset: 'belarus',
  homeTariff: 0.27,
  homeNightTariff: 0.16,
  fastDayTariff: 0.56,
  fastNightTariff: 0.43,
  slowPublicTariff: 0.43,
  malankaDcTariff: 0.56,
  malankaAcTariff: 0.43,
  evikaTariff: 0.43,
  batteryFlyTariff: 0.60,
  zaryadkaTariff: 0.56,
  zaryadkaDayTariff: 0.56,
  zaryadkaNightTariff: 0.43,
  zaryadkaDcTariff: 0.56,
  zaryadkaAcTariff: 0.43,
  gasEquivalentL100km: 8.0,
  gasPricePerLiter: 2.46,
  hapticFeedback: true,
  theme: 'dark',
  targetMaxSoc: 80,
};

export const REGION_PRESETS = {
  belarus: {
    name: 'Беларусь (Br / BYN)',
    currency: 'Br',
    homeTariff: 0.27,
    homeNightTariff: 0.16,
    fastDayTariff: 0.56,
    fastNightTariff: 0.43,
    slowPublicTariff: 0.43,
    malankaDcTariff: 0.56,
    malankaAcTariff: 0.43,
    evikaTariff: 0.43,
    batteryFlyTariff: 0.60,
    zaryadkaTariff: 0.56,
    zaryadkaDayTariff: 0.56,
    zaryadkaNightTariff: 0.43,
    zaryadkaDcTariff: 0.56,
    zaryadkaAcTariff: 0.43,
    gasEquivalentL100km: 8.0,
    gasPricePerLiter: 2.46,
  },
  russia: {
    name: 'Россия (₽ / RUB)',
    currency: '₽',
    homeTariff: 5.2,
    homeNightTariff: 2.8,
    fastDayTariff: 20.0,
    fastNightTariff: 14.0,
    slowPublicTariff: 12.0,
    malankaDcTariff: 20.0,
    malankaAcTariff: 12.0,
    evikaTariff: 12.0,
    batteryFlyTariff: 19.0,
    zaryadkaTariff: 20.0,
    zaryadkaDayTariff: 20.0,
    zaryadkaNightTariff: 14.0,
    zaryadkaDcTariff: 20.0,
    zaryadkaAcTariff: 12.0,
    gasEquivalentL100km: 8.0,
    gasPricePerLiter: 62.5,
  },
};

// Initial realistic sample sessions for Dongfeng Vigo (51.87 kWh)
export const INITIAL_SESSIONS: TripSession[] = [
  {
    id: 'trip-1',
    date: '2025-05-18',
    title: 'Город + вечерний поток',
    startSoc: 90,
    endSoc: 38,
    distanceKm: 185,
    energyUsedKwh: 26.97,
    consumptionPer100Km: 14.58,
    kmPerKwh: 6.86,
    chargingType: 'malanka_dc',
    totalCost: 15.1,
    gasCostEquivalent: 36.41,
    moneySaved: 21.31,
    roadType: 'city',
    climateOn: true,
    temperature: 21,
    note: 'Климат 22°C, режим ECO',
    createdAt: Date.now() - 86400000 * 5,
  },
  {
    id: 'trip-2',
    date: '2025-05-15',
    title: 'Загородная поездка (трасса М1)',
    startSoc: 100,
    endSoc: 22,
    distanceKm: 242,
    energyUsedKwh: 40.46,
    consumptionPer100Km: 16.72,
    kmPerKwh: 5.98,
    chargingType: 'evika',
    totalCost: 17.4,
    gasCostEquivalent: 47.63,
    moneySaved: 30.23,
    roadType: 'highway',
    climateOn: false,
    temperature: 18,
    note: 'Круиз-контроль 95-100 км/ч',
    createdAt: Date.now() - 86400000 * 8,
  },
  {
    id: 'trip-3',
    date: '2025-05-10',
    title: 'Ежедневные поездки работа-дом',
    startSoc: 85,
    endSoc: 45,
    distanceKm: 154,
    energyUsedKwh: 20.75,
    consumptionPer100Km: 13.47,
    kmPerKwh: 7.42,
    chargingType: 'home_night',
    totalCost: 3.32,
    gasCostEquivalent: 30.31,
    moneySaved: 26.99,
    roadType: 'city',
    climateOn: false,
    temperature: 17,
    note: 'Плавный стиль вождения',
    createdAt: Date.now() - 86400000 * 13,
  },
];

const SETTINGS_KEY = 'vigo_ev_settings_v2';
const SESSIONS_KEY = 'vigo_ev_sessions_v1';

export function loadSettings(): UserSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY) || localStorage.getItem('vigo_ev_settings_v1');
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      fastDayTariff: parsed.fastDayTariff ?? parsed.malankaDcTariff ?? parsed.fastChargeTariff ?? DEFAULT_SETTINGS.fastDayTariff,
      fastNightTariff: parsed.fastNightTariff ?? parsed.nightTariff ?? DEFAULT_SETTINGS.fastNightTariff,
      slowPublicTariff: parsed.slowPublicTariff ?? parsed.malankaAcTariff ?? DEFAULT_SETTINGS.slowPublicTariff,
      homeTariff: parsed.homeTariff ?? DEFAULT_SETTINGS.homeTariff,
      homeNightTariff: parsed.homeNightTariff ?? DEFAULT_SETTINGS.homeNightTariff,
      malankaDcTariff: parsed.malankaDcTariff ?? parsed.fastDayTariff ?? DEFAULT_SETTINGS.malankaDcTariff,
      malankaAcTariff: parsed.malankaAcTariff ?? parsed.slowPublicTariff ?? DEFAULT_SETTINGS.malankaAcTariff,
      evikaTariff: parsed.evikaTariff ?? DEFAULT_SETTINGS.evikaTariff,
      batteryFlyTariff: parsed.batteryFlyTariff ?? DEFAULT_SETTINGS.batteryFlyTariff,
      zaryadkaTariff: parsed.zaryadkaTariff ?? parsed.zaryadkaDayTariff ?? parsed.zaryadkaDcTariff ?? DEFAULT_SETTINGS.zaryadkaTariff,
      zaryadkaDayTariff: parsed.zaryadkaDayTariff ?? parsed.zaryadkaTariff ?? parsed.zaryadkaDcTariff ?? DEFAULT_SETTINGS.zaryadkaDayTariff,
      zaryadkaNightTariff: parsed.zaryadkaNightTariff ?? (parsed.zaryadkaTariff ? parsed.zaryadkaTariff * 0.75 : DEFAULT_SETTINGS.zaryadkaNightTariff),
      zaryadkaDcTariff: parsed.zaryadkaDcTariff ?? parsed.zaryadkaTariff ?? DEFAULT_SETTINGS.zaryadkaDcTariff,
      zaryadkaAcTariff: parsed.zaryadkaAcTariff ?? DEFAULT_SETTINGS.zaryadkaAcTariff,
    };
  } catch (err) {
    console.error('Failed to load settings:', err);
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: UserSettings): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

export function loadSessions(): TripSession[] {
  if (typeof window === 'undefined') return INITIAL_SESSIONS;
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) {
      // Seed with initial sessions
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(INITIAL_SESSIONS));
      return INITIAL_SESSIONS;
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : INITIAL_SESSIONS;
  } catch (err) {
    console.error('Failed to load sessions:', err);
    return INITIAL_SESSIONS;
  }
}

export function saveSessions(sessions: TripSession[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch (err) {
    console.error('Failed to save sessions:', err);
  }
}

export function getTariffForType(
  chargingType: TripSession['chargingType'],
  settings: UserSettings,
  customTariff?: number
): number {
  if (chargingType === 'custom') return customTariff ?? 0;
  if (chargingType === 'free') return 0;
  if (chargingType === 'malanka_dc') return settings.malankaDcTariff ?? 0.56;
  if (chargingType === 'malanka_ac') return settings.malankaAcTariff ?? 0.43;
  if (chargingType === 'evika') return settings.evikaTariff ?? 0.43;
  if (chargingType === 'batteryfly') return settings.batteryFlyTariff ?? 0.60;
  if (chargingType === 'zaryadka_day' || chargingType === 'zaryadka') return settings.zaryadkaDayTariff ?? settings.zaryadkaTariff ?? settings.zaryadkaDcTariff ?? 0.56;
  if (chargingType === 'zaryadka_night') return settings.zaryadkaNightTariff ?? (settings.zaryadkaTariff ? settings.zaryadkaTariff * 0.75 : 0.43);
  if (chargingType === 'zaryadka_dc') return settings.zaryadkaDcTariff ?? settings.zaryadkaDayTariff ?? settings.zaryadkaTariff ?? 0.56;
  if (chargingType === 'zaryadka_ac') return settings.zaryadkaAcTariff ?? 0.43;
  if (chargingType === 'home_night') return settings.homeNightTariff ?? (settings.homeTariff * 0.6);
  if (chargingType === 'home' || chargingType === 'home_day') return settings.homeTariff;
  if (chargingType === 'fast_day' || chargingType === 'fast_dc') return settings.fastDayTariff;
  if (chargingType === 'fast_night') return settings.fastNightTariff;
  if (chargingType === 'slow_public') return settings.slowPublicTariff;
  return settings.homeTariff;
}

/**
 * Predicts EV energy consumption (kWh/100km) and estimated range for Dongfeng Vigo
 * by analyzing trips from the last month + real-time GPS average speed + GPS weather temperature.
 */
export interface ConsumptionForecast {
  estimatedConsumption: number; // kWh/100km
  baseConsumption: number; // Dongfeng Vigo baseline ~14.5 kWh/100km
  estimatedRangeKm: number; // Remaining full battery range in km
  driverStyleFactor: number; // 1.0 = standard, <1 = eco, >1 = dynamic
  temperatureImpactPct: number; // e.g. +12% due to cold/hot total
  climateImpactPct?: number; // e.g. +14% due to heating/cooling at current outdoor temp
  climateDeltaKwh100?: number; // equivalent kWh/100km at 60 km/h; actual route energy uses HVAC power × time
  climatePowerKw?: number; // HVAC electrical load in kW
  climateLabel?: string; // e.g. "Обогрев (+18%)" or "Климат ЭКО (0%)"
  climateDescription?: string;
  precipitationImpactPct?: number; // e.g. +8% due to wet road / rain / snow
  precipitationLabel?: string; // e.g. "Дождь (+8%)", "Снег (+14%)"
  precipitationDescription?: string;
  roadSurfaceCondition?: string; // e.g. "Мокрый асфальт"
  speedImpactPct: number; // e.g. +18% due to high speed
  windImpactPct?: number; // e.g. +4% due to headwind, -3% due to tailwind
  windStatusText?: string; // e.g. "Встречный 18 км/ч (+4%)"
  elevationImpactPct?: number; // e.g. +9% net due to climbing, -5% due to descent/regen
  elevationDeltaKwh100?: number; // net kWh/100km added (climb) or credited (descent regen)
  elevationLabel?: string; // e.g. "Подъём (+3.2 кВт⋅ч/100)"
  monthlyTripsCount: number;
  dataSource: 'current_trip' | 'monthly_history' | 'all_history' | 'dongfeng_vigo_model';
}

/**
 * Calculates HVAC / Climate control consumption multiplier based on ambient temperature and AC/heating state.
 * Real EV physics (Dongfeng Vigo / EV standard):
 * - If climate is OFF: HVAC impact is 0% (only baseline ventilation).
 * - If climate is ON:
 *   - Cold conditions (heating via PTC/heat pump): increases linearly as temperature drops below 19°C.
 *   - Hot conditions (AC cooling compressor): increases linearly as temperature rises above 23°C.
 */
export function calculateClimateImpact(temperatureC: number | undefined, climateOn: boolean): {
  impactPct: number;
  deltaKwh100: number;
  powerKw: number;
  factor: number;
  label: string;
  description: string;
} {
  if (!climateOn) {
    return { impactPct: 0, deltaKwh100: 0, powerKw: 0, factor: 1.0, label: 'Климат ЭКО (0%)', description: 'Климат отключен (0%)' };
  }

  const temp = temperatureC ?? 20;

  // HVAC is modeled as a real electrical load (kW), not as a fixed kWh/100 km value.
  // The exact load depends on outdoor temperature; the energy consumed on a route is
  // then power (kW) × actual time spent driving (h).
  let powerKw: number;
  let label: string;
  let description: string;

  if (temp >= 19 && temp <= 23) {
    powerKw = 0.40;
    label = 'Климат · комфорт';
    description = 'Базовая электрическая нагрузка HVAC ~0,4 кВт';
  } else if (temp < 19) {
    // Heat-pump vehicle: the heat pump carries most cabin heating, while a supplemental
    // PTC heater assists increasingly in colder weather. These are planning estimates,
    // not measured VIGO telemetry. The PTC share is intentionally moderate because cabin
    // heat demand falls after the initial warm-up on a long trip.
    if (temp >= 10) {
      powerKw = 0.55 + (19 - temp) * 0.030;
    } else if (temp >= 0) {
      powerKw = 0.82 + (10 - temp) * 0.048;
    } else if (temp >= -10) {
      powerKw = 1.30 + Math.abs(temp) * 0.060;
    } else if (temp >= -20) {
      powerKw = 1.90 + (Math.abs(temp) - 10) * 0.080;
    } else {
      powerKw = 2.70 + (Math.abs(temp) - 20) * 0.110;
    }
    powerKw = Math.min(3.8, Math.max(0.55, powerKw));
    label = `Тепловой насос + ТЭН (${powerKw.toFixed(1)} кВт)`;
    description = `Оценочная электрическая нагрузка теплового насоса с поддержкой ТЭН при ${temp}°C: ~${powerKw.toFixed(1)} кВт`;
  } else {
    powerKw = 0.65 + (temp - 23) * 0.10;
    powerKw = Math.min(2.6, Math.max(0.65, powerKw));
    label = `A/C охлаждение (${powerKw.toFixed(1)} кВт)`;
    description = `Оценочная электрическая нагрузка охлаждения при ${temp}°C: ~${powerKw.toFixed(1)} кВт`;
  }

  // kWh/100 km is only a legacy equivalent. The primary HVAC metric is kW (= kWh/h),
  // and route HVAC energy is calculated as power × actual trip time.
  const deltaKwh100 = Number((powerKw / 60 * 100).toFixed(2));
  const impactPct = Math.round((deltaKwh100 / BENCHMARK_CONSUMPTION_KWH_100KM) * 100);
  return { impactPct, deltaKwh100, powerKw, factor: Number((1 + impactPct / 100).toFixed(2)), label, description };
}

export interface PrecipitationImpact {
  impactPct: number;
  factor: number;
  type: 'dry' | 'damp' | 'rain' | 'heavy_rain' | 'snow' | 'heavy_snow';
  label: string;
  roadState: string;
  description: string;
}

/**
 * Calculates rolling resistance and hydrodynamic drag coefficient from precipitation and road surface condition.
 * EV Physics:
 * - Dry road: baseline (0% added resistance)
 * - Damp / Mist / Fog: +2% to +4%
 * - Moderate Rain (water displacement by tires): +8%
 * - Heavy Rain / Puddles (hydrodynamic drag & spray): +12%
 * - Snow / Slush / Packed snow (compression and friction loss): +14% to +22%
 */
export function calculatePrecipitationImpact(
  weatherCode?: number,
  precipitationMm?: number
): PrecipitationImpact {
  const code = weatherCode ?? 0;
  const precip = Math.max(0, precipitationMm ?? 0);

  // Snow: intensity matters. A light snowfall is not equivalent to slush/deep snow.
  if ([71, 73, 75, 77, 85, 86].includes(code) || (code >= 70 && code < 80)) {
    const impactPct = (code === 75 || code === 86 || precip >= 3.0) ? 22
      : precip >= 1.0 ? 18
      : precip >= 0.3 ? 14
      : 8;
    const heavy = impactPct >= 20;
    return {
      impactPct, factor: 1 + impactPct / 100,
      type: heavy ? 'heavy_snow' : 'snow',
      label: `Снег (${impactPct >= 20 ? 'сильный' : 'умеренный'}, +${impactPct}%)`,
      roadState: heavy ? 'Снежная каша / накат' : 'Заснеженный асфальт',
      description: `Поправка зависит от интенсивности снега: ${impactPct}%`,
    };
  }

  if ([56, 57, 66, 67].includes(code)) {
    return {
      impactPct: 18, factor: 1.18, type: 'heavy_snow',
      label: 'Ледяной дождь (+18%)', roadState: 'Гололедица / накат',
      description: 'Потери на сцепление и сопротивление качению (+18%)',
    };
  }

  // Rain impact is now continuous with precipitation intensity instead of a hard
  // 8%/12% jump. For the operational hourly forecast, precipitationMm is mm/h.
  // Long-range seasonal data are converted to a daily-average hourly equivalent.
  const rainCodes = [51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 99];
  if (rainCodes.includes(code) || precip > 0) {
    let impactPct: number;
    if (precip <= 0.1) impactPct = 2;
    else if (precip <= 0.3) impactPct = 3;
    else if (precip <= 0.7) impactPct = 5;
    else if (precip <= 1.5) impactPct = 7;
    else if (precip <= 3.0) impactPct = 9;
    else if (precip <= 6.0) impactPct = 11;
    else impactPct = 12;

    // WMO heavy-rain codes retain a conservative minimum even when the API's
    // instantaneous precipitation value happens to be small.
    if ([65, 81, 82, 95, 96, 99].includes(code)) impactPct = Math.max(impactPct, 10);
    const heavy = impactPct >= 10;
    return {
      impactPct, factor: 1 + impactPct / 100,
      type: heavy ? 'heavy_rain' : impactPct <= 3 ? 'damp' : 'rain',
      label: `${impactPct >= 10 ? 'Ливень' : impactPct <= 3 ? 'Морось' : 'Дождь'} (+${impactPct}%)`,
      roadState: impactPct >= 10 ? 'Глубокие лужи / вода' : 'Мокрый асфальт',
      description: `Интенсивность осадков ~${precip.toFixed(1)} мм/ч → поправка +${impactPct}%`,
    };
  }

  if ([45, 48].includes(code)) {
    return { impactPct: 2, factor: 1.02, type: 'damp', label: 'Туман (+2%)', roadState: 'Сырой асфальт', description: 'Влажная поверхность дороги (+2%)' };
  }

  return { impactPct: 0, factor: 1.0, type: 'dry', label: 'Сухо (0%)', roadState: 'Сухой асфальт', description: 'Оптимальное сопротивление качению (0%)' };
}

/**
 * Calculates historical driving style coefficient and classification based on trips history.
 */
export function calculateHistoricalDriverStyle(sessions: TripSession[]): {
  factor: number;
  label: string;
  subLabel: string;
  diffPct: number;
  avgConsumption: number;
  benchmarkConsumption: number;
  validTripsCount: number;
} {
  const benchmarkConsumption = BENCHMARK_CONSUMPTION_KWH_100KM;
  const validSessions = sessions.filter((s) => s.consumptionPer100Km > 6 && s.consumptionPer100Km < 40);

  if (validSessions.length === 0) {
    return {
      factor: 1.0,
      label: 'Стандартный',
      subLabel: 'Нет сохраненных поездок для анализа',
      diffPct: 0,
      avgConsumption: benchmarkConsumption,
      benchmarkConsumption,
      validTripsCount: 0,
    };
  }

  const totalKm = validSessions.reduce((acc, s) => acc + s.distanceKm, 0);
  const totalKwh = validSessions.reduce((acc, s) => acc + s.energyUsedKwh, 0);
  const avgConsumption = totalKm > 0 ? (totalKwh / totalKm) * 100 : validSessions.reduce((acc, s) => acc + s.consumptionPer100Km, 0) / validSessions.length;

  const rawFactor = avgConsumption / benchmarkConsumption;
  const factor = Number(Math.max(0.70, Math.min(1.50, rawFactor)).toFixed(2));
  const diffPct = Math.round((factor - 1) * 100);

  let label = 'Сбалансированный';
  let subLabel = 'Умеренный стандартный темп';

  if (factor < 0.90) {
    label = 'Супер-Эко';
    subLabel = `Экономия энергии на ${Math.abs(diffPct)}% выше эталона`;
  } else if (factor < 0.97) {
    label = 'Экономный (Эко-стиль)';
    subLabel = `Плавное ускорение, расход ниже эталона на ${Math.abs(diffPct)}%`;
  } else if (factor <= 1.05) {
    label = 'Сбалансированный';
    subLabel = 'Оптимальное соотношение скорости и расхода энергии';
  } else if (factor <= 1.15) {
    label = 'Динамичный';
    subLabel = `Активные ускорения, расход выше эталона на +${diffPct}%`;
  } else {
    label = 'Агрессивный / Спортивный';
    subLabel = `Высокие скорости и резкие обгоны (+${diffPct}% к расходу)`;
  }

  return {
    factor,
    label,
    subLabel,
    diffPct,
    avgConsumption: Number(avgConsumption.toFixed(1)),
    benchmarkConsumption,
    validTripsCount: validSessions.length,
  };
}

/**
 * Computes total ascent/descent (meters) from a sequence of elevation samples, filtering out
 * GPS/API noise below the given threshold so minor jitter doesn't get counted as real climbing.
 */
export function computeElevationGainLoss(
  elevationsM: number[],
  noiseThresholdM = 1.5
): { gainM: number; lossM: number } {
  let gainM = 0;
  let lossM = 0;
  let lastCounted = elevationsM.length > 0 ? elevationsM[0] : 0;

  for (let i = 1; i < elevationsM.length; i++) {
    const delta = elevationsM[i] - lastCounted;
    if (Math.abs(delta) < noiseThresholdM) continue;
    if (delta > 0) {
      gainM += delta;
    } else {
      lossM += Math.abs(delta);
    }
    lastCounted = elevationsM[i];
  }

  return { gainM: Math.round(gainM), lossM: Math.round(lossM) };
}

export function estimateTripConsumption(
  avgSpeedKmH: number,
  temperatureC: number | undefined,
  sessions: TripSession[],
  batteryCapacityKwh = 51.87,
  climateOn = true,
  windSpeedKmH?: number,
  relativeWindAngleDeg?: number,
  customDriverStyleFactor?: number,
  weatherCode?: number,
  precipitationMm?: number,
  elevation?: { gainM: number; lossM: number; distanceKm: number },
  tripDurationHours?: number,
  climatePowerOverrideKw?: number
): ConsumptionForecast {
  // 1. Calculate base physical consumption for Dongfeng Vigo (51.87 kWh, ~1526 kg curb weight)
  // Physics curve: rolling resistance + aerodynamic drag (Cd*A*v^3) + base electrical load
  const effectiveSpeed = Math.max(15, Math.min(150, avgSpeedKmH > 0 ? avgSpeedKmH : 55));
  
  // Unified speed curve. Keeping this shared with segmented-route calculations guarantees
  // the same high-speed model in Calculator and HUD.
  const baseSpeedConsumption = interpolateVigoSpeedConsumption(effectiveSpeed);

  // 2. Temperature & Climate Impact (Separating physical battery cell resistance vs HVAC load)
  const temp = temperatureC ?? 20; // Default optimal 20°C if weather not loaded

  // A. Physical battery cell efficiency in cold (independent of cabin HVAC).
  // Saturating curve instead of unbounded linear growth: internal resistance really does rise as
  // cells get colder, but it approaches a physical ceiling rather than climbing forever — a real
  // pack doesn't lose 40%+ efficiency at -40°C just because -20°C already cost 20%.
  const BATTERY_RESISTANCE_MAX_PENALTY = 0.30; // asymptotic ceiling: +30% at extreme cold
  const BATTERY_RESISTANCE_SATURATION_TAU = 48; // controls how quickly the curve approaches the ceiling
  const degreesBelowComfort = Math.max(0, 18 - temp);
  const batteryResistanceMultiplier =
    1 + BATTERY_RESISTANCE_MAX_PENALTY * (1 - Math.exp(-degreesBelowComfort / BATTERY_RESISTANCE_SATURATION_TAU));

  // B. Cabin HVAC load. It is power in kW; when trip duration is known, actual energy is power × hours.
  const climateInfo = calculateClimateImpact(temp, climateOn);

  const tempMultiplier = batteryResistanceMultiplier;

  // 3. Precipitation & Road Surface Resistance Impact (water displacement, slush, snow)
  const precipInfo = calculatePrecipitationImpact(weatherCode, precipitationMm);
  const precipMultiplier = precipInfo.factor;

  // 4. Aerodynamic Wind Impact (Relative to Vehicle Heading)
  // IMPORTANT: wind is handled as air-relative velocity, not as a percentage bonus
  // applied to the whole vehicle consumption. The previous multiplier formula made the
  // wind penalty percentage shrink as vehicle speed increased, which could paradoxically
  // make a higher speed use less total energy than a lower speed in a strong headwind.
  // Physics: aerodynamic drag is proportional to airspeed^2. For a fixed road distance,
  // aerodynamic energy per 100 km therefore scales with the square of the relative air speed.
  let windMultiplier = 1.0;
  let windImpactPct = 0;
  let windStatusText = '';

  if (windSpeedKmH && windSpeedKmH > 3 && relativeWindAngleDeg !== undefined && !isNaN(relativeWindAngleDeg)) {
    const rad = (relativeWindAngleDeg * Math.PI) / 180;
    // Open-Meteo wind direction is the direction the wind comes FROM. Angle 0° therefore
    // means headwind and 180° means tailwind. Resolve the wind vector into longitudinal
    // and lateral components relative to the car.
    const longitudinalWind = windSpeedKmH * Math.cos(rad);
    const lateralWind = windSpeedKmH * Math.sin(rad);
    const relativeAirSpeed = Math.sqrt(
      Math.pow(effectiveSpeed + longitudinalWind, 2) + Math.pow(lateralWind, 2)
    );

    // Smoothly vary the aerodynamic share with speed instead of introducing a jump at 70 km/h.
    // This keeps the total consumption curve physically monotonic under headwind.
    // Decompose the no-wind consumption into a speed-dependent aerodynamic part and
    // a non-aerodynamic part.  Keep a conservative floor on the tailwind benefit: the
    // car still spends energy on rolling resistance, drivetrain/electrical loads and
    // auxiliaries, so a tailwind cannot make a higher road speed more economical than
    // a lower road speed simply because relative airspeed falls faster.
    const aeroShare = Math.min(0.55, Math.max(0.28, 0.22 + effectiveSpeed * 0.0026));
    const aeroBase = baseSpeedConsumption * aeroShare;
    const nonAeroBase = baseSpeedConsumption - aeroBase;
    const aeroWindFactor = Math.pow(relativeAirSpeed / effectiveSpeed, 2);
    const rawWindAdjustedConsumption = nonAeroBase + aeroBase * aeroWindFactor;

    // Limit the aerodynamic credit from a tailwind.  At very low relative airspeed,
    // the pure v_air^2 formula can otherwise remove an unrealistically large share of
    // the total road-load model.  A 15% minimum total-road-load credit keeps the model
    // physically conservative and preserves a monotonic speed curve.
    const tailwindFloor = relativeWindAngleDeg >= 135 && relativeWindAngleDeg <= 225
      ? baseSpeedConsumption * 0.78
      : 0;
    const windAdjustedConsumption = Math.max(rawWindAdjustedConsumption, tailwindFloor);
    windMultiplier = Math.max(0.78, Math.min(1.60, windAdjustedConsumption / baseSpeedConsumption));
    windImpactPct = Math.round((windMultiplier - 1) * 100);

    const normAngle = ((relativeWindAngleDeg % 360) + 360) % 360;
    if (normAngle <= 45 || normAngle >= 315) {
      windStatusText = `Встречный ${Math.round(windSpeedKmH)} км/ч (${windImpactPct >= 0 ? '+' : ''}${windImpactPct}%)`;
    } else if (normAngle >= 135 && normAngle <= 225) {
      windStatusText = `Попутный ${Math.round(windSpeedKmH)} км/ч (${windImpactPct >= 0 ? '+' : ''}${windImpactPct}%)`;
    } else if (normAngle > 45 && normAngle < 135) {
      windStatusText = `Боковой справа ${Math.round(windSpeedKmH)} км/ч (${windImpactPct >= 0 ? '+' : ''}${windImpactPct}%)`;
    } else {
      windStatusText = `Боковой слева ${Math.round(windSpeedKmH)} км/ч (${windImpactPct >= 0 ? '+' : ''}${windImpactPct}%)`;
    }
  }

  // 5. Elevation profile: climbs cost potential energy, sustained descents return it via regen.
  // Physics: E = m*g*h. Climbing energy is reduced by drivetrain efficiency; descent energy is
  // credited back at a lower regen efficiency (some is lost to friction/aero/heat, and regen
  // tapers off at low SoC or low speed in real cars, so we intentionally credit less than 1:1).
  let elevationDeltaKwh100 = 0;
  let elevationImpactPct = 0;
  let elevationLabel: string | undefined;

  if (elevation && elevation.distanceKm > 0.3) {
    // Same physical constants as services/routeElevation.ts (calculateElevationEnergy), so a
    // route's elevation contribution comes out identical whichever code path computes it —
    // the live HUD trip (raw altitude-sensor meters) or the route planner (OSRM+elevation API).
    const VEHICLE_MASS_KG = 1600; // ~1526 kg curb weight + a modest driver/luggage allowance
    const G = 9.80665;
    const DRIVETRAIN_EFFICIENCY = 0.90; // energy lost to motor/inverter/gearbox while climbing
    const REGEN_EFFICIENCY = 0.65; // realistic fraction of descent potential energy recovered

    const climbKwh = (VEHICLE_MASS_KG * G * Math.max(0, elevation.gainM)) / 3.6e6 / DRIVETRAIN_EFFICIENCY;
    const descentCreditKwh = (VEHICLE_MASS_KG * G * Math.max(0, elevation.lossM)) / 3.6e6 * REGEN_EFFICIENCY;
    const netKwh = climbKwh - descentCreditKwh;

    // Normalize to a kWh/100km rate so it composes with the rest of the model, then clamp to
    // guard against GPS/elevation-API noise producing an implausible spike.
    elevationDeltaKwh100 = Math.max(-8, Math.min(15, (netKwh / elevation.distanceKm) * 100));

    if (elevationDeltaKwh100 > 0.3) {
      elevationLabel = `Подъём (+${elevationDeltaKwh100.toFixed(1)} кВт⋅ч/100)`;
    } else if (elevationDeltaKwh100 < -0.3) {
      elevationLabel = `Спуск, рекуперация (${elevationDeltaKwh100.toFixed(1)} кВт⋅ч/100)`;
    } else {
      elevationLabel = 'Рельеф ровный (0)';
    }
  }

  // 6. Analyze real journal sessions from the last 30 days (1 month) or use custom live factor
  const oneMonthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentSessions = sessions.filter(
    (s) => s.createdAt && s.createdAt >= oneMonthAgo && s.consumptionPer100Km > 8 && s.consumptionPer100Km < 35
  );

  let driverStyleFactor = 1.0;
  let dataSource: ConsumptionForecast['dataSource'] = 'dongfeng_vigo_model';
  let monthlyTripsCount = recentSessions.length;

  if (customDriverStyleFactor !== undefined && !isNaN(customDriverStyleFactor)) {
    driverStyleFactor = customDriverStyleFactor;
    dataSource = 'current_trip';
  } else if (recentSessions.length >= 2) {
    dataSource = 'monthly_history';
    // Prefer the actual driving-style coefficient recorded by HUD (sharp acceleration/braking
    // analysis). Older/manual trips do not have this structured field, so their consumption is
    // used as a fallback calibration.
    const styleFactors = recentSessions
      .map((s) => {
        const match = s.note?.match(/стиль поездки:\s*x([0-9]+(?:[.,][0-9]+)?)/i);
        return match ? Number(match[1].replace(',', '.')) : NaN;
      })
      .filter((x) => Number.isFinite(x) && x >= 0.75 && x <= 1.35);

    if (styleFactors.length >= 2) {
      const avgStyle = styleFactors.reduce((acc, x) => acc + x, 0) / styleFactors.length;
      driverStyleFactor = Math.max(0.75, Math.min(1.35, avgStyle));
    } else {
      // Historical consumption contains weather, terrain and HVAC effects, so using it 1:1
      // as a permanent driving-style multiplier double-counts those effects on future routes.
      // Keep only a weak 35% calibration signal and cap it tightly around neutral.
      const historicalAvgCons =
        recentSessions.reduce((acc, s) => acc + s.consumptionPer100Km, 0) / recentSessions.length;
      const rawHistoryFactor = historicalAvgCons / BENCHMARK_CONSUMPTION_KWH_100KM;
      driverStyleFactor = Math.max(0.92, Math.min(1.08, 1 + (rawHistoryFactor - 1) * 0.35));
    }
  } else if (sessions.length >= 2) {
    dataSource = 'all_history';
    const validSessions = sessions.filter((s) => s.consumptionPer100Km > 8 && s.consumptionPer100Km < 35);
    if (validSessions.length > 0) {
      const allTimeAvg = validSessions.reduce((acc, s) => acc + s.consumptionPer100Km, 0) / validSessions.length;
      const rawHistoryFactor = allTimeAvg / BENCHMARK_CONSUMPTION_KWH_100KM;
      driverStyleFactor = Math.max(0.92, Math.min(1.08, 1 + (rawHistoryFactor - 1) * 0.35));
    }
  }

  // Final predicted consumption combining speed curve + weather + wind + precipitation + driver calibration + elevation + climate (HVAC)
  const climateDistanceKm = elevation?.distanceKm ?? 100;
  const climateDuration = tripDurationHours ?? (climateDistanceKm / effectiveSpeed);
  const climatePowerKw = climatePowerOverrideKw ?? climateInfo.powerKw;
  const climateDeltaForRoute = climateDistanceKm > 0 && climateDuration >= 0
    ? (climatePowerKw * climateDuration / climateDistanceKm) * 100
    : climateInfo.deltaKwh100;

  const calculatedCons =
    baseSpeedConsumption * tempMultiplier * windMultiplier * precipMultiplier * driverStyleFactor +
    elevationDeltaKwh100 +
    climateDeltaForRoute;
  const estimatedConsumption = Number(Math.max(9.5, Math.min(34.0, calculatedCons)).toFixed(2));
  const estimatedRangeKm = Math.round((batteryCapacityKwh / estimatedConsumption) * 100);

  const speedImpactPct = Math.round(((baseSpeedConsumption / BENCHMARK_CONSUMPTION_KWH_100KM) - 1) * 100);
  const temperatureImpactPct = Math.round((tempMultiplier - 1) * 100);
  elevationImpactPct = Math.round((elevationDeltaKwh100 / baseSpeedConsumption) * 100);

  return {
    estimatedConsumption,
    baseConsumption: BENCHMARK_CONSUMPTION_KWH_100KM,
    estimatedRangeKm,
    driverStyleFactor: Number(driverStyleFactor.toFixed(2)),
    temperatureImpactPct,
    climateImpactPct: climateInfo.impactPct,
    climateDeltaKwh100: Number(climateDeltaForRoute.toFixed(2)),
    climatePowerKw,
    climateLabel: climateInfo.label,
    climateDescription: climateInfo.description,
    precipitationImpactPct: precipInfo.impactPct,
    precipitationLabel: precipInfo.label,
    precipitationDescription: precipInfo.description,
    roadSurfaceCondition: precipInfo.roadState,
    speedImpactPct,
    windImpactPct,
    windStatusText: windStatusText || undefined,
    elevationImpactPct: elevation ? elevationImpactPct : undefined,
    elevationDeltaKwh100: elevation ? Number(elevationDeltaKwh100.toFixed(2)) : undefined,
    elevationLabel,
    monthlyTripsCount,
    dataSource,
  };
}



export interface SegmentedRoutePoint {
  lat: number;
  lon: number;
  distanceFromStartKm: number;
  elevationM?: number;
}

export interface SegmentedWeatherSample {
  distanceFromStartKm: number;
  weather: {
    temperature: number;
    weatherCode: number;
    precipitation: number;
    windSpeed: number;
    windDirection: number;
  };
  routeBearing?: number;
}

export interface SegmentedRouteBreakdown {
  distanceKm: number;
  durationHours: number;
  energyKwh: number;
  baseEnergyKwh: number;
  temperatureDeltaKwh: number;
  windDeltaKwh: number;
  precipitationDeltaKwh: number;
  driverDeltaKwh: number;
  elevationDeltaKwh: number;
  climateEnergyKwh: number;
  regenEnergyKwh: number;
  avgTemperature: number;
  avgWindSpeed: number;
  avgPrecipitation: number;
  segments: number;
  windImpactPct: number;
  precipitationImpactPct: number;
  climatePowerKw: number;
}

const bearingBetween = (a: SegmentedRoutePoint, b: SegmentedRoutePoint) => {
  const r = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};

const circularInterpolateDeg = (a: number, b: number, t: number) => {
  const delta = ((b - a + 540) % 360) - 180;
  return (a + delta * t + 360) % 360;
};

const interpolateRouteWeather = (
  distanceKm: number,
  samples: SegmentedWeatherSample[],
  fallback: SegmentedWeatherSample['weather']
) => {
  if (!samples.length) return fallback;
  if (samples.length === 1) return samples[0].weather;
  if (distanceKm <= samples[0].distanceFromStartKm) return samples[0].weather;
  if (distanceKm >= samples[samples.length - 1].distanceFromStartKm) return samples[samples.length - 1].weather;
  for (let i = 1; i < samples.length; i++) {
    const left = samples[i - 1];
    const right = samples[i];
    if (distanceKm <= right.distanceFromStartKm) {
      const span = Math.max(0.001, right.distanceFromStartKm - left.distanceFromStartKm);
      const t = Math.max(0, Math.min(1, (distanceKm - left.distanceFromStartKm) / span));
      return {
        temperature: left.weather.temperature + (right.weather.temperature - left.weather.temperature) * t,
        weatherCode: t < 0.5 ? left.weather.weatherCode : right.weather.weatherCode,
        precipitation: left.weather.precipitation + (right.weather.precipitation - left.weather.precipitation) * t,
        windSpeed: left.weather.windSpeed + (right.weather.windSpeed - left.weather.windSpeed) * t,
        windDirection: circularInterpolateDeg(left.weather.windDirection, right.weather.windDirection, t),
      };
    }
  }
  return samples[samples.length - 1].weather;
};

/**
 * Calculates route energy segment-by-segment. Weather is interpolated between the existing
 * forecast points, while local road bearing and elevation are calculated for every segment.
 * This keeps the API request count unchanged but removes the old "one average route" shortcut.
 */
export function estimateSegmentedRouteConsumption(
  points: SegmentedRoutePoint[],
  weatherSamples: SegmentedWeatherSample[],
  fallbackWeather: SegmentedWeatherSample['weather'],
  avgSpeedKmH: number,
  sessions: TripSession[],
  batteryCapacityKwh = 51.87,
  climateOn = true,
  customDriverStyleFactor?: number
): SegmentedRouteBreakdown {
  if (points.length < 2) {
    return {
      distanceKm: 0, durationHours: 0, energyKwh: 0, baseEnergyKwh: 0, temperatureDeltaKwh: 0,
      windDeltaKwh: 0, precipitationDeltaKwh: 0, driverDeltaKwh: 0, elevationDeltaKwh: 0,
      climateEnergyKwh: 0, regenEnergyKwh: 0, avgTemperature: fallbackWeather.temperature,
      avgWindSpeed: fallbackWeather.windSpeed, avgPrecipitation: fallbackWeather.precipitation,
      segments: 0, windImpactPct: 0, precipitationImpactPct: 0, climatePowerKw: 0,
    };
  }

  const speed = Math.max(5, avgSpeedKmH);
  const oneMonthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = sessions.filter((s) => s.createdAt && s.createdAt >= oneMonthAgo && s.consumptionPer100Km > 8 && s.consumptionPer100Km < 35);
  let styleFactor = 1;
  if (customDriverStyleFactor !== undefined && Number.isFinite(customDriverStyleFactor)) styleFactor = customDriverStyleFactor;
  else if (recent.length >= 2) {
    const factors = recent.map((s) => {
      const m = s.note?.match(/стиль поездки:\s*x([0-9]+(?:[.,][0-9]+)?)/i);
      return m ? Number(m[1].replace(',', '.')) : NaN;
    }).filter((x) => Number.isFinite(x) && x >= 0.75 && x <= 1.35);
    if (factors.length >= 2) styleFactor = factors.reduce((a, b) => a + b, 0) / factors.length;
    else {
      const avg = recent.reduce((a, s) => a + s.consumptionPer100Km, 0) / recent.length;
      styleFactor = 1 + (Math.max(0.92, Math.min(1.08, avg / BENCHMARK_CONSUMPTION_KWH_100KM)) - 1) * 0.35;
    }
  }
  styleFactor = Math.max(0.75, Math.min(1.35, styleFactor));

  let distanceKm = 0, durationHours = 0, energyKwh = 0, baseEnergyKwh = 0;
  let temperatureDeltaKwh = 0, windDeltaKwh = 0, precipitationDeltaKwh = 0, driverDeltaKwh = 0;
  let elevationDeltaKwh = 0, climateEnergyKwh = 0, regenEnergyKwh = 0;
  let tempWeighted = 0, windWeighted = 0, precipWeighted = 0, climatePowerWeighted = 0;
  let windWeightedBase = 0, precipWeightedBase = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const segmentDistance = Math.max(0, b.distanceFromStartKm - a.distanceFromStartKm);
    if (segmentDistance <= 0.001) continue;
    const midpoint = (a.distanceFromStartKm + b.distanceFromStartKm) / 2;
    const weather = interpolateRouteWeather(midpoint, weatherSamples, fallbackWeather);
    const bearing = bearingBetween(a, b);
    const relativeWindAngle = ((weather.windDirection - bearing + 360) % 360);
    const segDuration = segmentDistance / speed;
    const elevationGain = Math.max(0, (b.elevationM ?? 0) - (a.elevationM ?? 0));
    const elevationLoss = Math.max(0, (a.elevationM ?? 0) - (b.elevationM ?? 0));
    const climatePower = calculateClimateImpact(weather.temperature, climateOn).powerKw;
    // Cabin warm-up curve: heating/cooling a cold cabin from ambient to comfort draws noticeably
    // more power than just maintaining it afterwards (defrost, heated surfaces, bigger delta-T
    // for the heat pump to work against). We ramp from a peak multiplier at trip start down to
    // the steady maintenance level (1.0x — calculateClimateImpact's powerKw already represents
    // that steady-state load) over the first ~25 minutes, then hold flat.
    // Uses cumulative elapsed trip time (durationHours before this segment, at its midpoint) —
    // NOT this segment's own tiny duration, which is what made the old warm-up logic a no-op
    // (individual route segments are seconds to minutes long, so "segDuration - 1 hour" was
    // always negative and the multiplier never moved off 1).
    const WARMUP_PEAK_MULTIPLIER = 1.4; // +40% power while the cabin is still cold
    const WARMUP_DURATION_HOURS = 25 / 60; // ramps down to baseline over ~25 minutes
    const elapsedAtSegmentMidpoint = durationHours + segDuration / 2;
    const warmFactor = climateOn
      ? elapsedAtSegmentMidpoint >= WARMUP_DURATION_HOURS
        ? 1
        : WARMUP_PEAK_MULTIPLIER -
          (WARMUP_PEAK_MULTIPLIER - 1) * (elapsedAtSegmentMidpoint / WARMUP_DURATION_HOURS)
      : 1;
    const effectiveClimatePower = climatePower * warmFactor;
    const f = estimateTripConsumption(
      speed, weather.temperature, sessions, batteryCapacityKwh, climateOn,
      weather.windSpeed, relativeWindAngle, styleFactor, weather.weatherCode, weather.precipitation,
      { gainM: elevationGain, lossM: elevationLoss, distanceKm: segmentDistance }, segDuration, effectiveClimatePower
    );
    const segEnergy = segmentDistance / 100 * f.estimatedConsumption;
    // Keep the breakdown additive while preserving the exact segmented total produced by the
    // established estimator. The "base" line is the no-weather/no-climate speed baseline.
    const speedBase = segmentDistance / 100 * interpolateVigoSpeedConsumption(speed);
    const tempDelta = speedBase * (f.temperatureImpactPct / 100);
    const windDelta = speedBase * (f.windImpactPct ?? 0) / 100;
    const precipDelta = speedBase * (f.precipitationImpactPct ?? 0) / 100;
    const elevationNet = (1600 * 9.80665 * elevationGain / 3.6e6 / 0.90) - (1600 * 9.80665 * elevationLoss / 3.6e6 * 0.65);
    const climateEnergy = effectiveClimatePower * segDuration;
    const driverDelta = speedBase * (styleFactor - 1);
    const explained = speedBase + tempDelta + windDelta + precipDelta + driverDelta + elevationNet + climateEnergy;
    const residual = segEnergy - explained;

    distanceKm += segmentDistance;
    durationHours += segDuration;
    energyKwh += segEnergy;
    baseEnergyKwh += speedBase;
    temperatureDeltaKwh += tempDelta;
    windDeltaKwh += windDelta;
    precipitationDeltaKwh += precipDelta;
    driverDeltaKwh += driverDelta + residual;
    elevationDeltaKwh += elevationNet;
    regenEnergyKwh += (1600 * 9.80665 * elevationLoss / 3.6e6 * 0.65);
    climateEnergyKwh += climateEnergy;
    tempWeighted += weather.temperature * segmentDistance;
    windWeighted += weather.windSpeed * segmentDistance;
    precipWeighted += weather.precipitation * segmentDistance;
    climatePowerWeighted += effectiveClimatePower * segDuration;
    windWeightedBase += speedBase;
    precipWeightedBase += speedBase;
  }

  return {
    distanceKm: Number(distanceKm.toFixed(2)), durationHours: Number(durationHours.toFixed(3)), energyKwh: Number(energyKwh.toFixed(2)),
    baseEnergyKwh: Number(baseEnergyKwh.toFixed(2)), temperatureDeltaKwh: Number(temperatureDeltaKwh.toFixed(2)),
    windDeltaKwh: Number(windDeltaKwh.toFixed(2)), precipitationDeltaKwh: Number(precipitationDeltaKwh.toFixed(2)),
    driverDeltaKwh: Number(driverDeltaKwh.toFixed(2)), elevationDeltaKwh: Number(elevationDeltaKwh.toFixed(2)),
    climateEnergyKwh: Number(climateEnergyKwh.toFixed(2)), regenEnergyKwh: Number(regenEnergyKwh.toFixed(2)),
    avgTemperature: Number((tempWeighted / Math.max(0.001, distanceKm)).toFixed(1)),
    avgWindSpeed: Number((windWeighted / Math.max(0.001, distanceKm)).toFixed(1)),
    avgPrecipitation: Number((precipWeighted / Math.max(0.001, distanceKm)).toFixed(2)),
    segments: Math.max(0, points.length - 1),
    windImpactPct: Math.round((windWeightedBase ? windDeltaKwh / windWeightedBase : 0) * 100),
    precipitationImpactPct: Math.round((precipWeightedBase ? precipitationDeltaKwh / precipWeightedBase : 0) * 100),
    climatePowerKw: Number((climatePowerWeighted / Math.max(0.001, durationHours)).toFixed(2)),
  };
}
export function calculateTripData(
  startSoc: number,
  endSoc: number,
  distanceKm: number,
  chargingType: TripSession['chargingType'],
  customTariff: number,
  settings: UserSettings,
  roadType: TripSession['roadType'] = 'city',
  climateOn = false,
  note = ''
): Omit<TripSession, 'id' | 'createdAt'> {
  const socUsed = Math.max(0.1, startSoc - endSoc);
  const batteryCap = settings.batteryCapacityKwh || 51.87;
  const energyUsedKwh = (socUsed / 100) * batteryCap;
  
  const safeDistance = Math.max(0.1, distanceKm);
  const consumptionPer100Km = (energyUsedKwh / safeDistance) * 100;
  const kmPerKwh = safeDistance / energyUsedKwh;

  const tariff = getTariffForType(chargingType, settings, customTariff);

  const totalCost = energyUsedKwh * tariff;
  const gasCostEquivalent = (safeDistance / 100) * settings.gasEquivalentL100km * settings.gasPricePerLiter;
  const moneySaved = Math.max(0, gasCostEquivalent - totalCost);

  return {
    date: new Date().toISOString().split('T')[0],
    startSoc,
    endSoc,
    distanceKm,
    energyUsedKwh: Number(energyUsedKwh.toFixed(2)),
    consumptionPer100Km: Number(consumptionPer100Km.toFixed(2)),
    kmPerKwh: Number(kmPerKwh.toFixed(2)),
    chargingType,
    customTariff: chargingType === 'custom' ? customTariff : undefined,
    totalCost: Number(totalCost.toFixed(2)),
    gasCostEquivalent: Number(gasCostEquivalent.toFixed(2)),
    moneySaved: Number(moneySaved.toFixed(2)),
    roadType,
    climateOn,
    note,
  };
}

export function exportBackupJSON(settings: UserSettings, sessions: TripSession[]): void {
  const data = {
    appName: 'Dongfeng Vigo EV Calculator',
    version: '1.01',
    exportDate: new Date().toISOString(),
    settings,
    sessions,
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `dongfeng_vigo_ev_history_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportSessionsCSV(sessions: TripSession[], currency: string): void {
  const headers = [
    'Дата',
    'Старт %',
    'Финиш %',
    'Дистанция (км)',
    'Потрачено (кВт⋅ч)',
    'Расход (кВт⋅ч/100км)',
    'Тип зарядки',
    `Стоимость (${currency})`,
    `Экономия vs бензин (${currency})`,
    'Тип дороги',
    'Климат',
    'Заметка'
  ];

  const rows = sessions.map(s => [
    s.date,
    s.startSoc,
    s.endSoc,
    s.distanceKm,
    s.energyUsedKwh,
    s.consumptionPer100Km,
    s.chargingType,
    s.totalCost,
    s.moneySaved,
    s.roadType,
    s.climateOn ? 'Вкл' : 'Выкл',
    `"${(s.note || '').replace(/"/g, '""')}"`
  ]);

  const csvContent = '\uFEFF' + [headers.join(';'), ...rows.map(r => r.join(';'))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vigo_trips_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
