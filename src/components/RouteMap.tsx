import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RoutePoint } from '../services/routeElevation';
import { loadYandexMaps } from '../utils/yandexMaps';

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
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const ymapsRef = useRef<any>(null);
  const polylineRef = useRef<any>(null);
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

  // The animation is deliberately independent from the map's object lifecycle.
  // Yandex gets ONE Polyline instance; only its geometry coordinates are updated.
  // Markers are never recreated during animation and setBounds is called only once
  // when the route data changes.
  useEffect(() => {
    const map = mapRef.current;
    const ymaps = ymapsRef.current;
    if (!map || !ymaps || positions.length < 2) return;

    // Remove/recreate objects only when the route itself changes, never per animation frame.
    map.geoObjects.removeAll();
    polylineRef.current = null;

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
      map.geoObjects.add(
        new ymaps.Placemark(
          start,
          { hintContent: 'А' },
          {
            preset: 'islands#circleIcon',
            iconColor: '#22d3ee',
          },
        ),
      );
    }

    if (end) {
      map.geoObjects.add(
        new ymaps.Placemark(
          end,
          { hintContent: 'Б' },
          {
            preset: 'islands#circleIcon',
            iconColor: '#ef4444',
          },
        ),
      );
    }

    stops.forEach((stop, i) => {
      map.geoObjects.add(
        new ymaps.Placemark(
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
        ),
      );
    });

    // Fit the map exactly once for this route. Do not derive bounds from the
    // animated polyline because at this moment it contains only its first points.
    // Calculate the viewport from the COMPLETE route plus charging stops.
    const allBoundsPoints = [
      ...positions,
      ...stops.map((stop) => [stop.lat, stop.lon] as [number, number]),
    ];
    if (allBoundsPoints.length > 1) {
      const lats = allBoundsPoints.map(([lat]) => lat);
      const lons = allBoundsPoints.map(([, lon]) => lon);
      const bounds: [[number, number], [number, number]] = [
        [Math.min(...lats), Math.min(...lons)],
        [Math.max(...lats), Math.max(...lons)],
      ];
      map.setBounds(bounds, { checkZoomRange: true, zoomMargin: 28 });
    } else if (start) {
      map.setCenter(start, 12);
    }

    return () => {
      if (polylineRef.current === polyline) {
        polylineRef.current = null;
      }
    };
    // Route geometry / charging stops changed: rebuild objects once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, JSON.stringify(positions), JSON.stringify(stops)]);

  // Progressive draw-in: update the existing Yandex Polyline geometry.
  // No geoObjects.removeAll(), marker recreation, or setBounds() occurs here.
  useEffect(() => {
    const polyline = polylineRef.current;
    if (!polyline || positions.length < 2) return;

    let cancelled = false;
    const frames = 70;
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
    }, 28);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [positions, mapReady]);

  // Create the map once per mount.
  useEffect(() => {
    let cancelled = false;

    loadYandexMaps()
      .then((ymaps) => {
        if (cancelled || !containerRef.current) return;

        ymapsRef.current = ymaps;
        const map = new ymaps.Map(
          containerRef.current,
          {
            center: start || [53.9, 27.5667],
            zoom: 12,
            controls: ['zoomControl'],
          },
          {
            suppressMapOpenBlock: false,
            yandexMapDisablePoiInteractivity: true,
          },
        );

        mapRef.current = map;
        setMapReady(true);
      })
      .catch(() => setLoadError(true));

    return () => {
      cancelled = true;
      polylineRef.current = null;
      mapRef.current?.destroy?.();
      mapRef.current = null;
      ymapsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`route-map-shell overflow-hidden ${isDark ? 'bg-slate-950' : 'bg-slate-100'}`}>
      <div className="route-map">
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
