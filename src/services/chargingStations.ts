// Charging-station lookup for VIGO.
// Primary source for Belarus: EVRACE public station registry API.
// Secondary source: OpenStreetMap / Overpass for stations missing from EVRACE.
//
// EVRACE is used for address, connector and power information whenever a station
// exists in both sources. OSM remains a fallback so the app does not depend on one
// provider being complete or available.

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
  /** True when the source marks a charging station but does not specify connector type. */
  connectorTypeUnknown: boolean;
  /** Rated output per connector type, in kW, when available. */
  type2PowerKw?: number;
  ccs2PowerKw?: number;
  distanceFromRouteKm: number;
  distanceAlongRouteKm: number;
  /** Source used for this station record. */
  source?: 'evrace' | 'osm' | 'merged';
}

export interface RouteRefPoint { lat: number; lon: number; distanceFromStartKm: number; }

const EVRACE_API = '/api/evrace/stations';

// v1.07: routed through our own backend (api/osm/stations.ts) instead of calling
// overpass-api.de / overpass.kumi.systems directly from the browser. Direct browser calls hit
// two independent failure modes — CORS preflight failures on overpass-api.de, and outright
// ERR_CONNECTION_REFUSED to both mirrors on networks that block them at the DNS/firewall level.
// A server-to-server request from our backend has neither problem.
const OSM_PROXY_API = '/api/osm/stations';
const OSM_PROXY_TIMEOUT_MS = 12000;

const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CACHE_PREFIX = 'vigo_charging_stations_v7_';
const EVRACE_MATCH_DISTANCE_KM = 0.08; // 80 m: same physical location in two datasets.

const haversineKm = (aLat: number, aLon: number, bLat: number, bLon: number) => {
  const R = 6371, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
};

const parsePowerKw = (raw?: unknown): number | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const m = String(raw).replace(',', '.').match(/([\d.]+)/);
  return m ? Number(m[1]) : undefined;
};

const buildAddress = (tags: Record<string, string>): string => {
  if (tags['addr:full']) return tags['addr:full'];
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  const city = tags['addr:city'] || tags['addr:town'] || tags['addr:village'];
  return [street, city].filter(Boolean).join(', ');
};

const asFiniteNumber = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    const n = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};

const textValue = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return undefined;
};

const normalizeConnector = (value: unknown): string => {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
    .replace('type2c', 'type2');
};

// EVRACE labels the Combo2/CCS Type 2 DC gun simply as "CCS" (not "CCS2").
// OSM uses socket:type2_combo / ccs / ccs2. All of these are the same physical plug on VIGO.
const isCcs = (value: unknown) => {
  const s = normalizeConnector(value);
  return (
    s === 'ccs' ||
    s === 'ccs2' ||
    s === 'ccscombo' ||
    s === 'ccscombo2' ||
    s === 'combo' ||
    s === 'combo2' ||
    s === 'type2combo' ||
    s === 'iec62196type2combo' ||
    s.includes('ccs')
  );
};

const isType2 = (value: unknown) => {
  const s = normalizeConnector(value);
  return s === 'type2' || s === 'type2ac' || s === 'actype2';
};

const collectPoleObjects = (record: any): any[] => {
  const arrays = [record?.poles, record?.guns, record?.connectors, record?.guns_list, record?.plugs];
  const out: any[] = [];
  for (const value of arrays) if (Array.isArray(value)) out.push(...value);
  return out;
};

// EVRACE /api/stations-page returns coordinates and connector data on individual
// `poles`, while the parent `group` contains the address/location_id. Older
// normalization expected coordinates on the group itself, which made every group
// disappear during bbox filtering. Keep the group-level fallback, but derive the
// station point from its poles when needed.
const getEvraceCoordinates = (record: any): { lat: number; lon: number } | null => {
  const directLat = asFiniteNumber(
    record?.lat, record?.latitude, record?.y,
    record?.location?.lat, record?.location?.latitude,
    record?.coordinates?.lat, record?.coordinates?.latitude,
  );
  const directLon = asFiniteNumber(
    record?.lng, record?.lon, record?.longitude, record?.x,
    record?.location?.lng, record?.location?.lon, record?.location?.longitude,
    record?.coordinates?.lng, record?.coordinates?.lon, record?.coordinates?.longitude,
  );
  if (directLat !== undefined && directLon !== undefined) return { lat: directLat, lon: directLon };

  const poles = collectPoleObjects(record);
  const coords = poles.map((pole: any) => ({
    lat: asFiniteNumber(pole?.lat, pole?.latitude, pole?.y, pole?.location?.lat),
    lon: asFiniteNumber(pole?.lng, pole?.lon, pole?.longitude, pole?.x, pole?.location?.lng),
  })).filter((p): p is { lat: number; lon: number } => p.lat !== undefined && p.lon !== undefined);

  if (!coords.length) return null;
  return {
    lat: coords.reduce((sum, p) => sum + p.lat, 0) / coords.length,
    lon: coords.reduce((sum, p) => sum + p.lon, 0) / coords.length,
  };
};

