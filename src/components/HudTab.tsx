import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Play,
  Square,
  RotateCcw,
  Gauge,
  FlipHorizontal,
  Thermometer,
  PlusCircle,
  Check,
  AlertTriangle,
  Wind,
  ArrowDown,
  ShieldCheck,
  Activity,
  Sliders,
  Minus,
  Plus,
  Edit3,
  CloudRain,
  CloudSnow,
  CloudDrizzle,
  Droplets,
  Zap,
  Compass,
  TrendingUp,
  TrendingDown,
  Mountain,
  MapPin,
  Navigation,
  Loader2,
  Flag,
  ChevronDown,
  PlugZap,
  X,
  SkipForward,
} from 'lucide-react';
import { UserSettings, TripSession } from '../types';
import {
  estimateTripConsumption,
  estimateSegmentedRouteConsumption,
  calculateClimateImpact,
  calculatePrecipitationImpact,
  computeFlatRoadConsumptionRate,
  ConsumptionForecast,
  loadHudCheckpoint,
  saveHudCheckpoint,
  clearHudCheckpoint,
  type HudTripCheckpoint,
} from '../utils/storage';
import { triggerHaptic } from '../utils/haptics';
import { consumeMatchingRouteForecast } from '../utils/routeForecastBridge';
import { geocodeAddress, buildRouteElevation, type RoutePoint } from '../services/routeElevation';
import { fetchForecastWeatherAt, fetchForecastWeatherAlongRoute } from '../services/weatherForecast';
import { RouteMap } from './RouteMap';
import { findNearbyFreeCcsChargers } from '../services/nearbyFreeCharging';
import { resolveEffectiveConnectors } from '../data/vehicleProfiles';
import { RangeGauge } from './ui/RangeGauge';


interface CollapsibleDetailsProps {
  isDark: boolean;
  open: boolean;
  onToggle: () => void;
  className?: string;
  label: React.ReactNode;
  children: React.ReactNode;
}

const CollapsibleDetails: React.FC<CollapsibleDetailsProps> = ({
  isDark,
  open,
  onToggle,
  className = '',
  label,
  children,
}) => (
  <div className={className}>
    <button
      type="button"
      onClick={onToggle}
      className={`w-full flex items-center justify-between gap-2 rounded-xl border px-2.5 py-1.5 text-left ${
        isDark ? 'bg-slate-900/70 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'
      }`}
    >
      <span className="min-w-0">{label}</span>
      <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && (
      <div className={`mt-1 rounded-xl border px-2.5 py-2 ${
        isDark ? 'bg-slate-950/80 border-slate-800 text-slate-400' : 'bg-white border-slate-200 text-slate-500'
      }`}>
        {children}
      </div>
    )}
  </div>
);

/** One leg of a multi-stop plan transferred from Calculator (charge stops + final B). */
export type HudRouteWaypoint = {
  kind: 'charge' | 'destination';
  name: string;
  /** Distance from trip start along the planned route, km. */
  distanceAlongRouteKm: number;
  lat?: number;
  lon?: number;
  /** Planned SoC when arriving at this point (before charge). */
  plannedArrivalSoc?: number;
  /** Planned SoC after charging (only for kind=charge). */
  chargeTargetSoc?: number;
  connectorLabel?: string;
  /** Optional EVSE metadata for map card (from Calculator). */
  stationId?: string;
  address?: string;
  operator?: string;
  ccs2PowerKw?: number;
  gbtPowerKw?: number;
  type2PowerKw?: number;
};

export type HudRoutePlan = {
  destination: string;
  startSoc: number;
  plannedSpeedKmH?: number;
  /** Full planned distance A→B (with stops on the way). */
  totalDistanceKm?: number;
  /** Calculator result: predicted SoC at destination (after last charge if any). */
  predictedEndSoc?: number;
  /** Calculator result: energy required for the remaining route from A, kWh. */
  energyNeededKwh?: number;
  /** Calculator result: average consumption kWh/100km. */
  predictedConsumption?: number;
  /** Intermediate charge stops + final destination, ordered by distanceAlongRouteKm. */
  waypoints?: HudRouteWaypoint[];
  /** Downsampled route geometry for map visualization in HUD. */
  routePoints?: Array<{ lat: number; lon: number; elevationM?: number; distanceFromStartKm?: number }>;
};

interface HudTabProps {
  settings: UserSettings;
  sessions: TripSession[];
  onSaveToHistory: (tripData: Omit<TripSession, 'id' | 'createdAt'>) => void;
  onOpenAddModalWithData?: (data: Partial<TripSession>) => void;
  onTrackingChange?: (isTracking: boolean) => void;
  /** Plan transferred from Calculator — prefill destination + start SoC */
  hudPlan?: HudRoutePlan | null;
  onHudPlanConsumed?: () => void;
}

interface GpsWeather {
  temperature: number;
  weatherCode: number;
  precipitation?: number; // mm
  windSpeed: number; // km/h
  windDirection: number; // 0-360 degrees
  city?: string;
  isLoaded: boolean;
}

// Max plausible speed for Dongfeng Vigo (km/h) to filter out GPS glitches (e.g. 5000 km/h)
const MAX_VALID_SPEED_KMH = 160;
// Maximum GPS accuracy error radius in meters to accept for distance tracking
const MAX_ACCURACY_THRESHOLD_M = 45;
// Maximum vertical (altitude) accuracy error in meters to accept an altitude sample. Phone GPS
// altitude is typically 2-3x noisier than horizontal position, especially at speed/under
// overpasses, so this is intentionally looser than MAX_ACCURACY_THRESHOLD_M but still rejects
// clearly unreliable fixes. Samples with no altitudeAccuracy reported (common on some browsers)
// fall through to the noise-threshold and grade-plausibility checks instead.
const ALT_ACCURACY_THRESHOLD_M = 20;
// Minimum smoothed-altitude change (m) before counting it as real elevation gain/loss. Raised
// from an earlier 2m to be more tolerant of residual GPS noise after smoothing.
const ALT_NOISE_THRESHOLD_M = 4;
// Steepest road grade treated as physically plausible (15% covers essentially any real road in
// Belarus). A counted delta implying a steeper grade over the distance actually driven since the
// last checkpoint is almost always GPS altitude noise, not real elevation change.
const MAX_PLAUSIBLE_GRADE = 0.15;
// A GPS altitude fix can jump several metres for a few seconds even when its reported
// vertical accuracy looks acceptable. Never turn such a short-lived disturbance directly
// into battery energy. Elevation must persist over distance before it is committed.
const MIN_ELEVATION_COMMIT_DISTANCE_KM = 0.25;
const MIN_ELEVATION_COMMIT_DELTA_M = 5;
const ELEVATION_CONFIRMATION_SAMPLES = 3;
const MAX_ELEVATION_DELTA_PER_COMMIT_M = 30;

