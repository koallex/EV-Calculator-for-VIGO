// Bridges a Calculator route forecast (pre-trip) to the next matching HUD trip saved to
// history, so predicted vs actual can be compared after the fact. Deliberately lightweight —
// a single localStorage slot, not a queue. Only the most recently calculated route is kept as
// "pending", and it is consumed (cleared) the first time a plausibly matching trip is saved,
// so a stale forecast never silently attaches to a later, unrelated trip.

const STORAGE_KEY = 'vigo_pending_route_forecast';

// A forecast only counts as "for" a trip if driving started reasonably soon after the
// calculation and covers roughly the same distance.
const MAX_FORECAST_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours
const DISTANCE_MATCH_TOLERANCE = 0.25; // ±25%

export interface PendingRouteForecast {
  savedAt: number;
  distanceKm: number;
  plannedSpeedKmH: number;
  plannedMaxSpeedKmH: number;
  arrivalSoc: number;
  consumptionPer100Km: number;
  energyKwh: number;
  speedProfile: Array<{ distanceKm: number; speedKmH: number }>;
}

export function saveLastRouteForecast(forecast: Omit<PendingRouteForecast, 'savedAt'>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...forecast, savedAt: Date.now() }));
  } catch {
    // localStorage unavailable (private mode, quota, etc.) — this is a nice-to-have diagnostic,
    // never worth failing or blocking the route calculation over.
  }
}

// Returns the pending forecast if it plausibly matches this trip's distance/timing, and clears
// the stored forecast regardless of the outcome (a forecast is "used up" by the first trip saved
// after it, matching or not).
export function consumeMatchingRouteForecast(actualDistanceKm: number): PendingRouteForecast | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    localStorage.removeItem(STORAGE_KEY);

    const forecast: PendingRouteForecast = JSON.parse(raw);
    const age = Date.now() - forecast.savedAt;
    if (!Number.isFinite(age) || age < 0 || age > MAX_FORECAST_AGE_MS) return null;

    const distanceRatio = Math.abs(actualDistanceKm - forecast.distanceKm) / Math.max(1, forecast.distanceKm);
    if (distanceRatio > DISTANCE_MATCH_TOLERANCE) return null;

    return forecast;
  } catch {
    return null;
  }
}