const stationFromEvraceRecord = (record: any, index: number): ChargingStation | null => {
  const coordinates = getEvraceCoordinates(record);
  if (!coordinates) return null;
  const { lat, lon } = coordinates;

  const poles = collectPoleObjects(record);
  const connectorValues: unknown[] = [
    record?.gun1_type, record?.gun2_type, record?.gun3_type, record?.gun4_type,
    record?.connector, record?.connector_type,
    ...poles.flatMap((p: any) => [
      p?.type, p?.connector, p?.connector_type, p?.gun_type, p?.socket, p?.standard,
      p?.gun1_type, p?.gun2_type, p?.gun3_type, p?.gun4_type,
    ]),
  ];
  const ccsValues = connectorValues.filter(isCcs);
  const type2Values = connectorValues.filter(isType2);
  const incompatibleValues = connectorValues.map(normalizeConnector).filter(s => s === 'chademo' || s === 'gbt' || s === 'gbtac' || s === 'tesla' || s === 'teslasupercharger' || s === 'tesladestination');
  const hasCcs2 = ccsValues.length > 0;
  const hasType2 = type2Values.length > 0;

  const ccsPowers = [
    record?.ccs2_power, record?.ccs_power, record?.dc_power,
    ...poles.filter((p: any) => {
      const values = [p?.type, p?.connector, p?.connector_type, p?.gun_type, p?.standard, p?.gun1_type, p?.gun2_type, p?.gun3_type, p?.gun4_type];
      return values.some(isCcs);
    }).flatMap((p: any) => [p?.power_kw, p?.power, p?.kw, p?.dc_power]),
  ].map(parsePowerKw).filter((v): v is number => v !== undefined);
  const type2Powers = [
    record?.type2_power, record?.ac_power,
    ...poles.filter((p: any) => {
      const values = [p?.type, p?.connector, p?.connector_type, p?.gun_type, p?.standard, p?.gun1_type, p?.gun2_type, p?.gun3_type, p?.gun4_type];
      return values.some(isType2);
    }).flatMap((p: any) => [p?.power_kw, p?.power, p?.kw, p?.ac_power]),
  ].map(parsePowerKw).filter((v): v is number => v !== undefined);

  // EVRACE's public registry is Belarus-only. If a record has coordinates but no explicit
  // connector information, keep it rather than losing a real station due to incomplete data.
  const connectorTypeUnknown = !hasCcs2 && !hasType2 && incompatibleValues.length === 0;

  const id = textValue(record?.external_id, record?.id, record?.station_id, record?.location_id) || `row-${index}`;
  const city = textValue(record?.city, record?.town, record?.settlement);
  const address = textValue(
    record?.address, record?.location_address, record?.location_name,
    [city, textValue(record?.street, record?.street_name), textValue(record?.house, record?.house_number)].filter(Boolean).join(', '),
  ) || '';

  return {
    id: `evrace:${id}`,
    lat,
    lon,
    name: textValue(record?.name, record?.location, record?.location_name, record?.operator, 'Зарядная станция') || 'Зарядная станция',
    address,
    operator: textValue(record?.operator, record?.operator_name, record?.network),
    access: textValue(record?.access),
    fee: textValue(record?.fee),
    hasType2,
    hasCcs2,
    connectorTypeUnknown,
    type2PowerKw: type2Powers.length ? Math.max(...type2Powers) : parsePowerKw(record?.ac_power),
    ccs2PowerKw: ccsPowers.length ? Math.max(...ccsPowers) : parsePowerKw(record?.dc_power),
    distanceFromRouteKm: Infinity,
    distanceAlongRouteKm: 0,
    source: 'evrace',
  };
};

const extractStationRecords = (payload: any): any[] => {
  if (Array.isArray(payload)) return payload;
  const candidates = [payload?.groups, payload?.stations, payload?.items, payload?.rows, payload?.results, payload?.data, payload?.records];
  for (const candidate of candidates) if (Array.isArray(candidate)) return candidate;
  return [];
};

const extractTotal = (payload: any): number | undefined => asFiniteNumber(
  payload?.total, payload?.count, payload?.totalCount, payload?.pagination?.total,
  payload?.meta?.total, payload?.meta?.total_groups, payload?.data?.total,
);

