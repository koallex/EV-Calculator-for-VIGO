// Charging-time modeling — kept as its own documented, separately-calibratable set of terms,
// same philosophy as the consumption model in storage.ts.
//
// ⚠️ NOT yet calibrated against a real logged fast-charging session on Александр's own car.
// Every constant below is a placeholder until there is a real SoC/time log.
//
// Model (all terms separate, none folded into a blanket multiplier):
//   power(soc) = min( stationMaxPowerKw × STATION_DELIVERY_EFFICIENCY,
//                     vehicleCurve(soc) × (dcMaxKw / 167) × temperaturePowerFactor )
//   chargeMinutes = ∫ dE / power(soc)               (1%-SoC steps)
//   stop minutes  = chargeMinutes + PLUG_IN_OVERHEAD_MIN + detour driving time
//
// Vehicle curve shape is anchored to two published spec figures for the Vigo E2+ (CCS Type 2):
//   - 167 kW peak DC charging power
//   - 30% → 80% SoC in ~18 minutes
// Both assume a ~160 kW+ station with no power-sharing. The curve is a piecewise-linear shape
// that reproduces ~18 min for 30→80% at full, uncontended station power. It is expressed for the
// Vigo's 167 kW and scaled linearly by the profile's `dcMaxKw` (Settings → car profile), so
// dcMaxKw = 167 reproduces the original numbers exactly and a car with a lower limit gets a
// proportionally compressed curve.
export const VIGO_REFERENCE_DC_MAX_KW = 167;
export const VIGO_REFERENCE_AC_MAX_KW = 6.6;

export const VIGO_DC_CHARGE_CURVE_KW: { soc: number; powerKw: number }[] = [
  { soc: 0, powerKw: 70 },
  { soc: 10, powerKw: 120 },
  { soc: 45, powerKw: 120 },
  { soc: 80, powerKw: 45 },
  { soc: 90, powerKw: 25 },
  { soc: 100, powerKw: 12 },
];

// Most Belarusian stations in OSM don't have a tagged power rating yet. Leaving the station
// limit undefined would let the curve run at the car's own peak — i.e. silently assume a
// top-tier ultra-fast charger. 50 kW is a conservative, still-fairly-common floor for a public
// CCS lot; callers should surface that this is an assumption, not a real reading.
export const DEFAULT_UNKNOWN_STATION_POWER_KW = 50;

/** Share of the station's rated power that actually reaches the battery (cable / conversion
 *  losses, real-world derating). Applied only to the station-side limit. */
export const STATION_DELIVERY_EFFICIENCY = 0.92;
/** Time to park, plug in, authorize and start the session — added once per stop. */
export const PLUG_IN_OVERHEAD_MIN = 5;
/** Straight-line distance-from-route → road distance. */
export const DETOUR_ROAD_FACTOR = 1.3;
/** Average speed on the detour to/from the station. */
export const DETOUR_SPEED_KMH = 40;

export type ChargeConnector = 'ccs2' | 'type2' | 'gbt';

/** Vehicle-side charging limits, taken from the car profile (Settings). */
export interface ChargeVehicleLimits {
  /** Max DC charge power the car accepts (kW). */
  dcMaxKw?: number;
  /** Onboard AC charger limit (kW). */
  acMaxKw?: number;
}

/** Everything that determines the charge power at a given SoC. One object instead of
 *  positional arguments — positional slots were a source of silent bugs before. */
export interface ChargePowerParams {
  connector: ChargeConnector;
  /** Rated power of the specific station/connector (kW). Undefined = car-limited. */
  stationMaxPowerKw?: number;
  /** Outside temperature at the stop (°C). Undefined = no temperature limit. */
  temperatureC?: number;
  vehicle?: ChargeVehicleLimits;
}

const positiveOr = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback;

const interpolateCurve = (curve: { soc: number; powerKw: number }[], soc: number): number => {
  const s = Math.max(0, Math.min(100, soc));
  if (s <= curve[0].soc) return curve[0].powerKw;
  for (let i = 1; i < curve.length; i++) {
    if (s <= curve[i].soc) {
      const a = curve[i - 1], b = curve[i];
      const t = (s - a.soc) / Math.max(0.001, b.soc - a.soc);
      return a.powerKw + (b.powerKw - a.powerKw) * t;
    }
  }
  return curve[curve.length - 1].powerKw;
};

/**
 * Battery-side power limit from temperature (fraction of the warm-weather curve). The car is
 * assumed to arrive at the charger after driving, so the pack is partly warmed "from the
 * wheels". This limits POWER, not time: on a slow station the station is the bottleneck and
 * cold does not stretch the session; on a fast one it caps what the pack accepts.
 * Placeholder values until real cold-weather charging logs exist.
 */
export const VIGO_EN_ROUTE_CHARGE_TEMP_POWER_POINTS: { temperatureC: number; powerFactor: number }[] = [
  { temperatureC: -20, powerFactor: 0.68 },
  { temperatureC: -15, powerFactor: 0.74 },
  { temperatureC: -10, powerFactor: 0.80 },
  { temperatureC: -5, powerFactor: 0.86 },
  { temperatureC: 0, powerFactor: 0.92 },
  { temperatureC: 5, powerFactor: 0.96 },
  { temperatureC: 15, powerFactor: 1.00 },
  { temperatureC: 30, powerFactor: 1.00 },
  { temperatureC: 35, powerFactor: 0.95 },
];