export const HudTab: React.FC<HudTabProps> = ({
  settings,
  sessions,
  onSaveToHistory,
  onTrackingChange,
  hudPlan,
  onHudPlanConsumed,
}) => {
  // Tracking state
  const [isTracking, setIsTracking] = useState(false);
  // Offer to resume a trip that survived a WebView kill / page reload.
  const [pendingCheckpoint, setPendingCheckpoint] = useState<HudTripCheckpoint | null>(() =>
    loadHudCheckpoint(),
  );
  // Two-tap safety for the destructive controls (СТОП / СБРОС): the first tap "arms" the button for
  // a few seconds, the second tap performs the action. Prevents accidental taps while driving.
  const [armedAction, setArmedAction] = useState<'stop' | 'reset' | null>(null);
  const armTimerRef = useRef<number | null>(null);
  const [tripStartTime, setTripStartTime] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Speed and GPS metrics
  const [currentSpeed, setCurrentSpeed] = useState(0); // km/h
  const [maxSpeed, setMaxSpeed] = useState(0); // km/h
  const [tripDistanceKm, setTripDistanceKm] = useState(0); // km
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [gpsHeading, setGpsHeading] = useState<number | null>(null); // 0-359 degrees
  const [gpsError, setGpsError] = useState<string | null>(null);

  // HUD display modes
  const [isMirrored, setIsMirrored] = useState(false);

  // Dynamic SoC State
  // User sets initial SoC at start of trip (e.g. 80%), and it dynamically decreases during the trip
  const [startTripSoc, setStartTripSoc] = useState<number>(80);
  const [climateOn, setClimateOn] = useState(true);
  const [passengers, setPassengers] = useState(1);
  const [wakeLockActive, setWakeLockActive] = useState(false);

  // Live elevation gain/loss accumulated during the current tracked trip (meters)
  const [elevationGainM, setElevationGainM] = useState(0);
  const [elevationLossM, setElevationLossM] = useState(0);
  const [altitudeAvailable, setAltitudeAvailable] = useState(false);

  // SoC-at-Destination forecast tool
  const [destinationMode, setDestinationMode] = useState<'address' | 'distance'>('address');
  const [destinationQuery, setDestinationQuery] = useState('');
  const [manualAvgSpeedKmH, setManualAvgSpeedKmH] = useState(60);
  const [destinationBusy, setDestinationBusy] = useState(false);
  const [destinationError, setDestinationError] = useState<string | null>(null);
  const [destinationBreakdownOpen, setDestinationBreakdownOpen] = useState(false);
  const [factorsOpen, setFactorsOpen] = useState(false);
  const [destinationResult, setDestinationResult] = useState<{
    name: string;
    distanceKm: number;
    gainM: number;
    lossM: number;
    predictedConsumption: number;
    energyNeededKwh: number;
    predictedSoc: number;
    etaMinutes?: number;
    approximate: boolean;
    arrivalTimeLabel?: string;
    forecastUsed: boolean;
    forecastTemperature?: number;
    forecastWindSpeed?: number;
    forecastPrecipLabel?: string;
    windImpactPct?: number;
    precipitationImpactPct?: number;
    temperatureImpactPct?: number;
    climatePowerKw?: number;
    elevationImpactPct?: number;
    elevationDeltaKwh100?: number;
    regenEnergyKwh?: number;
    climateEnergyKwh?: number;
    speedImpactPct?: number;
    driverStyleFactor?: number;
    breakdown?: any;
  } | null>(null);

  /** Multi-stop plan from Calculator: charge legs + final B. */
  const [routeWaypoints, setRouteWaypoints] = useState<HudRouteWaypoint[]>([]);
  /** EVSE card opened by tapping a charge marker on the HUD map */
  const [selectedMapStop, setSelectedMapStop] = useState<HudRouteWaypoint | null>(null);
  const [mapStopLive, setMapStopLive] = useState<{
    loading: boolean;
    freeCcs: number;
    totalCcs: number;
    freeGbt?: number;
    totalGbt?: number;
    matchedConnector?: string;
    error?: string;
  } | null>(null);
  const [routeTotalDistanceKm, setRouteTotalDistanceKm] = useState<number | null>(null);
  /** Index of the next waypoint the live SoC is aimed at. */
  const [activeWaypointIndex, setActiveWaypointIndex] = useState(0);
  /** Route geometry from Calculator for map in HUD. */
  const [hudRoutePoints, setHudRoutePoints] = useState<RoutePoint[]>([]);
  /** Collapsed by default so the phone HUD keeps STOP visible; user expands when needed. */
  const [hudMapOpen, setHudMapOpen] = useState(false);
  /** Live GPS for map marker (updated while tracking) — EMA-smoothed. */
  const [mapLivePosition, setMapLivePosition] = useState<{ lat: number; lon: number } | null>(null);
  const lastMapPosUpdateRef = useRef(0);
  const smoothMapPosRef = useRef<{ lat: number; lon: number } | null>(null);
  /** Display-smoothed remaining range so the HUD number does not jump every tick. */
  const [displayRangeKm, setDisplayRangeKm] = useState(0);
  const [isLandscape, setIsLandscape] = useState(false);

  // Weather data fetched via GPS coordinates
  const [weather, setWeather] = useState<GpsWeather>({
    temperature: 20,
    weatherCode: 0,
    precipitation: 0,
    windSpeed: 0,
    windDirection: 0,
    isLoaded: false,
  });

  // Stopped Trip Summary Modal
  const [completedTripSummary, setCompletedTripSummary] = useState<{
    distanceKm: number;
    avgSpeedKmH: number;
    maxSpeedKmH: number;
    durationMinutes: number;
    estimatedCons: number;
    temp: number;
    windStatus?: string;
    precipitationStatus?: string;
    roadSurface?: string;
    startSoc: number;
    endSoc: number;
    energyUsedKwh: number;
    styleFactor?: number;
    styleLabel?: string;
    // Exact energySpentKwh breakdown at the moment tracking stopped — logged so the three
    // components can be checked directly against the saved total instead of reconstructed
    // afterward from the 1km-interval hudWindLog (which necessarily lags by up to 1km/a few
    // GPS ticks and can't fully account for the very last partial segment before stopping).
    segmentEnergyKwhAtStop?: number;
    elevationEnergyKwhAtStop?: number;
    climateEnergyKwhAtStop?: number;
    // Raw climatePowerKw (kW) that fed climateEnergyKwhAtStop, logged directly rather than
    // inferred from climateEnergyKwhAtStop/elapsedHours — at 22°C, calculateClimateImpact's
    // comfort-zone branch should return exactly 0.40 kW; if this logs something much higher
    // (implying the model is treating the trip as if it were deep in the cold-weather branch),
    // that pinpoints the bug directly instead of it being inferred indirectly after the fact.
    climatePowerKwAtStop?: number;
  } | null>(null);
  const [trackingStopMessage, setTrackingStopMessage] = useState('');

  const watchIdRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const prevPositionRef = useRef<{ lat: number; lon: number; time: number; speed: number } | null>(null);
  const speedHistoryRef = useRef<number[]>([]);
  const distanceRef = useRef<number>(0);
  const smoothSpeedBufferRef = useRef<number[]>([]);
  const lastHeadingRef = useRef<number>(0);
  /** Rolling GPS track bearings — median-smoothed before publishing to the map. */
  const bearingHistoryRef = useRef<number[]>([]);
  // Last values pushed to React state from the GPS callback. Algorithms still write full-precision
  // data into the refs above on every tick; these mirrors only avoid redundant setState when the
  // UI-visible number did not change (or heading jitter is below a small threshold).
  const uiGpsPublishedRef = useRef<{
    speed: number;
    accuracy: number | null;
    heading: number | null;
    distanceKm: number;
    segmentEnergyKwh: number;
    altitudeAvailable: boolean;
    elevationGainM: number;
    elevationLossM: number;
    maxSpeed: number;
  }>({
    speed: 0,
    accuracy: null,
    heading: null,
    distanceKm: 0,
    segmentEnergyKwh: 0,
    altitudeAvailable: false,
    elevationGainM: 0,
    elevationLossM: 0,
    maxSpeed: 0,
  });
  const smoothedAltitudeRef = useRef<number | null>(null);
  const lastCountedAltitudeRef = useRef<number | null>(null);
  const lastCountedAltitudeDistanceKmRef = useRef(0);
  const elevationTrendDirectionRef = useRef<1 | -1 | 0>(0);
  const elevationTrendSamplesRef = useRef(0);
  const previousSmoothedAltitudeRef = useRef<number | null>(null);
  const elevationGainRef = useRef(0);
  const elevationLossRef = useRef(0);
  // Elevation energy accumulated incrementally, in kWh, at the vehicle mass that applied at the
  // moment each metre was actually gained/lost — see the ELEVATION TRACKING block below. This
  // replaces recomputing net elevation kWh from aggregate gainM/lossM at the CURRENT passenger
  // count on every render, which retroactively re-priced the whole trip's climb/descent history
  // whenever passengers changed mid-trip.
  const elevationEnergyKwhRef = useRef(0);
  // Climate energy accumulated incrementally, once per second, at whatever climateOn/outdoor
  // temperature was in effect at that second — see the 1Hz timer below. Replaces computing
  // climatePowerKw × total-elapsed-time on every render, which (like the old elevation
  // aggregate-recompute bug) re-prices the WHOLE trip's climate at the CURRENT toggle state:
  // switching climate off for the last few km would have silently zeroed out climate energy for
  // the entire trip, not just the remainder.
  const climateEnergyKwhRef = useRef(0);
  // Compact trail of wind/energy checkpoints sampled roughly every WIND_LOG_INTERVAL_KM, kept
  // for later diagnosis. Captured live during tracking, independent of any later manual SoC
  // correction (handleUpdateSessionEndSoc only rewrites endSoc/energyUsedKwh/consumptionPer100Km,
  // never this log), so it preserves what the model actually saw at each point along the route.
  const windLogRef = useRef<Array<{
    d: number; // distanceKm
    v: number; // speedKmH
    w: number; // windSpeedKmH
    a: number; // relativeWindAngleDeg (0=headwind, 180=tailwind)
    m: number; // windMultiplier applied to that segment
    e: number; // cumulative segment-accumulated energyKwh at this point
    g: number; // cumulative elevationGainM
    l: number; // cumulative elevationLossM
    ee: number; // cumulative elevationEnergyKwh (mass-aware, incremental)
    alt: number | null; // smoothed altitude reading (m), for eyeballing raw trend/noise
    aa: number | null; // latest raw altitudeAccuracy (m) seen from GPS, whether or not it passed the gate
  }>>([]);
  const lastWindLogDistanceKmRef = useRef(0);
  // Latest raw altitudeAccuracy seen from the GPS, regardless of whether it passed the
  // ALT_ACCURACY_THRESHOLD_M gate — logged alongside wind checkpoints purely to find out what
  // values this device/browser actually reports (some browsers never report it at all).
  const lastAltitudeAccuracyRef = useRef<number | null>(null);

  // Latest GPS state used by the low-frequency weather refresh while tracking.
  const latestGpsPositionRef = useRef<{ lat: number; lon: number } | null>(null);
  const latestGpsSpeedRef = useRef(0);
  const weatherRefreshInFlightRef = useRef(false);
  const lastWeatherFetchAtRef = useRef(0);

  // Cached destination geo so live recalculations during tracking don't re-geocode every time.
  const cachedDestRef = useRef<{ lat: number; lon: number; name: string } | null>(null);
  // Throttling for automatic live SoC-at-destination recalculation while tracking.
  const lastDestRecalcAtRef = useRef(0);
  const lastDestRecalcDistanceRef = useRef(0);
  const destRecalcInFlightRef = useRef(false);

  // Live per-segment energy accumulation. Instead of applying the trip's average speed to the
  // whole distance (which under-costs a route that mixes city and highway driving, since the
  // speed→consumption curve is convex), every accepted GPS segment below adds its own distance
  // × consumption-at-that-segment's-actual-speed to this running total. See computeFlatRoadConsumptionRate.
  const segmentEnergyKwhRef = useRef(0);
  const [liveSegmentEnergyKwh, setLiveSegmentEnergyKwh] = useState(0);

  // Mirrors of render-scope values the geolocation watchPosition callback needs to read at
  // call-time without forcing the GPS watch to be torn down and resubscribed on every change.
  const weatherRef = useRef(weather);
  const relativeWindAngleRef = useRef(0);
  const passengersRef = useRef(passengers);
  // Same reasoning, for the climate toggle and outdoor temp: the 1Hz timer below (not the GPS
  // callback) needs the current value at call-time so tapping the climate on/off button
  // mid-trip only changes energy accrual from that second forward.
  const climateOnRef = useRef(climateOn);
  const outdoorTempRef = useRef(20);

  const isDark = settings.theme !== 'light';
  const batteryCap = settings.batteryCapacityKwh || 51.87;

  // Notify parent of tracking status
  useEffect(() => {
    onTrackingChange?.(isTracking);
  }, [isTracking, onTrackingChange]);

  // Apply plan transferred from Calculator (destination + start SoC + optional multi-stop plan)
  useEffect(() => {
    if (!hudPlan) return;
    if (hudPlan.destination?.trim()) {
      setDestinationQuery(hudPlan.destination.trim());
      setDestinationMode('address');
      cachedDestRef.current = null; // force re-geocode for the new address
    }
    if (typeof hudPlan.startSoc === 'number' && hudPlan.startSoc > 0) {
      setStartTripSoc(Math.min(100, Math.max(1, Math.round(hudPlan.startSoc))));
    }
    if (typeof hudPlan.plannedSpeedKmH === 'number' && hudPlan.plannedSpeedKmH > 0) {
      setManualAvgSpeedKmH(Math.min(150, Math.max(5, Math.round(hudPlan.plannedSpeedKmH))));
    }
    if (Array.isArray(hudPlan.waypoints) && hudPlan.waypoints.length > 0) {
      const sorted = [...hudPlan.waypoints].sort(
        (a, b) => a.distanceAlongRouteKm - b.distanceAlongRouteKm,
      );
      setRouteWaypoints(sorted);
      setActiveWaypointIndex(0);
    } else {
      setRouteWaypoints([]);
      setActiveWaypointIndex(0);
    }
    if (typeof hudPlan.totalDistanceKm === 'number' && hudPlan.totalDistanceKm > 0) {
      setRouteTotalDistanceKm(hudPlan.totalDistanceKm);
      const startSocSeed = Math.min(
        100,
        Math.max(1, Math.round(hudPlan.startSoc || startTripSoc)),
      );
      // Prefer calculator end-SoC. Fallback: last waypoint plannedArrivalSoc / chargeTargetSoc.
      let endSocSeed: number | null =
        typeof hudPlan.predictedEndSoc === 'number' && Number.isFinite(hudPlan.predictedEndSoc)
          ? Math.max(0, Math.min(100, Math.round(hudPlan.predictedEndSoc)))
          : null;
      if (endSocSeed == null && Array.isArray(hudPlan.waypoints) && hudPlan.waypoints.length) {
        const destWp = [...hudPlan.waypoints]
          .filter((w) => w.kind === 'destination')
          .sort((a, b) => b.distanceAlongRouteKm - a.distanceAlongRouteKm)[0]
          || hudPlan.waypoints[hudPlan.waypoints.length - 1];
        if (typeof destWp.plannedArrivalSoc === 'number') {
          endSocSeed = Math.max(0, Math.min(100, Math.round(destWp.plannedArrivalSoc)));
        }
      }
      const energySeed =
        typeof hudPlan.energyNeededKwh === 'number' && hudPlan.energyNeededKwh > 0
          ? hudPlan.energyNeededKwh
          : endSocSeed != null
            ? Math.max(0, ((startSocSeed - endSocSeed) / 100) * (settings.batteryCapacityKwh || 60))
            : 0;
      const predictedSocSeed =
        endSocSeed != null
          ? endSocSeed
          : energySeed > 0
            ? Math.max(0, Math.round(startSocSeed - (energySeed / (settings.batteryCapacityKwh || 60)) * 100))
            : startSocSeed;

      // Always seed from calculator plan (do not keep previous trip's energyNeededKwh: 0).
      setDestinationResult({
        name: (hudPlan.destination || 'Назначение').trim(),
        distanceKm: Number(hudPlan.totalDistanceKm!.toFixed(1)),
        gainM: 0,
        lossM: 0,
        predictedConsumption:
          typeof hudPlan.predictedConsumption === 'number'
            ? hudPlan.predictedConsumption
            : 0,
        energyNeededKwh: Number(energySeed.toFixed(2)),
        predictedSoc: predictedSocSeed,
        approximate: true,
        forecastUsed: false,
      });
    } else {
      setRouteTotalDistanceKm(null);
    }
    if (Array.isArray(hudPlan.routePoints) && hudPlan.routePoints.length >= 2) {
      setHudRoutePoints(
        hudPlan.routePoints.map((p, i) => ({
          lat: p.lat,
          lon: p.lon,
          elevationM: p.elevationM ?? 0,
          distanceFromStartKm: p.distanceFromStartKm ?? i,
        })),
      );
      // Show map in pre-start (map-first HUD).
      setHudMapOpen(true);
    } else {
      setHudRoutePoints([]);
    }
    onHudPlanConsumed?.();
  }, [hudPlan, onHudPlanConsumed, settings.batteryCapacityKwh, startTripSoc]);

  // Keep weatherRef in sync so the geolocation callback (subscribed once per trip) always reads
  // the latest fetched weather without needing to resubscribe watchPosition.
  useEffect(() => {
    weatherRef.current = weather;
  }, [weather]);

  // Same reasoning for passenger count: read at call-time so adding passengers mid-trip only
  // affects elevation energy accrued from that point forward (see elevationEnergyKwhRef below),
  // instead of retroactively re-costing the whole trip's already-accumulated climb/descent at
  // the new mass, which previously showed up as a sudden multi-percent SoC jump the moment
  // passengers changed.
  useEffect(() => {
    passengersRef.current = passengers;
  }, [passengers]);

  // Haversine distance formula between two GPS coordinates (in km)
  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371; // Earth radius in km
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  // Calculate bearing from coordinate A to coordinate B (0 - 359°)
  const calculateBearing = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ = Math.atan2(y, x);
    return Math.round(((θ * 180) / Math.PI + 360) % 360);
  };

  // === 1. ULTRA-ROBUST IPHONE / SAFARI SCREEN WAKE LOCK ===
  const requestWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator) {
        if (!wakeLockRef.current || wakeLockRef.current.released) {
          wakeLockRef.current = await navigator.wakeLock.request('screen');
          setWakeLockActive(true);
          wakeLockRef.current.addEventListener('release', () => {
            setWakeLockActive(false);
          });
        }
      }
    } catch {
      setWakeLockActive(false);
    }
  }, []);

  // Re-acquire Wake Lock whenever tab becomes visible or tracking starts
  useEffect(() => {
    requestWakeLock();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };

    const handleUserInteraction = () => {
      if (!wakeLockRef.current || wakeLockRef.current.released) {
        requestWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleVisibilityChange);
    window.addEventListener('touchstart', handleUserInteraction, { passive: true });
    window.addEventListener('click', handleUserInteraction, { passive: true });

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleVisibilityChange);
      window.removeEventListener('touchstart', handleUserInteraction);
      window.removeEventListener('click', handleUserInteraction);
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    };
  }, [requestWakeLock]);

  // Keep screen awake whenever tracking is enabled
  useEffect(() => {
    if (isTracking) {
      requestWakeLock();
    }
  }, [isTracking, requestWakeLock]);

  // Timer interval when tracking is active
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (isTracking && tripStartTime) {
      interval = setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - tripStartTime) / 1000));
        // Accrue climate energy for exactly this one second, at the climate on/off state and
        // outdoor temperature in effect right now — see climateEnergyKwhRef above.
        const currentClimatePowerKw = calculateClimateImpact(outdoorTempRef.current, climateOnRef.current).powerKw;
        climateEnergyKwhRef.current += currentClimatePowerKw / 3600;
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isTracking, tripStartTime]);

  // Fetch real-time weather & wind & precipitation from Open-Meteo.
  // During tracking this is intentionally called at a low frequency (15 min), not per GPS tick.
  const fetchGpsWeather = async (lat: number, lon: number) => {
    if (weatherRefreshInFlightRef.current) return false;
    weatherRefreshInFlightRef.current = true;
    try {
      const res = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation,rain,showers,snowfall`
      );
      if (res.ok) {
        const data = await res.json();
        if (data.current) {
          const precipValue = Number(
            (data.current.precipitation ?? data.current.rain ?? data.current.snowfall ?? 0).toFixed(1)
          );
          setWeather({
            temperature: Math.round(data.current.temperature_2m),
            weatherCode: data.current.weather_code ?? 0,
            precipitation: precipValue,
            windSpeed: Math.round(data.current.wind_speed_10m),
            windDirection: Math.round(data.current.wind_direction_10m ?? 0),
            isLoaded: true,
          });
          lastWeatherFetchAtRef.current = Date.now();
          return true;
        }
      }
    } catch {
      // Keep existing state on transient network error.
    } finally {
      weatherRefreshInFlightRef.current = false;
    }
    return false;
  };

  // Geolocation watchPosition listener with glitch filters
  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsError('GPS не поддерживается вашим браузером');
      return;
    }

    const handleSuccess = (pos: GeolocationPosition) => {
      setGpsError(null);
      const { latitude, longitude, speed, accuracy, heading } = pos.coords;
      const now = Date.now();
      latestGpsPositionRef.current = { lat: latitude, lon: longitude };
      // EMA-smoothed map marker — reduces GPS jumpiness on the HUD map.
      {
        const prev = smoothMapPosRef.current;
        const alpha = prev ? 0.28 : 1;
        const smoothed = {
          lat: prev ? prev.lat * (1 - alpha) + latitude * alpha : latitude,
          lon: prev ? prev.lon * (1 - alpha) + longitude * alpha : longitude,
        };
        smoothMapPosRef.current = smoothed;
        // ~4 Hz map feed — RouteMap continuously lerps marker toward this target.
        if (now - lastMapPosUpdateRef.current > 250) {
          lastMapPosUpdateRef.current = now;
          setMapLivePosition(smoothed);
        }
      }

      const accMeters = accuracy ? Math.round(accuracy) : null;
      // UI only: skip setState when accuracy meter reading is unchanged.
      if (accMeters !== uiGpsPublishedRef.current.accuracy) {
        uiGpsPublishedRef.current.accuracy = accMeters;
        setGpsAccuracy(accMeters);
      }

      // Fetch weather on the first reliable GPS lock.
      if (!weatherRef.current.isLoaded) {
        fetchGpsWeather(latitude, longitude);
      }

      // === 3. SANITY FILTERING OF GPS GLITCHES / SPIKES (e.g. 5000 km/h) ===
      let rawSpeedKmh = 0;
      let isPlausibleReading = true;

      if (speed !== null && !isNaN(speed) && speed >= 0) {
        rawSpeedKmh = speed * 3.6; // convert m/s to km/h
      } else if (prevPositionRef.current) {
        const timeDeltaHours = (now - prevPositionRef.current.time) / (1000 * 3600);
        const distDeltaKm = calculateDistance(
          prevPositionRef.current.lat,
          prevPositionRef.current.lon,
          latitude,
          longitude
        );

        if (timeDeltaHours > 0.0001) {
          rawSpeedKmh = distDeltaKm / timeDeltaHours;
        }
      }

      if (rawSpeedKmh > MAX_VALID_SPEED_KMH) {
        isPlausibleReading = false;
        rawSpeedKmh = prevPositionRef.current?.speed ?? 0;
      }

      if (rawSpeedKmh < 3) {
        rawSpeedKmh = 0;
      }

      smoothSpeedBufferRef.current.push(rawSpeedKmh);
      if (smoothSpeedBufferRef.current.length > 3) {
        smoothSpeedBufferRef.current.shift();
      }
      const smoothedSpeed = Math.round(
        smoothSpeedBufferRef.current.reduce((a, b) => a + b, 0) / smoothSpeedBufferRef.current.length
      );

      // Ref always tracks live speed for weather/recalc paths; state only when the shown integer changes.
      latestGpsSpeedRef.current = smoothedSpeed;
      if (smoothedSpeed !== uiGpsPublishedRef.current.speed) {
        uiGpsPublishedRef.current.speed = smoothedSpeed;
        setCurrentSpeed(smoothedSpeed);
      }

      // Course for map/UI: GPS track bearing with short median filter (kills turn jitter).
      // Hold last heading when nearly stopped — do not republish every tick.
      const publishHeadingUi = (nextHeading: number) => {
        const rounded = Math.round(nextHeading);
        lastHeadingRef.current = rounded;
        const prevUi = uiGpsPublishedRef.current.heading;
        if (prevUi == null) {
          uiGpsPublishedRef.current.heading = rounded;
          setGpsHeading(rounded);
          return;
        }
        const delta = Math.abs(((rounded - prevUi + 540) % 360) - 180);
        // Publish often enough for smooth chase, but skip sub-degree noise.
        if (delta >= 3) {
          uiGpsPublishedRef.current.heading = rounded;
          setGpsHeading(rounded);
        }
      };

      // Heading only when clearly moving — standing GPS wander must not spin the map.
      if (prevPositionRef.current && smoothedSpeed >= 12) {
        const distKm = calculateDistance(
          prevPositionRef.current.lat,
          prevPositionRef.current.lon,
          latitude,
          longitude
        );
        // Require ~8 m of travel between samples so noise cannot invent a bearing.
        if (distKm >= 0.008) {
          const bearing = calculateBearing(
            prevPositionRef.current.lat,
            prevPositionRef.current.lon,
            latitude,
            longitude
          );
          const hist = bearingHistoryRef.current;
          hist.push(bearing);
          if (hist.length > 5) hist.shift();
          let sinSum = 0;
          let cosSum = 0;
          for (const b of hist) {
            const r = (b * Math.PI) / 180;
            sinSum += Math.sin(r);
            cosSum += Math.cos(r);
          }
          const avg =
            hist.length > 0
              ? ((Math.atan2(sinSum / hist.length, cosSum / hist.length) * 180) / Math.PI + 360) % 360
              : bearing;
          publishHeadingUi(avg);
        }
      } else if (smoothedSpeed < 8) {
        bearingHistoryRef.current = [];
      }

      // === ACCUMULATE TRIP DISTANCE (with strict glitch checks) ===
      if (isTracking && prevPositionRef.current && isPlausibleReading) {
        const timeDeltaSec = (now - prevPositionRef.current.time) / 1000;
        const deltaKm = calculateDistance(
          prevPositionRef.current.lat,
          prevPositionRef.current.lon,
          latitude,
          longitude
        );

        const maxPlausibleDeltaKm = (MAX_VALID_SPEED_KMH / 3600) * Math.max(1, timeDeltaSec) * 1.3;

        if (
          (!accMeters || accMeters <= MAX_ACCURACY_THRESHOLD_M) &&
          deltaKm > 0.002 &&
          deltaKm <= maxPlausibleDeltaKm
        ) {
          distanceRef.current += deltaKm;
          // Full precision stays in distanceRef; UI shows the same 0.01 km resolution as before.
          const distanceUi = Number(distanceRef.current.toFixed(2));
          if (distanceUi !== uiGpsPublishedRef.current.distanceKm) {
            uiGpsPublishedRef.current.distanceKm = distanceUi;
            setTripDistanceKm(distanceUi);
          }

          // Per-segment energy: rate at THIS segment's own speed (not the trip average), so a
          // short fast burst costs proportionally more than the same distance at a cruising
          // pace, matching the convex (aero-drag) shape of the speed/consumption curve.
          //
          // NOTE: styleFactorRef is intentionally NOT applied here. currentTripStyle's burst
          // (max/avg speed) and high-speed-time-share terms react to exactly the same signal
          // that this per-segment evaluation already prices in physically (e.g. a single
          // 100->110 km/h overtake costs more only for the distance/time actually spent at
          // that speed, via the convex part of the curve). Multiplying the *whole trip's*
          // accumulated energy by a factor derived from one short burst double-counts that
          // burst and smears its cost across every km of the trip, not just the burst itself.
          // The style factor is still computed, shown in the UI badge, and saved on the
          // session — it's the right (and only) correction for estimateTripConsumption's
          // single-average-speed evaluation (Calculator tab, SoC-at-destination forecast),
          // which has no per-segment data and would otherwise miss burst driving entirely.
          const segRate = computeFlatRoadConsumptionRate(
            smoothedSpeed,
            weatherRef.current.isLoaded ? weatherRef.current.temperature : undefined,
            weatherRef.current.isLoaded ? weatherRef.current.windSpeed : undefined,
            relativeWindAngleRef.current,
            weatherRef.current.isLoaded ? weatherRef.current.weatherCode : undefined,
            weatherRef.current.isLoaded ? weatherRef.current.precipitation : undefined
          );
          const segConsumptionPer100 =
            segRate.baseSpeedConsumption *
            segRate.tempMultiplier *
            segRate.windMultiplier *
            segRate.precipMultiplier;
          segmentEnergyKwhRef.current += (deltaKm / 100) * segConsumptionPer100;
          const segmentEnergyUi = Number(segmentEnergyKwhRef.current.toFixed(3));
          if (segmentEnergyUi !== uiGpsPublishedRef.current.segmentEnergyKwh) {
            uiGpsPublishedRef.current.segmentEnergyKwh = segmentEnergyUi;
            setLiveSegmentEnergyKwh(segmentEnergyUi);
          }

          // Sample a compact checkpoint roughly every 1 km so wind/energy/elevation behaviour
          // along the route can be audited after the fact, instead of relying on what was
          // glanced at on screen mid-drive or inferred backwards from the final totals.
          // Elevation/accuracy fields read from refs updated by the ELEVATION TRACKING block
          // below, so they reflect the most recent tick that block ran on (negligible lag at
          // 1km sampling granularity).
          const WIND_LOG_INTERVAL_KM = 1;
          if (distanceRef.current - lastWindLogDistanceKmRef.current >= WIND_LOG_INTERVAL_KM) {
            lastWindLogDistanceKmRef.current = distanceRef.current;
            windLogRef.current.push({
              d: Number(distanceRef.current.toFixed(1)),
              v: Math.round(smoothedSpeed),
              w: weatherRef.current.isLoaded ? Math.round(weatherRef.current.windSpeed) : 0,
              a: Math.round(relativeWindAngleRef.current),
              m: Number(segRate.windMultiplier.toFixed(3)),
              e: Number(segmentEnergyKwhRef.current.toFixed(2)),
              g: Math.round(elevationGainRef.current),
              l: Math.round(elevationLossRef.current),
              ee: Number(elevationEnergyKwhRef.current.toFixed(2)),
              alt: smoothedAltitudeRef.current !== null ? Math.round(smoothedAltitudeRef.current) : null,
              aa: lastAltitudeAccuracyRef.current !== null && lastAltitudeAccuracyRef.current !== undefined
                ? Math.round(lastAltitudeAccuracyRef.current)
                : null,
            });
            // Defensive cap — a very long trip shouldn't grow this unboundedly.
            if (windLogRef.current.length > 400) windLogRef.current.shift();
          }

          if (smoothedSpeed > 0) {
            speedHistoryRef.current.push(smoothedSpeed);
          }
          if (smoothedSpeed > uiGpsPublishedRef.current.maxSpeed) {
            uiGpsPublishedRef.current.maxSpeed = smoothedSpeed;
            setMaxSpeed(smoothedSpeed);
          }
        }
      }

      // === ELEVATION TRACKING (Рельеф и рекуперация) ===
      // Device altitude is often noisy (±5-10m, worse without a barometric assist), so a change
      // is only counted once it (a) has an acceptable vertical accuracy, (b) clears a noise
      // threshold after EMA smoothing, and (c) implies a physically plausible road grade for the
      // distance actually driven since the last counted checkpoint (checked here, after distance
      // accumulation above, so distanceRef.current already reflects this tick).
      //
      // (c) matters because climb energy is divided by DRIVETRAIN_EFFICIENCY (0.90) while
      // descent is credited back at only REGEN_EFFICIENCY (0.65) in estimateTripConsumption —
      // so pure altitude noise (equal spurious gain and loss) has a net *cost* rather than
      // cancelling out, and gets worse at higher speed / weaker vertical GPS fix (e.g. highway).
      const rawAltitude = pos.coords.altitude;
      const rawAltitudeAccuracy = pos.coords.altitudeAccuracy;
      lastAltitudeAccuracyRef.current = rawAltitudeAccuracy;
      const altitudeAccuracyOk = rawAltitudeAccuracy == null || rawAltitudeAccuracy <= ALT_ACCURACY_THRESHOLD_M;

      if (isTracking && rawAltitude !== null && !isNaN(rawAltitude)) {
        if (!uiGpsPublishedRef.current.altitudeAvailable) {
          uiGpsPublishedRef.current.altitudeAvailable = true;
          setAltitudeAvailable(true);
        }

        if (altitudeAccuracyOk) {
          if (smoothedAltitudeRef.current === null) {
            smoothedAltitudeRef.current = rawAltitude;
            lastCountedAltitudeRef.current = rawAltitude;
            lastCountedAltitudeDistanceKmRef.current = distanceRef.current;
          } else {
            smoothedAltitudeRef.current = smoothedAltitudeRef.current * 0.7 + rawAltitude * 0.3;
            const previousSmoothedAltitude = previousSmoothedAltitudeRef.current;
            const countedDelta = smoothedAltitudeRef.current - (lastCountedAltitudeRef.current ?? smoothedAltitudeRef.current);
            const sampleDelta = previousSmoothedAltitude === null
              ? 0
              : smoothedAltitudeRef.current - previousSmoothedAltitude;
            previousSmoothedAltitudeRef.current = smoothedAltitudeRef.current;

            if (Math.abs(countedDelta) >= ALT_NOISE_THRESHOLD_M) {
              const distanceSinceCheckpointKm = distanceRef.current - lastCountedAltitudeDistanceKmRef.current;
              const direction: 1 | -1 = countedDelta > 0 ? 1 : -1;
              const sampleDirection: 1 | -1 | 0 = Math.abs(sampleDelta) >= 0.5 ? (sampleDelta > 0 ? 1 : -1) : 0;

              // Never confirm an elevation change merely because the smoothed altitude jumped
              // once and then stayed at the new (possibly wrong) GPS level. The individual
              // smoothed samples must continue moving in the same direction as the candidate.
              if (sampleDirection === direction) {
                if (elevationTrendDirectionRef.current === direction) {
                  elevationTrendSamplesRef.current += 1;
                } else {
                  elevationTrendDirectionRef.current = direction;
                  elevationTrendSamplesRef.current = 1;
                }
              } else if (sampleDirection !== 0) {
                elevationTrendDirectionRef.current = 0;
                elevationTrendSamplesRef.current = 0;
              }

              const impliedGrade = distanceSinceCheckpointKm > 0
                ? Math.abs(countedDelta) / (distanceSinceCheckpointKm * 1000)
                : Infinity;

              const enoughDistance = distanceSinceCheckpointKm >= MIN_ELEVATION_COMMIT_DISTANCE_KM;
              const enoughConfirmation = elevationTrendSamplesRef.current >= ELEVATION_CONFIRMATION_SAMPLES;
              const enoughDelta = Math.abs(countedDelta) >= MIN_ELEVATION_COMMIT_DELTA_M;

              if (enoughDistance && enoughConfirmation && enoughDelta && impliedGrade <= MAX_PLAUSIBLE_GRADE) {
                // Hard-limit one committed elevation chunk. At 30 m this is far below the energy
                // required for a multi-percent SoC jump, while genuine longer climbs can still be
                // accumulated over multiple confirmed chunks. A short GPS excursion cannot cross
                // the confirmation + distance gates, so it contributes zero battery energy.
                const committedDelta = Math.sign(countedDelta) * Math.min(
                  Math.abs(countedDelta),
                  MAX_ELEVATION_DELTA_PER_COMMIT_M
                );
                const VEHICLE_MASS_KG = 1600 + (Math.max(1, Math.min(5, Math.round(passengersRef.current))) - 1) * 75;
                const G = 9.80665;
                const DRIVETRAIN_EFFICIENCY = 0.90;
                const REGEN_EFFICIENCY = 0.65;
                if (committedDelta > 0) {
                  elevationGainRef.current += committedDelta;
                  elevationEnergyKwhRef.current += (VEHICLE_MASS_KG * G * committedDelta) / 3.6e6 / DRIVETRAIN_EFFICIENCY;
                } else {
                  elevationLossRef.current += Math.abs(committedDelta);
                  elevationEnergyKwhRef.current -= (VEHICLE_MASS_KG * G * Math.abs(committedDelta)) / 3.6e6 * REGEN_EFFICIENCY;
                }
                const gainUi = Math.round(elevationGainRef.current);
                const lossUi = Math.round(elevationLossRef.current);
                if (gainUi !== uiGpsPublishedRef.current.elevationGainM) {
                  uiGpsPublishedRef.current.elevationGainM = gainUi;
                  setElevationGainM(gainUi);
                }
                if (lossUi !== uiGpsPublishedRef.current.elevationLossM) {
                  uiGpsPublishedRef.current.elevationLossM = lossUi;
                  setElevationLossM(lossUi);
                }
                lastCountedAltitudeRef.current = (lastCountedAltitudeRef.current ?? smoothedAltitudeRef.current) + committedDelta;
                lastCountedAltitudeDistanceKmRef.current = distanceRef.current;
                elevationTrendDirectionRef.current = 0;
                elevationTrendSamplesRef.current = 0;
              } else if (distanceSinceCheckpointKm >= MIN_ELEVATION_COMMIT_DISTANCE_KM && impliedGrade > MAX_PLAUSIBLE_GRADE) {
                // Impossible grade: re-anchor without charging or crediting the battery.
                lastCountedAltitudeRef.current = smoothedAltitudeRef.current;
                lastCountedAltitudeDistanceKmRef.current = distanceRef.current;
                elevationTrendDirectionRef.current = 0;
                elevationTrendSamplesRef.current = 0;
              }
            }
          }
        }
        // If altitude accuracy is too poor, skip folding this sample into the smoothed altitude
        // or checkpoint entirely — better to wait for a trustworthy fix than smooth in noise.
      }

      prevPositionRef.current = {
        lat: latitude,
        lon: longitude,
        time: now,
        speed: smoothedSpeed,
      };
    };

    const handleError = (err: GeolocationPositionError) => {
      if (err.code === err.PERMISSION_DENIED) {
        setGpsError('GPS запрещен. Разрешите доступ к геолокации в браузере.');
      } else if (err.code === err.POSITION_UNAVAILABLE) {
        setGpsError('Поиск спутников GPS...');
      } else {
        setGpsError('Слабый сигнал GPS...');
      }
    };

    watchIdRef.current = navigator.geolocation.watchPosition(handleSuccess, handleError, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 8000,
    });

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, [isTracking]);

  // During active tracking, refresh current weather every 15 minutes, but only while the car is moving.
  // This uses one lightweight Open-Meteo current-conditions request per interval and never calls
  // Elevation API. All GPS/routing calculations remain local.
  useEffect(() => {
    if (!isTracking) return;

    const WEATHER_REFRESH_MS = 15 * 60 * 1000;

    const refreshWeatherIfNeeded = (force = false) => {
      const position = latestGpsPositionRef.current;
      const speed = latestGpsSpeedRef.current;
      if (!position || speed < 3) return;

      const elapsed = Date.now() - lastWeatherFetchAtRef.current;
      if (!force && elapsed < WEATHER_REFRESH_MS) return;

      fetchGpsWeather(position.lat, position.lon);
    };

    // Get a fresh weather sample as tracking starts (if GPS already has a moving fix).
    // Subsequent refreshes are limited to once every 15 minutes.
    refreshWeatherIfNeeded(true);
    const interval = window.setInterval(refreshWeatherIfNeeded, WEATHER_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [isTracking]);

  // Dynamic relative wind angle calculation
  const currentHeading = gpsHeading ?? lastHeadingRef.current ?? 0;
  const windDir = weather.windDirection;
  const relativeWindAngle = ((windDir - currentHeading + 360) % 360);
  const windSpeedMs = Number((weather.windSpeed / 3.6).toFixed(1));

  // Keep relativeWindAngleRef in sync for the geolocation callback's per-segment energy calc.
  useEffect(() => {
    relativeWindAngleRef.current = relativeWindAngle;
  }, [relativeWindAngle]);

  // Dynamic arrow rotation: top of dial is vehicle heading (0°).
  // Headwind (windDir = heading, relAngle = 0°): Arrow points straight DOWN into car (0° rotation).
  // Tailwind (windDir = heading + 180°, relAngle = 180°): Arrow points straight UP with car (180° rotation).
  // Crosswind from right (relAngle = 90°): Arrow points LEFT (90° rotation).
  // Crosswind from left (relAngle = 270°): Arrow points RIGHT (270° rotation).
  const dynamicRelativeWindArrowDeg = Math.round(relativeWindAngle);

  const getWindClassification = (relAngle: number, speedKmh: number) => {
    const spdMs = speedKmh / 3.6;
    if (spdMs < 0.8) {
      return {
        label: 'Штиль',
        arrowRotation: 0,
        type: 'calm',
        color: isDark ? 'text-slate-400' : 'text-slate-500',
        badgeBg: isDark ? 'bg-slate-800/80 border-slate-700 text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-700',
      };
    }

    const norm = (relAngle % 360 + 360) % 360;

    if (norm <= 35 || norm >= 325) {
      return {
        label: 'Встречный',
        arrowRotation: dynamicRelativeWindArrowDeg,
        type: 'headwind',
        color: 'text-rose-500',
        badgeBg: isDark ? 'bg-rose-950/70 border-rose-800/80 text-rose-300' : 'bg-rose-50 border-rose-200 text-rose-700',
      };
    } else if (norm >= 145 && norm <= 215) {
      return {
        label: 'Попутный',
        arrowRotation: dynamicRelativeWindArrowDeg,
        type: 'tailwind',
        color: 'text-cyan-500',
        badgeBg: isDark ? 'bg-cyan-950/70 border-cyan-800/80 text-cyan-300' : 'bg-cyan-50 border-cyan-200 text-cyan-700',
      };
    } else if (norm > 35 && norm < 145) {
      return {
        label: 'Справа',
        arrowRotation: dynamicRelativeWindArrowDeg,
        type: 'crosswind_right',
        color: 'text-amber-500',
        badgeBg: isDark ? 'bg-amber-950/70 border-amber-800/80 text-amber-300' : 'bg-amber-50 border-amber-200 text-amber-800',
      };
    } else {
      return {
        label: 'Слева',
        arrowRotation: dynamicRelativeWindArrowDeg,
        type: 'crosswind_left',
        color: 'text-amber-500',
        badgeBg: isDark ? 'bg-amber-950/70 border-amber-800/80 text-amber-300' : 'bg-amber-50 border-amber-200 text-amber-800',
      };
    }
  };

  const windInfo = getWindClassification(relativeWindAngle, weather.windSpeed);

  // Real-time trip average speed calculation
  const avgTripSpeedKmH =
    isTracking && elapsedSeconds > 5 && tripDistanceKm > 0.05
      ? Math.min(MAX_VALID_SPEED_KMH, Number(((tripDistanceKm / (elapsedSeconds / 3600))).toFixed(0)))
      : currentSpeed > 0
      ? currentSpeed
      : 55;

  // Average speed from the trip journal — used specifically for the "SoC at Destination"
  // forecast when no live trip is being tracked, instead of falling back to a generic default.
  const journalAvgSpeedKmH = useMemo(() => {
    const validSpeeds = sessions
      .map((s) => s.avgSpeedKmH)
      .filter((v): v is number => typeof v === 'number' && v > 5 && v < MAX_VALID_SPEED_KMH);
    if (validSpeeds.length === 0) return 55;
    return Math.round(validSpeeds.reduce((a, b) => a + b, 0) / validSpeeds.length);
  }, [sessions]);

  // Speed used for the destination forecast: live tracked pace while a trip is running,
  // otherwise the historical average from the journal.
  const destinationSpeedKmH = isTracking ? avgTripSpeedKmH : journalAvgSpeedKmH;

  // Ambient outside temperature & live climate impact calculation
  const outdoorTemp = weather.isLoaded ? weather.temperature : 20;
  const liveClimate = calculateClimateImpact(outdoorTemp, climateOn);

  // Keep the 1Hz timer's climate refs in sync without restarting the interval on every toggle.
  useEffect(() => {
    climateOnRef.current = climateOn;
  }, [climateOn]);
  useEffect(() => {
    outdoorTempRef.current = outdoorTemp;
  }, [outdoorTemp]);

  // Precipitation & Road Surface Impact calculation
  const livePrecipitation = calculatePrecipitationImpact(
    weather.isLoaded ? weather.weatherCode : undefined,
    weather.isLoaded ? weather.precipitation : undefined,
    outdoorTemp
  );

  // === REAL-TIME DRIVING STYLE SPECIFICALLY FOR THE CURRENT ACTIVE TRIP ===
  // Dynamic speed kinetics, speed stability and high-speed intensity only.
  // Weather/temperature/precipitation are deliberately excluded from driving style.
  const currentTripStyle = useMemo(() => {
    // When tracking is inactive or in early calibration
    if (!isTracking || tripDistanceKm < 0.05 || elapsedSeconds < 6 || speedHistoryRef.current.length < 4) {
      return {
        factor: 1.0,
        label: 'Калибровка',
        subLabel: 'Анализ темпа в пути...',
        details: 'Определение стиля вождения',
        diffPct: 0,
        color: isDark ? 'text-slate-300' : 'text-slate-700',
        badgeBg: isDark ? 'bg-slate-800/80 border-slate-700 text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-700',
      };
    }

    // Style is judged from a ROLLING window of recent samples, not the whole trip so far.
    // Cumulative-since-start variance falsely reads as "volatile/aggressive" driving during the
    // first minute of any trip — accelerating 0 -> cruising speed is naturally high-variance and
    // has nothing to do with driving style, but it used to get baked in and diluted only slowly
    // as more (calm) samples arrived, which is exactly what made the live "SOC на финише" number
    // look too pessimistic for a while early in a trip even though the driving itself was normal.
    // ~60 samples at ~1 GPS fix/second is roughly the last 1-2 minutes — long enough to judge
    // actual style, short enough that an early ramp-up ages out of it within the first couple of
    // minutes. Short trips that never reach 60 samples still use everything they have, same as before.
    const RECENT_STYLE_WINDOW = 60;
    const movingSpeeds = speedHistoryRef.current.slice(-RECENT_STYLE_WINDOW).filter((s) => s >= 5);
    if (movingSpeeds.length < 4) {
      return {
        factor: 1.0,
        label: 'Сбалансированный',
        subLabel: 'Штатный темп',
        details: 'Штатный темп',
        diffPct: 0,
        color: isDark ? 'text-slate-200' : 'text-slate-800',
        badgeBg: isDark ? 'bg-slate-800/80 border-slate-700 text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-700',
      };
    }

    // 1. Speed stability & standard deviation
    const mean = movingSpeeds.reduce((a, b) => a + b, 0) / movingSpeeds.length;
    const variance = movingSpeeds.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / movingSpeeds.length;
    const stdDev = Math.sqrt(variance);

    let factor = 1.0;

    // Smooth cruise vs stop-and-go jerks
    if (stdDev < 10 && movingSpeeds.length > 8) {
      factor -= 0.08; // High cruising stability bonus
    } else if (stdDev < 16) {
      factor -= 0.03; // Smooth driving
    } else if (stdDev > 26) {
      factor += 0.08; // Volatile bursts & hard brakes
    }

    // 2. Max speed vs Average speed burstiness
    if (maxSpeed > 80 && avgTripSpeedKmH > 0) {
      const burstRatio = maxSpeed / Math.max(30, avgTripSpeedKmH);
      if (burstRatio > 1.6) {
        factor += 0.06;
      }
    }

    // 3. High speed intensity
    const highSpeedRatio = movingSpeeds.filter((s) => s > 105).length / movingSpeeds.length;
    if (highSpeedRatio > 0.35) {
      factor += 0.08;
    } else if (highSpeedRatio > 0.15) {
      factor += 0.04;
    }

    const clamped = Number(Math.max(0.75, Math.min(1.35, factor)).toFixed(2));
    const diffPct = Math.round((clamped - 1) * 100);

    if (clamped < 0.95) {
      return {
        factor: clamped,
        label: 'Эко-плавный',
        subLabel: `Плавный темп (${diffPct > 0 ? `+${diffPct}` : diffPct}%)`,
        details: `Плавный разгон, минимум рывков`,
        diffPct,
        color: 'text-cyan-500',
        badgeBg: isDark ? 'bg-cyan-950/70 border-cyan-800 text-cyan-300' : 'bg-cyan-50 border-cyan-200 text-cyan-800',
      };
    } else if (clamped <= 1.05) {
      return {
        factor: clamped,
        label: 'Сбалансированный',
        subLabel: `Штатный темп (${diffPct >= 0 ? `+${diffPct}` : diffPct}%)`,
        details: `Оптимальный баланс динамики`,
        diffPct,
        color: isDark ? 'text-slate-200' : 'text-slate-800',
        badgeBg: isDark ? 'bg-slate-800/80 border-slate-700 text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-700',
      };
    } else if (clamped <= 1.15) {
      return {
        factor: clamped,
        label: 'Динамичный',
        subLabel: `Ускорения (+${diffPct}%)`,
        details: `Активные обгоны и перестроения`,
        diffPct,
        color: 'text-amber-500',
        badgeBg: isDark ? 'bg-amber-950/70 border-amber-800 text-amber-300' : 'bg-amber-50 border-amber-200 text-amber-800',
      };
    } else {
      return {
        factor: clamped,
        label: 'Агрессивный',
        subLabel: `Резкие рывки (+${diffPct}%)`,
        details: `Резкие ускорения и торможения`,
        diffPct,
        color: 'text-rose-500',
        badgeBg: isDark ? 'bg-rose-950/70 border-rose-800 text-rose-300' : 'bg-rose-50 border-rose-200 text-rose-800',
      };
    }
  }, [isTracking, tripDistanceKm, elapsedSeconds, maxSpeed, avgTripSpeedKmH, isDark]);

  // Energy consumption forecast combining live trip style + speed + temperature + climate + relative wind + precipitation + elevation
  const forecast: ConsumptionForecast = estimateTripConsumption(
    avgTripSpeedKmH,
    weather.isLoaded ? weather.temperature : undefined,
    sessions,
    settings.batteryCapacityKwh,
    climateOn,
    weather.isLoaded ? weather.windSpeed : undefined,
    relativeWindAngle,
    isTracking ? currentTripStyle.factor : undefined,
    weather.isLoaded ? weather.weatherCode : undefined,
    weather.isLoaded ? weather.precipitation : undefined,
    isTracking && tripDistanceKm > 0.3
      ? { gainM: elevationGainM, lossM: elevationLossM, distanceKm: tripDistanceKm }
      : undefined,
    undefined,
    // Bug fix (found 2026-09-10): this call was missing the tripDurationHours/
    // climatePowerOverrideKw argument pair's second slot, so `passengers` landed in the
    // climatePowerOverrideKw parameter instead of its own — and since that override always wins
    // over the real temperature-based HVAC calc, live climate energy was silently being computed
    // as passengerCount kW (e.g. 3 passengers -> a flat 3kW "climate" load) regardless of actual
    // temperature. Confirmed by cross-checking five recent trips: logged climate power matched
    // passenger count almost exactly in every one, independent of temperature. The explicit
    // `undefined` here fills climatePowerOverrideKw (position 13) so passengers correctly lands
    // in position 14.
    undefined,
    passengers,
    settings.curbWeightKg ?? 1600,
    settings.consumptionScale ?? 1,
    settings.hasHeatPump ?? true,
  );

  // Range display is intentionally decoupled from passenger-count adjustments.
  // Passenger count is useful for destination-energy estimation, but the live range
  // indicator should remain stable and not jump dramatically when passengers change.
  const rangeForecast: ConsumptionForecast = estimateTripConsumption(
    avgTripSpeedKmH,
    weather.isLoaded ? weather.temperature : undefined,
    sessions,
    settings.batteryCapacityKwh,
    climateOn,
    weather.isLoaded ? weather.windSpeed : undefined,
    relativeWindAngle,
    isTracking ? currentTripStyle.factor : undefined,
    weather.isLoaded ? weather.weatherCode : undefined,
    weather.isLoaded ? weather.precipitation : undefined,
    isTracking && tripDistanceKm > 0.3
      ? { gainM: elevationGainM, lossM: elevationLossM, distanceKm: tripDistanceKm }
      : undefined,
    undefined,
    // Same missing-argument bug as the forecast call above — without this extra `undefined`,
    // the trailing `1` below lands in climatePowerOverrideKw (forcing a flat 1kW "climate" load
    // regardless of temperature) instead of passengers.
    undefined,
    1,
    settings.curbWeightKg ?? 1600,
    settings.consumptionScale ?? 1,
    settings.hasHeatPump ?? true,
  );
  // Keep the range calculation on a stable vehicle-level consumption basis.
  // Passenger count still affects the destination forecast above.
  const rangeConsumption = Math.max(0.1, rangeForecast.estimatedConsumption);

  // === DYNAMIC SOC & RANGE CALCULATION DURING TRIP ===
  // Energy spent so far during active trip (kWh).
  // The speed/temperature/wind/precipitation/style portion is liveSegmentEnergyKwh, accumulated
  // per-GPS-segment at each segment's own instantaneous speed (see geolocation handler above) —
  // NOT the previous approach of applying the whole-trip average speed to the whole distance,
  // which under-costs mixed city/highway trips because the speed→consumption curve is convex.
  //
  // Elevation energy (elevationEnergyKwhRef) is accumulated the same incremental way, in the
  // same geolocation handler, at the vehicle mass in effect at the moment each metre of gain/loss
  // was counted (see passengersRef above). It is deliberately NOT recomputed here from aggregate
  // gainM/lossM at the CURRENT passenger count — doing so priced the entire trip's already-driven
  // climb/descent at whatever mass happened to apply when this line last ran, so adding
  // passengers mid-trip retroactively re-costed elevation already banked earlier in the trip and
  // showed up as a sudden multi-percent SoC jump.
  //
  // HVAC energy is now accumulated incrementally every second (climateEnergyKwhRef, set in the
  // 1Hz timer above) rather than climatePowerKw × total-elapsed-time, so toggling climate
  // on/off mid-trip only affects energy from that second forward — not the whole trip retroactively.
  const energySpentKwh = isTracking
    ? Math.max(0, liveSegmentEnergyKwh + elevationEnergyKwhRef.current + climateEnergyKwhRef.current)
    : 0;

  // Percentage drop of battery based on energy spent and battery capacity
  const socSpentPercent = (energySpentKwh / batteryCap) * 100;

  // Live dynamic remaining SoC % — a direct read of the current energy balance, not clamped
  // to a running minimum. It can rise slightly mid-trip: braking before a turn, coasting, and
  // descents all genuinely give regen credit (elevationEnergyKwhRef can decrease), and with the
  // display now rounded to whole percent, small honest upward ticks read as real recuperation
  // rather than as a confusing flicker.
  const liveDynamicSoc = Math.max(0, Number((startTripSoc - socSpentPercent).toFixed(1)));

  // Live SoC-at-destination: always derived from the *current* liveDynamicSoc + last
  // calculated remaining energy. This makes the big "SOC на финише" number move in real time
  // while tracking, even between full route recalculations.
  const livePredictedSoc =
    destinationResult != null
      ? destinationResult.energyNeededKwh > 0.01
        ? Math.max(
            0,
            Number(
              (liveDynamicSoc - (destinationResult.energyNeededKwh / batteryCap) * 100).toFixed(1),
            ),
          )
        : // Seeded calculator value (or pending live recalc) — do not force equal to start SoC
          Math.max(0, Number(destinationResult.predictedSoc))
      : null;

  // Multi-stop plan: remaining distance / SoC to the *next* waypoint (charge stop or B).
  const activeWaypoint =
    routeWaypoints.length > 0
      ? routeWaypoints[Math.min(activeWaypointIndex, routeWaypoints.length - 1)]
      : null;
  const remainingKmToActiveWaypoint = activeWaypoint
    ? Math.max(0, activeWaypoint.distanceAlongRouteKm - tripDistanceKm)
    : null;
  // Prefer scaling the last full-route energy estimate; otherwise use live range consumption.
  const energyToActiveWaypointKwh =
    remainingKmToActiveWaypoint != null
      ? destinationResult != null && destinationResult.distanceKm > 0.5
        ? (remainingKmToActiveWaypoint / destinationResult.distanceKm) * destinationResult.energyNeededKwh
        : (remainingKmToActiveWaypoint / 100) * rangeConsumption
      : null;
  const liveSocAtActiveWaypoint =
    energyToActiveWaypointKwh != null
      ? Math.max(0, Number((liveDynamicSoc - (energyToActiveWaypointKwh / batteryCap) * 100).toFixed(1)))
      : null;

  // Auto-advance to the next leg when GPS distance along the trip has passed a waypoint.
  useEffect(() => {
    if (!routeWaypoints.length || !isTracking) return;
    let idx = activeWaypointIndex;
    while (
      idx < routeWaypoints.length - 1 &&
      tripDistanceKm >= routeWaypoints[idx].distanceAlongRouteKm - 0.25
    ) {
      idx += 1;
    }
    if (idx !== activeWaypointIndex) setActiveWaypointIndex(idx);
  }, [tripDistanceKm, routeWaypoints, activeWaypointIndex, isTracking]);

  // Remaining battery kWh at live dynamic SoC
  const dynamicRemainingBatteryKwh = (liveDynamicSoc / 100) * batteryCap;

  // Remaining range in km dynamically calculated from live SoC & predicted consumption (style + weather + road)
  const dynamicRemainingRangeKm = Math.max(
    0,
    Math.round((dynamicRemainingBatteryKwh / rangeConsumption) * 100)
  );

  // Smooth displayed range so it does not flicker every GPS/weather tick.
  useEffect(() => {
    setDisplayRangeKm((prev) => {
      if (!prev || prev <= 0) return dynamicRemainingRangeKm;
      const next = Math.round(prev * 0.72 + dynamicRemainingRangeKm * 0.28);
      // Ignore sub-2 km noise
      if (Math.abs(next - prev) < 2) return prev;
      return next;
    });
  }, [dynamicRemainingRangeKm]);

  // Landscape / wide layout for HUD driving and pre-start.
  useEffect(() => {
    const update = () => {
      const landscape =
        (typeof window.matchMedia === 'function' && window.matchMedia('(orientation: landscape)').matches) ||
        window.innerWidth > window.innerHeight * 1.05;
      setIsLandscape(landscape);
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  // Baseline nominal range at the vehicle's official passport rating (340 km at 100% charge for
  // the Dongfeng Vigo), scaled down proportionally to the current battery charge.
  const PASSPORT_RANGE_KM = 340;
  const baselineNominalRangeKm = Math.max(
    0,
    Math.round((dynamicRemainingBatteryKwh / batteryCap) * PASSPORT_RANGE_KM)
  );

  // Range delta relative to nominal factory rating (due to weather + driving style + wind + precipitation)
  const rangeDeltaKm = dynamicRemainingRangeKm - baselineNominalRangeKm;

  // Safe buffer range down to 10% reserve for reaching a charging station
  const safeDynamicSoc = Math.max(0, liveDynamicSoc - 10);
  const safeDynamicBatteryKwh = (safeDynamicSoc / 100) * batteryCap;
  const safeDynamicRangeKm = Math.max(
    0,
    Math.round((safeDynamicBatteryKwh / rangeConsumption) * 100)
  );

  // Total consumption multiplier factor relative to base
  const totalConsumptionFactor = Number(
    (forecast.estimatedConsumption / forecast.baseConsumption).toFixed(2)
  );

  // Persist live trip so a WebView kill / reload does not erase it.
  const writeCheckpoint = useCallback(() => {
    if (!isTracking || !tripStartTime) return;
    saveHudCheckpoint({
      v: 1,
      savedAt: Date.now(),
      tripStartTime,
      elapsedSeconds,
      tripDistanceKm,
      maxSpeed,
      startTripSoc,
      climateOn,
      passengers,
      elevationGainM,
      elevationLossM,
      altitudeAvailable,
      distanceKm: distanceRef.current,
      segmentEnergyKwh: segmentEnergyKwhRef.current,
      elevationEnergyKwh: elevationEnergyKwhRef.current,
      climateEnergyKwh: climateEnergyKwhRef.current,
      speedHistory: speedHistoryRef.current.slice(-200),
      windLog: windLogRef.current as Array<Record<string, unknown>>,
      lastWindLogDistanceKm: lastWindLogDistanceKmRef.current,
      destinationQuery: destinationQuery || undefined,
      destinationMode,
      manualAvgSpeedKmH,
    });
  }, [
    isTracking,
    tripStartTime,
    elapsedSeconds,
    tripDistanceKm,
    maxSpeed,
    startTripSoc,
    climateOn,
    passengers,
    elevationGainM,
    elevationLossM,
    altitudeAvailable,
    destinationQuery,
    destinationMode,
    manualAvgSpeedKmH,
  ]);

  useEffect(() => {
    if (!isTracking) return;
    writeCheckpoint();
    const id = window.setInterval(writeCheckpoint, 12_000);
    const onHide = () => {
      if (document.visibilityState === 'hidden') writeCheckpoint();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', writeCheckpoint);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', writeCheckpoint);
    };
  }, [isTracking, writeCheckpoint]);

  const applyCheckpoint = useCallback(
    (cp: HudTripCheckpoint) => {
      requestWakeLock();
      setIsTracking(true);
      setTripStartTime(cp.tripStartTime);
      setElapsedSeconds(
        Math.max(cp.elapsedSeconds, Math.floor((Date.now() - cp.tripStartTime) / 1000)),
      );
      setTripDistanceKm(cp.tripDistanceKm);
      setMaxSpeed(cp.maxSpeed);
      setStartTripSoc(cp.startTripSoc);
      setClimateOn(cp.climateOn);
      setPassengers(cp.passengers);
      setElevationGainM(cp.elevationGainM);
      setElevationLossM(cp.elevationLossM);
      setAltitudeAvailable(cp.altitudeAvailable);
      distanceRef.current = cp.distanceKm;
      segmentEnergyKwhRef.current = cp.segmentEnergyKwh;
      elevationEnergyKwhRef.current = cp.elevationEnergyKwh;
      climateEnergyKwhRef.current = cp.climateEnergyKwh;
      speedHistoryRef.current = Array.isArray(cp.speedHistory) ? [...cp.speedHistory] : [];
      windLogRef.current = Array.isArray(cp.windLog) ? [...(cp.windLog as any[])] : [];
      lastWindLogDistanceKmRef.current = cp.lastWindLogDistanceKm || 0;
      setLiveSegmentEnergyKwh(Number(cp.segmentEnergyKwh.toFixed(3)));
      if (cp.destinationQuery) setDestinationQuery(cp.destinationQuery);
      if (cp.destinationMode) setDestinationMode(cp.destinationMode);
      if (cp.manualAvgSpeedKmH) setManualAvgSpeedKmH(cp.manualAvgSpeedKmH);
      setCompletedTripSummary(null);
      setTrackingStopMessage('');
      setPendingCheckpoint(null);
      uiGpsPublishedRef.current = {
        ...uiGpsPublishedRef.current,
        distanceKm: Number(cp.distanceKm.toFixed(2)),
        segmentEnergyKwh: Number(cp.segmentEnergyKwh.toFixed(3)),
        elevationGainM: cp.elevationGainM,
        elevationLossM: cp.elevationLossM,
        altitudeAvailable: cp.altitudeAvailable,
        maxSpeed: cp.maxSpeed,
      };
    },
    [requestWakeLock],
  );

  // START tracking
  const handleStartTracking = () => {
    triggerHaptic('success', settings.hapticFeedback);
    requestWakeLock();
    clearHudCheckpoint();
    setPendingCheckpoint(null);
    setIsTracking(true);
    setTripStartTime(Date.now());
    setElapsedSeconds(0);
    setTripDistanceKm(0);
    setMaxSpeed(0);
    distanceRef.current = 0;
    speedHistoryRef.current = [];
    bearingHistoryRef.current = [];
    smoothSpeedBufferRef.current = [];
    smoothedAltitudeRef.current = null;
    lastCountedAltitudeRef.current = null;
    lastCountedAltitudeDistanceKmRef.current = 0;
    elevationTrendDirectionRef.current = 0;
    elevationTrendSamplesRef.current = 0;
    previousSmoothedAltitudeRef.current = null;
    windLogRef.current = [];
    lastAltitudeAccuracyRef.current = null;
    lastWindLogDistanceKmRef.current = 0;
    elevationGainRef.current = 0;
    elevationEnergyKwhRef.current = 0;
    climateEnergyKwhRef.current = 0;
    elevationLossRef.current = 0;
    setElevationGainM(0);
    setElevationLossM(0);
    setAltitudeAvailable(false);
    setCompletedTripSummary(null);
    setTrackingStopMessage('');
    segmentEnergyKwhRef.current = 0;
    setLiveSegmentEnergyKwh(0);
    uiGpsPublishedRef.current = {
      speed: 0,
      accuracy: uiGpsPublishedRef.current.accuracy,
      heading: uiGpsPublishedRef.current.heading,
      distanceKm: 0,
      segmentEnergyKwh: 0,
      altitudeAvailable: false,
      elevationGainM: 0,
      elevationLossM: 0,
      maxSpeed: 0,
    };
  };

  // STOP tracking
  const disarmAction = () => {
    if (armTimerRef.current != null) window.clearTimeout(armTimerRef.current);
    armTimerRef.current = null;
    setArmedAction(null);
  };

  const pressGuarded = (action: 'stop' | 'reset', run: () => void) => {
    if (armedAction === action) {
      disarmAction();
      run();
      return;
    }
    triggerHaptic('heavy', settings.hapticFeedback);
    if (armTimerRef.current != null) window.clearTimeout(armTimerRef.current);
    setArmedAction(action);
    armTimerRef.current = window.setTimeout(() => {
      armTimerRef.current = null;
      setArmedAction(null);
    }, 3000);
  };

  const handleStopPress = () => pressGuarded('stop', () => handleStopTracking());
  const handleResetPress = () => pressGuarded('reset', () => handleResetTracking());

  useEffect(() => () => {
    if (armTimerRef.current != null) window.clearTimeout(armTimerRef.current);
  }, []);

  const handleStopTracking = () => {
    triggerHaptic('medium', settings.hapticFeedback);
    writeCheckpoint(); // keep until user saves or discards summary
    setIsTracking(false);
    setDestinationResult(null);
    setDestinationError(null);
    setDestinationBreakdownOpen(false);
    cachedDestRef.current = null;
    lastDestRecalcAtRef.current = 0;
    lastDestRecalcDistanceRef.current = 0;
    destRecalcInFlightRef.current = false;
    setTrackingStopMessage('Расчёт остановлен');

    const finalDistance = Number(distanceRef.current.toFixed(1));
    const finalMinutes = Math.max(1, Math.round(elapsedSeconds / 60));
    const finalAvgSpeed =
      elapsedSeconds > 10 && finalDistance > 0.05
        ? Math.min(MAX_VALID_SPEED_KMH, Math.round(finalDistance / (elapsedSeconds / 3600)))
        : maxSpeed > 0
        ? Math.round(maxSpeed * 0.7)
        : currentSpeed;

    // Use the live per-segment-accumulated energy total (energySpentKwh) rather than
    // re-deriving it from the trip's average speed, for the same reason the live SoC display
    // does: it already reflects each segment's own actual speed.
    const finalEnergyKwh = Number(energySpentKwh.toFixed(2));
    const finalEndSoc = Math.max(0, Math.round(startTripSoc - (finalEnergyKwh / batteryCap) * 100));

    setCompletedTripSummary({
      distanceKm: finalDistance,
      avgSpeedKmH: finalAvgSpeed,
      maxSpeedKmH: maxSpeed,
      durationMinutes: finalMinutes,
      estimatedCons: forecast.estimatedConsumption,
      temp: weather.temperature,
      windStatus: forecast.windStatusText,
      precipitationStatus: forecast.precipitationLabel,
      roadSurface: forecast.roadSurfaceCondition,
      startSoc: startTripSoc,
      endSoc: finalEndSoc,
      energyUsedKwh: finalEnergyKwh,
      styleFactor: currentTripStyle.factor,
      styleLabel: currentTripStyle.label,
      segmentEnergyKwhAtStop: Number(liveSegmentEnergyKwh.toFixed(3)),
      elevationEnergyKwhAtStop: Number(elevationEnergyKwhRef.current.toFixed(3)),
      climateEnergyKwhAtStop: Number(climateEnergyKwhRef.current.toFixed(3)),
      climatePowerKwAtStop: Number(calculateClimateImpact(outdoorTempRef.current, climateOnRef.current).powerKw.toFixed(3)),
    });
  };

  // RESET tracking
  const handleResetTracking = () => {
    triggerHaptic('light', settings.hapticFeedback);
    clearHudCheckpoint();
    setPendingCheckpoint(null);
    setIsTracking(false);
    setTrackingStopMessage('');
    setTripStartTime(null);
    setElapsedSeconds(0);
    setTripDistanceKm(0);
    setMaxSpeed(0);
    distanceRef.current = 0;
    speedHistoryRef.current = [];
    bearingHistoryRef.current = [];
    smoothSpeedBufferRef.current = [];
    smoothedAltitudeRef.current = null;
    lastCountedAltitudeRef.current = null;
    lastCountedAltitudeDistanceKmRef.current = 0;
    elevationTrendDirectionRef.current = 0;
    elevationTrendSamplesRef.current = 0;
    previousSmoothedAltitudeRef.current = null;
    windLogRef.current = [];
    lastAltitudeAccuracyRef.current = null;
    lastWindLogDistanceKmRef.current = 0;
    elevationGainRef.current = 0;
    elevationEnergyKwhRef.current = 0;
    climateEnergyKwhRef.current = 0;
    elevationLossRef.current = 0;
    setElevationGainM(0);
    setElevationLossM(0);
    setAltitudeAvailable(false);
    setCompletedTripSummary(null);
    segmentEnergyKwhRef.current = 0;
    setLiveSegmentEnergyKwh(0);
    uiGpsPublishedRef.current = {
      speed: 0,
      accuracy: uiGpsPublishedRef.current.accuracy,
      heading: uiGpsPublishedRef.current.heading,
      distanceKm: 0,
      segmentEnergyKwh: 0,
      altitudeAvailable: false,
      elevationGainM: 0,
      elevationLossM: 0,
      maxSpeed: 0,
    };
  };

  // Save tracked trip directly to history
  const handleSaveTrackedTrip = () => {
    if (!completedTripSummary) return;

    triggerHaptic('success', settings.hapticFeedback);

    const gasCostEquivalent = Number(
      ((completedTripSummary.distanceKm / 100) * settings.gasEquivalentL100km * settings.gasPricePerLiter).toFixed(2)
    );
    const tariff = settings.malankaDcTariff ?? settings.fastDayTariff ?? 0.56;
    const totalCost = Number((completedTripSummary.energyUsedKwh * tariff).toFixed(2));
    const moneySaved = Number(Math.max(0, gasCostEquivalent - totalCost).toFixed(2));

    const roadType =
      completedTripSummary.avgSpeedKmH > 75
        ? 'highway'
        : completedTripSummary.avgSpeedKmH < 45
        ? 'city'
        : 'mixed';

    // If a Calculator route forecast was computed shortly before this trip and covers roughly
    // the same distance, attach predicted-vs-actual so History can show the comparison without
    // a separate accuracy-tracking screen yet.
    const matchedForecast = consumeMatchingRouteForecast(completedTripSummary.distanceKm);
    let forecastNote = '';
    if (matchedForecast) {
      const socDelta = Number((completedTripSummary.endSoc - matchedForecast.arrivalSoc).toFixed(1));
      const socDeltaText = `${socDelta > 0 ? '+' : ''}${socDelta}`;
      forecastNote = ` | Прогноз: ${matchedForecast.arrivalSoc}% SoC (Δ${socDeltaText}п.п., ${matchedForecast.consumptionPer100Km}→${completedTripSummary.estimatedCons} кВт⋅ч/100)`;
    }

    // Exact breakdown of the saved total, captured at the moment tracking stopped — lets the
    // three components (segment/elevation/climate) be checked directly against energyUsedKwh
    // without reconstructing them from the 1km-interval hudWindLog.
    const breakdownNote = completedTripSummary.segmentEnergyKwhAtStop !== undefined
      ? ` | Состав: сегмент=${completedTripSummary.segmentEnergyKwhAtStop}, рельеф=${completedTripSummary.elevationEnergyKwhAtStop}, климат=${completedTripSummary.climateEnergyKwhAtStop} кВт⋅ч (мощность климата=${completedTripSummary.climatePowerKwAtStop} кВт при t=${completedTripSummary.temp}°C)`
      : '';

    clearHudCheckpoint();
    setPendingCheckpoint(null);
    onSaveToHistory({
      date: new Date().toISOString().split('T')[0],
      title: `GPS Трек: ${completedTripSummary.distanceKm} км (${completedTripSummary.avgSpeedKmH} км/ч)`,
      startSoc: completedTripSummary.startSoc,
      endSoc: completedTripSummary.endSoc,
      distanceKm: completedTripSummary.distanceKm,
      energyUsedKwh: completedTripSummary.energyUsedKwh,
      consumptionPer100Km: completedTripSummary.estimatedCons,
      kmPerKwh: Number((100 / completedTripSummary.estimatedCons).toFixed(2)),
      chargingType: 'malanka_dc',
      totalCost,
      gasCostEquivalent,
      moneySaved,
      roadType,
      climateOn,
      temperature: completedTripSummary.temp,
      avgSpeedKmH: completedTripSummary.avgSpeedKmH,
      maxSpeedKmH: completedTripSummary.maxSpeedKmH,
      drivingStyleFactor: completedTripSummary.styleFactor,
      passengers,
      note: `GPS HUD: ${completedTripSummary.durationMinutes} мин, ${completedTripSummary.avgSpeedKmH} км/ч, стиль поездки: x${completedTripSummary.styleFactor || 1.0} (${completedTripSummary.styleLabel || 'Сбалансированный'}), t=${completedTripSummary.temp}°C${
        completedTripSummary.windStatus ? `, ветер: ${completedTripSummary.windStatus}` : ''
      }${forecastNote}${breakdownNote}`,
      ...(matchedForecast && {
        forecastArrivalSoc: matchedForecast.arrivalSoc,
        forecastConsumptionPer100Km: matchedForecast.consumptionPer100Km,
        forecastEnergyKwh: matchedForecast.energyKwh,
        forecastPlannedSpeedKmH: matchedForecast.plannedSpeedKmH,
        forecastPlannedMaxSpeedKmH: matchedForecast.plannedMaxSpeedKmH,
        forecastSpeedProfile: matchedForecast.speedProfile,
      }),
      // Raw per-km wind/energy trail from live tracking, captured before any manual SoC
      // correction — see windLogRef above.
      hudWindLog: windLogRef.current.length ? JSON.stringify(windLogRef.current) : undefined,
    });

    setCompletedTripSummary(null);
  };

  // Format time mm:ss or hh:mm:ss
  const formatTime = (secs: number) => {
    const hrs = Math.floor(secs / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (hrs > 0) {
      return `${hrs}:${mins < 10 ? '0' : ''}${mins}:${s < 10 ? '0' : ''}${s}`;
    }
    return `${mins < 10 ? '0' : ''}${mins}:${s < 10 ? '0' : ''}${s}`;
  };

  // === SoC AT DESTINATION FORECAST ===
  // geocodeAddress / buildRouteElevation live in ../services/routeElevation and
  // fetchForecastWeatherAt lives in ../services/weatherForecast, so the Calculator tab's route
  // planner shares the exact same implementations instead of maintaining its own copies.
  //
  // While tracking is active the forecast is automatically refreshed (throttled) so that
  // "SOC на финише" stays live. Manual press still works the same way.

  const handleCalculateDestination = async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!destinationQuery.trim()) return;
    if (destinationBusy && !silent) return;
    if (destRecalcInFlightRef.current && silent) return;

    if (!silent) {
      triggerHaptic('light', settings.hapticFeedback);
      setDestinationBusy(true);
      setDestinationError(null);
      // Do not clear destinationResult immediately — avoids UI flicker. New result will replace it.
      setDestinationBreakdownOpen(false);
    } else {
      destRecalcInFlightRef.current = true;
    }

    // Speed used to estimate consumption + ETA for the destination forecast:
    // - Tracking already running -> use the live, GPS-derived average speed of this trip.
    // - Not tracking yet -> use the speed the driver manually set for the planned trip.
    const destinationSpeedKmH = isTracking ? avgTripSpeedKmH : Math.min(150, Math.max(5, manualAvgSpeedKmH || 60));

    try {
      if (destinationMode === 'distance') {
        const distanceKm = parseFloat(destinationQuery.replace(',', '.'));
        if (isNaN(distanceKm) || distanceKm <= 0) {
          if (!silent) setDestinationError('Введите дистанцию в км, например 45');
          return;
        }

        const etaMinutes = destinationSpeedKmH > 3 ? Math.round((distanceKm / destinationSpeedKmH) * 60) : undefined;
        const arrivalDate = new Date(Date.now() + (etaMinutes ?? 0) * 60000);

        // No route geometry in this mode — extrapolate terrain from what's already been driven
        // this trip (if any), otherwise assume flat road (0 gain/loss).
        const haveLiveElevation = isTracking && tripDistanceKm > 1 && (elevationGainM > 0 || elevationLossM > 0);
        const projectedGainM = haveLiveElevation ? (elevationGainM / tripDistanceKm) * distanceKm : 0;
        const projectedLossM = haveLiveElevation ? (elevationLossM / tripDistanceKm) * distanceKm : 0;

        // No destination coordinates in this mode, so the best we can do is a *temporal*
        // forecast for the current position at the estimated arrival time (not a spatial one).
        let forecastWeather: Awaited<ReturnType<typeof fetchForecastWeatherAt>> = null;
        if (prevPositionRef.current) {
          forecastWeather = await fetchForecastWeatherAt(
            prevPositionRef.current.lat,
            prevPositionRef.current.lon,
            arrivalDate
          );
        }
        const forecastUsed = forecastWeather !== null;
        const calcTemperature = forecastWeather?.temperature ?? (weather.isLoaded ? weather.temperature : undefined);
        const calcWindSpeed = forecastWeather?.windSpeed ?? (weather.isLoaded ? weather.windSpeed : undefined);
        const calcWeatherCode = forecastWeather?.weatherCode ?? (weather.isLoaded ? weather.weatherCode : undefined);
        const calcPrecipitation = forecastWeather?.precipitation ?? (weather.isLoaded ? weather.precipitation : undefined);
        const calcRelativeWindAngle = forecastWeather
          ? ((forecastWeather.windDirection - currentHeading + 360) % 360)
          : relativeWindAngle;

        const segmented = estimateSegmentedRouteConsumption(
          [
            { lat: 0, lon: 0, distanceFromStartKm: 0, elevationM: 0 },
            { lat: 0, lon: 0, distanceFromStartKm: distanceKm, elevationM: projectedGainM - projectedLossM },
          ],
          forecastWeather ? [{ distanceFromStartKm: distanceKm, weather: forecastWeather }] : [],
          { temperature: calcTemperature ?? 20, weatherCode: calcWeatherCode ?? 0, precipitation: calcPrecipitation ?? 0, windSpeed: calcWindSpeed ?? 0, windDirection: forecastWeather?.windDirection ?? currentHeading },
          destinationSpeedKmH, sessions, settings.batteryCapacityKwh, climateOn, isTracking ? currentTripStyle.factor : undefined, passengers, undefined,
          settings.curbWeightKg ?? 1600, settings.consumptionScale ?? 1, settings.hasHeatPump ?? true,
        );
        const destForecast = estimateTripConsumption(
          destinationSpeedKmH, calcTemperature, sessions, settings.batteryCapacityKwh, climateOn,
          calcWindSpeed, calcRelativeWindAngle, isTracking ? currentTripStyle.factor : undefined,
          calcWeatherCode, calcPrecipitation, { gainM: projectedGainM, lossM: projectedLossM, distanceKm },
          etaMinutes ? etaMinutes / 60 : distanceKm / Math.max(5, destinationSpeedKmH), segmented.climatePowerKw, passengers,
          settings.curbWeightKg ?? 1600, settings.consumptionScale ?? 1, settings.hasHeatPump ?? true,
        );

        const energyNeededKwh = segmented.energyKwh;
        const predictedSoc = Math.max(0, Number((liveDynamicSoc - (energyNeededKwh / batteryCap) * 100).toFixed(1)));

        setDestinationResult({
          name: `${distanceKm} км по прямой`,
          distanceKm,
          gainM: Math.round(projectedGainM),
          lossM: Math.round(projectedLossM),
          predictedConsumption: destForecast.estimatedConsumption,
          energyNeededKwh: Number(energyNeededKwh.toFixed(2)),
          predictedSoc,
          etaMinutes,
          approximate: true,
          arrivalTimeLabel: etaMinutes
            ? arrivalDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
            : undefined,
          forecastUsed,
          forecastTemperature: forecastWeather?.temperature,
          forecastWindSpeed: forecastWeather?.windSpeed,
          forecastPrecipLabel: destForecast.precipitationLabel,
          windImpactPct: destForecast.windImpactPct,
          precipitationImpactPct: destForecast.precipitationImpactPct,
          temperatureImpactPct: destForecast.temperatureImpactPct,
          climatePowerKw: destForecast.climatePowerKw,
          elevationImpactPct: destForecast.elevationImpactPct,
          elevationDeltaKwh100: destForecast.elevationDeltaKwh100,
          regenEnergyKwh: undefined,
          climateEnergyKwh: Number(((destForecast.climatePowerKw ?? 0) * (etaMinutes ? etaMinutes / 60 : distanceKm / Math.max(5, destinationSpeedKmH))).toFixed(2)),
          speedImpactPct: destForecast.speedImpactPct,
          driverStyleFactor: destForecast.driverStyleFactor,
          breakdown: segmented,
        });
        lastDestRecalcAtRef.current = Date.now();
        lastDestRecalcDistanceRef.current = distanceRef.current;
        return;
      }

      // Address mode: geocode (or use cache) -> real route -> elevation profile along the route
      if (!prevPositionRef.current) {
        if (!silent) setDestinationError('Нет текущих координат GPS. Дождитесь сигнала GPS.');
        return;
      }

      // Prefer cached coordinates during live tracking recalcs to avoid repeated geocoding.
      let geoLat: number;
      let geoLon: number;
      let geoName: string;

      if (silent && cachedDestRef.current) {
        geoLat = cachedDestRef.current.lat;
        geoLon = cachedDestRef.current.lon;
        geoName = cachedDestRef.current.name;
      } else {
        const geo = await geocodeAddress(destinationQuery.trim());
        geoLat = geo.lat;
        geoLon = geo.lon;
        geoName = geo.displayName;
        cachedDestRef.current = { lat: geo.lat, lon: geo.lon, name: geo.displayName };
      }

      const route = await buildRouteElevation(
        prevPositionRef.current.lat,
        prevPositionRef.current.lon,
        geoLat,
        geoLon,
        geoName
      );
      const gainM = route.elevationGainM;
      const lossM = route.elevationLossM;

      const etaMinutes = destinationSpeedKmH > 3 ? Math.round((route.distanceKm / destinationSpeedKmH) * 60) : undefined;
      const arrivalDate = new Date(Date.now() + (etaMinutes ?? 0) * 60000);

      // Load a small number of weather samples along the route. The calculation itself is then
      // performed segment-by-segment; weather between samples is interpolated by distance.
      const routeWeatherSamples = await fetchForecastWeatherAlongRoute(route.points, new Date(), destinationSpeedKmH);
      const forecastWeather = await fetchForecastWeatherAt(geoLat, geoLon, arrivalDate);
      const forecastUsed = forecastWeather !== null;
      const calcTemperature = forecastWeather?.temperature ?? (weather.isLoaded ? weather.temperature : undefined);
      const calcWindSpeed = forecastWeather?.windSpeed ?? (weather.isLoaded ? weather.windSpeed : undefined);
      const calcWeatherCode = forecastWeather?.weatherCode ?? (weather.isLoaded ? weather.weatherCode : undefined);
      const calcPrecipitation = forecastWeather?.precipitation ?? (weather.isLoaded ? weather.precipitation : undefined);

      const routeBearing = calculateBearing(prevPositionRef.current.lat, prevPositionRef.current.lon, geoLat, geoLon);
      const calcRelativeWindAngle = forecastWeather
        ? ((forecastWeather.windDirection - routeBearing + 360) % 360)
        : relativeWindAngle;
      const segmented = estimateSegmentedRouteConsumption(
        route.points,
        routeWeatherSamples.map(s => ({ distanceFromStartKm: s.distanceFromStartKm, weather: s.weather, routeBearing: s.routeBearing })),
        { temperature: calcTemperature ?? 20, weatherCode: calcWeatherCode ?? 0, precipitation: calcPrecipitation ?? 0, windSpeed: calcWindSpeed ?? 0, windDirection: forecastWeather?.windDirection ?? 0 },
        destinationSpeedKmH, sessions, settings.batteryCapacityKwh, climateOn, isTracking ? currentTripStyle.factor : undefined, passengers, undefined,
        settings.curbWeightKg ?? 1600, settings.consumptionScale ?? 1, settings.hasHeatPump ?? true,
      );
      const destForecast = estimateTripConsumption(destinationSpeedKmH, calcTemperature, sessions, settings.batteryCapacityKwh, climateOn, segmented.avgWindSpeed, calcRelativeWindAngle, isTracking ? currentTripStyle.factor : undefined, calcWeatherCode, segmented.avgPrecipitation, { gainM, lossM, distanceKm: route.distanceKm }, segmented.durationHours, segmented.climatePowerKw, passengers, settings.curbWeightKg ?? 1600, settings.consumptionScale ?? 1, settings.hasHeatPump ?? true);
      const energyNeededKwh = segmented.energyKwh;
      const predictedSoc = Math.max(0, Number((liveDynamicSoc - (energyNeededKwh / batteryCap) * 100).toFixed(1)));

      setDestinationResult({
        name: geoName.split(',').slice(0, 3).join(','),
        distanceKm: Number(route.distanceKm.toFixed(1)),
        gainM,
        lossM,
        predictedConsumption: destForecast.estimatedConsumption,
        energyNeededKwh: Number(energyNeededKwh.toFixed(2)),
        predictedSoc,
        etaMinutes,
        approximate: false,
        arrivalTimeLabel: etaMinutes
          ? arrivalDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
          : undefined,
        forecastUsed,
        forecastTemperature: forecastWeather?.temperature,
        forecastWindSpeed: forecastWeather?.windSpeed,
        forecastPrecipLabel: destForecast.precipitationLabel,
        windImpactPct: destForecast.windImpactPct,
        precipitationImpactPct: destForecast.precipitationImpactPct,
        temperatureImpactPct: destForecast.temperatureImpactPct,
        climatePowerKw: destForecast.climatePowerKw,
        elevationImpactPct: destForecast.elevationImpactPct,
        elevationDeltaKwh100: destForecast.elevationDeltaKwh100,
        regenEnergyKwh: route.recoveredEnergyKwh,
        climateEnergyKwh: Number(((destForecast.climatePowerKw ?? 0) * (etaMinutes ? etaMinutes / 60 : 0)).toFixed(2)),
        speedImpactPct: destForecast.speedImpactPct,
        driverStyleFactor: destForecast.driverStyleFactor,
        breakdown: segmented,
      });

      // Record throttle points after successful live/manual recalc
      lastDestRecalcAtRef.current = Date.now();
      lastDestRecalcDistanceRef.current = distanceRef.current;
    } catch (e) {
      // geocodeAddress / buildRouteElevation throw with a specific, user-readable message
      // (e.g. "Адрес не найден", "Не удалось построить маршрут") — surface that directly
      // instead of a generic network error, same as the Calculator tab's route planner does.
      // Silent live recalcs fail quietly — keep the previous result visible.
      if (!silent) {
        const msg = e instanceof Error ? e.message : '';
        setDestinationError(msg || 'Ошибка сети при расчете маршрута. Проверьте соединение.');
      }
    } finally {
      if (!silent) {
        setDestinationBusy(false);
      }
      destRecalcInFlightRef.current = false;
    }
  };

  // === LIVE SoC-at-destination recalculation while tracking ===
  // The most important feature: keep "SOC на финише" up to date during the trip.
  // Throttled by time (≈45 s) OR distance (≈1.5 km) so we don't spam routing/elevation APIs.
  // Between full recalcs the displayed value still moves live because it is derived from
  // the current liveDynamicSoc + last known energyNeededKwh.
  useEffect(() => {
    if (!isTracking || !destinationQuery.trim()) return;

    const RECALC_INTERVAL_MS = 45 * 1000;
    const RECALC_EVERY_KM = 1.5;
    const CHECK_EVERY_MS = 8 * 1000;

    const maybeRecalc = () => {
      if (!prevPositionRef.current) return;
      if (destRecalcInFlightRef.current || destinationBusy) return;
      // Only while actually moving — no point recalculating at a red light.
      if (latestGpsSpeedRef.current < 3) return;

      const now = Date.now();
      const dist = distanceRef.current;
      const timeOk = now - lastDestRecalcAtRef.current >= RECALC_INTERVAL_MS;
      const distOk = dist - lastDestRecalcDistanceRef.current >= RECALC_EVERY_KM;

      if (timeOk || distOk) {
        void handleCalculateDestination({ silent: true });
      }
    };

    const interval = window.setInterval(maybeRecalc, CHECK_EVERY_MS);
    return () => window.clearInterval(interval);
  }, [isTracking, destinationQuery, destinationBusy]);

  // Start tracking first so GPS can establish the current position. If a destination was
  // entered, the live destination forecast can then be calculated from that GPS position.
  const handleStartWithLiveForecast = async () => {
    handleStartTracking();
    if (destinationQuery.trim()) {
      // Give the geolocation watcher a moment to receive the first valid position.
      window.setTimeout(() => {
        if (prevPositionRef.current) {
          void handleCalculateDestination();
        }
      }, 1200);
    }
  };

  const liveTripConsumption =
    tripDistanceKm > 0.05 && energySpentKwh > 0.01
      ? Number(((energySpentKwh / tripDistanceKm) * 100).toFixed(1))
      : Number(forecast.estimatedConsumption.toFixed(1));

  const glass = isDark
    ? 'bg-slate-950/70 border-white/10 text-white backdrop-blur-md'
    : 'bg-white/80 border-slate-200/80 text-slate-900 backdrop-blur-md';

  // Shared fullscreen map layer (pre-start + driving)
  // Prefer planned route geometry; if the user started tracking without a plan, still show
  // a map centered on the live (or last) GPS fix so portrait HUD is never a blank panel.
  const mapPointsForHud =
    hudRoutePoints.length >= 2
      ? hudRoutePoints
      : mapLivePosition
        ? [
            {
              lat: mapLivePosition.lat,
              lon: mapLivePosition.lon,
              elevationM: 0,
              distanceFromStartKm: 0,
            },
            {
              lat: mapLivePosition.lat + 0.0008,
              lon: mapLivePosition.lon + 0.0008,
              elevationM: 0,
              distanceFromStartKm: 0.1,
            },
          ]
        : [];


  // Live free slots for the EVSE card opened from the map
  useEffect(() => {
    if (!selectedMapStop || selectedMapStop.kind !== 'charge') {
      setMapStopLive(null);
      return;
    }
    if (!Number.isFinite(selectedMapStop.lat) || !Number.isFinite(selectedMapStop.lon)) {
      setMapStopLive({ loading: false, freeCcs: 0, totalCcs: 0, error: 'Нет координат' });
      return;
    }
    let cancelled = false;
    setMapStopLive({ loading: true, freeCcs: 0, totalCcs: 0 });
    (async () => {
      try {
        const vehicleConnectors = resolveEffectiveConnectors(
          settings.vehicleProfileId,
          settings.connectorOverride as any,
        );
        const { results } = await findNearbyFreeCcsChargers(
          { lat: selectedMapStop.lat!, lon: selectedMapStop.lon! },
          { radiusKm: 4, limit: 12, vehicleConnectors },
        );
        if (cancelled) return;
        const match =
          results.find(
            (r) =>
              (selectedMapStop.stationId && r.station.id === selectedMapStop.stationId) ||
              (Math.abs(r.station.lat - selectedMapStop.lat!) < 1e-4 &&
                Math.abs(r.station.lon - selectedMapStop.lon!) < 1e-4),
          ) || results[0];
        if (!match) {
          setMapStopLive({
            loading: false,
            freeCcs: 0,
            totalCcs: 0,
            error: 'Live-статус недоступен',
          });
          return;
        }
        setMapStopLive({
          loading: false,
          freeCcs: match.freeCcs,
          totalCcs: match.totalCcs,
          matchedConnector: match.matchedConnector,
        });
      } catch (e) {
        if (!cancelled) {
          setMapStopLive({
            loading: false,
            freeCcs: 0,
            totalCcs: 0,
            error: e instanceof Error ? e.message : 'Ошибка live-статуса',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedMapStop, settings.vehicleProfileId, settings.connectorOverride]);

  const mapLayer = (
    <div className="absolute inset-0 h-full w-full">
      {mapPointsForHud.length >= 2 ? (
        <RouteMap
          points={mapPointsForHud}
          isDark={isDark}
          fill
          currentPosition={isTracking ? mapLivePosition : null}
          followMode={isTracking && !!mapLivePosition}
          headingDeg={isTracking ? (gpsHeading ?? lastHeadingRef.current ?? 0) : null}
          moveSpeedKmH={isTracking ? currentSpeed : null}
          chargingStops={routeWaypoints
            .filter((w) => w.kind === 'charge' && Number.isFinite(w.lat) && Number.isFinite(w.lon))
            .map((w) => ({
              id: w.stationId || `${w.lat},${w.lon}`,
              lat: w.lat!,
              lon: w.lon!,
              name: w.name,
              address: w.address,
            }))}
          onChargingStopClick={(stop) => {
            triggerHaptic('light', settings.hapticFeedback);
            const match = routeWaypoints.find(
              (w) =>
                w.kind === 'charge' &&
                ((w.stationId && w.stationId === stop.id) ||
                  (Number.isFinite(w.lat) &&
                    Number.isFinite(w.lon) &&
                    Math.abs(w.lat! - stop.lat) < 1e-5 &&
                    Math.abs(w.lon! - stop.lon) < 1e-5)),
            );
            setSelectedMapStop(
              match || {
                kind: 'charge',
                name: stop.name,
                distanceAlongRouteKm: 0,
                lat: stop.lat,
                lon: stop.lon,
                address: stop.address,
                stationId: stop.id,
              },
            );
          }}
        />
      ) : (
        <div className={`absolute inset-0 flex items-center justify-center text-xs ${isDark ? 'bg-slate-900 text-slate-500' : 'bg-slate-200 text-slate-500'}`}>
          Ожидание GPS…
        </div>
      )}
    </div>
  );


  // Sit above floating bottom nav; in landscape also clear trip controls (passengers / STOP).
  const hudEvseCard = selectedMapStop ? (
    <div
      className={`pointer-events-auto absolute left-1/2 z-40 w-[min(22rem,calc(100%-1.25rem))] -translate-x-1/2 rounded-2xl border p-3 shadow-2xl backdrop-blur-md overflow-y-auto overscroll-contain ${
        isDark
          ? 'border-amber-700/40 bg-slate-950/95 text-slate-100'
          : 'border-amber-200 bg-white/95 text-slate-900'
      }`}
      style={{
        bottom: isLandscape
          ? 'calc(7.5rem + env(safe-area-inset-bottom, 0px))'
          : 'calc(6.25rem + env(safe-area-inset-bottom, 0px))',
        maxHeight: isLandscape
          ? 'calc(100dvh - 9rem - env(safe-area-inset-bottom, 0px))'
          : 'calc(100dvh - 10rem - env(safe-area-inset-bottom, 0px))',
      }}
    >
      <div className="flex items-start gap-2">
        <div className={`mt-0.5 rounded-lg p-1.5 ${isDark ? 'bg-amber-500/15 text-amber-400' : 'bg-amber-50 text-amber-700'}`}>
          <PlugZap className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-[13px] font-bold leading-tight">{selectedMapStop.name}</p>
              {selectedMapStop.address && (
                <p className={`truncate text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {selectedMapStop.address}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setSelectedMapStop(null)}
              className={`rounded-lg p-1 ${isDark ? 'text-slate-400 hover:text-white' : 'text-slate-500 hover:text-slate-800'}`}
              aria-label="Закрыть"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {selectedMapStop.operator && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${isDark ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>
                {selectedMapStop.operator}
              </span>
            )}
            {selectedMapStop.connectorLabel && (
              <span className="rounded-full bg-amber-600/90 px-2 py-0.5 text-[10px] font-semibold text-white">
                {selectedMapStop.connectorLabel}
              </span>
            )}
            {selectedMapStop.ccs2PowerKw != null && selectedMapStop.ccs2PowerKw > 0 && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${isDark ? 'bg-slate-800 text-cyan-300' : 'bg-cyan-50 text-cyan-700'}`}>
                CCS · {Math.round(selectedMapStop.ccs2PowerKw)} кВт
              </span>
            )}
            {selectedMapStop.gbtPowerKw != null && selectedMapStop.gbtPowerKw > 0 && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${isDark ? 'bg-slate-800 text-cyan-300' : 'bg-cyan-50 text-cyan-700'}`}>
                GB/T · {Math.round(selectedMapStop.gbtPowerKw)} кВт
              </span>
            )}
            {selectedMapStop.type2PowerKw != null && selectedMapStop.type2PowerKw > 0 && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${isDark ? 'bg-slate-800 text-cyan-300' : 'bg-cyan-50 text-cyan-700'}`}>
                Type2 · {Math.round(selectedMapStop.type2PowerKw)} кВт
              </span>
            )}
            {selectedMapStop.plannedArrivalSoc != null && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${isDark ? 'bg-slate-800 text-emerald-300' : 'bg-emerald-50 text-emerald-700'}`}>
                Прибытие ~{Math.round(selectedMapStop.plannedArrivalSoc)}%
              </span>
            )}
            {selectedMapStop.chargeTargetSoc != null && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${isDark ? 'bg-slate-800 text-emerald-300' : 'bg-emerald-50 text-emerald-700'}`}>
                Заряд до {Math.round(selectedMapStop.chargeTargetSoc)}%
              </span>
            )}
          </div>

          {/* Live free ports */}
          <div className={`mt-2.5 rounded-xl border px-2.5 py-2 ${isDark ? 'border-slate-800 bg-slate-900/80' : 'border-slate-200 bg-slate-50'}`}>
            <div className={`text-[10px] font-bold uppercase tracking-wide mb-1 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
              Свободные слоты
            </div>
            {mapStopLive?.loading ? (
              <div className={`flex items-center gap-1.5 text-[12px] ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Проверяем доступность…
              </div>
            ) : mapStopLive?.error && !mapStopLive.totalCcs ? (
              <div className={`text-[12px] ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                {mapStopLive.error}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-bold ${
                    (mapStopLive?.freeCcs ?? 0) > 0
                      ? 'bg-emerald-600 text-white'
                      : isDark
                        ? 'bg-slate-800 text-slate-300'
                        : 'bg-slate-200 text-slate-700'
                  }`}
                >
                  {(mapStopLive?.matchedConnector === 'gbt' ? 'GB/T' : 'CCS')}{' '}
                  {mapStopLive?.freeCcs ?? 0}
                  {mapStopLive?.totalCcs != null && mapStopLive.totalCcs > 0
                    ? ` / ${mapStopLive.totalCcs}`
                    : ''}
                  {(mapStopLive?.freeCcs ?? 0) > 0 ? ' свободно' : ' занято'}
                </span>
                {mapStopLive && (mapStopLive.freeCcs ?? 0) > 0 && (
                  <span className="text-[11px] font-semibold text-emerald-500">● Live</span>
                )}
                {mapStopLive && (mapStopLive.freeCcs ?? 0) === 0 && mapStopLive.totalCcs > 0 && (
                  <span className="text-[11px] font-semibold text-rose-400">Нет свободных</span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  ) : null;

  // Save dialog must live outside tracking-only branches — after STOP isTracking becomes false
  // and we often land on pre-start (route still present).
  // z-[60] above floating bottom nav (z-50). Extra bottom padding keeps action buttons clear of the nav bar in landscape.
  const completedTripModal = completedTripSummary ? (
    <div
      className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-md flex items-center justify-center px-4 pt-4"
      style={{
        paddingBottom: 'calc(5.75rem + env(safe-area-inset-bottom, 0px))',
      }}
    >
      <div className={`border rounded-3xl max-w-md w-full p-5 space-y-4 shadow-2xl text-left max-h-[min(78dvh,calc(100dvh-7.5rem))] overflow-y-auto overscroll-contain ${
        isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900'
      }`}>
        <div className={`flex items-center justify-between border-b pb-3 ${
          isDark ? 'border-slate-800' : 'border-slate-200'
        }`}>
          <div className="flex items-center gap-2">
            <div className={`p-2 rounded-xl ${
              isDark ? 'bg-cyan-500/20 text-cyan-400' : 'bg-cyan-100 text-cyan-700'
            }`}>
              <Check className="w-5 h-5" />
            </div>
            <div>
              <h3 className={`text-base font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                Поездка завершена
              </h3>
              <span className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                SoC: {Math.round(completedTripSummary.startSoc)}% → {Math.round(completedTripSummary.endSoc)}%
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCompletedTripSummary(null)}
            className={`text-sm ${isDark ? 'text-slate-400 hover:text-white' : 'text-slate-500 hover:text-slate-900'}`}
          >
            ✕
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div className={`border rounded-xl p-3 ${isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
            <span className={`text-[10px] block font-semibold uppercase ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Дистанция</span>
            <span className={`text-xl font-bold font-mono ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`}>
              {completedTripSummary.distanceKm} км
            </span>
          </div>
          <div className={`border rounded-xl p-3 ${isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
            <span className={`text-[10px] block font-semibold uppercase ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Средняя</span>
            <span className={`text-xl font-bold font-mono ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`}>
              {completedTripSummary.avgSpeedKmH} км/ч
            </span>
          </div>
          <div className={`border rounded-xl p-3 ${isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
            <span className={`text-[10px] block font-semibold uppercase ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>В пути</span>
            <span className={`text-xl font-bold font-mono ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
              {completedTripSummary.durationMinutes} мин
            </span>
          </div>
          <div className={`border rounded-xl p-3 ${isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
            <span className={`text-[10px] block font-semibold uppercase ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Расход</span>
            <span className={`text-xl font-bold font-mono ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
              {completedTripSummary.estimatedCons} кВт⋅ч/100
            </span>
          </div>
        </div>

        <div className={`p-2.5 border rounded-xl text-xs space-y-1 ${
          isDark ? 'bg-slate-950/70 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'
        }`}>
          <div className="flex justify-between gap-2">
            <span>Энергия</span>
            <span className="font-bold font-mono">{completedTripSummary.energyUsedKwh} кВт⋅ч</span>
          </div>
          <div className="flex justify-between gap-2">
            <span>Макс. скорость</span>
            <span className="font-bold font-mono">{completedTripSummary.maxSpeedKmH} км/ч</span>
          </div>
          <div className="flex justify-between gap-2">
            <span>Температура</span>
            <span className="font-bold font-mono">
              {completedTripSummary.temp > 0 ? `+${completedTripSummary.temp}` : completedTripSummary.temp}°C
            </span>
          </div>
        </div>

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={handleSaveTrackedTrip}
            className="flex-1 py-3 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-sm active:scale-[0.98]"
          >
            Сохранить в историю
          </button>
          <button
            type="button"
            onClick={() => setCompletedTripSummary(null)}
            className={`px-4 py-3 rounded-xl border font-semibold text-sm ${
              isDark ? 'border-slate-700 text-slate-300' : 'border-slate-200 text-slate-700'
            }`}
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  ) : null;

  // ── Resume unfinished trip after WebView kill / reload ────────────────
  if (pendingCheckpoint && !isTracking && !completedTripSummary) {
    const cp = pendingCheckpoint;
    const mins = Math.max(1, Math.round(cp.elapsedSeconds / 60));
    const agoMin = Math.max(1, Math.round((Date.now() - cp.savedAt) / 60_000));
    return (
      <div
        id="hud-tab-container"
        className={`relative flex flex-col items-center justify-center gap-4 p-5 select-none ${
          isLandscape ? 'h-[100dvh]' : 'h-[calc(100dvh-7.5rem)] min-h-[420px]'
        } ${isDark ? 'bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-900'}`}
      >
        <div
          className={`w-full max-w-sm rounded-2xl border p-4 shadow-xl ${
            isDark ? 'border-cyan-800/50 bg-slate-900' : 'border-cyan-200 bg-white'
          }`}
        >
          <p className="text-[11px] font-bold uppercase tracking-wide text-cyan-500 mb-1">
            Незавершённая поездка
          </p>
          <p className={`text-sm font-semibold mb-3 ${isDark ? 'text-white' : 'text-slate-900'}`}>
            {cp.tripDistanceKm.toFixed(1)} км · {mins} мин · старт {cp.startTripSoc}% SoC
          </p>
          <p className={`text-[12px] mb-4 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            Сохранено ~{agoMin} мин назад. Продолжить трекинг, сохранить в историю или удалить?
          </p>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('success', settings.hapticFeedback);
                applyCheckpoint(cp);
              }}
              className="w-full rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-sm py-3"
            >
              Продолжить
            </button>
            <button
              type="button"
              onClick={() => {
                triggerHaptic('medium', settings.hapticFeedback);
                const finalDistance = Number((cp.distanceKm || cp.tripDistanceKm).toFixed(1));
                const finalMinutes = Math.max(1, Math.round(cp.elapsedSeconds / 60));
                const finalEnergy = Number(
                  (
                    (cp.segmentEnergyKwh || 0) +
                    (cp.elevationEnergyKwh || 0) +
                    (cp.climateEnergyKwh || 0)
                  ).toFixed(2),
                );
                const finalEndSoc = Math.max(
                  0,
                  Math.round(
                    cp.startTripSoc -
                      (finalEnergy / (settings.batteryCapacityKwh || 51.87)) * 100,
                  ),
                );
                distanceRef.current = cp.distanceKm;
                segmentEnergyKwhRef.current = cp.segmentEnergyKwh;
                elevationEnergyKwhRef.current = cp.elevationEnergyKwh;
                climateEnergyKwhRef.current = cp.climateEnergyKwh;
                windLogRef.current = Array.isArray(cp.windLog) ? [...(cp.windLog as any[])] : [];
                setStartTripSoc(cp.startTripSoc);
                setClimateOn(cp.climateOn);
                setPassengers(cp.passengers);
                setCompletedTripSummary({
                  distanceKm: finalDistance,
                  avgSpeedKmH:
                    finalMinutes > 0
                      ? Math.min(160, Math.round((finalDistance / finalMinutes) * 60))
                      : cp.maxSpeed,
                  maxSpeedKmH: cp.maxSpeed,
                  durationMinutes: finalMinutes,
                  estimatedCons:
                    finalDistance > 0.1
                      ? Number(((finalEnergy / finalDistance) * 100).toFixed(1))
                      : 0,
                  temp: outdoorTempRef.current,
                  windStatus: '',
                  precipitationStatus: '',
                  roadSurface: '',
                  startSoc: cp.startTripSoc,
                  endSoc: finalEndSoc,
                  energyUsedKwh: finalEnergy,
                  styleFactor: 1,
                  styleLabel: 'Восстановлено',
                  segmentEnergyKwhAtStop: Number((cp.segmentEnergyKwh || 0).toFixed(3)),
                  elevationEnergyKwhAtStop: Number((cp.elevationEnergyKwh || 0).toFixed(3)),
                  climateEnergyKwhAtStop: Number((cp.climateEnergyKwh || 0).toFixed(3)),
                  climatePowerKwAtStop: 0,
                });
                clearHudCheckpoint();
                setPendingCheckpoint(null);
              }}
              className={`w-full rounded-xl border font-semibold text-sm py-2.5 ${
                isDark
                  ? 'border-slate-600 text-slate-200 hover:bg-slate-800'
                  : 'border-slate-200 text-slate-800 hover:bg-slate-50'
              }`}
            >
              Сохранить в историю
            </button>
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light', settings.hapticFeedback);
                clearHudCheckpoint();
                setPendingCheckpoint(null);
              }}
              className={`w-full rounded-xl text-sm py-2 ${
                isDark ? 'text-slate-500 hover:text-rose-400' : 'text-slate-400 hover:text-rose-600'
              }`}
            >
              Удалить
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Pre-start: route from Calculator, map + compact controls ────────────
  // Prefer map-first pre-start whenever a plan destination or geometry exists
  // (avoids falling through to the legacy form UI).
  if (!isTracking && (hudRoutePoints.length >= 2 || !!destinationQuery.trim())) {
    return (
      <div
        id="hud-tab-container"
        className={`relative overflow-hidden select-none ${
          isLandscape
            ? 'h-[100dvh] min-h-0 max-h-none rounded-none border-0'
            : 'h-[calc(100dvh-7.5rem)] min-h-[480px] max-h-[980px] rounded-3xl'
        } ${isDark ? 'bg-slate-950 border border-slate-800' : 'bg-slate-100 border border-slate-200'}`}
      >
        {mapLayer}
        {hudEvseCard}

        {completedTripModal}

        {/* Center-bottom panel — above floating nav + Yandex attribution */}
        <div
          className="pointer-events-none absolute inset-x-0 z-20 px-2.5 pt-2 flex justify-center"
          style={{ bottom: 'calc(4.75rem + env(safe-area-inset-bottom, 0px))' }}
        >
          <div className={`pointer-events-auto w-full max-w-md sm:max-w-sm landscape:max-w-[22rem] rounded-2xl border p-3 space-y-2.5 shadow-xl ${glass}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[10px] font-bold uppercase opacity-60">Маршрут готов</div>
                <div className="text-[13px] font-semibold truncate">
                  {destinationQuery || destinationResult?.name || 'Назначение'}
                </div>
                {destinationResult && (
                  <div className="mt-0.5 text-[11px] opacity-70">
                    {destinationResult.distanceKm} км
                    {destinationResult.arrivalTimeLabel ? ` · ETA ${destinationResult.arrivalTimeLabel}` : ''}
                  </div>
                )}
              </div>
              <div className="text-right shrink-0">
                <div className="text-[10px] font-bold uppercase opacity-60">SOC на финише</div>
                <div className={`text-2xl font-black font-mono tabular-nums ${
                  (livePredictedSoc ?? 100) < 20 ? 'text-rose-400' : (livePredictedSoc ?? 100) < 40 ? 'text-amber-400' : 'text-cyan-300'
                }`}>
                  {livePredictedSoc != null ? `${Math.round(livePredictedSoc)}%` : '—'}
                </div>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-bold opacity-70">SOC на старте</span>
                <span className="text-sm font-black font-mono">{startTripSoc}%</span>
              </div>
              <input
                type="range"
                min={1}
                max={100}
                value={startTripSoc}
                onChange={(e) => setStartTripSoc(Number(e.target.value))}
                className="w-full accent-cyan-500 h-1.5"
              />
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 rounded-xl border border-white/10 px-1.5 py-1">
                <button type="button" onClick={() => setPassengers((p) => Math.max(1, p - 1))} className="w-8 h-8 rounded-lg font-bold text-sm">−</button>
                <span className="text-[12px] font-bold min-w-[3rem] text-center">👥 {passengers}</span>
                <button type="button" onClick={() => setPassengers((p) => Math.min(5, p + 1))} className="w-8 h-8 rounded-lg font-bold text-sm">+</button>
              </div>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light', settings.hapticFeedback);
                  setClimateOn((v) => !v);
                }}
                className={`rounded-xl border border-white/10 px-3 py-2 text-[12px] font-bold ${
                  climateOn ? 'ring-1 ring-cyan-400/50' : 'opacity-70'
                }`}
              >
                {climateOn ? 'Климат вкл' : 'Климат выкл'}
              </button>
            </div>

            <button
              type="button"
              onClick={handleStartWithLiveForecast}
              className="w-full rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-black text-[15px] py-3.5 active:scale-[0.98] shadow-lg shadow-cyan-900/30"
            >
              Начать поездку
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Map-first driving mode ──────────────────────────────────────────────
  if (isTracking) {
    const rangeShown = displayRangeKm || dynamicRemainingRangeKm;

    const socColor =
      liveDynamicSoc < 20 ? 'text-rose-400' : liveDynamicSoc < 40 ? 'text-amber-400' : 'text-cyan-300';
    const finishSoc = Math.round(liveSocAtActiveWaypoint ?? livePredictedSoc ?? 0);

    // Portrait-only compact metrics strip
    const metricsBlock = (
      <>
        <div className="flex items-center gap-2 min-w-0">
          <div className="shrink-0 text-center w-[3.1rem]">
            <div className="text-[1.65rem] font-black font-mono tabular-nums leading-none whitespace-nowrap">
              {currentSpeed}
            </div>
            <div className="text-[9px] font-bold uppercase opacity-60 whitespace-nowrap">км/ч</div>
          </div>
          <div className={`w-px self-stretch shrink-0 ${isDark ? 'bg-white/10' : 'bg-slate-300/60'}`} />
          <div className="min-w-0 flex-1 grid grid-cols-3 gap-1 text-center">
            <div className="min-w-0">
              <div className="text-[9px] font-bold uppercase opacity-60 whitespace-nowrap">SOC</div>
              <div className={`text-[15px] font-black font-mono tabular-nums leading-none whitespace-nowrap ${socColor}`}>
                {Math.round(liveDynamicSoc)}%
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-[9px] font-bold uppercase opacity-60 whitespace-nowrap">Расход</div>
              <div className="text-[15px] font-black font-mono tabular-nums leading-none whitespace-nowrap">
                {liveTripConsumption}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-[9px] font-bold uppercase opacity-60 whitespace-nowrap">Запас</div>
              <div className="text-[15px] font-black font-mono tabular-nums leading-none whitespace-nowrap">
                {rangeShown}<span className="text-[9px] font-bold opacity-60">км</span>
              </div>
            </div>
          </div>
          <div className={`w-px self-stretch shrink-0 ${isDark ? 'bg-white/10' : 'bg-slate-300/60'}`} />
          <div className="shrink-0 text-[10px] leading-none space-y-1 text-right font-mono whitespace-nowrap">
            <div className="flex items-center justify-end gap-1">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${gpsAccuracy != null && gpsAccuracy <= 15 ? 'bg-cyan-400' : gpsAccuracy != null ? 'bg-amber-400' : 'bg-rose-500'}`} />
              <span className="font-bold tabular-nums">{gpsAccuracy != null ? `±${gpsAccuracy}` : '…'}</span>
            </div>
            <div className="font-bold tabular-nums">
              {weather.isLoaded ? `${weather.temperature > 0 ? '+' : ''}${weather.temperature}°` : '—'}
            </div>
            <div className={`flex items-center justify-end gap-0.5 font-bold ${windInfo.color}`}>
              <ArrowDown className="w-3 h-3 shrink-0" style={{ transform: `rotate(${windInfo.arrowRotation}deg)` }} />
              <span className="tabular-nums">{weather.isLoaded ? `${windSpeedMs}` : '—'}</span>
              <span className="opacity-60 font-semibold">м/с</span>
            </div>
          </div>
        </div>
        {activeWaypoint && (
          <div className={`mt-2 pt-2 border-t flex items-center justify-between gap-2 min-w-0 ${isDark ? 'border-white/10' : 'border-slate-300/50'}`}>
            <div className="min-w-0 flex items-center gap-1.5 overflow-hidden">
              {activeWaypoint.kind === 'charge' ? (
                <PlugZap className="w-3.5 h-3.5 shrink-0 text-amber-400" />
              ) : (
                <Flag className="w-3.5 h-3.5 shrink-0 text-cyan-400" />
              )}
              <div className="min-w-0 overflow-hidden">
                <div className="text-[10px] font-bold uppercase opacity-60 truncate">
                  {activeWaypoint.kind === 'charge' ? 'До зарядки' : 'До финиша'}
                  {destinationResult?.arrivalTimeLabel ? ` · ${destinationResult.arrivalTimeLabel}` : ''}
                </div>
                <div className="text-[11px] font-semibold truncate">{activeWaypoint.name}</div>
              </div>
            </div>
            <div className="text-right shrink-0 whitespace-nowrap">
              <div className="text-[9px] font-bold uppercase opacity-60">SOC на финише</div>
              <div className="text-base font-black font-mono tabular-nums leading-none">
                {finishSoc}%
                {remainingKmToActiveWaypoint != null && (
                  <span className="ml-1 text-[10px] font-bold opacity-60">
                    · {remainingKmToActiveWaypoint < 1
                      ? `${Math.round(remainingKmToActiveWaypoint * 1000)} м`
                      : `${remainingKmToActiveWaypoint.toFixed(1)} км`}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </>
    );

    const controlsBlock = (
      <div className="flex items-center gap-1.5 w-full min-w-0 overflow-hidden">
        <div className={`flex items-center gap-0.5 rounded-xl border px-1 py-0.5 shrink-0 ${glass}`}>
          <button type="button" onClick={() => setPassengers((p) => Math.max(1, p - 1))} className="w-7 h-7 rounded-lg font-bold text-sm opacity-80">−</button>
          <span className="text-[11px] font-bold min-w-[2.75rem] text-center tabular-nums">👥 {passengers}</span>
          <button type="button" onClick={() => setPassengers((p) => Math.min(5, p + 1))} className="w-7 h-7 rounded-lg font-bold text-sm opacity-80">+</button>
        </div>
        <button
          type="button"
          onClick={() => {
            triggerHaptic('light', settings.hapticFeedback);
            setClimateOn((v) => !v);
          }}
          className={`rounded-xl border px-2 py-1.5 text-[11px] font-bold shrink min-w-0 ${glass} ${
            climateOn ? 'ring-1 ring-cyan-400/50' : 'opacity-70'
          }`}
        >
          {climateOn ? 'Климат' : 'Без кл.'}
        </button>
        <button
          type="button"
          onClick={handleStopPress}
          className={`ml-auto shrink-0 rounded-xl bg-rose-600 text-white font-black text-[12px] px-3 py-2 flex items-center justify-center gap-1 shadow-lg shadow-rose-900/40 active:scale-[0.98] ${armedAction === 'stop' ? 'ring-2 ring-white animate-pulse' : ''}`}
        >
          <Square className="w-3.5 h-3.5 fill-current" /> {armedAction === 'stop' ? 'ЕЩЁ РАЗ' : 'СТОП'}
        </button>
      </div>
    );

    const telemetryBlock = (
      <div className={`rounded-2xl border px-2 py-1.5 grid grid-cols-3 gap-1 ${glass}`}>
        <div className="text-center">
          <div className="text-[9px] font-bold uppercase opacity-60">В пути</div>
          <div className="text-sm font-black font-mono tabular-nums">{formatTime(elapsedSeconds)}</div>
        </div>
        <div className="text-center">
          <div className="text-[9px] font-bold uppercase opacity-60">Средняя</div>
          <div className="text-sm font-black font-mono tabular-nums">{avgTripSpeedKmH} <span className="text-[9px] opacity-60">км/ч</span></div>
        </div>
        <div className="text-center">
          <div className="text-[9px] font-bold uppercase opacity-60">Дистанция</div>
          <div className="text-sm font-black font-mono tabular-nums">{tripDistanceKm.toFixed(1)} <span className="text-[9px] opacity-60">км</span></div>
        </div>
      </div>
    );

    return (
      <div
        id="hud-tab-container"
        className={`relative overflow-hidden select-none ${
          isLandscape
            ? 'h-[100dvh] min-h-0 max-h-none rounded-none border-0'
            : 'h-[calc(100dvh-7.5rem)] min-h-[480px] max-h-[980px] rounded-3xl'
        } ${isDark ? 'bg-slate-950 border border-slate-800' : 'bg-slate-100 border border-slate-200'}`}
      >
        {completedTripModal}

        <div className="absolute inset-0 z-0">
          {mapLayer}
          {hudEvseCard}
        </div>

        {/* Landscape: left info column + right-bottom controls. Map stays open on the right. */}
        {isLandscape && (
          <>
            {/* Left cluster — glanceable, does not span the screen */}
            <div
              className="pointer-events-none absolute left-2 top-2 z-20 flex flex-col gap-1.5"
              style={{ maxHeight: 'calc(100% - 5.5rem - env(safe-area-inset-bottom, 0px))' }}
            >
              <div className={`pointer-events-auto w-[13.5rem] rounded-2xl border px-3 py-2.5 shadow-xl ${glass}`}>
                {/* Speed hero */}
                <div className="text-center">
                  <div className="text-[3.1rem] leading-none font-black font-mono tabular-nums tracking-tight">
                    {currentSpeed}
                  </div>
                  <div className="text-[10px] font-bold uppercase opacity-55 mt-0.5">км/ч</div>
                </div>

                <div className={`my-2 h-px ${isDark ? 'bg-white/12' : 'bg-slate-300/50'}`} />

                {/* Primary metrics */}
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[10px] font-bold uppercase opacity-55">SOC</span>
                    <span className={`text-xl font-black font-mono tabular-nums leading-none ${socColor}`}>
                      {Math.round(liveDynamicSoc)}%
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[10px] font-bold uppercase opacity-55">Расход</span>
                    <span className="text-xl font-black font-mono tabular-nums leading-none">
                      {liveTripConsumption}
                      <span className="text-[10px] font-semibold opacity-50 ml-0.5">/100</span>
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[10px] font-bold uppercase opacity-55">Запас</span>
                    <span className="text-xl font-black font-mono tabular-nums leading-none">
                      {rangeShown}
                      <span className="text-[10px] font-semibold opacity-50 ml-0.5">км</span>
                    </span>
                  </div>
                </div>

                <div className={`my-2 h-px ${isDark ? 'bg-white/12' : 'bg-slate-300/50'}`} />

                {/* Trip strip */}
                <div className="grid grid-cols-3 gap-1.5 text-center">
                  <div>
                    <div className="text-[9px] font-bold uppercase opacity-50">В пути</div>
                    <div className="text-sm font-black font-mono tabular-nums leading-tight">{formatTime(elapsedSeconds)}</div>
                  </div>
                  <div>
                    <div className="text-[9px] font-bold uppercase opacity-50">Средн.</div>
                    <div className="text-sm font-black font-mono tabular-nums leading-tight">{avgTripSpeedKmH}</div>
                  </div>
                  <div>
                    <div className="text-[9px] font-bold uppercase opacity-50">Км</div>
                    <div className="text-sm font-black font-mono tabular-nums leading-tight">{tripDistanceKm.toFixed(1)}</div>
                  </div>
                </div>

                <div className={`my-2 h-px ${isDark ? 'bg-white/12' : 'bg-slate-300/50'}`} />

                {/* GPS + weather + wind direction arrow */}
                <div className="space-y-1.5 text-[12px] font-mono">
                  <div className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${gpsAccuracy != null && gpsAccuracy <= 15 ? 'bg-cyan-400' : gpsAccuracy != null ? 'bg-amber-400' : 'bg-rose-500'}`} />
                    <span className="font-bold tabular-nums opacity-90">{gpsAccuracy != null ? `±${gpsAccuracy} м` : 'GPS…'}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 font-bold">
                    <span className="tabular-nums text-sm">
                      {weather.isLoaded ? `${weather.temperature > 0 ? '+' : ''}${weather.temperature}°` : '—'}
                    </span>
                    <span className={`inline-flex items-center gap-1 tabular-nums ${windInfo.color}`}>
                      <ArrowDown
                        className="w-4 h-4 shrink-0"
                        style={{ transform: `rotate(${windInfo.arrowRotation}deg)` }}
                      />
                      <span className="text-sm">{weather.isLoaded ? `${windSpeedMs}` : '—'}</span>
                      <span className="opacity-50 text-[11px]">м/с</span>
                    </span>
                  </div>
                  {weather.isLoaded && windInfo.label && (
                    <div className={`flex items-center gap-1.5 text-[11px] font-bold ${windInfo.color}`}>
                      <ArrowDown
                        className="w-3.5 h-3.5 shrink-0"
                        style={{ transform: `rotate(${windInfo.arrowRotation}deg)` }}
                      />
                      <span className="truncate">{windInfo.label}</span>
                    </div>
                  )}
                </div>

                {activeWaypoint && (
                  <>
                    <div className={`my-2 h-px ${isDark ? 'bg-white/12' : 'bg-slate-300/50'}`} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 text-[10px] font-bold uppercase opacity-55 truncate">
                        {activeWaypoint.kind === 'charge' ? (
                          <PlugZap className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                        ) : (
                          <Flag className="w-3.5 h-3.5 shrink-0 text-cyan-400" />
                        )}
                        {activeWaypoint.kind === 'charge' ? 'До зарядки' : 'До финиша'}
                        {destinationResult?.arrivalTimeLabel ? ` · ${destinationResult.arrivalTimeLabel}` : ''}
                      </div>
                      <div className="text-xs font-semibold truncate leading-tight mt-0.5">{activeWaypoint.name}</div>
                      <div className="mt-1.5 flex items-baseline justify-between gap-1">
                        <span className="text-[10px] font-bold uppercase opacity-55">SOC</span>
                        <span className="text-lg font-black font-mono tabular-nums leading-none">
                          {finishSoc}%
                          {remainingKmToActiveWaypoint != null && (
                            <span className="ml-1 text-[11px] font-bold opacity-55">
                              {remainingKmToActiveWaypoint < 1
                                ? `${Math.round(remainingKmToActiveWaypoint * 1000)} м`
                                : `${remainingKmToActiveWaypoint.toFixed(1)} км`}
                            </span>
                          )}
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Controls: bottom-right, above floating nav */}
            <div
              className="pointer-events-none absolute right-2 z-20 flex items-center gap-2"
              style={{ bottom: 'calc(4.75rem + env(safe-area-inset-bottom, 0px))' }}
            >
              <div className={`pointer-events-auto flex items-center gap-1 rounded-2xl border px-2 py-1.5 ${glass}`}>
                <button type="button" onClick={() => setPassengers((p) => Math.max(1, p - 1))} className="w-8 h-8 rounded-lg font-bold text-base opacity-80">−</button>
                <span className="text-sm font-bold min-w-[3rem] text-center">👥 {passengers}</span>
                <button type="button" onClick={() => setPassengers((p) => Math.min(5, p + 1))} className="w-8 h-8 rounded-lg font-bold text-base opacity-80">+</button>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('light', settings.hapticFeedback);
                    setClimateOn((v) => !v);
                  }}
                  className={`rounded-xl border px-2.5 py-1.5 text-xs font-bold whitespace-nowrap ${
                    isDark ? 'border-white/15' : 'border-slate-300'
                  } ${climateOn ? 'ring-1 ring-cyan-400/50' : 'opacity-70'}`}
                >
                  {climateOn ? 'Климат' : 'Без кл.'}
                </button>
              </div>
              <button
                type="button"
                onClick={handleStopPress}
                className={`pointer-events-auto rounded-2xl bg-rose-600 text-white font-black text-sm px-5 py-2.5 flex items-center gap-1.5 shadow-lg shadow-rose-900/40 active:scale-[0.98] ${armedAction === 'stop' ? 'ring-2 ring-white animate-pulse' : ''}`}
              >
                <Square className="w-4 h-4 fill-current" /> {armedAction === 'stop' ? 'ЕЩЁ РАЗ' : 'СТОП'}
              </button>
            </div>
          </>
        )}

        {/* Portrait overlays */}
        {!isLandscape && (
          <>
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 p-2 flex justify-center">
              <div className={`pointer-events-auto w-full max-w-md rounded-2xl border px-2.5 py-2 space-y-2 shadow-lg overflow-hidden ${glass}`}>
                {metricsBlock}
                <div className={`border-t pt-2 min-w-0 ${isDark ? 'border-white/10' : 'border-slate-300/40'}`}>
                  {controlsBlock}
                </div>
              </div>
            </div>
            <div
              className="pointer-events-none absolute inset-x-0 z-20 px-2.5 flex justify-center"
              style={{ bottom: 'calc(4.75rem + env(safe-area-inset-bottom, 0px))' }}
            >
              <div className="pointer-events-auto w-full max-w-md">{telemetryBlock}</div>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      id="hud-tab-container"
      className={`relative flex flex-col overflow-hidden select-none transition-all duration-200 ${
        isLandscape
          ? 'h-[100dvh] min-h-0 max-h-none rounded-none'
          : 'h-[calc(100dvh-7.5rem)] min-h-[480px] max-h-[980px] rounded-3xl'
      } ${
        isDark
          ? 'bg-slate-950 text-white border border-slate-800/90 shadow-2xl'
          : 'bg-white text-slate-900 border border-slate-200 shadow-xl'
      }`}
    >
      {/* Scrollable body — map and cards live here; STOP stays in sticky footer */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-3 pb-2 [-webkit-overflow-scrolling:touch]">
      {/* 1. Status */}
      <div
        className={`flex items-center justify-between gap-2 border-b pb-1.5 shrink-0 ${
          isDark ? 'border-slate-800/80' : 'border-slate-200'
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] border shrink-0 ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-slate-100 border-slate-200'}`}>
            <span className={`w-2 h-2 rounded-full ${gpsAccuracy !== null && gpsAccuracy <= 15 ? 'bg-cyan-400 animate-pulse' : gpsAccuracy !== null ? 'bg-amber-400' : 'bg-rose-500'}`} />
            <span className={`font-mono font-bold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
              {gpsAccuracy !== null ? `±${gpsAccuracy}м` : 'GPS…'}
            </span>
          </div>
          <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-mono border shrink-0 ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-slate-100 border-slate-200'}`}>
            <Thermometer className="w-3.5 h-3.5 text-cyan-500" />
            <span className={isDark ? 'text-cyan-300' : 'text-cyan-700'}>
              {weather.isLoaded ? `${weather.temperature > 0 ? '+' : ''}${weather.temperature}°` : '—'}
            </span>
          </div>
          <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-mono border shrink-0 ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-slate-100 border-slate-200'}`}>
            <Wind className="w-3.5 h-3.5 text-sky-500" />
            <span className={isDark ? 'text-sky-300' : 'text-sky-700'}>
              {weather.isLoaded ? `${windSpeedMs}` : '—'}
            </span>
            <span className={`text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>м/с</span>
          </div>
          {isTracking && (
            <span className="text-[11px] font-bold text-cyan-400 shrink-0">● LIVE</span>
          )}
        </div>
        {hudRoutePoints.length >= 2 && (
          <button
            type="button"
            onClick={() => {
              setHudMapOpen((v) => !v);
              triggerHaptic('light', settings.hapticFeedback);
            }}
            title={hudMapOpen ? 'Скрыть карту' : 'Показать карту'}
            className={`p-2 rounded-xl border shrink-0 ${
              hudMapOpen
                ? 'bg-cyan-600 text-white border-cyan-500'
                : isDark
                  ? 'bg-slate-800 text-slate-300 border-slate-700'
                  : 'bg-slate-100 text-slate-700 border-slate-300'
            }`}
          >
            <Navigation className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* 2. Speed */}
      <div className="flex items-end justify-center gap-2.5 shrink-0 leading-none py-0.5">
        <span
          className={`text-6xl font-black font-mono tracking-tighter tabular-nums ${
            isDark
              ? 'text-transparent bg-clip-text bg-gradient-to-b from-white via-slate-100 to-slate-300'
              : 'text-slate-900'
          }`}
        >
          {currentSpeed}
        </span>
        <div className="flex flex-col items-start pb-1">
          <span className={`text-sm font-bold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>км/ч</span>
          {gpsHeading !== null && (
            <span className={`text-[11px] font-mono ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {gpsHeading}°
            </span>
          )}
        </div>
      </div>

      {/* 3. Start SOC */}
      <div
        className={`rounded-2xl border px-3.5 py-2.5 shrink-0 ${
          isDark ? 'bg-slate-900/95 border-slate-700/80' : 'bg-white border-slate-200 shadow-xs'
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className={`block text-[11px] font-extrabold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              {isTracking ? 'SOC сейчас' : 'SOC на старте'}
            </span>
            <span
              className={`font-mono font-black text-3xl leading-none tabular-nums ${
                (isTracking ? liveDynamicSoc : startTripSoc) < 20
                  ? 'text-rose-500'
                  : (isTracking ? liveDynamicSoc : startTripSoc) < 40
                  ? 'text-amber-500'
                  : isDark
                  ? 'text-cyan-400'
                  : 'text-cyan-600'
              }`}
            >
              {Math.round(isTracking ? liveDynamicSoc : startTripSoc)}%
            </span>
          </div>
          {!isTracking ? (
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => setStartTripSoc((prev) => Math.max(1, prev - 5))}
                className={`w-10 h-10 rounded-xl border text-lg font-bold active:scale-95 ${
                  isDark ? 'bg-slate-950 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'
                }`}
              >
                −
              </button>
              <button
                type="button"
                onClick={() => setStartTripSoc((prev) => Math.min(100, prev + 5))}
                className={`w-10 h-10 rounded-xl border text-lg font-bold active:scale-95 ${
                  isDark ? 'bg-slate-950 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'
                }`}
              >
                +
              </button>
            </div>
          ) : (
            <div className={`w-28 h-2.5 rounded-full overflow-hidden ${isDark ? 'bg-slate-950' : 'bg-slate-200'}`}>
              <div
                className={`h-full transition-all duration-300 ${
                  liveDynamicSoc < 20 ? 'bg-rose-500' : liveDynamicSoc < 40 ? 'bg-amber-500' : 'bg-cyan-500'
                }`}
                style={{ width: `${Math.min(100, Math.max(0, liveDynamicSoc))}%` }}
              />
            </div>
          )}
        </div>
        {!isTracking && (
          <input
            type="range"
            min={1}
            max={100}
            step={1}
            value={startTripSoc}
            onChange={(e) => setStartTripSoc(Number(e.target.value))}
            className="w-full h-2 mt-2 accent-cyan-500 cursor-pointer touch-pan-x"
            aria-label="SOC на старте поездки"
          />
        )}
      </div>

      {/* Route map — separate compact block (collapsed by default on first load after plan) */}
      {hudRoutePoints.length >= 2 && (
        <div
          className={`rounded-2xl border overflow-hidden shrink-0 ${
            isDark ? 'bg-slate-900/95 border-slate-700/80' : 'bg-white border-slate-200'
          }`}
        >
          <button
            type="button"
            onClick={() => {
              setHudMapOpen((v) => !v);
              triggerHaptic('light', settings.hapticFeedback);
            }}
            className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left ${
              isDark ? 'text-slate-200' : 'text-slate-800'
            }`}
          >
            <span className="flex items-center gap-2 text-[12px] font-bold">
              <Navigation className={`w-4 h-4 ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`} />
              Карта маршрута
              {routeWaypoints.filter((w) => w.kind === 'charge').length > 0
                ? ` · ${routeWaypoints.filter((w) => w.kind === 'charge').length} ⚡`
                : ''}
            </span>
            <ChevronDown
              className={`w-4 h-4 shrink-0 transition-transform ${hudMapOpen ? 'rotate-180' : ''} ${
                isDark ? 'text-slate-500' : 'text-slate-400'
              }`}
            />
          </button>
          {hudMapOpen && (
            <RouteMap
              points={hudRoutePoints}
              isDark={isDark}
              compact
              currentPosition={isTracking ? mapLivePosition : null}
              chargingStops={routeWaypoints
                .filter((w) => w.kind === 'charge' && Number.isFinite(w.lat) && Number.isFinite(w.lon))
                .map((w) => ({
                  id: w.stationId || `${w.lat},${w.lon}`,
                  lat: w.lat!,
                  lon: w.lon!,
                  name: w.name,
                  address: w.address,
                }))}
              onChargingStopClick={(stop) => {
                triggerHaptic('light', settings.hapticFeedback);
                const match = routeWaypoints.find(
                  (w) =>
                    w.kind === 'charge' &&
                    ((w.stationId && w.stationId === stop.id) ||
                      (Math.abs((w.lat ?? 0) - stop.lat) < 1e-5 && Math.abs((w.lon ?? 0) - stop.lon) < 1e-5)),
                );
                setSelectedMapStop(
                  match || {
                    kind: 'charge',
                    name: stop.name,
                    distanceAlongRouteKm: 0,
                    lat: stop.lat,
                    lon: stop.lon,
                    address: stop.address,
                    stationId: stop.id,
                  },
                );
              }}
            />
          )}
        </div>
      )}

      {/* Multi-stop plan from Calculator: next charge / next leg */}
      {activeWaypoint && (
        <div
          className={`rounded-2xl border px-3.5 py-2.5 shrink-0 ${
            isDark ? 'bg-slate-900/95 border-amber-800/50' : 'bg-amber-50/70 border-amber-200'
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {activeWaypoint.kind === 'charge' ? (
                <PlugZap className={`w-5 h-5 shrink-0 ${isDark ? 'text-amber-400' : 'text-amber-600'}`} />
              ) : (
                <Flag className={`w-5 h-5 shrink-0 ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`} />
              )}
              <div className="min-w-0">
                <span className={`block text-[11px] font-extrabold uppercase tracking-wider ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                  {activeWaypoint.kind === 'charge' ? 'До зарядки' : 'До финиша'}
                  {routeWaypoints.length > 1
                    ? ` · ${Math.min(activeWaypointIndex + 1, routeWaypoints.length)}/${routeWaypoints.length}`
                    : ''}
                </span>
                <span className={`block text-[12px] font-medium truncate ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  {activeWaypoint.name}
                  {activeWaypoint.connectorLabel ? ` · ${activeWaypoint.connectorLabel}` : ''}
                </span>
              </div>
            </div>
            <div className="text-right shrink-0">
              {liveSocAtActiveWaypoint != null ? (
                <span
                  className={`font-mono font-black text-3xl leading-none tabular-nums ${
                    liveSocAtActiveWaypoint < 10
                      ? 'text-rose-500'
                      : liveSocAtActiveWaypoint < 20
                        ? 'text-amber-500'
                        : isDark
                          ? 'text-amber-300'
                          : 'text-amber-700'
                  }`}
                >
                  {Math.round(liveSocAtActiveWaypoint)}%
                </span>
              ) : (
                <span className={`text-2xl font-bold tabular-nums ${isDark ? 'text-slate-600' : 'text-slate-300'}`}>—</span>
              )}
              {remainingKmToActiveWaypoint != null && (
                <span className={`block text-[11px] font-mono mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                  {remainingKmToActiveWaypoint < 1
                    ? `${Math.round(remainingKmToActiveWaypoint * 1000)} м`
                    : `${remainingKmToActiveWaypoint.toFixed(1)} км`}
                </span>
              )}
            </div>
          </div>
          {activeWaypoint.kind === 'charge' && (
            <p className={`mt-1.5 text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
              План: приезд ~{activeWaypoint.plannedArrivalSoc != null ? Math.round(activeWaypoint.plannedArrivalSoc) : '—'}%
              {activeWaypoint.chargeTargetSoc != null
                ? ` → заряд до ~${Math.round(activeWaypoint.chargeTargetSoc)}%`
                : ''}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            {activeWaypointIndex < routeWaypoints.length - 1 && (
              <button
                type="button"
                onClick={() => {
                  setActiveWaypointIndex((i) => Math.min(i + 1, routeWaypoints.length - 1));
                  triggerHaptic('light', settings.hapticFeedback);
                }}
                className={`flex-1 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold flex items-center justify-center gap-1 border ${
                  isDark
                    ? 'bg-slate-950 border-slate-700 text-slate-300'
                    : 'bg-white border-slate-200 text-slate-700'
                }`}
              >
                <SkipForward className="w-3.5 h-3.5" />
                Следующая точка
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setRouteWaypoints([]);
                setActiveWaypointIndex(0);
                setRouteTotalDistanceKm(null);
                setHudRoutePoints([]);
                triggerHaptic('light', settings.hapticFeedback);
              }}
              className={`rounded-lg px-2.5 py-1.5 text-[11px] font-semibold border ${
                isDark
                  ? 'bg-slate-950 border-slate-700 text-slate-400'
                  : 'bg-white border-slate-200 text-slate-500'
              }`}
            >
              Сбросить план
            </button>
          </div>
        </div>
      )}

      {/* 4. Destination + result details */}
      <div
        className={`rounded-2xl border px-3.5 py-2.5 shrink-0 ${
          isDark ? 'bg-slate-900/95 border-cyan-900/50' : 'bg-cyan-50/60 border-cyan-200'
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Flag className={`w-5 h-5 shrink-0 ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`} />
            <div className="min-w-0">
              <span className={`block text-[11px] font-extrabold uppercase tracking-wider ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                SOC на финише
              </span>
              <span className={`block text-[12px] font-medium truncate ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                {destinationResult?.name || 'Укажите адрес назначения'}
              </span>
            </div>
          </div>
          {destinationResult && livePredictedSoc != null ? (
            <RangeGauge
              percent={livePredictedSoc}
              size={76}
              strokeWidth={7}
              isDark={isDark}
              subValue={isTracking ? `сейчас ${Math.round(liveDynamicSoc)}%` : undefined}
            />
          ) : (
            <span className={`text-2xl font-bold tabular-nums ${isDark ? 'text-slate-600' : 'text-slate-300'}`}>—</span>
          )}
        </div>

        <div className="flex items-center gap-1.5 mt-2">
          <div className="relative flex-1 min-w-0">
            <MapPin className={`absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
            <input
              type="text"
              inputMode="text"
              value={destinationQuery}
              onChange={(e) => {
                const next = e.target.value;
                setDestinationQuery(next);
                // Clear cached geo when the user edits the destination so the next
                // calculation (manual or live) will re-geocode the new address.
                if (cachedDestRef.current) {
                  cachedDestRef.current = null;
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCalculateDestination();
              }}
              placeholder="Город, улица, дом…"
              className={`w-full pl-9 pr-3 py-2.5 rounded-xl border text-[14px] ${
                isDark
                  ? 'bg-slate-950 border-slate-800 text-white placeholder:text-slate-600'
                  : 'bg-white border-slate-200 text-slate-900 placeholder:text-slate-400'
              }`}
            />
          </div>
          {!isTracking ? (
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => void handleCalculateDestination()}
                disabled={destinationBusy || !destinationQuery.trim()}
                className={`px-3 py-2.5 rounded-xl border text-[12px] font-bold disabled:opacity-50 ${
                  isDark ? 'bg-slate-950 border-slate-700 text-slate-200' : 'bg-white border-slate-300 text-slate-700'
                }`}
              >
                {destinationBusy ? '…' : 'Расчёт'}
              </button>
              <button
                type="button"
                onClick={handleStartWithLiveForecast}
                disabled={destinationBusy}
                className="px-3.5 py-2.5 rounded-xl bg-cyan-600 active:bg-cyan-500 text-white text-[12px] font-black disabled:opacity-60"
              >
                СТАРТ
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void handleCalculateDestination()}
              disabled={destinationBusy || !destinationQuery.trim()}
              className={`px-3.5 py-2.5 rounded-xl border text-[12px] font-bold shrink-0 disabled:opacity-50 ${
                isDark ? 'bg-slate-950 border-cyan-800 text-cyan-300' : 'bg-white border-cyan-300 text-cyan-700'
              }`}
            >
              {destinationBusy ? '…' : 'Обновить'}
            </button>
          )}
        </div>

        {/* Expanded API result block */}
        {destinationResult && (
          <div
            className={`mt-2.5 rounded-xl border px-3 py-2 space-y-1.5 ${
              isDark ? 'bg-slate-950/90 border-slate-800' : 'bg-white/90 border-slate-200'
            }`}
          >
            <div className={`text-[13px] font-semibold leading-snug ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
              {destinationResult.name}
            </div>

            <div className={`grid grid-cols-3 gap-1.5 text-center ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
              <div className={`rounded-lg px-1.5 py-1.5 ${isDark ? 'bg-slate-900' : 'bg-slate-50'}`}>
                <span className={`block text-[10px] uppercase font-bold ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Дистанция</span>
                <span className="font-mono font-bold text-[15px] tabular-nums">{destinationResult.distanceKm} км</span>
              </div>
              <div className={`rounded-lg px-1.5 py-1.5 ${isDark ? 'bg-slate-900' : 'bg-slate-50'}`}>
                <span className={`block text-[10px] uppercase font-bold ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>ETA</span>
                <span className="font-mono font-bold text-[15px] tabular-nums">
                  {destinationResult.arrivalTimeLabel
                    || (destinationResult.etaMinutes != null ? `~${destinationResult.etaMinutes}м` : '—')}
                </span>
              </div>
              <div className={`rounded-lg px-1.5 py-1.5 ${isDark ? 'bg-slate-900' : 'bg-slate-50'}`}>
                <span className={`block text-[10px] uppercase font-bold ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Энергия</span>
                <span className="font-mono font-bold text-[15px] tabular-nums">{destinationResult.energyNeededKwh.toFixed(1)} кВт⋅ч</span>
              </div>
            </div>

            <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              <span className="font-mono tabular-nums">{destinationResult.predictedConsumption.toFixed(1)} кВт⋅ч/100</span>
              {(destinationResult.gainM > 0 || destinationResult.lossM > 0) && (
                <span className="inline-flex items-center gap-1">
                  <Mountain className="w-3.5 h-3.5 shrink-0" />
                  <span className="font-mono tabular-nums">
                    <span className={isDark ? 'text-amber-300' : 'text-amber-700'}>↑{Math.round(destinationResult.gainM)}м</span>
                    {' / '}
                    <span className={isDark ? 'text-sky-300' : 'text-sky-700'}>↓{Math.round(destinationResult.lossM)}м</span>
                  </span>
                </span>
              )}
              {destinationResult.regenEnergyKwh != null && destinationResult.regenEnergyKwh > 0 && (
                <span className={`font-mono tabular-nums ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`}>
                  рекуп. {destinationResult.regenEnergyKwh.toFixed(2)} кВт⋅ч
                </span>
              )}
            </div>

            {(destinationResult.forecastUsed || destinationResult.forecastTemperature != null) && (
              <div className={`flex flex-wrap items-center gap-x-2.5 gap-y-0.5 pt-0.5 border-t text-[12px] ${
                isDark ? 'border-slate-800 text-slate-300' : 'border-slate-200 text-slate-600'
              }`}>
                <span className="inline-flex items-center gap-1 font-semibold shrink-0">
                  <CloudRain className={`w-3.5 h-3.5 ${isDark ? 'text-sky-400' : 'text-sky-600'}`} />
                  По маршруту
                </span>
                <span className="font-mono tabular-nums">
                  {destinationResult.forecastTemperature != null
                    ? `${destinationResult.forecastTemperature > 0 ? '+' : ''}${Math.round(destinationResult.forecastTemperature)}°`
                    : '—'}
                </span>
                {destinationResult.forecastWindSpeed != null && (
                  <span className="font-mono tabular-nums inline-flex items-center gap-0.5">
                    <Wind className="w-3.5 h-3.5" />
                    {(destinationResult.forecastWindSpeed / 3.6).toFixed(1)} м/с
                  </span>
                )}
                {destinationResult.forecastPrecipLabel && (
                  <span className="truncate">{destinationResult.forecastPrecipLabel}</span>
                )}
              </div>
            )}
          </div>
        )}

        {destinationError && (
          <div className="mt-1.5 text-[12px] text-amber-500">{destinationError}</div>
        )}
      </div>

      {/* 5. Passengers + climate + wind */}
      <div
        className={`rounded-2xl border px-2.5 py-1.5 flex items-center gap-2 shrink-0 ${
          isDark ? 'bg-slate-900/80 border-slate-800' : 'bg-slate-50 border-slate-200'
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
          <div
            className={`w-8 h-8 rounded-full border flex items-center justify-center shrink-0 ${
              isDark ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200'
            }`}
          >
            <ArrowDown
              className={`w-4 h-4 ${windInfo.color}`}
              style={{ transform: `rotate(${windInfo.arrowRotation}deg)` }}
            />
          </div>
          <span className={`text-[12px] font-bold truncate ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
            {weather.isLoaded ? windInfo.label : 'Ветер…'}
          </span>
        </div>

        <div
          className={`flex items-center gap-0.5 shrink-0 rounded-xl border px-1 ${
            isDark ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200'
          }`}
        >
          <button
            type="button"
            onClick={() => setPassengers((p) => Math.max(1, p - 1))}
            className={`w-9 h-9 text-lg font-bold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
            aria-label="Меньше пассажиров"
          >
            −
          </button>
          <span className={`text-[13px] font-bold min-w-[2.5rem] text-center tabular-nums ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
            👤{passengers}
          </span>
          <button
            type="button"
            onClick={() => setPassengers((p) => Math.min(5, p + 1))}
            className={`w-9 h-9 text-lg font-bold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
            aria-label="Больше пассажиров"
          >
            +
          </button>
        </div>

        <button
          type="button"
          onClick={() => setClimateOn(!climateOn)}
          className={`px-3 py-2 rounded-xl border text-[12px] font-bold shrink-0 ${
            climateOn
              ? outdoorTemp < 19
                ? 'bg-amber-950/70 text-amber-300 border-amber-800'
                : 'bg-cyan-950/70 text-cyan-300 border-cyan-800'
              : isDark
              ? 'bg-slate-950 text-slate-400 border-slate-800'
              : 'bg-white text-slate-600 border-slate-200'
          }`}
        >
          {climateOn ? (outdoorTemp < 19 ? `🔥 +${liveClimate.impactPct}%` : `❄️ +${liveClimate.impactPct}%`) : '🍃 ЭКО'}
        </button>
      </div>

      </div>
      {/* end scrollable body */}

      {/* Sticky footer: always on screen (STOP / telemetry) */}
      <div
        className={`shrink-0 space-y-2 border-t px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] ${
          isDark ? 'border-slate-800/80 bg-slate-950' : 'border-slate-200 bg-white'
        }`}
      >
        {/* 6. Controls */}
        <div className="grid grid-cols-2 gap-2">
          {isTracking ? (
            <>
              <button
                type="button"
                onClick={handleStopPress}
                className={`py-3 rounded-xl bg-rose-600 text-white font-black text-[14px] flex items-center justify-center gap-2 active:scale-[0.98] shadow-lg shadow-rose-900/40 ${armedAction === 'stop' ? 'ring-2 ring-white animate-pulse' : ''}`}
              >
                <Square className="w-4 h-4 fill-current" /> {armedAction === 'stop' ? 'ЕЩЁ РАЗ — ЗАВЕРШИТЬ' : 'СТОП'}
              </button>
              <button
                type="button"
                onClick={handleResetPress}
                className={`py-3 rounded-xl border font-bold text-[14px] flex items-center justify-center gap-2 active:scale-[0.98] ${
                  armedAction === 'reset'
                    ? 'bg-amber-500 text-slate-950 border-amber-300 ring-2 ring-amber-300 animate-pulse'
                    : isDark
                    ? 'bg-slate-800 text-slate-200 border-slate-700'
                    : 'bg-slate-100 text-slate-700 border-slate-300'
                }`}
              >
                <RotateCcw className="w-4 h-4" /> {armedAction === 'reset' ? 'СТЕРЕТЬ ТРЕК?' : 'СБРОС'}
              </button>
            </>
          ) : (
            <div className={`col-span-2 text-center py-1 text-[12px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              {trackingStopMessage || 'Введите адрес и SOC → Расчёт / СТАРТ'}
            </div>
          )}
        </div>

        {/* 7. Telemetry */}
        <div
          className={`rounded-xl border grid grid-cols-3 divide-x ${
            isDark ? 'bg-slate-900/70 border-slate-800 divide-slate-800' : 'bg-slate-50 border-slate-200 divide-slate-200'
          }`}
        >
          <div className="py-1.5 text-center">
            <span className={`block text-[10px] uppercase font-bold ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Дистанция</span>
            <b className={`font-mono text-base tabular-nums ${isDark ? 'text-cyan-300' : 'text-cyan-600'}`}>
              {tripDistanceKm.toFixed(1)}
              <small className="text-[10px]"> км</small>
            </b>
          </div>
          <div className="py-1.5 text-center">
            <span className={`block text-[10px] uppercase font-bold ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>В пути</span>
            <b className={`font-mono text-base tabular-nums ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
              {formatTime(elapsedSeconds)}
            </b>
          </div>
          <div className="py-1.5 text-center">
            <span className={`block text-[10px] uppercase font-bold ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Средняя</span>
            <b className={`font-mono text-base tabular-nums ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`}>
              {avgTripSpeedKmH}
              <small className="text-[10px]"> км/ч</small>
            </b>
          </div>
        </div>
      </div>

      {/* Completed Trip Summary Modal (legacy form branch) */}
      {completedTripSummary && (
        <div
          className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-md flex items-center justify-center px-4 pt-4"
          style={{
            paddingBottom: 'calc(5.75rem + env(safe-area-inset-bottom, 0px))',
          }}
        >
          <div className={`border rounded-3xl max-w-md w-full p-5 space-y-4 shadow-2xl text-left max-h-[min(78dvh,calc(100dvh-7.5rem))] overflow-y-auto overscroll-contain ${
            isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900'
          }`}>
            <div className={`flex items-center justify-between border-b pb-3 ${
              isDark ? 'border-slate-800' : 'border-slate-200'
            }`}>
              <div className="flex items-center gap-2">
                <div className={`p-2 rounded-xl ${
                  isDark ? 'bg-cyan-500/20 text-cyan-400' : 'bg-cyan-100 text-cyan-700'
                }`}>
                  <Check className="w-5 h-5" />
                </div>
                <div>
                  <h3 className={`text-base font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                    Поездка завершена
                  </h3>
                  <span className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    Данные по GPS треку (SoC: {Math.round(completedTripSummary.startSoc)}% → {Math.round(completedTripSummary.endSoc)}%)
                  </span>
                </div>
              </div>
              <button
                onClick={() => setCompletedTripSummary(null)}
                className={`text-sm ${isDark ? 'text-slate-400 hover:text-white' : 'text-slate-500 hover:text-slate-900'}`}
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div className={`border rounded-xl p-3 ${
                isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
              }`}>
                <span className={`text-[10px] block font-semibold uppercase ${
                  isDark ? 'text-slate-400' : 'text-slate-500'
                }`}>
                  Дистанция
                </span>
                <span className={`text-xl font-bold font-mono ${
                  isDark ? 'text-cyan-400' : 'text-cyan-600'
                }`}>
                  {completedTripSummary.distanceKm} км
                </span>
              </div>

              <div className={`border rounded-xl p-3 ${
                isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
              }`}>
                <span className={`text-[10px] block font-semibold uppercase ${
                  isDark ? 'text-slate-400' : 'text-slate-500'
                }`}>
                  Средняя скорость
                </span>
                <span className={`text-xl font-bold font-mono ${
                  isDark ? 'text-cyan-400' : 'text-cyan-600'
                }`}>
                  {completedTripSummary.avgSpeedKmH} км/ч
                </span>
              </div>

              <div className={`border rounded-xl p-3 ${
                isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
              }`}>
                <span className={`text-[10px] block font-semibold uppercase ${
                  isDark ? 'text-slate-400' : 'text-slate-500'
                }`}>
                  Время в пути
                </span>
                <span className={`text-xl font-bold font-mono ${
                  isDark ? 'text-slate-200' : 'text-slate-800'
                }`}>
                  {completedTripSummary.durationMinutes} мин
                </span>
              </div>

              <div className={`border rounded-xl p-3 ${
                isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
              }`}>
                <span className={`text-[10px] block font-semibold uppercase ${
                  isDark ? 'text-slate-400' : 'text-slate-500'
                }`}>
                  Расход (кВт⋅ч/100)
                </span>
                <span className={`text-xl font-bold font-mono ${
                  isDark ? 'text-amber-400' : 'text-amber-600'
                }`}>
                  {completedTripSummary.estimatedCons}
                </span>
              </div>
            </div>

            <div className={`p-2.5 border rounded-xl text-xs space-y-1 ${
              isDark ? 'bg-slate-950/70 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'
            }`}>
              <div className="flex justify-between">
                <span>Расход энергии:</span>
                <span className={`font-bold font-mono ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  {completedTripSummary.energyUsedKwh} кВт⋅ч (SoC: {Math.round(completedTripSummary.startSoc)}% → {Math.round(completedTripSummary.endSoc)}%)
                </span>
              </div>
              <div className="flex justify-between">
                <span>Температура воздуха:</span>
                <span className={`font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  {completedTripSummary.temp > 0 ? `+${completedTripSummary.temp}` : completedTripSummary.temp}°C
                </span>
              </div>
              <div className="flex justify-between">
                <span>Максимальная скорость:</span>
                <span className={`font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  {completedTripSummary.maxSpeedKmH} км/ч
                </span>
              </div>
              <div className="flex justify-between">
                <span>Стиль поездки (трек):</span>
                <span className={`font-bold ${
                  (completedTripSummary.styleFactor ?? 1) > 1.05
                    ? 'text-rose-400'
                    : (completedTripSummary.styleFactor ?? 1) < 0.95
                    ? 'text-cyan-400'
                    : isDark ? 'text-white' : 'text-slate-900'
                }`}>
                  x{(completedTripSummary.styleFactor ?? 1).toFixed(2)} ({completedTripSummary.styleLabel || 'Сбалансированный'})
                </span>
              </div>
              {completedTripSummary.windStatus && (
                <div className={`flex justify-between ${isDark ? 'text-cyan-300' : 'text-cyan-700'}`}>
                  <span>Ветер во время поездки:</span>
                  <span className="font-semibold">{completedTripSummary.windStatus}</span>
                </div>
              )}
              {completedTripSummary.precipitationStatus && (
                <div className={`flex justify-between ${isDark ? 'text-blue-300' : 'text-blue-700'}`}>
                  <span>Покрытие дороги / Осадки:</span>
                  <span className="font-semibold">{completedTripSummary.roadSurface || completedTripSummary.precipitationStatus}</span>
                </div>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex gap-2 pt-2">
              <button
                onClick={handleSaveTrackedTrip}
                className="flex-1 py-3 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-xs shadow-md shadow-cyan-600/30 active:scale-95 transition-all flex items-center justify-center gap-1.5"
              >
                <PlusCircle className="w-4 h-4" />
                <span>Записать в журнал</span>
              </button>

              <button
                onClick={() => setCompletedTripSummary(null)}
                className={`py-3 px-4 rounded-xl font-semibold text-xs border ${
                  isDark
                    ? 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
                    : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300'
                }`}
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
