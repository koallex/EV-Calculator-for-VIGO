import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RoutePoint } from '../services/routeElevation';
import {
  applyMapTheme,
  bindDarkPanPerformance,
  createOptimizedMap,
  loadYandexMaps,
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
  /** Live GPS position (HUD tracking). */
  currentPosition?: { lat: number; lon: number } | null;
  /** Compact height for HUD embed. */
  compact?: boolean;
  /** Stretch to parent (fullscreen HUD background). */
  fill?: boolean;
}

// Renders the route on Yandex Maps. The map's logo, copyright and "Открыть в Яндекс Картах"
// control are left on deliberately (default `suppressMapOpenBlock: false`, no CSS hiding
// them) — the free-tier license requires all three to stay visible and unobstructed. Our own
// legend sits top-left instead of bottom-left for the same reason: bottom-left is where Yandex's
// own controls render.
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
  const mapRef = useRef<any>(null);
  const ymapsRef = useRef<any>(null);
  const polylineRef = useRef<any>(null);
  const currentPosMarkerRef = useRef<any>(null);
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

  // Route lifecycle is completely independent from charging-stop markers.
  // Adding/removing a charger must NEVER remove/recreate the route polyline or
  // restart its animation. This is important because the animation owns the
  // current Polyline instance while it progressively updates its geometry.
  const startMarkerRef = useRef<any>(null);
  const endMarkerRef = useRef<any>(null);
  const chargerMarkersRef = useRef<any[]>([]);

  // Build the route objects only when the actual route geometry changes.
  useEffect(() => {
    const map = mapRef.current;
    const ymaps = ymapsRef.current;
    if (!map || !ymaps || positions.length < 2) return;

    // Remove only the previous route objects. Charger markers are managed by
    // the separate effect below and are intentionally left untouched here.
    if (polylineRef.current) {
      map.geoObjects.remove(polylineRef.current);
      polylineRef.current = null;
    }
    if (startMarkerRef.current) {
      map.geoObjects.remove(startMarkerRef.current);
      startMarkerRef.current = null;
    }
    if (endMarkerRef.current) {
      map.geoObjects.remove(endMarkerRef.current);
      endMarkerRef.current = null;
    }

    const initialPositions = positions.slice(0, Math.min(2, positions.length));
    const polyline = new ymaps.Polyline(
      initialPositions,
      {},
      {
        strokeColor: '#06b6d4',
        strokeWidth: 5,
        strokeOpacity: 0.92,
      },
    );

    map.geoObjects.add(polyline);
    polylineRef.current = polyline;

    if (start) {
      const marker = new ymaps.Placemark(
        start,
        { hintContent: 'А' },
        {
          preset: 'islands#circleIcon',
          iconColor: '#22d3ee',
        },
      );
      map.geoObjects.add(marker);
      startMarkerRef.current = marker;
    }

    if (end) {
      const marker = new ymaps.Placemark(
        end,
        { hintContent: 'Б' },
        {
          preset: 'islands#circleIcon',
          iconColor: '#ef4444',
        },
      );
      map.geoObjects.add(marker);
      endMarkerRef.current = marker;
    }

    // Fit the map only when the route itself changes.
    const allRoutePoints = positions;
    if (allRoutePoints.length > 1) {
      const lats = allRoutePoints.map(([lat]) => lat);
      const lons = allRoutePoints.map(([, lon]) => lon);
      const bounds: [[number, number], [number, number]] = [
        [Math.min(...lats), Math.min(...lons)],
        [Math.max(...lats), Math.max(...lons)],
      ];
      map.setBounds(bounds, { checkZoomRange: true, zoomMargin: 28 });
    } else if (start) {
      map.setCenter(start, 12);
    }

    return () => {
      // Do not call removeAll() here. Only detach the route objects that this
      // effect owns. The charger effect and its markers remain independent.
      if (polylineRef.current === polyline) {
        map.geoObjects.remove(polyline);
        polylineRef.current = null;
      }
      if (startMarkerRef.current) {
        map.geoObjects.remove(startMarkerRef.current);
        startMarkerRef.current = null;
      }
      if (endMarkerRef.current) {
        map.geoObjects.remove(endMarkerRef.current);
        endMarkerRef.current = null;
      }
    };
    // Route geometry only. Charging stops deliberately excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, JSON.stringify(positions)]);

  // Charging markers have their own lifecycle. Changing charging stops never
  // touches the route Polyline, route markers, animation, or map bounds.
  useEffect(() => {
    const map = mapRef.current;
    const ymaps = ymapsRef.current;
    if (!map || !ymaps) return;

    chargerMarkersRef.current.forEach((marker) => {
      map.geoObjects.remove(marker);
    });
    chargerMarkersRef.current = [];

    stops.forEach((stop, i) => {
      const marker = new ymaps.Placemark(
        [stop.lat, stop.lon],
        {
          balloonContentHeader: stops.length > 1 ? `${i + 1}. ${stop.name}` : stop.name,
          balloonContentBody: stop.address || '',
          hintContent: stop.name,
        },
        {
          preset: 'islands#darkOrangeStretchyIcon',
          iconContent: '⚡',
        },
      );
      map.geoObjects.add(marker);
      chargerMarkersRef.current.push(marker);
    });

    return () => {
      chargerMarkersRef.current.forEach((marker) => {
        map.geoObjects.remove(marker);
      });
      chargerMarkersRef.current = [];
    };
    // Only charging stops control this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, JSON.stringify(stops)]);

  // Progressive draw-in: update the existing Yandex Polyline geometry.
  // No geoObjects.removeAll(), marker recreation, or setBounds() occurs here.
  useEffect(() => {
    const polyline = polylineRef.current;
    if (!polyline || positions.length < 2) return;

    let cancelled = false;
    const frames = compact ? 20 : 70;
    const step = Math.max(1, Math.ceil((positions.length - 2) / frames));
    let count = 2;

    polyline.geometry.setCoordinates(positions.slice(0, count));

    const timer = window.setInterval(() => {
      if (cancelled || !polylineRef.current) {
        window.clearInterval(timer);
        return;
      }

      count = Math.min(positions.length, count + step);
      polylineRef.current.geometry.setCoordinates(positions.slice(0, count));

      if (count >= positions.length) {
        window.clearInterval(timer);
      }
    }, compact ? 16 : 28);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [positions, mapReady, compact]);

  // Live GPS marker for HUD tracking — independent of route/chargers.
  useEffect(() => {
    const map = mapRef.current;
    const ymaps = ymapsRef.current;
    if (!map || !ymaps) return;

    if (!currentPosition || !Number.isFinite(currentPosition.lat) || !Number.isFinite(currentPosition.lon)) {
      if (currentPosMarkerRef.current) {
        map.geoObjects.remove(currentPosMarkerRef.current);
        currentPosMarkerRef.current = null;
      }
      return;
    }

    const coords: [number, number] = [currentPosition.lat, currentPosition.lon];
    if (currentPosMarkerRef.current) {
      currentPosMarkerRef.current.geometry.setCoordinates(coords);
    } else {
      const marker = new ymaps.Placemark(
        coords,
        { hintContent: 'Вы здесь' },
        {
          preset: 'islands#blueCircleDotIcon',
          iconColor: '#38bdf8',
        },
      );
      map.geoObjects.add(marker);
      currentPosMarkerRef.current = marker;
    }
  }, [mapReady, currentPosition?.lat, currentPosition?.lon]);

  // Create the map once per mount.
  useEffect(() => {
    let cancelled = false;

    loadYandexMaps()
      .then((ymaps) => {
        if (cancelled || !containerRef.current) return;

        ymapsRef.current = ymaps;
        const map = createOptimizedMap(ymaps, containerRef.current, {
          center: start || [53.9, 27.5667],
          zoom: 12,
          minZoom: 6,
          maxZoom: 17,
        });

        applyMapTheme(ymaps, map, isDark);
        const unbindDarkPan = isDark ? bindDarkPanPerformance(map) : () => {};
        (map as any).__vigoUnbindDarkPan = unbindDarkPan;
        mapRef.current = map;
        setMapReady(true);
      })
      .catch(() => setLoadError(true));

    return () => {
      cancelled = true;
      polylineRef.current = null;
      startMarkerRef.current = null;
      endMarkerRef.current = null;
      currentPosMarkerRef.current = null;
      chargerMarkersRef.current = [];
      try {
        (mapRef.current as any)?.__vigoUnbindDarkPan?.();
      } catch {
        /* ignore */
      }
      mapRef.current?.destroy?.();
      mapRef.current = null;
      ymapsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            Не удалось загрузить Яндекс Карты. Проверьте подключение и ключ API.
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
            <span>
              ⚡ {stops.length > 1 ? `${stops.length} остановки` : 'Зарядка'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
