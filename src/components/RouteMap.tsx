import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RoutePoint } from '../services/routeElevation';
import {
  createBestMap,
  headingDegToAzimuthRad,
  makeDotMarkerEl,
  makeLabelMarkerEl,
  makeChargingMarkerEl,
  makeNavArrowEl,
  normalizeDeg180,
  scrubYandexOpenMapsPromo,
  toLonLat,
  type AnyMapBundle,
} from '../utils/yandexMaps';
import { TESLA_ROUTE_BLUE, TESLA_ROUTE_TRAVELED, TESLA_ROUTE_GLOW } from '../utils/mapStyleTesla';
import { HeadingFilter, headingDelta } from '../utils/headingFilter';
import {
  CourseSmoother,
  NAV_TILT_DEG,
  angleDelta,
  azimuthForCourse,
  azimuthSignFromNorthVector,
  routeHeadingAhead,
  smoothScalar,
  tiltRad,
  wrapPi,
  zoomForSpeed,
} from '../utils/navCamera';
import { Box, LocateFixed } from 'lucide-react';
import { insetsKey, type MapInsets } from '../utils/calculatorSheet';

const CAM3D_KEY = 'vigo_hud_cam3d_v1';
/** Gestures the app allows on route maps. Rotate/tilt are excluded: the navigation camera owns them. */
const ROUTE_MAP_BEHAVIORS = ['drag', 'pinchZoom', 'scrollZoom', 'dblClick'];

/**
 * Measures which way positive `azimuth` turns the map, on the real map, once.
 * Puts two invisible markers 150 m apart (A, and B due north of A), turns the camera to +90° and
 * reads where B lands relative to A on screen. Resolves 1 (positive = counter-clockwise),
 * −1 (positive = clockwise) or 0 when it could not be measured (then the caller must not rotate).
 */
async function probeAzimuthSign(bundle: any, container: HTMLElement): Promise<1 | -1 | 0> {
  if (bundle?.apiVersion !== 3) return 0;
  const map = bundle.map;
  const { YMapMarker } = bundle.ymaps3;
  const rect = container.getBoundingClientRect();
  if (rect.width < 120 || rect.height < 120) return 0; // hidden tab / not laid out yet
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

  let center: [number, number] = [27.5667, 53.9];
  try { if (map.center) center = [map.center[0], map.center[1]]; } catch { /* ignore */ }
  const mkEl = () => {
    const d = document.createElement('div');
    d.style.cssText = 'width:2px;height:2px;pointer-events:none;opacity:0;';
    return d;
  };
  const elA = mkEl();
  const elB = mkEl();
  const mA = new YMapMarker({ coordinates: center }, elA);
  const mB = new YMapMarker({ coordinates: [center[0], center[1] + 150 / 111320] }, elB);
  const prevOpacity = container.style.opacity;
  const prevTransition = container.style.transition;
  try {
    container.style.transition = 'none';
    container.style.opacity = '0'; // the probe turns the map by 90° — keep it off screen
    map.addChild(mA);
    map.addChild(mB);
    map.update({ camera: { azimuth: Math.PI / 2, tilt: 0, duration: 0 } });
    let result: 1 | -1 | 0 = 0;
    for (let attempt = 0; attempt < 4 && result === 0; attempt++) {
      await frame();
      await frame();
      await wait(90);
      const a = elA.getBoundingClientRect();
      const b = elB.getBoundingClientRect();
      result = azimuthSignFromNorthVector(b.left - a.left, b.top - a.top);
    }
    return result;
  } catch {
    return 0;
  } finally {
    try { map.update({ camera: { azimuth: 0, tilt: 0, duration: 0 } }); } catch { /* ignore */ }
    try { map.removeChild(mA); } catch { /* ignore */ }
    try { map.removeChild(mB); } catch { /* ignore */ }
    container.style.opacity = prevOpacity;
    container.style.transition = prevTransition;
  }
}

/** Токен последнего вписывания (v3): отменяет устаревший повтор на следующем кадре. */
let fitSeq = 0;