export const getEnRouteChargePowerFactor = (temperatureC?: number): number => {
  if (!Number.isFinite(temperatureC)) return 1;
  const t = temperatureC as number;
  const points = VIGO_EN_ROUTE_CHARGE_TEMP_POWER_POINTS;
  if (t <= points[0].temperatureC) return points[0].powerFactor;
  if (t >= points[points.length - 1].temperatureC) return points[points.length - 1].powerFactor;
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].temperatureC) {
      const a = points[i - 1];
      const b = points[i];
      const f = (t - a.temperatureC) / Math.max(0.001, b.temperatureC - a.temperatureC);
      return a.powerFactor + (b.powerFactor - a.powerFactor) * f;
    }
  }
  return 1;
};

/** Charging power (kW into the battery) at a given SoC: the vehicle's own curve — scaled to
 *  the profile's dcMaxKw, capped by the onboard AC charger for Type 2, reduced by temperature —
 *  further capped by what the station actually delivers. */
export const chargePowerKwAtSoc = (soc: number, params: ChargePowerParams): number => {
  const dcMaxKw = positiveOr(params.vehicle?.dcMaxKw, VIGO_REFERENCE_DC_MAX_KW);
  const acMaxKw = positiveOr(params.vehicle?.acMaxKw, VIGO_REFERENCE_AC_MAX_KW);
  const curveKw = interpolateCurve(VIGO_DC_CHARGE_CURVE_KW, soc) * (dcMaxKw / VIGO_REFERENCE_DC_MAX_KW);
  const tempFactor = getEnRouteChargePowerFactor(params.temperatureC);
  const vehicleKw = (params.connector === 'type2' ? Math.min(curveKw, acMaxKw) : curveKw) * tempFactor;
  return params.stationMaxPowerKw
    ? Math.min(vehicleKw, params.stationMaxPowerKw * STATION_DELIVERY_EFFICIENCY)
    : vehicleKw;
};

export interface ChargeSessionEstimate {
  /** Total time of the stop: charging + plug-in overhead + detour. */
  minutes: number;
  /** Pure charging time. */
  chargeMinutes: number;
  /** Parking / plug-in / authorization. */
  overheadMinutes: number;
  /** Extra driving to reach the station and return to the route. */
  detourMinutes: number;
  energyKwh: number;
  /** Average power over the charging part only. */
  avgPowerKw: number;
}

export interface ChargeSessionParams extends ChargePowerParams {
  fromSoc: number;
  toSoc: number;
  batteryCapacityKwh: number;
  /** One-way distance of the station from the route (km). */
  detourKm?: number;
  overheadMinutes?: number;
}

/** Integrates the charge curve in 1%-SoC steps from fromSoc to toSoc. */
export const estimateChargingSession = (params: ChargeSessionParams): ChargeSessionEstimate => {
  const from = Math.max(0, Math.min(100, params.fromSoc));
  const to = Math.max(from, Math.min(100, params.toSoc));
  const STEP = 1;
  let hours = 0;
  let energyKwh = 0;
  for (let soc = from; soc < to; soc += STEP) {
    const stepSoc = Math.min(STEP, to - soc);
    const powerKw = chargePowerKwAtSoc(soc + stepSoc / 2, params);
    const stepEnergyKwh = (stepSoc / 100) * params.batteryCapacityKwh;
    energyKwh += stepEnergyKwh;
    hours += powerKw > 0 ? stepEnergyKwh / powerKw : 0;
  }
  const chargeMinutes = Math.round(hours * 60);
  // A stop that adds nothing stays at 0 so callers can still filter it out.
  const hasStop = chargeMinutes > 0;
  const overheadMinutes = hasStop ? Math.round(params.overheadMinutes ?? PLUG_IN_OVERHEAD_MIN) : 0;
  const detourKm = Number.isFinite(params.detourKm) ? Math.max(0, params.detourKm as number) : 0;
  const detourMinutes = hasStop
    ? Math.round(((2 * detourKm * DETOUR_ROAD_FACTOR) / DETOUR_SPEED_KMH) * 60)
    : 0;
  return {
    minutes: chargeMinutes + overheadMinutes + detourMinutes,
    chargeMinutes,
    overheadMinutes,
    detourMinutes,
    energyKwh: Number(energyKwh.toFixed(2)),
    avgPowerKw: hours > 0 ? Number((energyKwh / hours).toFixed(1)) : 0,
  };
};

/**
 * Picks a charge target that balances "enough to safely finish the trip" against "don't keep
 * charging once the marginal rate has collapsed". Starting from max(fromSoc, minRequiredSoc),
 * it walks forward in 1% steps while the charging power at that SoC is still at least
 * `marginalRateThreshold` (default 50%) of the curve's peak power for this car/station; it stops
 * as soon as that condition fails. `minRequiredSoc` always wins over the efficiency cutoff —
 * necessity (reaching point B with reserve) is never traded away for a faster stop.
 */
export const findOptimalChargeTargetSoc = (
  fromSoc: number,
  minRequiredSoc: number,
  power: ChargePowerParams,
  options: { maxTargetSoc?: number; marginalRateThreshold?: number } = {},
): number => {
  const maxTargetSoc = options.maxTargetSoc ?? 90;
  const marginalRateThreshold = options.marginalRateThreshold ?? 0.5;
  const peakPowerKw = Math.max(...VIGO_DC_CHARGE_CURVE_KW.map(p => chargePowerKwAtSoc(p.soc, power)));
  const floor = Math.max(fromSoc, minRequiredSoc);
  let efficientTarget = Math.min(maxTargetSoc, floor);
  for (let soc = floor; soc <= maxTargetSoc; soc += 1) {
    const powerKw = chargePowerKwAtSoc(soc, power);
    if (powerKw < peakPowerKw * marginalRateThreshold) break;
    efficientTarget = soc;
  }
  return Math.max(Math.min(minRequiredSoc, maxTargetSoc), Math.min(maxTargetSoc, efficientTarget));
};