const fetchEvraceStationsForRoute = async (points: RouteRefPoint[]): Promise<ChargingStation[]> => {
  const bbox = bboxForChunk(points, 10);
  const params = new URLSearchParams({
    minLat: bbox.minLat.toFixed(5),
    maxLat: bbox.maxLat.toFixed(5),
    minLon: bbox.minLon.toFixed(5),
    maxLon: bbox.maxLon.toFixed(5),
  });
  const res = await fetch(`${EVRACE_API}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Станции недоступны (${res.status})`);
  const payload = await res.json();
  const records = extractStationRecords(payload);
  return records
    .map((record, index) => stationFromEvraceRecord(record, index))
    .filter((s): s is ChargingStation => !!s);
};

/** Returns nearest point on the actual route polyline, not nearest sampled route point. */
const nearestPointOnRoute = (lat: number, lon: number, points: RouteRefPoint[]) => {
  if (points.length === 1) return { distanceKm: haversineKm(lat, lon, points[0].lat, points[0].lon), alongKm: points[0].distanceFromStartKm };

  let bestDistance = Infinity;
  let bestAlong = 0;
  const latScale = 111.32;
  const lonScale = 111.32 * Math.max(0.2, Math.cos(lat * Math.PI / 180));
  const px = lon * lonScale;
  const py = lat * latScale;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const ax = a.lon * lonScale, ay = a.lat * latScale;
    const bx = b.lon * lonScale, by = b.lat * latScale;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const qx = ax + dx * t, qy = ay + dy * t;
    const distance = Math.hypot(px - qx, py - qy);
    if (distance < bestDistance) {
      bestDistance = distance;
      const segmentKm = Math.max(0, b.distanceFromStartKm - a.distanceFromStartKm);
      bestAlong = a.distanceFromStartKm + segmentKm * t;
    }
  }
  return { distanceKm: bestDistance, alongKm: bestAlong };
};

const stationOnRoute = (station: ChargingStation, points: RouteRefPoint[], bufferKm: number): ChargingStation | null => {
  const nearest = nearestPointOnRoute(station.lat, station.lon, points);
  if (nearest.distanceKm > bufferKm) return null;
  return { ...station, distanceFromRouteKm: Number(nearest.distanceKm.toFixed(2)), distanceAlongRouteKm: nearest.alongKm };
};

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
      current = [p];
      chunkStart = p.distanceFromStartKm;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
};

