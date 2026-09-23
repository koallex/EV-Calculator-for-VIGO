// EVRACE registry loader.
//
// This module intentionally does not depend on Redis. The EVRACE proxy is a public read-only
// data source and the Redis dependency made the Vercel function fragile: an import/init failure
// in @upstash/redis could kill the whole function before our handler's try/catch ran.
//
// We keep a small per-instance cache and fetch the public registry in parallel pages. A warm
// Vercel instance reuses the registry; a cold instance rebuilds it. Partial page failures do
// not turn into a platform 500: successfully fetched pages are still returned.

const EVRACE_API = 'https://evrace.by/api/stations-page';
const PAGE_SIZE = 100;
const MAX_CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 4500;
const LIVE_FETCH_DEADLINE_MS = 8500;
const CACHE_TTL_MS = 30 * 60 * 1000;

interface CachedRegistry {
  groups: any[];
  totalGroups: number;
  fetchedAt: number;
  failedPages: number;
}

let memoryCache: CachedRegistry | null = null;
let inflight: Promise<CachedRegistry> | null = null;

const fetchPage = async (offset: number, deadline: number): Promise<{ groups: any[]; totalGroups?: number }> => {
  const remaining = deadline - Date.now();
  if (remaining <= 300) throw new Error('EVRACE fetch deadline exceeded');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remaining));
  try {
    const response = await fetch(`${EVRACE_API}?limit=${PAGE_SIZE}&offset=${offset}`, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'ru,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
        Referer: 'https://evrace.by/',
      },
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`EVRACE HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
    }
    if (!contentType.includes('json')) {
      throw new Error(`EVRACE returned non-JSON (${contentType || 'no content-type'}): ${body.slice(0, 180)}`);
    }

    const payload = JSON.parse(body);
    const groups = Array.isArray(payload?.groups)
      ? payload.groups
      : Array.isArray(payload?.stations)
        ? payload.stations
        : [];
    const total = Number(payload?.meta?.total_groups ?? payload?.total_groups ?? payload?.meta?.total);
    return { groups, totalGroups: Number.isFinite(total) ? total : undefined };
  } finally {
    clearTimeout(timer);
  }
};

const fetchAllGroupsLive = async (): Promise<CachedRegistry> => {
  const deadline = Date.now() + LIVE_FETCH_DEADLINE_MS;
  const first = await fetchPage(0, deadline);
  if (!first.groups.length) throw new Error('EVRACE returned no station groups');

  const totalGroups = Math.max(first.groups.length, first.totalGroups ?? first.groups.length);
  const offsets: number[] = [];
  for (let offset = PAGE_SIZE; offset < totalGroups; offset += PAGE_SIZE) offsets.push(offset);

  const pages: any[][] = [];
  let failedPages = 0;

  for (let i = 0; i < offsets.length; i += MAX_CONCURRENCY) {
    if (Date.now() >= deadline) {
      failedPages += offsets.length - i;
      break;
    }
    const batch = offsets.slice(i, i + MAX_CONCURRENCY);
    const results = await Promise.all(batch.map(async offset => {
      try {
        return (await fetchPage(offset, deadline)).groups;
      } catch (error) {
        failedPages++;
        console.error(`[evrace] page offset=${offset} failed:`, error);
        return [];
      }
    }));
    pages.push(...results);
  }

  const unique = new Map<string, any>();
  for (const group of [first.groups, ...pages].flat()) {
    const id = String(group?.location_id ?? group?.id ?? `${group?.latitude}:${group?.longitude}:${group?.address ?? ''}`);
    if (!unique.has(id)) unique.set(id, group);
  }

  return {
    groups: Array.from(unique.values()),
    totalGroups,
    fetchedAt: Date.now(),
    failedPages,
  };
};

const loadRegistry = async (): Promise<CachedRegistry> => {
  if (memoryCache && Date.now() - memoryCache.fetchedAt < CACHE_TTL_MS) return memoryCache;
  if (inflight) return inflight;

  inflight = fetchAllGroupsLive()
    .then(data => {
      memoryCache = data;
      return data;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
};

const groupCoordinates = (group: any): { lat: number; lon: number } | null => {
  const directLat = Number(group?.latitude ?? group?.lat);
  const directLon = Number(group?.longitude ?? group?.lng ?? group?.lon);
  if (Number.isFinite(directLat) && Number.isFinite(directLon)) return { lat: directLat, lon: directLon };

  const poles = Array.isArray(group?.poles) ? group.poles : [];
  const coords = poles.map((pole: any) => ({
    lat: Number(pole?.lat ?? pole?.latitude),
    lon: Number(pole?.lng ?? pole?.lon ?? pole?.longitude),
  })).filter((p: { lat: number; lon: number }) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (!coords.length) return null;
  return {
    lat: coords.reduce((sum: number, p: { lat: number; lon: number }) => sum + p.lat, 0) / coords.length,
    lon: coords.reduce((sum: number, p: { lat: number; lon: number }) => sum + p.lon, 0) / coords.length,
  };
};

export const getEvraceGroups = async (bbox?: {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}) => {
  const registry = await loadRegistry();
  if (!bbox) return registry.groups;
  return registry.groups.filter(group => {
    const point = groupCoordinates(group);
    return !!point
      && point.lat >= bbox.minLat && point.lat <= bbox.maxLat
      && point.lon >= bbox.minLon && point.lon <= bbox.maxLon;
  });
};

export const getEvraceStats = async () => {
  if (!memoryCache) return { cached: false, expiresAt: null, totalGroups: null, stale: null, failedPages: null };
  const age = Date.now() - memoryCache.fetchedAt;
  return {
    cached: true,
    expiresAt: memoryCache.fetchedAt + CACHE_TTL_MS,
    totalGroups: memoryCache.totalGroups,
    stale: age >= CACHE_TTL_MS,
    failedPages: memoryCache.failedPages,
    ageMs: age,
  };
};

export const forceRefreshEvraceCache = async (): Promise<CachedRegistry> => {
  const fresh = await fetchAllGroupsLive();
  memoryCache = fresh;
  return fresh;
};
