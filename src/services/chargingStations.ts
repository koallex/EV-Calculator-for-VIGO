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
const CACHE_PREFIX = 'vigo_charging_stations_';

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

// Thins the route down to one point roughly every `stepKm` before building the Overpass
// `around:` filter — querying every raw route point (there can be hundreds) would make the
// request URL/body unnecessarily huge without meaningfully changing which stations are found.
const sampleRouteForQuery = (points: RouteRefPoint[], stepKm = 8): RouteRefPoint[] => {
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

const cacheKeyForRoute = (points: RouteRefPoint[]): string => {
  const a = points[0], b = points[points.length - 1];
  return `${CACHE_PREFIX}${a.lat.toFixed(2)}_${a.lon.toFixed(2)}_${b.lat.toFixed(2)}_${b.lon.toFixed(2)}_${Math.round(b.distanceFromStartKm)}`;
};

/** Dongfeng Vigo charges via CCS Type 2 (DC fast) or plain Type 2 (AC) — this filters out
 *  stations offering neither (CHAdeMO-only lots, Tesla-proprietary connectors, etc.). */
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
      if (parsed.expiresAt > Date.now() && Array.isArray(parsed.stations)) return parsed.stations as ChargingStation[];
    }
  } catch { /* corrupt/unavailable cache entry — just refetch */ }

  const sampled = sampleRouteForQuery(points, 8);

  // Overpass `around:` accepts exactly one center point: (around:radius,lat,lon).
  // The previous implementation tried to put many centers into one `around:` clause,
  // which makes Overpass reject the query. Build a valid union of small circles instead.
  const radiusM = Math.round(bufferKm * 1000);
  const clauses = sampled.flatMap(p => [
    `node["amenity"="charging_station"](around:${radiusM},${p.lat.toFixed(5)},${p.lon.toFixed(5)});`,
    `way["amenity"="charging_station"](around:${radiusM},${p.lat.toFixed(5)},${p.lon.toFixed(5)});`,
    `node["man_made"="charge_point"](around:${radiusM},${p.lat.toFixed(5)},${p.lon.toFixed(5)});`,
  ]);

  // Keep the request reasonably small. One query per route is still much cheaper than
  // querying every raw GPS/OSRM point, while every `around:` expression remains valid.
  const query = `[out:json][timeout:25];(${clauses.join('')});out center tags;`;

  let data: any = null;
  let lastError: unknown = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Overpass ${res.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
      }
      data = await res.json();
      break;
    } catch (e) { lastError = e; }
  }
  if (!data) throw new Error(`Не удалось получить данные о зарядках: ${String(lastError)}`);

  const stations: ChargingStation[] = (data.elements || [])
    .map((el: any) => {
      const tags = el.tags || {};
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      let nearestDistAlong = 0;
      let nearestDist = Infinity;
      for (const p of points) {
        const d = haversineKm(lat, lon, p.lat, p.lon);
        if (d < nearestDist) { nearestDist = d; nearestDistAlong = p.distanceFromStartKm; }
      }
      const station: ChargingStation = {
        id: `${el.type}/${el.id}`,
        lat, lon,
        name: tags.name || tags.operator || 'Зарядная станция',
        address: buildAddress(tags),
        operator: tags.operator,
        access: tags.access,
        fee: tags.fee,
        hasType2: !!(tags['socket:type2'] || tags['socket:type2:output']),
        hasCcs2: !!(tags['socket:type2_combo'] || tags['socket:type2_combo:output'] || tags['socket:ccs2'] || tags['socket:ccs']),
        type2PowerKw: parsePowerKw(tags['socket:type2:output']),
        ccs2PowerKw: parsePowerKw(tags['socket:type2_combo:output'] || tags['socket:ccs2:output'] || tags['socket:ccs:output']),
        distanceFromRouteKm: Number(nearestDist.toFixed(2)),
        distanceAlongRouteKm: nearestDistAlong,
      };
      return station;
    })
    .filter((s: ChargingStation) => Number.isFinite(s.lat) && Number.isFinite(s.lon) && s.distanceFromRouteKm <= bufferKm);

  try {
    localStorage.setItem(cacheKey, JSON.stringify({ expiresAt: Date.now() + CACHE_TTL_MS, stations }));
  } catch { /* storage full/unavailable — degrade gracefully, still return the fresh fetch */ }

  return stations;
}
