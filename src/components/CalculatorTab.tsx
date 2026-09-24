import React, { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
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
import { fetchChargingStationsAlongRoute, stationSupportsVigo, ChargingStation } from '../services/chargingStations';
import { findNearbyFreeCcsChargers, FreeChargerResult } from '../services/nearbyFreeCharging';
import { estimateChargingSession, findOptimalChargeTargetSoc, DEFAULT_UNKNOWN_STATION_POWER_KW, ChargeConnector } from '../utils/chargingPlanner';
import { RouteMap } from './RouteMap';
import { LocationPickerModal } from './LocationPickerModal';
import { ResponsiveContainer, AreaChart, Area, XAxis, Tooltip } from 'recharts';
import { CollapsibleDetails, SecondaryStatRow, ChipRow } from './ui/CollapsibleDetails';
import { AnimatedNumber } from './ui/AnimatedNumber';

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

export type HudRoutePlan = {
  destination: string;
  startSoc: number;
  plannedSpeedKmH?: number;
};

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
  // Input states
  const [startSoc, setStartSoc] = useState<number>(100);
  const [endSoc, setEndSoc] = useState<number>(45);
  const [distanceKm, setDistanceKm] = useState<number>(180);
  const [roadType, setRoadType] = useState<RoadType>('city');
  const [climateOn, setClimateOn] = useState(true);
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
  const [passengers, setPassengers] = useState(1);
  // Two distinct workflows used to live interleaved on one long scroll (route planning vs.
  // logging a completed trip by hand) with no visual separation between them. This just
  // groups the existing sections under a switcher; nothing about how each section works changes.
  const [calculatorMode, setCalculatorMode] = useState<'route' | 'manual'>('route');

  // Planned route: current GPS point A -> selected destination B -> detailed elevation profile.
  const [startMode, setStartMode] = useState<'gps' | 'address'>('gps');
  const [startAddress, setStartAddress] = useState('');
  const [destinationAddress, setDestinationAddress] = useState('');
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
  const [plannedSpeedKmH, setPlannedSpeedKmH] = useState(70);
  const [plannedMaxSpeedKmH, setPlannedMaxSpeedKmH] = useState(120);
  const [routeWeather, setRouteWeather] = useState<{ temperature:number; windSpeed:number; windDirection:number; weatherCode:number; precipitation:number; routeBearing:number; etaMinutes:number; arrivalDate: Date; samples: RouteWeatherSample[] } | null>(null);
  const [routeForecast, setRouteForecast] = useState<{ consumption:number; energyKwh:number; arrivalSoc:number; windLabel:string; weatherLabel:string; precipitationLabel:string; relativeWindAngle:number; driverStyleFactor:number; driverStyleSource:string; climateLabel:string; climateImpactPct:number; climateDeltaKwh100:number; speedImpactPct:number; breakdown?: any } | null>(null);
  // Mid-route charging suggestion — computed whenever the forecast arrival SoC drops under 20%.
  // "loading"/"unavailable" keep the UI from silently showing nothing while EVRACE/OSM are queried
  // or when no reachable Type2/CCS2 station was found along the route.
  const [chargingSuggestion, setChargingSuggestion] = useState<{
    station: ChargingStation;
    connector: ChargeConnector;
    socAtStation: number;
    targetSoc: number;
    minRequiredSoc: number;
    session: { minutes: number; energyKwh: number; avgPowerKw: number };
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
    session: { minutes: number; energyKwh: number; avgPowerKw: number };
    finishSocAfterCharge: number;
  }>>([]);
  /** How many VIGO-compatible stations were found along the corridor before usefulness filtering. */
  const [stationsFoundAlongRoute, setStationsFoundAlongRoute] = useState(0);
  const [nearbyFreeStatus, setNearbyFreeStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [nearbyFreeList, setNearbyFreeList] = useState<FreeChargerResult[]>([]);
  const [nearbyFreeError, setNearbyFreeError] = useState('');

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
  /** Detailed route info (map, elevation, breakdown) — collapsed after calc */
  const [routeDetailsOpen, setRouteDetailsOpen] = useState(false);
  const [manualDetailsOpen, setManualDetailsOpen] = useState(false);
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

  useEffect(() => {
    if (!navigator.geolocation) { setGpsStatus('error'); return; }
    const id = navigator.geolocation.watchPosition(
      async (position) => {
        setGpsStatus('ok');
        setGpsCoords({ lat: position.coords.latitude, lon: position.coords.longitude });
        try {
          const { latitude, longitude } = position.coords;
          const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude.toFixed(4)}&longitude=${longitude.toFixed(4)}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`);
          if (!res.ok) return;
          const data = await res.json();
          if (data?.current) setQuickWeather({
            temperature: Math.round(data.current.temperature_2m),
            weatherCode: data.current.weather_code ?? 0,
            windSpeed: Math.round(data.current.wind_speed_10m ?? 0),
          });
        } catch { /* keep last known weather */ }
      },
      () => setGpsStatus('error'),
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 10000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // After a successful route calc, keep the hero result in the viewport (not the page bottom).
  useEffect(() => {
    if (!resultHighlight || !routeForecast) return;
    const timer = window.setTimeout(() => {
      document.getElementById('route-result-main')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [resultHighlight, routeForecast]);

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
      const { results } = await findNearbyFreeCcsChargers(origin, { radiusKm: 40, limit: 10 });
      setNearbyFreeList(results);
      setNearbyFreeStatus('ready');
      if (!results.length) {
        setNearbyFreeError('Свободных CCS рядом не найдено.');
      }
    } catch (e) {
      setNearbyFreeStatus('error');
      setNearbyFreeError(e instanceof Error ? e.message : String(e));
    }
  }, [startMode, gpsCoords, startPin]);

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
    try {
      const stations = await fetchChargingStationsAlongRoute(routeElevation.points, force ? 8 : 5);
      if (cancelled) return;
      const vigoStations = stations.filter(stationSupportsVigo);
      setStationsFoundAlongRoute(vigoStations.length);
      const batteryCap = settings.batteryCapacityKwh || 51.87;
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
          const connector: ChargeConnector = station.hasCcs2 || station.connectorTypeUnknown ? 'ccs2' : 'type2';
          const rawStationMaxPowerKw = connector === 'ccs2' ? station.ccs2PowerKw : station.type2PowerKw;
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
                connector,
                stationMaxPowerKw,
                {
                  // Allow only a tiny efficiency pad above the true need.
                  maxTargetSoc: Math.min(90, Math.max(desiredTarget, desiredTarget + 3)),
                  marginalRateThreshold: 0.5,
                },
              );
          const chargeAddedSoc = Math.max(0, targetSoc - socAtStation);
          const session = estimateChargingSession(socAtStation, targetSoc, batteryCap, connector, stationMaxPowerKw);
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
            session.minutes +
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

      // Optional search with high finish SOC: if strict window found nothing, take the
      // best mid-route VIGO station with any positive charge session.
      if (!candidates.length && (!mustCharge || force)) {
        candidates = vigoStations
          .map((station) => {
            const socAtStation = socAtDistance(station.distanceAlongRouteKm);
            const remainingKm = Math.max(0, totalDistanceKm - station.distanceAlongRouteKm);
            if (socAtStation < 10 || socAtStation > 88) return null;
            if (remainingKm < 10) return null;
            if (station.distanceAlongRouteKm < 5) return null;
            const remainingEnergyKwh = totalEnergyKwh * (remainingKm / Math.max(0.001, totalDistanceKm));
            const minRequiredSoc = Math.min(95, (remainingEnergyKwh / batteryCap) * 100 + ARRIVAL_RESERVE_SOC);
            const connector: ChargeConnector = station.hasCcs2 || station.connectorTypeUnknown ? 'ccs2' : 'type2';
            const rawStationMaxPowerKw = connector === 'ccs2' ? station.ccs2PowerKw : station.type2PowerKw;
            const stationMaxPowerKw = rawStationMaxPowerKw ?? DEFAULT_UNKNOWN_STATION_POWER_KW;
            const desiredTarget = Math.min(
              90,
              Math.max(socAtStation + 5, minRequiredSoc),
            );
            const targetSoc = findOptimalChargeTargetSoc(
              socAtStation,
              desiredTarget,
              connector,
              stationMaxPowerKw,
              {
                maxTargetSoc: Math.min(90, Math.max(desiredTarget, desiredTarget + 3)),
                marginalRateThreshold: 0.5,
              },
            );
            const chargeAddedSoc = Math.max(0, targetSoc - socAtStation);
            if (chargeAddedSoc < 3) return null;
            const session = estimateChargingSession(socAtStation, targetSoc, batteryCap, connector, stationMaxPowerKw);
            if (session.minutes <= 0) return null;
            const finishSocAfterCharge = Math.max(
              0,
              Math.min(100, targetSoc - (remainingEnergyKwh / batteryCap) * 100),
            );
            const score =
              session.minutes +
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
      const MAX_STOPS = 4;
      const MIN_GAP_KM = 25;
      const plan: typeof candidates = [];
      let cursorKm = 0;
      let socCursor = startSoc;
      const energyPerKm = totalEnergyKwh / Math.max(0.001, totalDistanceKm);

      const buildStopCandidate = (
        station: (typeof vigoStations)[0],
        socAtStation: number,
        reserveAtB: number,
      ) => {
        const remainingKm = Math.max(0, totalDistanceKm - station.distanceAlongRouteKm);
        const remainingEnergyKwh = energyPerKm * remainingKm;
        if (remainingKm < MIN_TAIL_KM) return null; // no stop in the tail of the route
        const minRequiredSoc = Math.min(95, (remainingEnergyKwh / batteryCap) * 100 + reserveAtB);
        const connector: ChargeConnector = station.hasCcs2 || station.connectorTypeUnknown ? 'ccs2' : 'type2';
        const rawStationMaxPowerKw = connector === 'ccs2' ? station.ccs2PowerKw : station.type2PowerKw;
        const stationMaxPowerKw = rawStationMaxPowerKw ?? DEFAULT_UNKNOWN_STATION_POWER_KW;
        const desiredTarget = minRequiredSoc;
        const targetSoc = findOptimalChargeTargetSoc(socAtStation, desiredTarget, connector, stationMaxPowerKw, {
          maxTargetSoc: Math.min(90, Math.max(desiredTarget, desiredTarget + 3)),
          marginalRateThreshold: 0.5,
        });
        const chargeAddedSoc = Math.max(0, targetSoc - socAtStation);
        if (chargeAddedSoc < MIN_USEFUL_CHARGE_SOC) return null;
        const session = estimateChargingSession(socAtStation, targetSoc, batteryCap, connector, stationMaxPowerKw);
        if (session.minutes <= 0) return null;
        const finishSocAfterCharge = Math.max(0, Math.min(100, targetSoc - (remainingEnergyKwh / batteryCap) * 100));
        const score =
          session.minutes +
          station.distanceFromRouteKm * 5 +
          Math.abs(socAtStation - IDEAL_ARRIVAL_SOC) * 1.5 +
          (socAtStation > 50 ? (socAtStation - 50) * 1.5 : 0);
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

        const pool = (
          n === 0
            ? candidates
            : vigoStations
                .map((station) => {
                  const dist = station.distanceAlongRouteKm;
                  if (dist < cursorKm + MIN_GAP_KM) return null;
                  const socAtStation =
                    socCursor - (energyPerKm * (dist - cursorKm) * 100) / batteryCap;
                  if (socAtStation < ARRIVAL_RESERVE_SOC) return null;
                  if (socAtStation > 70) return null;
                  return buildStopCandidate(station, socAtStation, FINISH_SOC_TARGET);
                })
                .filter((x): x is NonNullable<typeof x> => !!x)
                .sort((a, b) => a.score - b.score)
        );

        if (!pool.length) break;
        // Prefer stops that leave a real leg after them (already filtered), meaningful charge.
        const pick = pool.find((c) => c.chargeAddedSoc >= MIN_USEFUL_CHARGE_SOC) ?? pool[0];
        if (pick.chargeAddedSoc < MIN_USEFUL_CHARGE_SOC) break;

        plan.push(pick);
        cursorKm = pick.station.distanceAlongRouteKm;
        socCursor = pick.targetSoc;
        if (pick.finishSocAfterCharge >= FINISH_SOC_MIN) break;
      }

      // Drop a trailing micro-stop: charge a bit more on the previous one instead (or accept ≥ MIN).
      if (plan.length >= 2) {
        const last = plan[plan.length - 1];
        const prev = plan[plan.length - 2];
        if (last.chargeAddedSoc < MIN_USEFUL_CHARGE_SOC + 2 || last.finishSocAfterCharge - FINISH_SOC_MIN < 6) {
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
            (connector === 'ccs2' ? prev.station.ccs2PowerKw : prev.station.type2PowerKw) ??
            DEFAULT_UNKNOWN_STATION_POWER_KW;
          const targetSoc = findOptimalChargeTargetSoc(prev.socAtStation, bumpTarget, connector, stationMax, {
            maxTargetSoc: Math.min(90, Math.max(bumpTarget, bumpTarget + 3)),
            marginalRateThreshold: 0.5,
          });
          const session = estimateChargingSession(
            prev.socAtStation,
            targetSoc,
            batteryCap,
            connector,
            stationMax,
          );
          const finishSocAfterCharge = Math.max(
            0,
            Math.min(100, targetSoc - (remainingEnergyPrev / batteryCap) * 100),
          );
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

      // If single (or last) stop still ends below MIN only slightly, leave it — band is soft.
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
  }, [routeElevation, routeForecast, startSoc, settings.batteryCapacityKwh]);

  // Automatic search is deliberately limited to the low-arrival-SOC case.
  useEffect(() => {
    if (!routeElevation || !routeForecast || routeForecast.arrivalSoc >= CHARGE_SUGGEST_SOC) {
      setChargingSuggestion(null);
      setChargingStops([]);
      setChargingSuggestionStatus('idle');
      setStationsFoundAlongRoute(0);
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
      setRouteDetailsOpen(false);
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

  const isDark = settings.theme !== 'light';

  return (
    <div id="calculator-tab-container" className="calculator-minimal-shell flex flex-col gap-3 pb-12 max-w-2xl mx-auto">
      {/* Quick status */}
      <section className={`calculator-status rounded-2xl border px-4 py-2.5 ${isDark ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200 shadow-xs'}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs min-w-0">
            <span className={`inline-flex h-2 w-2 shrink-0 rounded-full ${gpsStatus === 'ok' ? 'bg-cyan-500' : gpsStatus === 'error' ? 'bg-rose-500' : 'bg-amber-500 animate-pulse'}`} />
            <LocateFixed className={`w-4 h-4 shrink-0 ${gpsStatus === 'ok' ? 'text-cyan-500' : gpsStatus === 'error' ? 'text-rose-500' : 'text-amber-500'}`} />
            <span className="font-semibold">GPS</span>
            <span className="text-slate-500 truncate">
              {gpsStatus === 'ok' ? 'Сигнал есть' : gpsStatus === 'error' ? 'Недоступен' : 'Поиск…'}
            </span>
          </div>
          {gpsStatus === 'error' ? (
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light', settings.hapticFeedback);
                setStartMode('address');
                setCalculatorMode('route');
              }}
              className={`shrink-0 rounded-lg px-2.5 py-1 text-[11px] font-bold border ${
                isDark
                  ? 'bg-rose-950/50 border-rose-700/50 text-rose-300'
                  : 'bg-rose-50 border-rose-300 text-rose-700'
              }`}
            >
              Указать адрес точки А
            </button>
          ) : quickWeather ? (
            <div className="flex items-center gap-1.5 text-xs">
              {weatherIcon(quickWeather.weatherCode)}
              <span className="font-semibold">{quickWeather.temperature >= 0 ? '+' : ''}{quickWeather.temperature}°C</span>
              <span className="text-slate-500">·</span>
              <Wind className="w-3.5 h-3.5 text-slate-400" />
              <span>{quickWeather.windSpeed} км/ч</span>
            </div>
          ) : (
            <span className="text-xs text-slate-500">Погода загружается…</span>
          )}
        </div>
        {gpsStatus === 'error' && startMode === 'gps' && calculatorMode === 'route' && (
          <p className={`mt-2 text-[11px] ${isDark ? 'text-rose-300/90' : 'text-rose-600'}`}>
            Без GPS маршрут от текущей позиции недоступен. Переключитесь на «Адрес точки А» или нажмите кнопку выше.
          </p>
        )}
      </section>

      {/* Compact trip conditions: SoC + people + climate in one row-card */}
      <section className={`rounded-2xl border p-3 space-y-3 ${isDark ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200 shadow-xs'}`}>
        <div className="flex items-center justify-between gap-2">
          <span className={`text-xs font-bold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Старт</span>
          <span className={`text-xl font-black font-mono tabular-nums ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`}>{Math.round(startSoc)}%</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => updateRouteStartSoc(startSoc - 5)} className={`w-10 h-9 rounded-lg font-bold text-xs border ${isDark ? 'bg-slate-950 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'}`}>−5</button>
          <input type="range" min={1} max={100} value={startSoc} onChange={(e) => updateRouteStartSoc(Number(e.target.value))} className="flex-1 accent-cyan-500 h-1.5 rounded-lg cursor-pointer" />
          <button type="button" onClick={() => updateRouteStartSoc(startSoc + 5)} className={`w-10 h-9 rounded-lg font-bold text-xs border ${isDark ? 'bg-slate-950 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'}`}>+5</button>
        </div>
        <div className="flex items-center gap-2">
          <div className={`flex-1 flex items-center justify-between gap-2 rounded-xl border px-2.5 py-1.5 ${isDark ? 'bg-slate-950/80 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
            <span className={`text-[11px] font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Люди</span>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => setPassengers(p => Math.max(1, p - 1))} className={`w-8 h-8 rounded-lg font-bold border text-sm ${isDark ? 'bg-slate-900 border-slate-700 text-slate-300' : 'bg-white border-slate-200 text-slate-700'}`}>−</button>
              <span className={`min-w-5 text-center font-bold font-mono ${isDark ? 'text-white' : 'text-slate-900'}`}>{passengers}</span>
              <button type="button" onClick={() => setPassengers(p => Math.min(5, p + 1))} className={`w-8 h-8 rounded-lg font-bold border text-sm ${isDark ? 'bg-slate-900 border-slate-700 text-slate-300' : 'bg-white border-slate-200 text-slate-700'}`}>+</button>
            </div>
          </div>
          <button
            type="button"
            onClick={() => { triggerHaptic('light', settings.hapticFeedback); setClimateOn(v => !v); }}
            className={`shrink-0 rounded-xl px-3 py-2 text-xs font-bold border transition-colors ${
              climateOn
                ? isDark ? 'bg-cyan-950/70 text-cyan-300 border-cyan-500/60' : 'bg-cyan-600 text-white border-cyan-700'
                : isDark ? 'bg-slate-950 text-slate-400 border-slate-800' : 'bg-slate-50 text-slate-600 border-slate-200'
            }`}
          >
            <span className="inline-flex items-center gap-1"><Power className="w-3.5 h-3.5" />{climateOn ? 'Климат' : 'Без клим.'}</span>
          </button>
        </div>
      </section>

      {/* Mode: route planning vs. logging a completed trip — two different workflows, kept visually separate instead of one long interleaved scroll */}
      <LayoutGroup>
        <div className={`relative grid grid-cols-2 rounded-2xl border p-1 gap-1 ${isDark ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200 shadow-xs'}`}>
          <button
            onClick={() => { triggerHaptic('light', settings.hapticFeedback); setCalculatorMode('route'); }}
            className={`relative z-10 rounded-xl py-2.5 text-sm font-bold flex items-center justify-center gap-1.5 transition-colors ${calculatorMode === 'route' ? 'text-white' : isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-800'}`}
          >
            {calculatorMode === 'route' && (
              <motion.div
                layoutId="calculatorModePill"
                className="absolute inset-0 rounded-xl bg-cyan-600 shadow-sm"
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-1.5">
              <Navigation className="w-4 h-4" /> Маршрут
            </span>
          </button>
          <button
            onClick={() => { triggerHaptic('light', settings.hapticFeedback); setCalculatorMode('manual'); }}
            className={`relative z-10 rounded-xl py-2.5 text-sm font-bold flex items-center justify-center gap-1.5 transition-colors ${calculatorMode === 'manual' ? 'text-white' : isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-800'}`}
          >
            {calculatorMode === 'manual' && (
              <motion.div
                layoutId="calculatorModePill"
                className="absolute inset-0 rounded-xl bg-cyan-600 shadow-sm"
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-1.5">
              <Gauge className="w-4 h-4" /> Ручной ввод
            </span>
          </button>
        </div>
      </LayoutGroup>

      <AnimatePresence mode="wait" initial={false}>
      {calculatorMode === 'route' && (
        <motion.div
          key="mode-route"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col gap-3"
        >
        <>

      {/* Route: A → B + calculate */}
      <section className={`calculator-route rounded-2xl border p-3 space-y-3 ${isDark ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200 shadow-xs'}`}>
        <div className={`grid grid-cols-2 rounded-xl p-1 ${isDark ? 'bg-slate-950' : 'bg-slate-100'}`}>
          <button onClick={() => setStartMode('gps')} className={`rounded-lg py-2 text-xs font-semibold ${startMode === 'gps' ? (isDark ? 'bg-slate-800 text-white' : 'bg-white text-slate-900 shadow-sm') : 'text-slate-500'}`}>📍 Здесь</button>
          <button onClick={() => setStartMode('address')} className={`rounded-lg py-2 text-xs font-semibold ${startMode === 'address' ? (isDark ? 'bg-slate-800 text-white' : 'bg-white text-slate-900 shadow-sm') : 'text-slate-500'}`}>🏠 Адрес А</button>
        </div>

        {startMode === 'address' && (
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <AddressAutocomplete
              value={startAddress}
              onChange={(v) => { setStartAddress(v); setStartPin(null); }}
              onSelect={(s) => { setStartAddress(s.displayName); setStartPin({ lat: s.lat, lon: s.lon }); }}
              placeholder="Откуда? Город, улица, дом"
              isDark={isDark}
              inputClassName={`w-full rounded-xl border py-3 pl-9 pr-12 text-sm outline-none truncate ${isDark ? 'bg-slate-950 border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'}`}
            />
            <button
              type="button"
              onClick={() => { triggerHaptic('light', settings.hapticFeedback); setPickerFor('start'); }}
              aria-label="Выбрать точку А на карте"
              className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg ${startPin ? 'text-amber-500' : 'text-slate-400'} ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-200'}`}
            >
              <Map className="w-4 h-4" />
            </button>
          </div>
        )}

        {startMode === 'address' && (startAddress || destinationAddress) && (
          <div className="flex justify-center -my-1.5 relative z-10">
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
              }}
              aria-label="Поменять местами А и Б"
              className={`p-1.5 rounded-full border transition-all active:scale-90 ${isDark ? 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white' : 'bg-white border-slate-300 text-slate-500 hover:text-slate-800 shadow-xs'}`}
            >
              <ArrowUpDown className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div className="relative">
          <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <AddressAutocomplete
            value={destinationAddress}
            onChange={(v) => { setDestinationAddress(v); setDestinationPin(null); }}
            onSelect={(s) => { setDestinationAddress(s.displayName); setDestinationPin({ lat: s.lat, lon: s.lon }); }}
            placeholder="Куда? Город, улица, дом"
            isDark={isDark}
            inputClassName={`w-full rounded-xl border py-3 pl-9 pr-12 text-sm outline-none truncate ${isDark ? 'bg-slate-950 border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'}`}
          />
          <button
            type="button"
            onClick={() => { triggerHaptic('light', settings.hapticFeedback); setPickerFor('destination'); }}
            aria-label="Выбрать точку Б на карте"
            className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg ${destinationPin ? 'text-amber-500' : 'text-slate-400'} ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-200'}`}
          >
            <Map className="w-4 h-4" />
          </button>
        </div>

        <LocationPickerModal
          isOpen={pickerFor !== null}
          isDark={isDark}
          title={pickerFor === 'start' ? 'Точка А — откуда' : 'Точка Б — куда'}
          initialCenter={
            (pickerFor === 'start' ? destinationPin : startPin) // pick near the other end of the route, if set
            ?? gpsCoords // else near the device
            ?? undefined // else the modal's own Minsk fallback
          }
          hapticFeedback={settings.hapticFeedback}
          onClose={() => setPickerFor(null)}
          onConfirm={({ lat, lon, displayName }) => {
            if (pickerFor === 'start') { setStartAddress(displayName); setStartPin({ lat, lon }); }
            else if (pickerFor === 'destination') { setDestinationAddress(displayName); setDestinationPin({ lat, lon }); }
            setPickerFor(null);
          }}
        />

        <CollapsibleDetails
          isDark={isDark}
          label={`Скорость · ср. ${plannedSpeedKmH} · макс. ${plannedMaxSpeedKmH} км/ч`}
          open={routeParamsOpen}
          onToggle={() => setRouteParamsOpen(v => !v)}
        >
          <div className="space-y-2">
            <div className={`rounded-xl p-2.5 flex items-center justify-between gap-3 ${isDark ? 'bg-slate-950' : 'bg-slate-50'}`}>
              <span className="text-xs font-semibold">Средняя</span>
              <div className="flex items-center gap-1">
                <DecimalInput value={plannedSpeedKmH} onChange={(v) => { setPlannedSpeedKmH(v); setPlannedMaxSpeedKmH((prev) => Math.max(prev, v)); }} min={20} max={140} className="w-20 text-right" />
                <span className="text-xs text-slate-500">км/ч</span>
              </div>
            </div>
            <div className={`rounded-xl p-2.5 flex items-center justify-between gap-3 ${isDark ? 'bg-slate-950' : 'bg-slate-50'}`}>
              <span className="text-xs font-semibold">Максимум</span>
              <div className="flex items-center gap-1">
                <DecimalInput value={plannedMaxSpeedKmH} onChange={(v) => setPlannedMaxSpeedKmH(Math.max(plannedSpeedKmH, Math.min(150, v)))} min={20} max={150} className="w-20 text-right" />
                <span className="text-xs text-slate-500">км/ч</span>
              </div>
            </div>
          </div>
        </CollapsibleDetails>

        <button
          onClick={() => { void calculateRouteProfile(); }}
          disabled={routeLoading}
          className="w-full rounded-xl bg-cyan-600 hover:bg-cyan-500 py-3.5 text-sm font-bold text-white disabled:opacity-60 flex items-center justify-center gap-2 active:scale-[0.98] transition-all shadow-sm shadow-cyan-600/20"
        >
          {routeLoading
            ? <><Loader2 className="w-5 h-5 animate-spin" /> Считаем маршрут…</>
            : <><Navigation className="w-5 h-5" /> Рассчитать маршрут</>}
        </button>

        {routeLoading && <div className="text-xs text-cyan-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{routeStatus || 'Подготавливаем расчёт…'}</div>}
        {routeError && <div className="text-xs text-rose-500">{routeError}</div>}

        <div className={`rounded-xl border p-3 space-y-2 ${isDark ? 'border-slate-800 bg-slate-950/50' : 'border-slate-200 bg-slate-50'}`}>
          <button
            type="button"
            onClick={() => { triggerHaptic('light', settings.hapticFeedback); void searchNearbyFreeChargers(); }}
            disabled={nearbyFreeStatus === 'loading'}
            className={`w-full rounded-lg px-3 py-2.5 text-[12px] font-semibold flex items-center justify-center gap-2 ${
              isDark ? 'bg-slate-900 text-slate-200 hover:bg-slate-800' : 'bg-white text-slate-800 border border-slate-200'
            }`}
          >
            {nearbyFreeStatus === 'loading' ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Ищем свободные CCS…</>
            ) : (
              <><PlugZap className="w-4 h-4" /> Ближайшая свободная зарядка</>
            )}
          </button>
          {nearbyFreeStatus === 'error' && (
            <p className="text-[11px] text-rose-500">{nearbyFreeError}</p>
          )}
          {nearbyFreeStatus === 'ready' && nearbyFreeError && !nearbyFreeList.length && (
            <p className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>{nearbyFreeError}</p>
          )}
          {nearbyFreeList.length > 0 && (
            <ul className="space-y-1.5 max-h-56 overflow-auto">
              {nearbyFreeList.map((item) => (
                <li key={item.station.id}>
                  <button
                    type="button"
                    onClick={() => applyFreeChargerAsDestination(item)}
                    className={`w-full text-left rounded-lg px-3 py-2 ${
                      isDark ? 'bg-slate-900/80 hover:bg-slate-800' : 'bg-white hover:bg-slate-100 border border-slate-100'
                    }`}
                  >
                    <div className={`text-[12px] font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                      {item.station.name}
                    </div>
                    <div className={`mt-0.5 text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                      {item.distanceKm < 1
                        ? `${Math.round(item.distanceKm * 1000)} м`
                        : `${item.distanceKm.toFixed(1)} км`}
                      {' · '}CCS свободно {item.freeCcs}
                      {item.station.ccs2PowerKw
                        ? ` · ${Math.round(item.station.ccs2PowerKw)} кВт`
                        : ''}
                      {item.operator ? ` · ${item.operator}` : ''}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {routeElevation && !routeElevation.elevationAvailable && routeElevation.elevationNote && (
          <div className={`text-xs rounded-lg px-3 py-2 ${isDark ? 'bg-amber-950/40 text-amber-400' : 'bg-amber-50 text-amber-700'}`}>⚠ {routeElevation.elevationNote}</div>
        )}

        {routeElevation && (
          <>
            {routeForecast && (() => {
              const arrival = routeForecast.arrivalSoc;
              const statusTone =
                arrival >= 20
                  ? 'good'
                  : arrival >= ARRIVAL_RESERVE_SOC
                  ? 'ok'
                  : 'low';
              const statusText =
                statusTone === 'good'
                  ? '✓ Доедете с хорошим запасом'
                  : statusTone === 'ok'
                  ? 'Небольшой запас'
                  : startSoc >= 99
                  ? 'Нужна зарядка в пути'
                  : 'Недостаточно заряда';
              const statusColor =
                statusTone === 'good'
                  ? isDark
                    ? 'text-cyan-400'
                    : 'text-cyan-600'
                  : statusTone === 'ok'
                  ? 'text-amber-500'
                  : 'text-rose-500';
              return (
              <div id="route-result-main" className="space-y-3">
                {/* Map first — main visual */}
                <div className={`rounded-2xl border overflow-hidden ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                  <RouteMap
                    points={routeElevation.points}
                    isDark={isDark}
                    chargingStops={
                      chargingSuggestionStatus === 'ready' && chargingStops.length
                        ? chargingStops.map((s) => ({
                            lat: s.station.lat,
                            lon: s.station.lon,
                            name: s.station.name,
                            address: s.station.address,
                          }))
                        : chargingSuggestionStatus === 'ready' && chargingSuggestion
                          ? [{
                              lat: chargingSuggestion.station.lat,
                              lon: chargingSuggestion.station.lon,
                              name: chargingSuggestion.station.name,
                              address: chargingSuggestion.station.address,
                            }]
                          : []
                    }
                  />
                  <div className={`p-2 ${isDark ? 'bg-slate-950' : 'bg-slate-50'}`}>
                    <a
                      href={typeof yandexNaviHref === 'string' ? '#' : yandexNaviHref.web}
                      onClick={openYandexNavi}
                      className={`block w-full rounded-lg px-3 py-2.5 text-center text-[12px] font-semibold ${isDark ? 'bg-slate-900 text-slate-200 hover:bg-slate-800' : 'bg-white text-slate-800 border border-slate-200'}`}
                    >
                      Открыть в Яндекс Навигаторе
                    </a>
                  </div>
                </div>

                {/* Compact SOC + charging strip under the map */}
                <div className={`rounded-2xl border px-4 py-3 ${isDark ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200'}`}>
                  <div className="flex items-center gap-4">
                    <div className="min-w-0 flex-1">
                      <div className={`text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>На финише</div>
                      <div className={`text-4xl font-black font-mono tracking-tight leading-none ${statusColor}`}>
                        <AnimatedNumber value={arrival} decimals={0} suffix="%" className={statusColor} />
                      </div>
                      <div className={`mt-1 text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{statusText}</div>
                    </div>
                    <div className={`text-right text-[11px] tabular-nums shrink-0 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      <div><span className={`font-mono ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{routeForecast.consumption.toFixed(1)}</span> кВт⋅ч/100</div>
                      <div className="mt-0.5"><span className={`font-mono ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{routeForecast.energyKwh.toFixed(1)}</span> кВт⋅ч</div>
                      <div className="mt-0.5">старт {Math.round(startSoc)}%</div>
                    </div>
                  </div>

                  {routeForecast && (
                    <div className={`mt-3 pt-3 border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
                      <div className={`flex items-center gap-1.5 text-[11px] font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                        <PlugZap className="w-3.5 h-3.5" />
                        {arrival < CHARGE_SUGGEST_SOC ? 'Зарядка в пути' : 'Зарядка по маршруту'}
                      </div>
                      {chargingSuggestionStatus === 'loading' && (
                        <p className={`mt-1.5 text-[11px] flex items-center gap-1.5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                          <Loader2 className="w-3 h-3 animate-spin" /> Ищем станции…
                        </p>
                      )}
                      {arrival >= CHARGE_SUGGEST_SOC && chargingSuggestionStatus === 'idle' && (
                        <button
                          type="button"
                          onClick={() => { triggerHaptic('light', settings.hapticFeedback); void searchChargingStations(); }}
                          className={`mt-2 w-full rounded-lg px-3 py-2 text-[12px] font-semibold ${isDark ? 'bg-slate-900 text-slate-200' : 'bg-slate-100 text-slate-700'}`}
                        >
                          Найти зарядку по маршруту
                        </button>
                      )}
                      {chargingSuggestionStatus === 'unavailable' && (
                        <div className="mt-1.5 space-y-2">
                          <p className={`text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-600'}`}>
                            {stationsFoundAlongRoute > 0
                              ? 'Подходящей остановки по правилам комфорта нет.'
                              : 'Станций на маршруте не найдено.'}
                          </p>
                          {stationsFoundAlongRoute > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                triggerHaptic('light', settings.hapticFeedback);
                                void searchChargingStations({ force: true });
                              }}
                              className={`w-full rounded-lg px-3 py-2 text-[12px] font-semibold ${
                                isDark ? 'bg-cyan-500/15 text-cyan-300' : 'bg-cyan-50 text-cyan-800'
                              }`}
                            >
                              Показать станции всё равно
                            </button>
                          )}
                        </div>
                      )}
                      {chargingSuggestionStatus === 'error' && (
                        <p className={`mt-1.5 text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-600'}`}>
                          Не удалось загрузить станции.
                        </p>
                      )}
                      {chargingSuggestionStatus === 'ready' && (chargingStops.length > 0 || chargingSuggestion) && (
                        <div className="mt-2 space-y-2">
                          {(chargingStops.length ? chargingStops : [{
                            station: chargingSuggestion!.station,
                            connector: chargingSuggestion!.connector,
                            socAtStation: chargingSuggestion!.socAtStation,
                            targetSoc: chargingSuggestion!.targetSoc,
                            session: chargingSuggestion!.session,
                            finishSocAfterCharge: chargingSuggestion!.finishSocAfterCharge,
                          }]).map((stop, idx, arr) => (
                            <div key={`${stop.station.id}-${idx}`} className={idx > 0 ? `pt-2 border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}` : ''}>
                              <p className={`text-[12px] leading-snug ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                                {arr.length > 1 && (
                                  <span className={`mr-1.5 text-[10px] font-bold ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                                    {idx + 1}.
                                  </span>
                                )}
                                <span className="font-semibold">{stop.station.name}</span>
                                {stop.station.address ? ` · ${stop.station.address}` : ''}
                                {' · '}~{Math.round(stop.station.distanceAlongRouteKm)} км
                              </p>
                              <p className={`mt-0.5 text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                                {stop.connector === 'ccs2' ? 'CCS' : 'Type2'}
                                {(stop.connector === 'ccs2' ? stop.station.ccs2PowerKw : stop.station.type2PowerKw) ? ` · ${Math.round(stop.connector === 'ccs2' ? stop.station.ccs2PowerKw! : stop.station.type2PowerKw!)} кВт` : ''}
                                {' · '}~{Math.round(stop.socAtStation)}%
                                {!chargingSearchForced && <> → {Math.round(stop.targetSoc)}%</>}
                                {' · '}{stop.session.minutes} мин
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                      {hasChargingAdjustedFinishSoc && (
                        <div className={`mt-2 rounded-lg border px-3 py-2 ${isDark ? 'border-cyan-900/60 bg-cyan-950/30' : 'border-cyan-200 bg-cyan-50'}`}>
                          <div className={`text-[10px] font-semibold ${isDark ? 'text-cyan-500' : 'text-cyan-700'}`}>После зарядки на финише</div>
                          <div className={`text-lg font-black font-mono ${isDark ? 'text-cyan-300' : 'text-cyan-700'}`}>{Math.round(chargingFinishSoc!)}%</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              );
            })()}

            {/* Send planned route to HUD for live tracking */}
            {onSendToHud && destinationAddress.trim() && (
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('success', settings.hapticFeedback);
                  onSendToHud({
                    destination: destinationAddress.trim(),
                    startSoc,
                    plannedSpeedKmH,
                  });
                }}
                className={`w-full rounded-xl py-3.5 text-sm font-bold flex items-center justify-center gap-2 border transition-all active:scale-[0.98] ${
                  isDark
                    ? 'bg-sky-950/50 border-sky-700/60 text-sky-300 hover:bg-sky-900/40'
                    : 'bg-sky-50 border-sky-300 text-sky-800 hover:bg-sky-100'
                }`}
              >
                <Navigation className="w-5 h-5" />
                Вести в HUD
              </button>
            )}

            {/* All secondary route info behind one control */}
            <CollapsibleDetails
              isDark={isDark}
              label="Подробнее о маршруте"
              open={routeDetailsOpen}
              onToggle={() => setRouteDetailsOpen(v => !v)}
              className="mt-1"
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
                          <XAxis dataKey="distance" type="number" domain={[0, 'dataMax']} tick={{ fontSize: 10 }} tickFormatter={(v) => `${v} км`} interval="preserveStartEnd" />
                          <Tooltip formatter={(v: number) => [`${Math.round(v)} м`, 'Высота']} labelFormatter={(v) => `${v} км`} />
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
                        <XAxis dataKey="distance" type="number" domain={[0, 'dataMax']} tick={{ fontSize: 10 }} tickFormatter={(v) => `${v} км`} interval="preserveStartEnd" />
                        <Tooltip formatter={(v: number) => [`${v} км/ч`, 'Скорость']} labelFormatter={(v) => `${v} км`} />
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
          </>
        )}
      </section>

      {/* Weather — collapsed by default */}
      <CollapsibleDetails
        isDark={isDark}
        label={weatherMode === 'current' ? 'Погода · сейчас' : 'Погода · вручную'}
        icon={<CloudSun className="w-4 h-4 text-cyan-500" />}
        open={weatherPanelOpen}
        onToggle={() => setWeatherPanelOpen(v => !v)}
        className="rounded-2xl"
      >
        <div className="space-y-3">
          <div className={`grid grid-cols-2 rounded-xl p-1 ${isDark ? 'bg-slate-950' : 'bg-slate-100'}`}>
            <button type="button" onClick={() => setWeatherMode('current')} className={`rounded-lg py-2 text-xs font-semibold ${weatherMode === 'current' ? (isDark ? 'bg-slate-800 text-white' : 'bg-white text-slate-900 shadow-sm') : 'text-slate-500'}`}>Сейчас</button>
            <button type="button" onClick={() => setWeatherMode('planning')} className={`rounded-lg py-2 text-xs font-semibold ${weatherMode === 'planning' ? (isDark ? 'bg-slate-800 text-white' : 'bg-white text-slate-900 shadow-sm') : 'text-slate-500'}`}>Планирование</button>
          </div>
          {weatherMode === 'planning' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs"><span className="block text-slate-500 mb-1">🌡️ °C</span><DecimalInput value={manualTemperature} onChange={setManualTemperature} min={-40} max={50} allowNegative className="w-full" /></label>
                <label className="text-xs"><span className="block text-slate-500 mb-1">💨 м/с</span><DecimalInput value={manualWindSpeed} onChange={setManualWindSpeed} min={0} max={40} className="w-full" /></label>
              </div>
              <div className="flex items-center gap-2"><Navigation className="w-4 h-4 text-slate-400" style={{transform:`rotate(${manualWindDirection}deg)`}} /><span className="text-xs text-slate-500">Ветер</span><DecimalInput value={manualWindDirection} onChange={(v) => setManualWindDirection(((Math.round(v)%360)+360)%360)} min={0} max={359} className="ml-auto w-20 text-right" /><span className="text-xs text-slate-500">°</span></div>
              <div><div className="text-[11px] text-slate-500 mb-1.5">Осадки</div><div className="grid grid-cols-3 gap-1">{([['none','Нет'],['rain','Дождь'],['snow','Снег']] as const).map(([v,label]) => <button key={v} type="button" onClick={() => setManualPrecipitationType(v)} className={`rounded-lg py-2 text-xs font-semibold border ${manualPrecipitationType===v ? 'border-cyan-500 bg-cyan-500/10 text-cyan-500' : (isDark ? 'border-slate-800 text-slate-400' : 'border-slate-200 text-slate-600')}`}>{label}</button>)}</div></div>
              {manualPrecipitationType !== 'none' && (
                <div className="grid grid-cols-3 gap-1">
                  {(['light','moderate','heavy'] as const).map((v) => {
                    const label = v === 'light' ? 'Лёгкая' : v === 'moderate' ? 'Умеренная' : 'Сильная';
                    return (
                      <button key={v} type="button" onClick={() => setManualPrecipitationIntensity(v)}
                        className={`rounded-lg py-2 text-xs font-semibold border ${manualPrecipitationIntensity===v ? 'border-cyan-500 bg-cyan-500/10 text-cyan-500' : (isDark ? 'border-slate-800 text-slate-400' : 'border-slate-200 text-slate-600')}`}>
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </CollapsibleDetails>
        </>
        </motion.div>
      )}

      {calculatorMode === 'manual' && (
        <motion.div
          key="mode-manual"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col gap-3"
        >
        <>
          {/* Hero result */}
          <section
            className={`rounded-2xl border p-4 text-center ${
              isDark ? 'bg-cyan-950/40 border-cyan-800/60' : 'bg-cyan-50 border-cyan-200'
            }`}
          >
            <div className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-cyan-300/80' : 'text-cyan-700'}`}>
              Расход
            </div>
            <div className={`mt-1 text-5xl font-black font-mono tabular-nums ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`}>
              {consumptionPer100Km > 0 ? (
                <AnimatedNumber value={consumptionPer100Km} decimals={1} className={isDark ? 'text-cyan-400' : 'text-cyan-600'} />
              ) : '—'}
              <span className="text-base font-bold ml-1.5 opacity-70">кВт⋅ч/100</span>
            </div>
            <div className={`mt-2 text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              {Math.round(startSoc)}% → {Math.round(endSoc)}% · −{Math.round(socUsedPct)}% · {energyUsedKwh.toFixed(1)} кВт⋅ч
              {distanceKm > 0 ? ` · ${distanceKm} км` : ''}
            </div>
            <div className={`mt-2 inline-flex items-center gap-2 text-[11px] font-semibold px-2.5 py-1 rounded-full border ${rating.bg} ${rating.color}`}>
              {rating.label}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-center">
              <div className={`rounded-xl px-2 py-2 ${isDark ? 'bg-slate-950/70' : 'bg-white/80'}`}>
                <div className={`text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Стоимость</div>
                <div className="text-sm font-black font-mono">{tripCost.toFixed(2)} {settings.currency}</div>
              </div>
              <div className={`rounded-xl px-2 py-2 ${isDark ? 'bg-slate-950/70' : 'bg-white/80'}`}>
                <div className={`text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>На 100 км</div>
                <div className="text-sm font-black font-mono">{costPer100Km.toFixed(2)} {settings.currency}</div>
              </div>
            </div>
          </section>

          {/* Core inputs: end SOC + distance */}
          <section className={`rounded-2xl border p-3 space-y-3 ${isDark ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200 shadow-xs'}`}>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className={`text-xs font-bold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>SOC на финише</span>
                <div className="text-right">
                  <span className={`text-xl font-black font-mono ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`}>{Math.round(endSoc)}%</span>
                </div>
              </div>
              {routeWeather && (
                <div className={`mt-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold ${isDark ? 'bg-slate-950/70 text-slate-300' : 'bg-slate-50 text-slate-600'}`}>
                  <div>
                    Прибытие: {finishArrivalDate?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) ?? '—'}
                    {totalChargingMinutes > 0 ? ` · зарядка ${totalChargingMinutes} мин` : ''}
                  </div>
                  <div className={`mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    Погода на финише: {finishTemperature !== null ? `${finishTemperature >= 0 ? '+' : ''}${Math.round(finishTemperature)}°C` : '—'}
                    {finishPrecipitation > 0.05 ? ' · осадки' : ' · без осадков'}
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => adjustValue(setEndSoc, -5, 0, Math.max(0, startSoc - 1))} className={`w-10 h-9 rounded-lg text-xs font-bold border ${isDark ? 'bg-slate-950 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'}`}>−5</button>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, startSoc - 1)}
                  value={Math.min(endSoc, Math.max(0, startSoc - 1))}
                  onChange={(e) => setEndSoc(Number(e.target.value))}
                  className="flex-1 accent-cyan-500 h-1.5 cursor-pointer"
                  aria-label="SOC на финише"
                />
                <button type="button" onClick={() => adjustValue(setEndSoc, 5, 0, Math.max(0, startSoc - 1))} className={`w-10 h-9 rounded-lg text-xs font-bold border ${isDark ? 'bg-slate-950 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'}`}>+5</button>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className={`text-xs font-bold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Расстояние</span>
                <div className="w-28">
                  <DecimalInput
                    value={distanceKm}
                    onChange={(val) => setDistanceKm(Math.max(0.1, val))}
                    suffix="км"
                    className={`w-full text-right px-2 py-1 rounded-lg text-sm font-bold font-mono focus:outline-none border ${
                      isDark
                        ? 'bg-slate-950 border-slate-700 text-cyan-400'
                        : 'bg-slate-50 border-slate-200 text-cyan-600'
                    }`}
                  />
                </div>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {[
                  { d: -10, l: '−10' },
                  { d: -1, l: '−1' },
                  { d: 1, l: '+1' },
                  { d: 10, l: '+10' },
                ].map(({ d, l }) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => adjustValue(setDistanceKm, d, 1, 1000)}
                    className={`py-1.5 rounded-lg text-xs font-bold border ${
                      isDark ? 'bg-slate-950 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'
                    }`}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className={`text-[11px] font-semibold mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Тип дороги</div>
              <div className="grid grid-cols-3 gap-1.5">
                {([
                  ['city', 'Город'],
                  ['highway', 'Трасса'],
                  ['mixed', 'Смешан.'],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      triggerHaptic('light', settings.hapticFeedback);
                      setRoadType(id);
                    }}
                    className={`py-2 rounded-lg text-xs font-semibold border ${
                      roadType === id
                        ? isDark
                          ? 'bg-cyan-950/70 text-cyan-300 border-cyan-500/60'
                          : 'bg-cyan-600 text-white border-cyan-700'
                        : isDark
                        ? 'bg-slate-950 text-slate-400 border-slate-800'
                        : 'bg-slate-50 text-slate-600 border-slate-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* Secondary: tariff, ICE, range */}
          <CollapsibleDetails
            isDark={isDark}
            label={`Тариф · ${activeTariff} ${settings.currency}/кВт⋅ч`}
            open={manualDetailsOpen}
            onToggle={() => setManualDetailsOpen(v => !v)}
          >
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                {([
                  ['malanka_dc', 'malanka_dc', 'fast_day'],
                  ['evika', 'evika', 'malanka_ac', 'slow_public'],
                  ['zaryadka_day', 'zaryadka_day', 'zaryadka', 'zaryadka_dc'],
                  ['zaryadka_night', 'zaryadka_night'],
                  ['batteryfly', 'batteryfly'],
                  ['home_night', 'home_night', 'fast_night'],
                  ['home', 'home', 'home_day'],
                  ['free', 'free'],
                ] as Array<[TripSession['chargingType'], ...string[]]>).map(([id, ...aliases]) => {
                  const active = aliases.includes(chargingType) || chargingType === id;
                  const label =
                    id === 'home_night' ? 'Дом ночь' :
                    id === 'home' ? 'Дом день' :
                    id === 'free' ? 'Бесплатно' :
                    getOperatorLabel(id, settings.regionPreset);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        triggerHaptic('light', settings.hapticFeedback);
                        setChargingType(id);
                      }}
                      className={`py-2 px-2 rounded-lg text-xs font-semibold border text-left ${
                        active
                          ? isDark
                            ? 'bg-amber-950/50 text-amber-300 border-amber-500/50'
                            : 'bg-amber-50 text-amber-900 border-amber-300'
                          : isDark
                          ? 'bg-slate-950 text-slate-400 border-slate-800'
                          : 'bg-white text-slate-700 border-slate-200'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>

              <div className={`rounded-xl border p-3 text-xs ${isDark ? 'bg-slate-950 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'}`}>
                <div className="flex justify-between gap-2">
                  <span>Экономия vs ДВС</span>
                  <b className="text-cyan-500">+{moneySaved.toFixed(2)} {settings.currency}</b>
                </div>
                <div className={`mt-1 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                  ДВС ≈ {gasCostEquivalent.toFixed(2)} {settings.currency} · {settings.gasEquivalentL100km} л/100 км
                </div>
                {consumptionPer100Km > 0 && (
                  <div className="mt-2 pt-2 border-t border-slate-500/20 flex justify-between gap-2">
                    <span>Запас на текущем SOC</span>
                    <b>{remainingRangeKm.toFixed(0)} км</b>
                  </div>
                )}
              </div>
            </div>
          </CollapsibleDetails>

          <div className="flex flex-col sm:flex-row gap-2">
            <button
              id="save-trip-direct-button"
              type="button"
              onClick={handleQuickSave}
              className="flex-1 py-3.5 px-4 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-sm shadow-sm shadow-cyan-600/20 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
            >
              <Zap className="w-4 h-4 fill-current" />
              Сохранить · {consumptionPer100Km > 0 ? `${consumptionPer100Km.toFixed(1)} кВт⋅ч/100` : '—'}
            </button>
            <button
              id="save-trip-detailed-button"
              type="button"
              onClick={() => {
                triggerHaptic('medium', settings.hapticFeedback);
                onOpenAddModalWithData({
                  startSoc,
                  endSoc,
                  distanceKm,
                  roadType,
                  climateOn,
                  chargingType,
                  passengers,
                });
              }}
              className={`py-3 px-3.5 rounded-xl font-semibold text-xs border active:scale-95 transition-all flex items-center justify-center gap-1.5 ${
                isDark
                  ? 'bg-slate-900 hover:bg-slate-800 text-slate-200 border-slate-800'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-800 border-slate-200'
              }`}
            >
              Подробнее
              <ChevronRight className={`w-3.5 h-3.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`} />
            </button>
          </div>
        </>
        </motion.div>
      )}
      </AnimatePresence>

    </div>
  );
};
