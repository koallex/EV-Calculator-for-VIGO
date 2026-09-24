/**
 * Vehicle profiles for the Belarus (РБ) market — popular pure BEVs.
 * Capacities are nominal (gross) unless noted; curb weights are approximate.
 * consumptionScale multiplies the Vigo speed-consumption curve (1.0 = Vigo baseline).
 * Values are planning estimates for the calculator, not lab measurements.
 */

export type BatteryChemistry = 'lfp' | 'nmc';

export interface VehicleVariant {
  id: string;
  label: string;
  /** Nominal pack capacity used in SOC → kWh conversion (kWh). */
  batteryCapacityKwh: number;
  curbWeightKg: number;
  /** Multiplier on the shared speed-consumption curve (Vigo = 1). */
  consumptionScale: number;
  hasHeatPump: boolean;
  acMaxKw: number;
  dcMaxKw: number;
  chemistry: BatteryChemistry;
  /** Default variant for this model when selected. */
  default?: boolean;
}

export interface VehicleProfile {
  id: string;
  brand: string;
  name: string;
  /** Short label for selects, e.g. "Dongfeng Vigo". */
  displayName: string;
  body: 'hatch' | 'crossover' | 'sedan' | 'suv';
  connectors: Array<'ccs2' | 'type2'>;
  variants: VehicleVariant[];
  notes?: string;
}

export const VEHICLE_PROFILES: VehicleProfile[] = [
  {
    id: 'dongfeng-vigo',
    brand: 'Dongfeng',
    name: 'Vigo',
    displayName: 'Dongfeng Vigo',
    body: 'crossover',
    connectors: ['ccs2', 'type2'],
    notes: 'Профиль по умолчанию. Кривая расхода откалибрована под Vigo.',
    variants: [
      {
        id: '51.87',
        label: '51.87 кВт·ч',
        batteryCapacityKwh: 51.87,
        curbWeightKg: 1526,
        consumptionScale: 1.0,
        hasHeatPump: false,
        acMaxKw: 6.6,
        dcMaxKw: 167,
        chemistry: 'lfp',
        default: true,
      },
    ],
  },
  {
    id: 'dongfeng-box',
    brand: 'Dongfeng',
    name: 'Box',
    displayName: 'Dongfeng Box',
    body: 'hatch',
    connectors: ['ccs2', 'type2'],
    notes: 'Народный бестселлер РБ. Основная версия ~42 кВт·ч.',
    variants: [
      {
        id: '31.4',
        label: '31.4 кВт·ч',
        batteryCapacityKwh: 31.4,
        curbWeightKg: 1250,
        consumptionScale: 0.92,
        hasHeatPump: false,
        acMaxKw: 3.3,
        dcMaxKw: 57,
        chemistry: 'lfp',
      },
      {
        id: '42.3',
        label: '42.3 кВт·ч',
        batteryCapacityKwh: 42.3,
        curbWeightKg: 1430,
        consumptionScale: 0.94,
        hasHeatPump: false,
        acMaxKw: 6.6,
        dcMaxKw: 88,
        chemistry: 'lfp',
        default: true,
      },
    ],
  },
  {
    id: 'geely-ex2',
    brand: 'Geely',
    name: 'EX2',
    displayName: 'Geely EX2',
    body: 'hatch',
    connectors: ['ccs2', 'type2'],
    notes: 'Сборка Belgee. В РБ Pro/Max — 39.4 кВт·ч.',
    variants: [
      {
        id: '39.4',
        label: '39.4 кВт·ч (РБ)',
        batteryCapacityKwh: 39.4,
        curbWeightKg: 1300,
        consumptionScale: 0.93,
        hasHeatPump: false,
        acMaxKw: 6.6,
        dcMaxKw: 70,
        chemistry: 'lfp',
        default: true,
      },
      {
        id: '35',
        label: '35 кВт·ч',
        batteryCapacityKwh: 35.0,
        curbWeightKg: 1290,
        consumptionScale: 0.92,
        hasHeatPump: false,
        acMaxKw: 6.6,
        dcMaxKw: 60,
        chemistry: 'lfp',
      },
      {
        id: '47.1',
        label: '47.1 кВт·ч',
        batteryCapacityKwh: 47.1,
        curbWeightKg: 1365,
        consumptionScale: 0.94,
        hasHeatPump: false,
        acMaxKw: 11,
        dcMaxKw: 80,
        chemistry: 'lfp',
      },
    ],
  },
  {
    id: 'geely-ex5',
    brand: 'Geely',
    name: 'EX5',
    displayName: 'Geely EX5',
    body: 'crossover',
    connectors: ['ccs2', 'type2'],
    notes: 'Сборка Belgee. Тепловой насос в типичных комплектациях.',
    variants: [
      {
        id: '60.2',
        label: '60.2 кВт·ч',
        batteryCapacityKwh: 60.22,
        curbWeightKg: 1765,
        consumptionScale: 1.06,
        hasHeatPump: true,
        acMaxKw: 11,
        dcMaxKw: 100,
        chemistry: 'lfp',
        default: true,
      },
      {
        id: '49.5',
        label: '49.5 кВт·ч',
        batteryCapacityKwh: 49.52,
        curbWeightKg: 1700,
        consumptionScale: 1.04,
        hasHeatPump: true,
        acMaxKw: 11,
        dcMaxKw: 100,
        chemistry: 'lfp',
      },
      {
        id: '68.4',
        label: '68.4 кВт·ч',
        batteryCapacityKwh: 68.39,
        curbWeightKg: 1815,
        consumptionScale: 1.08,
        hasHeatPump: true,
        acMaxKw: 11,
        dcMaxKw: 100,
        chemistry: 'lfp',
      },
    ],
  },
  {
    id: 'deepal-s05',
    brand: 'Deepal',
    name: 'S05',
    displayName: 'Deepal S05',
    body: 'crossover',
    connectors: ['ccs2', 'type2'],
    notes: 'Популярный середняк в РБ. Тепловой насос на EU/топ версиях.',
    variants: [
      {
        id: '56.1',
        label: '56.1 кВт·ч',
        batteryCapacityKwh: 56.1,
        curbWeightKg: 1770,
        consumptionScale: 1.05,
        hasHeatPump: true,
        acMaxKw: 11,
        dcMaxKw: 150,
        chemistry: 'lfp',
        default: true,
      },
      {
        id: '68.8',
        label: '68.8 кВт·ч',
        batteryCapacityKwh: 68.8,
        curbWeightKg: 1940,
        consumptionScale: 1.08,
        hasHeatPump: true,
        acMaxKw: 11,
        dcMaxKw: 200,
        chemistry: 'lfp',
      },
    ],
  },
  {
    id: 'byd-song-plus',
    brand: 'BYD',
    name: 'Song Plus EV',
    displayName: 'BYD Song Plus EV',
    body: 'suv',
    connectors: ['ccs2', 'type2'],
    notes: 'Долго один из самых частых на зарядках РБ. Blade LFP.',
    variants: [
      {
        id: '71.7',
        label: '71.7 кВт·ч',
        batteryCapacityKwh: 71.7,
        curbWeightKg: 1950,
        consumptionScale: 1.08,
        hasHeatPump: true,
        acMaxKw: 7,
        dcMaxKw: 110,
        chemistry: 'lfp',
      },
      {
        id: '87',
        label: '87 кВт·ч',
        batteryCapacityKwh: 87.0,
        curbWeightKg: 2050,
        consumptionScale: 1.10,
        hasHeatPump: true,
        acMaxKw: 11,
        dcMaxKw: 140,
        chemistry: 'lfp',
        default: true,
      },
    ],
  },
  {
    id: 'byd-yuan-plus',
    brand: 'BYD',
    name: 'Yuan Plus / Atto 3',
    displayName: 'BYD Yuan Plus',
    body: 'crossover',
    connectors: ['ccs2', 'type2'],
    notes: 'Atto 3 на экспорте. Blade LFP, много на вторичке РБ.',
    variants: [
      {
        id: '49.9',
        label: '49.9 кВт·ч',
        batteryCapacityKwh: 49.92,
        curbWeightKg: 1625,
        consumptionScale: 1.02,
        hasHeatPump: false,
        acMaxKw: 7,
        dcMaxKw: 70,
        chemistry: 'lfp',
      },
      {
        id: '60.5',
        label: '60.5 кВт·ч',
        batteryCapacityKwh: 60.48,
        curbWeightKg: 1750,
        consumptionScale: 1.04,
        hasHeatPump: false,
        acMaxKw: 11,
        dcMaxKw: 88,
        chemistry: 'lfp',
        default: true,
      },
    ],
  },
];

