// Charging-station lookup from OpenStreetMap, via the public Overpass API — no key, no
// per-request quota tied to an account. Data is tagged `amenity=charging_station` (the same
// tag MapComplete's "Charging stations" theme reads: https://mapcomplete.org/charging_stations),
// licensed ODbL: free to store and reuse locally as long as OpenStreetMap is credited.
//
// The route search is intentionally split into small distance windows. A single Overpass query
// containing dozens of `around:` clauses becomes very expensive on long routes and can make the
// UI wait for a timeout before falling back. We therefore query independent route chunks with a
// small concurrency limit and a short client-side timeout.

export interface ChargingStation {
  id: string;
  lat: number;
  lon: number;
  name: string;
  address: string;
  operator?: string;
  access?: string;
  fee?: string;
  hasType2: boolean;
  hasCcs2: boolean;
  /** Rated output per connector type, in kW, when OSM has it tagged. */
  type2PowerKw?: number;
  ccs2PowerKw?: number;
  /** Nearest distance from the station to the route polyline, km — used to filter to "along the route". */
  distanceFromRouteKm: number;
  /** distanceFromStartKm of the nearest route point — where along A→B this station sits. */
  distanceAlongRouteKm: number;
}

export interface RouteRefPoint { lat: number; lon: number; distanceFromStartKm: number; }

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CACHE_PREFIX = 'vigo_charging_stations_';

// Keep each request small enough for public Overpass instances to answer quickly.
const QUERY_CHUNK_KM = 100;
const QUERY_SAMPLE_KM = 8;
const QUERY_TIMEOUT_MS = 12000;
const MAX_CONCURRENT_QUERIES = 3;

const haversineKm = (aLat: number, aLon: number, bLat: number, bLon: number) => {
  const R = 6371, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
};

const parsePowerKw = (raw?: string): number | undefined => {
  if (!raw) return undefined;
  const m = raw.match(/([\d.]+)/);
  return m ? Number(m[1]) : undefined;
};

const buildAddress = (tags: Record<string, string>): string => {
  if (tags['addr:full']) return tags['addr:full'];
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  const city = tags['addr:city'] || tags['addr:town'] || tags['addr:village'];
  return [street, city].filter(Boolean).join(', ');
};

const sampleRouteForQuery = (points: RouteRefPoint[], stepKm = QUERY_SAMPLE_KM): RouteRefPoint[] => {
  if (!points.length) return [];
  const sampled: RouteRefPoint[] = [points[0]];
  let last = points[0].distanceFromStartKm;
  for (const p of points) {
    if (p.distanceFromStartKm - last >= stepKm) {
      sampled.push(p);
      last = p.distanceFromStartKm;
    }
  }
  const lastPoint = points[points.length - 1];
  if (sampled[sampled.length - 1] !== lastPoint) sampled.push(lastPoint);
  return sampled;
};

const cacheKeyForRoute = (points: RouteRefPoint[]): string => {
  const a = points[0], b = points[points.length - 1];
  return `${CACHE_PREFIX}${a.lat.toFixed(2)}_${a.lon.toFixed(2)}_${b.lat.toFixed(2)}_${b.lon.toFixed(2)}_${Math.round(b.distanceFromStartKm)}`;
};

