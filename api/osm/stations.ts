/**
 * Geo helpers under one Hobby-plan function slot:
 * - GET bbox → OSM Overpass charging stations (legacy)
 * - GET/POST ?resource=elevation → shared Redis elevation cache
 */
import {
  readElevationProfile,
  writeElevationProfile,
  fetchOpenMeteoElevations,
  isElevationRedisConfigured,
} from '../_lib/elevation.js';

export const config = { maxDuration: 25 };

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
];

const REQUEST_TIMEOUT_MS = 6500;

const numberParam = (value: unknown): number | undefined => {
  if (Array.isArray(value)) value = value[0];
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

const parseBody = (req: any) => {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
};

const fetchOverpass = async (endpoint: string, query: string, timeoutMs: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json',
        'User-Agent': 'EV-Calculator-for-VIGO/1.01',
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Overpass HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
};

async function handleElevation(req: any, res: any) {
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

    const coords = body.coords;
    if (!Array.isArray(coords) || coords.length < 2) {
      return res.status(400).json({
        error: 'coords required when not cached',
        redis_configured: isElevationRedisConfigured(),
      });
    }
    const normalized = coords
      .map((c: unknown) => {
        if (!Array.isArray(c) || c.length < 2) return null;
        const lon = Number(c[0]);
        const lat = Number(c[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
        return [lon, lat] as [number, number];
      })
      .filter(Boolean) as [number, number][];
    if (normalized.length < 2) {
      return res.status(400).json({ error: 'invalid coords' });
    }

    let elevations: number[];
    if (
      Array.isArray(body.elevations) &&
      body.elevations.length === normalized.length &&
      body.elevations.every((v: unknown) => Number.isFinite(Number(v)))
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
  } catch (e: any) {
    const msg = e instanceof Error ? e.message : String(e);
    const isLimit = e?.name === 'ElevationLimitError' || /429|quota/i.test(msg);
    console.error('[api/osm/stations elevation]', msg);
    return res.status(isLimit ? 429 : 500).json({
      error: isLimit ? 'elevation_quota' : 'elevation_failed',
      message: msg,
      redis_configured: isElevationRedisConfigured(),
    });
  }
}

async function handleOsmStations(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const south = numberParam(req.query.south);
  const west = numberParam(req.query.west);
  const north = numberParam(req.query.north);
  const east = numberParam(req.query.east);
  if ([south, west, north, east].some((v) => v === undefined)) {
    return res.status(400).json({ error: 'Missing or invalid bbox params (south, west, north, east required)' });
  }

  const query = `[out:json][timeout:15];nwr["amenity"="charging_station"](${south},${west},${north},${east});out center tags;`;
  const errors: string[] = [];

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const data = await fetchOverpass(endpoint, query, REQUEST_TIMEOUT_MS);
      res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=86400');
      return res.status(200).json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${new URL(endpoint).hostname}: ${message}`);
      console.error(`[osm-proxy] ${endpoint} failed:`, error);
    }
  }

  return res.status(502).json({
    error: 'OSM/Overpass unavailable',
    message: errors.join(' | '),
  });
}

export default async function handler(req: any, res: any) {
  const resource =
    (typeof req.query?.resource === 'string' && req.query.resource) ||
    (req.body && typeof req.body === 'object' && req.body.resource) ||
    '';
  const isElevation =
    resource === 'elevation' ||
    req.query?.elevation === '1' ||
    (req.body && typeof req.body === 'object' && req.body.elevation === true);

  if (isElevation) {
    return handleElevation(req, res);
  }
  return handleOsmStations(req, res);
}
