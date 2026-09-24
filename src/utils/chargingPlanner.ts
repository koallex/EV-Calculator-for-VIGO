// Charging-time modeling for the Dongfeng Vigo (51.87 kWh LFP) — kept as its own documented,
// separately-calibratable term, same philosophy as the consumption model in storage.ts.
//
// ⚠️ NOT yet calibrated against a real logged fast-charging session on Александр's own car.
// Anchored instead to two published spec figures for the Vigo E2+ (CCS Type 2):
//   - 167 kW peak DC charging power
//   - 30% → 80% SoC in ~18 minutes
// Both spec figures assume a ~160 kW+ station with the car as the only vehicle drawing power
// from it (no power-sharing with a neighbouring stall). A real public station is very often
// slower than that — either rated below 160 kW to begin with, or a shared-power unit that
// derates when another car is charging alongside — in which case the curve below is correctly
// capped by `stationMaxPowerKw` in chargePowerKwAtSoc, and the resulting session will (rightly)
// take longer than the 18-minute headline figure. The curve below is a piecewise-linear shape
// picked to reproduce that 18-minute window at full, uncontended station power (it comes out to
// ~17 min for the same 30→80% span — within the spread you'd expect reverse-engineering a curve
// from two spec numbers). Treat every number here as a placeholder until there's a real SoC/time
// log from an actual DC fast-charge session — the same way the consumption model itself only
// became trustworthy after real-trip confirmation.
export const VIGO_DC_CHARGE_CURVE_KW: { soc: number; powerKw: number }[] = [
  { soc: 0, powerKw: 70 },
  { soc: 10, powerKw: 120 },
  { soc: 45, powerKw: 120 },
  { soc: 80, powerKw: 45 },
  { soc: 90, powerKw: 25 },
  { soc: 100, powerKw: 12 },
];

// Type 2 AC is capped by the car's onboard charger, not by the DC curve above.
const VIGO_AC_MAX_POWER_KW = 6.6;

// Most Belarusian stations in OSM don't have a tagged power rating yet (the project's own
// notes flag OSM/Overpass coverage there as still thin). Leaving `stationMaxPowerKw` undefined
// in that case would let the curve run at the car's own peak (up to 167 kW) — i.e. silently
// assume a top-tier ultra-fast charger. That's the wrong default: most public DC stations
// Александр is likely to actually plug into are well under that. 50 kW is a conservative,
// still-fairly-common "at least this much" floor for a public CCS lot; callers should also
// surface to the user that this is an assumption, not a real reading, when it's used.
export const DEFAULT_UNKNOWN_STATION_POWER_KW = 50;

export type ChargeConnector = 'ccs2' | 'type2' | 'gbt';

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

/** Charging power actually available at a given SoC: the vehicle's own curve (or the AC
 *  onboard-charger cap for Type 2), further capped by whatever the specific station/connector
 *  can deliver — a 50 kW public CCS lot won't give 167 kW just because the car could take it. */
export const chargePowerKwAtSoc = (soc: number, connector: ChargeConnector, stationMaxPowerKw?: number): number => {
  const vehiclePowerKw = connector === 'type2'
    ? Math.min(interpolateCurve(VIGO_DC_CHARGE_CURVE_KW, soc), VIGO_AC_MAX_POWER_KW)
    : interpolateCurve(VIGO_DC_CHARGE_CURVE_KW, soc);
  return stationMaxPowerKw ? Math.min(vehiclePowerKw, stationMaxPowerKw) : vehiclePowerKw;
};

export interface ChargeSessionEstimate { minutes: number; energyKwh: number; avgPowerKw: number; }

/** Integrates the charge curve in 1%-SoC steps from fromSoc to toSoc. */
export const estimateChargingSession = (
  fromSoc: number,
  toSoc: number,
  batteryCapacityKwh: number,
  connector: ChargeConnector,
  stationMaxPowerKw?: number,
): ChargeSessionEstimate => {
  const from = Math.max(0, Math.min(100, fromSoc));
  const to = Math.max(from, Math.min(100, toSoc));
  const STEP = 1;
  let hours = 0;
  let energyKwh = 0;
  for (let soc = from; soc < to; soc += STEP) {
    const stepSoc = Math.min(STEP, to - soc);
    const powerKw = chargePowerKwAtSoc(soc + stepSoc / 2, connector, stationMaxPowerKw);
    const stepEnergyKwh = (stepSoc / 100) * batteryCapacityKwh;
    energyKwh += stepEnergyKwh;
    hours += powerKw > 0 ? stepEnergyKwh / powerKw : 0;
  }
  return {
    minutes: Math.round(hours * 60),
    energyKwh: Number(energyKwh.toFixed(2)),
    avgPowerKw: hours > 0 ? Number((energyKwh / hours).toFixed(1)) : 0,
  };
};

/**
 * Picks a charge target that balances "enough to safely finish the trip" against "don't keep
 * charging once the marginal rate has collapsed". Starting from max(fromSoc, minRequiredSoc),
 * it walks forward in 1% steps while the charging power at that SoC is still at least
 * `marginalRateThreshold` (default 50%) of the curve's peak power for this connector/station;
 * it stops as soon as that condition fails. `minRequiredSoc` always wins over the efficiency
 * cutoff — necessity (reaching point B with reserve) is never traded away for a faster stop.
 */
export const findOptimalChargeTargetSoc = (
  fromSoc: number,
  minRequiredSoc: number,
  connector: ChargeConnector,
  stationMaxPowerKw?: number,
  options: { maxTargetSoc?: number; marginalRateThreshold?: number } = {},
): number => {
  const maxTargetSoc = options.maxTargetSoc ?? 90;
  const marginalRateThreshold = options.marginalRateThreshold ?? 0.5;
  const peakPowerKw = Math.max(...VIGO_DC_CHARGE_CURVE_KW.map(p => chargePowerKwAtSoc(p.soc, connector, stationMaxPowerKw)));
  const floor = Math.max(fromSoc, minRequiredSoc);
  let efficientTarget = Math.min(maxTargetSoc, floor);
  for (let soc = floor; soc <= maxTargetSoc; soc += 1) {
    const powerKw = chargePowerKwAtSoc(soc, connector, stationMaxPowerKw);
    if (powerKw < peakPowerKw * marginalRateThreshold) break;
    efficientTarget = soc;
  }
  return Math.max(Math.min(minRequiredSoc, maxTargetSoc), Math.min(maxTargetSoc, efficientTarget));
};
