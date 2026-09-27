import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RoutePoint } from '../services/routeElevation';
import {
  createBestMap,
  makeDotMarkerEl,
  makeLabelMarkerEl,
  makeNavArrowEl,
  scrubYandexOpenMapsPromo,
  toLonLat,
  type AnyMapBundle,
} from '../utils/yandexMaps';

export interface RouteMapChargingStop {
  lat: number;
  lon: number;
  name: string;
  address?: string;
  /** Optional id to match station in parent state when marker is tapped. */
  id?: string;
}

interface RouteMapProps {
  points: RoutePoint[];
  isDark: boolean;
  chargingStop?: RouteMapChargingStop | null;
  chargingStops?: RouteMapChargingStop[];
  currentPosition?: { lat: number; lon: number } | null;
  /** Compass heading 0–359° for nav-style map rotation (API v3). */
  headingDeg?: number | null;
  /** Keep map centered on currentPosition with closer zoom (HUD follow). */
  followMode?: boolean;
  compact?: boolean;
  fill?: boolean;
  /** Fired when user taps a charging-stop marker on the map. */
  onChargingStopClick?: (stop: RouteMapChargingStop) => void;
}

export const RouteMap: React.FC<RouteMapProps> = ({
  points,
  isDark,
  chargingStop,
  chargingStops,
  currentPosition = null,
  headingDeg = null,
  followMode = false,
  compact = false,
  fill = false,
  onChargingStopClick,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const bundleRef = useRef<AnyMapBundle | null>(null);
  const featureRef = useRef<any>(null);
  const outlineFeatureRef = useRef<any>(null);
  const traveledFeatureRef = useRef<any>(null);
  const startMarkerRef = useRef<any>(null);
  const endMarkerRef = useRef<any>(null);
  const currentPosMarkerRef = useRef<any>(null);
  const chargerMarkersRef = useRef<any[]>([]);
  const [loadError, setLoadError] = useState('');
  const [mapReady, setMapReady] = useState(false);
  /** After user pans/zooms, pause GPS follow so gestures are not fought. */
  const userNavPauseUntilRef = useRef(0);
  const lastAppliedHeadingRef = useRef<number | null>(null);

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
      showZoom: true,
    })
      .then((bundle) => {
        if (cancelled) {
          bundle.destroy();
          return;
        }
        bundleRef.current = bundle;
        setMapReady(true);
        // Allow pan/zoom: pause followMode briefly after user gesture
        const el = containerRef.current;
        const pauseFollow = () => {
          userNavPauseUntilRef.current = Date.now() + 8000;
        };
        if (el) {
          el.addEventListener('pointerdown', pauseFollow, { passive: true });
          el.addEventListener('wheel', pauseFollow, { passive: true });
          el.addEventListener('touchstart', pauseFollow, { passive: true });
          (bundle as any)._vigoPauseFollow = pauseFollow;
          (bundle as any)._vigoPauseEl = el;
        }
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Ошибка карты'));

    return () => {
      cancelled = true;
      featureRef.current = null;
      startMarkerRef.current = null;
      endMarkerRef.current = null;
      currentPosMarkerRef.current = null;
      chargerMarkersRef.current = [];
      try {
        const b = bundleRef.current as any;
        const el = b?._vigoPauseEl as HTMLElement | undefined;
        const fn = b?._vigoPauseFollow as (() => void) | undefined;
        if (el && fn) {
          el.removeEventListener('pointerdown', fn);
          el.removeEventListener('wheel', fn);
          el.removeEventListener('touchstart', fn);
        }
      } catch { /* ignore */ }
      bundleRef.current?.destroy();
      bundleRef.current = null;
      setMapReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bundleRef.current?.setTheme(isDark);
  }, [isDark]);

  // Extra pass: promo block is sometimes injected outside the map instance root.
  useEffect(() => {
    if (!mapReady) return;
    const root =
      containerRef.current?.closest('.route-map-shell') ||
      containerRef.current ||
      undefined;
    return scrubYandexOpenMapsPromo(root as HTMLElement | undefined);
  }, [mapReady]);

  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle || !mapReady || positions.length < 2) return;
    const map = (bundle as any).map;

    removeObj(bundle, featureRef.current);
    removeObj(bundle, outlineFeatureRef.current);
    removeObj(bundle, traveledFeatureRef.current);
    removeObj(bundle, startMarkerRef.current);
    removeObj(bundle, endMarkerRef.current);
    featureRef.current = null;
    outlineFeatureRef.current = null;
    traveledFeatureRef.current = null;
    startMarkerRef.current = null;
    endMarkerRef.current = null;

    let cancelled = false;
    let timer: number | null = null;

    const strokeMain = isDark ? 'rgba(34, 211, 238, 0.95)' : 'rgba(6, 182, 212, 0.95)';
    const strokeOutline = isDark ? 'rgba(15, 23, 42, 0.55)' : 'rgba(255, 255, 255, 0.65)';

    // Draw-in animation A→B unless actively following GPS (HUD trip).
    // Pre-start HUD uses fill=true but followMode=false — still animate.
    const animateDraw = !followMode;
    const frames = compact ? 22 : 56;
    const step = Math.max(1, Math.ceil((positions.length - 2) / frames));
    let count = animateDraw ? Math.min(2, positions.length) : positions.length;

    if (bundle.apiVersion === 3) {
      const ymaps3 = (bundle as any).ymaps3;
      const { YMapFeature, YMapMarker } = ymaps3;
      const lonLatPath = positions.map(([la, lo]) => toLonLat(la, lo));

      const outline = new YMapFeature({
        geometry: { type: 'LineString', coordinates: lonLatPath.slice(0, count) },
        style: { stroke: [{ width: 7, color: strokeOutline }] },
      });
      map.addChild(outline);
      outlineFeatureRef.current = outline;

      const feature = new YMapFeature({
        geometry: { type: 'LineString', coordinates: lonLatPath.slice(0, count) },
        style: { stroke: [{ width: 4.5, color: strokeMain }] },
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

      if (!followMode) {
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
          bundle.setLocation(start![0], start![1], 11);
        }
      }

      if (animateDraw) {
        timer = window.setInterval(() => {
          if (cancelled || !featureRef.current) {
            if (timer) window.clearInterval(timer);
            return;
          }
          count = Math.min(positions.length, count + step);
          const slice = lonLatPath.slice(0, count);
          try {
            outlineFeatureRef.current?.update?.({
              geometry: { type: 'LineString', coordinates: slice },
            });
          } catch { /* ignore */ }
          try {
            featureRef.current.update({
              geometry: { type: 'LineString', coordinates: slice },
            });
          } catch {
            try {
              featureRef.current.geometry = { type: 'LineString', coordinates: slice };
            } catch { /* ignore */ }
          }
          if (count >= positions.length && timer) {
            window.clearInterval(timer);
            timer = null;
          }
        }, compact ? 16 : 28);
      }
    } else {
      const ymaps = (bundle as any).ymaps;
      const outline = new ymaps.Polyline(
        positions.slice(0, count),
        {},
        {
          strokeColor: isDark ? '#0f172a' : '#ffffff',
          strokeWidth: 7,
          strokeOpacity: 0.55,
        },
      );
      map.geoObjects.add(outline);
      outlineFeatureRef.current = outline;

      const polyline = new ymaps.Polyline(
        positions.slice(0, count),
        {},
        { strokeColor: '#06b6d4', strokeWidth: 5, strokeOpacity: 0.95 },
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
      if (!followMode) {
        try {
          const lats = positions.map(([la]) => la);
          const lons = positions.map(([, lo]) => lo);
          map.setBounds(
            [
              [Math.min(...lats), Math.min(...lons)],
              [Math.max(...lats), Math.max(...lons)],
            ],
            { checkZoomRange: true, zoomMargin: 36 },
          );
        } catch { /* ignore */ }
      }

      if (animateDraw) {
        timer = window.setInterval(() => {
          if (cancelled || !featureRef.current) {
            if (timer) window.clearInterval(timer);
            return;
          }
          count = Math.min(positions.length, count + step);
          try {
            outlineFeatureRef.current?.geometry?.setCoordinates?.(positions.slice(0, count));
          } catch { /* ignore */ }
          try {
            featureRef.current.geometry.setCoordinates(positions.slice(0, count));
          } catch { /* ignore */ }
          if (count >= positions.length && timer) {
            window.clearInterval(timer);
            timer = null;
          }
        }, compact ? 16 : 28);
      }
    }

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      removeObj(bundle, featureRef.current);
      removeObj(bundle, outlineFeatureRef.current);
      removeObj(bundle, traveledFeatureRef.current);
      removeObj(bundle, startMarkerRef.current);
      removeObj(bundle, endMarkerRef.current);
      featureRef.current = null;
      outlineFeatureRef.current = null;
      traveledFeatureRef.current = null;
      startMarkerRef.current = null;
      endMarkerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, JSON.stringify(positions), compact, fill, followMode, isDark]);

  // Progress: only after the car has clearly moved along the path (avoid full-route gray at start).
  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle || !mapReady || positions.length < 2) return;
    if (!followMode || !currentPosition) {
      // Restore full bright route if leaving follow
      if (featureRef.current && bundle.apiVersion === 3) {
        try {
          const lonLatPath = positions.map(([la, lo]) => toLonLat(la, lo));
          featureRef.current.update({
            geometry: { type: 'LineString', coordinates: lonLatPath },
            style: {
              stroke: [
                {
                  width: 4.5,
                  color: isDark ? 'rgba(34, 211, 238, 0.95)' : 'rgba(6, 182, 212, 0.95)',
                },
              ],
            },
          });
        } catch { /* ignore */ }
      }
      removeObj(bundle, traveledFeatureRef.current);
      traveledFeatureRef.current = null;
      return;
    }

    let bestIdx = 0;
    let bestD = Infinity;
    for (let i = 0; i < positions.length; i++) {
      const dLat = positions[i][0] - currentPosition.lat;
      const dLon = positions[i][1] - currentPosition.lon;
      const d = dLat * dLat + dLon * dLon;
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }

    // Require meaningful progress along polyline (not just "nearest is index 0/1")
    const progressRatio = bestIdx / Math.max(1, positions.length - 1);
    if (bestIdx < 3 && progressRatio < 0.02) {
      removeObj(bundle, traveledFeatureRef.current);
      traveledFeatureRef.current = null;
      return;
    }

    const map = (bundle as any).map;
    const traveledPos = positions.slice(0, Math.max(2, bestIdx + 1));
    const remainingPos = positions.slice(Math.max(0, bestIdx));
    if (remainingPos.length < 2) return;

    const strokeMain = isDark ? 'rgba(34, 211, 238, 0.95)' : 'rgba(6, 182, 212, 0.95)';
    const strokeTraveled = isDark ? 'rgba(100, 116, 139, 0.75)' : 'rgba(148, 163, 184, 0.8)';

    removeObj(bundle, traveledFeatureRef.current);
    traveledFeatureRef.current = null;

    if (bundle.apiVersion === 3) {
      const { YMapFeature } = (bundle as any).ymaps3;
      if (traveledPos.length >= 2) {
        const traveled = new YMapFeature({
          geometry: {
            type: 'LineString',
            coordinates: traveledPos.map(([la, lo]) => toLonLat(la, lo)),
          },
          style: { stroke: [{ width: 4.5, color: strokeTraveled }] },
        });
        map.addChild(traveled);
        traveledFeatureRef.current = traveled;
      }
      if (featureRef.current) {
        try {
          featureRef.current.update({
            geometry: {
              type: 'LineString',
              coordinates: remainingPos.map(([la, lo]) => toLonLat(la, lo)),
            },
            style: { stroke: [{ width: 4.5, color: strokeMain }] },
          });
        } catch { /* ignore */ }
      }
    } else {
      const ymaps = (bundle as any).ymaps;
      if (traveledPos.length >= 2) {
        const traveled = new ymaps.Polyline(
          traveledPos,
          {},
          { strokeColor: '#94a3b8', strokeWidth: 5, strokeOpacity: 0.8 },
        );
        map.geoObjects.add(traveled);
        traveledFeatureRef.current = traveled;
      }
      if (featureRef.current?.geometry?.setCoordinates) {
        try {
          featureRef.current.geometry.setCoordinates(remainingPos);
        } catch { /* ignore */ }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, currentPosition?.lat, currentPosition?.lon, followMode, JSON.stringify(positions), isDark]);

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
        el.style.cursor = 'pointer';
        if (onChargingStopClick) {
          el.addEventListener('click', (ev: Event) => {
            ev.stopPropagation();
            onChargingStopClick(stop);
          });
        }
        const m = new YMapMarker({ coordinates: toLonLat(stop.lat, stop.lon) }, el);
        map.addChild(m);
        chargerMarkersRef.current.push(m);
      } else {
        const ymaps = (bundle as any).ymaps;
        const m = new ymaps.Placemark(
          [stop.lat, stop.lon],
          { hintContent: stop.name, balloonContent: stop.name },
          { preset: 'islands#darkOrangeStretchyIcon', iconContent: '⚡' },
        );
        if (onChargingStopClick) {
          m.events.add('click', () => onChargingStopClick(stop));
        }
        map.geoObjects.add(m);
        chargerMarkersRef.current.push(m);
      }
    });

    return () => {
      chargerMarkersRef.current.forEach((m) => removeObj(bundle, m));
      chargerMarkersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, JSON.stringify(stops), onChargingStopClick]);

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
      const h =
        headingDeg != null && Number.isFinite(headingDeg)
          ? Number(headingDeg)
          : lastAppliedHeadingRef.current ?? 0;
      if (currentPosMarkerRef.current) {
        try {
          currentPosMarkerRef.current.update({ coordinates: coords });
        } catch {
          /* ignore */
        }
        // Refresh arrow rotation via DOM child when possible
        try {
          const root = currentPosMarkerRef.current?.element || currentPosMarkerRef.current?._element;
          const arrow = root?.querySelector?.('[data-vigo-nav-arrow]') as HTMLElement | null;
          if (arrow) arrow.style.transform = `translate(-50%,-50%) rotate(${h}deg)`;
        } catch {
          /* ignore */
        }
      } else {
        const { YMapMarker } = (bundle as any).ymaps3;
        const el = followMode ? makeNavArrowEl('#38bdf8', h) : makeDotMarkerEl('#38bdf8', 14, '#fff');
        const m = new YMapMarker({ coordinates: coords }, el);
        map.addChild(m);
        currentPosMarkerRef.current = m;
      }

      // Nav-style follow: center + rotate. Skip while user is panning/zooming.
      if (followMode && Date.now() >= userNavPauseUntilRef.current) {
        const hasHeading = headingDeg != null && Number.isFinite(headingDeg);
        // Smooth heading to reduce compass jitter (degrees → radians for API).
        let headingForMap = hasHeading ? Number(headingDeg) : lastAppliedHeadingRef.current;
        if (headingForMap != null && Number.isFinite(headingForMap)) {
          const prev = lastAppliedHeadingRef.current;
          if (prev != null) {
            let d = ((headingForMap - prev + 540) % 360) - 180;
            headingForMap = (prev + d * 0.35 + 360) % 360;
          }
          lastAppliedHeadingRef.current = headingForMap;
        }
        const azimuthRad =
          headingForMap != null && Number.isFinite(headingForMap)
            ? (headingForMap * Math.PI) / 180
            : undefined;
        try {
          // Keep current zoom if user changed it; only force center + azimuth.
          let zoom = 16;
          try {
            if (typeof map.zoom === 'number') zoom = map.zoom;
            else if (typeof map.location?.zoom === 'number') zoom = map.location.zoom;
          } catch { /* ignore */ }
          const loc: Record<string, unknown> = {
            center: coords,
            zoom,
            duration: 400,
          };
          if (azimuthRad != null) loc.azimuth = azimuthRad;
          map.setLocation(loc);
        } catch {
          try {
            if (azimuthRad != null && typeof map.setAzimuth === 'function') {
              map.setAzimuth(azimuthRad, { duration: 400 });
            }
            if (typeof map.setCenter === 'function') {
              map.setCenter(coords);
            } else {
              (bundle as any).setLocation?.(currentPosition.lat, currentPosition.lon, zoom as any);
            }
          } catch {
            try {
              (bundle as any).setLocation?.(currentPosition.lat, currentPosition.lon, 16);
            } catch {
              /* ignore */
            }
          }
        }
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

      // API 2.1: pan follow. Pause when user interacts; keep user zoom.
      if (followMode && Date.now() >= userNavPauseUntilRef.current) {
        try {
          const z = typeof map.getZoom === 'function' ? map.getZoom() : 16;
          map.setCenter(coords, z, { duration: 300 });
        } catch {
          try {
            (bundle as any).setLocation?.(currentPosition.lat, currentPosition.lon);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }, [mapReady, currentPosition?.lat, currentPosition?.lon, followMode, headingDeg]);

  return (
    <div
      className={`route-map-shell overflow-hidden ${fill ? 'route-map-shell--fill' : ''} ${
        isDark ? 'bg-slate-950 vigo-ymaps-dark' : 'bg-slate-100'
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
        {/* Hidden in fullscreen HUD (fill) — overlaps bottom trip telemetry */}
        {!fill && (
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
        )}
      </div>
    </div>
  );
};
