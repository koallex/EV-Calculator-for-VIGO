// Charging-station lookup from OpenStreetMap, via the public Overpass API — no key, no
// per-request quota tied to an account. Data is tagged `amenity=charging_station` (the same
// tag MapComplete's "Charging stations" theme reads: https://mapcomplete.org/charging_stations),
// licensed ODbL: free to store and reuse locally as long as OpenStreetMap is credited, which
// the map attribution already does (see mapTiles.ts).
//
// Explicitly NOT sourced by scraping Yandex/Google Maps search results — that's against those
// services' terms even for just extracting names+addresses, and the terms of service violation
// risk isn't worth it for data that's available legitimately here anyway.

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
  /** True when OSM marks the station as a charging point but does not specify connector type. */
  connectorTypeUnknown: boolean;
  /** Rated output per connector type, in kW, when OSM has it tagged. */
  type2PowerKw?: number;
  ccs2PowerKw?: number;
  /** Nearest distance from the station to the route polyline, km — used to filter to "along the route". */
  distanceFromRouteKm: number;
  /** distanceFromStartKm of the nearest route point — where along A→B this station sits. */
  distanceAlongRouteKm: number;
}

export interface RouteRefPoint { lat: number; lon: number; distanceFromStartKm: number; }

// kumi.systems mirrors the same Overpass dataset; used as a fallback if the main instance is
// rate-limiting or briefly down, same pattern as most Overpass-consuming apps use.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// Stations get added/removed far more often than terrain elevation does, so this cache is
// deliberately shorter-lived than the 30-day elevation cache in routeElevation.ts.
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CACHE_PREFIX = 'vigo_charging_stations_v3_';

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

// Keep only a small number of route points for each Overpass request. The query itself is
// split into route chunks, so we do not need one huge `around:` expression for the whole trip.
const sampleRouteForQuery = (points: RouteRefPoint[], stepKm = 10): RouteRefPoint[] => {
  if (!points.length) return [];
  const sampled: RouteRefPoint[] = [points[0]];
  let last = points[0].distanceFromStartKm;
  for (const p of points) {
    if (p.distanceFromStartKm - last >= stepKm) { sampled.push(p); last = p.distanceFromStartKm; }
  }
  const lastPoint = points[points.length - 1];
  if (sampled[sampled.length - 1] !== lastPoint) sampled.push(lastPoint);
  return sampled;
};

const routeChunks = (points: RouteRefPoint[], chunkKm = 120): RouteRefPoint[][] => {
  if (!points.length) return [];
  const chunks: RouteRefPoint[][] = [];
  let current: RouteRefPoint[] = [points[0]];
  let chunkStart = points[0].distanceFromStartKm;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    current.push(p);
    if (p.distanceFromStartKm - chunkStart >= chunkKm) {
      chunks.push(current);
      // Overlap the boundary point so a station close to a chunk edge is never missed.
      current = [p];
      chunkStart = p.distanceFromStartKm;
    }
  }
  if (current.length >= 1) chunks.push(current);
  return chunks;
};

const bboxForChunk = (chunk: RouteRefPoint[], bufferKm: number) => {
  const lats = chunk.map(p => p.lat);
  const lons = chunk.map(p => p.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const midLat = (minLat + maxLat) / 2;
  const latPad = bufferKm / 111.32;
  const lonPad = bufferKm / (111.32 * Math.max(0.2, Math.cos(midLat * Math.PI / 180)));
  return { minLat: minLat - latPad, maxLat: maxLat + latPad, minLon: minLon - lonPad, maxLon: maxLon + lonPad };
};

const distanceToRouteKm = (lat: number, lon: number, points: RouteRefPoint[]) => {
  if (points.length === 1) {
    return { distanceKm: haversineKm(lat, lon, points[0].lat, points[0].lon), distanceAlongRouteKm: points[0].distanceFromStartKm };
  }

  // Find the closest point on the actual route polyline, not merely the closest
  // sampled point. This is important because Overpass search boxes are deliberately
  // sampled coarsely for speed (10 km), while a station may sit between two samples.
  // Use a local equirectangular projection for each segment; the segments are short
  // enough that the approximation is more than adequate for a 3 km route buffer.
  const latRad = lat * Math.PI / 180;
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.max(0.2, Math.cos(latRad));
  let bestDistance = Infinity;
  let bestAlong = points[0].distanceFromStartKm;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const ax = (a.lon - lon) * kmPerDegLon;
    const ay = (a.lat - lat) * kmPerDegLat;
    const bx = (b.lon - lon) * kmPerDegLon;
    const by = (b.lat - lat) * kmPerDegLat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx;
    const py = ay + t * dy;
    const distance = Math.hypot(px, py);

    if (distance < bestDistance) {
      bestDistance = distance;
      const segmentLengthKm = haversineKm(a.lat, a.lon, b.lat, b.lon);
      bestAlong = a.distanceFromStartKm + segmentLengthKm * t;
    }
  }

  return { distanceKm: bestDistance, distanceAlongRouteKm: bestAlong };
};