/**
 * Вписывает маршрут в карту с учётом закрытых карточками краёв (`insets`).
 * v3: margin карты сдвигает «видимое окно», границы считает сама карта.
 * v2.1: тот же эффект через zoomMargin.
 */
function fitRouteToView(
  bundle: AnyMapBundle,
  positions: Array<[number, number]>,
  insets: MapInsets | null,
  duration: number,
): void {
  if (positions.length < 2) return;
  const map = (bundle as any).map;
  const lats = positions.map(([la]) => la);
  const lons = positions.map(([, lo]) => lo);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  if (bundle.apiVersion === 3) {
    const seq = ++fitSeq;
    const bounds = [toLonLat(minLat, minLon), toLonLat(maxLat, maxLon)];
    if (insets) {
      try { map.update({ margin: [insets.top, insets.right, insets.bottom, insets.left] }); } catch { /* ignore */ }
    }
    map.setLocation({ bounds, duration });
    // Страховка: если карта применила margin уже после setLocation, повторяем вписывание на следующем кадре.
    // Токен не даёт устаревшему вызову перебить более свежий.
    if (duration === 0 && insets && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (seq !== fitSeq) return;
        try { map.setLocation({ bounds, duration: 0 }); } catch { /* ignore */ }
      });
    }
  } else {
    const m = insets
      ? [insets.top, insets.right, insets.bottom, insets.left].map((v) => Math.max(24, v))
      : 36;
    map.setBounds(
      [[minLat, minLon], [maxLat, maxLon]],
      { checkZoomRange: true, zoomMargin: m, duration },
    );
  }
}

export interface RouteMapChargingStop {
  lat: number;
  lon: number;
  name: string;
  address?: string;
  /** Optional id to match station in parent state when marker is tapped. */
  id?: string;
  /** Maximum known charging power at this station. */
  powerKw?: number;
  /** Planned/comfortable stop selected by the route charging algorithm. */
  isRecommended?: boolean;
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
  /**
   * Ground speed (km/h). Camera yaw freezes below ~10 km/h so stationary
   * GPS noise cannot spin the map.
   */
  moveSpeedKmH?: number | null;
  compact?: boolean;
  fill?: boolean;
  /** Fired when user taps a charging-stop marker on the map. */
  onChargingStopClick?: (stop: RouteMapChargingStop) => void;
  /**
   * Where to center the map while there is no route yet (e.g. device GPS on the calculator's
   * start screen). Ignored as soon as a route with 2+ points is drawn.
   */
  focusPoint?: { lat: number; lon: number } | null;
  /**
   * Сколько пикселей карты закрыто карточками поверх неё (верх/низ/лево/право). Если передано,
   * маршрут вписывается в оставшееся видимое окно, а не в весь размер карты. Не передано —
   * поведение прежнее (HUD не затронут).
   */
  viewportInsets?: MapInsets | null;
}

