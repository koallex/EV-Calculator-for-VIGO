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
  [30, 11.2], [50, 12.0], [60, 12.8], [70, 13.5],
];

// Above ~80 km/h aerodynamic drag becomes a major part of road load. For a fixed road
// distance, the aerodynamic contribution to energy/100 km scales approximately with v².
// We therefore use a continuous quadratic high-speed branch instead of a linear lookup.
// The branch is anchored to the existing 80–90 km/h range and tuned against the owner's
// observed highway run (77.7 km, ~105 km/h average, +25…29°C, HVAC OFF, calm wind,
// dashboard 21.4 kWh/100 km). This is a calibration anchor, not a claimed factory Cd value.
const VIGO_HIGH_SPEED_AERO_A = 6.857;
const VIGO_HIGH_SPEED_AERO_B = 0.0011905;

// 95-100 km/h cruise band was slightly under-costed versus real-world dashboard readings,
// so the 100 km/h calibration anchor was nudged up from 17.3 -> 17.9 kWh/100km (~+0.6-0.75
// kWh/100km through the 95-100 km/h range specifically). 70/80/105 anchors are unchanged.

// Owner reported the whole curve (30-150 km/h) was running slightly high against their real
// routes, so the entire curve is scaled down by a flat 4% here rather than re-deriving every
// anchor point individually — this preserves the curve's shape (including the 95-100 km/h
// bump above) while bringing every speed down uniformly. Tune this single constant if further
// real-trip data suggests a different overall calibration.
const VIGO_SPEED_CURVE_CALIBRATION_SCALE = 0.96;

function interpolateVigoSpeedConsumptionRaw(speedKmH: number): number {
  const speed = Math.max(15, Math.min(150, speedKmH));
  const curve = VIGO_SPEED_CONSUMPTION_CURVE;
  if (speed <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [s1, c1] = curve[i - 1];
    const [s2, c2] = curve[i];
    if (speed <= s2) {
      const t = (speed - s1) / Math.max(0.001, s2 - s1);
      return c1 + (c2 - c1) * t;
    }
  }
  // Smooth the transition above 70 km/h. The previous implementation switched
  // directly from the 30–70 km/h linear curve to the steeper quadratic aero branch
  // at 80 km/h, which made the slope noticeably steeper around 70–80 km/h.
  // Use one continuous quadratic through 70, 80 and the existing 105 km/h calibration
  // anchor. This keeps the curve monotonic while avoiding an artificial kink at 70–80.
  const s1 = 70, c1 = 13.5;
  const s2 = 80, c2 = VIGO_HIGH_SPEED_AERO_A + VIGO_HIGH_SPEED_AERO_B * s2 * s2;
  const s3 = 105, c3 = 19.3;
  // Smooth cubic through the calibration points:
  // 70=13.5, 80=14.2, 100=17.9, 105=19.3 kWh/100km.
  const qA = -0.000000952380952381;
  const qB = 0.00407142857142857;
  const qC = -0.524619047619048;
  const qD = 30.6;
  if (speed <= 105) {
    return qA * speed * speed * speed + qB * speed * speed + qC * speed + qD;
  }
  // Above 105 km/h use a gently steeper high-speed branch. The new branch
  // is continuous in value and slope at 105 km/h and is tuned through
  // 120 and 150 km/h. This raises the cost of sustained high-speed driving
  // without changing the already-calibrated <=105 km/h curve.
  const hA = 0.000000811287477950617;
  const hB = 0.000510582010583333;
  const hC = 0.164825396825233;
  const hD = -4.57499999999333;
  return hA * speed * speed * speed + hB * speed * speed + hC * speed + hD;
}

