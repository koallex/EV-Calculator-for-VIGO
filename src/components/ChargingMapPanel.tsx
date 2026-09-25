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
import { applyMapTheme, loadYandexMaps } from '../utils/yandexMaps';
import {
  resolveEffectiveConnectors,
  type ConnectorOverride,
} from '../data/vehicleProfiles';
import type { VehicleConnector } from '../services/chargingStations';
import { triggerHaptic } from '../utils/haptics';

type ConnFilter = 'ccs2' | 'gbt' | 'type2';

interface MapStation {
  id: string;
  lat: number;
  lon: number;
  name: string;
  address: string;
  operator: string;
  hasCcs2: boolean;
  hasGbt: boolean;
  hasType2: boolean;
  ccs2PowerKw?: number;
  gbtPowerKw?: number;
  type2PowerKw?: number;
  freeCcs?: number;
  freeGbt?: number;
  freeType2?: number;
  totalCcs?: number;
  totalGbt?: number;
  totalType2?: number;
  liveChecked?: boolean;
  _poles?: any[];
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

  return {
    id: `evrace:${id}`,
    lat: lat!,
    lon: lon!,
    name:
      group?.location_name ||
      [group?.city, group?.address].filter(Boolean).join(', ') ||
      'Станция',
    address: [group?.city, group?.address].filter(Boolean).join(', ') || '',
    operator: String(group?.operator || poles[0]?.operator || ''),
    hasCcs2,
    hasGbt,
    hasType2,
    ccs2PowerKw: hasCcs2 ? maxDc : undefined,
    gbtPowerKw: hasGbt ? maxDc : undefined,
    type2PowerKw: parsePowerKw(group?.ac_power ?? poles[0]?.ac_power),
    _poles: poles,
  };
}

type EvraceTariff = {
  id: string;
  name: string;
  dcDay: number | null;
  dcNight: number | null;
  acDay: number | null;
  asOf?: string | null;
  floor?: string | null;
};

function isNightTariffHour(d = new Date()) {
  const h = d.getHours();
  return h >= 23 || h < 7;
}

