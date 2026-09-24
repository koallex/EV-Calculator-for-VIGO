import React, { useEffect, useRef, useState } from 'react';
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
// legend sits top-left instead of bottom-left for the same reason: bottom-left is where
// Yandex's own controls render.
export const RouteMap: React.FC<RouteMapProps> = ({
  points,
  isDark,
  chargingStop,
  chargingStops,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const ymapsRef = useRef<any>(null);
  const [drawCount, setDrawCount] = useState(points.length);
  const [loadError, setLoadError] = useState(false);

  const positions = points.map((p) => [p.lat, p.lon] as [number, number]);
  const start = positions[0];
  const end = positions[positions.length - 1];
  const stops =
    chargingStops && chargingStops.length
      ? chargingStops
      : chargingStop
        ? [chargingStop]
        : [];

  // Same progressive draw-in animation as before, independent of the map provider.
  useEffect(() => {
    if (positions.length < 2) return;
    setDrawCount(2);
    const frames = 70;
    const step = Math.max(1, Math.ceil(positions.length / frames));
    let count = 2;
    const timer = window.setInterval(() => {
      count = Math.min(positions.length, count + step);
      setDrawCount(count);
      if (count >= positions.length) window.clearInterval(timer);
    }, 28);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points]);

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
      })
      .catch(() => setLoadError(true));

    return () => {
      cancelled = true;
      mapRef.current?.destroy?.();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw the route line, endpoint pins and charging-stop markers whenever the data or the
  // draw-in animation progresses.
  useEffect(() => {
    const map = mapRef.current;
    const ymaps = ymapsRef.current;
    if (!map || !ymaps) return;

    map.geoObjects.removeAll();

    const animatedPositions = positions.slice(0, drawCount);
    if (animatedPositions.length >= 2) {
      map.geoObjects.add(
        new ymaps.Polyline(animatedPositions, {}, {
          strokeColor: '#06b6d4',
          strokeWidth: 5,
          strokeOpacity: 0.92,
        }),
      );
    }

    if (start) {
      map.geoObjects.add(
        new ymaps.Placemark(start, { hintContent: 'А' }, {
          preset: 'islands#circleIcon',
          iconColor: '#22d3ee',
        }),
      );
    }
    if (end) {
      map.geoObjects.add(
        new ymaps.Placemark(end, { hintContent: 'Б' }, {
          preset: 'islands#circleIcon',
          iconColor: '#ef4444',
        }),
      );
    }

    stops.forEach((s, i) => {
      map.geoObjects.add(
        new ymaps.Placemark(
          [s.lat, s.lon],
          {
            balloonContentHeader: stops.length > 1 ? `${i + 1}. ${s.name}` : s.name,
            balloonContentBody: s.address || '',
            hintContent: s.name,
          },
          {
            preset: 'islands#darkOrangeStretchyIcon',
            iconContent: '⚡',
          },
        ),
      );
    });

    if (positions.length >= 2) {
      const bounds = map.geoObjects.getBounds();
      if (bounds) map.setBounds(bounds, { checkZoomRange: true, zoomMargin: 28 });
    } else if (start) {
      map.setCenter(start, 12);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawCount, JSON.stringify(stops), start?.[0], start?.[1], end?.[0], end?.[1]]);

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