export const RouteMap: React.FC<RouteMapProps> = ({
  points,
  isDark,
  chargingStop,
  chargingStops,
  currentPosition = null,
  headingDeg = null,
  followMode = false,
  moveSpeedKmH = null,
  compact = false,
  fill = false,
  onChargingStopClick,
  focusPoint = null,
  viewportInsets = null,
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
  /** Last route progress index applied to polylines — skip redraw when unchanged. */
  const lastProgressIdxRef = useRef(-1);
  /** Continuous follow loop (does not restart on every GPS tick). */
  const followLoopRafRef = useRef<number | null>(null);
  const followTargetRef = useRef<{
    lat: number;
    lon: number;
    heading: number | null;
  } | null>(null);
  /** Movement-based course (not compass / raw GPS heading). */
  const headingFilterRef = useRef(new HeadingFilter());
  /** Continuous camera azimuth in degrees — accumulates deltas (no 0↔360 flips). */
  const camAzimuthDegRef = useRef(0);
  const camAzimuthReadyRef = useRef(false);
  const displayPosRef = useRef<{ lat: number; lon: number } | null>(null);
  /** Heavily smoothed heading used for camera (deg). */
  const displayHeadingRef = useRef<number | null>(null);
  /** Last azimuth actually sent to the map (deg, -180..180). */
  const lastCameraHeadingDegRef = useRef<number | null>(null);
  const lastCameraPushMsRef = useRef(0);
  const lastCenterPushMsRef = useRef(0);
  const followModeRef = useRef(followMode);
  followModeRef.current = followMode;
  const moveSpeedRef = useRef(moveSpeedKmH);
  moveSpeedRef.current = moveSpeedKmH;
  /** Course-up camera state. */
  const courseRef = useRef(new CourseSmoother());
  const routeIdxHintRef = useRef<number | null>(null);
  /** null = not measured yet, 0 = measurement failed (no rotation), ±1 = measured. */
  const azimuthSignRef = useRef<1 | -1 | 0 | null>(null);
  const probingRef = useRef(false);
  const [cam3d, setCam3d] = useState(() => {
    try { return localStorage.getItem(CAM3D_KEY) !== '0'; } catch { return true; }
  });
  const cam3dRef = useRef(cam3d);
  cam3dRef.current = cam3d;
  /** True while the user has moved the map and follow is paused (drives the "recenter" button). */
  const [followPaused, setFollowPaused] = useState(false);

  const positions = useMemo(
    () => points.map((p) => [p.lat, p.lon] as [number, number]),
    [points],
  );
  /** Route polyline for stable course-up heading (preferred over noisy GPS). */
  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  /** Актуальные отступы для вписывания маршрута; ref, чтобы их смена не перерисовывала линию. */
  const insetsRef = useRef<MapInsets | null>(viewportInsets);
  insetsRef.current = viewportInsets;
  const insetsK = viewportInsets ? insetsKey(viewportInsets) : '';
  /** Ключ отступов, с которыми маршрут был вписан в последний раз. */
  const lastFitInsetsKeyRef = useRef('');

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
      behaviors: ROUTE_MAP_BEHAVIORS,
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
          if (followModeRef.current) setFollowPaused(true);
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

  // No route yet: keep the camera on the caller-provided point (GPS) instead of the Minsk default.
  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle || !mapReady || positions.length >= 2 || !focusPoint) return;
    if (!Number.isFinite(focusPoint.lat) || !Number.isFinite(focusPoint.lon)) return;
    try {
      bundle.setLocation(focusPoint.lat, focusPoint.lon, 12);
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, focusPoint?.lat, focusPoint?.lon, positions.length >= 2]);

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

    // Dark HUD: Tesla-like bright blue route + soft glow. Light theme keeps cyan accent.
    const strokeMain = isDark ? TESLA_ROUTE_BLUE : 'rgba(6, 182, 212, 0.95)';
    const strokeGlow = isDark ? TESLA_ROUTE_GLOW : 'rgba(6, 182, 212, 0.2)';
    const strokeOutline = isDark ? 'rgba(20, 23, 29, 0.75)' : 'rgba(255, 255, 255, 0.65)';
    const strokeTraveled = isDark ? TESLA_ROUTE_TRAVELED : '#94a3b8';

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

      // Underlay (outline) + glow + core — Tesla multi-stroke look
      const outline = new YMapFeature({
        geometry: { type: 'LineString', coordinates: lonLatPath.slice(0, count) },
        style: {
          stroke: isDark
            ? [
                { width: 18, color: strokeGlow },
                { width: 10, color: strokeOutline },
              ]
            : [{ width: 7, color: strokeOutline }],
        },
      });
      map.addChild(outline);
      outlineFeatureRef.current = outline;

      const feature = new YMapFeature({
        geometry: { type: 'LineString', coordinates: lonLatPath.slice(0, count) },
        style: {
          stroke: isDark
            ? [
                { width: 14, color: strokeGlow },
                { width: 6, color: strokeMain },
              ]
            : [{ width: 4.5, color: strokeMain }],
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

      if (!followMode) {
        try {
          fitRouteToView(bundle, positions, insetsRef.current, 0);
          lastFitInsetsKeyRef.current = insetsRef.current ? insetsKey(insetsRef.current) : '';
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
          fitRouteToView(bundle, positions, insetsRef.current, 0);
          lastFitInsetsKeyRef.current = insetsRef.current ? insetsKey(insetsRef.current) : '';
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

  // Карточки/панель поменяли размер (свёрнута ↔ раскрыта): заново вписываем уже нарисованный
  // маршрут в свободное окно. Саму линию не перерисовываем.
  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle || !mapReady || followMode || !insetsRef.current || positions.length < 2) return;
    if (insetsK === lastFitInsetsKeyRef.current) return;
    try {
      fitRouteToView(bundle, positionsRef.current, insetsRef.current, 250);
      lastFitInsetsKeyRef.current = insetsK;
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, insetsK, followMode, positions.length >= 2]);

  // Маршрут убран — возвращаем карте нулевой margin (только если отступы вообще использовались).
  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle || !mapReady || positions.length >= 2 || !insetsRef.current) return;
    lastFitInsetsKeyRef.current = '';
    if (bundle.apiVersion === 3) {
      try { (bundle as any).map.update({ margin: [0, 0, 0, 0] }); } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, positions.length >= 2]);

  // Progress along route: update geometry in place (no remove/add) to avoid track flicker.
  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle || !mapReady || positions.length < 2) return;
    if (!followMode || !currentPosition) {
      lastProgressIdxRef.current = -1;
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
      if (lastProgressIdxRef.current !== -1) {
        lastProgressIdxRef.current = -1;
        removeObj(bundle, traveledFeatureRef.current);
        traveledFeatureRef.current = null;
      }
      return;
    }

    // Only redraw when the nearest vertex actually advanced (or first paint).
    if (bestIdx === lastProgressIdxRef.current) return;
    lastProgressIdxRef.current = bestIdx;

    const map = (bundle as any).map;
    const traveledPos = positions.slice(0, Math.max(2, bestIdx + 1));
    const remainingPos = positions.slice(Math.max(0, bestIdx));
    if (remainingPos.length < 2) return;

    const strokeMain = isDark ? TESLA_ROUTE_BLUE : 'rgba(6, 182, 212, 0.95)';
    const strokeGlow = isDark ? TESLA_ROUTE_GLOW : 'rgba(6, 182, 212, 0.2)';
    const strokeTraveled = isDark ? TESLA_ROUTE_TRAVELED : 'rgba(148, 163, 184, 0.8)';

    if (bundle.apiVersion === 3) {
      const { YMapFeature } = (bundle as any).ymaps3;
      const traveledCoords = traveledPos.map(([la, lo]) => toLonLat(la, lo));
      const remainCoords = remainingPos.map(([la, lo]) => toLonLat(la, lo));

      if (traveledFeatureRef.current) {
        try {
          traveledFeatureRef.current.update({
            geometry: { type: 'LineString', coordinates: traveledCoords },
            style: { stroke: [{ width: 4.5, color: strokeTraveled }] },
          });
        } catch {
          removeObj(bundle, traveledFeatureRef.current);
          traveledFeatureRef.current = null;
        }
      }
      if (!traveledFeatureRef.current && traveledPos.length >= 2) {
        const traveled = new YMapFeature({
          geometry: { type: 'LineString', coordinates: traveledCoords },
          style: { stroke: [{ width: 4.5, color: strokeTraveled }] },
        });
        map.addChild(traveled);
        traveledFeatureRef.current = traveled;
      }
      if (featureRef.current) {
        try {
          featureRef.current.update({
            geometry: { type: 'LineString', coordinates: remainCoords },
            style: { stroke: isDark ? [{ width: 14, color: strokeGlow }, { width: 6, color: strokeMain }] : [{ width: 4.5, color: strokeMain }] },
          });
        } catch { /* ignore */ }
      }
    } else {
      const ymaps = (bundle as any).ymaps;
      if (traveledFeatureRef.current?.geometry?.setCoordinates) {
        try {
          traveledFeatureRef.current.geometry.setCoordinates(traveledPos);
        } catch {
          removeObj(bundle, traveledFeatureRef.current);
          traveledFeatureRef.current = null;
        }
      }
      if (!traveledFeatureRef.current && traveledPos.length >= 2) {
        const traveled = new ymaps.Polyline(
          traveledPos,
          {},
          { strokeColor: strokeTraveled, strokeWidth: 5, strokeOpacity: 0.8 },
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
        const el = makeChargingMarkerEl(stop.powerKw, !!stop.isRecommended);
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
          {
            preset: 'islands#circleIcon',
            iconContent: Number.isFinite(stop.powerKw) && (stop.powerKw as number) > 0
              ? `${Math.round(stop.powerKw as number)}`
              : '⚡',
            iconColor: stop.isRecommended ? '#f59e0b' : '#64748b',
          },
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

  // A different route was drawn: forget where on the old one we were.
  useEffect(() => {
    routeIdxHintRef.current = null;
  }, [positions]);

  // Push latest GPS sample into follow target (does not restart the render loop).
  useEffect(() => {
    if (
      !currentPosition ||
      !Number.isFinite(currentPosition.lat) ||
      !Number.isFinite(currentPosition.lon)
    ) {
      followTargetRef.current = null;
      return;
    }

    const speedKmH =
      moveSpeedKmH != null && Number.isFinite(moveSpeedKmH) ? Number(moveSpeedKmH) : null;
    // Course from movement only (HeadingFilter) — never the compass or coords.heading,
    // which is garbage at low speed.
    const filtered = headingFilterRef.current.update(
      currentPosition.lat,
      currentPosition.lon,
      speedKmH,
    );

    // Preferred: direction of the road ~45 m AHEAD on the planned route. Matching only moves
    // forward along the polyline, so an out-and-back route cannot flip the camera 180°.
    let routeHeading: number | null = null;
    const rh = routeHeadingAhead(
      positionsRef.current,
      currentPosition.lat,
      currentPosition.lon,
      routeIdxHintRef.current,
    );
    if (rh) {
      routeIdxHintRef.current = rh.idx;
      routeHeading = rh.heading;
    }

    const heading = routeHeading ?? (headingFilterRef.current.ready ? filtered : null);

    followTargetRef.current = {
      lat: currentPosition.lat,
      lon: currentPosition.lon,
      heading,
    };
    if (!displayPosRef.current) {
      displayPosRef.current = {
        lat: currentPosition.lat,
        lon: currentPosition.lon,
      };
    }
    if (displayHeadingRef.current == null && heading != null) {
      displayHeadingRef.current = heading;
    }
  }, [currentPosition?.lat, currentPosition?.lon, moveSpeedKmH, positions]);

  /** Next camera update glides (600 ms) instead of snapping — used on toggle / recenter / start. */
  const glideNextFrameRef = useRef(true);

  // Continuous follow loop: smooth marker + Tesla-style camera (course-up, tilted, speed zoom).
  // The camera is driven here, frame by frame, with duration 0 from our own smoothed state.
  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle || !mapReady) return;
    const map = (bundle as any).map;
    const isV3 = bundle.apiVersion === 3;

    const stopLoop = () => {
      if (followLoopRafRef.current != null) {
        cancelAnimationFrame(followLoopRafRef.current);
        followLoopRafRef.current = null;
      }
    };

    if (!followMode && !currentPosition) {
      stopLoop();
      displayPosRef.current = null;
      displayHeadingRef.current = null;
      headingFilterRef.current.reset();
      courseRef.current.reset();
      camAzimuthReadyRef.current = false;
      camAzimuthDegRef.current = 0;
      removeObj(bundle, currentPosMarkerRef.current);
      currentPosMarkerRef.current = null;
      return;
    }

    const lastMarkerPushRef = { lat: NaN, lon: NaN, deg: NaN, t: 0 };
    const ensureMarker = (lat: number, lon: number, arrowDeg: number) => {
      // Skip tiny updates — fewer Yandex marker writes → cooler phone, still looks continuous.
      const dLat = lat - lastMarkerPushRef.lat;
      const dLon = lon - lastMarkerPushRef.lon;
      const moved = !(
        Number.isFinite(lastMarkerPushRef.lat) &&
        dLat * dLat + dLon * dLon < 2.5e-11 // ~0.5 m
      );
      const turned =
        !Number.isFinite(lastMarkerPushRef.deg) ||
        Math.abs(arrowDeg - lastMarkerPushRef.deg) >= 1.5;
      if (!moved && !turned && currentPosMarkerRef.current) return;
      lastMarkerPushRef.lat = lat;
      lastMarkerPushRef.lon = lon;
      lastMarkerPushRef.deg = arrowDeg;

      if (bundle.apiVersion === 3) {
        const coords = toLonLat(lat, lon);
        if (!currentPosMarkerRef.current) {
          const { YMapMarker } = (bundle as any).ymaps3;
          const el = followModeRef.current
            ? makeNavArrowEl('#f8fafc', arrowDeg)
            : makeDotMarkerEl('#38bdf8', 14, '#fff');
          const m = new YMapMarker({ coordinates: coords }, el);
          map.addChild(m);
          currentPosMarkerRef.current = m;
        } else if (moved) {
          try {
            currentPosMarkerRef.current.update({ coordinates: coords });
          } catch { /* ignore */ }
        }
        if (turned || !currentPosMarkerRef.current) {
          try {
            const root =
              currentPosMarkerRef.current?.element ||
              currentPosMarkerRef.current?._element;
            const arrow = root?.querySelector?.('[data-vigo-nav-arrow]') as HTMLElement | null;
            if (arrow) arrow.style.transform = `translate(-50%,-50%) rotate(${arrowDeg}deg)`;
          } catch { /* ignore */ }
        }
      } else {
        const coords: [number, number] = [lat, lon];
        if (!currentPosMarkerRef.current) {
          const ymaps = (bundle as any).ymaps;
          const m = new ymaps.Placemark(
            coords,
            { hintContent: 'Вы здесь' },
            { preset: 'islands#blueCircleDotIcon', iconColor: '#38bdf8' },
          );
          map.geoObjects.add(m);
          currentPosMarkerRef.current = m;
        } else if (moved) {
          try {
            currentPosMarkerRef.current.geometry.setCoordinates(coords);
          } catch { /* ignore */ }
        }
      }
    };

    const POS_TAU_S = 0.4;
    const HEAD_LERP = 0.14;
    const HEAD_DEADZONE = 3;
    const FRAME_MIN_MS = 40; // ~25 fps camera updates
    const GLIDE_MS = 600;
    let lastFrameTs = 0;
    let camZoom: number | null = null;
    let zoomOffset = 0;
    let wasPaused = false;
    let suppressUntil = 0;
    let lastMargin = -1;
    const lastSent = { lat: NaN, lon: NaN, az: NaN, tilt: NaN, zoom: NaN };

    if (isV3 && !followModeRef.current) {
      // Position dot only (no follow): keep the basemap flat and north-up.
      try {
        map.update({ camera: { azimuth: 0, tilt: 0, duration: 0 } });
      } catch { /* ignore */ }
    }
    glideNextFrameRef.current = true;

    const tick = () => {
      const target = followTargetRef.current;
      if (!target) {
        followLoopRafRef.current = requestAnimationFrame(tick);
        return;
      }

      const now = performance.now();
      if (lastFrameTs && now - lastFrameTs < FRAME_MIN_MS) {
        followLoopRafRef.current = requestAnimationFrame(tick);
        return;
      }
      const dt = lastFrameTs ? Math.min(0.1, (now - lastFrameTs) / 1000) : 0.04;
      lastFrameTs = now;

      // Marker/camera position follows the GPS target exponentially (frame-rate independent).
      const posAlpha = 1 - Math.exp(-dt / POS_TAU_S);
      let disp = displayPosRef.current;
      if (!disp) {
        disp = { lat: target.lat, lon: target.lon };
        displayPosRef.current = disp;
      } else {
        disp.lat += (target.lat - disp.lat) * posAlpha;
        disp.lon += (target.lon - disp.lon) * posAlpha;
      }

      // Arrow heading for north-up mode.
      if (target.heading != null && Number.isFinite(target.heading)) {
        const prev = displayHeadingRef.current;
        if (prev == null) {
          displayHeadingRef.current = target.heading;
        } else {
          const d = headingDelta(prev, target.heading);
          if (Math.abs(d) >= HEAD_DEADZONE) {
            displayHeadingRef.current = prev + d * HEAD_LERP;
          }
        }
      }
      const headingSmooth = displayHeadingRef.current;
      const speed = moveSpeedRef.current;
      const following = followModeRef.current;

      // Course for the camera: smoothed, rate-limited, frozen when (almost) stationary.
      const camCourse = following ? courseRef.current.step(target.heading, dt, speed) : null;

      // One-time measurement of which way +azimuth turns THIS map (see probeAzimuthSign).
      const want3d = following && cam3dRef.current && isV3;
      if (
        want3d &&
        azimuthSignRef.current === null &&
        !probingRef.current &&
        containerRef.current &&
        document.visibilityState === 'visible'
      ) {
        probingRef.current = true;
        void probeAzimuthSign(bundle, containerRef.current)
          .then((sign) => {
            const fails = ((bundle as any)._vigoProbeFails ?? 0) + (sign === 0 ? 1 : 0);
            (bundle as any)._vigoProbeFails = fails;
            if (sign !== 0) azimuthSignRef.current = sign;
            else if (fails >= 3) {
              azimuthSignRef.current = 0; // give up: tilted but north-up, never a wrong-way spin
              console.warn('[hud-camera] azimuth direction could not be measured; course-up disabled');
            }
            glideNextFrameRef.current = true;
          })
          .finally(() => {
            probingRef.current = false;
          });
      }
      const calibrating = probingRef.current;

      const sign = azimuthSignRef.current;
      const rotating = want3d && (sign === 1 || sign === -1) && camCourse != null;

      // Chevron: relative to the screen when the map turns with the car, geographic otherwise.
      const arrowDeg = rotating && headingSmooth != null
        ? angleDelta(camCourse as number, headingSmooth)
        : rotating
          ? 0
          : headingSmooth ?? 0;
      ensureMarker(disp.lat, disp.lon, arrowDeg);

      if (following && !calibrating) {
        const paused = Date.now() < userNavPauseUntilRef.current;
        if (paused) {
          wasPaused = true;
        } else if (isV3) {
          const tilt = want3d ? tiltRad(NAV_TILT_DEG) : 0;
          const az = rotating ? azimuthForCourse(camCourse as number, sign as 1 | -1) : 0;

          // Speed-dependent zoom; a pinch by the user is kept as an offset instead of being overwritten.
          const baseZoom = zoomForSpeed(speed);
          let mapZoom = NaN;
          try { mapZoom = typeof map.zoom === 'number' ? map.zoom : NaN; } catch { /* ignore */ }
          let glide = glideNextFrameRef.current;
          if (wasPaused) {
            wasPaused = false;
            setFollowPaused(false);
            if (Number.isFinite(mapZoom)) {
              zoomOffset = Math.max(-3, Math.min(2, mapZoom - baseZoom));
              camZoom = mapZoom;
            }
            glide = true;
          }
          if (camZoom == null) camZoom = Number.isFinite(mapZoom) ? mapZoom : baseZoom;
          camZoom = smoothScalar(camZoom, Math.max(11, Math.min(19, baseZoom + zoomOffset)), dt, 1.4);

          // Car sits in the lower third: shrink the map's top margin instead of shifting the centre.
          const el = containerRef.current;
          const marginTop = want3d && el ? Math.round(el.clientHeight * 0.3) : 0;
          if (Math.abs(marginTop - lastMargin) > 10) {
            lastMargin = marginTop;
            try { map.update({ margin: [marginTop, 0, 0, 0] }); } catch { /* ignore */ }
          }

          if (now >= suppressUntil) {
            const moved =
              !Number.isFinite(lastSent.lat) ||
              Math.hypot(
                (disp.lat - lastSent.lat) * 111320,
                (disp.lon - lastSent.lon) * 111320 * Math.cos((disp.lat * Math.PI) / 180),
              ) > 0.12;
            const turned = !Number.isFinite(lastSent.az) || Math.abs(wrapPi(az - lastSent.az)) > 0.0009;
            const tilted = !Number.isFinite(lastSent.tilt) || Math.abs(tilt - lastSent.tilt) > 0.002;
            const zoomed = !Number.isFinite(lastSent.zoom) || Math.abs(camZoom - lastSent.zoom) > 0.004;
            if (glide || moved || turned || tilted || zoomed) {
              // The map tweens azimuth numerically. If the target is on the other side of the ±π seam
              // it would sweep the long way round (a fast full spin) — snap instead; the seam is invisible.
              let curAz = 0;
              try { curAz = typeof map.azimuth === 'number' ? map.azimuth : 0; } catch { /* ignore */ }
              const duration = glide && Math.abs(az - curAz) < Math.PI * 0.75 ? GLIDE_MS : 0;
              try {
                map.update({
                  location: { center: toLonLat(disp.lat, disp.lon), zoom: camZoom, duration },
                  camera: { azimuth: az, tilt, duration },
                });
              } catch { /* ignore */ }
              lastSent.lat = disp.lat;
              lastSent.lon = disp.lon;
              lastSent.az = az;
              lastSent.tilt = tilt;
              lastSent.zoom = camZoom;
              if (glide) {
                glideNextFrameRef.current = false;
                if (duration > 0) suppressUntil = now + GLIDE_MS + 30;
              }
            }
          }
        } else if (now - lastCenterPushMsRef.current >= 1200) {
          // Yandex 2.1 fallback: centre only.
          lastCenterPushMsRef.current = now;
          try {
            const z = typeof map.getZoom === 'function' ? map.getZoom() : 16;
            map.setCenter([disp.lat, disp.lon], z, { duration: 0 });
          } catch {
            try { (bundle as any).setLocation?.(disp.lat, disp.lon); } catch { /* ignore */ }
          }
        }
      }

      followLoopRafRef.current = requestAnimationFrame(tick);
    };

    stopLoop();
    followLoopRafRef.current = requestAnimationFrame(tick);

    return () => {
      stopLoop();
      // Leave the map flat and north-up for whoever uses it next.
      if (isV3) {
        try {
          map.update({ camera: { azimuth: 0, tilt: 0, duration: 0 }, margin: [0, 0, 0, 0] });
        } catch { /* map may already be destroyed */ }
      }
    };
    // Restart loop only when map readiness / follow mode flips — not on every GPS sample.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, followMode, !!currentPosition]);

  const toggleCam3d = () => {
    setCam3d((v) => {
      const next = !v;
      try { localStorage.setItem(CAM3D_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
    glideNextFrameRef.current = true;
  };
  const recenter = () => {
    userNavPauseUntilRef.current = 0;
    glideNextFrameRef.current = true;
    setFollowPaused(false);
  };

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
        {fill && followMode && (
          <div className="absolute left-3 top-1/2 z-[120] flex -translate-y-1/2 flex-col gap-2">
            <button
              type="button"
              onClick={toggleCam3d}
              aria-pressed={cam3d}
              aria-label={cam3d ? 'Плоская карта, север сверху' : '3D-вид по ходу движения'}
              className={`flex h-10 w-10 items-center justify-center rounded-full border shadow-lg active:scale-95 ${
                cam3d
                  ? 'border-blue-400/60 bg-blue-600/90 text-white'
                  : isDark
                    ? 'border-slate-600 bg-slate-900/85 text-slate-300'
                    : 'border-slate-300 bg-white/90 text-slate-600'
              }`}
            >
              <Box className="h-5 w-5" />
            </button>
            {followPaused && (
              <button
                type="button"
                onClick={recenter}
                aria-label="Вернуть карту к автомобилю"
                className={`flex h-10 w-10 items-center justify-center rounded-full border shadow-lg active:scale-95 ${
                  isDark ? 'border-slate-600 bg-slate-900/90 text-blue-300' : 'border-slate-300 bg-white/95 text-blue-600'
                }`}
              >
                <LocateFixed className="h-5 w-5" />
              </button>
            )}
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
              <span>⚡ {stops.length > 1 ? `${stops.length} ${stops.length < 5 ? 'остановки' : 'остановок'}` : 'Зарядка'}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
