import {
  readElevationProfile,
  writeElevationProfile,
  fetchOpenMeteoElevations,
  isElevationRedisConfigured,
} from '../_lib/elevation.js';

export const config = { maxDuration: 25 };

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

/**
 * Shared elevation profile cache.
 * GET  ?aLat=&aLon=&bLat=&bLon=  → redis lookup only
 * POST { aLat, aLon, bLat, bLon, coords: [[lon,lat],...] }
 *   → redis, else Open-Meteo + write redis (TTL 1 year)
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const aLat = num(req.query?.aLat);
      const aLon = num(req.query?.aLon);
      const bLat = num(req.query?.bLat);
      const bLon = num(req.query?.bLon);
      if (![aLat, aLon, bLat, bLon].every(Number.isFinite)) {
        return res.status(400).json({ error: 'aLat,aLon,bLat,bLon required' });
      }
      const cached = await readElevationProfile(aLat, aLon, bLat, bLon);
      if (!cached) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).json({
          source: null,
          redis_configured: isElevationRedisConfigured(),
          error: 'not_cached',
        });
      }
      res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).json({
        source: 'redis',
        redis_configured: true,
        coords: cached.coords,
        elevations: cached.elevations,
        savedAt: cached.savedAt,
      });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST, OPTIONS');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = parseBody(req);
    const aLat = num(body.aLat);
    const aLon = num(body.aLon);
    const bLat = num(body.bLat);
    const bLon = num(body.bLon);
    if (![aLat, aLon, bLat, bLon].every(Number.isFinite)) {
      return res.status(400).json({ error: 'aLat,aLon,bLat,bLon required' });
    }

    // 1) Shared cache hit
    const cached = await readElevationProfile(aLat, aLon, bLat, bLon);
    if (cached) {
      res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).json({
        source: 'redis',
        redis_configured: isElevationRedisConfigured(),
        coords: cached.coords,
        elevations: cached.elevations,
        savedAt: cached.savedAt,
      });
    }

    // 2) Need sampled geometry from client
    const coords = body.coords;
    if (!Array.isArray(coords) || coords.length < 2) {
      return res.status(400).json({
        error: 'coords required when not cached',
        redis_configured: isElevationRedisConfigured(),
      });
    }
    const normalized = coords
      .map((c) => {
        if (!Array.isArray(c) || c.length < 2) return null;
        const lon = Number(c[0]);
        const lat = Number(c[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
        return [lon, lat];
      })
      .filter(Boolean);
    if (normalized.length < 2) {
      return res.status(400).json({ error: 'invalid coords' });
    }

    // 3) Prefer client-provided elevations (seed cache without a second Open-Meteo call),
    // otherwise fetch once for everyone and store long-term.
    let elevations;
    if (
      Array.isArray(body.elevations) &&
      body.elevations.length === normalized.length &&
      body.elevations.every((v) => Number.isFinite(Number(v)))
    ) {
      elevations = body.elevations.map(Number);
    } else {
      elevations = await fetchOpenMeteoElevations(normalized);
    }
    const profile = { coords: normalized, elevations };
    const stored = await writeElevationProfile(aLat, aLon, bLat, bLon, profile);

    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({
      source: stored ? 'open-meteo+redis' : 'open-meteo',
      redis_configured: isElevationRedisConfigured(),
      stored,
      coords: normalized,
      elevations,
      savedAt: Date.now(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isLimit = e?.name === 'ElevationLimitError' || /429|quota/i.test(msg);
    console.error('[api/elevation/profile]', msg);
    return res.status(isLimit ? 429 : 500).json({
      error: isLimit ? 'elevation_quota' : 'elevation_failed',
      message: msg,
      redis_configured: isElevationRedisConfigured(),
    });
  }
}
