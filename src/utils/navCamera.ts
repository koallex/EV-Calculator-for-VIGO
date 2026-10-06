/**
 * Tesla-style navigation camera: course-up rotation, tilted 3D view, speed-dependent zoom.
 *
 * Everything here is pure (no DOM, no Yandex API) so it can be tested in isolation.
 * The camera is driven frame-by-frame with `duration: 0` from our own smoothed state;
 * we never rely on the map's animations, because restarting an animation on every GPS
 * sample (and interpolating across the ±π wrap) is what made the map spin.
 */

const DEG = Math.PI / 180;

/** Yandex JS API v3 accepts tilt in 0…50°. */
export const MAX_TILT_DEG = 50;
export const NAV_TILT_DEG = 45;

export const norm360 = (a: number) => ((a % 360) + 360) % 360;

/** Shortest signed difference to − from, in (-180, 180]. */
export const angleDelta = (from: number, to: number) => ((((to - from) % 360) + 540) % 360) - 180;

/** Wrap radians into [-π, π] — the only range the map accepts for azimuth. */
export const wrapPi = (rad: number) => {
  let r = rad % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r < -Math.PI) r += 2 * Math.PI;
  return r;
};

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ── Geometry helpers ────────────────────────────────────────────────────────────────────────

const M_PER_DEG_LAT = 111_320;

export function bearingBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const p1 = aLat * DEG;
  const p2 = bLat * DEG;
  const dl = (bLon - aLon) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return norm360(Math.atan2(y, x) / DEG);
}

/** Flat-earth distance in metres — plenty accurate at the sub-kilometre scale used here. */
export function approxDistM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * M_PER_DEG_LAT;
  const dLon = (bLon - aLon) * M_PER_DEG_LAT * Math.cos(((aLat + bLat) / 2) * DEG);
  return Math.hypot(dLat, dLon);
}

export interface RouteHeadingResult {
  /** Course of the road ahead of the vehicle, degrees. */
  heading: number;
  /** Index of the polyline vertex matched to the vehicle (feed back as `hintIdx`). */
  idx: number;
  /** Distance from the vehicle to the polyline, metres. */
  offRouteM: number;
}

/**
 * Course of the route a little way AHEAD of the vehicle.
 *
 * Two things matter for a stable camera:
 *  • the search runs only forward from the previous match (progress along a route is monotone), so an out-and-back route (or two
 *    roads running side by side) cannot snap the match to the wrong branch and flip the heading 180°;
 *  • the bearing is taken between the matched point and a point `lookAheadM` further along, which
 *    smooths over polyline vertices instead of jumping at each one.
 */
