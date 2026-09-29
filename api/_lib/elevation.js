import { Redis } from '@upstash/redis';

const ELEVATION_KEY_PREFIX = 'vigo:elevation:v1:';
/** Terrain does not change — keep profiles for a long time so the shared pool grows. */
export const ELEVATION_REDIS_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year
const ELEVATION_BATCH_SIZE = 100;

let redis = null;
function getRedis() {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

export function isElevationRedisConfigured() {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

export function roundCoord(n) {
  return Number(n).toFixed(3);
}

export function elevationCacheKey(aLat, aLon, bLat, bLon) {
  return `${ELEVATION_KEY_PREFIX}${roundCoord(aLat)},${roundCoord(aLon)}-${roundCoord(bLat)},${roundCoord(bLon)}`;
}

/**
 * @returns {Promise<{ coords: [number, number][], elevations: number[], savedAt: number, source: string } | null>}
 */
export async function readElevationProfile(aLat, aLon, bLat, bLon) {
  const client = getRedis();
  if (!client) return null;
  const key = elevationCacheKey(aLat, aLon, bLat, bLon);
  try {
    const raw = await client.get(key);
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (
      !parsed ||
      !Array.isArray(parsed.coords) ||
      !Array.isArray(parsed.elevations) ||
      parsed.coords.length !== parsed.elevations.length ||
      parsed.coords.length < 2
    ) {
      return null;
    }
    return {
      coords: parsed.coords,
      elevations: parsed.elevations,
      savedAt: Number(parsed.savedAt) || Date.now(),
      source: 'redis',
    };
  } catch (e) {
    console.warn('[elevation] redis read failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * @param {{ coords: [number, number][], elevations: number[] }} profile
 */
export async function writeElevationProfile(aLat, aLon, bLat, bLon, profile) {
  const client = getRedis();
  if (!client) return false;
  if (!profile?.coords?.length || profile.coords.length !== profile.elevations?.length) return false;
  const key = elevationCacheKey(aLat, aLon, bLat, bLon);
  const payload = {
    coords: profile.coords,
    elevations: profile.elevations,
    savedAt: Date.now(),
  };
  try {
    await client.set(key, JSON.stringify(payload), { ex: ELEVATION_REDIS_TTL_SECONDS });
    return true;
  } catch (e) {
    console.warn('[elevation] redis write failed:', e instanceof Error ? e.message : e);
    return false;
  }
}

async function elevationBatch(batch) {
  // batch items: [lon, lat]
  const lats = batch.map((c) => c[1]).join(',');
  const lons = batch.map((c) => c[0]).join(',');
  const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 429) {
    const err = new Error('Elevation API quota exceeded (429)');
    err.name = 'ElevationLimitError';
    throw err;
  }
  if (!res.ok) throw new Error(`Elevation API ${res.status}`);
  const data = await res.json();
  const values = data?.elevation;
  if (!Array.isArray(values) || values.length !== batch.length) {
    throw new Error('Elevation API returned unexpected payload');
  }
  if (values.some((v) => !Number.isFinite(Number(v)))) {
    throw new Error('Elevation API returned non-numeric values');
  }
  return values.map(Number);
}

/**
 * Fetch elevations for sampled route points from Open-Meteo (server-side).
 * @param {[number, number][]} coords [lon, lat][]
 */
export async function fetchOpenMeteoElevations(coords) {
  if (!Array.isArray(coords) || coords.length < 2) {
    throw new Error('Need at least 2 coordinates');
  }
  if (coords.length > 250) {
    throw new Error('Too many elevation points (max 250)');
  }
  const elevations = [];
  for (let i = 0; i < coords.length; i += ELEVATION_BATCH_SIZE) {
    const batch = coords.slice(i, i + ELEVATION_BATCH_SIZE);
    elevations.push(...(await elevationBatch(batch)));
    if (i + ELEVATION_BATCH_SIZE < coords.length) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  return elevations;
}