const buildQuery = (sampled: RouteRefPoint[], bufferKm: number): string => {
  // Overpass `around:` accepts ONE center point per filter. The previous implementation
  // concatenated all route points into one `around:` expression, which produces an invalid
  // Overpass query and is why the client always fell through to the error state.
  // Keep the route chunked and make a small union of valid filters instead.
  const radiusM = Math.round(bufferKm * 1000);
  const filters = sampled.flatMap(p => {
    const point = `${radiusM},${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
    return [
      `nwr["amenity"="charging_station"](around:${point});`,
      `nwr["man_made"="charge_point"](around:${point});`,
    ];
  }).join('');

  return `[out:json][timeout:10];(${filters});out center tags;`;
};

const splitRouteIntoChunks = (points: RouteRefPoint[], chunkKm = QUERY_CHUNK_KM): RouteRefPoint[][] => {
  if (points.length < 2) return [];

  const chunks: RouteRefPoint[][] = [];
  let current: RouteRefPoint[] = [points[0]];
  let chunkStartKm = points[0].distanceFromStartKm;

  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    current.push(p);

    if (p.distanceFromStartKm - chunkStartKm >= chunkKm) {
      chunks.push(current);
      // Repeat the boundary point in the next chunk. This prevents a station close to a
      // 100-km boundary from being missed just because it fell into the next query window.
      current = [p];
      chunkStartKm = p.distanceFromStartKm;
    }
  }

  if (current.length >= 2) chunks.push(current);
  return chunks;
};

const fetchJsonWithTimeout = async (endpoint: string, query: string): Promise<any> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

const fetchChunk = async (chunk: RouteRefPoint[], bufferKm: number): Promise<any> => {
  const sampled = sampleRouteForQuery(chunk, QUERY_SAMPLE_KM);
  const query = buildQuery(sampled, bufferKm);
  let lastError: unknown = null;

  // Try the second public instance only when this particular chunk fails.
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      return await fetchJsonWithTimeout(endpoint, query);
    } catch (e) {
      lastError = e;
    }
  }

  throw new Error(`Не удалось получить данные о зарядках для участка маршрута: ${String(lastError)}`);
};

const runWithConcurrency = async <T>(
  items: T[],
  worker: (item: T) => Promise<any>,
  concurrency: number,
): Promise<{ values: any[]; errors: unknown[] }> => {
  const values: any[] = [];
  const errors: unknown[] = [];
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;

      try {
        values[index] = await worker(items[index]);
      } catch (e) {
        errors[index] = e;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()),
  );

  return { values, errors };
};

const parseStations = (
  dataSets: any[],
  points: RouteRefPoint[],
  bufferKm: number,
): ChargingStation[] => {
  const seen = new Set<string>();
  const stations: ChargingStation[] = [];

  for (const data of dataSets) {
    for (const el of data?.elements || []) {
      const id = `${el.type}/${el.id}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const tags = el.tags || {};
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      let nearestDistAlong = 0;
      let nearestDist = Infinity;
      for (const p of points) {
        const d = haversineKm(lat, lon, p.lat, p.lon);
        if (d < nearestDist) {
          nearestDist = d;
          nearestDistAlong = p.distanceFromStartKm;
        }
      }

      const station: ChargingStation = {
        id,
        lat,
        lon,
        name: tags.name || tags.operator || 'Зарядная станция',
        address: buildAddress(tags),
        operator: tags.operator,
        access: tags.access,
        fee: tags.fee,
        hasType2: !!(tags['socket:type2'] || tags['socket:type2:output']),
        hasCcs2: !!(
          tags['socket:type2_combo'] ||
          tags['socket:type2_combo:output'] ||
          tags['socket:ccs2'] ||
          tags['socket:ccs']
        ),
        type2PowerKw: parsePowerKw(tags['socket:type2:output']),
        ccs2PowerKw: parsePowerKw(
          tags['socket:type2_combo:output'] ||
          tags['socket:ccs2:output'] ||
          tags['socket:ccs:output'],
        ),
        distanceFromRouteKm: Number(nearestDist.toFixed(2)),
        distanceAlongRouteKm: nearestDistAlong,
      };

      if (station.distanceFromRouteKm <= bufferKm) stations.push(station);
    }
  }

  return stations;
};

/** Dongfeng Vigo charges via CCS Type 2 (DC fast) or plain Type 2 (AC). */
export const stationSupportsVigo = (s: ChargingStation) => s.hasType2 || s.hasCcs2;

export async function fetchChargingStationsAlongRoute(
  points: RouteRefPoint[],
  bufferKm = 3,
): Promise<ChargingStation[]> {
  if (points.length < 2) return [];

  const cacheKey = cacheKeyForRoute(points);
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.expiresAt > Date.now() && Array.isArray(parsed.stations)) {
        return parsed.stations as ChargingStation[];
      }
    }
  } catch { /* corrupt/unavailable cache entry — just refetch */ }

  const chunks = splitRouteIntoChunks(points);
  const { values, errors } = await runWithConcurrency(
    chunks,
    chunk => fetchChunk(chunk, bufferKm),
    MAX_CONCURRENT_QUERIES,
  );

  const successfulData = values.filter(Boolean);
  // A real empty result is different from an API failure. Only report an error to the caller
  // when every chunk failed, so the UI cannot turn a transient Overpass outage into
  // "charging stations not found".
  if (!successfulData.length && errors.length) {
    throw new Error('Не удалось получить данные о зарядных станциях: Overpass API недоступен.');
  }

  const stations = parseStations(successfulData, points, bufferKm);

  try {
    localStorage.setItem(cacheKey, JSON.stringify({
      expiresAt: Date.now() + CACHE_TTL_MS,
      stations,
    }));
  } catch { /* storage full/unavailable — degrade gracefully */ }

  return stations;
}