const stationFromElement = (el: any, points: RouteRefPoint[], bufferKm: number): ChargingStation | null => {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const nearest = distanceToRouteKm(lat, lon, points);
  if (nearest.distanceKm > bufferKm) return null;

  return {
    id: `${el.type}/${el.id}`,
    lat, lon,
    name: tags.name || tags.operator || 'Зарядная станция',
    address: buildAddress(tags),
    operator: tags.operator,
    access: tags.access,
    fee: tags.fee,
    hasType2: !!(tags['socket:type2'] || tags['socket:type2:output'] || tags['socket:type2_c'] || tags['socket:type2_c:output']),
    hasCcs2: !!(tags['socket:type2_combo'] || tags['socket:type2_combo:output'] || tags['socket:ccs2'] || tags['socket:ccs2:output'] || tags['socket:ccs'] || tags['socket:ccs:output'] || tags['socket:ccs_combo'] || tags['socket:ccs_combo:output'] || tags['socket:combo-2'] || tags['socket:combo-2:output'] || tags['socket:combo2'] || tags['socket:combo2:output']),
    connectorTypeUnknown: !(tags['socket:type2'] || tags['socket:type2:output'] || tags['socket:type2_c'] || tags['socket:type2_c:output'] || tags['socket:type2_combo'] || tags['socket:type2_combo:output'] || tags['socket:ccs2'] || tags['socket:ccs2:output'] || tags['socket:ccs'] || tags['socket:ccs:output'] || tags['socket:ccs_combo'] || tags['socket:ccs_combo:output'] || tags['socket:combo-2'] || tags['socket:combo-2:output'] || tags['socket:combo2'] || tags['socket:combo2:output'] || tags['socket:chademo'] || tags['socket:chademo:output'] || tags['socket:tesla_supercharger'] || tags['socket:tesla_destination']),
    type2PowerKw: parsePowerKw(tags['socket:type2:output'] || tags['socket:type2_c:output']),
    ccs2PowerKw: parsePowerKw(tags['socket:type2_combo:output'] || tags['socket:ccs2:output'] || tags['socket:ccs:output'] || tags['socket:ccs_combo:output'] || tags['socket:combo-2:output'] || tags['socket:combo2:output']),
    distanceFromRouteKm: Number(nearest.distanceKm.toFixed(2)),
    distanceAlongRouteKm: nearest.distanceAlongRouteKm,
  };
};

const cacheKeyForRoute = (points: RouteRefPoint[]): string => {
  const a = points[0], b = points[points.length - 1];
  return `${CACHE_PREFIX}${a.lat.toFixed(2)}_${a.lon.toFixed(2)}_${b.lat.toFixed(2)}_${b.lon.toFixed(2)}_${Math.round(b.distanceFromStartKm)}`;
};

/** Dongfeng Vigo charges via CCS Type 2 (DC fast) or plain Type 2 (AC) — this filters out
 *  stations offering neither (CHAdeMO-only lots, Tesla-proprietary connectors, etc.). */
export const stationSupportsVigo = (s: ChargingStation) => {
  // OSM coverage is incomplete: many real stations are mapped as charging_station
  // but have no socket:* tag at all. Do not throw those stations away.
  // Explicitly incompatible-only stations are still excluded.
  return s.hasType2 || s.hasCcs2 || s.connectorTypeUnknown;
};

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
      if (parsed.expiresAt > Date.now() && Array.isArray(parsed.stations)) return parsed.stations as ChargingStation[];
    }
  } catch { /* ignore cache */ }

  const sampled = sampleRouteForQuery(points, 10);
  const chunks = routeChunks(sampled, 120);
  const results = new Map<string, ChargingStation>();
  let successfulRequests = 0;
  let lastError: unknown = null;

  // Three concurrent requests is enough to make long routes fast without hammering public
  // Overpass instances. Each chunk has its own timeout and fallback endpoint.
  const workerCount = Math.min(3, chunks.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= chunks.length) return;
      const chunk = chunks[index];
      const bbox = bboxForChunk(chunk, bufferKm);
      const south = bbox.minLat.toFixed(5);
      const west = bbox.minLon.toFixed(5);
      const north = bbox.maxLat.toFixed(5);
      const east = bbox.maxLon.toFixed(5);
      const query = `[out:json][timeout:12];(nwr["amenity"="charging_station"](${south},${west},${north},${east});nwr["man_made"="charge_point"](${south},${west},${north},${east});nwr["amenity"="fuel"]["fuel:electricity"="yes"](${south},${west},${north},${east}););out center tags;`;

      for (const endpoint of OVERPASS_ENDPOINTS) {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 14000);
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `data=${encodeURIComponent(query)}`,
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(`Overpass ${res.status}`);
          const data = await res.json();
          successfulRequests++;
          for (const el of data.elements || []) {
            const station = stationFromElement(el, points, bufferKm);
            if (station) results.set(station.id, station);
          }
          break;
        } catch (e) {
          lastError = e;
        } finally {
          window.clearTimeout(timeout);
        }
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (!successfulRequests && chunks.length) {
    throw new Error(`Не удалось получить данные о зарядках: ${String(lastError)}`);
  }

  const stations = Array.from(results.values()).sort((a, b) => a.distanceAlongRouteKm - b.distanceAlongRouteKm);
  try {
    localStorage.setItem(cacheKey, JSON.stringify({ expiresAt: Date.now() + CACHE_TTL_MS, stations }));
  } catch { /* ignore cache errors */ }
  return stations;
}