export const DEFAULT_VEHICLE_PROFILE_ID = 'dongfeng-vigo';
export const DEFAULT_VEHICLE_VARIANT_ID = '51.87';

export function getVehicleProfile(profileId?: string | null): VehicleProfile {
  return (
    VEHICLE_PROFILES.find((p) => p.id === profileId) ||
    VEHICLE_PROFILES.find((p) => p.id === DEFAULT_VEHICLE_PROFILE_ID)!
  );
}

export function getVehicleVariant(
  profileId?: string | null,
  variantId?: string | null,
): VehicleVariant {
  const profile = getVehicleProfile(profileId);
  const byId = profile.variants.find((v) => v.id === variantId);
  if (byId) return byId;
  return profile.variants.find((v) => v.default) || profile.variants[0];
}

/** Apply selected profile/variant onto settings fields used by the calculator. */
export function applyVehicleVariantToSettings<T extends {
  vehicleProfileId?: string;
  vehicleVariantId?: string;
  batteryCapacityKwh: number;
  curbWeightKg?: number;
  consumptionScale?: number;
  hasHeatPump?: boolean;
  acMaxKw?: number;
  dcMaxKw?: number;
}>(settings: T, profileId: string, variantId: string): T {
  const variant = getVehicleVariant(profileId, variantId);
  return {
    ...settings,
    vehicleProfileId: profileId,
    vehicleVariantId: variant.id,
    batteryCapacityKwh: variant.batteryCapacityKwh,
    curbWeightKg: variant.curbWeightKg,
    consumptionScale: variant.consumptionScale,
    hasHeatPump: variant.hasHeatPump,
    acMaxKw: variant.acMaxKw,
    dcMaxKw: variant.dcMaxKw,
  };
}
