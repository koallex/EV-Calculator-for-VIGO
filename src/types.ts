export type ThemeMode = 'dark' | 'light' | 'oled';

export interface UserSettings {
  batteryCapacityKwh: number; // default 51.87 (Dongfeng Vigo)
  /** Active vehicle profile id from vehicleProfiles catalog (e.g. dongfeng-vigo). */
  vehicleProfileId?: string;
  /** Battery / trim variant id within the profile (e.g. 51.87, 42.3). */
  vehicleVariantId?: string;
  /** Curb weight used for elevation / mass model (kg). */
  curbWeightKg?: number;
  /** Multiplier on the shared speed-consumption curve (Vigo baseline = 1). */
  consumptionScale?: number;
  /** Heat pump present — reduces estimated winter HVAC electrical load. */
  hasHeatPump?: boolean;
  /** On-board AC max power (kW), informational / charge-time estimates. */
  acMaxKw?: number;
  /** Vehicle DC peak charge power (kW). */
  dcMaxKw?: number;
  /**
   * Manual charge-port override. When set (not 'auto'), replaces the profile's
   * default connectors for station filtering and charge planning.
   * Values: 'auto' | 'ccs2' | 'gbt' | 'type2' | 'ccs2_type2' | 'ccs2_gbt'
   */
  connectorOverride?: 'auto' | 'ccs2' | 'gbt' | 'type2' | 'ccs2_type2' | 'ccs2_gbt';
  currency: string; // e.g. 'Br', '₽', '$', '€', '₸'
  regionPreset?: 'belarus' | 'russia' | 'custom';
  
  // Core Tariffs
  homeTariff: number; // Домашняя стандарт (AC)
  homeNightTariff?: number; // Домашняя ночная (льготная)
  fastDayTariff: number; // Быстрая DC (День)
  fastNightTariff: number; // Быстрая DC (Ночь)
  slowPublicTariff: number; // Медленная AC (городская)
  
  // Belarus / Custom Operators
  malankaDcTariff?: number; // Маланка DC (0.56 - 0.65 Br)
  malankaAcTariff?: number; // Маланка AC (0.43 - 0.45 Br)
  evikaTariff?: number; // Белтелеком Evika (0.43 Br)
  batteryFlyTariff?: number; // BatteryFly / Forpost (0.60 Br)
  zaryadkaTariff?: number; // Zaryadka (Зарядка) общий (0.56 Br)
  zaryadkaDayTariff?: number; // Zaryadka Дневной (0.56 Br)
  zaryadkaNightTariff?: number; // Zaryadka Ночной (0.43 Br)
  zaryadkaDcTariff?: number; // Zaryadka DC (0.56 Br)
  zaryadkaAcTariff?: number; // Zaryadka AC (0.43 Br)
  
  gasEquivalentL100km: number; // e.g. 8.0 L/100km
  gasPricePerLiter: number; // e.g. 2.45 Br/L or 62.0 ₽/L
  hapticFeedback: boolean;
  theme: ThemeMode;
  targetMaxSoc: number; // e.g. 80 or 100 for battery health advice

  // Deprecated fields kept for migration compatibility
  nightTariff?: number;
  fastChargeTariff?: number;
}

export type ChargingType = 
  | 'home' 
  | 'home_night'
  | 'fast_day' 
  | 'fast_night' 
  | 'slow_public' 
  | 'malanka_dc'
  | 'malanka_ac'
  | 'evika'
  | 'batteryfly'
  | 'zaryadka'
  | 'zaryadka_day'
  | 'zaryadka_night'
  | 'zaryadka_dc'
  | 'zaryadka_ac'
  | 'free' 
  | 'custom'
  // Backward compatibility:
  | 'home_day' 
  | 'fast_dc';
export type RoadType = 'city' | 'highway' | 'mixed';
export type WeatherType = 'summer' | 'spring_autumn' | 'winter_mild' | 'winter_cold';

export interface TripSession {
  id: string;
  date: string; // YYYY-MM-DD
  title?: string;
  startSoc: number; // 0-100%
  endSoc: number; // 0-100%
  endSocAdjustedManually?: boolean; // true when the user corrected the measured finish SOC in History
  distanceKm: number; // km
  odoStart?: number;
  odoEnd?: number;
  avgSpeedKmH?: number; // Real average speed recorded during trip or HUD tracking
  maxSpeedKmH?: number; // Max speed recorded
  drivingStyleFactor?: number; // Structured driving-style coefficient from HUD; independent of weather
  passengers?: number; // Total people in the vehicle, including the driver (default 1)
  energyUsedKwh: number; // calculated: (startSoc - endSoc)/100 * batteryCapacity
  consumptionPer100Km: number; // kWh/100km
  kmPerKwh: number;
  chargingType: ChargingType;
  customTariff?: number;
  totalCost: number;
  gasCostEquivalent: number;
  moneySaved: number;
  roadType: RoadType;
  climateOn: boolean;
  temperature?: number;
  weatherCondition?: string;
  note?: string;
  elevationGainM?: number;
  elevationLossM?: number;
  startElevationM?: number;
  endElevationM?: number;
  elevationEnergyUsedKwh?: number;
  regenEnergyRecoveredKwh?: number;
  // Pre-trip Calculator route forecast, attached automatically (see routeForecastBridge.ts) when
  // a HUD trip is saved shortly after a matching route calculation — lets History compare
  // predicted vs actual without needing a separate "forecast accuracy" screen yet.
  forecastArrivalSoc?: number;
  forecastConsumptionPer100Km?: number;
  forecastEnergyKwh?: number;
  forecastPlannedSpeedKmH?: number;
  forecastPlannedMaxSpeedKmH?: number;
  forecastSpeedProfile?: Array<{ distanceKm: number; speedKmH: number }>;
  // Compact JSON trail of {d,v,w,a,m,e} checkpoints (distanceKm, speedKmH, windSpeedKmH,
  // relativeWindAngleDeg, windMultiplier, cumulativeEnergyKwh) sampled ~every 1km during HUD
  // live tracking — see HudTab's windLogRef. Captured before any manual endSoc correction.
  hudWindLog?: string;
  createdAt: number;
}

export interface ChargerPreset {
  id: string;
  name: string;
  description: string;
  powerKw: number;
  type: 'ac_slow' | 'ac_fast' | 'dc_fast';
  icon: string;
}

export interface QuickPreset {
  label: string;
  startSoc: number;
  endSoc: number;
  distanceKm: number;
  description: string;
}