const bboxForChunk = (chunk: RouteRefPoint[], bufferKm: number) => {
  const lats = chunk.map(p => p.lat);
  const lons = chunk.map(p => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const midLat = (minLat + maxLat) / 2;
  const latPad = bufferKm / 111.32;
  const lonPad = bufferKm / (111.32 * Math.max(0.2, Math.cos(midLat * Math.PI / 180)));
  return { minLat: minLat - latPad, maxLat: maxLat + latPad, minLon: minLon - lonPad, maxLon: maxLon + lonPad };
};

const stationFromOsmElement = (el: any): ChargingStation | null => {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const hasType2 = !!(tags['socket:type2'] || tags['socket:type2:output'] || tags['socket:type2_c'] || tags['socket:type2_c:output']);
  const hasCcs2 = !!(tags['socket:type2_combo'] || tags['socket:type2_combo:output'] || tags['socket:ccs2'] || tags['socket:ccs2:output'] || tags['socket:ccs'] || tags['socket:ccs:output'] || tags['socket:ccs_combo'] || tags['socket:ccs_combo:output'] || tags['socket:combo-2'] || tags['socket:combo-2:output'] || tags['socket:combo2'] || tags['socket:combo2:output']);
  const hasAnyConnector = hasType2 || hasCcs2 || tags['socket:chademo'] || tags['socket:chademo:output'] || tags['socket:tesla_supercharger'] || tags['socket:tesla_destination'];
  return {
    id: `osm:${el.type}/${el.id}`,
    lat, lon,
    name: tags.name || tags.operator || 'Зарядная станция',
    address: buildAddress(tags),
    operator: tags.operator,
    access: tags.access,
    fee: tags.fee,
    hasType2,
    hasCcs2,
    connectorTypeUnknown: !hasAnyConnector,
    type2PowerKw: parsePowerKw(tags['socket:type2:output'] || tags['socket:type2_c:output']),
    ccs2PowerKw: parsePowerKw(tags['socket:type2_combo:output'] || tags['socket:ccs2:output'] || tags['socket:ccs:output'] || tags['socket:ccs_combo:output'] || tags['socket:combo-2:output'] || tags['socket:combo2:output']),
    distanceFromRouteKm: Infinity,
    distanceAlongRouteKm: 0,
    source: 'osm',
  };
};

const cacheKeyForRoute = (points: RouteRefPoint[]): string => {
  const a = points[0], b = points[points.length - 1];
  return `${CACHE_PREFIX}${a.lat.toFixed(2)}_${a.lon.toFixed(2)}_${b.lat.toFixed(2)}_${b.lon.toFixed(2)}_${Math.round(b.distanceFromStartKm)}`;
};

export const stationSupportsVigo = (s: ChargingStation) => s.hasType2 || s.hasCcs2 || s.connectorTypeUnknown;

const mergeStationSources = (evrace: ChargingStation[], osm: ChargingStation[]): ChargingStation[] => {
  const merged = [...evrace];
  for (const candidate of osm) {
    const same = merged.find(existing => haversineKm(existing.lat, existing.lon, candidate.lat, candidate.lon) <= EVRACE_MATCH_DISTANCE_KM);
    if (!same) { merged.push(candidate); continue; }
    same.source = 'merged';
    same.hasCcs2 ||= candidate.hasCcs2;
    same.hasType2 ||= candidate.hasType2;
    same.connectorTypeUnknown = same.connectorTypeUnknown && candidate.connectorTypeUnknown;
    same.ccs2PowerKw = Math.max(same.ccs2PowerKw ?? 0, candidate.ccs2PowerKw ?? 0) || undefined;
    same.type2PowerKw = Math.max(same.type2PowerKw ?? 0, candidate.type2PowerKw ?? 0) || undefined;
    if (!same.address && candidate.address) same.address = candidate.address;
    if ((!same.name || same.name === 'Зарядная станция') && candidate.name) same.name = candidate.name;
    if (!same.operator && candidate.operator) same.operator = candidate.operator;
  }
  return merged;
};

const fetchOsmStationsAlongRoute = async (points: RouteRefPoint[], bufferKm: number): Promise<ChargingStation[]> => {
  const sampled = sampleRouteForQuery(points, 10);
  const chunks = routeChunks(sampled, 120);
  const results = new Map<string, ChargingStation>();
  let successfulRequests = 0;
  let lastError: unknown = null;
  const workerCount = Math.min(3, chunks.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= chunks.length) return;
      const bbox = bboxForChunk(chunks[index], bufferKm);
      const params = new URLSearchParams({
        south: bbox.minLat.toFixed(5),
        west: bbox.minLon.toFixed(5),
        north: bbox.maxLat.toFixed(5),
        east: bbox.maxLon.toFixed(5),
      });
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), OSM_PROXY_TIMEOUT_MS);
      try {
        const res = await fetch(`${OSM_PROXY_API}?${params.toString()}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
        if (!res.ok) throw new Error(`Станции недоступны (${res.status})`);
        const data = await res.json();
        successfulRequests++;
        for (const el of data.elements || []) {
          const station = stationFromOsmElement(el);
          if (!station) continue;
          const onRoute = stationOnRoute(station, points, bufferKm);
          if (onRoute) results.set(station.id, onRoute);
        }
      } catch (e) { lastError = e; }
      finally { window.clearTimeout(timeout); }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (!successfulRequests && chunks.length) throw new Error('Не удалось получить станции');
  return Array.from(results.values());
};

export async function fetchChargingStationsAlongRoute(points: RouteRefPoint[], bufferKm = 5): Promise<ChargingStation[]> {
  if (points.length < 2) return [];
  const cacheKey = cacheKeyForRoute(points);
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.expiresAt > Date.now() && Array.isArray(parsed.stations)) return parsed.stations as ChargingStation[];
    }
  } catch { /* ignore cache */ }

  // EVRACE is the fast primary source. It contains the Belarusian registry with address,
  // connector and power information. Failure here must not prevent the OSM fallback.
  let evraceStations: ChargingStation[] = [];
  try {
    const routeEvrace = await fetchEvraceStationsForRoute(points);
    evraceStations = routeEvrace
      .map(station => stationOnRoute(station, points, bufferKm))
      .filter((s): s is ChargingStation => !!s);
  } catch (e) {
    // EVRACE unavailable; OSM remains available. Logged (not surfaced to the user) so this is
    // debuggable from the browser console instead of silently producing an empty result.
    console.error('[chargingStations] EVRACE fetch failed:', e);
  }

  let osmStations: ChargingStation[] = [];
  try {
    osmStations = await fetchOsmStationsAlongRoute(points, bufferKm);
  } catch (e) {
    // If EVRACE already gave us stations, a temporary Overpass failure should not turn the
    // whole feature into an error. Only throw when both sources failed below.
    console.error('[chargingStations] OSM/Overpass fetch failed:', e);
  }

  if (!evraceStations.length && !osmStations.length) {
    // Preserve the old behavior of surfacing a real provider failure to the UI only when
    // neither source could provide anything.
    throw new Error('Не удалось получить данные о зарядных станциях');
  }

  const stations = mergeStationSources(evraceStations, osmStations)
    .filter(stationSupportsVigo)
    .sort((a, b) => a.distanceAlongRouteKm - b.distanceAlongRouteKm);

  try { localStorage.setItem(cacheKey, JSON.stringify({ expiresAt: Date.now() + CACHE_TTL_MS, stations })); } catch { /* ignore cache */ }
  return stations;
}
