import React, { useCallback, useEffect, useState, useLayoutEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Zap,
  Gauge,
  Coins,
  ChevronRight,
  TrendingDown,
  Mountain,
  MapPin,
  Loader2,
  ArrowDown,
  Navigation,
  CloudSun,
  CloudRain,
  CloudSnow,
  Sun,
  Wind,
  Thermometer,
  Power,
  Map,
  ArrowUpDown,
  ChartNoAxesCombined,
  LocateFixed,
  PlugZap,
  RotateCcw,
  SlidersHorizontal,
  X,
  History,
  Route,
  BatteryCharging,
  ChevronUp,
} from 'lucide-react';
import { UserSettings, RoadType, TripSession } from '../types';
import { BatteryVisual } from './BatteryVisual';
import { DecimalInput } from './DecimalInput';
import { getTariffForType, getOperatorLabel, estimateTripConsumption, estimateSegmentedRouteConsumption, calculateClimateImpact } from '../utils/storage';
import { triggerHaptic } from '../utils/haptics';
import { saveLastRouteForecast } from '../utils/routeForecastBridge';
import { buildRouteElevation, geocodeAddress, RouteElevationData, RouteProgress } from '../services/routeElevation';
import { AddressAutocomplete } from './AddressAutocomplete';
import { fetchForecastWeatherAt, fetchForecastWeatherAlongRoute, RouteWeatherSample } from '../services/weatherForecast';
import { fetchChargingStationsAlongRoute, stationSupportsConnectors, ChargingStation } from '../services/chargingStations';
import { findNearbyFreeCcsChargers, FreeChargerResult } from '../services/nearbyFreeCharging';
import { resolveEffectiveConnectors, resolveChargeLimits } from '../data/vehicleProfiles';
import { estimateChargingSession, findOptimalChargeTargetSoc, DEFAULT_UNKNOWN_STATION_POWER_KW, ChargeConnector, ChargePowerParams, ChargeSessionEstimate } from '../utils/chargingPlanner';
import { RouteMap } from './RouteMap';
import {
  computeMapInsets,
  insetsKey,
  resolveHandleGesture,
  SWIPE_THRESHOLD_PX,
  sheetMaxHeightPx,
  shortPlaceLabel,
  ZERO_INSETS,
  type MapInsets,
  type SheetMode,
} from '../utils/calculatorSheet';
import { LocationPickerModal } from './LocationPickerModal';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, ReferenceLine, ReferenceDot } from 'recharts';
import { CollapsibleDetails, SecondaryStatRow, ChipRow } from './ui/CollapsibleDetails';
import { AnimatedNumber } from './ui/AnimatedNumber';
import { RangeGauge } from './ui/RangeGauge';

// Manual "Планирование" precipitation presets: type × intensity → (mm/h, WMO weather code).
// Values sit inside the intensity bands calculatePrecipitationImpact() already uses, so each
// button maps to a genuinely different physical impact rather than just a different label.
// Freezing rain / naledь at sub-zero planning temperatures is NOT a separate button here —
// it falls out automatically from the temperature already entered above, since
// calculatePrecipitationImpact blends "rain" smoothly into the icy-road formula as
// manualTemperature approaches/drops below 0°C (see calcIceBlendFactor in storage.ts).
const MANUAL_PRECIPITATION_PRESETS: Record<'rain' | 'snow', Record<'light' | 'moderate' | 'heavy', { mm: number; code: number }>> = {
  rain: {
    light: { mm: 0.2, code: 61 },    // морось / слабый дождь
    moderate: { mm: 2.0, code: 63 }, // умеренный дождь
    heavy: { mm: 6.0, code: 65 },    // ливень
  },
  snow: {
    light: { mm: 0.2, code: 71 },    // слабый снег
    moderate: { mm: 1.0, code: 73 }, // умеренный снег
    heavy: { mm: 3.5, code: 75 },    // сильный снегопад
  },
};

const RECENT_PLACES_KEY = 'vigo_recent_places_v1';
interface RecentPlace { name: string; lat: number; lon: number }

import type { HudRoutePlan } from './HudTab';
export type { HudRoutePlan };

interface CalculatorTabProps {
  settings: UserSettings;
  sessions: TripSession[];
  onSaveToHistory: (tripData: Omit<TripSession, 'id' | 'createdAt'>) => void;
  onOpenAddModalWithData: (initialData: Partial<TripSession>) => void;
  /** Transfer planned route into HUD tracking tab */
  onSendToHud?: (plan: HudRoutePlan) => void;
}

