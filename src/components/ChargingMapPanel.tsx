import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MapPin,
  Navigation,
  Loader2,
  X,
  Zap,
  PlugZap,
  Filter,
  LocateFixed,
} from 'lucide-react';
import { UserSettings } from '../types';
import {
  createBestMap,
  makeDotMarkerEl,
  makeChargerMarkerEl,
  makeClusterMarkerEl,
  clusterPointsByZoom,
  resetClusterEnterAnimations,
  toLonLat,
  type AnyMapBundle,
} from '../utils/yandexMaps';
import {
  resolveEffectiveConnectors,
  type ConnectorOverride,
} from '../data/vehicleProfiles';
import type { VehicleConnector } from '../services/chargingStations';
import { triggerHaptic } from '../utils/haptics';
import { findNearbyFreeCcsChargers, type FreeChargerResult } from '../services/nearbyFreeCharging';
import { useEvraceTariffs, matchEvraceTariff, type EvraceTariff } from '../hooks/useEvraceTariffs';

/** Port group: same connector + same power on a location */
type PortGroup = {
  connector: string;
  powerKw?: number;
  count: number;
};

interface MapStation {
  id: string;
  lat: number;
  lon: number;
  name: string;
  address: string;
  operator: string;
  operatorKey: string;
  hasCcs2: boolean;
  hasGbt: boolean;
  hasType2: boolean;
  ccs2PowerKw?: number;
  gbtPowerKw?: number;
  type2PowerKw?: number;
  /** Detailed ports (may include several powers for one connector type) */
  portGroups: PortGroup[];
  freeCcs?: number;
  freeGbt?: number;
  freeType2?: number;
  totalCcs?: number;
  totalGbt?: number;
  totalType2?: number;
  liveChecked?: boolean;
  _poles?: any[];
}

const OPERATOR_COLORS: Record<string, string> = {
  malanka: '#22c55e',
  zaryadka: '#3b82f6',
  batteryfly: '#f59e0b',
  forevo: '#a855f7',
  evika: '#ef4444',
  united: '#06b6d4',
  csms: '#14b8a6',
  цсмс: '#14b8a6',
  evon: '#e11d48',
  orange: '#f97316',
  skat: '#8b5cf6',
  prizma: '#0ea5e9',
  gto: '#64748b',
  belteh: '#64748b',
};