export function interpolateVigoSpeedConsumption(speedKmH: number): number {
  const speed = Math.max(15, Math.min(150, speedKmH));
  // High-speed calibration is intentionally separate from the driver-style factor.
  // The style coefficient now represents acceleration/braking behaviour only, while
  // sustained 90+ km/h energy is carried by the physical speed curve itself.
  let highSpeedFactor = 1.0;
  if (speed > 90) {
    // Keep 90 km/h cruising slightly lighter than the previous calibration while
    // retaining the full high-speed correction by 120 km/h.
    const t = Math.min(1, (speed - 90) / 30);
    highSpeedFactor = 1 + 0.09 * t;
  }
  if (speed > 120) {
    const t = Math.min(1, (speed - 120) / 30);
    highSpeedFactor = 1.09 + 0.01 * t;
  }
  return interpolateVigoSpeedConsumptionRaw(speed) * VIGO_SPEED_CURVE_CALIBRATION_SCALE * highSpeedFactor;
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

/**
 * Display names for charging operators by region.
 * Internal ChargingType IDs stay the same (for history compatibility);
 * only the visible labels switch when the user changes region.
 */
export const OPERATOR_LABELS: Record<
  'belarus' | 'russia',
  Record<string, string>
> = {
  belarus: {
    malanka_dc: 'Маланка DC',
    malanka_ac: 'Маланка AC',
    evika: 'Evika',
    batteryfly: 'BatteryFly',
    zaryadka: 'Зарядка',
    zaryadka_day: 'Зарядка День',
    zaryadka_night: 'Зарядка Ночь',
    zaryadka_dc: 'Зарядка DC',
    zaryadka_ac: 'Зарядка AC',
    home: 'Домашний',
    home_night: 'Домашний ночной',
    home_day: 'Домашний',
    fast_day: 'Быстрая DC (день)',
    fast_night: 'Быстрая DC (ночь)',
    slow_public: 'Медленная AC',
    free: 'Бесплатно',
    custom: 'Свой тариф',
  },
  russia: {
    malanka_dc: 'Punkt E / Россети DC',
    malanka_ac: 'AC городская',
    evika: 'AC / городская сеть',
    batteryfly: 'Electro.cars',
    zaryadka: 'DC сеть',
    zaryadka_day: 'DC день',
    zaryadka_night: 'DC ночь',
    zaryadka_dc: 'DC быстрая',
    zaryadka_ac: 'AC городская',
    home: 'Домашний',
    home_night: 'Домашний ночной',
    home_day: 'Домашний',
    fast_day: 'DC быстрая (день)',
    fast_night: 'DC быстрая (ночь)',
    slow_public: 'AC городская',
    free: 'Бесплатно',
    custom: 'Свой тариф',
  },
};

export function getOperatorLabel(
  type: string,
  region: UserSettings['regionPreset'] = 'belarus'
): string {
  const key = region === 'russia' ? 'russia' : 'belarus';
  return OPERATOR_LABELS[key][type] ?? type;
}

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
    //
    // The 10-19°C branch is anchored to power=0.40 kW exactly at temp=19 (matching the
    // comfort-zone baseline above) and to power=0.82 kW at temp=10 (matching the next
    // branch's own value there) so the curve has no jump at either seam.
    if (temp >= 10) {
      powerKw = 0.40 + (19 - temp) * 0.046667;
    } else if (temp >= 0) {
      powerKw = 0.82 + (10 - temp) * 0.048;
    } else if (temp >= -10) {
      powerKw = 1.30 + Math.abs(temp) * 0.060;
    } else if (temp >= -20) {
      powerKw = 1.90 + (Math.abs(temp) - 10) * 0.080;
    } else {
      powerKw = 2.70 + (Math.abs(temp) - 20) * 0.110;
    }
    powerKw = Math.min(3.8, Math.max(0.40, powerKw));
    label = `Тепловой насос + ТЭН (${powerKw.toFixed(1)} кВт)`;
    description = `Оценочная электрическая нагрузка теплового насоса с поддержкой ТЭН при ${temp}°C: ~${powerKw.toFixed(1)} кВт`;
  } else {
    // Anchored to power=0.40 kW exactly at temp=23°C (matching the comfort-zone baseline)
    // so there is no jump crossing out of the comfort zone on the hot side either.
    powerKw = 0.40 + (temp - 23) * 0.10;
    powerKw = Math.min(2.6, Math.max(0.40, powerKw));
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

// Smooth 0..1 ease used for every temperature-driven precipitation transition below —
// keeps blends continuous instead of a hard on/off switch at some threshold degree.
function smoothstep01(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

// Rain reported by the API doesn't stop being dangerous the instant air temperature
// crosses 0°C — the road surface itself typically stays colder than the air above it,
// so real black-ice risk starts a couple degrees above freezing and is essentially
// total a few degrees below it. Returns 0 (plain wet road) .. 1 (fully icy).
const ICE_BLEND_UPPER_TEMP_C = 2; // above this, treat rain as ordinary wet road
const ICE_BLEND_LOWER_TEMP_C = -3; // at/below this, treat rain as fully icy/naledь
function calcIceBlendFactor(temperatureC: number): number {
  if (temperatureC >= ICE_BLEND_UPPER_TEMP_C) return 0;
  if (temperatureC <= ICE_BLEND_LOWER_TEMP_C) return 1;
  const t = (ICE_BLEND_UPPER_TEMP_C - temperatureC) / (ICE_BLEND_UPPER_TEMP_C - ICE_BLEND_LOWER_TEMP_C);
  return smoothstep01(t);
}

// Snow resistance isn't constant across temperature either: wet, near-freezing snow packs
// into slush and gives the worst rolling resistance / traction loss, while deep-cold snow
// is dry powder that a tire displaces far more easily. Returns a 0.78..1.0 multiplier on
// the intensity-based snow impact — 1.0 at the wet-snow worst case, easing down toward dry
// powder as it gets colder, saturating rather than dropping without bound.
const SNOW_WET_PEAK_TEMP_C = -1; // at/above this (but still snowing), worst-case wet/packed snow
const SNOW_DRY_FLOOR_TEMP_C = -18; // at/below this, dry powder — resistance eases off and saturates
const SNOW_COLD_MAX_EASE = 0.22; // up to 22% less resistance than wet snow, in deep cold
function calcSnowTempFactor(temperatureC: number): number {
  if (temperatureC >= SNOW_WET_PEAK_TEMP_C) return 1;
  if (temperatureC <= SNOW_DRY_FLOOR_TEMP_C) return 1 - SNOW_COLD_MAX_EASE;
  const t = (SNOW_WET_PEAK_TEMP_C - temperatureC) / (SNOW_WET_PEAK_TEMP_C - SNOW_DRY_FLOOR_TEMP_C);
  return 1 - smoothstep01(t) * SNOW_COLD_MAX_EASE;
}

/**
 * Calculates rolling resistance and hydrodynamic drag coefficient from precipitation and road surface condition.
 * EV Physics:
 * - Dry road: baseline (0% added resistance)
 * - Damp / Mist / Fog: +2% to +4%
 * - Moderate Rain (water displacement by tires): +8%
 * - Heavy Rain / Puddles (hydrodynamic drag & spray): +12%
 * - Snow / Slush / Packed snow (compression and friction loss): +14% to +22%, eased down in
 *   deep cold where snow is dry powder rather than wet/packed (see calcSnowTempFactor)
 * - Rain at/near freezing air temperature is blended smoothly into an icy-road penalty
 *   (see calcIceBlendFactor), since real black ice risk doesn't wait for a hard 0°C cutoff
 */
export function calculatePrecipitationImpact(
  weatherCode?: number,
  precipitationMm?: number,
  temperatureC?: number
): PrecipitationImpact {
  const code = weatherCode ?? 0;
  const precip = Math.max(0, precipitationMm ?? 0);

  // Snow: intensity matters. A light snowfall is not equivalent to slush/deep snow.
  if ([71, 73, 75, 77, 85, 86].includes(code) || (code >= 70 && code < 80)) {
    let impactPct = (code === 75 || code === 86 || precip >= 3.0) ? 22
      : precip >= 1.0 ? 18
      : precip >= 0.3 ? 14
      : 8;
    let tempNote = '';
    if (temperatureC !== undefined) {
      const snowFactor = calcSnowTempFactor(temperatureC);
      if (snowFactor < 1) {
        const before = impactPct;
        impactPct = Math.round(impactPct * snowFactor);
        tempNote = ` Сухой морозный снег при ${temperatureC.toFixed(0)}°C снижает сопротивление: ${before}%→${impactPct}%.`;
      }
    }
    const heavy = impactPct >= 20;
    return {
      impactPct, factor: 1 + impactPct / 100,
      type: heavy ? 'heavy_snow' : 'snow',
      label: `Снег (${heavy ? 'сильный' : 'умеренный'}, +${impactPct}%)`,
      roadState: heavy ? 'Снежная каша / накат' : 'Заснеженный асфальт',
      description: `Поправка зависит от интенсивности снега: ${impactPct}%.${tempNote}`,
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
    let wetImpactPct: number;
    if (precip <= 0.1) wetImpactPct = 2;
    else if (precip <= 0.3) wetImpactPct = 3;
    else if (precip <= 0.7) wetImpactPct = 5;
    else if (precip <= 1.5) wetImpactPct = 7;
    else if (precip <= 3.0) wetImpactPct = 9;
    else if (precip <= 6.0) wetImpactPct = 11;
    else wetImpactPct = 12;

    // WMO heavy-rain codes retain a conservative minimum even when the API's
    // instantaneous precipitation value happens to be small.
    if ([65, 81, 82, 95, 96, 99].includes(code)) wetImpactPct = Math.max(wetImpactPct, 10);

    // Below-freezing rain is physically freezing rain / black ice, not "wet asphalt" — traction
    // and rolling-resistance losses are far higher. Blend smoothly into the icy-road formula as
    // air temperature approaches and drops below 0°C, rather than only trusting explicit
    // freezing-rain weather codes (56/57/66/67) that the API doesn't always report correctly,
    // especially on long-range/seasonal forecasts used for trip planning.
    const iceImpactPct = precip <= 0.3 ? 15 : precip <= 1.0 ? 18 : precip <= 3.0 ? 21 : 24;
    const iceBlend = temperatureC !== undefined ? calcIceBlendFactor(temperatureC) : 0;
    const impactPct = Math.round(wetImpactPct + (iceImpactPct - wetImpactPct) * iceBlend);

    const isIcy = iceBlend >= 0.5;
    const heavy = !isIcy && impactPct >= 10;
    return {
      impactPct, factor: 1 + impactPct / 100,
      type: isIcy ? 'heavy_snow' : heavy ? 'heavy_rain' : impactPct <= 3 ? 'damp' : 'rain',
      label: isIcy
        ? `Гололёд / ледяной дождь (+${impactPct}%)`
        : `${heavy ? 'Ливень' : impactPct <= 3 ? 'Морось' : 'Дождь'} (+${impactPct}%)`,
      roadState: isIcy ? 'Гололедица / накат' : heavy ? 'Глубокие лужи / вода' : 'Мокрый асфальт',
      description: isIcy
        ? `Дождь при ~${temperatureC?.toFixed(0)}°C — риск наледи на дороге, поправка +${impactPct}%`
        : `Интенсивность осадков ~${precip.toFixed(1)} мм/ч → поправка +${impactPct}%`,
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

  // IMPORTANT: driving style must be independent of weather, temperature, wind,
  // precipitation, terrain and HVAC. Prefer the structured factor recorded by HUD.
  // For older trips without that field, derive a conservative style factor only
  // from average/max speed. Do not infer style from energy consumption.
  const styleSessions = sessions.filter((s) => {
    const hasStoredFactor = Number.isFinite(s.drivingStyleFactor);
    const hasSpeedData = Number.isFinite(s.avgSpeedKmH) && Number.isFinite(s.maxSpeedKmH)
      && (s.avgSpeedKmH ?? 0) > 5 && (s.maxSpeedKmH ?? 0) >= (s.avgSpeedKmH ?? 0);
    return hasStoredFactor || hasSpeedData;
  });

  if (styleSessions.length === 0) {
    return {
      factor: 1.0,
      label: 'Сбалансированный',
      subLabel: 'Нет сохранённых данных о стиле вождения',
      diffPct: 0,
      avgConsumption: 0,
      benchmarkConsumption,
      validTripsCount: 0,
    };
  }

  const totalKm = sessions.reduce((acc, s) => acc + Math.max(0, s.distanceKm || 0), 0);
  const totalKwh = sessions.reduce((acc, s) => acc + Math.max(0, s.energyUsedKwh || 0), 0);
  const avgConsumption = totalKm > 0 ? (totalKwh / totalKm) * 100 : 0;

  // Distance-weight the style factors so a 3 km calibration trip does not have
  // the same influence as a 100 km trip.
  let weightedFactorSum = 0;
  let weightedKm = 0;
  for (const s of styleSessions) {
    const factor = Number.isFinite(s.drivingStyleFactor)
      ? Number(s.drivingStyleFactor)
      : deriveDrivingStyleFactor(s.avgSpeedKmH, s.maxSpeedKmH);
    const km = Math.max(1, Number(s.distanceKm) || 1);
    if (!Number.isFinite(factor)) continue;
    weightedFactorSum += factor * km;
    weightedKm += km;
  }

  const factor = Number(Math.max(0.97, Math.min(1.10, weightedKm > 0 ? weightedFactorSum / weightedKm : 1)).toFixed(2));
  const diffPct = Math.round((factor - 1) * 100);
  const label = getDrivingStyleLabel(factor);

  let subLabel = 'Штатный темп и плавность движения';
  if (factor < 0.95) subLabel = `Плавный стиль, коэффициент ${factor.toFixed(2)}`;
  else if (factor <= 1.05) subLabel = `Сбалансированный стиль, коэффициент ${factor.toFixed(2)}`;
  else if (factor <= 1.15) subLabel = `Повышенная динамика, коэффициент ${factor.toFixed(2)}`;
  else subLabel = `Высокая динамика, коэффициент ${factor.toFixed(2)}`;

  return {
    factor,
    label,
    subLabel,
    diffPct,
    avgConsumption: Number(avgConsumption.toFixed(1)),
    benchmarkConsumption,
    validTripsCount: styleSessions.length,
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

// "Flat road" portion of the consumption model: speed curve + cold-battery penalty +
// precipitation/road-surface resistance + relative-wind aerodynamic impact. Deliberately
// excludes elevation (order-independent, additive over a whole trip from total gain/loss)
// and HVAC/climate (a time-based load, not a distance-based one). Extracted as its own
// function so it can be evaluated per-GPS-segment at that segment's own instantaneous
// speed (see HudTab's live SoC tracking) as well as from estimateTripConsumption's
// whole-trip average — keeping both call sites on exactly the same physical model instead
// of letting a second, hand-copied formula drift out of sync over time.
export interface FlatRoadConsumptionRate {
  effectiveSpeed: number;
  baseSpeedConsumption: number; // kWh/100km from the speed curve alone
  tempMultiplier: number;
  precipMultiplier: number;
  windMultiplier: number;
  windImpactPct: number;
  windStatusText?: string;
}

export function computeFlatRoadConsumptionRate(
  speedKmH: number,
  temperatureC: number | undefined,
  windSpeedKmH?: number,
  relativeWindAngleDeg?: number,
  weatherCode?: number,
  precipitationMm?: number
): FlatRoadConsumptionRate {
  // 1. Calculate base physical consumption for Dongfeng Vigo (51.87 kWh, ~1526 kg curb weight)
  // Physics curve: rolling resistance + aerodynamic drag (Cd*A*v^3) + base electrical load
  const effectiveSpeed = Math.max(15, Math.min(150, speedKmH > 0 ? speedKmH : 55));

  // Unified speed curve. Keeping this shared with segmented-route calculations guarantees
  // the same high-speed model in Calculator and HUD.
  const baseSpeedConsumption = interpolateVigoSpeedConsumption(effectiveSpeed);

  // 2A. Physical battery cell efficiency in cold (independent of cabin HVAC).
  // Saturating curve instead of unbounded linear growth: internal resistance really does rise as
  // cells get colder, but it approaches a physical ceiling rather than climbing forever — a real
  // pack doesn't lose 40%+ efficiency at -40°C just because -20°C already cost 20%.
  const temp = temperatureC ?? 20; // Default optimal 20°C if weather not loaded
  const BATTERY_RESISTANCE_MAX_PENALTY = 0.22; // temporary conservative calibration: reduced cold penalty pending real winter VIGO data
  const BATTERY_RESISTANCE_SATURATION_TAU = 48; // controls how quickly the curve approaches the ceiling
  const degreesBelowComfort = Math.max(0, 18 - temp);
  const batteryResistanceMultiplier =
    1 + BATTERY_RESISTANCE_MAX_PENALTY * (1 - Math.exp(-degreesBelowComfort / BATTERY_RESISTANCE_SATURATION_TAU));

  // 2B. LFP-specific reduced usable capacity in extreme cold. This is a physically distinct
  // effect from the internal-resistance efficiency penalty above: it's not that driving costs
  // more energy per km, it's that the pack's own low-voltage cutoff is reached earlier under
  // load when cold, so less of the nominal capacity is actually reachable on a cold-soaked
  // battery (LFP chemistry is known to derate more here than NMC/NCA). Modeled as an extra
  // multiplier on effective consumption (equivalent to less usable capacity for the same
  // distance), separate from and multiplicative with the resistance penalty above, so the two
  // physically-distinct causes of owner-reported "range feels too optimistic in real winter
  // cold" don't get conflated into one hand-tuned number. Starts below -5°C (LFP capacity is
  // essentially unaffected in ordinary cold) and saturates by extreme cold rather than growing
  // without bound. Owner calibration: "medium" of three proposed severities (12/18/25% ceiling).
  const LFP_CAPACITY_DERATING_MAX_PENALTY = 0.10; // temporary conservative calibration: reduced LFP cold derating pending real winter VIGO data
  const LFP_CAPACITY_DERATING_SATURATION_TAU = 22;
  const degreesBelowLfpThreshold = Math.max(0, -5 - temp);
  const lfpCapacityDeratingMultiplier =
    1 + LFP_CAPACITY_DERATING_MAX_PENALTY * (1 - Math.exp(-degreesBelowLfpThreshold / LFP_CAPACITY_DERATING_SATURATION_TAU));

  const tempMultiplier = batteryResistanceMultiplier * lfpCapacityDeratingMultiplier;

  // 3. Precipitation & Road Surface Resistance Impact (water displacement, slush, snow).
  // `temp` (already resolved above, defaults to 20°C) lets this react to icing/dry-powder
  // conditions instead of only intensity — see calcIceBlendFactor/calcSnowTempFactor.
  const precipInfo = calculatePrecipitationImpact(weatherCode, precipitationMm, temp);
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
  let windStatusText: string | undefined;

  // Wind is evaluated continuously from 0 km/h — no on/off gate. A hard "ignore below X km/h"
  // threshold used to create a jump right at the cutoff (0% just below it, then a sudden step
  // above it); the low-wind ramp below already sends the effect to ~0% smoothly as wind→0, so
  // no separate gate is needed. `windSpeedKmH > 0` just avoids doing the trig for calm conditions.
  if (windSpeedKmH && windSpeedKmH > 0 && relativeWindAngleDeg !== undefined && !isNaN(relativeWindAngleDeg)) {
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
    //
    // Calibration (owner feedback: wind impact felt overstated at city/moderate speeds):
    // the previous curve had a hard 28% floor even at ~20 km/h, where real-world aero drag
    // is a minor contributor next to rolling resistance and drivetrain/aux load. The share
    // now starts near ~6% at low speed and ramps up to the 55% ceiling only around
    // 140-150 km/h, where aerodynamics genuinely dominates the road-load. This roughly
    // halves the wind sensitivity at typical city/highway speeds (60-100 km/h) while
    // preserving a strong effect for genuine highway-speed storms.
    const aeroShare = Math.min(0.55, Math.max(0.06, 0.06 + (effectiveSpeed - 15) * 0.0038));
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
    const fullStrengthMultiplier = Math.max(0.78, Math.min(1.60, windAdjustedConsumption / baseSpeedConsumption));

    // Low-wind ramp (owner feedback: effect still felt too strong at LOW wind speeds
    // specifically, not just moderate ones). Ambient wind reported by a weather station
    // is measured well above the road and is rarely a clean, steady flow right around the
    // car at low absolute speeds — gustiness and the car's own boundary-layer turbulence
    // dominate over the "textbook" relative-airspeed effect until the wind is genuinely
    // blowing with some strength. A smoothstep ramp (zero slope at both ends, so it joins
    // the "no effect" baseline and the full-strength model with no kink) fades the effect
    // in from 0% at 0 km/h to 100% of the full-strength model by ~20 km/h true wind speed,
    // rather than applying the full effect uniformly from the first breath of air.
    const WIND_RAMP_FULL_STRENGTH_KMH = 20;
    const rampT = Math.max(0, Math.min(1, windSpeedKmH / WIND_RAMP_FULL_STRENGTH_KMH));
    const rampFactor = rampT * rampT * (3 - 2 * rampT); // smoothstep
    windMultiplier = 1 + (fullStrengthMultiplier - 1) * rampFactor;
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

  return {
    effectiveSpeed,
    baseSpeedConsumption,
    tempMultiplier,
    precipMultiplier,
    windMultiplier,
    windImpactPct,
    windStatusText,
  };
}

export function deriveDrivingStyleFactor(avgSpeedKmH?: number, maxSpeedKmH?: number): number {
  if (!Number.isFinite(avgSpeedKmH) || !Number.isFinite(maxSpeedKmH) || (avgSpeedKmH ?? 0) <= 0) return 1.0;
  // Legacy fallback only: without the HUD's second-by-second speed history we cannot
  // measure acceleration/braking directly. Do NOT treat high average speed as a style penalty;
  // sustained high speed is already represented by the speed-consumption curve.
  const avg = avgSpeedKmH as number;
  const max = Math.max(avg, maxSpeedKmH as number);
  const burstRatio = max / Math.max(30, avg);
  let factor = 1.0;
  if (burstRatio > 1.9) factor += 0.06;
  else if (burstRatio > 1.6) factor += 0.03;
  else if (avg <= 40 && burstRatio < 1.35) factor -= 0.02;
  return Number(Math.max(0.97, Math.min(1.10, factor)).toFixed(2));
}

export function getDrivingStyleLabel(factor?: number): string {
  const f = Number.isFinite(factor) ? (factor as number) : 1;
  if (f < 0.95) return 'Эко-плавный';
  if (f <= 1.05) return 'Сбалансированный';
  if (f <= 1.15) return 'Динамичный';
  return 'Агрессивный';
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
  climatePowerOverrideKw?: number,
  passengers = 1
): ConsumptionForecast {
  // 1-4. Speed curve + cold-battery penalty + precipitation + relative-wind impact, shared
  // with the per-segment live calculation in HudTab (see computeFlatRoadConsumptionRate above).
  const flatRoad = computeFlatRoadConsumptionRate(
    avgSpeedKmH,
    temperatureC,
    windSpeedKmH,
    relativeWindAngleDeg,
    weatherCode,
    precipitationMm
  );
  const { effectiveSpeed, baseSpeedConsumption, tempMultiplier, precipMultiplier, windMultiplier, windImpactPct, windStatusText } = flatRoad;
  const passengerCount = Math.max(1, Math.min(5, Math.round(passengers)));
  const extraMassKg = (passengerCount - 1) * 75;
  // Passenger mass affects rolling/acceleration components, not aero drag. Approximate the
  // mass-sensitive share of the flat-road model at 12% of the road-load energy.
  const massMultiplier = 1 + (extraMassKg / 1600) * 0.12;
  const massAdjustedBaseSpeedConsumption = baseSpeedConsumption * massMultiplier;

  // Re-derive the precipitation descriptive fields (label/description/roadState) for the
  // return payload below; precipMultiplier itself already came from computeFlatRoadConsumptionRate.
  const precipInfo = calculatePrecipitationImpact(weatherCode, precipitationMm, temperatureC ?? 20);

  // 2B. Cabin HVAC load. It is power in kW; when trip duration is known, actual energy is power × hours.
  const temp = temperatureC ?? 20; // Default optimal 20°C if weather not loaded
  const climateInfo = calculateClimateImpact(temp, climateOn);

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
    const VEHICLE_MASS_KG = 1600 + (Math.max(1, Math.min(5, Math.round(passengers))) - 1) * 75;
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
      .map((s) => Number.isFinite(s.drivingStyleFactor) ? s.drivingStyleFactor! : deriveDrivingStyleFactor(s.avgSpeedKmH, s.maxSpeedKmH))
      .filter((x) => Number.isFinite(x) && x >= 0.75 && x <= 1.35);
    if (styleFactors.length >= 1) {
      driverStyleFactor = Math.max(0.97, Math.min(1.10, styleFactors.reduce((acc, x) => acc + x, 0) / styleFactors.length));
    }
  } else if (sessions.length >= 2) {
    dataSource = 'all_history';
    const validSessions = sessions.filter((s) => s.consumptionPer100Km > 8 && s.consumptionPer100Km < 35);
    if (validSessions.length > 0) {
      const styleFactors = validSessions
        .map((s) => Number.isFinite(s.drivingStyleFactor) ? s.drivingStyleFactor! : deriveDrivingStyleFactor(s.avgSpeedKmH, s.maxSpeedKmH))
        .filter((x) => Number.isFinite(x));
      if (styleFactors.length) driverStyleFactor = styleFactors.reduce((a, b) => a + b, 0) / styleFactors.length;
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
    massAdjustedBaseSpeedConsumption * tempMultiplier * windMultiplier * precipMultiplier * driverStyleFactor +
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
  roadSpeedKmH?: number;
  roadSegmentLengthKm?: number; // length of the OSRM step this speed came from — short = junction/village, long = open road
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
  speedProfile: { distanceKm: number; speedKmH: number }[]; // the actual per-point speed used for the calc, for the (optional, collapsed) speed-vs-distance chart
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
  customDriverStyleFactor?: number,
  passengers = 1,
  maxSpeedKmH?: number
): SegmentedRouteBreakdown {
  if (points.length < 2) {
    return {
      distanceKm: 0, durationHours: 0, energyKwh: 0, baseEnergyKwh: 0, temperatureDeltaKwh: 0,
      windDeltaKwh: 0, precipitationDeltaKwh: 0, driverDeltaKwh: 0, elevationDeltaKwh: 0,
      climateEnergyKwh: 0, regenEnergyKwh: 0, avgTemperature: fallbackWeather.temperature,
      avgWindSpeed: fallbackWeather.windSpeed, avgPrecipitation: fallbackWeather.precipitation,
      segments: 0, windImpactPct: 0, precipitationImpactPct: 0, climatePowerKw: 0,
      speedProfile: [],
    };
  }

  const speed = Math.max(5, avgSpeedKmH);
  // Preserve the user's planned average while using OSRM's road profile. When a planned
  // maximum speed is supplied, high-speed road sections are stretched/compressed toward that
  // maximum before the profile is normalized back to the requested average. This lets the user
  // tell the model, for example, "79 km/h average, up to 120 km/h on permitted sections" —
  // something OSRM alone cannot know from the route geometry.
  const requestedMaxSpeed = Number.isFinite(maxSpeedKmH) ? Math.max(speed, Math.min(150, maxSpeedKmH!)) : undefined;
  const rawRoadSpeeds = points.map((p) => Number.isFinite(p.roadSpeedKmH) && (p.roadSpeedKmH ?? 0) > 0
    ? Math.max(10, Math.min(140, p.roadSpeedKmH!)) : speed);
  // How much we trust a point's OSRM-assigned speed as "genuine open road" rather than noise from
  // a short step (junction, roundabout, village pass-through). OSRM reports a speed for every
  // named step regardless of length — a 150 m slip road can get the same "speedKmH" treatment as
  // a 10 km straight, even though only the latter is a road a driver could realistically stretch
  // toward their stated maximum on. 2 km is picked as "long enough that a driver could plausibly
  // be at a settled cruising speed for a meaningful stretch of it".
  const LENGTH_CONFIDENCE_KM = 0.75;
  const lengthWeights = points.map((p) =>
    Math.max(0, Math.min(1, (p.roadSegmentLengthKm ?? LENGTH_CONFIDENCE_KM) / LENGTH_CONFIDENCE_KM))
  );
  let roadSpeeds = rawRoadSpeeds.slice();
  if (requestedMaxSpeed !== undefined) {
    const FAST_ROAD_THRESHOLD = 80;
    const roadMax = Math.max(...rawRoadSpeeds);
    if (roadMax > FAST_ROAD_THRESHOLD) {
      roadSpeeds = rawRoadSpeeds.map((roadSpeed, i) => {
        if (roadSpeed <= FAST_ROAD_THRESHOLD) return roadSpeed;
        const t = (roadSpeed - FAST_ROAD_THRESHOLD) / Math.max(0.001, roadMax - FAST_ROAD_THRESHOLD);
        const stretchedSpeed = FAST_ROAD_THRESHOLD + t * (requestedMaxSpeed - FAST_ROAD_THRESHOLD);
        // Blend between "leave it alone" (short/low-confidence step) and "fully stretch toward
        // the driver's stated max" (long, trustworthy step) — a short step that happened to get
        // tagged with a high OSRM speed no longer gets pulled all the way up to 120 just because
        // it's technically above the 80 km/h threshold.
        return roadSpeed + (stretchedSpeed - roadSpeed) * lengthWeights[i];
      });
    }

    // Which points represent genuine, high-confidence open-road driving where the stated
    // maximum should actually show up — long (length-trusted) sections OSRM already tags as
    // fast. These stay pinned near their stretched speed. The harmonic-mean fit below only
    // scales the *other* (city/junction/short-step/low-confidence) points to bring the route
    // average down to the requested value.
    //
    // Scaling every point uniformly (the previous approach) pulled the fast sections back down
    // below the stated max whenever the requested average was well below the road's natural
    // average — e.g. "79 km/h avg, up to 120 km/h" ended up never actually reaching 120
    // anywhere on the route, because hitting a low average forced scale < 1, and that same
    // factor also capped the fastest, most confident sections (observed: profile topped out
    // ~105 km/h instead of 120; only entering an average close to the road's natural speed let
    // the peak through). Physically, a low trip average next to a high stated max means the
    // driver held near that max on the open sections and was slower everywhere else (traffic,
    // villages, turns) — not uniformly slower everywhere including the open stretch.
    const FAST_CONFIDENT_LENGTH_WEIGHT = 0.35;
    const isFastConfident = rawRoadSpeeds.map(
      (v, i) => v > FAST_ROAD_THRESHOLD && lengthWeights[i] > FAST_CONFIDENT_LENGTH_WEIGHT
    );

    // Find the scale factor whose harmonic mean equals the requested average while never
    // exceeding the driver's stated maximum. A short bisection is stable for mixed city/highway
    // profiles and avoids the old one-shot scale that could erase the intended max speed.
    //
    // Fast-confident points are ALWAYS pinned (never multiplied by scale), regardless of
    // whether the route also has flexible points to absorb the average correction. A previous
    // version gated pinning behind `hasFlexiblePoints` (i.e. "only pin if there's something
    // else to scale instead") — on a route that is entirely fast/confident (e.g. a pure highway
    // trip with no city or junction sections at all), that guard evaluated to false and fell
    // back to scaling every point uniformly, silently reintroducing the original peak-erasing
    // bug on exactly that class of route. If a route truly has no flexible points, there is
    // nothing that *can* legitimately absorb a lower requested average without erasing the
    // peak — so on such routes the achieved average may end up a bit above the requested value
    // instead, which is the physically honest outcome.
    const harmonicMeanForScale = (scale: number) => {
      let dSum = 0, timeSum = 0;
      for (let i = 1; i < points.length; i++) {
        const d = Math.max(0, points[i].distanceFromStartKm - points[i - 1].distanceFromStartKm);
        if (d <= 0.001) continue;
        const base = isFastConfident[i] ? roadSpeeds[i] : roadSpeeds[i] * scale;
        const v = Math.max(10, Math.min(requestedMaxSpeed!, base));
        dSum += d; timeSum += d / v;
      }
      return timeSum > 0 ? dSum / timeSum : speed;
    };
    let lo = 0.1, hi = 3;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      if (harmonicMeanForScale(mid) < speed) lo = mid; else hi = mid;
    }
    const scale = (lo + hi) / 2;
    roadSpeeds = roadSpeeds.map((v, i) => {
      const base = isFastConfident[i] ? v : v * scale;
      return Math.max(10, Math.min(requestedMaxSpeed!, base));
    });
  } else {
    let rawTime = 0, rawDistance = 0;
    for (let i = 1; i < points.length; i++) {
      const d = Math.max(0, points[i].distanceFromStartKm - points[i - 1].distanceFromStartKm);
      if (d > 0.001) { rawDistance += d; rawTime += d / roadSpeeds[i]; }
    }
    const rawHarmonic = rawTime > 0 ? rawDistance / rawTime : speed;
    const speedScale = rawHarmonic > 0 ? speed / rawHarmonic : 1;
    roadSpeeds = roadSpeeds.map((v) => Math.max(10, Math.min(140, v * speedScale)));
  }
  // Use the speed at the middle of each sampled distance interval instead of assigning the
  // whole interval the speed of its end point. This matters on long routes where a 1–2 km
  // sampled interval can cross a transition into/out of a 100+ km/h road section: the old
  // endpoint rule could charge the interval at the slower speed after leaving a fast section,
  // systematically under-counting the energy of high-speed portions. A midpoint interpolation
  // keeps the route profile smooth without adding UI data or extra API calls.
  const getSegmentSpeed = (index: number) => {
    const current = roadSpeeds[index];
    const previous = roadSpeeds[index - 1];
    if (Number.isFinite(current) && Number.isFinite(previous)) {
      const avg = (current + previous) / 2;
      const endpointMax = Math.max(current, previous);
      // Do not smooth away a deliberately supplied high-speed cruising section. If either
      // endpoint belongs to the stretched fast-road profile, keep the faster endpoint for the
      // segment. Otherwise midpoint smoothing is useful at ordinary speed transitions.
      const fastEndpoint = requestedMaxSpeed !== undefined
        && endpointMax >= Math.max(90, requestedMaxSpeed * 0.9);
      const chosen = fastEndpoint ? endpointMax : avg;
      return Math.max(10, Math.min(requestedMaxSpeed ?? 140, chosen));
    }
    return current ?? previous ?? speed;
  };
  const oneMonthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = sessions.filter((s) => s.createdAt && s.createdAt >= oneMonthAgo && s.consumptionPer100Km > 8 && s.consumptionPer100Km < 35);
  let styleFactor = 1;
  if (customDriverStyleFactor !== undefined && Number.isFinite(customDriverStyleFactor)) styleFactor = customDriverStyleFactor;
  else if (recent.length >= 2) {
    const factors = recent
      .map((s) => Number.isFinite(s.drivingStyleFactor) ? s.drivingStyleFactor! : deriveDrivingStyleFactor(s.avgSpeedKmH, s.maxSpeedKmH))
      .filter((x) => Number.isFinite(x) && x >= 0.75 && x <= 1.35);
    if (factors.length) styleFactor = factors.reduce((a, b) => a + b, 0) / factors.length;
  }
  styleFactor = Math.max(0.97, Math.min(1.10, styleFactor));

  // Speed profile for the (optional) chart — the actual per-point speed the calculation used,
  // after road-class interpretation, length-confidence weighting and max-speed stretching.
  const speedProfile = points.map((p, i) => ({
    distanceKm: p.distanceFromStartKm,
    // The chart should show the actual speed profile fed into the segment calculation, including
    // the user's explicit maximum-speed scenario. Do not replace point speeds with midpoint
    // averages here, otherwise a real 120 km/h fast section can visually collapse to ~90–100.
    speedKmH: Math.round(Math.max(10, Math.min(requestedMaxSpeed ?? 140, roadSpeeds[i] ?? speed))),
  }));

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
    const segmentSpeed = getSegmentSpeed(i);
    const segDuration = segmentDistance / segmentSpeed;
    const elevationGain = Math.max(0, (b.elevationM ?? 0) - (a.elevationM ?? 0));
    const elevationLoss = Math.max(0, (a.elevationM ?? 0) - (b.elevationM ?? 0));
    const climatePower = calculateClimateImpact(weather.temperature, climateOn).powerKw;
    // Cabin warm-up curve: calculateClimateImpact's powerKw is the power needed to bring a
    // cold-soaked cabin up to comfort temperature (worst case — defrost, cold surfaces, full
    // delta-T for the heat pump/PTC to fight). That load is real but temporary: once the cabin
    // and its thermal mass (seats, dash, glass) reach target temperature, the system only has to
    // offset ongoing heat loss through the shell, which takes meaningfully less power. We hold
    // the full (peak) power for the first ~15 minutes, then ease down to a maintenance fraction
    // of it for the rest of the trip, instead of charging every trip at peak power the whole way
    // through — which is very likely the single biggest source of winter over-estimation for
    // anything but short city hops.
    // Uses cumulative elapsed trip time (durationHours before this segment, at its midpoint) —
    // NOT this segment's own tiny duration, since individual route segments are only seconds to
    // minutes long and would never move the ramp off its starting value on their own.
    const HVAC_WARMUP_DURATION_HOURS = 15 / 60; // ~15 minutes to bring a cold-soaked cabin to comfort temp
    const HVAC_MAINTENANCE_FRACTION = 0.6; // steady-state power afterwards, as a fraction of peak warm-up power
    const elapsedAtSegmentMidpoint = durationHours + segDuration / 2;
    const warmupProgress = Math.min(1, elapsedAtSegmentMidpoint / HVAC_WARMUP_DURATION_HOURS);
    const warmFactor = climateOn
      ? 1 - (1 - HVAC_MAINTENANCE_FRACTION) * smoothstep01(warmupProgress)
      : 1;
    const effectiveClimatePower = climatePower * warmFactor;
    // Pass passengers through so the per-segment estimate (which is what actually gets summed
    // into energyKwh/arrivalSoc below) reflects extra passenger mass exactly like the standalone
    // estimateTripConsumption() call does. Previously this argument was silently dropped here,
    // so passenger count was accepted by this function's signature but had zero effect on the
    // real route forecast — only on cosmetic labels computed elsewhere from a separate call.
    const f = estimateTripConsumption(
      segmentSpeed, weather.temperature, sessions, batteryCapacityKwh, climateOn,
      weather.windSpeed, relativeWindAngle, styleFactor, weather.weatherCode, weather.precipitation,
      { gainM: elevationGain, lossM: elevationLoss, distanceKm: segmentDistance }, segDuration, effectiveClimatePower,
      passengers
    );
    const segEnergy = segmentDistance / 100 * f.estimatedConsumption;
    // Keep the breakdown additive while preserving the exact segmented total produced by the
    // established estimator. The "base" line is the no-weather/no-climate speed baseline.
    const speedBase = segmentDistance / 100 * interpolateVigoSpeedConsumption(segmentSpeed);
    const tempDelta = speedBase * (f.temperatureImpactPct / 100);
    const windDelta = speedBase * (f.windImpactPct ?? 0) / 100;
    const precipDelta = speedBase * (f.precipitationImpactPct ?? 0) / 100;
    // Same passenger-adjusted mass as estimateTripConsumption's own elevation model, so this
    // breakdown line (and the regen credit below) stay consistent with what f.estimatedConsumption
    // actually charged for climbs/descents instead of silently assuming a 1-passenger vehicle.
    const vehicleMassKg = 1600 + (Math.max(1, Math.min(5, Math.round(passengers))) - 1) * 75;
    const elevationNet = (vehicleMassKg * 9.80665 * elevationGain / 3.6e6 / 0.90) - (vehicleMassKg * 9.80665 * elevationLoss / 3.6e6 * 0.65);
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
    regenEnergyKwh += (vehicleMassKg * 9.80665 * elevationLoss / 3.6e6 * 0.65);
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
    speedProfile,
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
