// Nearest free DC chargers using EVRace live operator feeds.
// Filtered by the active vehicle's connectors (CCS2 / GB/T / Type2).
import {
  stationSupportsConnectors,
  type ChargingStation,
  type VehicleConnector,
} from './chargingStations';

const LIVE_OPERATORS = ['forevo', 'malanka', 'zaryadka', 'batteryfly', 'evika'] as const;
type LiveOperator = (typeof LIVE_OPERATORS)[number];

export interface FreeChargerResult {
  station: ChargingStation;
  distanceKm: number;
  freeCcs: number;
  totalCcs: number;
  /** Preferred connector family that matched (for UI). */
  matchedConnector?: VehicleConnector;
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

const isGbtLabel = (label: unknown) => {
  const s = String(label ?? '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  // Do not treat "GBT AC" as DC GBT for free-DC search — still match label for type filter.
  return s.includes('gbt') || s.includes('gb/t') || s === 'guobiao';
};

/** Live connector is free for plugging in. */
const isConnectorAvailable = (status: unknown) => {
  const s = String(status ?? '')
    .toLowerCase()
    .trim();
  return s === 'available' || s === 'free' || s === 'availableidle' || s === 'idle';
};

/** Live connector matches what the vehicle needs (DC preferred). */
const connectorMatchesVehicle = (label: unknown, vehicleConnectors: VehicleConnector[]) => {
  if (vehicleConnectors.includes('gbt') && isGbtLabel(label)) return true;
  if (vehicleConnectors.includes('ccs2') && isCcsLabel(label)) return true;
  return false;
};

/** Infer which DC types this pole has from registry gun fields (not whole station). */
const poleRegistryConnectors = (pole: any): { hasCcs: boolean; hasGbt: boolean } => {
  const guns = ['gun1_type', 'gun2_type', 'gun3_type', 'gun4_type']
    .map((k) => pole?.[k])
    .filter(Boolean);
  return {
    hasCcs: guns.some((g) => isCcsLabel(g)),
    hasGbt: guns.some((g) => isGbtLabel(g)),
  };
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
  const hasGbt = guns.some((g) => isGbtLabel(g));

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
  const gbtPowers = [
    group?.gbt_power,
    group?.gbt_dc_power,
    ...poles.filter((p: any) => isGbtLabel(p?.gun1_type) || isGbtLabel(p?.gun2_type)).flatMap((p: any) => [p?.power_kw, p?.power, p?.kw, p?.dc_power]),
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
    hasGbt,
    connectorTypeUnknown: !hasCcs2 && !hasType2 && !hasGbt,
    ccs2PowerKw: ccsPowers.length ? Math.max(...ccsPowers) : undefined,
    type2PowerKw: type2Powers.length ? Math.max(...type2Powers) : undefined,
    gbtPowerKw: gbtPowers.length ? Math.max(...gbtPowers) : undefined,
    distanceFromRouteKm: 0,
    distanceAlongRouteKm: 0,
    source: 'evrace',
    // stash raw poles for live id matching
    ...( { _poles: poles, _aggregator: group?.aggregator } as any ),
  };
}

export async function findNearbyFreeCcsChargers(
  origin: { lat: number; lon: number },
  options: {
    radiusKm?: number;
    limit?: number;
    /** Active vehicle ports; default CCS2 (Vigo). */
    vehicleConnectors?: VehicleConnector[];
  } = {},
): Promise<{ results: FreeChargerResult[]; searched: number; liveChecked: number }> {
  const radiusKm = options.radiusKm ?? 40;
  const limit = options.limit ?? 12;
  const vehicleConnectors: VehicleConnector[] = options.vehicleConnectors?.length
    ? options.vehicleConnectors
    : ['ccs2', 'type2'];
  const wantsDc =
    vehicleConnectors.includes('ccs2') || vehicleConnectors.includes('gbt');
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
    if (!stationSupportsConnectors(s, vehicleConnectors)) return;
    // Nearby "free DC" search requires a DC port the car can use
    if (wantsDc) {
      const hasDc =
        (vehicleConnectors.includes('ccs2') && s.hasCcs2) ||
        (vehicleConnectors.includes('gbt') && s.hasGbt);
      if (!hasDc && !s.connectorTypeUnknown) return;
    }
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

  // Registry pole metadata by external_id (gun types for this pole only).
  const registryPoleByExt = new Map<string, any>();
  for (const s of stations) {
    for (const pole of s._poles || []) {
      const ext = String(pole.external_id || '').trim();
      if (ext) registryPoleByExt.set(ext, pole);
    }
  }

  // Aggregate free matching DC connectors per station location.
  // Critical: free status must be attributed to the *connector type the car needs*,
  // not to "any free gun on a multi-standard pole / multi-pole site".
  // Bug that this fixes: pole with only GBT free was counted as "CCS свободно"
  // because the station (another pole) has CCS and livePole.status was available.
  const byStation = new Map<string, FreeChargerResult>();
  for (const [ext, livePole] of liveByExt) {
    const station = stationByExt.get(ext);
    if (!station) continue;
    const connectors = Array.isArray(livePole.connectors) ? livePole.connectors : [];
    const matched = connectors.filter((c: any) =>
      connectorMatchesVehicle(c.label, vehicleConnectors),
    );
    const freeMatched = matched.filter((c: any) => isConnectorAvailable(c.status));

    let freeCount = 0;
    let totalCount = 0;
    let reportConnectors: { label: string; status: string }[] = [];

    if (connectors.length > 0) {
      // Authoritative: per-connector live status. No pole-level fallback.
      freeCount = freeMatched.length;
      totalCount = matched.length;
      reportConnectors = matched.map((c: any) => ({
        label: String(c.label ?? ''),
        status: String(c.status ?? ''),
      }));
    } else {
      // No connector breakdown — only trust pole status if *this pole* has the
      // wanted DC type in the registry (not merely the station as a whole).
      const reg = poleRegistryConnectors(registryPoleByExt.get(ext));
      const poleHasWanted =
        (vehicleConnectors.includes('ccs2') && reg.hasCcs) ||
        (vehicleConnectors.includes('gbt') && reg.hasGbt);
      if (poleHasWanted && isConnectorAvailable(livePole.status)) {
        freeCount = 1;
        totalCount = 1;
        reportConnectors = [
          {
            label: reg.hasCcs && vehicleConnectors.includes('ccs2') ? 'CCS' : 'GB/T',
            status: String(livePole.status ?? 'available'),
          },
        ];
      }
    }

    if (freeCount < 1) continue;

    // Label UI by what is actually free among matched connectors.
    const matchedConnector: VehicleConnector | undefined = freeMatched.some((c: any) =>
      isGbtLabel(c.label),
    ) && vehicleConnectors.includes('gbt')
      ? freeMatched.some((c: any) => isCcsLabel(c.label)) && vehicleConnectors.includes('ccs2')
        ? 'ccs2' // prefer CCS label if both free and car has CCS
        : 'gbt'
      : freeMatched.some((c: any) => isCcsLabel(c.label)) || vehicleConnectors.includes('ccs2')
        ? 'ccs2'
        : vehicleConnectors.includes('gbt')
          ? 'gbt'
          : vehicleConnectors[0];

    // If only GBT is free and the car is CCS-only, freeMatched is empty and we
    // already continued — so matchedConnector here always reflects a usable free port.

    const existing = byStation.get(station.id);
    if (existing) {
      existing.freeCcs += freeCount;
      existing.totalCcs += totalCount;
      existing.connectors.push(...reportConnectors);
      // Prefer showing CCS in UI if any free CCS was seen on this site.
      if (matchedConnector === 'ccs2') existing.matchedConnector = 'ccs2';
    } else {
      byStation.set(station.id, {
        station,
        distanceKm: station.distanceFromRouteKm,
        freeCcs: freeCount,
        totalCcs: totalCount,
        matchedConnector,
        operator: station.operator || '',
        updatedAt,
        connectors: reportConnectors,
      });
    }
  }

  const results = Array.from(byStation.values())
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);

  return { results, searched: stations.length, liveChecked };
}