export function routeHeadingAhead(
  pts: ReadonlyArray<readonly [number, number]>,
  lat: number,
  lon: number,
  hintIdx: number | null,
  lookAheadM = 45,
  maxOffRouteM = 70,
): RouteHeadingResult | null {
  const n = pts.length;
  if (n < 2) return null;

  const from = hintIdx == null ? 0 : Math.max(0, hintIdx - 1);
  const to = hintIdx == null ? n - 1 : Math.min(n - 1, hintIdx + 120);

  let best = -1;
  let bestD = Infinity;
  for (let i = from; i <= to; i++) {
    const d = approxDistM(lat, lon, pts[i][0], pts[i][1]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  // Windowed search failed (GPS jumped / rerouted) — fall back to a full scan once.
  if (best < 0 || (hintIdx != null && bestD > maxOffRouteM)) {
    for (let i = 0; i < n; i++) {
      const d = approxDistM(lat, lon, pts[i][0], pts[i][1]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  }
  if (best < 0 || bestD > maxOffRouteM) return null;

  let j = best;
  let acc = 0;
  while (j < n - 1 && acc < lookAheadM) {
    acc += approxDistM(pts[j][0], pts[j][1], pts[j + 1][0], pts[j + 1][1]);
    j++;
  }
  if (j === best) {
    // At the very end of the route — use the last segment.
    if (best === 0) return null;
    return {
      heading: bearingBetween(pts[best - 1][0], pts[best - 1][1], pts[best][0], pts[best][1]),
      idx: best,
      offRouteM: bestD,
    };
  }
  return {
    heading: bearingBetween(pts[best][0], pts[best][1], pts[j][0], pts[j][1]),
    idx: best,
    offRouteM: bestD,
  };
}

// ── Course smoothing ─────────────────────────────────────────────────────────────────────────

export interface CourseSmootherOptions {
  /** Time constant of the exponential follow, seconds (larger = lazier). */
  tauS: number;
  /** Hard cap on how fast the map may turn, degrees per second. */
  maxRateDegS: number;
  /** Ignore target changes smaller than this (GPS jitter), degrees. */
  deadBandDeg: number;
  /** Below this ground speed the course is frozen, km/h. */
  freezeBelowKmH: number;
}

export const DEFAULT_COURSE_OPTIONS: CourseSmootherOptions = {
  tauS: 0.9,
  maxRateDegS: 38,
  deadBandDeg: 2.5,
  freezeBelowKmH: 7,
};

/**
 * Smoothed course angle, kept UNWRAPPED (it may exceed 360° or go negative).
 * Staying unwrapped removes the 359°→1° discontinuity; the wrap to [-π, π] happens only when
 * the value is handed to the map, and with `duration: 0` that jump is invisible.
 */
export class CourseSmoother {
  private value: number | null = null;
  constructor(private readonly opt: CourseSmootherOptions = DEFAULT_COURSE_OPTIONS) {}

  get current(): number | null {
    return this.value;
  }

  reset() {
    this.value = null;
  }

  step(targetDeg: number | null, dtS: number, speedKmH: number | null): number | null {
    if (targetDeg == null || !Number.isFinite(targetDeg)) return this.value;
    if (this.value == null) {
      this.value = norm360(targetDeg);
      return this.value;
    }
    if (speedKmH != null && speedKmH < this.opt.freezeBelowKmH) return this.value;

    const dt = clamp(dtS, 0.001, 0.25);
    const delta = angleDelta(this.value, targetDeg);
    if (Math.abs(delta) < this.opt.deadBandDeg) return this.value;

    const follow = 1 - Math.exp(-dt / this.opt.tauS);
    const wanted = delta * follow;
    const cap = this.opt.maxRateDegS * dt;
    this.value += clamp(wanted, -cap, cap);
    return this.value;
  }
}

// ── Zoom & camera ────────────────────────────────────────────────────────────────────────────

/**
 * Speed-dependent zoom: close in town and at a standstill, wider on the motorway.
 * Piecewise-linear through fixed points so each band can be tuned on its own.
 * At a standstill we deliberately stay a bit wider than before (16.9, was 17.4): a parking lot at zoom 17.4
 * showed individual aircraft/markings and nothing useful.
 */
const ZOOM_BY_SPEED: ReadonlyArray<readonly [number, number]> = [
  [0, 16.9],
  [30, 16.6],
  [60, 16.1],
  [90, 15.5],
  [130, 14.9],
];

export function zoomForSpeed(speedKmH: number | null): number {
  const v = clamp(speedKmH ?? 0, 0, 130);
  for (let i = 1; i < ZOOM_BY_SPEED.length; i++) {
    const [v1, z1] = ZOOM_BY_SPEED[i];
    if (v <= v1) {
      const [v0, z0] = ZOOM_BY_SPEED[i - 1];
      const t = (v - v0) / (v1 - v0);
      return Math.round((z0 + (z1 - z0) * t) * 100) / 100;
    }
  }
  return ZOOM_BY_SPEED[ZOOM_BY_SPEED.length - 1][1];
}

/** Exponential smoothing for scalar values such as zoom (frame-rate independent). */
export function smoothScalar(current: number, target: number, dtS: number, tauS: number): number {
  return current + (target - current) * (1 - Math.exp(-clamp(dtS, 0.001, 0.25) / tauS));
}

/**
 * Azimuth that puts `courseDeg` at the top of the screen.
 * `sign` comes from {@link detectAzimuthSign}: +1 if positive azimuth turns the map counter-clockwise
 * (heading h ⇒ azimuth +h), −1 if it turns clockwise.
 */
export function azimuthForCourse(courseDeg: number, sign: 1 | -1): number {
  return wrapPi(sign * courseDeg * DEG);
}

/**
 * Where north points on screen after the map has been rotated by a probe azimuth of +90°.
 * Screen coordinates: x to the right, y down. At azimuth 0 north is straight up (0, −1).
 *
 *  • north now points LEFT  (dx < 0) ⇒ positive azimuth rotates the map counter-clockwise ⇒ sign +1
 *  • north now points RIGHT (dx > 0) ⇒ positive azimuth rotates the map clockwise          ⇒ sign −1
 */
export function azimuthSignFromNorthVector(dx: number, dy: number): 1 | -1 | 0 {
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 4) return 0; // too small to trust
  // After a ±90° probe north must be (almost) horizontal; anything else means the measurement is bad.
  if (Math.abs(dx) < Math.abs(dy) * 2) return 0;
  return dx < 0 ? 1 : -1;
}

export interface CameraFrame {
  center: { lat: number; lon: number };
  zoom: number;
  /** radians, −π…π */
  azimuth: number;
  /** radians, 0…50° */
  tilt: number;
}

export function tiltRad(deg = NAV_TILT_DEG) {
  return clamp(deg, 0, MAX_TILT_DEG) * DEG;
}