export const CalculatorTab: React.FC<CalculatorTabProps> = ({
  settings,
  sessions,
  onSaveToHistory,
  onOpenAddModalWithData,
  onSendToHud,
}) => {
  // Input states (restored from last session when available)
  const [startSoc, setStartSoc] = useState<number>(() => {
    try {
      const d = JSON.parse(localStorage.getItem('vigo_calculator_draft_v1') || '{}');
      return typeof d.startSoc === 'number' ? d.startSoc : 100;
    } catch {
      return 100;
    }
  });
  const [endSoc, setEndSoc] = useState<number>(() => {
    try {
      const d = JSON.parse(localStorage.getItem('vigo_calculator_draft_v1') || '{}');
      return typeof d.endSoc === 'number' ? d.endSoc : 45;
    } catch {
      return 45;
    }
  });
  const [distanceKm, setDistanceKm] = useState<number>(() => {
    try {
      const d = JSON.parse(localStorage.getItem('vigo_calculator_draft_v1') || '{}');
      return typeof d.distanceKm === 'number' ? d.distanceKm : 180;
    } catch {
      return 180;
    }
  });
  const [roadType, setRoadType] = useState<RoadType>('city');
  const [climateOn, setClimateOn] = useState(() => {
    try {
      const d = JSON.parse(localStorage.getItem('vigo_calculator_draft_v1') || '{}');
      return typeof d.climateOn === 'boolean' ? d.climateOn : true;
    } catch {
      return true;
    }
  });
  // Weather mode: live API for trips now, or manual conditions for long-term planning.
  const [weatherMode, setWeatherMode] = useState<'current' | 'planning'>('current');
  const [manualTemperature, setManualTemperature] = useState(20);
  const [manualWindSpeed, setManualWindSpeed] = useState(0);
  const [manualWindDirection, setManualWindDirection] = useState(0);
  const [manualPrecipitationType, setManualPrecipitationType] = useState<'none' | 'rain' | 'snow'>('none');
  // Intensity within a type — feeds a representative mm/h value into the same continuous
  // calculatePrecipitationImpact() curve the live weather API uses, so manual planning gets
  // the same non-linear resistance model instead of one fixed value per precipitation type.
  const [manualPrecipitationIntensity, setManualPrecipitationIntensity] = useState<'light' | 'moderate' | 'heavy'>('moderate');
  const [chargingType, setChargingType] = useState<TripSession['chargingType']>('malanka_dc');
  const [passengers, setPassengers] = useState(() => {
    try {
      const d = JSON.parse(localStorage.getItem('vigo_calculator_draft_v1') || '{}');
      return typeof d.passengers === 'number' ? d.passengers : 1;
    } catch {
      return 1;
    }
  });
  // Two distinct workflows used to live interleaved on one long scroll (route planning vs.
  // logging a completed trip by hand) with no visual separation between them. This just
  // groups the existing sections under a switcher; nothing about how each section works changes.
  const calculatorMode = 'route';

  // Planned route: current GPS point A -> selected destination B -> detailed elevation profile.
  const [startMode, setStartMode] = useState<'gps' | 'address'>('gps');
  const [startAddress, setStartAddress] = useState('');
  const [destinationAddress, setDestinationAddress] = useState(() => {
    try {
      const d = JSON.parse(localStorage.getItem('vigo_calculator_draft_v1') || '{}');
      return typeof d.destinationAddress === 'string' ? d.destinationAddress : '';
    } catch {
      return '';
    }
  });
  // Exact coordinates when A/B was picked by tapping the interactive map, rather than typed
  // as free-text. When set, these are used directly instead of re-geocoding the text — a tap
  // is already precise, so routing through Nominatim's text search again could drift to a
  // different nearby match. Cleared as soon as the corresponding text field is edited by hand.
  const [startPin, setStartPin] = useState<{ lat: number; lon: number } | null>(null);
  const [destinationPin, setDestinationPin] = useState<{ lat: number; lon: number } | null>(null);
  const [pickerFor, setPickerFor] = useState<'start' | 'destination' | null>(null);
  const [routeStatus, setRouteStatus] = useState('');
  const [routeElevation, setRouteElevation] = useState<RouteElevationData | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState('');
  const [plannedSpeedKmH, setPlannedSpeedKmH] = useState(() => {
    try {
      const d = JSON.parse(localStorage.getItem('vigo_calculator_draft_v1') || '{}');
      return typeof d.plannedSpeedKmH === 'number' ? d.plannedSpeedKmH : 70;
    } catch {
      return 70;
    }
  });
  const [plannedMaxSpeedKmH, setPlannedMaxSpeedKmH] = useState(() => {
    try {
      const d = JSON.parse(localStorage.getItem('vigo_calculator_draft_v1') || '{}');
      return typeof d.plannedMaxSpeedKmH === 'number' ? d.plannedMaxSpeedKmH : 120;
    } catch {
      return 120;
    }
  });

  // Persist last calculator inputs so a reload does not reset to 100/45/180.
  useEffect(() => {
    try {
      localStorage.setItem(
        'vigo_calculator_draft_v1',
        JSON.stringify({
          startSoc,
          endSoc,
          distanceKm,
          climateOn,
          passengers,
          destinationAddress,
          plannedSpeedKmH,
          plannedMaxSpeedKmH,
          calculatorMode,
        }),
      );
    } catch {
      /* ignore */
    }
  }, [
    startSoc,
    endSoc,
    distanceKm,
    climateOn,
    passengers,
    destinationAddress,
    plannedSpeedKmH,
    plannedMaxSpeedKmH,
    calculatorMode,
  ]);
  const [routeWeather, setRouteWeather] = useState<{ temperature:number; windSpeed:number; windDirection:number; weatherCode:number; precipitation:number; routeBearing:number; etaMinutes:number; arrivalDate: Date; samples: RouteWeatherSample[] } | null>(null);
  const [routeForecast, setRouteForecast] = useState<{ consumption:number; energyKwh:number; arrivalSoc:number; windLabel:string; weatherLabel:string; precipitationLabel:string; relativeWindAngle:number; driverStyleFactor:number; driverStyleSource:string; climateLabel:string; climateImpactPct:number; climateDeltaKwh100:number; speedImpactPct:number; breakdown?: any } | null>(null);
  const getChargingTemperatureAtDistance = useCallback((distanceKm: number): number | undefined => {
    if (!routeWeather) return undefined;
    if (!routeWeather.samples?.length) return routeWeather.temperature;
    let nearest = routeWeather.samples[0];
    let bestDelta = Math.abs(nearest.distanceFromStartKm - distanceKm);
    for (const sample of routeWeather.samples) {
      const delta = Math.abs(sample.distanceFromStartKm - distanceKm);
      if (delta < bestDelta) {
        nearest = sample;
        bestDelta = delta;
      }
    }
    return nearest.weather.temperature;
  }, [routeWeather]);
  // Mid-route charging suggestion — computed whenever the forecast arrival SoC drops under 20%.
  // "loading"/"unavailable" keep the UI from silently showing nothing while EVRACE/OSM are queried
  // or when no reachable Type2/CCS2 station was found along the route.
  const [chargingSuggestion, setChargingSuggestion] = useState<{
    station: ChargingStation;
    connector: ChargeConnector;
    socAtStation: number;
    targetSoc: number;
    minRequiredSoc: number;
    session: ChargeSessionEstimate;
    chargeAddedSoc: number;
    finishSocAfterCharge: number;
    /** True when the station has no power tag in OSM, so the session estimate above used the
     *  conservative DEFAULT_UNKNOWN_STATION_POWER_KW assumption rather than a real reading —
     *  worth flagging, since actual time can differ a lot either way. */
    stationPowerAssumed: boolean;
  } | null>(null);
  const [chargingSuggestionStatus, setChargingSuggestionStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable' | 'error'>('idle');
  // True when the visible station list came from the explicit force-search action.
  const [chargingSearchForced, setChargingSearchForced] = useState(false);
  /** Full plan: one or more stops on long trips (first stop mirrors chargingSuggestion). */
  const [chargingStops, setChargingStops] = useState<Array<{
    station: ChargingStation;
    connector: ChargeConnector;
    socAtStation: number;
    targetSoc: number;
    session: ChargeSessionEstimate;
    finishSocAfterCharge: number;
  }>>([]);
  /** How many VIGO-compatible stations were found along the corridor before usefulness filtering. */
  const [stationsFoundAlongRoute, setStationsFoundAlongRoute] = useState(0);
  /** All connector-compatible stations found along the current route (for map markers). */
  const [routeStationsAlong, setRouteStationsAlong] = useState<ChargingStation[]>([]);
  const [showAllRouteStations, setShowAllRouteStations] = useState(false);
  const [nearbyFreeStatus, setNearbyFreeStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [nearbyFreeList, setNearbyFreeList] = useState<FreeChargerResult[]>([]);
  const [nearbyFreeError, setNearbyFreeError] = useState('');
  /** Station card opened from route map charging marker. */
  const [selectedRouteStop, setSelectedRouteStop] = useState<{
    station: ChargingStation;
    connector?: ChargeConnector;
    socAtStation?: number;
    targetSoc?: number;
    session?: ChargeSessionEstimate;
    finishSocAfterCharge?: number;
  } | null>(null);

  const [gpsStatus, setGpsStatus] = useState<'searching' | 'ok' | 'error'>('searching');
  // Last known device position, kept only to center the map-picker modal near the user
  // instead of defaulting to Minsk when they open it (weather fetch above already has this
  // fix rate, this just also remembers the coordinate).
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [quickWeather, setQuickWeather] = useState<{ temperature:number; weatherCode:number; windSpeed:number } | null>(null);
  const [routeMapOpen, setRouteMapOpen] = useState(false);
  const [elevationOpen, setElevationOpen] = useState(false);
  const [consumptionOpen, setConsumptionOpen] = useState(true);
  const [speedProfileOpen, setSpeedProfileOpen] = useState(false);
  const [weatherPanelOpen, setWeatherPanelOpen] = useState(false);
  const [routeParamsOpen, setRouteParamsOpen] = useState(false);
  /**
   * The map card must end ABOVE the floating bottom navigation. Yandex's mandatory logo/© sits in the
   * map's bottom corner; if the card extends under the nav the logo ends up drawn over the menu.
   */
  const shellRef = useRef<HTMLDivElement>(null);
  /**
   * Ландшафт: вместо «шторки» снизу — боковая колонка слева (поиск → кнопки → результат), справа вся карта.
   * Саму раскладку задаёт CSS (index.css, блок «Calculator — landscape»); флаг нужен только там,
   * где без JS не обойтись: лимиты высоты шторки и минимальная высота оболочки.
   */
  const [landscape, setLandscape] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(orientation: landscape)').matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(orientation: landscape)');
    const update = () => setLandscape(mq.matches);
    update();
    try { mq.addEventListener('change', update); } catch { /* Safari < 14 */ mq.addListener?.(update); }
    return () => {
      try { mq.removeEventListener('change', update); } catch { mq.removeListener?.(update); }
    };
  }, []);
  const [shellHeight, setShellHeight] = useState<number | null>(null);
  /** Pixels of `main`'s bottom padding the card would push the page by — cancelled with a negative margin. */
  const [shellBleed, setShellBleed] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const el = shellRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      if (!(el.offsetParent || el.getClientRects().length)) return; // tab is hidden
      const nav = (document.querySelector('#main-bottom-nav-wrap nav') ||
        document.querySelector('nav')) as HTMLElement | null;
      const navTop = nav ? nav.getBoundingClientRect().top : window.innerHeight;
      if (!Number.isFinite(navTop) || navTop <= top) return;
      // В портрете карта не должна быть совсем низкой (360 px). В ландшафте высота — самый дефицитный ресурс:
      // жёсткие 360 px вылезали за экран телефона (≈320–400 px) и уходили под нижнюю навигацию.
      const isLand = typeof window.matchMedia === 'function' && window.matchMedia('(orientation: landscape)').matches;
      const h = Math.max(isLand ? 160 : 360, Math.floor(navTop - top - 10));
      setShellHeight((prev) => (prev !== null && Math.abs(prev - h) < 2 ? prev : h));
      const main = el.closest('main');
      const padBottom = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
      const bleed = Math.max(0, Math.min(padBottom, Math.ceil(top + window.scrollY + h + padBottom - window.innerHeight)));
      setShellBleed((prev) => (Math.abs(prev - bleed) < 2 ? prev : bleed));
    };
    measure();
    const t = window.setTimeout(measure, 350); // nav slides in with a spring animation
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    window.visualViewport?.addEventListener('resize', measure);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(document.body);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, []);

  /** Hidden-by-default parameters sheet (SoC, people, climate, speed, weather). */
  const [paramsOpen, setParamsOpen] = useState(false);
  /** True when a parameter that needs a recalculation changed while the sheet was open. */
  const [paramsDirty, setParamsDirty] = useState(false);
  /** Bumped to recalculate with the latest state (A/B edits made through the search card). */
  const [recalcTick, setRecalcTick] = useState(0);
  const [recentPlaces, setRecentPlaces] = useState<RecentPlace[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENT_PLACES_KEY) || '[]');
      return Array.isArray(raw)
        ? raw
            .filter((p) => p && typeof p.name === 'string' && Number.isFinite(p.lat) && Number.isFinite(p.lon))
            .slice(0, 5)
        : [];
    } catch {
      return [];
    }
  });
  const [showGuideTip, setShowGuideTip] = useState(() => {
    try { return localStorage.getItem('ev_guide_tip_dismissed') !== '1'; } catch { return true; }
  });
  /** Detailed route info (map, elevation, breakdown) — collapsed after calc */
  /** Положение нижней панели результата: свёрнута / наполовину / раскрыта («Подробности»). */
  const [sheetMode, setSheetMode] = useState<SheetMode>('peek');
  /** После расчёта верхняя карточка сворачивается в одну строку; тап по ней возвращает поля. */
  const [searchEditing, setSearchEditing] = useState(false);
  /** Сколько карты закрыто карточками — по этим отступам маршрут вписывается в видимое окно. */
  const [mapInsets, setMapInsets] = useState<MapInsets>(ZERO_INSETS);
  const topPanelRef = useRef<HTMLDivElement>(null);
  const bottomPanelRef = useRef<HTMLDivElement>(null);
  const insetsFrozenRef = useRef(false);
  const hasRoute = !!(routeElevation && routeForecast);
  /** Подписи А → Б для свёрнутой верхней карточки: снимаются в момент готовности маршрута, чтобы не расходиться с ним. */
  const [routeLabels, setRouteLabels] = useState({ start: '', dest: '' });
  const handleDragRef = useRef<{ y: number } | null>(null);
  const [manualDetailsOpen, setManualDetailsOpen] = useState(false);

  // Пришёл новый результат расчёта: панель — в свёрнутое положение, верхняя карточка — в одну строку.
  useEffect(() => {
    if (routeElevation) {
      setSheetMode('peek');
      setSearchEditing(false);
      setRouteLabels({
        start: startMode === 'gps' ? 'Моя геопозиция' : shortPlaceLabel(startAddress, 'Точка А'),
        dest: shortPlaceLabel(destinationAddress, 'Точка Б'),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeElevation]);

  // Замер занятого карточками места. Пока открыта карточка станции / список зарядок / идёт расчёт,
  // отступы не обновляем: иначе карта «прыгала» бы при каждом тапе по ⚡.
  useLayoutEffect(() => {
    const measure = () => {
      const shell = shellRef.current;
      if (!shell || insetsFrozenRef.current) return;
      if (!(shell.offsetParent || shell.getClientRects().length)) return; // вкладка скрыта
      const sr = shell.getBoundingClientRect();
      if (sr.width < 50 || sr.height < 50) return;
      const landscape = typeof window.matchMedia === 'function' && window.matchMedia('(orientation: landscape)').matches;
      const next = computeMapInsets({
        shell: sr,
        topPanel: topPanelRef.current ? topPanelRef.current.getBoundingClientRect() : null,
        bottomPanel: bottomPanelRef.current ? bottomPanelRef.current.getBoundingClientRect() : null,
        landscape,
      });
      setMapInsets((prev) => (insetsKey(prev, 8) === insetsKey(next, 8) ? prev : next));
    };
    measure();
    const t = window.setTimeout(measure, 350);
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    [shellRef.current, topPanelRef.current, bottomPanelRef.current].forEach((el) => { if (el) ro?.observe(el); });
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      ro?.disconnect();
    };
  }, []);
  /** Brief highlight pulse on the result card after a successful route calc */
  const [resultHighlight, setResultHighlight] = useState(false);
  /** Reserve SoC kept as safety buffer when interpreting arrival forecast.
   *  Example: arrival 18% with reserve 10% → "free margin" above the safety floor = 8%. */
  const ARRIVAL_RESERVE_SOC = 10;
  /** Below this finish SOC we auto-suggest a mid-route charge; at/above — only via button. */
  const CHARGE_SUGGEST_SOC = 20;

  const weatherIcon = (code: number, className = 'w-4 h-4') => {
    if ([71,73,75,77,85,86].includes(code)) return <CloudSnow className={className} />;
    if ([51,53,55,61,63,65,80,81,82].includes(code)) return <CloudRain className={className} />;
    if ([0,1].includes(code)) return <Sun className={className} />;
    return <CloudSun className={className} />;
  };

  // Same headwind/tailwind/crosswind classification used for the route-level wind badge and
  // for storage.ts's windStatusText, applied per sample point using that point's own local
  // road bearing rather than one A→B bearing for the whole route.
  const sampleWindLabel = (windDirectionDeg: number, bearingDeg: number) => {
    const rel = ((windDirectionDeg - bearingDeg + 360) % 360);
    if (rel <= 45 || rel >= 315) return 'Встречный';
    if (rel >= 135 && rel <= 225) return 'Попутный';
    if (rel > 45 && rel < 135) return 'Боковой справа';
    return 'Боковой слева';
  };

  // This tab stays mounted (hidden) while the HUD is open, so this watcher keeps firing during a trip. Without
  // throttling it re-rendered this 3k-line tab and hit Open-Meteo on EVERY position update (traffic + 429s).
  const quickGpsStateRef = useRef<{ t: number; lat: number; lon: number } | null>(null);
  const quickWeatherRef = useRef<{ t: number; lat: number; lon: number } | null>(null);
  useEffect(() => {
    if (!navigator.geolocation) { setGpsStatus('error'); return; }
    const kmBetween = (aLat: number, aLon: number, bLat: number, bLon: number) =>
      Math.hypot((bLat - aLat) * 111.32, (bLon - aLon) * 111.32 * Math.cos((aLat * Math.PI) / 180));
    const id = navigator.geolocation.watchPosition(
      async (position) => {
        const nowMs = Date.now();
        const { latitude, longitude } = position.coords;
        const prevState = quickGpsStateRef.current;
        if (
          !prevState ||
          nowMs - prevState.t >= 30_000 ||
          kmBetween(prevState.lat, prevState.lon, latitude, longitude) >= 0.05
        ) {
          quickGpsStateRef.current = { t: nowMs, lat: latitude, lon: longitude };
          setGpsStatus('ok');
          setGpsCoords({ lat: latitude, lon: longitude });
        }
        // Quick weather: first fix, then only after >10 min or >5 km.
        const prevWx = quickWeatherRef.current;
        if (prevWx && nowMs - prevWx.t < 10 * 60_000 && kmBetween(prevWx.lat, prevWx.lon, latitude, longitude) < 5) return;
        quickWeatherRef.current = { t: nowMs, lat: latitude, lon: longitude };
        try {
          const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude.toFixed(4)}&longitude=${longitude.toFixed(4)}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`);
          if (!res.ok) {
            // Retry in ~1 min instead of waiting the full interval (or hammering on every position update).
            quickWeatherRef.current = { t: nowMs - 9 * 60_000, lat: latitude, lon: longitude };
            return;
          }
          const data = await res.json();
          if (data?.current) setQuickWeather({
            temperature: Math.round(data.current.temperature_2m),
            weatherCode: data.current.weather_code ?? 0,
            windSpeed: Math.round(data.current.wind_speed_10m ?? 0),
          });
        } catch {
          /* keep last known weather */
          quickWeatherRef.current = { t: nowMs - 9 * 60_000, lat: latitude, lon: longitude };
        }
      },
      () => setGpsStatus('error'),
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 10000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // Searches stations along the current route. It is invoked automatically only when the
  // unassisted arrival SoC is below 20%, or manually from the button shown for safer routes.
  // One button: Yandex Navigator only (Maps and Navi were collapsing to the same app).
  // Deep link build_route_on_map + via point for the suggested charger.
  const yandexNaviHref = (() => {
    if (!routeElevation?.points?.length) return '#';
    const pts = routeElevation.points;
    const a = pts[0];
    const b = pts[pts.length - 1];
    const vias =
      chargingSuggestionStatus === 'ready' && chargingStops.length
        ? chargingStops.map((s) => ({ lat: s.station.lat, lon: s.station.lon }))
        : chargingSuggestionStatus === 'ready' && chargingSuggestion
          ? [{ lat: chargingSuggestion.station.lat, lon: chargingSuggestion.station.lon }]
          : [];
    let app = `yandexnavi://build_route_on_map?lat_from=${a.lat}&lon_from=${a.lon}&lat_to=${b.lat}&lon_to=${b.lon}`;
    vias.forEach((v, i) => {
      app += `&lat_via_${i}=${v.lat}&lon_via_${i}=${v.lon}`;
    });
    const parts = [`${a.lat},${a.lon}`, ...vias.map((v) => `${v.lat},${v.lon}`), `${b.lat},${b.lon}`];
    const web = `https://yandex.ru/navi/?rtext=${parts.join('~')}&rtt=auto`;
    return { app, web };
  })();

  const openYandexNavi = (e: React.MouseEvent) => {
    if (yandexNaviHref === '#' || typeof yandexNaviHref === 'string') return;
    e.preventDefault();
    e.stopPropagation();
    const { app, web } = yandexNaviHref;
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    // On phones only the Navi app scheme — a delayed https fallback was also opening Maps.
    if (isMobile) {
      window.location.href = app;
      return;
    }
    window.open(web, '_blank', 'noopener,noreferrer');
  };

  const searchNearbyFreeChargers = useCallback(async () => {
    setNearbyFreeStatus('loading');
    setNearbyFreeError('');
    setNearbyFreeList([]);
    try {
      let origin: { lat: number; lon: number } | null = null;
      if (startMode === 'gps' && gpsCoords) {
        origin = { lat: gpsCoords.lat, lon: gpsCoords.lon };
      } else if (startPin) {
        origin = { lat: startPin.lat, lon: startPin.lon };
      } else if (typeof navigator !== 'undefined' && navigator.geolocation) {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 12000,
            maximumAge: 30000,
          }),
        );
        origin = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      }
      if (!origin) {
        throw new Error('Нужна геолокация или точка А на карте');
      }
      const vehicleConnectors = resolveEffectiveConnectors(
        settings.vehicleProfileId,
        settings.connectorOverride,
      );
      const { results } = await findNearbyFreeCcsChargers(origin, {
        radiusKm: 40,
        limit: 10,
        vehicleConnectors,
      });
      setNearbyFreeList(results);
      setNearbyFreeStatus('ready');
      if (!results.length) {
        setNearbyFreeError('Свободных подходящих зарядок рядом не найдено.');
      }
    } catch (e) {
      setNearbyFreeStatus('error');
      setNearbyFreeError(e instanceof Error ? e.message : String(e));
    }
  }, [startMode, gpsCoords, startPin, settings.vehicleProfileId, settings.connectorOverride]);

  const applyFreeChargerAsDestination = (item: FreeChargerResult) => {
    // Short label so the destination field doesn't overflow the route form.
    const name =
      (item.station.name && item.station.name.length < 80
        ? item.station.name
        : item.station.address) ||
      item.station.name ||
      'Свободная зарядка';
    const pin = { lat: item.station.lat, lon: item.station.lon };
    setDestinationAddress(name);
    setDestinationPin(pin);
    setNearbyFreeList([]);
    setNearbyFreeStatus('idle');
    setNearbyFreeError('');
    setSelectedRouteStop({
      station: item.station,
      connector: item.matchedConnector === 'gbt' ? 'gbt' : item.matchedConnector === 'type2' ? 'type2' : 'ccs2',
    });
    triggerHaptic('light', settings.hapticFeedback);
    // Calculate immediately with explicit coords (don't wait for setState).
    void calculateRouteProfile({ lat: pin.lat, lon: pin.lon, displayName: name });
  };

  const searchChargingStations = useCallback(async (opts?: { force?: boolean }) => {
    if (!routeElevation || !routeForecast) return;
    const force = !!opts?.force;
    setChargingSearchForced(force);
    let cancelled = false;
    setChargingSuggestionStatus('loading');
    setChargingStops([]);
    // keep previous routeStationsAlong until new fetch lands
    try {
      const stations = await fetchChargingStationsAlongRoute(routeElevation.points, force ? 5 : 3.5);
      if (cancelled) return;
      const vehicleConnectors = resolveEffectiveConnectors(
        settings.vehicleProfileId,
        settings.connectorOverride,
      );
      const vigoStations = stations.filter((s) => stationSupportsConnectors(s, vehicleConnectors));
      setStationsFoundAlongRoute(vigoStations.length);
      setRouteStationsAlong(vigoStations);
      const batteryCap = settings.batteryCapacityKwh || 51.87;
      // Vehicle-side limits come from the car profile (Settings); the temperature is the one
      // forecast at the stop. Both are bundled into one object so no positional slot can be
      // mixed up between the target-SoC and session calls.
      const chargeLimits = resolveChargeLimits(settings);
      const chargePower = (
        connector: ChargeConnector,
        stationMaxPowerKw: number | undefined,
        distanceAlongRouteKm: number,
      ): ChargePowerParams => ({
        connector,
        stationMaxPowerKw,
        temperatureC: getChargingTemperatureAtDistance(distanceAlongRouteKm),
        vehicle: chargeLimits,
      });
      const chargeSession = (
        fromSoc: number,
        toSoc: number,
        connector: ChargeConnector,
        stationMaxPowerKw: number | undefined,
        station: { distanceAlongRouteKm: number; distanceFromRouteKm: number },
      ): ChargeSessionEstimate =>
        estimateChargingSession({
          fromSoc,
          toSoc,
          batteryCapacityKwh: batteryCap,
          ...chargePower(connector, stationMaxPowerKw, station.distanceAlongRouteKm),
          detourKm: station.distanceFromRouteKm,
        });
      const totalDistanceKm = routeElevation.distanceKm;
      const totalEnergyKwh = routeForecast.energyKwh;
      const socAtDistance = (distanceKm: number) =>
        startSoc - (totalEnergyKwh * (distanceKm / Math.max(0.001, totalDistanceKm)) / batteryCap) * 100;

      // Charge only as much as needed for the remaining leg. Finish SOC is a band, not a
      // hard point: prefer ~22%, accept down to ~15% rather than a micro-stop in the last km.
      const IDEAL_ARRIVAL_SOC = 30;
      const FINISH_SOC_TARGET = 22; // preferred when we do charge
      const FINISH_SOC_MIN = 15; // acceptable: no extra stop just to climb 15→22%
      const MIN_USEFUL_CHARGE_SOC = 8; // skip stops that only add a few %
      const MIN_TAIL_KM = 35; // avoid stations in the last ~35 km for tiny top-ups

      const mustCharge = routeForecast.arrivalSoc < CHARGE_SUGGEST_SOC;
      const finishReserveSoc = mustCharge ? FINISH_SOC_TARGET : ARRIVAL_RESERVE_SOC;

            let candidates = vigoStations
        .map((station) => ({
          station,
          socAtStation: socAtDistance(station.distanceAlongRouteKm),
        }))
        .filter(({ station, socAtStation }) => {
          const remainingKm = Math.max(0, totalDistanceKm - station.distanceAlongRouteKm);
          const remainingEnergyKwh = totalEnergyKwh * (remainingKm / Math.max(0.001, totalDistanceKm));
          const minRequiredSoc = Math.min(95, (remainingEnergyKwh / batteryCap) * 100 + finishReserveSoc);
          const chargeNeeded = minRequiredSoc - socAtStation;

          // Forced search: any reachable VIGO stop with room after it — user asked explicitly.
          if (force) {
            if (socAtStation < 5) return false;
            if (remainingKm < 12) return false;
            if (station.distanceAlongRouteKm < 3) return false;
            return true;
          }

          if (socAtStation < ARRIVAL_RESERVE_SOC) return false;
          if (station.distanceAlongRouteKm < 8 && socAtStation > 65) return false;
          if (mustCharge) {
            if (socAtStation >= 70) return false;
            if (socAtStation >= 55 && chargeNeeded < 8) return false;
            if (chargeNeeded < 2) return false;
            if (remainingKm < MIN_TAIL_KM && chargeNeeded < MIN_USEFUL_CHARGE_SOC) return false;
            if (remainingKm < Math.min(20, totalDistanceKm * 0.1) && chargeNeeded < 12) return false;
          } else {
            if (socAtStation < 10) return false;
            if (socAtStation > 82) return false;
            if (remainingKm < Math.min(12, totalDistanceKm * 0.08)) return false;
            if (station.distanceAlongRouteKm < Math.min(10, totalDistanceKm * 0.06)) return false;
            if (Math.min(90, FINISH_SOC_TARGET + 60) - socAtStation < 5 && socAtStation > 75) return false;
          }
          return true;
        })
        .map(({ station, socAtStation }) => {
          const remainingKm = Math.max(0, totalDistanceKm - station.distanceAlongRouteKm);
          const remainingEnergyKwh = totalEnergyKwh * (remainingKm / Math.max(0.001, totalDistanceKm));
          const minRequiredSoc = Math.min(95, (remainingEnergyKwh / batteryCap) * 100 + finishReserveSoc);
          const connector: ChargeConnector = (() => {
            // Prefer a connector the active vehicle actually has.
            if (vehicleConnectors.includes('gbt') && station.hasGbt) return 'gbt';
            if (vehicleConnectors.includes('ccs2') && (station.hasCcs2 || station.connectorTypeUnknown)) return 'ccs2';
            if (vehicleConnectors.includes('type2') && station.hasType2) return 'type2';
            if (station.hasCcs2 || station.connectorTypeUnknown) return 'ccs2';
            if (station.hasGbt) return 'gbt';
            return 'type2';
          })();
          const rawStationMaxPowerKw =
            connector === 'gbt'
              ? station.gbtPowerKw ?? station.ccs2PowerKw
              : connector === 'ccs2'
                ? station.ccs2PowerKw
                : station.type2PowerKw;
          const stationPowerAssumed = rawStationMaxPowerKw === undefined;
          const stationMaxPowerKw = rawStationMaxPowerKw ?? DEFAULT_UNKNOWN_STATION_POWER_KW;
          // Target = energy for remaining km + comfort finish reserve (no forced 80%).
          const desiredTarget = minRequiredSoc;
          // In forced mode the user explicitly asked to see a station even when the
          // route already has enough SOC. Do not let the comfort/charge optimizer turn
          // such a station into a zero-charge candidate and filter it out below. Give
          // the displayed stop a small +5% charging session purely so it remains a
          // valid station suggestion. Normal search keeps the existing optimization.
          const targetSoc = force
            ? Math.min(90, Math.max(socAtStation + 5, desiredTarget))
            : findOptimalChargeTargetSoc(
                socAtStation,
                desiredTarget,
                chargePower(connector, stationMaxPowerKw, station.distanceAlongRouteKm),
                {
                  // Allow only a tiny efficiency pad above the true need.
                  maxTargetSoc: Math.min(90, Math.max(desiredTarget, desiredTarget + 3)),
                  marginalRateThreshold: 0.5,
                },
              );
          const chargeAddedSoc = Math.max(0, targetSoc - socAtStation);
          const session = chargeSession(socAtStation, targetSoc, connector, stationMaxPowerKw, station);
          // Finish SOC = leave station at targetSoc, then burn energy for the remaining km to B.
          // (Old formula arrivalSoc + chargeAdded was wrong: early charge + long remaining leg
          // still looked almost like the unassisted arrival.)
          const finishSocAfterCharge = Math.max(
            0,
            Math.min(100, targetSoc - (remainingEnergyKwh / batteryCap) * 100),
          );

          // Lower score is better.
          const socWindowPenalty = Math.abs(socAtStation - IDEAL_ARRIVAL_SOC) * (mustCharge ? 1.8 : 1.2);
          const highSocPenalty = socAtStation > 50 ? (socAtStation - 50) * (mustCharge ? 2.5 : 1.2) : 0;
          const smallChargePenalty = chargeAddedSoc < 15 ? (15 - chargeAddedSoc) * 2 : 0;
          const detourPenalty = station.distanceFromRouteKm * 5;
          const earlyStopPenalty = Math.max(0, 0.35 * totalDistanceKm - station.distanceAlongRouteKm) * 0.15;
          const score =
            session.chargeMinutes +
            detourPenalty +
            socWindowPenalty +
            highSocPenalty +
            smallChargePenalty +
            earlyStopPenalty;

          return {
            station,
            connector,
            socAtStation,
            targetSoc,
            minRequiredSoc,
            session,
            chargeAddedSoc,
            finishSocAfterCharge,
            stationPowerAssumed,
            score,
          };
        })
        .filter(candidate => (force ? candidate.chargeAddedSoc >= 1 : candidate.chargeAddedSoc >= 2) && candidate.session.minutes > 0)
        .sort((a, b) => {
          if (Math.abs(a.score - b.score) >= 3) return a.score - b.score;
          // Tie-break: later stop, then larger useful charge.
          if (Math.abs(a.station.distanceAlongRouteKm - b.station.distanceAlongRouteKm) >= 15) {
            return b.station.distanceAlongRouteKm - a.station.distanceAlongRouteKm;
          }
          return b.chargeAddedSoc - a.chargeAddedSoc;
        });

      // Soft fallback when strict comfort filters found nothing.
      // Previously this ran only when !mustCharge — so "нужна зарядка" + empty list
      // was a common dead-end (e.g. arrival 15–19% with stations only in the route tail).
      if (!candidates.length) {
        candidates = vigoStations
          .map((station) => {
            const socAtStation = socAtDistance(station.distanceAlongRouteKm);
            const remainingKm = Math.max(0, totalDistanceKm - station.distanceAlongRouteKm);
            // Reachable stop with room after it; slightly looser than comfort window.
            if (socAtStation < 8 || socAtStation > 90) return null;
            if (remainingKm < 12) return null;
            if (station.distanceAlongRouteKm < 5) return null;
            const remainingEnergyKwh = totalEnergyKwh * (remainingKm / Math.max(0.001, totalDistanceKm));
            const minRequiredSoc = Math.min(
              95,
              (remainingEnergyKwh / batteryCap) * 100 + (mustCharge ? FINISH_SOC_TARGET : ARRIVAL_RESERVE_SOC),
            );
            const connector: ChargeConnector = (() => {
              if (vehicleConnectors.includes('gbt') && station.hasGbt) return 'gbt';
              if (vehicleConnectors.includes('ccs2') && (station.hasCcs2 || station.connectorTypeUnknown)) return 'ccs2';
              if (vehicleConnectors.includes('type2') && station.hasType2) return 'type2';
              if (station.hasCcs2 || station.connectorTypeUnknown) return 'ccs2';
              if (station.hasGbt) return 'gbt';
              return 'type2';
            })();
            const rawStationMaxPowerKw =
              connector === 'gbt'
                ? station.gbtPowerKw ?? station.ccs2PowerKw
                : connector === 'ccs2'
                  ? station.ccs2PowerKw
                  : station.type2PowerKw;
            const stationMaxPowerKw = rawStationMaxPowerKw ?? DEFAULT_UNKNOWN_STATION_POWER_KW;
            const desiredTarget = Math.min(
              90,
              Math.max(socAtStation + (mustCharge ? 8 : 5), minRequiredSoc),
            );
            const targetSoc = findOptimalChargeTargetSoc(
              socAtStation,
              desiredTarget,
              chargePower(connector, stationMaxPowerKw, station.distanceAlongRouteKm),
              {
                maxTargetSoc: Math.min(90, Math.max(desiredTarget, desiredTarget + 3)),
                marginalRateThreshold: 0.5,
              },
            );
            const chargeAddedSoc = Math.max(0, targetSoc - socAtStation);
            // When we must charge, even a 5% top-up is better than "no plan".
            if (chargeAddedSoc < (mustCharge ? 5 : 3)) return null;
            const session = chargeSession(socAtStation, targetSoc, connector, stationMaxPowerKw, station);
            if (session.minutes <= 0) return null;
            const finishSocAfterCharge = Math.max(
              0,
              Math.min(100, targetSoc - (remainingEnergyKwh / batteryCap) * 100),
            );
            const score =
              session.chargeMinutes +
              station.distanceFromRouteKm * 5 +
              Math.abs(socAtStation - IDEAL_ARRIVAL_SOC) * 1.0 +
              Math.abs(station.distanceAlongRouteKm - totalDistanceKm * 0.45) * 0.2;
            return {
              station,
              connector,
              socAtStation,
              targetSoc,
              minRequiredSoc,
              session,
              chargeAddedSoc,
              finishSocAfterCharge,
              stationPowerAssumed: rawStationMaxPowerKw === undefined,
              score,
            };
          })
          .filter((x): x is NonNullable<typeof x> => !!x)
          .sort((a, b) => a.score - b.score);
      }

      if (!candidates.length) {
        setChargingSuggestion(null);
        setChargingStops([]);
        setChargingSuggestionStatus('unavailable');
        return;
      }

      // Forced search is a display action: if the user explicitly asked to see
      // stations, do not run the comfort multi-stop planner. That planner can
      // legitimately return an empty plan when the route already has enough SOC,
      // which used to make the button appear to do nothing.
      if (force) {
        const forcedStops = candidates.slice(0, 4).map(({ station, connector, socAtStation, targetSoc, session, finishSocAfterCharge }) => ({
          station,
          connector,
          socAtStation,
          targetSoc,
          session,
          finishSocAfterCharge,
        }));
        if (forcedStops.length) {
          setChargingSuggestion(candidates[0]);
          setChargingStops(forcedStops);
          setChargingSuggestionStatus('ready');
        } else {
          setChargingSuggestion(null);
          setChargingStops([]);
          setChargingSuggestionStatus('unavailable');
        }
        return;
      }

      // Multi-stop plan: chain stops until finish SOC is in the acceptable band
      // [FINISH_SOC_MIN … FINISH_SOC_TARGET+], without a micro-stop near B.
      // Long routes in heavy conditions (cold, headwind, snow) can need many stops;
      // the loop still ends as soon as projected finish SOC is acceptable, and each
      // stop must be >= MIN_GAP_KM further along, so this is only a safety ceiling.
      const MAX_STOPS = 10;
      const MIN_GAP_KM = 25;
      const plan: typeof candidates = [];
      let cursorKm = 0;
      let socCursor = startSoc;
      const energyPerKm = totalEnergyKwh / Math.max(0.001, totalDistanceKm);

      // Soft tail when the route is energy-critical; hard tail only for optional comfort stops.
      // Never use 35 km when finish would otherwise be 0% — stations on Baranovichi→Brest must stay eligible.
      const effectiveMinTailKm = mustCharge ? 12 : MIN_TAIL_KM;

      const resolveConnector = (station: (typeof vigoStations)[0]): ChargeConnector => {
        if (vehicleConnectors.includes('gbt') && station.hasGbt) return 'gbt';
        if (vehicleConnectors.includes('ccs2') && (station.hasCcs2 || station.connectorTypeUnknown)) return 'ccs2';
        if (vehicleConnectors.includes('type2') && station.hasType2) return 'type2';
        if (station.hasCcs2 || station.connectorTypeUnknown) return 'ccs2';
        if (station.hasGbt) return 'gbt';
        return 'type2';
      };

      const buildStopCandidate = (
        station: (typeof vigoStations)[0],
        socAtStation: number,
        reserveAtB: number,
        opts?: { minTailKm?: number; minChargeSoc?: number; allowHighArrival?: boolean },
      ) => {
        const remainingKm = Math.max(0, totalDistanceKm - station.distanceAlongRouteKm);
        const remainingEnergyKwh = energyPerKm * remainingKm;
        const minTail = opts?.minTailKm ?? effectiveMinTailKm;
        if (remainingKm < minTail) return null;
        // True need for the rest of the trip (may exceed 95% — then this stop alone cannot finish B).
        const rawNeed = (remainingEnergyKwh / batteryCap) * 100 + reserveAtB;
        const minRequiredSoc = Math.min(95, rawNeed);
        const connector = resolveConnector(station);
        const rawStationMaxPowerKw =
          connector === 'gbt'
            ? station.gbtPowerKw ?? station.ccs2PowerKw
            : connector === 'ccs2'
              ? station.ccs2PowerKw
              : station.type2PowerKw;
        const stationMaxPowerKw = rawStationMaxPowerKw ?? DEFAULT_UNKNOWN_STATION_POWER_KW;
        // If B is unreachable even at 90%, charge to a practical leg target (~80–90%)
        // so the next stop further along remains usable — not a false "done" at 95%→0% finish.
        const cannotReachBAlone = rawNeed > 92;
        const desiredTarget = cannotReachBAlone
          ? Math.min(90, Math.max(socAtStation + MIN_USEFUL_CHARGE_SOC, 80))
          : minRequiredSoc;
        const targetSoc = findOptimalChargeTargetSoc(socAtStation, desiredTarget, chargePower(connector, stationMaxPowerKw, station.distanceAlongRouteKm), {
          maxTargetSoc: Math.min(90, Math.max(desiredTarget, desiredTarget + 3)),
          marginalRateThreshold: 0.5,
        });
        const chargeAddedSoc = Math.max(0, targetSoc - socAtStation);
        const minCharge = opts?.minChargeSoc ?? MIN_USEFUL_CHARGE_SOC;
        if (chargeAddedSoc < minCharge) return null;
        const session = chargeSession(socAtStation, targetSoc, connector, stationMaxPowerKw, station);
        if (session.minutes <= 0) return null;
        const finishSocAfterCharge = Math.max(
          0,
          Math.min(100, targetSoc - (remainingEnergyKwh / batteryCap) * 100),
        );
        // Prefer stops that leave a workable pack for the next leg when B is still far.
        const unreachablePenalty = cannotReachBAlone ? 40 : 0;
        const score =
          session.chargeMinutes +
          station.distanceFromRouteKm * 5 +
          Math.abs(socAtStation - IDEAL_ARRIVAL_SOC) * 1.5 +
          (socAtStation > 50 ? (socAtStation - 50) * 1.2 : 0) +
          unreachablePenalty;
        return {
          station,
          connector,
          socAtStation,
          targetSoc,
          minRequiredSoc,
          session,
          chargeAddedSoc,
          finishSocAfterCharge,
          stationPowerAssumed: rawStationMaxPowerKw === undefined,
          score,
        };
      };

      for (let n = 0; n < MAX_STOPS; n++) {
        const remainingFromCursor = Math.max(0, totalDistanceKm - cursorKm);
        const projectedFinish = socCursor - (energyPerKm * remainingFromCursor * 100) / batteryCap;
        // Accept the band: e.g. 18% is fine — do not add a last stop for +4%.
        if (projectedFinish >= FINISH_SOC_MIN) break;

        const critical = projectedFinish < FINISH_SOC_MIN;
        const pool = (
          n === 0
            ? candidates
            : vigoStations
                .map((station) => {
                  const dist = station.distanceAlongRouteKm;
                  if (dist < cursorKm + MIN_GAP_KM) return null;
                  const socAtStation =
                    socCursor - (energyPerKm * (dist - cursorKm) * 100) / batteryCap;
                  // Reachable with a small reserve. Do NOT reject high arrival SOC after a
                  // previous charge (was >70) — that blocked Baranovichi→Brest stops after
                  // leaving the previous plug at 80–90%.
                  if (socAtStation < (critical ? 5 : ARRIVAL_RESERVE_SOC)) return null;
                  if (!critical && socAtStation > 82) return null;
                  if (critical && socAtStation > 90) return null;
                  return buildStopCandidate(station, socAtStation, FINISH_SOC_TARGET, {
                    minTailKm: critical ? 10 : effectiveMinTailKm,
                    minChargeSoc: critical ? 5 : MIN_USEFUL_CHARGE_SOC,
                    allowHighArrival: critical,
                  });
                })
                .filter((x): x is NonNullable<typeof x> => !!x)
                .sort((a, b) => a.score - b.score)
        );

        if (!pool.length) break;
        const pick = pool.find((c) => c.chargeAddedSoc >= (critical ? 5 : MIN_USEFUL_CHARGE_SOC)) ?? pool[0];
        if (pick.chargeAddedSoc < 3) break;

        plan.push(pick);
        cursorKm = pick.station.distanceAlongRouteKm;
        socCursor = pick.targetSoc;
        if (pick.finishSocAfterCharge >= FINISH_SOC_MIN) break;
      }

      // Recovery: plan still ends below the band — pull any remaining stations past the last
      // stop (e.g. highway CCS between Baranovichi and Brest) with relaxed gates.
      while (plan.length < MAX_STOPS) {
        const lastKm = plan.length ? plan[plan.length - 1].station.distanceAlongRouteKm : 0;
        const lastTarget = plan.length ? plan[plan.length - 1].targetSoc : startSoc;
        const remainingFromLast = Math.max(0, totalDistanceKm - lastKm);
        const projected =
          lastTarget - (energyPerKm * remainingFromLast * 100) / batteryCap;
        if (projected >= FINISH_SOC_MIN) break;

        const recovery = vigoStations
          .map((station) => {
            const dist = station.distanceAlongRouteKm;
            if (dist < lastKm + Math.min(MIN_GAP_KM, 15)) return null;
            const socAtStation =
              lastTarget - (energyPerKm * (dist - lastKm) * 100) / batteryCap;
            if (socAtStation < 5 || socAtStation > 92) return null;
            return buildStopCandidate(station, socAtStation, FINISH_SOC_TARGET, {
              minTailKm: 8,
              minChargeSoc: 4,
            });
          })
          .filter((x): x is NonNullable<typeof x> => !!x)
          .sort((a, b) => a.score - b.score);

        if (!recovery.length) break;
        const extra = recovery[0];
        plan.push(extra);
        if (extra.finishSocAfterCharge >= FINISH_SOC_MIN) break;
      }

      // Drop a trailing micro-stop only when it is truly tiny AND finish is already acceptable
      // (or becomes so after a modest bump on the previous stop). Never drop a stop that is
      // the only reason finish is not 0%.
      if (plan.length >= 2) {
        const last = plan[plan.length - 1];
        const prev = plan[plan.length - 2];
        const lastIsMicro = last.chargeAddedSoc < MIN_USEFUL_CHARGE_SOC + 2;
        const finishAlreadyOk = last.finishSocAfterCharge >= FINISH_SOC_MIN;
        if (lastIsMicro && finishAlreadyOk) {
          const remainingKmPrev = Math.max(0, totalDistanceKm - prev.station.distanceAlongRouteKm);
          const remainingEnergyPrev = energyPerKm * remainingKmPrev;
          const bumpTarget = Math.min(
            90,
            Math.max(
              prev.targetSoc,
              (remainingEnergyPrev / batteryCap) * 100 + FINISH_SOC_TARGET,
            ),
          );
          const connector = prev.connector;
          const stationMax =
            (connector === 'gbt'
              ? prev.station.gbtPowerKw ?? prev.station.ccs2PowerKw
              : connector === 'ccs2'
                ? prev.station.ccs2PowerKw
                : prev.station.type2PowerKw) ?? DEFAULT_UNKNOWN_STATION_POWER_KW;
          const targetSoc = findOptimalChargeTargetSoc(prev.socAtStation, bumpTarget, chargePower(connector, stationMax, prev.station.distanceAlongRouteKm), {
            maxTargetSoc: Math.min(90, Math.max(bumpTarget, bumpTarget + 3)),
            marginalRateThreshold: 0.5,
          });
          const session = chargeSession(prev.socAtStation, targetSoc, connector, stationMax, prev.station);
          const finishSocAfterCharge = Math.max(
            0,
            Math.min(100, targetSoc - (remainingEnergyPrev / batteryCap) * 100),
          );
          // Only drop last if the bumped previous stop still lands in the finish band.
          if (finishSocAfterCharge >= FINISH_SOC_MIN) {
            plan[plan.length - 2] = {
              ...prev,
              targetSoc,
              session,
              chargeAddedSoc: Math.max(0, targetSoc - prev.socAtStation),
              finishSocAfterCharge,
            };
            plan.pop();
          }
        }
      }

      // Planner produced nothing (e.g. all candidates in the hard tail) but the
      // ranked list still has usable stops — take the best one rather than "unavailable".
      if (!plan.length && candidates.length) {
        plan.push(candidates[0]);
      }

      if (!plan.length) {
        setChargingSuggestion(null);
        setChargingStops([]);
        setChargingSuggestionStatus('unavailable');
        return;
      }

      if (!cancelled) {
        setChargingSuggestion(plan[0]);
        setChargingStops(
          plan.map(({ station, connector, socAtStation, targetSoc, session, finishSocAfterCharge }) => ({
            station,
            connector,
            socAtStation,
            targetSoc,
            session,
            finishSocAfterCharge,
          })),
        );
        setChargingSuggestionStatus('ready');
      }
    } catch (e) {
      console.error('[CalculatorTab] charging suggestion failed:', e);
      if (!cancelled) {
        setChargingSuggestion(null);
        setChargingStops([]);
        setChargingSuggestionStatus('error');
      }
    }
    return () => { cancelled = true; };
  }, [routeElevation, routeForecast, routeWeather, startSoc, settings.batteryCapacityKwh, settings.vehicleProfileId, settings.vehicleVariantId, settings.connectorOverride, settings.dcMaxKw, settings.acMaxKw, getChargingTemperatureAtDistance]);

  // Automatic search is deliberately limited to the low-arrival-SOC case.
  useEffect(() => {
    if (!routeElevation || !routeForecast || routeForecast.arrivalSoc >= CHARGE_SUGGEST_SOC) {
      setChargingSuggestion(null);
      setChargingStops([]);
      setChargingSuggestionStatus('idle');
      setStationsFoundAlongRoute(0);
    setRouteStationsAlong([]);
      return;
    }
    void searchChargingStations();
  }, [routeElevation, routeForecast, searchChargingStations]);

  const calculateBearing = (lat1:number, lon1:number, lat2:number, lon2:number) => {
    const r=Math.PI/180, y=Math.sin((lon2-lon1)*r)*Math.cos(lat2*r), x=Math.cos(lat1*r)*Math.sin(lat2*r)-Math.sin(lat1*r)*Math.cos(lat2*r)*Math.cos((lon2-lon1)*r);
    return (Math.atan2(y,x)*180/Math.PI+360)%360;
  };

  const fetchRouteWeather = async (lat: number, lon: number, arrivalDate: Date) => {
    const result = await fetchForecastWeatherAt(lat, lon, arrivalDate);
    if (!result) throw new Error('Не удалось получить прогноз погоды. Попробуйте ещё раз.');
    return result;
  };

  const getDriverStyleSourceLabel = (source: string) => {
    if (source === 'monthly_history') return 'Журнал за 30 дней';
    if (source === 'all_history') return 'Вся история поездок';
    if (source === 'current_trip') return 'Текущая поездка';
    return 'Базовая модель';
  };

  const getClimateModeLabel = () => climateOn ? 'Включен · AUTO' : 'Выключен';

  const updateRouteStartSoc = (value: number) => {
    const next = Math.max(1, Math.min(100, Math.round(value)));
    setStartSoc(next);
    setRouteForecast((prev) => {
      if (!prev) return prev;
      const cap = settings.batteryCapacityKwh || 51.87;
      const arrivalSoc = Math.max(0, Number((next - (prev.energyKwh / cap) * 100).toFixed(1)));
      return { ...prev, arrivalSoc };
    });
  };

  const rememberPlace = (place: RecentPlace) => {
    const name = (place.name || '').trim();
    if (!name || name === 'Текущая геопозиция') return;
    setRecentPlaces((prev) => {
      const next = [{ ...place, name }, ...prev.filter((p) => p.name !== name)].slice(0, 5);
      try { localStorage.setItem(RECENT_PLACES_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const calculateRouteProfile = async (destOverride?: { lat: number; lon: number; displayName: string }) => {
    // Guard: onClick may pass a MouseEvent if wired as onClick={calculateRouteProfile}.
    const dest =
      destOverride &&
      typeof destOverride === 'object' &&
      typeof (destOverride as { lat?: unknown }).lat === 'number' &&
      typeof (destOverride as { lon?: unknown }).lon === 'number' &&
      Number.isFinite((destOverride as { lat: number }).lat) &&
      Number.isFinite((destOverride as { lon: number }).lon)
        ? destOverride
        : undefined;
    if (!dest && !destinationAddress.trim()) { setRouteError('Введите адрес точки Б'); return; }
    if (startMode === 'address' && !startAddress.trim()) { setRouteError('Введите адрес точки А'); return; }
    setRouteLoading(true); setRouteError(''); setRouteElevation(null); setRouteWeather(null); setRouteForecast(null);
    const onProgress = (p: RouteProgress) => setRouteStatus(p.message);
    try {
      let start: { lat:number; lon:number; displayName:string };
      if (startMode === 'gps') {
        if (!navigator.geolocation) throw new Error('Геолокация недоступна');
        setRouteStatus('Получаем текущую геопозицию…');
        const pos = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy:true, timeout:15000, maximumAge:30000 }));
        start = { lat:pos.coords.latitude, lon:pos.coords.longitude, displayName:'Текущая геопозиция' };
      } else if (startPin) { start = { lat: startPin.lat, lon: startPin.lon, displayName: startAddress.trim() }; }
      else { setRouteStatus('Ищем начальный адрес…'); start = await geocodeAddress(startAddress.trim()); }
      let destination: { lat:number; lon:number; displayName:string };
      if (dest) {
        destination = dest;
      } else if (
        destinationPin &&
        Number.isFinite(destinationPin.lat) &&
        Number.isFinite(destinationPin.lon)
      ) {
        destination = { lat: destinationPin.lat, lon: destinationPin.lon, displayName: destinationAddress.trim() };
      } else {
        setRouteStatus('Ищем адрес назначения…');
        destination = await geocodeAddress(destinationAddress.trim());
      }
      if (
        !Number.isFinite(start.lat) ||
        !Number.isFinite(start.lon) ||
        !Number.isFinite(destination.lat) ||
        !Number.isFinite(destination.lon)
      ) {
        throw new Error('Не удалось определить координаты. Выберите адрес из списка или укажите точку на карте.');
      }
      const data = await buildRouteElevation(start.lat,start.lon,destination.lat,destination.lon,destination.displayName,onProgress);
      setRouteElevation(data); setDistanceKm(data.distanceKm);
      rememberPlace({ name: destination.displayName, lat: destination.lat, lon: destination.lon });
      const etaMinutes=Math.max(1,Math.round((data.distanceKm/Math.max(10,plannedSpeedKmH))*60));
      // Всегда используем текущее время: API прогноза корректно работает для актуального
      // погодного окна, без выбора удалённой даты отправления.
      const departureDate = new Date();
      const arrivalDate=new Date(departureDate.getTime()+etaMinutes*60000);
      const avg = <T,>(values:T[], fallback:T) => values.length ? values.reduce((a:any,b:any)=>a+b,0)/values.length : fallback;
      let samples: RouteWeatherSample[] = [];
      let avgTemperature = 20;
      let avgWindSpeed = 0;
      let avgPrecipitation = 0;
      let avgWeatherCode = 0;
      const routeBearing=calculateBearing(start.lat,start.lon,destination.lat,destination.lon);
      let avgRelativeWindAngle = 0;

      if (weatherMode === 'current') {
        setRouteStatus('Получаем прогноз погоды по маршруту…');
        samples = await fetchForecastWeatherAlongRoute(data.points, departureDate, plannedSpeedKmH);
        if (!samples.length) throw new Error('Не удалось получить актуальный прогноз погоды по маршруту. Попробуйте повторить расчёт позже.');
        avgTemperature = avg(samples.map(s=>s.weather.temperature), 20);
        avgPrecipitation = avg(samples.map(s=>s.weather.precipitation), 0);
        avgWeatherCode = samples[Math.floor(samples.length/2)].weather.weatherCode;

        // Wind is resolved locally at each route sample. This avoids treating a long,
        // curving route as if it had one single A→B bearing. We average the wind vector
        // (longitudinal + lateral components), not compass angles as plain numbers.
        let sumLong = 0;
        let sumLat = 0;
        samples.forEach(s => {
          const rel = ((s.weather.windDirection - s.routeBearing + 540) % 360) - 180;
          const rad = rel * Math.PI / 180;
          sumLong += s.weather.windSpeed * Math.cos(rad);
          sumLat += s.weather.windSpeed * Math.sin(rad);
        });
        sumLong /= samples.length;
        sumLat /= samples.length;
        avgWindSpeed = Math.sqrt(sumLong * sumLong + sumLat * sumLat);
        avgRelativeWindAngle = (Math.atan2(sumLat, sumLong) * 180 / Math.PI + 360) % 360;
      } else {
        // Manual weather deliberately bypasses forecast APIs, so planning works for any future date/season.
        avgTemperature = manualTemperature;
        // The manual input field is in m/s (matches how wind is usually reported), but the
        // whole consumption model (estimateTripConsumption / estimateSegmentedRouteConsumption)
        // works in km/h — same unit Open-Meteo returns for the "current" weather mode. Convert
        // here so both weather modes feed the physics model consistently.
        avgWindSpeed = manualWindSpeed * 3.6;
        if (manualPrecipitationType === 'none') {
          avgPrecipitation = 0;
          avgWeatherCode = 0;
        } else {
          const preset = MANUAL_PRECIPITATION_PRESETS[manualPrecipitationType][manualPrecipitationIntensity];
          avgPrecipitation = preset.mm;
          avgWeatherCode = preset.code;
        }
        avgRelativeWindAngle = (manualWindDirection - routeBearing + 360) % 360;
      }
      const fallbackWeather = {
        temperature: avgTemperature, weatherCode: avgWeatherCode, precipitation: avgPrecipitation,
        windSpeed: avgWindSpeed, windDirection: weatherMode === 'planning' ? manualWindDirection : (samples[0]?.weather.windDirection ?? 0),
      };
      const segmented = estimateSegmentedRouteConsumption(
        data.points,
        samples.map(s => ({ distanceFromStartKm: s.distanceFromStartKm, weather: s.weather, routeBearing: s.routeBearing })),
        fallbackWeather, plannedSpeedKmH, sessions, settings.batteryCapacityKwh, climateOn, undefined, passengers, plannedMaxSpeedKmH,
        settings.curbWeightKg ?? 1600, settings.consumptionScale ?? 1, settings.hasHeatPump ?? true,
      );
      const energyKwh = segmented.energyKwh;
      const arrivalSoc = Math.max(0, Number((startSoc - (energyKwh/(settings.batteryCapacityKwh||51.87))*100).toFixed(1)));
      const segmentedForecast = estimateTripConsumption(
        plannedSpeedKmH, segmented.avgTemperature, sessions, settings.batteryCapacityKwh, climateOn,
        segmented.avgWindSpeed, avgRelativeWindAngle, undefined, avgWeatherCode, segmented.avgPrecipitation,
        {gainM:data.elevationGainM, lossM:data.elevationLossM, distanceKm:data.distanceKm}, segmented.durationHours, segmented.climatePowerKw, passengers,
        settings.curbWeightKg ?? 1600, settings.consumptionScale ?? 1, settings.hasHeatPump ?? true,
      );
      const displayWeather = weatherMode === 'current' && samples.length ? samples[Math.min(samples.length - 1, Math.floor(samples.length / 2))].weather : { temperature: avgTemperature, windSpeed: avgWindSpeed, windDirection: manualWindDirection, weatherCode: avgWeatherCode, precipitation: avgPrecipitation };
      setRouteWeather({ ...displayWeather, temperature:Math.round(avgTemperature), windSpeed:Math.round(avgWindSpeed), precipitation:Number(avgPrecipitation.toFixed(1)), routeBearing, etaMinutes, arrivalDate, samples });
      setRouteForecast({consumption:Number((energyKwh/data.distanceKm*100).toFixed(2)),energyKwh:Number(energyKwh.toFixed(2)),arrivalSoc,windLabel:segmentedForecast.windStatusText || `Ветер ~${Math.round(segmented.avgWindSpeed)} км/ч`,weatherLabel:`${Math.round(segmented.avgTemperature)>=0?'+':''}${Math.round(segmented.avgTemperature)}°C`,precipitationLabel:segmentedForecast.precipitationLabel||'Без существенных осадков',relativeWindAngle:avgRelativeWindAngle,driverStyleFactor:segmentedForecast.driverStyleFactor,driverStyleSource:getDriverStyleSourceLabel(segmentedForecast.dataSource),climateLabel:segmentedForecast.climateLabel || `Климат · ${segmented.climatePowerKw.toFixed(1)} кВт`,climateImpactPct:segmentedForecast.climateImpactPct || 0,climateDeltaKwh100:Number((segmented.climateEnergyKwh/data.distanceKm*100).toFixed(2)),climatePowerKw:segmented.climatePowerKw,speedImpactPct:segmentedForecast.speedImpactPct,breakdown:segmented});
      setEndSoc(arrivalSoc);
      // Stash this forecast so that if a matching HUD trip is saved to history later today, we
      // can attach predicted-vs-actual for comparison (see routeForecastBridge.ts).
      saveLastRouteForecast({
        distanceKm: data.distanceKm,
        plannedSpeedKmH,
        plannedMaxSpeedKmH,
        arrivalSoc,
        consumptionPer100Km: Number((energyKwh / data.distanceKm * 100).toFixed(2)),
        energyKwh: Number(energyKwh.toFixed(2)),
        speedProfile: segmented.speedProfile,
      });
      // Keep secondary panels collapsed so the hero result stays in view
      setConsumptionOpen(false);
      setSheetMode('peek');
      setRouteStatus('Готово');
      triggerHaptic('success', settings.hapticFeedback);
      setResultHighlight(true);
      window.setTimeout(() => setResultHighlight(false), 1800);
    } catch (e) {
      const msg=e instanceof Error?e.message:'Ошибка расчёта маршрута';
      const isGpsIssue = /denied|permission|геопозиц|geolocation|position/i.test(msg);
      if (isGpsIssue) {
        setRouteError('GPS недоступен. Укажите адрес точки А вручную.');
        setStartMode('address');
      } else {
        setRouteError(msg);
      }
      setRouteStatus('');
    } finally { setRouteLoading(false); }
  };

  const getWhatIfScenario = (speed: number) => {
    if (!routeElevation || !routeWeather) return null;
    const samples = routeWeather.samples ?? [];
    const fallbackWeather = {
      temperature: routeWeather.temperature,
      weatherCode: routeWeather.weatherCode,
      precipitation: routeWeather.precipitation,
      windSpeed: routeWeather.windSpeed,
      windDirection: routeWeather.windDirection,
    };
    const breakdown = estimateSegmentedRouteConsumption(
      routeElevation.points,
      samples.map(s => ({ distanceFromStartKm: s.distanceFromStartKm, weather: s.weather, routeBearing: s.routeBearing })),
      fallbackWeather,
      speed,
      sessions,
      settings.batteryCapacityKwh,
      climateOn, undefined, passengers, Math.max(plannedMaxSpeedKmH, speed),
      settings.curbWeightKg ?? 1600, settings.consumptionScale ?? 1, settings.hasHeatPump ?? true,
    );
    const energyKwh = breakdown.energyKwh;
    const arrivalSoc = Math.max(0, Number((startSoc - (energyKwh / (settings.batteryCapacityKwh || 51.87)) * 100).toFixed(1)));
    const forecast = estimateTripConsumption(
      speed, breakdown.avgTemperature, sessions, settings.batteryCapacityKwh, climateOn,
      breakdown.avgWindSpeed, routeForecast?.relativeWindAngle ?? 0, undefined,
      routeWeather.weatherCode, breakdown.avgPrecipitation,
      { gainM: routeElevation.elevationGainM, lossM: routeElevation.elevationLossM, distanceKm: routeElevation.distanceKm },
      breakdown.durationHours, breakdown.climatePowerKw, passengers,
      settings.curbWeightKg ?? 1600, settings.consumptionScale ?? 1, settings.hasHeatPump ?? true,
    );
    return { speed, consumption: Number((energyKwh / routeElevation.distanceKm * 100).toFixed(2)), arrivalSoc, speedImpactPct: forecast.speedImpactPct, breakdown };
  };


  // Finds the speed that minimizes total route energy for the currently loaded route,
  // weather, elevation, HVAC setting and battery state. This is a local calculation —
  // it does not trigger any additional route/weather API requests.
  const getOptimalSpeedScenario = () => {
    if (!routeElevation || !routeWeather || !routeForecast) return null;
    const candidates = Array.from({ length: 15 }, (_, i) => 50 + i * 5); // 50..120 km/h
    const scenarios = candidates
      .map((speed) => getWhatIfScenario(speed))
      .filter((s): s is NonNullable<ReturnType<typeof getWhatIfScenario>> => Boolean(s));
    if (!scenarios.length) return null;
    return scenarios.reduce((best, current) => {
      const bestEnergy = (routeElevation.distanceKm / 100) * best.consumption;
      const currentEnergy = (routeElevation.distanceKm / 100) * current.consumption;
      return currentEnergy < bestEnergy ? current : best;
    });
  };

  const optimalSpeedScenario = getOptimalSpeedScenario();

  // Fast math calculations
  const batteryCap = settings.batteryCapacityKwh || 51.87;
  const socUsedPct = Math.max(0, startSoc - endSoc);
  const energyUsedKwh = Math.max(0, (socUsedPct / 100) * batteryCap);
  
  // Consumption per 100 km
  const consumptionPer100Km = distanceKm > 0 ? (energyUsedKwh / distanceKm) * 100 : 0;
  const kmPerKwh = energyUsedKwh > 0 ? distanceKm / energyUsedKwh : 0;
  
  // Total potential real range at this consumption rate
  const predictedFullRangeKm = consumptionPer100Km > 0 ? (batteryCap / consumptionPer100Km) * 100 : 0;
  // Remaining range on current endSoc
  const remainingRangeKm = consumptionPer100Km > 0 ? (((endSoc / 100) * batteryCap) / consumptionPer100Km) * 100 : 0;

  // Display-only ETA: keep the existing route time and add the already calculated
  // charging-session time. This does not change any route/consumption calculations.
  const totalChargingMinutes = chargingStops.reduce((sum, stop) => sum + Math.max(0, stop.session.minutes || 0), 0);
  // Display-only final SOC: when a real charging plan is required, show the
  // already calculated post-charge finish SOC directly in the main SOC block.
  // Forced station display must not affect this value.
  const chargingFinishSoc = !chargingSearchForced
    ? (chargingStops.length > 0
        ? chargingStops[chargingStops.length - 1].finishSocAfterCharge
        : (chargingSuggestion && chargingSuggestion.chargeAddedSoc > 0
            ? chargingSuggestion.finishSocAfterCharge
            : null))
    : null;
  const hasChargingAdjustedFinishSoc = chargingFinishSoc !== null;
  const finishArrivalDate = routeWeather?.arrivalDate
    ? new Date(routeWeather.arrivalDate.getTime() + totalChargingMinutes * 60000)
    : null;
  const finishWeatherSample = routeWeather?.samples?.length
    ? routeWeather.samples[routeWeather.samples.length - 1]?.weather
    : null;
  const finishTemperature = finishWeatherSample?.temperature ?? routeWeather?.temperature ?? null;
  const finishPrecipitation = finishWeatherSample?.precipitation ?? routeWeather?.precipitation ?? 0;
  const elevationAdjustedEnergyKwh = routeElevation ? Math.max(0, energyUsedKwh + routeElevation.netElevationEnergyKwh) : energyUsedKwh;
  const elevationAdjustedConsumption = routeElevation && routeElevation.distanceKm > 0 ? (elevationAdjustedEnergyKwh / routeElevation.distanceKm) * 100 : consumptionPer100Km;

  // Cost calculation
  const activeTariff = getTariffForType(chargingType, settings);
  const tripCost = energyUsedKwh * activeTariff;
  const costPer100Km = consumptionPer100Km * activeTariff;

  // Petrol comparison
  const gasCostEquivalent = (distanceKm / 100) * settings.gasEquivalentL100km * settings.gasPricePerLiter;
  const moneySaved = Math.max(0, gasCostEquivalent - tripCost);

  // Efficiency Rating
  const getEfficiencyRating = (cons: number) => {
    if (cons <= 0) return { label: 'Ожидание ввода', color: 'text-slate-400', bg: 'bg-slate-800' };
    if (cons < 13.5) return { label: 'Супер экономно', color: 'text-cyan-400', bg: 'bg-cyan-950/80 border-cyan-800/60' };
    if (cons < 16.5) return { label: 'Отличный расход', color: 'text-cyan-400', bg: 'bg-cyan-950/80 border-cyan-800/60' };
    if (cons < 19.5) return { label: 'Умеренный расход', color: 'text-amber-400', bg: 'bg-amber-950/80 border-amber-800/60' };
    return { label: 'Повышенный расход', color: 'text-rose-400', bg: 'bg-rose-950/80 border-rose-800/60' };
  };

  const rating = getEfficiencyRating(consumptionPer100Km);

  // Increment helper
  const adjustValue = (
    setter: React.Dispatch<React.SetStateAction<number>>,
    delta: number,
    min: number,
    max: number
  ) => {
    triggerHaptic('light', settings.hapticFeedback);
    setter((prev) => Math.min(max, Math.max(min, Number((prev + delta).toFixed(1)))));
  };

  const handleQuickSave = () => {
    triggerHaptic('success', settings.hapticFeedback);
    onSaveToHistory({
      date: new Date().toISOString().split('T')[0],
      startSoc,
      endSoc,
      distanceKm,
      energyUsedKwh: Number(energyUsedKwh.toFixed(2)),
      consumptionPer100Km: Number(consumptionPer100Km.toFixed(2)),
      kmPerKwh: Number(kmPerKwh.toFixed(2)),
      chargingType,
      totalCost: Number(tripCost.toFixed(2)),
      gasCostEquivalent: Number(gasCostEquivalent.toFixed(2)),
      moneySaved: Number(moneySaved.toFixed(2)),
      roadType,
      climateOn,
      passengers,
      temperature: routeWeather?.temperature ?? 20,
      note: `Калькулятор: ${Math.round(startSoc)}% → ${Math.round(endSoc)}%, ${distanceKm} км${routeElevation ? ` · ▲${routeElevation.elevationGainM}м ▼${routeElevation.elevationLossM}м` : ''}`,
      elevationGainM: routeElevation?.elevationGainM,
      elevationLossM: routeElevation?.elevationLossM,
      startElevationM: routeElevation?.startElevationM,
      endElevationM: routeElevation?.endElevationM,
      elevationEnergyUsedKwh: routeElevation?.grossClimbEnergyKwh,
      regenEnergyRecoveredKwh: routeElevation?.recoveredEnergyKwh,
    });
  };

  // Recalculate after A/B were edited through the search card (state is fresh by the time this runs).
  useEffect(() => {
    if (recalcTick > 0) void calculateRouteProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recalcTick]);
  const requestRecalc = () => setRecalcTick((n) => n + 1);

  /** Clear the route on screen and go back to the "Куда едем?" state. */
  const resetRoute = () => {
    setDestinationAddress('');
    setDestinationPin(null);
    setRouteElevation(null);
    setRouteWeather(null);
    setRouteForecast(null);
    setRouteError('');
    setChargingSuggestion(null);
    setChargingStops([]);
    setChargingSuggestionStatus('idle');
    setSelectedRouteStop(null);
    setStationsFoundAlongRoute(0);
    setRouteStationsAlong([]);
    setSheetMode('peek');
    setSearchEditing(false);
    setChargingSearchForced(false);
  };

  const resetAll = () => {
    setStartSoc(100);
    setEndSoc(45);
    setDistanceKm(50);
    setClimateOn(true);
    setPassengers(1);
    setPlannedSpeedKmH(70);
    setPlannedMaxSpeedKmH(120);
    setWeatherMode('current');
    setRoadType('city');
    setStartMode('gps');
    setStartAddress('');
    setStartPin(null);
    setParamsDirty(false);
    resetRoute();
    try { localStorage.removeItem('vigo_calculator_draft_v1'); } catch { /* ignore */ }
  };

  /** Hand the planned route (with charging waypoints) over to the HUD tab. */
  const handleStartTrip = () => {
    if (!onSendToHud || !routeElevation) return;
    triggerHaptic('success', settings.hapticFeedback);
    const totalKm = routeElevation?.distanceKm ?? distanceKm;
    const waypoints = [
      ...chargingStops.map((stop) => ({
        kind: 'charge' as const,
        name: stop.station.name || 'Зарядка',
        distanceAlongRouteKm: stop.station.distanceAlongRouteKm,
        lat: stop.station.lat,
        lon: stop.station.lon,
        plannedArrivalSoc: stop.socAtStation,
        chargeTargetSoc: stop.targetSoc,
        connectorLabel:
          stop.connector === 'gbt'
            ? 'GB/T'
            : stop.connector === 'ccs2'
              ? 'CCS'
              : 'Type2',
        stationId: stop.station.id,
        address: stop.station.address,
        operator: stop.station.operator,
        ccs2PowerKw: stop.station.ccs2PowerKw,
        gbtPowerKw: stop.station.gbtPowerKw,
        type2PowerKw: stop.station.type2PowerKw,
      })),
      {
        kind: 'destination' as const,
        name: destinationAddress.trim(),
        distanceAlongRouteKm: totalKm,
      },
    ];
    let routePoints:
      | Array<{ lat: number; lon: number; elevationM?: number; distanceFromStartKm?: number }>
      | undefined;
    const pts = routeElevation?.points;
    if (pts && pts.length >= 2) {
      const maxPts = 280;
      const toPt = (p: (typeof pts)[number]) => ({
        lat: p.lat,
        lon: p.lon,
        elevationM: p.elevationM,
        distanceFromStartKm: p.distanceFromStartKm,
      });
      if (pts.length <= maxPts) {
        routePoints = pts.map(toPt);
      } else {
        const rdp = (arr: typeof pts, eps: number): typeof pts => {
          if (arr.length <= 2) return arr.slice();
          const toRad = Math.PI / 180;
          const lat0 = arr[0].lat * toRad;
          const mPerDegLat = 111_320;
          const mPerDegLon = 111_320 * Math.cos(lat0);
          const dist = (a: (typeof pts)[0], b: (typeof pts)[0], p: (typeof pts)[0]) => {
            const ax = a.lon * mPerDegLon, ay = a.lat * mPerDegLat;
            const bx = b.lon * mPerDegLon, by = b.lat * mPerDegLat;
            const px = p.lon * mPerDegLon, py = p.lat * mPerDegLat;
            const dx = bx - ax, dy = by - ay;
            const len2 = dx * dx + dy * dy || 1;
            let t = ((px - ax) * dx + (py - ay) * dy) / len2;
            t = Math.max(0, Math.min(1, t));
            const cx = ax + t * dx, cy = ay + t * dy;
            return Math.hypot(px - cx, py - cy);
          };
          let maxD = 0, idx = 0;
          for (let i = 1; i < arr.length - 1; i++) {
            const d = dist(arr[0], arr[arr.length - 1], arr[i]);
            if (d > maxD) { maxD = d; idx = i; }
          }
          if (maxD > eps) {
            const left = rdp(arr.slice(0, idx + 1), eps);
            const right = rdp(arr.slice(idx), eps);
            return left.slice(0, -1).concat(right);
          }
          return [arr[0], arr[arr.length - 1]];
        };
        let eps = 25;
        let simplified = rdp(pts, eps);
        while (simplified.length > maxPts && eps < 200) {
          eps *= 1.35;
          simplified = rdp(pts, eps);
        }
        if (simplified.length > maxPts) {
          const step = Math.ceil(simplified.length / maxPts);
          simplified = simplified.filter(
            (_, i) => i === 0 || i === simplified.length - 1 || i % step === 0,
          );
        }
        routePoints = simplified.map(toPt);
      }
    }
    onSendToHud({
      destination: destinationAddress.trim(),
      startSoc,
      plannedSpeedKmH,
      passengers,
      climateOn,
      totalDistanceKm: totalKm,
      predictedEndSoc: endSoc,
      energyNeededKwh: energyUsedKwh,
      predictedConsumption: consumptionPer100Km,
      waypoints,
      routePoints,
    });
  };

  const isDark = settings.theme !== 'light';

  // ── Presentation helpers (no calculation logic lives here) ─────────────────────────────────
  const surface = isDark
    ? 'bg-slate-900/92 border-slate-700/60 text-slate-100 backdrop-blur-md'
    : 'bg-white/95 border-slate-200 text-slate-900 backdrop-blur-md';
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const chipBg = isDark ? 'bg-slate-800/80 text-slate-200' : 'bg-slate-100 text-slate-800';
  const inputCls = `w-full bg-transparent py-2.5 pl-8 pr-14 text-[14px] outline-none truncate ${
    isDark ? 'text-white placeholder:text-slate-500' : 'text-slate-900 placeholder:text-slate-400'
  }`;
  const connLabel = (c?: string) => (c === 'gbt' ? 'GB/T' : c === 'type2' ? 'Type2' : 'CCS');
  const connectorKw = (station: ChargingStation, connector?: string) =>
    connector === 'gbt'
      ? station.gbtPowerKw ?? station.ccs2PowerKw
      : connector === 'ccs2'
        ? station.ccs2PowerKw
        : station.type2PowerKw;
  const fmtDuration = (min: number) => {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h <= 0) return `${m} мин`;
    return m > 0 ? `${h} ч ${m} мин` : `${h} ч`;
  };

  /** Parameters that differ from the calculator defaults light up the sliders button. */
  const paramsModified =
    passengers !== 1 || !climateOn || plannedSpeedKmH !== 70 || plannedMaxSpeedKmH !== 120 || weatherMode !== 'current';

  /** Charging plan as one list regardless of whether it came from the multi-stop planner or the single suggestion. */
  const planStops =
    chargingSuggestionStatus === 'ready'
      ? chargingStops.length
        ? chargingStops
        : chargingSuggestion
          ? [{
              station: chargingSuggestion.station,
              connector: chargingSuggestion.connector,
              socAtStation: chargingSuggestion.socAtStation,
              targetSoc: chargingSuggestion.targetSoc,
              session: chargingSuggestion.session,
              finishSocAfterCharge: chargingSuggestion.finishSocAfterCharge,
            }]
          : []
      : [];

  /** Markers: all stations along the route after calc; recommended plan stops highlighted. Before route — nearby free list. */
  const mapStops = (() => {
    if (!routeElevation) {
      return nearbyFreeList.map((x) => {
        const kw =
          x.matchedConnector === 'gbt'
            ? x.station.gbtPowerKw ?? x.station.ccs2PowerKw
            : x.station.ccs2PowerKw ?? x.station.type2PowerKw;
        return {
          id: x.station.id,
          lat: x.station.lat,
          lon: x.station.lon,
          name: x.station.name,
          address: x.station.address,
          powerKw: kw ?? null,
          recommended: false,
        };
      });
    }
    const planIds = new Set(planStops.map((s) => s.station.id));
    const planKey = (lat: number, lon: number) =>
      planStops.some(
        (s) => Math.abs(s.station.lat - lat) < 1e-5 && Math.abs(s.station.lon - lon) < 1e-5,
      );
    const powerOf = (st: ChargingStation) => {
      const fromPlan = planStops.find(
        (s) =>
          s.station.id === st.id ||
          (Math.abs(s.station.lat - st.lat) < 1e-5 && Math.abs(s.station.lon - st.lon) < 1e-5),
      );
      if (fromPlan) {
        return connectorKw(fromPlan.station, fromPlan.connector) ?? st.ccs2PowerKw ?? st.gbtPowerKw ?? st.type2PowerKw;
      }
      return st.ccs2PowerKw ?? st.gbtPowerKw ?? st.type2PowerKw;
    };
    // Prefer full along-route list; if empty (search still running), fall back to plan only.
    const base = routeStationsAlong.length
      ? routeStationsAlong
      : planStops.map((s) => s.station);
    // Deduplicate by id / coords
    const seen = new Set<string>();
    const out: Array<{
      id: string;
      lat: number;
      lon: number;
      name: string;
      address?: string;
      powerKw: number | null;
      recommended: boolean;
    }> = [];
    /** Extra stations on the map: tighter corridor than the planner fetch (≤2 km off route). */
    const MAP_EXTRA_MAX_DETOUR_KM = 2;
    for (const st of base) {
      const key = st.id || `${st.lat.toFixed(5)},${st.lon.toFixed(5)}`;
      if (seen.has(key)) continue;
      const recommended = planIds.has(st.id) || planKey(st.lat, st.lon);
      // Non-plan stops: only if close to the polyline
      if (!recommended) {
        const detour = st.distanceFromRouteKm;
        if (!(detour != null && Number.isFinite(detour) && detour <= MAP_EXTRA_MAX_DETOUR_KM)) {
          continue;
        }
      }
      seen.add(key);
      const kw = powerOf(st);
      out.push({
        id: st.id,
        lat: st.lat,
        lon: st.lon,
        name: st.name,
        address: st.address,
        powerKw: kw != null && kw > 0 ? kw : null,
        recommended,
        accentColor: recommended ? '#22d3ee' : null,
      });
    }
    // Ensure every plan stop is present even if not in routeStationsAlong
    for (const s of planStops) {
      const key = s.station.id || `${s.station.lat.toFixed(5)},${s.station.lon.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const kw = connectorKw(s.station, s.connector);
      out.push({
        id: s.station.id,
        lat: s.station.lat,
        lon: s.station.lon,
        name: s.station.name,
        address: s.station.address,
        powerKw: kw != null && kw > 0 ? kw : null,
        recommended: true,
        accentColor: '#22d3ee',
      });
    }
    if (!showAllRouteStations) {
      return out.filter((s) => s.recommended);
    }
    return out;
  })();

  const extraRouteStationCount = (() => {
    if (!routeElevation || !routeStationsAlong.length) return 0;
    const planIds = new Set(planStops.map((s) => s.station.id));
    const MAP_EXTRA_MAX_DETOUR_KM = 2;
    return routeStationsAlong.filter((st) => {
      const inPlan =
        planIds.has(st.id) ||
        planStops.some(
          (s) =>
            Math.abs(s.station.lat - st.lat) < 1e-5 &&
            Math.abs(s.station.lon - st.lon) < 1e-5,
        );
      if (inPlan) return false;
      const detour = st.distanceFromRouteKm;
      return detour != null && Number.isFinite(detour) && detour <= MAP_EXTRA_MAX_DETOUR_KM;
    }).length;
  })();

  const selectNearbyItem = (item: FreeChargerResult) => {
    triggerHaptic('light', settings.hapticFeedback);
    setSelectedRouteStop({
      station: item.station,
      connector: item.matchedConnector === 'gbt' ? 'gbt' : item.matchedConnector === 'type2' ? 'type2' : 'ccs2',
    });
  };

  const handleMapStopClick = (stop: { id?: string; lat: number; lon: number; name: string; address?: string }) => {
    triggerHaptic('light', settings.hapticFeedback);
    if (!routeElevation) {
      const free = nearbyFreeList.find((x) => x.station.id === stop.id);
      if (free) { selectNearbyItem(free); return; }
    }
    const fromList = chargingStops.find(
      (s) => s.station.id === stop.id
        || (Math.abs(s.station.lat - stop.lat) < 1e-5 && Math.abs(s.station.lon - stop.lon) < 1e-5),
    );
    if (fromList) { setSelectedRouteStop(fromList); return; }
    if (
      chargingSuggestion
      && (chargingSuggestion.station.id === stop.id
        || (Math.abs(chargingSuggestion.station.lat - stop.lat) < 1e-5
          && Math.abs(chargingSuggestion.station.lon - stop.lon) < 1e-5))
    ) {
      setSelectedRouteStop({
        station: chargingSuggestion.station,
        connector: chargingSuggestion.connector,
        socAtStation: chargingSuggestion.socAtStation,
        targetSoc: chargingSuggestion.targetSoc,
        session: chargingSuggestion.session,
        finishSocAfterCharge: chargingSuggestion.finishSocAfterCharge,
      });
      return;
    }
    const along = routeStationsAlong.find(
      (s) =>
        s.id === stop.id ||
        (Math.abs(s.lat - stop.lat) < 1e-5 && Math.abs(s.lon - stop.lon) < 1e-5),
    );
    if (along) {
      setSelectedRouteStop({ station: along });
      return;
    }
    setSelectedRouteStop({
      station: {
        id: stop.id || `map:${stop.lat},${stop.lon}`,
        lat: stop.lat,
        lon: stop.lon,
        name: stop.name,
        address: stop.address || '',
        hasType2: false,
        hasCcs2: true,
        connectorTypeUnknown: true,
        distanceFromRouteKm: 0,
        distanceAlongRouteKm: 0,
      },
    });
  };

  const openStationInNavi = (lat: number, lon: number) => {
    triggerHaptic('medium', settings.hapticFeedback);
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
    if (isMobile) {
      window.location.href = `yandexnavi://build_route_on_map?lat_to=${lat}&lon_to=${lon}`;
    } else {
      window.open(`https://yandex.ru/maps/?rtext=~${lat},${lon}&rtt=auto`, '_blank', 'noopener,noreferrer');
    }
  };

  const buildRouteToSelectedStation = () => {
    if (!selectedRouteStop) return;
    const match = nearbyFreeList.find((x) => x.station.id === selectedRouteStop.station.id);
    if (match) { applyFreeChargerAsDestination(match); return; }
    applyFreeChargerAsDestination({
      station: selectedRouteStop.station,
      distanceKm: 0,
      freeCcs: 0,
      totalCcs: 0,
      matchedConnector: selectedRouteStop.connector === 'gbt' ? 'gbt' : selectedRouteStop.connector === 'type2' ? 'type2' : 'ccs2',
      operator: selectedRouteStop.station.operator || '',
      connectors: [],
    });
  };

  const applyPlaceAsDestination = (place: { name: string; lat: number; lon: number }) => {
    triggerHaptic('light', settings.hapticFeedback);
    setDestinationAddress(place.name);
    setDestinationPin({ lat: place.lat, lon: place.lon });
    void calculateRouteProfile({ lat: place.lat, lon: place.lon, displayName: place.name });
  };

  const closeParams = () => {
    setParamsOpen(false);
    if (paramsDirty) {
      setParamsDirty(false);
      // Conditions changed while a route is on screen — recompute so the answer never goes stale.
      if (routeElevation && (destinationAddress.trim() || destinationPin)) void calculateRouteProfile();
    }
  };

  const dirty = () => setParamsDirty(true);

  const seg = (active: boolean) =>
    `rounded-lg py-2 text-xs font-semibold ${
      active ? (isDark ? 'bg-slate-700 text-white' : 'bg-white text-slate-900 shadow-sm') : muted
    }`;
  const optBtn = (active: boolean) =>
    `rounded-lg py-2 text-xs font-semibold border ${
      active ? 'border-cyan-500 bg-cyan-500/10 text-cyan-500' : isDark ? 'border-slate-700 text-slate-400' : 'border-slate-200 text-slate-600'
    }`;

  // ── Sheet: what the bottom panel shows right now ───────────────────────────────────────────
  const renderStationCard = () => {
    if (!selectedRouteStop) return null;
    const st = selectedRouteStop.station;
    const nearby = nearbyFreeList.find((x) => x.station.id === st.id);
    return (
      <div>
        <div className="flex items-start gap-2.5">
          <div className={`mt-0.5 shrink-0 rounded-xl p-2 ${isDark ? 'bg-amber-500/15 text-amber-400' : 'bg-amber-50 text-amber-700'}`}>
            <PlugZap className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-bold leading-tight">{st.name}</p>
            {st.address && <p className={`mt-0.5 text-[12px] ${muted}`}>{st.address}</p>}
          </div>
          <button
            type="button"
            onClick={() => setSelectedRouteStop(null)}
            aria-label="Закрыть карточку станции"
            className={`shrink-0 rounded-full p-1.5 ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {st.operator && <p className={`mt-2 text-[12px] font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{st.operator}</p>}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {st.hasCcs2 && <span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${chipBg}`}>CCS{st.ccs2PowerKw ? ` · ${Math.round(st.ccs2PowerKw)} кВт` : ''}</span>}
          {st.hasGbt && <span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${chipBg}`}>GB/T{st.gbtPowerKw ? ` · ${Math.round(st.gbtPowerKw)} кВт` : ''}</span>}
          {st.hasType2 && <span className={`rounded-lg px-2 py-1 text-[11px] font-semibold ${chipBg}`}>Type2{st.type2PowerKw ? ` · ${Math.round(st.type2PowerKw)} кВт` : ''}</span>}
          {nearby && nearby.totalCcs > 0 && (
            <span className={`rounded-lg px-2 py-1 text-[11px] font-bold ${isDark ? 'bg-emerald-900/50 text-emerald-300' : 'bg-emerald-100 text-emerald-800'}`}>
              свободно {nearby.freeCcs} из {nearby.totalCcs}
            </span>
          )}
          {selectedRouteStop.connector && (
            <span className={`rounded-lg px-2 py-1 text-[11px] font-bold ${isDark ? 'bg-amber-900/50 text-amber-300' : 'bg-amber-100 text-amber-800'}`}>
              План: {connLabel(selectedRouteStop.connector)}
            </span>
          )}
        </div>
        {(selectedRouteStop.socAtStation != null || selectedRouteStop.session) && (
          <p className={`mt-2 text-[12px] ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            {selectedRouteStop.socAtStation != null && <>Прибытие ~{Math.round(selectedRouteStop.socAtStation)}%</>}
            {selectedRouteStop.targetSoc != null && <> → {Math.round(selectedRouteStop.targetSoc)}%</>}
            {selectedRouteStop.session && <> · ~{selectedRouteStop.session.minutes} мин · {selectedRouteStop.session.energyKwh.toFixed(1)} кВт⋅ч</>}
            {selectedRouteStop.finishSocAfterCharge != null && <> · на финише ~{Math.round(selectedRouteStop.finishSocAfterCharge)}%</>}
          </p>
        )}
        {routeElevation ? (
          <button
            type="button"
            onClick={() => openStationInNavi(st.lat, st.lon)}
            className="mt-3 w-full rounded-xl bg-cyan-600 px-3 py-3 text-[13px] font-bold text-white hover:bg-cyan-500 active:scale-[0.98]"
          >
            Маршрут к станции
          </button>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" onClick={buildRouteToSelectedStation} className="rounded-xl bg-emerald-600 px-3 py-3 text-[13px] font-bold text-white hover:bg-emerald-500 active:scale-[0.98]">
              Построить маршрут
            </button>
            <button type="button" onClick={() => openStationInNavi(st.lat, st.lon)} className="rounded-xl bg-cyan-600 px-3 py-3 text-[13px] font-bold text-white hover:bg-cyan-500 active:scale-[0.98]">
              В навигатор
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderNearbyView = () => (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] font-bold">
          <PlugZap className={`h-4 w-4 ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`} />
          Свободные зарядки рядом
        </div>
        <button
          type="button"
          onClick={() => { setNearbyFreeStatus('idle'); setNearbyFreeList([]); setNearbyFreeError(''); }}
          aria-label="Закрыть список зарядок"
          className={`rounded-full p-1.5 ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {nearbyFreeStatus === 'loading' && (
        <p className={`mt-3 flex items-center gap-2 text-[12px] ${muted}`}>
          <Loader2 className="h-4 w-4 animate-spin" /> Сканируем станции вокруг…
        </p>
      )}
      {nearbyFreeStatus === 'error' && <p className="mt-3 text-[12px] text-rose-500">{nearbyFreeError}</p>}
      {nearbyFreeStatus === 'ready' && nearbyFreeError && !nearbyFreeList.length && (
        <p className={`mt-3 text-[12px] ${muted}`}>{nearbyFreeError}</p>
      )}
      {nearbyFreeList.length > 0 && (
        <ul className="calc-nearby-list mt-2 max-h-[13rem] space-y-1.5 overflow-y-auto overscroll-contain">
          {nearbyFreeList.map((item) => {
            const isActive = selectedRouteStop?.station.id === item.station.id;
            const kw = item.matchedConnector === 'gbt' ? item.station.gbtPowerKw ?? item.station.ccs2PowerKw : item.station.ccs2PowerKw;
            return (
              <li key={item.station.id}>
                <button
                  type="button"
                  onClick={() => selectNearbyItem(item)}
                  className={`w-full rounded-xl border px-3 py-2.5 text-left ${
                    isActive
                      ? isDark ? 'border-amber-600/50 bg-amber-950/40' : 'border-amber-300 bg-amber-50'
                      : isDark ? 'border-transparent bg-slate-800/60 hover:bg-slate-800' : 'border-slate-100 bg-slate-50 hover:bg-slate-100'
                  }`}
                >
                  <div className="text-[13px] font-semibold">{item.station.name}</div>
                  <div className={`mt-0.5 text-[12px] ${muted}`}>
                    {item.distanceKm < 1 ? `${Math.round(item.distanceKm * 1000)} м` : `${item.distanceKm.toFixed(1)} км`}
                    {' · '}
                    {item.matchedConnector === 'gbt' ? 'GB/T' : 'CCS'} свободно {item.freeCcs}
                    {kw ? ` · ${Math.round(kw)} кВт` : ''}
                    {item.operator ? ` · ${item.operator}` : ''}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  const renderIdleView = () => (
    <div>
      <p className="text-[14px] font-bold">Куда едем?</p>
      <p className={`calc-idle-hint mt-0.5 text-[12px] ${muted}`}>
        Введите точку Б. Старт — ваша геопозиция, климат и погода подставятся сами.
      </p>
      {recentPlaces.length > 0 && (
        // Недавние места — одна горизонтальная лента чипов вместо вертикального списка из 5 строк:
        // занимает одну строку по высоте (важно в ландшафте), прокручивается вбок, «×» очищает историю.
        <div className="calc-recent mt-2.5 flex items-center gap-1.5 overflow-x-auto overscroll-x-contain pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="list" aria-label="Недавние места">
          <History className={`h-3.5 w-3.5 shrink-0 ${muted}`} aria-hidden="true" />
          {recentPlaces.map((p) => (
            <button
              key={`${p.lat},${p.lon}`}
              type="button"
              role="listitem"
              title={p.name}
              aria-label={`Поехать: ${p.name}`}
              onClick={() => applyPlaceAsDestination(p)}
              className={`max-w-[9.5rem] shrink-0 truncate rounded-full border px-3 py-1.5 text-[12px] font-medium ${isDark ? 'border-slate-700 bg-slate-800/60 text-slate-200 hover:bg-slate-800' : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'}`}
            >
              {shortPlaceLabel(p.name, p.name)}
            </button>
          ))}
          <button
            type="button"
            aria-label="Очистить недавние места"
            title="Очистить"
            onClick={() => {
              setRecentPlaces([]);
              try { localStorage.removeItem(RECENT_PLACES_KEY); } catch { /* ignore */ }
            }}
            className={`ml-0.5 shrink-0 rounded-full p-1.5 ${isDark ? 'text-slate-500 hover:bg-slate-800' : 'text-slate-400 hover:bg-slate-100'}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );

  const renderLoadingView = () => (
    <div className="flex items-center gap-3 py-1">
      <Loader2 className="h-5 w-5 shrink-0 animate-spin text-cyan-500" />
      <div className="min-w-0">
        <p className="text-[14px] font-bold">Считаем маршрут…</p>
        <p className={`truncate text-[12px] ${muted}`}>{routeStatus || 'Подготавливаем расчёт…'}</p>
      </div>
    </div>
  );

  const renderResultView = () => {
    if (!routeElevation || !routeForecast) return null;
    const arrival = routeForecast.arrivalSoc;
    const displayArrival = hasChargingAdjustedFinishSoc ? chargingFinishSoc! : arrival;
    const tone = displayArrival >= 20 ? 'good' : displayArrival >= ARRIVAL_RESERVE_SOC ? 'ok' : 'low';
    const needsCharge = arrival < CHARGE_SUGGEST_SOC;
    const searching = chargingSuggestionStatus === 'loading';
    const noStations = chargingSuggestionStatus === 'unavailable' || chargingSuggestionStatus === 'error';
    const verdict =
      tone === 'good'
        ? planStops.length && !chargingSearchForced ? 'Доедете с зарядкой' : 'Доедете'
        : tone === 'ok'
          ? 'Впритык'
          : searching
            ? 'Ищем зарядку…'
            : noStations
              ? 'Не доедете: станций нет'
              : 'Нужна зарядка в пути';
    const toneColor =
      tone === 'good' ? (isDark ? 'text-emerald-400' : 'text-emerald-600') : tone === 'ok' ? 'text-amber-500' : 'text-rose-500';
    const driveMinutes = routeWeather?.etaMinutes ?? Math.max(1, Math.round((routeElevation.distanceKm / Math.max(10, plannedSpeedKmH)) * 60));
    const totalTripMinutes = driveMinutes + totalChargingMinutes;
    const chargeLabel = searching
      ? '…'
      : planStops.length > 0
        ? String(planStops.length)
        : needsCharge
          ? 'нужна'
          : 'нет';
    const chargeSub = searching
      ? 'ищем зарядку'
      : planStops.length > 0
        ? planStops.length === 1 ? 'остановка' : planStops.length < 5 ? 'остановки' : 'остановок'
        : needsCharge && noStations
          ? 'станций нет'
          : 'зарядка';

    // SoC along the route: straight burn between points, vertical jump at every planned charge.
    const totalKm = routeElevation.distanceKm;
    const series: Array<{ km: number; soc: number }> = [{ km: 0, soc: Math.min(100, startSoc) }];
    planStops.forEach((s) => {
      const km = Math.max(0.1, Math.min(totalKm, s.station.distanceAlongRouteKm));
      series.push({ km, soc: Math.max(0, s.socAtStation) });
      if (!chargingSearchForced) series.push({ km: km + 0.01, soc: Math.min(100, s.targetSoc) });
    });
    series.push({ km: totalKm, soc: Math.max(0, Math.min(100, displayArrival)) });
    const chartStroke = tone === 'low' ? '#f43f5e' : tone === 'ok' ? '#f59e0b' : '#06b6d4';

    const chargesWord = `${planStops.length} зарядк${planStops.length === 1 ? 'а' : planStops.length < 5 ? 'и' : 'ок'}`;

    // Ручка панели: тап — свернуть/развернуть, свайп вверх/вниз — следующее/предыдущее положение.
    const sheetHandle = (
      <div
        role="button"
        tabIndex={0}
        aria-label={sheetMode === 'peek' ? 'Развернуть панель маршрута' : 'Свернуть панель маршрута'}
        onPointerDown={onHandlePointerDown}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerCancel}
        onKeyDown={onHandleKeyDown}
        className="calc-handle -mt-2 mb-1 flex cursor-grab touch-none justify-center py-2.5"
      >
        <span className={`h-1 w-10 rounded-full ${isDark ? 'bg-slate-600' : 'bg-slate-300'}`} />
      </div>
    );

    // Свёрнутое положение: процент и вердикт + «Начать», ниже одна строка «км · время · зарядки».
    if (sheetMode === 'peek') {
      const expand = () => { triggerHaptic('light', settings.hapticFeedback); setSheetMode('half'); };
      return (
        <div id="route-result-main">
          {sheetHandle}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={expand}
              aria-label="Показать детали расчёта"
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              <div className={`shrink-0 font-mono text-[32px] font-black leading-none tabular-nums ${toneColor}`}>
                <AnimatedNumber value={Math.round(displayArrival)} />%
              </div>
              <p className={`min-w-0 text-[13px] font-bold leading-tight ${toneColor}`}>{verdict}</p>
            </button>
            {onSendToHud && destinationAddress.trim() ? (
              <button
                type="button"
                onClick={handleStartTrip}
                className="flex shrink-0 items-center justify-center gap-1.5 rounded-xl bg-cyan-600 px-4 py-2.5 text-[13px] font-bold text-white shadow-sm shadow-cyan-600/20 hover:bg-cyan-500 active:scale-[0.98]"
              >
                <Navigation className="h-4 w-4 shrink-0" />
                Начать
              </button>
            ) : (
              <a
                href={typeof yandexNaviHref === 'string' ? '#' : yandexNaviHref.web}
                onClick={openYandexNavi}
                className={`flex shrink-0 items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-[13px] font-semibold active:scale-[0.98] ${
                  isDark ? 'border-slate-700 bg-slate-800/70 text-slate-200' : 'border-slate-200 bg-white text-slate-800'
                }`}
              >
                <Route className="h-4 w-4" />
                Навигатор
              </a>
            )}
          </div>
          <button
            type="button"
            onClick={expand}
            aria-label="Показать детали расчёта"
            className={`mt-2 block w-full truncate text-left text-[11px] ${muted}`}
          >
            на финише · {routeElevation.distanceKm.toFixed(0)} км · {fmtDuration(totalTripMinutes)}
            {planStops.length > 0 && <> · {chargesWord}</>}
          </button>
        </div>
      );
    }

    return (
      <div id="route-result-main">
        {sheetHandle}
        <div className="flex items-center justify-between gap-2">
          <p className={`text-[13px] font-bold ${toneColor}`}>{verdict}</p>
          <button
            type="button"
            onClick={() => { triggerHaptic('light', settings.hapticFeedback); resetRoute(); }}
            aria-label="Сбросить маршрут"
            className={`rounded-full p-1.5 ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-1 flex items-end gap-3">
          <div className="shrink-0">
            <div className={`font-mono text-[40px] font-black leading-none tabular-nums ${toneColor}`}>
              <AnimatedNumber value={Math.round(displayArrival)} />%
            </div>
            <div className={`mt-1 text-[11px] leading-tight ${muted}`}>
              на финише · старт {Math.round(startSoc)}%
              {hasChargingAdjustedFinishSoc && Math.round(arrival) !== Math.round(displayArrival) && (
                <span className="block">без зарядки {Math.round(arrival)}%</span>
              )}
            </div>
          </div>
          <div className="h-[72px] min-w-0 flex-1" aria-label="Заряд по маршруту">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series} margin={{ top: 6, right: 4, left: 4, bottom: 0 }}>
                <YAxis hide domain={[0, 100]} />
                <XAxis dataKey="km" type="number" domain={[0, 'dataMax']} hide />
                <ReferenceLine y={ARRIVAL_RESERVE_SOC} stroke={isDark ? '#475569' : '#cbd5e1'} strokeDasharray="3 3" />
                {planStops.map((s, i) => (
                  <ReferenceDot
                    key={`${s.station.id}-${i}`}
                    x={Math.max(0.1, Math.min(totalKm, s.station.distanceAlongRouteKm))}
                    y={chargingSearchForced ? s.socAtStation : s.targetSoc}
                    r={4}
                    fill="#f59e0b"
                    stroke={isDark ? '#0f172a' : '#ffffff'}
                    strokeWidth={2}
                  />
                ))}
                <Area type="linear" dataKey="soc" stroke={chartStroke} fill={chartStroke} fillOpacity={0.16} strokeWidth={2.5} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className={`mt-3 grid grid-cols-3 divide-x rounded-xl py-2 text-center ${isDark ? 'bg-slate-800/50 divide-slate-700/60' : 'bg-slate-100 divide-slate-200'}`}>
          <div className="px-2">
            <div className="whitespace-nowrap text-[14px] font-bold tabular-nums">{routeElevation.distanceKm.toFixed(0)} км</div>
            <div className={`text-[10px] ${muted}`}>{routeForecast.consumption.toFixed(1)} кВт⋅ч/100</div>
          </div>
          <div className="px-2">
            <div className="whitespace-nowrap text-[14px] font-bold tabular-nums">{fmtDuration(totalTripMinutes)}</div>
            <div className={`text-[10px] ${muted}`}>{totalChargingMinutes > 0 ? `с зарядкой ${totalChargingMinutes} мин` : 'в пути'}</div>
          </div>
          <div className="px-2">
            <div className={`whitespace-nowrap text-[14px] font-bold ${planStops.length ? (isDark ? 'text-amber-400' : 'text-amber-600') : ''}`}>{chargeLabel}</div>
            <div className={`text-[10px] ${muted}`}>{chargeSub}</div>
          </div>
        </div>

        <div className="mt-3 flex gap-2">
          {onSendToHud && destinationAddress.trim() && (
            <button
              type="button"
              onClick={handleStartTrip}
              className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-600 py-3 text-[13px] font-bold text-white shadow-sm shadow-cyan-600/20 hover:bg-cyan-500 active:scale-[0.98]"
            >
              <Navigation className="h-4 w-4 shrink-0" />
              <span className="truncate">
                {planStops.length > 0
                  ? `Начать · ${planStops.length} зарядк${planStops.length === 1 ? 'а' : planStops.length < 5 ? 'и' : 'ок'}`
                  : 'Начать поездку'}
              </span>
            </button>
          )}
          <a
            href={typeof yandexNaviHref === 'string' ? '#' : yandexNaviHref.web}
            onClick={openYandexNavi}
            className={`flex shrink-0 items-center justify-center gap-1.5 rounded-xl border px-4 py-3 text-[13px] font-semibold active:scale-[0.98] ${
              isDark ? 'border-slate-700 bg-slate-800/70 text-slate-200' : 'border-slate-200 bg-white text-slate-800'
            }`}
          >
            <Route className="h-4 w-4" />
            Навигатор
          </a>
        </div>

        {finishArrivalDate && (
          <p className={`mt-2 text-[11px] ${muted}`}>
            Прибытие ~{finishArrivalDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
            {finishTemperature != null && <> · {finishTemperature >= 0 ? '+' : ''}{Math.round(finishTemperature)}°C</>}
            {routeForecast.windLabel ? ` · ${routeForecast.windLabel}` : ''}
          </p>
        )}

        {/* Charge stops — tap to open the station card (same as tapping the ⚡ on the map) */}
        {planStops.length > 0 && (
          <div className="-mx-1 mt-2 flex gap-1.5 overflow-x-auto px-1 pb-1">
            {planStops.map((s, i) => (
              <button
                key={`${s.station.id}-${i}`}
                type="button"
                onClick={() => { triggerHaptic('light', settings.hapticFeedback); setSelectedRouteStop(s); }}
                className={`shrink-0 rounded-xl border px-2.5 py-1.5 text-left ${isDark ? 'border-amber-700/40 bg-amber-950/30' : 'border-amber-200 bg-amber-50'}`}
              >
                <div className="flex items-center gap-1 text-[12px] font-bold">
                  <PlugZap className="h-3 w-3 text-amber-500" />
                  <span className="max-w-[9.5rem] truncate">{s.station.name}</span>
                </div>
                <div className={`text-[11px] ${muted}`}>
                  {Math.round(s.station.distanceAlongRouteKm)} км · {Math.round(s.socAtStation)}%{!chargingSearchForced && <> → {Math.round(s.targetSoc)}%</>} · {s.session.minutes} мин
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Charge search states that need an explicit action */}
        {arrival >= CHARGE_SUGGEST_SOC && chargingSuggestionStatus === 'idle' && (
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light', settings.hapticFeedback);
              setShowAllRouteStations(true);
              void searchChargingStations();
            }}
            className={`mt-2 w-full rounded-xl px-3 py-2.5 text-[12px] font-semibold ${chipBg}`}
          >
            Найти зарядку по маршруту
          </button>
        )}
        {/* After plan / search: toggle all corridor stations on the map (merged with find-on-route) */}
        {routeElevation && chargingSuggestionStatus === 'ready' && extraRouteStationCount > 0 && (
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light', settings.hapticFeedback);
              setShowAllRouteStations((v) => !v);
            }}
            className={`mt-2 w-full rounded-xl px-3 py-2.5 text-[12px] font-semibold ${
              showAllRouteStations
                ? isDark ? 'bg-slate-800 text-slate-200' : 'bg-slate-100 text-slate-800'
                : isDark ? 'bg-cyan-500/15 text-cyan-300' : 'bg-cyan-50 text-cyan-800'
            }`}
          >
            {showAllRouteStations
              ? 'Только остановки плана'
              : `Показать все ЭЗС на маршруте · ${extraRouteStationCount}`}
          </button>
        )}
        {chargingSuggestionStatus === 'unavailable' && (
          <div className="mt-2 space-y-2">
            <p className={`text-[12px] ${muted}`}>
              {stationsFoundAlongRoute > 0 ? 'Подходящей остановки по правилам комфорта нет.' : 'Станций на маршруте не найдено.'}
            </p>
            {stationsFoundAlongRoute > 0 && (
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light', settings.hapticFeedback);
                  setShowAllRouteStations(true);
                  void searchChargingStations({ force: true });
                }}
                className={`w-full rounded-xl px-3 py-2.5 text-[12px] font-semibold ${isDark ? 'bg-cyan-500/15 text-cyan-300' : 'bg-cyan-50 text-cyan-800'}`}
              >
                Показать станции на маршруте
              </button>
            )}
          </div>
        )}
        {chargingSuggestionStatus === 'error' && <p className={`mt-2 text-[12px] ${muted}`}>Не удалось загрузить станции.</p>}


        {routeElevation && !routeElevation.elevationAvailable && routeElevation.elevationNote && (
          <div className={`mt-2 rounded-lg px-3 py-2 text-xs ${isDark ? 'bg-amber-950/40 text-amber-400' : 'bg-amber-50 text-amber-700'}`}>⚠ {routeElevation.elevationNote}</div>
        )}

        <div className="mt-3">
          <CollapsibleDetails
            isDark={isDark}
            label="Подробности"
            open={sheetMode === 'full'}
            onToggle={() => { triggerHaptic('light', settings.hapticFeedback); setSheetMode((m) => (m === 'full' ? 'half' : 'full')); }}
          >
            <div className="space-y-3">
                {routeForecast?.breakdown && (
                  <div className={`rounded-xl border p-3 space-y-2 text-xs ${isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
                    <div className={`text-[11px] font-bold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Что повлияло на расход</div>
                    {([
                      ['Базовое движение', routeForecast.breakdown.baseEnergyKwh],
                      ['Температура', routeForecast.breakdown.temperatureDeltaKwh],
                      ['Ветер', routeForecast.breakdown.windDeltaKwh],
                      ['Осадки / дорога', routeForecast.breakdown.precipitationDeltaKwh],
                      ['Стиль', routeForecast.breakdown.driverDeltaKwh],
                      ['Рельеф', routeForecast.breakdown.elevationDeltaKwh],
                      ['Климат', routeForecast.breakdown.climateEnergyKwh],
                    ] as Array<[string, number]>).map(([label, value]) => {
                      const kwh = Number(value) || 0;
                      const pct = routeForecast.energyKwh > 0.01 ? (kwh / routeForecast.energyKwh) * 100 : 0;
                      return (
                        <div key={label} className="flex justify-between gap-3">
                          <span>{label}</span>
                          <b className="tabular-nums whitespace-nowrap">
                            {kwh >= 0 ? '+' : ''}{kwh.toFixed(2)} кВт⋅ч
                            <span className={`ml-1.5 font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                              ({pct >= 0 ? '+' : ''}{pct.toFixed(0)}%)
                            </span>
                          </b>
                        </div>
                      );
                    })}
                    <div className="pt-2 border-t border-slate-700/30 flex justify-between font-bold">
                      <span>Итого / сегментов</span>
                      <span>{routeForecast.energyKwh.toFixed(2)} кВт⋅ч · {routeForecast.breakdown.segments}</span>
                    </div>
                  </div>
                )}

                {optimalSpeedScenario && (
                  <div className={`rounded-xl border p-3 ${isDark ? 'bg-cyan-950/30 border-cyan-900/60' : 'bg-cyan-50 border-cyan-200'}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className={`text-[10px] font-bold uppercase tracking-wide ${isDark ? 'text-cyan-300' : 'text-cyan-700'}`}>Оптимальная скорость</div>
                        <div className={`mt-0.5 text-2xl font-black font-mono ${isDark ? 'text-cyan-400' : 'text-cyan-700'}`}>{optimalSpeedScenario.speed} км/ч</div>
                      </div>
                      <div className="text-right text-[11px]">
                        <div><span className="text-slate-500">Расход</span> <b>{optimalSpeedScenario.consumption.toFixed(1)} кВт⋅ч/100</b></div>
                        <div className="mt-0.5"><span className="text-slate-500">Прибытие</span> <b>{Math.round(optimalSpeedScenario.arrivalSoc)}% SOC</b></div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-center">
                  <div className={`rounded-xl p-2 ${isDark ? 'bg-slate-950' : 'bg-slate-50'}`}><div className="text-lg font-bold">{routeElevation.distanceKm}</div><div className="text-[10px] text-slate-500">км</div></div>
                  <div className={`rounded-xl p-2 ${isDark ? 'bg-slate-950' : 'bg-slate-50'}`}><div className="text-lg font-bold text-amber-500">▲ {routeElevation.elevationGainM} м</div><div className="text-[10px] text-slate-500">набор</div></div>
                  <div className={`rounded-xl p-2 ${isDark ? 'bg-slate-950' : 'bg-slate-50'}`}><div className="text-lg font-bold text-cyan-500">▼ {routeElevation.elevationLossM} м</div><div className="text-[10px] text-slate-500">спуск</div></div>
                  <div className={`rounded-xl p-2 ${isDark ? 'bg-slate-950' : 'bg-slate-50'}`}><div className="text-lg font-bold">{routeElevation.netElevationEnergyKwh > 0 ? '+' : ''}{routeElevation.netElevationEnergyKwh.toFixed(2)}</div><div className="text-[10px] text-slate-500">кВт⋅ч нетто</div></div>
                </div>

                <div className={`rounded-xl p-3 text-xs ${isDark ? 'bg-slate-950 text-slate-300' : 'bg-slate-50 text-slate-600'}`}>
                  <div className="flex justify-between"><span>Подъёмы</span><b>+{routeElevation.grossClimbEnergyKwh.toFixed(2)} кВт⋅ч</b></div>
                  <div className="flex justify-between mt-1"><span>Рекуперация</span><b className="text-cyan-500">−{routeElevation.recoveredEnergyKwh.toFixed(2)} кВт⋅ч</b></div>
                  <div className="flex justify-between mt-2 pt-2 border-t border-slate-500/20"><span>Скорр. расход</span><b>{elevationAdjustedConsumption.toFixed(1)} кВт⋅ч/100 км</b></div>
                </div>

                {(() => {
                  const profilePoints = routeElevation.points
                    .map((p: any, i: number) => ({
                      distance: Number(p?.distanceFromStartKm ?? (i * routeElevation.distanceKm / Math.max(1, routeElevation.points.length - 1))),
                      elevation: Number(p?.elevationM),
                    }))
                    .filter((p: any) => Number.isFinite(p.elevation));
                  return profilePoints.length >= 2 ? (
                    <div className={`h-48 rounded-xl border p-3 ${isDark ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200'}`}>
                      <div className={`text-[11px] font-bold mb-1 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Профиль высот</div>
                      <ResponsiveContainer width="100%" height="85%">
                        <AreaChart data={profilePoints} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
                          <XAxis dataKey="distance" type="number" domain={[0, 'dataMax']} tick={{ fontSize: 10 }} tickFormatter={(v) => `${Math.round(Number(v))} км`} interval="preserveStartEnd" />
                          <Tooltip formatter={(v: number) => [`${Math.round(v)} м`, 'Высота']} labelFormatter={(v) => `${Math.round(Number(v))} км`} />
                          <Area type="monotone" dataKey="elevation" stroke="#06b6d4" fill="#06b6d4" fillOpacity={0.18} strokeWidth={2} isAnimationActive={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  ) : null;
                })()}

                {routeForecast?.breakdown?.speedProfile && routeForecast.breakdown.speedProfile.length >= 2 && (
                  <div className={`h-48 rounded-xl border p-3 ${isDark ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200'}`}>
                    <div className={`text-[11px] font-bold mb-1 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Профиль скорости</div>
                    <ResponsiveContainer width="100%" height="85%">
                      <AreaChart data={routeForecast.breakdown.speedProfile.map((p) => ({ distance: p.distanceKm, speed: Math.round(p.speedKmH) }))} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
                        <XAxis dataKey="distance" type="number" domain={[0, 'dataMax']} tick={{ fontSize: 10 }} tickFormatter={(v) => `${Math.round(Number(v))} км`} interval="preserveStartEnd" />
                        <Tooltip formatter={(v: number) => [`${v} км/ч`, 'Скорость']} labelFormatter={(v) => `${Math.round(Number(v))} км`} />
                        <Area type="stepAfter" dataKey="speed" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.18} strokeWidth={2} isAnimationActive={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {routeWeather && routeWeather.samples.length > 0 && (() => {
                  const departureDate = new Date(routeWeather.arrivalDate.getTime() - routeWeather.etaMinutes * 60000);
                  return (
                    <div className={`rounded-xl border divide-y overflow-hidden ${isDark ? 'bg-slate-950 border-slate-800 divide-slate-800' : 'bg-white border-slate-200 divide-slate-100'}`}>
                      <div className={`px-3 py-2 text-[11px] font-bold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        Погода по маршруту ({routeWeather.samples.length})
                      </div>
                      {routeWeather.samples.map((s, i) => {
                        const sampleTime = new Date(departureDate.getTime() + s.etaMinutes * 60000);
                        const relAngle = ((s.weather.windDirection - s.routeBearing + 360) % 360);
                        return (
                          <div key={i} className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs">
                            <div className="flex items-center gap-2 min-w-0">
                              {weatherIcon(s.weather.weatherCode, 'w-4 h-4 shrink-0 text-sky-500')}
                              <div className="min-w-0">
                                <div className="font-bold">{Math.round(s.distanceFromStartKm)} км · {sampleTime.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div>
                                <div className="text-[10px] text-slate-500">
                                  {sampleWindLabel(s.weather.windDirection, s.routeBearing)} {Math.round(s.weather.windSpeed)} км/ч
                                  {s.weather.precipitation > 0.1 ? ` · осадки ${s.weather.precipitation.toFixed(1)} мм/ч` : ''}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <ArrowDown className="w-3.5 h-3.5 text-slate-400" style={{ transform: `rotate(${relAngle}deg)` }} />
                              <b className="font-mono">{s.weather.temperature >= 0 ? '+' : ''}{Math.round(s.weather.temperature)}°C</b>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
            </div>
          </CollapsibleDetails>
        </div>
      </div>
    );
  };

  const sheetView: 'station' | 'nearby' | 'loading' | 'result' | 'idle' = selectedRouteStop
    ? 'station'
    : nearbyFreeStatus !== 'idle'
      ? 'nearby'
      : routeLoading
        ? 'loading'
        : routeElevation && routeForecast
          ? 'result'
          : 'idle';

  // ── Нижняя панель и верхняя карточка после расчёта ─────────────────────────────────────────
  insetsFrozenRef.current = !!selectedRouteStop || nearbyFreeStatus !== 'idle' || routeLoading;
  const searchCollapsed = hasRoute && !searchEditing;
  const sheetIsResult = sheetView === 'result';
  const sheetFull = sheetIsResult && sheetMode === 'full';
  const sheetMaxPx = !landscape && sheetIsResult && sheetMode !== 'peek'
    ? sheetMaxHeightPx(sheetMode, shellHeight ?? 560, mapInsets.top)
    : undefined;

  const onHandlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    handleDragRef.current = { y: e.clientY };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const onHandlePointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const d = handleDragRef.current;
    handleDragRef.current = null;
    if (!d) return;
    const next = resolveHandleGesture(sheetMode, e.clientY - d.y);
    if (next !== sheetMode) { triggerHaptic('light', settings.hapticFeedback); setSheetMode(next); }
  };
  const onHandlePointerCancel = () => { handleDragRef.current = null; };
  const onHandleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setSheetMode(resolveHandleGesture(sheetMode, 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSheetMode(resolveHandleGesture(sheetMode, -SWIPE_THRESHOLD_PX));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSheetMode(resolveHandleGesture(sheetMode, SWIPE_THRESHOLD_PX));
    }
  };

  return (
    <div
      id="calculator-tab-container"
      ref={shellRef}
      style={shellHeight ? { height: shellHeight, marginBottom: shellBleed ? -shellBleed : undefined } : undefined}
      className={`calculator-map-shell relative isolate mx-auto h-[calc(100dvh-11.5rem)] min-h-[360px] w-full overflow-hidden rounded-3xl border landscape:h-[calc(100dvh-4.75rem)] landscape:min-h-[10rem] landscape:rounded-2xl ${
        isDark ? 'border-slate-800 bg-slate-950' : 'border-slate-200 bg-slate-100'
      }`}
    >
      {/* Map fills the whole screen from the start */}
      <div className="absolute inset-0">
        <RouteMap
          points={routeElevation?.points ?? []}
          isDark={isDark}
          fill
          currentPosition={gpsCoords}
          focusPoint={gpsCoords}
          chargingStops={mapStops}
          onChargingStopClick={handleMapStopClick}
          viewportInsets={mapInsets}
          zoomControls
          zoomPlacement="auto"
          zoomControlsHidden={!landscape && sheetFull}
        />
</div>

      {/* Портрет: обёртка «прозрачна» (display: contents) — верхняя карточка и шторка позиционируются от оболочки, как раньше.
          Ландшафт: обёртка — левая колонка (поиск → быстрые кнопки → результат), справа остаётся вся карта.
          data-sheet: «compact» (пустая / свёрнутая шторка) или «expanded» — на низких экранах во втором случае прячем быстрые кнопки. */}
      <div className="calc-overlay" data-sheet={sheetView === 'idle' || (sheetView === 'result' && sheetMode === 'peek') ? 'compact' : 'expanded'}>
      {/* Top: A → B search + hidden-parameters button */}
      <div ref={topPanelRef} className="calc-top pointer-events-none absolute inset-x-2 top-2 z-30 flex flex-col gap-1.5">
        <div className="pointer-events-auto relative z-20 flex items-start gap-2">
          {searchCollapsed && (
            <div className={`flex min-w-0 flex-1 items-center rounded-2xl border shadow-lg ${surface}`}>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light', settings.hapticFeedback);
                  setSearchEditing(true);
                  if (sheetMode === 'full') setSheetMode('half');
                }}
                aria-label="Изменить маршрут"
                className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left"
              >
                <span className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-cyan-500 ring-2 ring-cyan-500/30" />
                <span className="min-w-0 truncate text-[13px] font-semibold">{routeLabels.start}</span>
                <span className={`shrink-0 text-[13px] ${muted}`}>→</span>
                <span className="min-w-0 truncate text-[13px] font-semibold">{routeLabels.dest}</span>
              </button>
              <button
                type="button"
                onClick={() => { triggerHaptic('light', settings.hapticFeedback); resetRoute(); }}
                aria-label="Сбросить маршрут"
                className={`mr-1.5 shrink-0 rounded-full p-2 ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {/* Поля А/Б остаются смонтированными и просто скрываются: иначе при возврате из «пилюли»
              автоподсказки адреса заново искали бы уже выбранный адрес и раскрывались сами. */}
          <div className={`min-w-0 flex-1 rounded-2xl border shadow-lg ${surface} ${searchCollapsed ? 'hidden' : ''}`}>
            {/* A */}
            <div className="relative flex items-center" onKeyDown={(e) => {
              if (e.key === 'Enter' && startMode === 'address' && startAddress.trim() && destinationAddress.trim()) requestRecalc();
            }}>
              {startMode === 'gps' ? (
                <button
                  type="button"
                  onClick={() => { triggerHaptic('light', settings.hapticFeedback); setStartMode('address'); }}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
                  aria-label="Указать точку А вручную"
                >
                  <span className={`inline-flex h-2.5 w-2.5 shrink-0 rounded-full ring-2 ${
                    gpsStatus === 'ok' ? 'bg-cyan-500 ring-cyan-500/30' : gpsStatus === 'error' ? 'bg-rose-500 ring-rose-500/30' : 'animate-pulse bg-amber-500 ring-amber-500/30'
                  }`} />
                  <span className="truncate text-[14px]">Моя геопозиция</span>
                  <span className={`ml-auto shrink-0 text-[11px] ${muted}`}>изменить</span>
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => { triggerHaptic('light', settings.hapticFeedback); setStartMode('gps'); setStartAddress(''); setStartPin(null); }}
                    aria-label="Начать от моей геопозиции"
                    className="absolute left-2 z-10 rounded-full p-1 text-cyan-500"
                  >
                    <LocateFixed className="h-4 w-4" />
                  </button>
                  <AddressAutocomplete
                    value={startAddress}
                    onChange={(v) => { setStartAddress(v); setStartPin(null); }}
                    onSelect={(s) => {
                      setStartAddress(s.displayName);
                      setStartPin({ lat: s.lat, lon: s.lon });
                      if (destinationAddress.trim()) requestRecalc();
                    }}
                    placeholder="Откуда? Город, улица, дом"
                    isDark={isDark}
                    inputClassName={inputCls}
                  />
                  <button
                    type="button"
                    onClick={() => { triggerHaptic('light', settings.hapticFeedback); setPickerFor('start'); }}
                    aria-label="Выбрать точку А на карте"
                    className={`absolute right-2 z-10 rounded-lg p-1.5 ${startPin ? 'text-amber-500' : muted}`}
                  >
                    <Map className="h-4 w-4" />
                  </button>
                </>
              )}
            </div>

            <div className={`relative mx-3 border-t ${isDark ? 'border-slate-700/60' : 'border-slate-200'}`}>
              {startMode === 'address' && (startAddress || destinationAddress) && (
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('light', settings.hapticFeedback);
                    const from = startAddress;
                    const fromPin = startPin;
                    setStartAddress(destinationAddress);
                    setDestinationAddress(from);
                    setStartPin(destinationPin);
                    setDestinationPin(fromPin);
                    if (from.trim() && destinationAddress.trim()) requestRecalc();
                  }}
                  aria-label="Поменять местами А и Б"
                  className={`absolute -top-3 right-8 z-10 rounded-full border p-1 active:scale-90 ${isDark ? 'border-slate-600 bg-slate-800 text-slate-300' : 'border-slate-300 bg-white text-slate-500'}`}
                >
                  <ArrowUpDown className="h-3 w-3" />
                </button>
              )}
            </div>

            {/* B */}
            <div className="relative flex items-center" onKeyDown={(e) => {
              if (e.key === 'Enter' && destinationAddress.trim() && !routeLoading) { e.preventDefault(); void calculateRouteProfile(); }
            }}>
              <MapPin className="pointer-events-none absolute left-2.5 z-10 h-4 w-4 text-rose-400" />
              <AddressAutocomplete
                value={destinationAddress}
                onChange={(v) => { setDestinationAddress(v); setDestinationPin(null); }}
                onSelect={(s) => {
                  setDestinationAddress(s.displayName);
                  setDestinationPin({ lat: s.lat, lon: s.lon });
                  // Point B chosen → the route appears right away, no separate "calculate" step.
                  void calculateRouteProfile({ lat: s.lat, lon: s.lon, displayName: s.displayName });
                }}
                placeholder="Куда едем?"
                isDark={isDark}
                inputClassName={inputCls}
              />
              <button
                type="button"
                onClick={() => { triggerHaptic('light', settings.hapticFeedback); setPickerFor('destination'); }}
                aria-label="Выбрать точку Б на карте"
                className={`absolute right-2 z-10 rounded-lg p-1.5 ${destinationPin ? 'text-amber-500' : muted}`}
              >
                <Map className="h-4 w-4" />
              </button>
            </div>
            {hasRoute && searchEditing && (
              <div className="flex justify-end px-2 pb-1.5">
                <button
                  type="button"
                  onClick={() => { triggerHaptic('light', settings.hapticFeedback); setSearchEditing(false); }}
                  aria-label="Свернуть поля маршрута"
                  className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold ${muted}`}
                >
                  <ChevronUp className="h-3.5 w-3.5" /> Свернуть
                </button>
              </div>
            )}
            {destinationAddress.trim() && !destinationPin && !routeLoading && (
              <div className="px-2 pb-2">
                <button
                  type="button"
                  onClick={() => { void calculateRouteProfile(); }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-600 py-2 text-[13px] font-bold text-white hover:bg-cyan-500 active:scale-[0.98]"
                >
                  <Navigation className="h-4 w-4" /> Построить маршрут
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => { triggerHaptic('light', settings.hapticFeedback); setParamsOpen(true); }}
            aria-label="Параметры поездки"
            className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border shadow-lg active:scale-95 ${surface}`}
          >
            <SlidersHorizontal className="h-5 w-5" />
            {paramsModified && <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-slate-900" />}
          </button>
        </div>

        {routeError && (
          <div className={`pointer-events-auto rounded-xl border px-3 py-2 text-[12px] font-medium shadow-lg ${
            isDark ? 'border-rose-800/60 bg-rose-950/90 text-rose-200' : 'border-rose-200 bg-rose-50 text-rose-700'
          }`}>
            {routeError}
          </div>
        )}

        {/* GPS + weather: one thin line instead of a card */}
        {gpsStatus === 'error' && startMode === 'gps' ? (
          <button
            type="button"
            onClick={() => { triggerHaptic('light', settings.hapticFeedback); setStartMode('address'); }}
            className={`pointer-events-auto self-start rounded-full border px-3 py-1 text-[11px] font-bold shadow ${
              isDark ? 'border-rose-700/50 bg-rose-950/80 text-rose-300' : 'border-rose-300 bg-rose-50 text-rose-700'
            }`}
          >
            GPS недоступен — указать точку А
          </button>
        ) : quickWeather && !hasRoute ? (
          <div className={`pointer-events-none relative z-10 flex items-center gap-1.5 self-start rounded-full border px-2.5 py-1 text-[11px] font-semibold shadow ${surface}`}>
            {weatherIcon(quickWeather.weatherCode, 'w-3.5 h-3.5')}
            {quickWeather.temperature >= 0 ? '+' : ''}{quickWeather.temperature}°C
            <Wind className={`h-3 w-3 ${muted}`} />
            {quickWeather.windSpeed} км/ч
          </div>
        ) : null}
      </div>

      {/* Bottom: the single sheet (result / details / stations) + quick buttons floating above it */}
      <div className={`calc-bottom pointer-events-none absolute inset-x-0 bottom-0 z-20 flex ${sheetFull ? 'max-h-[86%]' : 'max-h-[68%]'} flex-col justify-end p-2 pb-7`}>
        <div ref={bottomPanelRef} className="relative flex min-h-0 flex-col">
          {/* Portrait: a compact column on the right, hovering over the map just above the sheet (takes no layout height).
              Landscape: a plain row above the sheet, as before. Hidden while the sheet is fully expanded. */}
          {!sheetFull && (
            <div className="calc-quick pointer-events-auto absolute bottom-full right-0 z-10 mb-2 flex flex-col items-end gap-2 landscape:static landscape:mb-2 landscape:flex-row landscape:flex-wrap landscape:items-center">
              <button
                type="button"
                onClick={() => { triggerHaptic('light', settings.hapticFeedback); setParamsOpen(true); }}
                aria-label="Заряд на старте"
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-bold shadow-lg active:scale-95 ${surface}`}
              >
                <BatteryCharging className="h-3.5 w-3.5 text-cyan-500" />
                <span className="font-mono tabular-nums">{Math.round(startSoc)}%</span>
              </button>
              <button
                type="button"
                onClick={() => { triggerHaptic('medium', settings.hapticFeedback); setSelectedRouteStop(null); void searchNearbyFreeChargers(); }}
                disabled={nearbyFreeStatus === 'loading'}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-bold shadow-lg active:scale-95 disabled:opacity-70 ${surface}`}
              >
                {nearbyFreeStatus === 'loading'
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-500" />
                  : <PlugZap className="h-3.5 w-3.5 text-emerald-500" />}
                Ближайшие зарядки
              </button>
            </div>
          )}

          <motion.div
            key={sheetView}
            initial={{ y: 16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            style={sheetMaxPx ? { maxHeight: sheetMaxPx } : undefined}
            className={`calc-sheet pointer-events-auto min-h-0 overflow-y-auto overscroll-contain rounded-2xl border p-3.5 shadow-2xl ${surface}`}
          >
            {sheetView === 'station' && renderStationCard()}
            {sheetView === 'nearby' && renderNearbyView()}
            {sheetView === 'loading' && renderLoadingView()}
            {sheetView === 'result' && renderResultView()}
            {sheetView === 'idle' && renderIdleView()}
          </motion.div>
        </div>
      </div>
      </div>{/* /calc-overlay */}

      {/* Hidden parameters: speed, people, climate, weather — closed by default */}
      <AnimatePresence>
        {paramsOpen && (
          <>
            <motion.div
              key="params-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={closeParams}
              className="absolute inset-0 z-40 bg-black/50"
            />
            <motion.div
              key="params-panel"
              role="dialog"
              aria-label="Параметры поездки"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 380, damping: 36 }}
              className={`calc-params absolute inset-x-0 bottom-0 z-50 mx-auto max-h-[92%] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-3xl border p-4 pb-6 shadow-2xl ${
                isDark ? 'border-slate-700 bg-slate-900 text-slate-100' : 'border-slate-200 bg-white text-slate-900'
              }`}
            >
              <div className="flex items-center justify-between">
                <h2 className="text-[15px] font-bold">Параметры поездки</h2>
                <button type="button" onClick={closeParams} aria-label="Закрыть параметры" className={`rounded-full p-1.5 ${isDark ? 'text-slate-400 hover:bg-slate-800' : 'text-slate-500 hover:bg-slate-100'}`}>
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="calc-params-body">
              <div className="calc-params-col">
              <section className="mt-4">
                <div className="flex items-baseline justify-between">
                  <span className="text-[13px] font-semibold">Заряд на старте</span>
                  <span className={`font-mono text-2xl font-black tabular-nums ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`}>{Math.round(startSoc)}%</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button type="button" onClick={() => updateRouteStartSoc(startSoc - 5)} className={`h-9 w-11 rounded-lg border text-xs font-bold ${isDark ? 'border-slate-700 bg-slate-950 text-slate-300' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>−5</button>
                  <input type="range" min={1} max={100} value={startSoc} onChange={(e) => updateRouteStartSoc(Number(e.target.value))} aria-label="Заряд на старте, %" className="h-1.5 flex-1 cursor-pointer rounded-lg accent-cyan-500" />
                  <button type="button" onClick={() => updateRouteStartSoc(startSoc + 5)} className={`h-9 w-11 rounded-lg border text-xs font-bold ${isDark ? 'border-slate-700 bg-slate-950 text-slate-300' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>+5</button>
                </div>
              </section>

              <section className="mt-4 grid grid-cols-2 gap-2">
                <div className={`flex items-center justify-between gap-2 rounded-xl border px-2.5 py-2 ${isDark ? 'border-slate-800 bg-slate-950/70' : 'border-slate-200 bg-slate-50'}`}>
                  <span className={`text-[12px] font-semibold ${muted}`}>Люди</span>
                  <div className="flex items-center gap-1.5">
                    <button type="button" aria-label="Меньше людей" onClick={() => { setPassengers((p) => Math.max(1, p - 1)); dirty(); }} className={`h-8 w-8 rounded-lg border text-sm font-bold ${isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'}`}>−</button>
                    <span className="min-w-4 text-center font-mono font-bold">{passengers}</span>
                    <button type="button" aria-label="Больше людей" onClick={() => { setPassengers((p) => Math.min(5, p + 1)); dirty(); }} className={`h-8 w-8 rounded-lg border text-sm font-bold ${isDark ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'}`}>+</button>
                  </div>
                </div>
                <button
                  type="button"
                  aria-pressed={climateOn}
                  onClick={() => { triggerHaptic('light', settings.hapticFeedback); setClimateOn((v) => !v); dirty(); }}
                  className={`flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-[12px] font-bold ${
                    climateOn
                      ? isDark ? 'border-cyan-500/60 bg-cyan-950/70 text-cyan-300' : 'border-cyan-700 bg-cyan-600 text-white'
                      : isDark ? 'border-slate-800 bg-slate-950 text-slate-400' : 'border-slate-200 bg-slate-50 text-slate-600'
                  }`}
                >
                  <Power className="h-3.5 w-3.5" />
                  {climateOn ? 'Климат · авто' : 'Без климата'}
                </button>
              </section>

              <section className="mt-4 space-y-2">
                <div className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2 ${isDark ? 'bg-slate-950/70' : 'bg-slate-50'}`}>
                  <span className="text-[12px] font-semibold">Средняя скорость</span>
                  <div className="flex items-center gap-1">
                    <DecimalInput value={plannedSpeedKmH} onChange={(v) => { setPlannedSpeedKmH(v); setPlannedMaxSpeedKmH((prev) => Math.max(prev, v)); dirty(); }} min={20} max={140} className="w-20 text-right" />
                    <span className={`shrink-0 whitespace-nowrap text-xs ${muted}`}>км/ч</span>
                  </div>
                </div>
                <div className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2 ${isDark ? 'bg-slate-950/70' : 'bg-slate-50'}`}>
                  <span className="text-[12px] font-semibold">Максимальная</span>
                  <div className="flex items-center gap-1">
                    <DecimalInput value={plannedMaxSpeedKmH} onChange={(v) => { setPlannedMaxSpeedKmH(Math.max(plannedSpeedKmH, Math.min(150, v))); dirty(); }} min={20} max={150} className="w-20 text-right" />
                    <span className={`shrink-0 whitespace-nowrap text-xs ${muted}`}>км/ч</span>
                  </div>
                </div>
              </section>

              </div>{/* /calc-params-col (заряд, люди, скорость) */}
              <div className="calc-params-col">
              <section className="mt-4">
                <div className="flex items-center gap-1.5 text-[13px] font-semibold">
                  {weatherIcon(quickWeather?.weatherCode ?? 1, 'w-4 h-4 text-cyan-500')} Погода
                </div>
                <div className={`mt-2 grid grid-cols-2 rounded-xl p-1 ${isDark ? 'bg-slate-950' : 'bg-slate-100'}`}>
                  <button type="button" onClick={() => { setWeatherMode('current'); dirty(); }} className={seg(weatherMode === 'current')}>По прогнозу</button>
                  <button type="button" onClick={() => { setWeatherMode('planning'); dirty(); }} className={seg(weatherMode === 'planning')}>Задать вручную</button>
                </div>
                {weatherMode === 'planning' && (
                  <div className="mt-3 space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-xs"><span className={`mb-1 block ${muted}`}>🌡️ °C</span><DecimalInput value={manualTemperature} onChange={(v) => { setManualTemperature(v); dirty(); }} min={-40} max={50} allowNegative className="w-full" /></label>
                      <label className="text-xs"><span className={`mb-1 block ${muted}`}>💨 м/с</span><DecimalInput value={manualWindSpeed} onChange={(v) => { setManualWindSpeed(v); dirty(); }} min={0} max={40} className="w-full" /></label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Navigation className={`h-4 w-4 ${muted}`} style={{ transform: `rotate(${manualWindDirection}deg)` }} />
                      <span className={`text-xs ${muted}`}>Ветер</span>
                      <DecimalInput value={manualWindDirection} onChange={(v) => { setManualWindDirection(((Math.round(v) % 360) + 360) % 360); dirty(); }} min={0} max={359} className="ml-auto w-20 text-right" />
                      <span className={`text-xs ${muted}`}>°</span>
                    </div>
                    <div>
                      <div className={`mb-1.5 text-[11px] ${muted}`}>Осадки</div>
                      <div className="grid grid-cols-3 gap-1">
                        {([['none', 'Нет'], ['rain', 'Дождь'], ['snow', 'Снег']] as const).map(([v, label]) => (
                          <button key={v} type="button" onClick={() => { setManualPrecipitationType(v); dirty(); }} className={optBtn(manualPrecipitationType === v)}>{label}</button>
                        ))}
                      </div>
                    </div>
                    {manualPrecipitationType !== 'none' && (
                      <div className="grid grid-cols-3 gap-1">
                        {(['light', 'moderate', 'heavy'] as const).map((v) => (
                          <button key={v} type="button" onClick={() => { setManualPrecipitationIntensity(v); dirty(); }} className={optBtn(manualPrecipitationIntensity === v)}>
                            {v === 'light' ? 'Лёгкая' : v === 'moderate' ? 'Умеренная' : 'Сильная'}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </section>

              </div>{/* /calc-params-col (погода) */}
              </div>{/* /calc-params-body */}

              <div className={`calc-params-footer mt-5 flex items-center gap-2 ${isDark ? 'bg-slate-900' : 'bg-white'}`}>
                <button
                  type="button"
                  onClick={() => { triggerHaptic('light', settings.hapticFeedback); resetAll(); }}
                  className={`flex items-center gap-1.5 rounded-xl border px-3 py-3 text-[12px] font-semibold ${isDark ? 'border-slate-700 text-slate-300' : 'border-slate-200 text-slate-600'}`}
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Сбросить
                </button>
                <button
                  type="button"
                  onClick={closeParams}
                  className="flex-1 rounded-xl bg-cyan-600 py-3 text-[14px] font-bold text-white hover:bg-cyan-500 active:scale-[0.98]"
                >
                  {paramsDirty && routeElevation ? 'Применить и пересчитать' : 'Готово'}
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <LocationPickerModal
        isOpen={pickerFor !== null}
        isDark={isDark}
        title={pickerFor === 'start' ? 'Точка А — откуда' : 'Точка Б — куда'}
        initialCenter={(pickerFor === 'start' ? destinationPin : startPin) ?? gpsCoords ?? undefined}
        hapticFeedback={settings.hapticFeedback}
        onClose={() => setPickerFor(null)}
        onConfirm={({ lat, lon, displayName }) => {
          if (pickerFor === 'start') {
            setStartAddress(displayName);
            setStartPin({ lat, lon });
            if (destinationAddress.trim()) requestRecalc();
          } else if (pickerFor === 'destination') {
            setDestinationAddress(displayName);
            setDestinationPin({ lat, lon });
            void calculateRouteProfile({ lat, lon, displayName });
          }
          setPickerFor(null);
        }}
      />
    </div>
  );
};
