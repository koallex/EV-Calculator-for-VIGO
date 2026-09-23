const EVRACE_API = 'https://evrace.by/api/stations-page';

const PAGE_SIZE = 20;
const MAX_CONCURRENCY = 12;
const REQUEST_TIMEOUT_MS = 4500;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let cache: { expiresAt: number; groups: any[]; totalGroups: number } | null = null;
let loading: Promise<any[]> | null = null;

const fetchPage = async (offset: number): Promise<{ groups: any[]; totalGroups?: number }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${EVRACE_API}?limit=${PAGE_SIZE}&offset=${offset}`, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'ru,en;q=0.8',
        'User-Agent': 'VIGO-EV-Calculator/1.0',
        Referer: 'https://evrace.by/',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`EVRACE ${response.status}`);
    const payload = await response.json();
    const groups = Array.isArray(payload?.groups) ? payload.groups : [];
    const totalGroups = Number(payload?.meta?.total_groups ?? payload?.total_groups);
    return {
      groups,
      totalGroups: Number.isFinite(totalGroups) ? totalGroups : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
};

const loadAllGroups = async (): Promise<any[]> => {
  if (cache && cache.expiresAt > Date.now()) return cache.groups;
  if (loading) return loading;

  loading = (async () => {
    const first = await fetchPage(0);
    const totalGroups = first.totalGroups ?? first.groups.length;
    if (!first.groups.length) throw new Error('EVRACE returned no station groups');

    const offsets: number[] = [];
    for (let offset = PAGE_SIZE; offset < totalGroups; offset += PAGE_SIZE) offsets.push(offset);

    const pages: any[][] = [];
    for (let i = 0; i < offsets.length; i += MAX_CONCURRENCY) {
      const batch = offsets.slice(i, i + MAX_CONCURRENCY);
      const result = await Promise.all(batch.map(async offset => {
        try {
          return (await fetchPage(offset)).groups;
        } catch {
          return [];
        }
      }));
      pages.push(...result);
    }

    const groups = [first.groups, ...pages].flat();
    const unique = new Map<string, any>();
    for (const group of groups) {
      const id = String(group?.location_id ?? `${group?.latitude}:${group?.longitude}:${group?.address ?? ''}`);
      if (!unique.has(id)) unique.set(id, group);
    }

    const result = Array.from(unique.values());
    cache = { expiresAt: Date.now() + CACHE_TTL_MS, groups: result, totalGroups };
    return result;
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
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
    lat: coords.reduce((sum: number, p: { lat: number }) => sum + p.lat, 0) / coords.length,
    lon: coords.reduce((sum: number, p: { lon: number }) => sum + p.lon, 0) / coords.length,
  };
};

export const getEvraceGroups = async (bbox?: {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}) => {
  const groups = await loadAllGroups();
  if (!bbox) return groups;
  return groups.filter(group => {
    const point = groupCoordinates(group);
    return !!point
      && point.lat >= bbox.minLat && point.lat <= bbox.maxLat
      && point.lon >= bbox.minLon && point.lon <= bbox.maxLon;
  });
};

export const getEvraceStats = () => ({
  cached: !!cache && cache.expiresAt > Date.now(),
  expiresAt: cache?.expiresAt ?? null,
  totalGroups: cache?.totalGroups ?? null,
});
