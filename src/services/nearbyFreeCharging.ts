// Nearest free CCS chargers for VIGO using EVRace live operator feeds.
import { stationSupportsVigo, type ChargingStation } from './chargingStations';

const LIVE_OPERATORS = ['forevo', 'malanka', 'zaryadka', 'batteryfly', 'evika'] as const;
type LiveOperator = (typeof LIVE_OPERATORS)[number];

export interface FreeChargerResult {
  station: ChargingStation;
  distanceKm: number;
  freeCcs: number;
  totalCcs: number;
  operator: string;
  updatedAt?: string | null;
  connectors: { label: string; status: string }[];
}

const haversineKm = (aLat: number, aLon: number, bLat: number, bLon: number) => {
  const R = 6371;
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r;
  const dLon = (bLon - aLon) * r;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
};

const isCcsLabel = (label: unknown) => {
  const s = String(label ?? '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  return s.includes('ccs') || s === 'combo' || s === 'combo2';
};

function operatorForLive(station: any): LiveOperator | null {
  const op = String(station?.operator || '').toLowerCase();
  const agg = String(station?.aggregator || '').toLowerCase();
  const ext = String(station?.external_id || '');
  if (op === 'forevo' && ext.includes('forevo-ocpi-')) return 'forevo';
  if (op === 'zaryadka') return 'zaryadka';
  if (op === 'evika') return 'evika';
  if (op === 'batteryfly' || agg === 'batteryfly') return 'batteryfly';
  if (op === 'malanka' || agg === 'malanka') return 'malanka';
  // forevo stations often also on malanka feed when not pure OCPI id
  if (op === 'forevo' && !ext.includes('forevo-ocpi-')) return 'malanka';
  if (LIVE_OPERATORS.includes(op as LiveOperator)) return op as LiveOperator;
  return null;
}

async function fetchLivePoles(operator: LiveOperator, ids: string[]) {
  if (!ids.length) return { poles: [] as any[], updated_at: null as string | null };
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  const poles: any[] = [];
  let updated_at: string | null = null;
  for (const chunk of chunks) {
    const params = new URLSearchParams({
      operator,
      ids: chunk.join(','),
    });
    const res = await fetch(`/api/evrace/live-status?${params}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) continue;
    const data = await res.json();
    if (data.updated_at) updated_at = data.updated_at;
    if (Array.isArray(data.poles)) poles.push(...data.poles);
  }
  return { poles, updated_at };
}

const parsePowerKw = (raw?: unknown): number | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const m = String(raw).replace(',', '.').match(/([\d.]+)/);
  return m ? Number(m[1]) : undefined;
};

/** Normalize EVRace group → lightweight station for nearby list */
function groupToStation(group: any, index: number): ChargingStation | null {
  const poles = Array.isArray(group?.poles) ? group.poles : [];
  let lat: number | undefined;
  let lon: number | undefined;
  for (const p of poles) {
    const la = Number(p?.lat);
    const lo = Number(p?.lng ?? p?.lon);
    if (Number.isFinite(la) && Number.isFinite(lo)) {
      lat = la;
      lon = lo;
      break;
    }
  }
  if (lat === undefined || lon === undefined) {
    lat = Number(group?.lat);
    lon = Number(group?.lng ?? group?.lon);
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const guns: string[] = [];
  for (const p of poles) {
    for (const k of ['gun1_type', 'gun2_type', 'gun3_type', 'gun4_type']) {
      if (p?.[k]) guns.push(String(p[k]));
    }
  }
  const hasCcs2 = guns.some((g) => isCcsLabel(g));
  const hasType2 = guns.some((g) => /type\s*2|type2/i.test(g));

  // Max rated power from group / poles (same fields as chargingStations.ts)
  const ccsPowers = [
    group?.ccs2_power,
    group?.ccs_power,
    group?.dc_power,
    ...poles.flatMap((p: any) => [p?.power_kw, p?.power, p?.kw, p?.dc_power]),
  ]
    .map(parsePowerKw)
    .filter((v): v is number => v !== undefined && v > 0);
  const type2Powers = [
    group?.type2_power,
    group?.ac_power,
    ...poles.flatMap((p: any) => [p?.ac_power]),
  ]
    .map(parsePowerKw)
    .filter((v): v is number => v !== undefined && v > 0);

  const id =
    String(group?.location_id ?? group?.slug ?? poles[0]?.external_id ?? index);

  return {
    id: `evrace:${id}`,
    lat: lat!,
    lon: lon!,
    name:
      group?.location_name ||
      [group?.city, group?.address].filter(Boolean).join(', ') ||
      'Станция',
    address: [group?.city, group?.address].filter(Boolean).join(', ') || '',
    operator: group?.operator || poles[0]?.operator,
    hasType2,
    hasCcs2,
    connectorTypeUnknown: !hasCcs2 && !hasType2,
    ccs2PowerKw: ccsPowers.length ? Math.max(...ccsPowers) : undefined,
    type2PowerKw: type2Powers.length ? Math.max(...type2Powers) : undefined,
    distanceFromRouteKm: 0,
    distanceAlongRouteKm: 0,
    source: 'evrace',
    // stash raw poles for live id matching
    ...( { _poles: poles, _aggregator: group?.aggregator } as any ),
  };
}

export async function findNearbyFreeCcsChargers(
  origin: { lat: number; lon: number },
  options: { radiusKm?: number; limit?: number } = {},
): Promise<{ results: FreeChargerResult[]; searched: number; liveChecked: number }> {
  const radiusKm = options.radiusKm ?? 40;
  const limit = options.limit ?? 12;
  const pad = radiusKm / 111;
  const lonPad = radiusKm / (111 * Math.max(0.2, Math.cos((origin.lat * Math.PI) / 180)));
  const params = new URLSearchParams({
    minLat: String(origin.lat - pad),
    maxLat: String(origin.lat + pad),
    minLon: String(origin.lon - lonPad),
    maxLon: String(origin.lon + lonPad),
  });
  const res = await fetch(`/api/evrace/stations?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Станции недоступны (${res.status})`);
  const payload = await res.json();
  const groups = Array.isArray(payload?.groups) ? payload.groups : [];

  const stations: (ChargingStation & { _poles?: any[]; _aggregator?: string })[] = [];
  groups.forEach((g: any, i: number) => {
    const s = groupToStation(g, i) as any;
    if (!s) return;
    if (!stationSupportsVigo(s) || !s.hasCcs2) return;
    const d = haversineKm(origin.lat, origin.lon, s.lat, s.lon);
    if (d > radiusKm) return;
    s.distanceFromRouteKm = d;
    stations.push(s);
  });
  stations.sort((a, b) => a.distanceFromRouteKm - b.distanceFromRouteKm);

  // Collect external_ids per live operator
  const byOp: Record<string, string[]> = {};
  const stationByExt = new Map<string, (typeof stations)[0]>();
  for (const s of stations) {
    for (const pole of s._poles || []) {
      const ext = String(pole.external_id || '').trim();
      if (!ext) continue;
      const fake = {
        operator: pole.operator || s.operator,
        aggregator: pole.aggregator || s._aggregator,
        external_id: ext,
      };
      const op = operatorForLive(fake);
      if (!op) continue;
      byOp[op] = byOp[op] || [];
      if (!byOp[op].includes(ext)) byOp[op].push(ext);
      stationByExt.set(ext, s);
    }
  }

  const liveByExt = new Map<string, any>();
  let updatedAt: string | null = null;
  let liveChecked = 0;
  await Promise.all(
    Object.entries(byOp).map(async ([op, ids]) => {
      liveChecked += ids.length;
      const { poles, updated_at } = await fetchLivePoles(op as LiveOperator, ids);
      if (updated_at) updatedAt = updated_at;
      for (const pole of poles) {
        if (pole?.external_id) liveByExt.set(String(pole.external_id), pole);
      }
    }),
  );

  // Aggregate free CCS per station location
  const byStation = new Map<string, FreeChargerResult>();
  for (const [ext, livePole] of liveByExt) {
    const station = stationByExt.get(ext);
    if (!station) continue;
    const connectors = Array.isArray(livePole.connectors) ? livePole.connectors : [];
    const ccs = connectors.filter((c: any) => isCcsLabel(c.label));
    // If no connector labels, fall back to pole-level status when station has CCS
    const freeCcs = ccs.length
      ? ccs.filter((c: any) => c.status === 'available').length
      : livePole.status === 'available' && station.hasCcs2
        ? 1
        : 0;
    const totalCcs = ccs.length || (station.hasCcs2 ? 1 : 0);
    if (freeCcs < 1) continue;

    const existing = byStation.get(station.id);
    if (existing) {
      existing.freeCcs += freeCcs;
      existing.totalCcs += totalCcs;
      existing.connectors.push(
        ...ccs.map((c: any) => ({ label: String(c.label), status: String(c.status) })),
      );
    } else {
      byStation.set(station.id, {
        station,
        distanceKm: station.distanceFromRouteKm,
        freeCcs,
        totalCcs,
        operator: station.operator || '',
        updatedAt,
        connectors: ccs.map((c: any) => ({
          label: String(c.label),
          status: String(c.status),
        })),
      });
    }
  }

  const results = Array.from(byStation.values())
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);

  return { results, searched: stations.length, liveChecked };
}