function normalizeOperatorKey(op: string): string {
  const o = op.toLowerCase().replace(/\s+/g, '').replace(/[«»"']/g, '');
  if (!o) return 'other';
  if (o.includes('malanka') || o.includes('маланка')) return 'malanka';
  if (o.includes('zaryad') || o.includes('заряд')) return 'zaryadka';
  if (o.includes('battery') || o.includes('батар')) return 'batteryfly';
  if (o.includes('forevo')) return 'forevo';
  if (o.includes('evika') || o.includes('белтелеком')) return 'evika';
  if (o.includes('united')) return 'united';
  if (o.includes('csms') || o.includes('цсмс')) return 'csms';
  if (o.includes('evon')) return 'evon';
  if (o.includes('orange')) return 'orange';
  if (o.includes('skat')) return 'skat';
  if (o.includes('prizma')) return 'prizma';
  if (o.includes('gto') || o.includes('белтех')) return 'gto';
  return o.slice(0, 16);
}

function operatorColor(op: string): string {
  const key = normalizeOperatorKey(op);
  return OPERATOR_COLORS[key] || '#94a3b8';
}

function connectorLabelFromGun(g: string): string | null {
  if (isCcsLabel(g)) return 'CCS';
  if (isGbtLabel(g)) return 'GB/T';
  if (isType2Label(g) || /type\s*2/i.test(g)) return 'Type2';
  return null;
}

function buildPortGroups(poles: any[], group: any): PortGroup[] {
  const map = new Map<string, PortGroup>();
  const add = (connector: string, powerKw?: number) => {
    const key = `${connector}|${powerKw ?? 'x'}`;
    const cur = map.get(key);
    if (cur) cur.count += 1;
    else map.set(key, { connector, powerKw, count: 1 });
  };

  for (const p of poles) {
    const pw =
      parsePowerKw(p?.power_kw) ??
      parsePowerKw(p?.power) ??
      parsePowerKw(p?.kw) ??
      parsePowerKw(p?.dc_power) ??
      parsePowerKw(p?.ac_power);
    let anyGun = false;
    for (const k of ['gun1_type', 'gun2_type', 'gun3_type', 'gun4_type']) {
      if (!p?.[k]) continue;
      const label = connectorLabelFromGun(String(p[k]));
      if (!label) continue;
      anyGun = true;
      const power =
        label === 'Type2'
          ? parsePowerKw(p?.ac_power) ?? pw ?? parsePowerKw(group?.ac_power)
          : pw ??
            parsePowerKw(group?.ccs2_power) ??
            parsePowerKw(group?.ccs_power) ??
            parsePowerKw(group?.dc_power);
      add(label, power);
    }
    if (!anyGun && pw) {
      // pole without gun types — still show power bucket as DC if present
      add('DC', pw);
    }
  }

  // fallback from group-level flags if nothing collected
  if (!map.size) {
    const maxDc = [
      group?.ccs2_power,
      group?.ccs_power,
      group?.dc_power,
      ...poles.flatMap((p: any) => [p?.power_kw, p?.power, p?.kw, p?.dc_power]),
    ]
      .map(parsePowerKw)
      .filter((v): v is number => v !== undefined && v > 0);
    const dc = maxDc.length ? Math.max(...maxDc) : undefined;
    const ac = parsePowerKw(group?.ac_power ?? poles[0]?.ac_power);
    const guns: string[] = [];
    for (const p of poles) {
      for (const k of ['gun1_type', 'gun2_type', 'gun3_type', 'gun4_type']) {
        if (p?.[k]) guns.push(String(p[k]));
      }
    }
    if (guns.some((g) => isCcsLabel(g))) add('CCS', dc);
    if (guns.some((g) => isGbtLabel(g))) add('GB/T', dc);
    if (guns.some((g) => isType2Label(g) || /type\s*2/i.test(g))) add('Type2', ac);
  }

  return Array.from(map.values()).sort((a, b) => (b.powerKw ?? 0) - (a.powerKw ?? 0));
}

interface ChargingMapPanelProps {
  settings: UserSettings;
}

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
  return s.includes('gbt') || s.includes('gb/t') || s === 'guobiao';
};

const isType2Label = (label: unknown) => {
  const s = String(label ?? '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  return s.includes('type2') || s === 'type2ac';
};

const isAvailable = (status: unknown) => {
  const s = String(status ?? '')
    .toLowerCase()
    .trim();
  return s === 'available' || s === 'free' || s === 'idle';
};

const parsePowerKw = (raw?: unknown): number | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const m = String(raw)
    .replace(',', '.')
    .match(/([\d.]+)/);
  return m ? Number(m[1]) : undefined;
};

function groupToMapStation(group: any, index: number): MapStation | null {
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
  const hasGbt = guns.some((g) => isGbtLabel(g));
  const hasType2 = guns.some((g) => isType2Label(g) || /type\s*2/i.test(g));

  const dcPowers = [
    group?.ccs2_power,
    group?.ccs_power,
    group?.dc_power,
    ...poles.flatMap((p: any) => [p?.power_kw, p?.power, p?.kw, p?.dc_power]),
  ]
    .map(parsePowerKw)
    .filter((v): v is number => v !== undefined && v > 0);
  const maxDc = dcPowers.length ? Math.max(...dcPowers) : undefined;

  const id = String(group?.location_id ?? group?.slug ?? poles[0]?.external_id ?? index);

  const operator = String(group?.operator || poles[0]?.operator || '');
  const portGroups = buildPortGroups(poles, group);

  return {
    id: `evrace:${id}`,
    lat: lat!,
    lon: lon!,
    name:
      group?.location_name ||
      [group?.city, group?.address].filter(Boolean).join(', ') ||
      'Станция',
    address: [group?.city, group?.address].filter(Boolean).join(', ') || '',
    operator,
    operatorKey: normalizeOperatorKey(operator),
    hasCcs2,
    hasGbt,
    hasType2,
    ccs2PowerKw: hasCcs2 ? maxDc : undefined,
    gbtPowerKw: hasGbt ? maxDc : undefined,
    type2PowerKw: parsePowerKw(group?.ac_power ?? poles[0]?.ac_power),
    portGroups,
    _poles: poles,
  };
}

function isNightTariffHour(d = new Date()) {
  const h = d.getHours();
  return h >= 23 || h < 7;
}

function tariffFromEvrace(
  operator: string,
  tariffs: EvraceTariff[],
  preferDc = true,
): {
  label: string;
  rate: number | null;
  period: string;
  asOf?: string | null;
  source: string;
} {
  const t = matchEvraceTariff(operator, tariffs);
  if (!t) {
    return { label: operator || 'ЭЗС', rate: null, period: '', source: 'нет данных' };
  }
  const night = isNightTariffHour();
  let rate: number | null = null;
  let period = '';
  if (preferDc) {
    if (night && t.dcNight != null) {
      rate = t.dcNight;
      period = 'DC ночь';
    } else if (t.dcDay != null) {
      rate = t.dcDay;
      period = 'DC день';
    } else if (t.dcNight != null) {
      rate = t.dcNight;
      period = 'DC ночь';
    } else if (t.acDay != null) {
      rate = t.acDay;
      period = 'AC';
    }
  } else if (t.acDay != null) {
    rate = t.acDay;
    period = 'AC';
  } else if (t.dcDay != null) {
    rate = t.dcDay;
    period = 'DC день';
  }
  return {
    label: t.name,
    rate,
    period,
    asOf: t.asOf,
    source: 'база тарифов',
  };
}

const LIVE_OPS = ['forevo', 'malanka', 'zaryadka', 'batteryfly', 'evika'] as const;

function operatorForLive(station: any): (typeof LIVE_OPS)[number] | null {
  const op = String(station?.operator || '').toLowerCase();
  const agg = String(station?.aggregator || '').toLowerCase();
  const ext = String(station?.external_id || '');
  if (op === 'forevo' && ext.includes('forevo-ocpi-')) return 'forevo';
  if (op === 'zaryadka') return 'zaryadka';
  if (op === 'evika') return 'evika';
  if (op === 'batteryfly' || agg === 'batteryfly') return 'batteryfly';
  if (op === 'malanka' || agg === 'malanka') return 'malanka';
  if (op === 'forevo') return 'malanka';
  if ((LIVE_OPS as readonly string[]).includes(op)) return op as (typeof LIVE_OPS)[number];
  return null;
}

export const ChargingMapPanel: React.FC<ChargingMapPanelProps> = ({ settings }) => {
  const isDark = settings.theme !== 'light';
  const profileConnectors = useMemo(
    () =>
      resolveEffectiveConnectors(
        settings.vehicleProfileId,
        settings.connectorOverride as ConnectorOverride | undefined,
      ),
    [settings.vehicleProfileId, settings.connectorOverride],
  );

  const [onlyFree, setOnlyFree] = useState(false);
  /** Empty = all operators */
  const [operatorFilter, setOperatorFilter] = useState<string[]>([]);
  /** Min station power kW; null = any */
  const [minPowerKw, setMinPowerKw] = useState<number | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [findingNearest, setFindingNearest] = useState(false);
  const [nearestFreeList, setNearestFreeList] = useState<FreeChargerResult[]>([]);
  const [nearestFreeOpen, setNearestFreeOpen] = useState(false);
  const [stations, setStations] = useState<MapStation[]>([]);
  const [mapZoom, setMapZoom] = useState(12);
  const stationsSigRef = useRef('');
  useEffect(() => {
    const sig = stations.map((s) => s.id).join('|');
    if (sig !== stationsSigRef.current) {
      stationsSigRef.current = sig;
      resetClusterEnterAnimations();
    }
  }, [stations]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<MapStation | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);
  const { tariffs: evraceTariffs } = useEvraceTariffs();

  const mapRef = useRef<any>(null);
  const bundleRef = useRef<AnyMapBundle | null>(null);
  const markersLayerRef = useRef<any[]>([]);
  const userMarkerRef = useRef<any>(null);
  const userWatchRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [userPos, setUserPos] = useState<{ lat: number; lon: number } | null>(null);
  const fetchTimerRef = useRef<number | null>(null);
  const lastFetchAtRef = useRef(0);
  const stationsRef = useRef<MapStation[]>([]);
  stationsRef.current = stations;
  const onlyFreeRef = useRef(onlyFree);
  onlyFreeRef.current = onlyFree;
  const refreshLiveRef = useRef<(s: MapStation) => void>(() => {});

  const tariff = selected
    ? tariffFromEvrace(
        selected.operator,
        evraceTariffs,
        selected.hasCcs2 || selected.hasGbt,
      )
    : null;

  const stationMaxPowerKw = useCallback((s: MapStation): number => {
    const fromGroups = (s.portGroups || [])
      .map((g) => (typeof g.powerKw === 'number' && g.powerKw > 0 ? g.powerKw : 0));
    return Math.max(
      s.ccs2PowerKw ?? 0,
      s.gbtPowerKw ?? 0,
      s.type2PowerKw ?? 0,
      ...(fromGroups.length ? fromGroups : [0]),
      0,
    );
  }, []);

  const matchesFilters = useCallback(
    (s: MapStation) => {
      const typeOk =
        (profileConnectors.includes('ccs2') && s.hasCcs2) ||
        (profileConnectors.includes('gbt') && s.hasGbt) ||
        (profileConnectors.includes('type2') && s.hasType2);
      if (!typeOk) return false;
      if (operatorFilter.length && !operatorFilter.includes(s.operatorKey)) return false;
      if (minPowerKw != null) {
        const pw = stationMaxPowerKw(s);
        // Stations without power metadata stay visible only when filter is off.
        if (pw <= 0 || pw < minPowerKw) return false;
      }
      if (onlyFree) {
        if (!s.liveChecked) return false;
        const free =
          (profileConnectors.includes('ccs2') && (s.freeCcs ?? 0) > 0) ||
          (profileConnectors.includes('gbt') && (s.freeGbt ?? 0) > 0) ||
          (profileConnectors.includes('type2') && (s.freeType2 ?? 0) > 0);
        return free;
      }
      return true;
    },
    [profileConnectors, onlyFree, operatorFilter, minPowerKw, stationMaxPowerKw],
  );

  const operatorsInView = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of stations) {
      if (!s.operatorKey || s.operatorKey === 'other') continue;
      if (!map.has(s.operatorKey)) map.set(s.operatorKey, s.operator || s.operatorKey);
    }
    return Array.from(map.entries())
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  }, [stations]);

  const enrichLive = useCallback(async (list: MapStation[]): Promise<MapStation[]> => {
    const byOp: Record<string, string[]> = {};
    const stationByExt = new Map<string, MapStation>();
    for (const s of list) {
      for (const pole of s._poles || []) {
        const ext = String(pole.external_id || '').trim();
        if (!ext) continue;
        const op = operatorForLive({
          operator: pole.operator || s.operator,
          aggregator: pole.aggregator,
          external_id: ext,
        });
        if (!op) continue;
        byOp[op] = byOp[op] || [];
        if (!byOp[op].includes(ext)) byOp[op].push(ext);
        stationByExt.set(ext, s);
      }
    }

    const liveByExt = new Map<string, any>();
    await Promise.all(
      Object.entries(byOp).map(async ([op, ids]) => {
        for (let i = 0; i < ids.length; i += 50) {
          const chunk = ids.slice(i, i + 50);
          try {
            const res = await fetch(
              `/api/evrace/live-status?operator=${op}&ids=${encodeURIComponent(chunk.join(','))}`,
              { headers: { Accept: 'application/json' } },
            );
            if (!res.ok) continue;
            const data = await res.json();
            for (const pole of data.poles || []) {
              if (pole?.external_id) liveByExt.set(String(pole.external_id), pole);
            }
          } catch {
            /* ignore */
          }
        }
      }),
    );

    const acc = new Map<string, MapStation>();
    for (const s of list) {
      acc.set(s.id, {
        ...s,
        freeCcs: 0,
        freeGbt: 0,
        freeType2: 0,
        totalCcs: 0,
        totalGbt: 0,
        liveChecked: false,
      });
    }

    for (const [ext, livePole] of liveByExt) {
      const base = stationByExt.get(ext);
      if (!base) continue;
      const cur = acc.get(base.id);
      if (!cur) continue;
      cur.liveChecked = true;
      const connectors = Array.isArray(livePole.connectors) ? livePole.connectors : [];
      if (connectors.length) {
        for (const c of connectors) {
          const free = isAvailable(c.status);
          if (isCcsLabel(c.label)) {
            cur.totalCcs = (cur.totalCcs || 0) + 1;
            if (free) cur.freeCcs = (cur.freeCcs || 0) + 1;
          } else if (isGbtLabel(c.label)) {
            cur.totalGbt = (cur.totalGbt || 0) + 1;
            if (free) cur.freeGbt = (cur.freeGbt || 0) + 1;
          } else if (isType2Label(c.label)) {
            cur.totalType2 = (cur.totalType2 || 0) + 1;
            if (free) cur.freeType2 = (cur.freeType2 || 0) + 1;
          }
        }
      } else if (isAvailable(livePole.status)) {
        if (cur.hasCcs2) {
          cur.freeCcs = (cur.freeCcs || 0) + 1;
          cur.totalCcs = (cur.totalCcs || 0) + 1;
        } else if (cur.hasGbt) {
          cur.freeGbt = (cur.freeGbt || 0) + 1;
          cur.totalGbt = (cur.totalGbt || 0) + 1;
        }
      }
    }

    return Array.from(acc.values());
  }, []);

  const fetchStationsInBounds = useCallback(
    async (bounds: number[][]) => {
      // bounds: [[latSW, lonSW], [latNE, lonNE]]
      const minLat = Math.min(bounds[0][0], bounds[1][0]);
      const maxLat = Math.max(bounds[0][0], bounds[1][0]);
      const minLon = Math.min(bounds[0][1], bounds[1][1]);
      const maxLon = Math.max(bounds[0][1], bounds[1][1]);
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams({
          minLat: String(minLat),
          maxLat: String(maxLat),
          minLon: String(minLon),
          maxLon: String(maxLon),
        });
        const res = await fetch(`/api/evrace/stations?${params}`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`Станции недоступны (${res.status})`);
        const payload = await res.json();
        const groups = Array.isArray(payload?.groups) ? payload.groups : [];
        let list: MapStation[] = [];
        groups.forEach((g: any, i: number) => {
          const s = groupToMapStation(g, i);
          if (s) list.push(s);
        });
        // Cap markers — fewer objects = smoother pan
        if (list.length > 90) list = list.slice(0, 90);

        // Live occupancy is expensive: only when "only free" filter is on.
        // Single-station live runs on marker click.
        if (onlyFreeRef.current) {
          setLiveBusy(true);
          try {
            list = await enrichLive(list);
          } finally {
            setLiveBusy(false);
          }
        }
        setStations(list);
        lastFetchAtRef.current = Date.now();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [enrichLive],
  );

  const scheduleFetch = useCallback(() => {
    if (!mapRef.current) return;
    if (fetchTimerRef.current) window.clearTimeout(fetchTimerRef.current);
    // Debounce after pan/zoom ends — avoids stacking requests mid-drag
    fetchTimerRef.current = window.setTimeout(() => {
      try {
        const map = mapRef.current;
        if (!map) return;
        // ymaps3: bounds as [[minLon,minLat],[maxLon,maxLat]] or via location
        let bounds: number[][] | null = null;
        const bundle = bundleRef.current as any;
        if (bundle?.apiVersion === 2 && typeof map.getBounds === 'function') {
          const b = map.getBounds();
          if (b) bounds = b; // already [[lat,lon],[lat,lon]]
        } else if (typeof map.bounds === 'object' && map.bounds) {
          const b = map.bounds;
          bounds = [
            [b[0][1], b[0][0]],
            [b[1][1], b[1][0]],
          ];
        } else if (typeof map.getBounds === 'function') {
          const b = map.getBounds();
          if (b) {
            bounds = [
              [b[0][1], b[0][0]],
              [b[1][1], b[1][0]],
            ];
          }
        }
        if (!bounds) {
          // Estimate viewport from center + zoom (v3 center is [lon, lat])
          const c = map.center || map.location?.center || [27.5667, 53.9];
          const z = map.zoom ?? map.location?.zoom ?? 12;
          const lon = Array.isArray(c) ? c[0] : 27.5667;
          const lat = Array.isArray(c) ? c[1] : 53.9;
          const dLat = 180 / Math.pow(2, z) * 1.4;
          const dLon = dLat / Math.max(0.3, Math.cos((lat * Math.PI) / 180));
          bounds = [
            [lat - dLat, lon - dLon],
            [lat + dLat, lon + dLon],
          ];
        }
        void fetchStationsInBounds(bounds);
      } catch {
        /* ignore */
      }
    }, 700);
  }, [fetchStationsInBounds]);

  /** Live status for one station (on card open). */
  const refreshStationLive = useCallback(
    async (station: MapStation) => {
      setLiveBusy(true);
      try {
        const [enriched] = await enrichLive([station]);
        if (!enriched) return;
        setStations((prev) => prev.map((s) => (s.id === enriched.id ? { ...s, ...enriched } : s)));
        setSelected((cur) => (cur && cur.id === enriched.id ? { ...cur, ...enriched } : cur));
      } finally {
        setLiveBusy(false);
      }
    },
    [enrichLive],
  );
  refreshLiveRef.current = (s: MapStation) => {
    void refreshStationLive(s);
  };

  // Re-load with live data when "only free" is enabled
  useEffect(() => {
    if (!onlyFree || !mapRef.current) return;
    scheduleFetch();
  }, [onlyFree, scheduleFetch]);


  // Init Yandex Maps API v3
  useEffect(() => {
    let cancelled = false;
    if (!containerRef.current) return;

    createBestMap(containerRef.current, {
      lat: 53.9,
      lon: 27.5667,
      zoom: 12,
      isDark,
    })
      .then((bundle) => {
        if (cancelled) {
          bundle.destroy();
          return;
        }
        bundleRef.current = bundle;
        mapRef.current = bundle.map;

        const onMoveEnd = () => scheduleFetch();
        // v3: listen via YMapListener for location changes is complex; poll bounds on action end via DOM
        const el = containerRef.current;
        const onUp = () => scheduleFetch();
        el?.addEventListener('pointerup', onUp);
        el?.addEventListener('wheel', onUp, { passive: true });
        (bundle.map as any).__vigoCleanupListeners = () => {
          el?.removeEventListener('pointerup', onUp);
          el?.removeEventListener('wheel', onUp);
        };

        scheduleFetch();

        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              if (cancelled || !bundleRef.current) return;
              const lat = pos.coords.latitude;
              const lon = pos.coords.longitude;
              // placeUserMarker from closure after first paint
              const b = bundleRef.current;
              try {
                const el = document.createElement('div');
                el.style.cssText =
                  'position:relative;width:22px;height:22px;transform:translate(-50%,-50%);pointer-events:none;';
                el.innerHTML =
                  '<span class="vigo-user-pulse-ring"></span><span class="vigo-user-dot"></span>';
                if ((b as any).apiVersion === 3) {
                  const { YMapMarker } = (b as any).ymaps3;
                  const marker = new YMapMarker(
                    { coordinates: [lon, lat] },
                    el,
                  );
                  (b as any).map.addChild(marker);
                  userMarkerRef.current = marker;
                }
                setUserPos({ lat, lon });
              } catch {
                /* ignore */
              }
              bundleRef.current.setLocation(lat, lon, 13);
              scheduleFetch();
            },
            () => {},
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
          );
          try {
            userWatchRef.current = navigator.geolocation.watchPosition(
              (pos) => {
                if (cancelled || !bundleRef.current) return;
                const lat = pos.coords.latitude;
                const lon = pos.coords.longitude;
                const b = bundleRef.current as any;
                if (userMarkerRef.current && b.apiVersion === 3) {
                  try {
                    userMarkerRef.current.update({ coordinates: [lon, lat] });
                  } catch {
                    /* ignore */
                  }
                } else if (userMarkerRef.current && b.apiVersion === 2) {
                  try {
                    userMarkerRef.current.geometry.setCoordinates([lat, lon]);
                  } catch {
                    /* ignore */
                  }
                }
                setUserPos({ lat, lon });
              },
              () => {},
              { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 },
            );
          } catch {
            /* ignore */
          }
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить карту'));

    return () => {
      cancelled = true;
      if (fetchTimerRef.current) window.clearTimeout(fetchTimerRef.current);
      try {
        (mapRef.current as any)?.__vigoCleanupListeners?.();
      } catch {
        /* ignore */
      }
      markersLayerRef.current = [];
      if (userWatchRef.current != null && navigator.geolocation) {
        try {
          navigator.geolocation.clearWatch(userWatchRef.current);
        } catch {
          /* ignore */
        }
        userWatchRef.current = null;
      }
      userMarkerRef.current = null;
      bundleRef.current?.destroy();
      bundleRef.current = null;
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // Zoom for clustering
  useEffect(() => {
    const id = window.setInterval(() => {
      const b = bundleRef.current as any;
      if (!b?.map) return;
      try {
        const map = b.map;
        const z =
          (typeof map.zoom === 'number' && map.zoom) ||
          (typeof map.location?.zoom === 'number' && map.location.zoom) ||
          null;
        if (typeof z === 'number' && Number.isFinite(z)) {
          setMapZoom((prev) => (Math.abs(prev - z) >= 0.45 ? z : prev));
        }
      } catch { /* ignore */ }
    }, 450);
    return () => window.clearInterval(id);
  }, []);

  // Update markers when stations / filters change
  useEffect(() => {
    const bundle = bundleRef.current as any;
    if (!bundle) return;
    const map = bundle.map;
    const visible = stations.filter(matchesFilters);

    // clear previous
    markersLayerRef.current.forEach((m) => {
      try {
        if (bundle.apiVersion === 3) map.removeChild(m);
        else map.geoObjects.remove(m);
      } catch {
        /* ignore */
      }
    });
    markersLayerRef.current = [];

    const zoomInto = (lat: number, lon: number) => {
      try {
        if (bundle.apiVersion === 3) {
          map.setLocation?.({
            center: toLonLat(lat, lon),
            zoom: Math.min(16, (mapZoom || 12) + 2),
            duration: 280,
          });
        } else {
          bundle.setLocation?.(lat, lon, Math.min(16, (mapZoom || 12) + 2));
        }
      } catch { /* ignore */ }
    };

    const points = visible.map((s) => ({
      ...s,
      lat: s.lat,
      lon: s.lon,
      recommended: false,
    }));
    const zCluster = Math.round(mapZoom * 2) / 2;
    const buckets = clusterPointsByZoom(points, zCluster);

    for (const bucket of buckets) {
      if (bucket.type === 'cluster') {
        if (bundle.apiVersion === 3) {
          const { YMapMarker } = bundle.ymaps3;
          const el = makeClusterMarkerEl({
            count: bucket.count,
            title: `${bucket.count} станций — приблизьте`,
            stableKey: `map:${bucket.cellKey}:${bucket.count}`,
          });
          el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            zoomInto(bucket.lat, bucket.lon);
          });
          const marker = new YMapMarker({ coordinates: toLonLat(bucket.lat, bucket.lon) }, el);
          map.addChild(marker);
          markersLayerRef.current.push(marker);
        } else {
          const ymaps = bundle.ymaps;
          const marker = new ymaps.Placemark(
            [bucket.lat, bucket.lon],
            { iconContent: String(bucket.count), hintContent: `${bucket.count} станций` },
            { preset: 'islands#darkBlueCircleIcon' },
          );
          marker.events.add('click', () => zoomInto(bucket.lat, bucket.lon));
          map.geoObjects.add(marker);
          markersLayerRef.current.push(marker);
        }
        continue;
      }

      const s = bucket.item as MapStation;
      const pw = stationMaxPowerKw(s);

      if (bundle.apiVersion === 3) {
        const { YMapMarker } = bundle.ymaps3;
        const el = makeChargerMarkerEl({
          powerKw: pw > 0 ? pw : null,
          recommended: false,
          title: s.name + (pw > 0 ? ` · ${Math.round(pw)} кВт` : ''),
        });
        // Operator tint on the disc border when live is known
        if (s.liveChecked) {
          const free =
            (profileConnectors.includes('ccs2') && (s.freeCcs ?? 0) > 0) ||
            (profileConnectors.includes('gbt') && (s.freeGbt ?? 0) > 0) ||
            (profileConnectors.includes('type2') && (s.freeType2 ?? 0) > 0);
          const disc = el.querySelector('.vigo-chg-marker__disc') as HTMLElement | null;
          if (disc) disc.style.boxShadow = free ? '0 0 0 2px #34d399' : '0 0 0 2px #f87171';
        }
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          setSelected(s);
          triggerHaptic('light', settings.hapticFeedback);
          if (!s.liveChecked) refreshLiveRef.current(s);
        });
        const marker = new YMapMarker({ coordinates: toLonLat(s.lat, s.lon) }, el);
        map.addChild(marker);
        markersLayerRef.current.push(marker);
      } else {
        const ymaps = bundle.ymaps;
        const marker = new ymaps.Placemark(
          [s.lat, s.lon],
          {
            hintContent: s.name,
            iconContent: pw > 0 ? String(Math.round(pw)) : '⚡',
          },
          { preset: 'islands#circleIcon', iconColor: operatorColor(s.operator) },
        );
        marker.events.add('click', () => {
          setSelected(s);
          triggerHaptic('light', settings.hapticFeedback);
          if (!s.liveChecked) refreshLiveRef.current(s);
        });
        map.geoObjects.add(marker);
        markersLayerRef.current.push(marker);
      }
    }
  }, [stations, matchesFilters, profileConnectors, settings.hapticFeedback, mapZoom, stationMaxPowerKw]);

  useEffect(() => {
    bundleRef.current?.setTheme(isDark);
  }, [isDark]);


  const placeUserMarker = useCallback((lat: number, lon: number) => {
    const bundle = bundleRef.current as any;
    if (!bundle) return;
    const map = bundle.map;

    const el = document.createElement('div');
    el.style.cssText =
      'position:relative;width:22px;height:22px;transform:translate(-50%,-50%);pointer-events:none;z-index:1000;';
    el.innerHTML =
      '<span class="vigo-user-pulse-ring"></span><span class="vigo-user-dot"></span>';

    if (bundle.apiVersion === 3) {
      const { YMapMarker } = bundle.ymaps3;
      const coords = toLonLat(lat, lon);
      if (userMarkerRef.current) {
        try {
          userMarkerRef.current.update({ coordinates: coords });
        } catch {
          try {
            map.removeChild(userMarkerRef.current);
          } catch {
            /* ignore */
          }
          userMarkerRef.current = new YMapMarker({ coordinates: coords }, el);
          map.addChild(userMarkerRef.current);
        }
      } else {
        userMarkerRef.current = new YMapMarker({ coordinates: coords }, el);
        map.addChild(userMarkerRef.current);
      }
    } else {
      const ymaps = bundle.ymaps;
      const coords: [number, number] = [lat, lon];
      if (userMarkerRef.current) {
        try {
          userMarkerRef.current.geometry.setCoordinates(coords);
        } catch {
          /* ignore */
        }
      } else {
        const layout = ymaps.templateLayoutFactory.createClass(
          '<div style="transform:translate(-50%,-50%);width:22px;height:22px;position:relative;">' +
            '<div style="position:absolute;inset:-10px;border-radius:50%;background:rgba(56,189,248,0.4);"></div>' +
            '<div style="position:absolute;inset:0;border-radius:50%;background:#38bdf8;border:3px solid #fff;box-shadow:0 0 0 2px #0284c7,0 2px 10px rgba(0,0,0,.5);"></div>' +
            '</div>',
        );
        const m = new ymaps.Placemark(
          coords,
          { hintContent: 'Вы здесь' },
          {
            iconLayout: layout,
            iconShape: { type: 'Circle', coordinates: [0, 0], radius: 18 },
            zIndex: 2000,
          },
        );
        map.geoObjects.add(m);
        userMarkerRef.current = m;
      }
    }
    setUserPos({ lat, lon });
  }, []);

  const goToMe = () => {
    if (!navigator.geolocation || !mapRef.current) return;
    triggerHaptic('light', settings.hapticFeedback);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        placeUserMarker(lat, lon);
        bundleRef.current?.setLocation(lat, lon, 14);
        scheduleFetch();
      },
      () => setError('Геолокация недоступна'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  /** Search nearby free chargers (same service as Calculator) and show a short list. */
  const findNearestFree = async () => {
    if (!navigator.geolocation) {
      setError('Геолокация недоступна');
      return;
    }
    triggerHaptic('medium', settings.hapticFeedback);
    setFindingNearest(true);
    setNearestFreeList([]);
    setNearestFreeOpen(true);
    setFiltersOpen(false);
    setOnlyFree(true);
    setError('');

    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 12000,
          maximumAge: 15000,
        }),
      );
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      placeUserMarker(lat, lon);
      bundleRef.current?.setLocation(lat, lon, 13);
      scheduleFetch();

      const vehicleConnectors = resolveEffectiveConnectors(
        settings.vehicleProfileId,
        settings.connectorOverride as any,
      );
      const { results } = await findNearbyFreeCcsChargers(
        { lat, lon },
        { radiusKm: 40, limit: 10, vehicleConnectors },
      );
      setNearestFreeList(results);
      if (!results.length) {
        setError('Свободных ЭЗС рядом не найдено. Расширьте радиус или снимите фильтры.');
      } else {
        // Focus map on the closest result without auto-selecting only one card permanently
        const best = results[0];
        if (best?.station) {
          bundleRef.current?.setLocation(best.station.lat, best.station.lon, 14);
        }
        triggerHaptic('success', settings.hapticFeedback);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось найти свободные ЭЗС');
    } finally {
      setFindingNearest(false);
    }
  };

  const selectNearestResult = (item: FreeChargerResult) => {
    triggerHaptic('light', settings.hapticFeedback);
    // Map onto MapStation shape if present in current stations; else synthesize minimal card
    const match = stationsRef.current.find(
      (s) =>
        s.id === item.station.id ||
        (Math.abs(s.lat - item.station.lat) < 1e-4 && Math.abs(s.lon - item.station.lon) < 1e-4),
    );
    if (match) {
      setSelected(match);
    } else {
      setSelected({
        id: item.station.id,
        lat: item.station.lat,
        lon: item.station.lon,
        name: item.station.name,
        address: item.station.address || '',
        operator: item.operator || item.station.operator || '',
        operatorKey: String(item.station.operator || item.operator || 'other').toLowerCase(),
        hasCcs2: true,
        hasGbt: item.matchedConnector === 'gbt',
        hasType2: item.matchedConnector === 'type2',
        freeCcs: item.freeCcs,
        totalCcs: item.totalCcs,
        liveChecked: true,
      } as any);
    }
    bundleRef.current?.setLocation(item.station.lat, item.station.lon, 15);
  };

  type PortChip = { key: string; label: string; free?: number; total?: number; live: boolean };
  const portChips = (s: MapStation): PortChip[] => {
    const chips: PortChip[] = [];
    if (s.hasCcs2 || (s.totalCcs ?? 0) > 0) {
      chips.push({
        key: 'ccs',
        label: 'CCS',
        free: s.freeCcs,
        total: s.totalCcs,
        live: !!s.liveChecked,
      });
    }
    if (s.hasGbt || (s.totalGbt ?? 0) > 0) {
      chips.push({
        key: 'gbt',
        label: 'GB/T',
        free: s.freeGbt,
        total: s.totalGbt,
        live: !!s.liveChecked,
      });
    }
    if (s.hasType2 || (s.totalType2 ?? 0) > 0) {
      chips.push({
        key: 't2',
        label: 'Type2',
        free: s.freeType2,
        total: s.totalType2,
        live: !!s.liveChecked,
      });
    }
    return chips;
  };

  const powerLine = (s: MapStation) => {
    if (s.portGroups?.length) {
      return s.portGroups
        .map((g) => {
          const pw = g.powerKw != null ? `${Math.round(g.powerKw)} кВт` : '? кВт';
          return g.count > 1 ? `${g.connector} ${pw} ×${g.count}` : `${g.connector} ${pw}`;
        })
        .join(' · ');
    }
    const parts: string[] = [];
    if (s.hasCcs2 && s.ccs2PowerKw) parts.push(`CCS ${Math.round(s.ccs2PowerKw)} кВт`);
    if (s.hasGbt && s.gbtPowerKw) parts.push(`GB/T ${Math.round(s.gbtPowerKw)} кВт`);
    if (s.hasType2 && s.type2PowerKw) parts.push(`Type2 ${Math.round(s.type2PowerKw)} кВт`);
    return parts.join(' · ') || 'мощность н/д';
  };

  const fullTariff = (s: MapStation) => {
    const t = matchEvraceTariff(s.operator, evraceTariffs);
    if (!t) return null;
    return t;
  };

  const visibleCount = stations.filter(matchesFilters).length;

  const selectedTariff = selected ? fullTariff(selected) : null;
  const selectedChips = selected ? portChips(selected) : [];
  const subText = isDark ? 'text-slate-500' : 'text-slate-400';
  const tileBg = isDark ? 'bg-slate-900' : 'bg-slate-50';
  const fmtByn = (n: number | null | undefined) =>
    n != null ? `${String(n).replace('.', ',')} BYN` : '—';
  const panelSurface = isDark
    ? 'bg-slate-950/95 border border-slate-700 text-slate-100'
    : 'bg-white/95 border border-slate-200 text-slate-900 shadow-lg';

  return (
    <div className="relative h-[calc(100dvh-7rem)] sm:h-[calc(100dvh-8rem)] landscape:h-[100dvh] max-h-none min-h-[320px] w-full overflow-hidden rounded-none sm:rounded-2xl border-0 sm:border border-slate-800/60">
      <div ref={containerRef} className="absolute inset-0 bg-slate-900" />

      {/*
        Overlay grid (one place for all floating UI, no hard-coded "top: 6.75rem"):
        - Portrait: single column -> [filters + locate] / [CTA] / [filters sheet OR nearest list]
        - Landscape: three columns -> left: filters (+ sheet), centre: free map, right: CTA (+ nearest list)
        Safe-area insets are applied on all sides (notch / Dynamic Island in landscape).
      */}
      <div
        className="pointer-events-none absolute inset-0 z-30 grid grid-cols-1 pt-1.5 landscape:pt-[calc(0.5rem_+_env(safe-area-inset-top,0px))] grid-rows-[auto_auto_minmax(0,1fr)] gap-2 landscape:grid-cols-[minmax(0,min(19rem,38%))_minmax(0,1fr)_minmax(0,min(19rem,38%))] landscape:grid-rows-[auto_minmax(0,1fr)]"
        style={{
          paddingLeft: 'max(0.5rem, env(safe-area-inset-left, 0px))',
          paddingRight: 'max(0.5rem, env(safe-area-inset-right, 0px))',
          paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom, 0px))',
        }}
      >
        {/* Filters chip + counter + locate */}
        <div className="pointer-events-none flex items-start gap-2 landscape:col-start-1 landscape:row-start-1">
          <div
            className={`pointer-events-auto flex min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-xl px-2 py-1.5 backdrop-blur-md ${
              isDark ? 'bg-slate-950/85 text-slate-100' : 'bg-white/90 text-slate-900 shadow'
            }`}
          >
            <button
              type="button"
              onClick={() => {
                setFiltersOpen((v) => !v);
                setNearestFreeOpen(false);
              }}
              className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold ${
                filtersOpen ? 'bg-cyan-600 text-white' : isDark ? 'bg-slate-800' : 'bg-slate-100'
              }`}
            >
              <Filter className="h-3.5 w-3.5" />
              Фильтры
            </button>
            {onlyFree && (
              <span className="rounded-full bg-emerald-600/90 px-2 py-0.5 text-[10px] font-semibold text-white">
                свободные
              </span>
            )}
            <span className={`ml-auto text-[10px] tabular-nums ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              {loading || liveBusy ? '…' : `${visibleCount}`}
            </span>
          </div>
          <button
            type="button"
            onClick={goToMe}
            className={`pointer-events-auto shrink-0 rounded-xl p-2 backdrop-blur-md ${
              isDark ? 'bg-slate-950/85 text-cyan-400' : 'bg-white/90 text-cyan-600 shadow'
            }`}
            title="Моё местоположение"
          >
            <LocateFixed className="h-5 w-5" />
          </button>
        </div>

        {/* CTA: portrait — centred under filters; landscape — top-right column */}
        <div className="pointer-events-none flex justify-center landscape:col-start-3 landscape:row-start-1 landscape:justify-end">
          <button
            type="button"
            onClick={findNearestFree}
            disabled={findingNearest}
            className={`pointer-events-auto inline-flex items-center gap-2 rounded-full border px-5 py-2.5 text-[13px] font-black shadow-lg backdrop-blur-md active:scale-[0.98] disabled:opacity-80 landscape:px-4 landscape:py-2 landscape:text-[12px] ${
              findingNearest
                ? 'bg-cyan-700 text-white border-cyan-500/50 shadow-cyan-950/50'
                : 'bg-cyan-500 text-slate-950 border-cyan-300/40 shadow-cyan-500/30 hover:bg-cyan-400'
            }`}
          >
            {findingNearest ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Ищем свободную…
              </>
            ) : (
              <>
                <PlugZap className="h-4 w-4" />
                Ближайшая свободная
              </>
            )}
          </button>
        </div>

        {/* Nearest free list. Landscape: right column, hidden while a station card is open. */}
        {nearestFreeOpen && (
          <div
            className={`pointer-events-auto flex min-h-0 flex-col self-start overflow-hidden rounded-2xl backdrop-blur-md landscape:col-start-3 landscape:row-start-2 landscape:max-h-full ${
              selected ? 'max-h-[min(22dvh,11rem)] landscape:hidden' : 'max-h-[min(42dvh,20rem)]'
            } ${panelSurface}`}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-3 py-2">
              <span className="text-[11px] font-bold uppercase tracking-wide opacity-70">
                {findingNearest ? 'Поиск…' : `Свободные рядом · ${nearestFreeList.length}`}
              </span>
              <button
                type="button"
                onClick={() => {
                  setNearestFreeOpen(false);
                  setNearestFreeList([]);
                }}
                className="rounded-lg p-1 opacity-70 hover:opacity-100"
                aria-label="Закрыть"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {findingNearest ? (
              <div className="flex items-center gap-2 px-3 py-4 text-[12px] opacity-80">
                <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
                Сканируем станции вокруг…
              </div>
            ) : nearestFreeList.length === 0 ? (
              <div className="px-3 py-4 text-[12px] opacity-70">Ничего не найдено</div>
            ) : (
              <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain p-1.5">
                {nearestFreeList.map((item) => {
                  const isActive =
                    selected &&
                    (selected.id === item.station.id ||
                      (Math.abs(selected.lat - item.station.lat) < 1e-4 &&
                        Math.abs(selected.lon - item.station.lon) < 1e-4));
                  return (
                    <li key={item.station.id}>
                      <button
                        type="button"
                        onClick={() => selectNearestResult(item)}
                        className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                          isActive
                            ? isDark
                              ? 'bg-emerald-950/50 border-emerald-600/50'
                              : 'bg-emerald-50 border-emerald-300'
                            : isDark
                              ? 'bg-slate-900/80 border-transparent hover:bg-slate-800'
                              : 'bg-white border-slate-100 hover:bg-slate-50'
                        }`}
                      >
                        <div className="truncate text-[12px] font-semibold">{item.station.name}</div>
                        <div className="mt-0.5 text-[11px] opacity-60">
                          {item.distanceKm < 1
                            ? `${Math.round(item.distanceKm * 1000)} м`
                            : `${item.distanceKm.toFixed(1)} км`}
                          {' · '}
                          {item.matchedConnector === 'gbt' ? 'GB/T' : item.matchedConnector === 'type2' ? 'Type2' : 'CCS'}{' '}
                          свободно {item.freeCcs}
                          {item.operator ? ` · ${item.operator}` : ''}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {/* Filter sheet. Landscape: left column under the filters chip. */}
        {filtersOpen && (
          <div
            className={`pointer-events-auto min-h-0 self-start overflow-y-auto overscroll-contain rounded-2xl p-3 backdrop-blur-md landscape:col-start-1 landscape:row-start-2 landscape:max-h-full landscape:p-2.5 ${
              selected ? 'max-h-[min(30dvh,17rem)]' : 'max-h-[min(56dvh,26rem)]'
            } ${panelSurface}`}
          >
            <div className={`mb-3 rounded-xl px-3 py-2 text-[11px] landscape:mb-2 ${isDark ? 'bg-slate-900 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>
              <span className="font-semibold">Разъёмы:</span>{' '}
              {profileConnectors.map((c) => c === 'ccs2' ? 'CCS2' : c === 'gbt' ? 'GB/T' : 'Type2').join(' + ') || 'из профиля авто'}
            </div>

            <p className={`mb-1.5 text-[11px] font-bold uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Мощность от
            </p>
            <div className="mb-3 flex flex-wrap gap-1.5 landscape:mb-2">
              {(
                [
                  { v: null as number | null, label: 'Любая' },
                  { v: 50, label: '≥ 50 кВт' },
                  { v: 80, label: '≥ 80 кВт' },
                  { v: 120, label: '≥ 120 кВт' },
                  { v: 150, label: '≥ 150 кВт' },
                  { v: 180, label: '≥ 180 кВт' },
                ] as const
              ).map((opt) => (
                <button
                  key={String(opt.v)}
                  type="button"
                  onClick={() => {
                    setMinPowerKw(opt.v);
                    triggerHaptic('light', settings.hapticFeedback);
                  }}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    minPowerKw === opt.v
                      ? 'bg-cyan-600 text-white'
                      : isDark
                        ? 'bg-slate-800 text-slate-300'
                        : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => {
                setOnlyFree((v) => !v);
                triggerHaptic('light', settings.hapticFeedback);
              }}
              className={`w-full rounded-xl py-2 text-[12px] font-bold ${
                onlyFree
                  ? 'bg-emerald-600 text-white'
                  : isDark
                    ? 'bg-slate-800 text-slate-200'
                    : 'bg-slate-100 text-slate-700'
              }`}
            >
              Только свободные
            </button>

            <p className={`mt-3 text-[10px] font-bold uppercase tracking-wide landscape:mt-2 ${subText}`}>
              Оператор
            </p>
            <div className="mt-1.5 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto landscape:max-h-none">
              <button
                type="button"
                onClick={() => {
                  setOperatorFilter([]);
                  triggerHaptic('light', settings.hapticFeedback);
                }}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                  !operatorFilter.length
                    ? 'bg-cyan-600 text-white'
                    : isDark
                      ? 'bg-slate-800 text-slate-300'
                      : 'bg-slate-100 text-slate-600'
                }`}
              >
                Все
              </button>
              {operatorsInView.map((op) => {
                const active = operatorFilter.includes(op.key);
                return (
                  <button
                    key={op.key}
                    type="button"
                    onClick={() => {
                      setOperatorFilter((prev) =>
                        prev.includes(op.key)
                          ? prev.filter((k) => k !== op.key)
                          : [...prev, op.key],
                      );
                      triggerHaptic('light', settings.hapticFeedback);
                    }}
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                      active
                        ? 'text-white'
                        : isDark
                          ? 'bg-slate-800 text-slate-300'
                          : 'bg-slate-100 text-slate-600'
                    }`}
                    style={active ? { backgroundColor: operatorColor(op.key) } : undefined}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: operatorColor(op.key) }}
                    />
                    {op.label}
                  </button>
                );
              })}
            </div>

            <p className={`mt-2 text-[10px] ${subText}`}>
              Разъёмы — из профиля авто. Цвет маркера = оператор.
              {minPowerKw != null ? ` · Мощность ≥ ${minPowerKw} кВт` : ''}
            </p>
          </div>
        )}
      </div>

      {/* Loading pill: header counter already shows "…", so hide the pill while a card is open */}
      {(loading || liveBusy) && !selected && (
        <div className="absolute bottom-24 left-1/2 z-20 -translate-x-1/2 rounded-full bg-slate-950/80 px-3 py-1.5 text-[11px] text-slate-200 backdrop-blur landscape:bottom-3">
          <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" />
          Обновление…
        </div>
      )}

      {error && (
        <div
          className={`absolute left-2 right-2 z-50 rounded-xl bg-rose-950/90 px-3 py-2 text-[11px] text-rose-200 landscape:bottom-3 landscape:left-1/2 landscape:right-auto landscape:w-[min(28rem,50vw)] landscape:-translate-x-1/2 ${
            selected ? 'bottom-[calc(6rem_+_min(40dvh,24rem))]' : 'bottom-24'
          }`}
        >
          {error}
        </div>
      )}

      {/*
        Selected station card.
        Portrait: bottom sheet above the bottom nav.
        Landscape: compact two-column card pinned to the bottom-right (no bottom nav offset),
        so it never overlaps the filters/CTA and keeps the map centre visible.
      */}
      {selected && (
        <div
          className={`fixed left-3 right-3 z-40 mx-auto max-w-md overflow-y-auto overscroll-contain rounded-2xl border p-3 shadow-2xl backdrop-blur-md bottom-[calc(5.25rem_+_env(safe-area-inset-bottom,0px))] max-h-[min(40dvh,24rem)] landscape:left-auto landscape:right-[max(0.5rem,env(safe-area-inset-right,0px))] landscape:mx-0 landscape:w-[min(26rem,54vw)] landscape:max-w-none landscape:bottom-[max(0.5rem,env(safe-area-inset-bottom,0px))] landscape:max-h-[calc(100dvh_-_4rem_-_env(safe-area-inset-top,0px)_-_env(safe-area-inset-bottom,0px))] landscape:p-2.5 ${
            isDark
              ? 'border-slate-700 bg-slate-950/95 text-slate-100'
              : 'border-slate-200 bg-white/95 text-slate-900'
          }`}
        >
          <div className="flex items-start gap-2">
            <div className={`mt-0.5 rounded-lg p-1.5 ${isDark ? 'bg-cyan-500/15 text-cyan-400' : 'bg-cyan-50 text-cyan-600'}`}>
              <PlugZap className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-bold leading-tight">{selected.name}</p>
                  {selected.address && (
                    <p className={`truncate text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      {selected.address}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  aria-label="Закрыть"
                  className={`shrink-0 rounded-lg p-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Portrait: one column. Landscape: two columns (info | tariffs + navigate). */}
              <div className="landscape:grid landscape:grid-cols-2 landscape:gap-x-3">
                <div className="min-w-0">
                  {/* Operator */}
                  <div className="mt-2 flex items-center gap-2">
                    <span
                      className="h-3 w-3 shrink-0 rounded-full ring-2 ring-black/20"
                      style={{ backgroundColor: operatorColor(selected.operator) }}
                    />
                    <span className="truncate text-[12px] font-bold">{selected.operator || 'Оператор н/д'}</span>
                  </div>

                  {/* Free ports */}
                  <div className="mt-2">
                    <span className={`mb-1 block text-[10px] font-bold uppercase tracking-wide ${subText}`}>
                      Свободные порты
                      {liveBusy && !selected.liveChecked ? ' · обновление…' : ''}
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {selectedChips.map((chip) => {
                        const hasFree = chip.live && (chip.free ?? 0) > 0;
                        const allBusy = chip.live && (chip.free ?? 0) === 0 && (chip.total ?? 0) > 0;
                        return (
                          <span
                            key={chip.key}
                            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                              hasFree
                                ? 'bg-emerald-600 text-white'
                                : allBusy
                                  ? 'bg-rose-600/90 text-white'
                                  : isDark
                                    ? 'bg-slate-800 text-slate-200'
                                    : 'bg-slate-100 text-slate-700'
                            }`}
                          >
                            {chip.label}
                            {chip.live ? ` ${chip.free ?? 0}/${chip.total ?? '—'}` : ''}
                          </span>
                        );
                      })}
                      {!selectedChips.length && <span className={`text-[11px] ${subText}`}>—</span>}
                    </div>
                  </div>

                  {/* Ports × power */}
                  <div className="mt-2">
                    <span className={`mb-1 block text-[10px] font-bold uppercase tracking-wide ${subText}`}>
                      Порты и мощность
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {(selected.portGroups?.length ? selected.portGroups : []).map((g, i) => (
                        <span
                          key={`${g.connector}-${g.powerKw}-${i}`}
                          className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${
                            isDark ? 'bg-slate-900 text-slate-200' : 'bg-slate-50 text-slate-800'
                          }`}
                        >
                          {g.connector}
                          {g.powerKw != null ? ` ${Math.round(g.powerKw)} кВт` : ''}
                          {g.count > 1 ? ` ×${g.count}` : ''}
                        </span>
                      ))}
                      {!selected.portGroups?.length && (
                        <span className={`text-[11px] ${subText}`}>{powerLine(selected)}</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="min-w-0">
                  {/* Day / night tariffs */}
                  <div className={`mt-2 grid grid-cols-2 gap-2 text-[11px] ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                    <div className={`rounded-xl px-2.5 py-2 ${tileBg}`}>
                      <span className={`block text-[10px] uppercase ${subText}`}>DC день</span>
                      <span className="font-semibold">{fmtByn(selectedTariff?.dcDay)}</span>
                    </div>
                    <div className={`rounded-xl px-2.5 py-2 ${tileBg}`}>
                      <span className={`block text-[10px] uppercase ${subText}`}>DC ночь</span>
                      <span className="font-semibold">{fmtByn(selectedTariff?.dcNight)}</span>
                    </div>
                    {selectedTariff?.acDay != null && (
                      <div className={`col-span-2 rounded-xl px-2.5 py-2 ${tileBg}`}>
                        <span className={`block text-[10px] uppercase ${subText}`}>AC</span>
                        <span className="font-semibold">{fmtByn(selectedTariff.acDay)}</span>
                      </div>
                    )}
                    {!selectedTariff && (
                      <p className={`col-span-2 text-[10px] ${subText}`}>Тариф оператора не найден</p>
                    )}
                  </div>
                  {selectedTariff?.asOf && (
                    <p className={`mt-1 text-[10px] ${subText}`}>Тарифы на {selectedTariff.asOf}</p>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('medium', settings.hapticFeedback);
                      const { lat, lon } = selected;
                      // One target only — timed web fallback opened Maps + Navigator together.
                      const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(
                        navigator.userAgent || '',
                      );
                      if (isMobile) {
                        window.location.href = `yandexnavi://build_route_on_map?lat_to=${lat}&lon_to=${lon}`;
                      } else {
                        window.open(
                          `https://yandex.ru/maps/?rtext=~${lat},${lon}&rtt=auto`,
                          '_blank',
                          'noopener,noreferrer',
                        );
                      }
                    }}
                    className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-yellow-500 py-2.5 text-[13px] font-black text-slate-950 active:scale-[0.98] landscape:py-2"
                  >
                    <Navigation className="h-4 w-4" />
                    Яндекс Навигатор
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