function matchEvraceTariff(operator: string, tariffs: EvraceTariff[]): EvraceTariff | null {
  if (!tariffs.length) return null;
  const o = operator.toLowerCase().replace(/\s+/g, '');
  const aliases: Record<string, string[]> = {
    zaryadka: ['zaryadka', 'зарядка', 'zaryad'],
    malanka: ['malanka', 'маланка', 'csms', 'цсмс'],
    batteryfly: ['batteryfly', 'battery'],
    forevo: ['forevo'],
    evika: ['evika', 'белтелеком'],
    united: ['united', 'unitedcompany'],
  };
  for (const t of tariffs) {
    const id = t.id.toLowerCase();
    const name = t.name.toLowerCase().replace(/\s+/g, '');
    if (o.includes(id) || o.includes(name) || (o && name.includes(o))) return t;
    if ((aliases[id] || []).some((a) => o.includes(a))) return t;
  }
  return null;
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
    return { label: operator || 'ЭЗС', rate: null, period: '', source: 'нет в EVRace' };
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
    source: 'EVRace',
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

  const [connFilters, setConnFilters] = useState<ConnFilter[]>(() => {
    const init: ConnFilter[] = [];
    if (profileConnectors.includes('ccs2')) init.push('ccs2');
    if (profileConnectors.includes('gbt')) init.push('gbt');
    if (profileConnectors.includes('type2')) init.push('type2');
    return init.length ? init : ['ccs2'];
  });
  const [onlyFree, setOnlyFree] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [stations, setStations] = useState<MapStation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<MapStation | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);
  const [evraceTariffs, setEvraceTariffs] = useState<EvraceTariff[]>([]);

  const mapRef = useRef<any>(null);
  const ymapsRef = useRef<any>(null);
  const objectManagerRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fetchTimerRef = useRef<number | null>(null);
  const stationsRef = useRef<MapStation[]>([]);
  stationsRef.current = stations;
  const onlyFreeRef = useRef(onlyFree);
  onlyFreeRef.current = onlyFree;
  const refreshLiveRef = useRef<(s: MapStation) => void>(() => {});

  // Typical tariffs from EVRace (not user settings)
  useEffect(() => {
    let cancelled = false;
    fetch('/api/evrace/tariffs', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data?.operators) ? data.operators : [];
        setEvraceTariffs(
          list.map((o: any) => ({
            id: String(o.id || ''),
            name: String(o.name || o.id || ''),
            dcDay: o.dcDay ?? null,
            dcNight: o.dcNight ?? null,
            acDay: o.acDay ?? null,
            asOf: o.asOf ?? null,
            floor: o.floor ?? null,
          })),
        );
      })
      .catch(() => {
        /* keep empty — UI shows «нет в EVRace» */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Sync filters when profile changes
  useEffect(() => {
    const next: ConnFilter[] = [];
    if (profileConnectors.includes('ccs2')) next.push('ccs2');
    if (profileConnectors.includes('gbt')) next.push('gbt');
    if (profileConnectors.includes('type2')) next.push('type2');
    if (next.length) setConnFilters(next);
  }, [profileConnectors.join(',')]);

  const tariff = selected
    ? tariffFromEvrace(
        selected.operator,
        evraceTariffs,
        selected.hasCcs2 || selected.hasGbt,
      )
    : null;

  const toggleFilter = (f: ConnFilter) => {
    setConnFilters((prev) => {
      if (prev.includes(f)) {
        const next = prev.filter((x) => x !== f);
        return next.length ? next : prev; // keep at least one
      }
      return [...prev, f];
    });
    triggerHaptic('light', settings.hapticFeedback);
  };

  const matchesFilters = useCallback(
    (s: MapStation) => {
      const typeOk =
        (connFilters.includes('ccs2') && s.hasCcs2) ||
        (connFilters.includes('gbt') && s.hasGbt) ||
        (connFilters.includes('type2') && s.hasType2);
      if (!typeOk) return false;
      if (onlyFree) {
        if (!s.liveChecked) return false;
        const free =
          (connFilters.includes('ccs2') && (s.freeCcs ?? 0) > 0) ||
          (connFilters.includes('gbt') && (s.freeGbt ?? 0) > 0) ||
          (connFilters.includes('type2') && (s.freeType2 ?? 0) > 0);
        return free;
      }
      return true;
    },
    [connFilters, onlyFree],
  );

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
        if (list.length > 120) list = list.slice(0, 120);

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
        const b = mapRef.current.getBounds();
        if (b) void fetchStationsInBounds(b);
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


  // Init map
  useEffect(() => {
    let cancelled = false;
    loadYandexMaps()
      .then((ymaps) => {
        if (cancelled || !containerRef.current) return;
        ymapsRef.current = ymaps;
        const map = new ymaps.Map(
          containerRef.current,
          {
            center: [53.9, 27.5667],
            zoom: 12,
            controls: ['zoomControl'],
            type: isDark ? undefined : 'yandex#map',
          },
          {
            suppressMapOpenBlock: false,
            yandexMapDisablePoiInteractivity: true,
          },
        );
        applyMapTheme(ymaps, map, isDark);
        mapRef.current = map;
        const om = new ymaps.ObjectManager({
          clusterize: true,
          gridSize: 72,
          clusterDisableClickZoom: false,
          geoObjectOpenBalloonOnClick: false,
        });
        om.objects.options.set({
          preset: 'islands#circleDotIcon',
          iconColor: '#22d3ee',
        });
        om.clusters.options.set({
          preset: 'islands#invertedCyanClusterIcons',
          hasBalloon: false,
        });
        map.geoObjects.add(om);
        objectManagerRef.current = om;

        om.objects.events.add('click', (e: any) => {
          const id = e.get('objectId');
          const st = stationsRef.current.find((s) => s.id === id);
          if (st) {
            setSelected(st);
            triggerHaptic('light', settings.hapticFeedback);
            if (!st.liveChecked) refreshLiveRef.current(st);
          }
        });

        // Fetch only when user finishes pan/zoom — not on every frame of movement
        map.events.add('actionend', () => scheduleFetch());
        scheduleFetch();

        // Try geolocation center
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              if (cancelled || !mapRef.current) return;
              mapRef.current.setCenter([pos.coords.latitude, pos.coords.longitude], 13, {
                duration: 300,
              });
              scheduleFetch();
            },
            () => {},
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
          );
        }
      })
      .catch(() => setError('Не удалось загрузить карту'));

    return () => {
      cancelled = true;
      if (fetchTimerRef.current) window.clearTimeout(fetchTimerRef.current);
      mapRef.current?.destroy?.();
      mapRef.current = null;
      objectManagerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update markers when stations / filters change
  useEffect(() => {
    const om = objectManagerRef.current;
    if (!om) return;
    const visible = stations.filter(matchesFilters);
    const features = visible.map((s) => {
      let color = '#22d3ee'; // cyan — DC present, live unknown
      if (s.liveChecked) {
        const free =
          (connFilters.includes('ccs2') && (s.freeCcs ?? 0) > 0) ||
          (connFilters.includes('gbt') && (s.freeGbt ?? 0) > 0) ||
          (connFilters.includes('type2') && (s.freeType2 ?? 0) > 0);
        color = free ? '#34d399' : '#fb7185';
      } else if (!s.hasCcs2 && !s.hasGbt && s.hasType2) {
        color = '#a78bfa';
      }
      return {
        type: 'Feature',
        id: s.id,
        geometry: { type: 'Point', coordinates: [s.lat, s.lon] },
        properties: {
          hintContent: s.name,
          // Larger hit target via circleDot (more visible than tiny dots)
        },
        options: {
          preset: 'islands#circleDotIcon',
          iconColor: color,
        },
      };
    });
    om.removeAll();
    om.add({ type: 'FeatureCollection', features });
  }, [stations, matchesFilters, connFilters]);

  const goToMe = () => {
    if (!navigator.geolocation || !mapRef.current) return;
    triggerHaptic('light', settings.hapticFeedback);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        mapRef.current?.setCenter([pos.coords.latitude, pos.coords.longitude], 14, {
          duration: 400,
        });
        scheduleFetch();
      },
      () => setError('Геолокация недоступна'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
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
    const parts: string[] = [];
    if (s.hasCcs2 && s.ccs2PowerKw) parts.push(`CCS ${Math.round(s.ccs2PowerKw)} кВт`);
    if (s.hasGbt && s.gbtPowerKw) parts.push(`GB/T ${Math.round(s.gbtPowerKw)} кВт`);
    if (s.hasType2 && s.type2PowerKw) parts.push(`Type2 ${Math.round(s.type2PowerKw)} кВт`);
    if (!parts.length && s.ccs2PowerKw) parts.push(`${Math.round(s.ccs2PowerKw)} кВт`);
    return parts.join(' · ') || 'мощность н/д';
  };

  const visibleCount = stations.filter(matchesFilters).length;

  return (
    <div className="relative h-[calc(100dvh-8.5rem)] min-h-[420px] w-full overflow-hidden rounded-2xl border border-slate-800/60">
      <div ref={containerRef} className="absolute inset-0 bg-slate-900" />

      {/* Top controls */}
      <div className="absolute left-2 right-2 top-2 z-20 flex items-start gap-2 pointer-events-none">
        <div
          className={`pointer-events-auto flex flex-1 flex-wrap items-center gap-1.5 rounded-xl px-2 py-1.5 backdrop-blur-md ${
            isDark ? 'bg-slate-950/85 text-slate-100' : 'bg-white/90 text-slate-900 shadow'
          }`}
        >
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold ${
              filtersOpen ? 'bg-cyan-600 text-white' : isDark ? 'bg-slate-800' : 'bg-slate-100'
            }`}
          >
            <Filter className="h-3.5 w-3.5" />
            Фильтры
          </button>
          {connFilters.map((f) => (
            <span
              key={f}
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                isDark ? 'bg-cyan-950 text-cyan-300' : 'bg-cyan-50 text-cyan-700'
              }`}
            >
              {f === 'ccs2' ? 'CCS' : f === 'gbt' ? 'GB/T' : 'Type2'}
            </span>
          ))}
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
          className={`pointer-events-auto rounded-xl p-2 backdrop-blur-md ${
            isDark ? 'bg-slate-950/85 text-cyan-400' : 'bg-white/90 text-cyan-600 shadow'
          }`}
          title="Моё местоположение"
        >
          <LocateFixed className="h-5 w-5" />
        </button>
      </div>

      {/* Filter sheet */}
      {filtersOpen && (
        <div
          className={`absolute left-2 right-2 top-14 z-20 rounded-2xl p-3 backdrop-blur-md ${
            isDark ? 'bg-slate-950/95 border border-slate-700' : 'bg-white/95 border border-slate-200 shadow-lg'
          }`}
        >
          <p className={`mb-2 text-[11px] font-bold uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            Разъём
          </p>
          <div className="mb-3 flex flex-wrap gap-2">
            {(
              [
                ['ccs2', 'CCS2'],
                ['gbt', 'GB/T'],
                ['type2', 'Type2'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => toggleFilter(id)}
                className={`rounded-full px-3 py-1.5 text-[12px] font-semibold ${
                  connFilters.includes(id)
                    ? 'bg-cyan-600 text-white'
                    : isDark
                      ? 'bg-slate-800 text-slate-300'
                      : 'bg-slate-100 text-slate-600'
                }`}
              >
                {label}
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
          <p className={`mt-2 text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            По умолчанию — порты профиля авто. Можно изменить вручную.
          </p>
        </div>
      )}

      {(loading || liveBusy) && (
        <div className="absolute bottom-24 left-1/2 z-20 -translate-x-1/2 rounded-full bg-slate-950/80 px-3 py-1.5 text-[11px] text-slate-200 backdrop-blur">
          <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" />
          Обновление…
        </div>
      )}

      {error && (
        <div className="absolute bottom-24 left-2 right-2 z-20 rounded-xl bg-rose-950/90 px-3 py-2 text-[11px] text-rose-200">
          {error}
        </div>
      )}

      {/* Selected station card — fixed above bottom nav */}
      {selected && (
        <div
          className={`fixed left-3 right-3 z-40 mx-auto max-w-lg rounded-2xl border p-3 shadow-2xl backdrop-blur-md ${
            isDark
              ? 'border-slate-700 bg-slate-950/95 text-slate-100'
              : 'border-slate-200 bg-white/95 text-slate-900'
          }`}
          style={{
            bottom: 'calc(4.75rem + env(safe-area-inset-bottom, 0px))',
            maxHeight: 'min(52dvh, 420px)',
            overflowY: 'auto',
          }}
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
                  className={`shrink-0 rounded-lg p-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Free ports — primary info on tap */}
              <div className="mt-2">
                <span className={`block text-[10px] font-bold uppercase tracking-wide mb-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  Свободные порты
                  {liveBusy && !selected.liveChecked ? ' · обновление…' : ''}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {portChips(selected).map((chip) => {
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
                        {chip.live
                          ? ` ${chip.free ?? 0}/${chip.total ?? '—'}`
                          : ''}
                      </span>
                    );
                  })}
                  {!portChips(selected).length && (
                    <span className={`text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>—</span>
                  )}
                </div>
              </div>

              <div className={`mt-2 grid grid-cols-3 gap-2 text-[11px] ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                <div className={`rounded-xl px-2.5 py-2 ${isDark ? 'bg-slate-900' : 'bg-slate-50'}`}>
                  <span className={`block text-[10px] uppercase ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    Оператор
                  </span>
                  <span className="font-semibold truncate block">{selected.operator || '—'}</span>
                </div>
                <div className={`rounded-xl px-2.5 py-2 ${isDark ? 'bg-slate-900' : 'bg-slate-50'}`}>
                  <span className={`block text-[10px] uppercase ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    Мощность
                  </span>
                  <span className="font-semibold">{powerLine(selected)}</span>
                </div>
                <div className={`rounded-xl px-2.5 py-2 ${isDark ? 'bg-slate-900' : 'bg-slate-50'}`}>
                  <span className={`block text-[10px] uppercase ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    Тариф
                  </span>
                  <span className="font-semibold">
                    {tariff?.rate != null
                      ? `${String(tariff.rate).replace('.', ',')} BYN`
                      : 'н/д'}
                  </span>
                </div>
              </div>
              {tariff?.period && (
                <p className={`mt-1 text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  {tariff.label} · {tariff.period}
                  {tariff.asOf ? ` · ${tariff.asOf}` : ''}
                </p>
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
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-yellow-500 py-2.5 text-[13px] font-black text-slate-950 active:scale-[0.98]"
              >
                <Navigation className="h-4 w-4" />
                Яндекс Навигатор
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
