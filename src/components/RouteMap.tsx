import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RoutePoint } from '../services/routeElevation';
import {
  createBestMap,
  makeDotMarkerEl,
  makeLabelMarkerEl,
  toLonLat,
  type AnyMapBundle,
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
  const bundleRef = useRef<AnyMapBundle | null>(null);
  const featureRef = useRef<any>(null);
  const startMarkerRef = useRef<any>(null);
  const endMarkerRef = useRef<any>(null);
  const currentPosMarkerRef = useRef<any>(null);
  const chargerMarkersRef = useRef<any[]>([]);
  const [loadError, setLoadError] = useState('');
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

  const removeObj = (bundle: AnyMapBundle, obj: any) => {
    if (!obj) return;
    try {
      if (bundle.apiVersion === 3) (bundle as any).map.removeChild(obj);
      else (bundle as any).map.geoObjects.remove(obj);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    let cancelled = false;
    if (!containerRef.current) return;

    createBestMap(containerRef.current, {
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
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Ошибка карты'));

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

  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle || !mapReady || positions.length < 2) return;
    const map = (bundle as any).map;

    removeObj(bundle, featureRef.current);
    removeObj(bundle, startMarkerRef.current);
    removeObj(bundle, endMarkerRef.current);
    featureRef.current = null;
    startMarkerRef.current = null;
    endMarkerRef.current = null;

    if (bundle.apiVersion === 3) {
      const ymaps3 = (bundle as any).ymaps3;
      const { YMapFeature, YMapMarker } = ymaps3;
      const lonLatPath = positions.map(([la, lo]) => toLonLat(la, lo));
      const feature = new YMapFeature({
        geometry: { type: 'LineString', coordinates: lonLatPath },
        style: { stroke: [{ width: 5, color: 'rgba(6, 182, 212, 0.92)' }] },
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
      const lats = positions.map(([la]) => la);
      const lons = positions.map(([, lo]) => lo);
      try {
        map.setLocation({
          bounds: [
            toLonLat(Math.min(...lats), Math.min(...lons)),
            toLonLat(Math.max(...lats), Math.max(...lons)),
          ],
          duration: 0,
        });
      } catch {
        bundle.setLocation(start[0], start[1], 11);
      }
    } else {
      const ymaps = (bundle as any).ymaps;
      const polyline = new ymaps.Polyline(
        positions,
        {},
        { strokeColor: '#06b6d4', strokeWidth: 5, strokeOpacity: 0.92 },
      );
      map.geoObjects.add(polyline);
      featureRef.current = polyline;
      if (start) {
        const m = new ymaps.Placemark(
          start,
          { hintContent: 'А' },
          { preset: 'islands#circleIcon', iconColor: '#22d3ee' },
        );
        map.geoObjects.add(m);
        startMarkerRef.current = m;
      }
      if (end) {
        const m = new ymaps.Placemark(
          end,
          { hintContent: 'Б' },
          { preset: 'islands#circleIcon', iconColor: '#ef4444' },
        );
        map.geoObjects.add(m);
        endMarkerRef.current = m;
      }
      try {
        const lats = positions.map(([la]) => la);
        const lons = positions.map(([, lo]) => lo);
        map.setBounds(
          [
            [Math.min(...lats), Math.min(...lons)],
            [Math.max(...lats), Math.max(...lons)],
          ],
          { checkZoomRange: true, zoomMargin: 28 },
        );
      } catch {
        /* ignore */
      }
    }

    return () => {
      removeObj(bundle, featureRef.current);
      removeObj(bundle, startMarkerRef.current);
      removeObj(bundle, endMarkerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, JSON.stringify(positions)]);

  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle || !mapReady) return;
    const map = (bundle as any).map;

    chargerMarkersRef.current.forEach((m) => removeObj(bundle, m));
    chargerMarkersRef.current = [];

    stops.forEach((stop) => {
      if (bundle.apiVersion === 3) {
        const { YMapMarker } = (bundle as any).ymaps3;
        const el = makeLabelMarkerEl('⚡', '#fbbf24');
        el.title = stop.name;
        const m = new YMapMarker({ coordinates: toLonLat(stop.lat, stop.lon) }, el);
        map.addChild(m);
        chargerMarkersRef.current.push(m);
      } else {
        const ymaps = (bundle as any).ymaps;
        const m = new ymaps.Placemark(
          [stop.lat, stop.lon],
          { hintContent: stop.name },
          { preset: 'islands#darkOrangeStretchyIcon', iconContent: '⚡' },
        );
        map.geoObjects.add(m);
        chargerMarkersRef.current.push(m);
      }
    });

    return () => {
      chargerMarkersRef.current.forEach((m) => removeObj(bundle, m));
      chargerMarkersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, JSON.stringify(stops)]);

  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle || !mapReady) return;
    const map = (bundle as any).map;

    if (
      !currentPosition ||
      !Number.isFinite(currentPosition.lat) ||
      !Number.isFinite(currentPosition.lon)
    ) {
      removeObj(bundle, currentPosMarkerRef.current);
      currentPosMarkerRef.current = null;
      return;
    }

    if (bundle.apiVersion === 3) {
      const coords = toLonLat(currentPosition.lat, currentPosition.lon);
      if (currentPosMarkerRef.current) {
        try {
          currentPosMarkerRef.current.update({ coordinates: coords });
        } catch {
          /* ignore */
        }
      } else {
        const { YMapMarker } = (bundle as any).ymaps3;
        const m = new YMapMarker(
          { coordinates: coords },
          makeDotMarkerEl('#38bdf8', 14, '#fff'),
        );
        map.addChild(m);
        currentPosMarkerRef.current = m;
      }
    } else {
      const coords: [number, number] = [currentPosition.lat, currentPosition.lon];
      if (currentPosMarkerRef.current) {
        currentPosMarkerRef.current.geometry.setCoordinates(coords);
      } else {
        const ymaps = (bundle as any).ymaps;
        const m = new ymaps.Placemark(
          coords,
          { hintContent: 'Вы здесь' },
          { preset: 'islands#blueCircleDotIcon', iconColor: '#38bdf8' },
        );
        map.geoObjects.add(m);
        currentPosMarkerRef.current = m;
      }
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
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-rose-300 bg-slate-950/85 whitespace-pre-wrap">
            {loadError}
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
