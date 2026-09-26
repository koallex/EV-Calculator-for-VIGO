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

export type BodyType = 'hatch' | 'crossover' | 'sedan' | 'suv';

/**
 * Relative aerodynamic scale by body shape (1.0 = Vigo crossover baseline).
 * Used for the custom profile and as a planning hint for similar shapes.
 * Hatch is more efficient, SUV more boxy → higher high-speed drag share.
 */
export const BODY_TYPE_AERO_SCALE: Record<BodyType, number> = {
  hatch: 0.92,
  sedan: 0.96,
  crossover: 1.0,
  suv: 1.08,
};

export const BODY_TYPE_LABELS: Record<BodyType, string> = {
  hatch: 'Хэтчбек',
  sedan: 'Седан',
  crossover: 'Кроссовер',
  suv: 'SUV / Внедорожник',
};

export interface VehicleProfile {
  id: string;
  brand: string;
  name: string;
  /** Short label for selects, e.g. "Dongfeng Vigo". */
  displayName: string;
  body: BodyType;
  /** Ports on the car — filter stations by CCS2 / Type2 / GB/T. */
  connectors: Array<'ccs2' | 'type2' | 'gbt'>;
  variants: VehicleVariant[];
  notes?: string;
  /** User-defined profile — mass, body, battery, heat pump set manually in Settings. */
  isCustom?: boolean;
}

export const VEHICLE_PROFILES: VehicleProfile[] = [
  {
    id: 'dongfeng-vigo',
    brand: 'Dongfeng',
    name: 'Vigo',
    displayName: 'Dongfeng Vigo',
    body: 'crossover',
    connectors: ['ccs2', 'type2'],
    notes:
      'Профиль по умолчанию. Кривая расхода откалибрована под Vigo. Комплектации РБ — с тепловым насосом (зимний пакет); HVAC считается как ТН + подмешивающий ТЭН.',
    variants: [
      {
        id: '51.87',
        label: '51.87 кВт·ч',
        batteryCapacityKwh: 51.87,
        curbWeightKg: 1526,
        consumptionScale: 1.0,
        hasHeatPump: true,
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
    // Китайский рынок / поставки в РБ: родной разъём GB/T (AC+DC). CCS2 только с адаптером.
    connectors: ['gbt'],
    notes: 'В РБ обычно GB/T. Станции фильтруются по GB/T. Тепловой насос на многих версиях.',
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
  {
    id: 'custom',
    brand: 'Свой',
    name: 'профиль',
    displayName: 'Свой автомобиль',
    body: 'crossover',
    connectors: ['ccs2', 'type2'],
    isCustom: true,
    notes:
      'Задайте массу, тип кузова (аэродинамика), ёмкость батареи и наличие теплового насоса вручную. Масштаб расхода подстраивается под форму кузова.',
    variants: [
      {
        id: 'custom',
        label: 'Пользовательский',
        batteryCapacityKwh: 50,
        curbWeightKg: 1600,
        consumptionScale: 1.0,
        hasHeatPump: false,
        acMaxKw: 7,
        dcMaxKw: 100,
        chemistry: 'lfp',
        default: true,
      },
    ],
  },
];

export const DEFAULT_VEHICLE_PROFILE_ID = 'dongfeng-vigo';
export const DEFAULT_VEHICLE_VARIANT_ID = '51.87';

export type ConnectorOverride =
  | 'auto'
  | 'ccs2'
  | 'gbt'
  | 'type2'
  | 'ccs2_type2'
  | 'ccs2_gbt';

const OVERRIDE_TO_CONNECTORS: Record<Exclude<ConnectorOverride, 'auto'>, Array<'ccs2' | 'type2' | 'gbt'>> = {
  ccs2: ['ccs2'],
  gbt: ['gbt'],
  type2: ['type2'],
  ccs2_type2: ['ccs2', 'type2'],
  ccs2_gbt: ['ccs2', 'gbt'],
};

/**
 * Effective charge ports for filtering stations / planning stops.
 * `connectorOverride` from settings replaces the profile default when not 'auto'.
 */
export function resolveEffectiveConnectors(
  profileId?: string | null,
  connectorOverride?: ConnectorOverride | string | null,
): Array<'ccs2' | 'type2' | 'gbt'> {
  const override = (connectorOverride || 'auto') as ConnectorOverride;
  if (override !== 'auto' && OVERRIDE_TO_CONNECTORS[override as Exclude<ConnectorOverride, 'auto'>]) {
    return [...OVERRIDE_TO_CONNECTORS[override as Exclude<ConnectorOverride, 'auto'>]];
  }
  return [...getVehicleProfile(profileId).connectors];
}

export function formatConnectorsLabel(connectors: Array<'ccs2' | 'type2' | 'gbt'>): string {
  return connectors
    .map((c) => (c === 'gbt' ? 'GB/T' : c === 'ccs2' ? 'CCS2' : 'Type2'))
    .join(' / ');
}

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
  vehicleBodyType?: BodyType;
}>(settings: T, profileId: string, variantId: string): T {
  const profile = getVehicleProfile(profileId);
  const variant = getVehicleVariant(profileId, variantId);
  // Keep user's manual custom numbers when switching to the custom slot;
  // only seed defaults the first time (missing fields).
  if (profile.isCustom) {
    const body = (settings.vehicleBodyType as BodyType) || profile.body;
    const scale = BODY_TYPE_AERO_SCALE[body] ?? 1;
    return {
      ...settings,
      vehicleProfileId: profileId,
      vehicleVariantId: variant.id,
      vehicleBodyType: body,
      batteryCapacityKwh: settings.batteryCapacityKwh || variant.batteryCapacityKwh,
      curbWeightKg: settings.curbWeightKg || variant.curbWeightKg,
      consumptionScale: scale,
      hasHeatPump: settings.hasHeatPump ?? variant.hasHeatPump,
      acMaxKw: settings.acMaxKw ?? variant.acMaxKw,
      dcMaxKw: settings.dcMaxKw ?? variant.dcMaxKw,
    };
  }
  return {
    ...settings,
    vehicleProfileId: profileId,
    vehicleVariantId: variant.id,
    vehicleBodyType: profile.body,
    batteryCapacityKwh: variant.batteryCapacityKwh,
    curbWeightKg: variant.curbWeightKg,
    consumptionScale: variant.consumptionScale,
    hasHeatPump: variant.hasHeatPump,
    acMaxKw: variant.acMaxKw,
    dcMaxKw: variant.dcMaxKw,
  };
}

/** Update custom-profile fields and sync consumptionScale from body type. */
export function applyCustomVehicleFields<T extends {
  vehicleProfileId?: string;
  curbWeightKg?: number;
  batteryCapacityKwh: number;
  hasHeatPump?: boolean;
  consumptionScale?: number;
  vehicleBodyType?: BodyType;
}>(
  settings: T,
  fields: {
    curbWeightKg?: number;
    batteryCapacityKwh?: number;
    hasHeatPump?: boolean;
    vehicleBodyType?: BodyType;
  },
): T {
  const body = fields.vehicleBodyType ?? settings.vehicleBodyType ?? 'crossover';
  return {
    ...settings,
    vehicleProfileId: 'custom',
    vehicleVariantId: 'custom',
    vehicleBodyType: body,
    curbWeightKg: fields.curbWeightKg ?? settings.curbWeightKg,
    batteryCapacityKwh: fields.batteryCapacityKwh ?? settings.batteryCapacityKwh,
    hasHeatPump: fields.hasHeatPump ?? settings.hasHeatPump,
    consumptionScale: BODY_TYPE_AERO_SCALE[body] ?? 1,
  };
}
