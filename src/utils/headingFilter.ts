/**
 * Stable course for map camera: from position deltas only (not compass / noisy GPS heading).
 * Freezes heading when slow or nearly stationary.
 */

const MIN_SPEED_KMH = 11; // ~3 m/s — below this we keep last course
const MIN_MOVE_M = 12;
const DEAD_BAND_DEG = 4;
const SMOOTH = 0.22; // lower = smoother

export const norm360 = (a: number) => ((a % 360) + 360) % 360;

/** Shortest signed delta from → to in degrees, range (-180, 180]. */
export const headingDelta = (from: number, to: number) =>
  ((to - from + 540) % 360) - 180;

function bearingDeg(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return norm360((Math.atan2(y, x) * 180) / Math.PI);
}

function distanceM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export class HeadingFilter {
  private heading = 0;
  private hasHeading = false;
  private last: { lat: number; lon: number } | null = null;

  /** Current smoothed course in degrees [0, 360). Unchanged when parked. */
  get value(): number {
    return this.heading;
  }

  get ready(): boolean {
    return this.hasHeading;
  }

  reset() {
    this.heading = 0;
    this.hasHeading = false;
    this.last = null;
  }

  /**
   * @param speedKmH ground speed; below MIN_SPEED_KMH heading is frozen
   * @returns smoothed heading degrees
   */
  update(lat: number, lon: number, speedKmH: number | null): number {
    const speed = speedKmH ?? 0;
    if (this.last && speed >= MIN_SPEED_KMH) {
      const d = distanceM(this.last, { lat, lon });
      if (d >= MIN_MOVE_M) {
        const raw = bearingDeg(this.last, { lat, lon });
        if (!this.hasHeading) {
          this.heading = raw;
          this.hasHeading = true;
        } else {
          const dl = headingDelta(this.heading, raw);
          if (Math.abs(dl) > DEAD_BAND_DEG) {
            this.heading = norm360(this.heading + dl * SMOOTH);
          }
        }
        this.last = { lat, lon };
      }
    } else if (!this.last) {
      this.last = { lat, lon };
    }
    return this.heading;
  }
}
