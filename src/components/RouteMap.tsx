import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RoutePoint } from '../services/routeElevation';
import {
  createV3Map,
  makeDotMarkerEl,
  makeLabelMarkerEl,
  toLonLat,
  type V3MapBundle,
} from '../utils/yandexMaps';

export interface RouteMapChargingStop {
  lat: number;
  lon: number;
  name: string;
  address?: string;
}

interface RouteMapProps {
  points: RoutePoint[];
  isDark: boolean;
  /** @deprecated use chargingStops */
  chargingStop?: RouteMapChargingStop | null;
  chargingStops?: RouteMapChargingStop[];
  currentPosition?: { lat: number; lon: number } | null;
  compact?: boolean;
  fill?: boolean;
}

export const RouteMap: React.FC<RouteMapProps> = ({
  points,
  isDark,
  chargingStop,
  chargingStops,
  currentPosition = null,
  compact = false,
  fill = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const bundleRef = useRef<V3MapBundle | null>(null);
  const featureRef = useRef<any>(null);
  const startMarkerRef = useRef<any>(null);
  const endMarkerRef = useRef<any>(null);
  const currentPosMarkerRef = useRef<any>(null);
  const chargerMarkersRef = useRef<any[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [mapReady, setMapReady] = useState(false);

  const positions = useMemo(
    () => points.map((p) => [p.lat, p.lon] as [number, number]),
    [points],
  );
  const start = positions[0];
  const end = positions[positions.length - 1];
  const stops =
    chargingStops && chargingStops.length
      ? chargingStops
      : chargingStop
        ? [chargingStop]
        : [];

  // Create map once
  useEffect(() => {
    let cancelled = false;
    if (!containerRef.current) return;

    createV3Map(containerRef.current, {
      lat: start?.[0] ?? 53.9,
      lon: start?.[1] ?? 27.5667,
      zoom: 12,
      isDark,
    })
      .then((bundle) => {
        if (cancelled) {
          bundle.destroy();
          return;
        }
        bundleRef.current = bundle;
        setMapReady(true);
      })
      .catch(() => setLoadError(true));

    return () => {
      cancelled = true;
      featureRef.current = null;
      startMarkerRef.current = null;
      endMarkerRef.current = null;
      currentPosMarkerRef.current = null;
      chargerMarkersRef.current = [];
      bundleRef.current?.destroy();
      bundleRef.current = null;
      setMapReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bundleRef.current?.setTheme(isDark);
  }, [isDark]);

  // Route line + A/B markers
  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle || !mapReady || positions.length < 2) return;
    const { ymaps3, map } = bundle;
    const { YMapFeature, YMapMarker } = ymaps3;

    const removeChild = (child: any) => {
      if (!child) return;
      try {
        map.removeChild(child);
      } catch {
        /* ignore */
      }
    };

    removeChild(featureRef.current);
    removeChild(startMarkerRef.current);
    removeChild(endMarkerRef.current);
    featureRef.current = null;
    startMarkerRef.current = null;
    endMarkerRef.current = null;

    const lonLatPath = positions.map(([la, lo]) => toLonLat(la, lo));
    const feature = new YMapFeature({
      geometry: {
        type: 'LineString',
        coordinates: lonLatPath,
      },
      style: {
        stroke: [{ width: 5, color: 'rgba(6, 182, 212, 0.92)' }],
      },
    });
    map.addChild(feature);
    featureRef.current = feature;

    if (start) {
      const m = new YMapMarker(
        { coordinates: toLonLat(start[0], start[1]) },
        makeLabelMarkerEl('А', '#22d3ee'),
      );
      map.addChild(m);
      startMarkerRef.current = m;
    }
    if (end) {
      const m = new YMapMarker(
        { coordinates: toLonLat(end[0], end[1]) },
        makeLabelMarkerEl('Б', '#f87171'),
      );
      map.addChild(m);
      endMarkerRef.current = m;
    }

    // Fit bounds
    const lats = positions.map(([la]) => la);
    const lons = positions.map(([, lo]) => lo);
    const sw = toLonLat(Math.min(...lats), Math.min(...lons));
    const ne = toLonLat(Math.max(...lats), Math.max(...lons));
    try {
      map.setLocation({
        bounds: [sw, ne],
        duration: 0,
      });
    } catch {
      map.setLocation({
        center: toLonLat(start![0], start![1]),
        zoom: 11,
      });
    }

    return () => {
      removeChild(feature);
      removeChild(startMarkerRef.current);
      removeChild(endMarkerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, JSON.stringify(positions)]);

  // Charging stop markers
  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle || !mapReady) return;
    const { ymaps3, map } = bundle;
    const { YMapMarker } = ymaps3;

    chargerMarkersRef.current.forEach((m) => {
      try {
        map.removeChild(m);
      } catch {
        /* ignore */
      }
    });
    chargerMarkersRef.current = [];

    stops.forEach((stop) => {
      const el = makeLabelMarkerEl('⚡', '#fbbf24');
      el.title = stop.name;
      const m = new YMapMarker(
        { coordinates: toLonLat(stop.lat, stop.lon) },
        el,
      );
      map.addChild(m);
      chargerMarkersRef.current.push(m);
    });

    return () => {
      chargerMarkersRef.current.forEach((m) => {
        try {
          map.removeChild(m);
        } catch {
          /* ignore */
        }
      });
      chargerMarkersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, JSON.stringify(stops)]);

  // Live GPS
  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle || !mapReady) return;
    const { ymaps3, map } = bundle;
    const { YMapMarker } = ymaps3;

    if (
      !currentPosition ||
      !Number.isFinite(currentPosition.lat) ||
      !Number.isFinite(currentPosition.lon)
    ) {
      if (currentPosMarkerRef.current) {
        try {
          map.removeChild(currentPosMarkerRef.current);
        } catch {
          /* ignore */
        }
        currentPosMarkerRef.current = null;
      }
      return;
    }

    const coords = toLonLat(currentPosition.lat, currentPosition.lon);
    if (currentPosMarkerRef.current) {
      try {
        currentPosMarkerRef.current.update({ coordinates: coords });
      } catch {
        /* ignore */
      }
    } else {
      const m = new YMapMarker(
        { coordinates: coords },
        makeDotMarkerEl('#38bdf8', 14, '#fff'),
      );
      map.addChild(m);
      currentPosMarkerRef.current = m;
    }
  }, [mapReady, currentPosition?.lat, currentPosition?.lon]);

  return (
    <div
      className={`route-map-shell overflow-hidden ${fill ? 'route-map-shell--fill' : ''} ${
        isDark ? 'bg-slate-950' : 'bg-slate-100'
      }`}
    >
      <div
        className={`route-map ${compact && !fill ? 'route-map--compact' : ''} ${
          fill ? 'route-map--fill' : ''
        }`}
      >
        <div ref={containerRef} className="route-map-yandex" />
        {loadError && (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-rose-300 bg-slate-950/85">
            Не удалось загрузить Яндекс Карты v3. Проверьте ключ и HTTP Referer.
          </div>
        )}
        <div className="route-map-legend">
          <span>
            <i className="route-dot route-dot-start" />А
          </span>
          <span>
            <i className="route-dot route-dot-end" />Б
          </span>
          {stops.length > 0 && (
            <span>⚡ {stops.length > 1 ? `${stops.length} остановки` : 'Зарядка'}</span>
          )}
        </div>
      </div>
    </div>
  );
};
