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
} from 'lucide-react';
import { UserSettings, TripSession } from '../types';
import {
  estimateTripConsumption,
  estimateSegmentedRouteConsumption,
  calculateClimateImpact,
  calculatePrecipitationImpact,
  computeFlatRoadConsumptionRate,
  ConsumptionForecast,
} from '../utils/storage';
import { triggerHaptic } from '../utils/haptics';
import { geocodeAddress, buildRouteElevation } from '../services/routeElevation';
import { fetchForecastWeatherAt, fetchForecastWeatherAlongRoute } from '../services/weatherForecast';


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

interface HudTabProps {
  settings: UserSettings;
  sessions: TripSession[];
  onSaveToHistory: (tripData: Omit<TripSession, 'id' | 'createdAt'>) => void;
  onOpenAddModalWithData?: (data: Partial<TripSession>) => void;
  onTrackingChange?: (isTracking: boolean) => void;
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

export const HudTab: React.FC<HudTabProps> = ({
  settings,
  sessions,
  onSaveToHistory,
  onTrackingChange,
}) => {
  // Tracking state
  const [isTracking, setIsTracking] = useState(false);
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
  } | null>(null);
  const [trackingStopMessage, setTrackingStopMessage] = useState('');

  const watchIdRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const prevPositionRef = useRef<{ lat: number; lon: number; time: number; speed: number } | null>(null);
  const speedHistoryRef = useRef<number[]>([]);
  const distanceRef = useRef<number>(0);
  const smoothSpeedBufferRef = useRef<number[]>([]);
  const lastHeadingRef = useRef<number>(0);
  const smoothedAltitudeRef = useRef<number | null>(null);
  const lastCountedAltitudeRef = useRef<number | null>(null);
  const elevationGainRef = useRef(0);
  const elevationLossRef = useRef(0);

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

  // Monotonic floor for current SoC during a trip: once the displayed live SoC drops,
  // it must never rise again until tracking is stopped. Prevents small upward jumps from
  // regen recalculation, elevation profile updates, or climate forecast changes.
  const minLiveSocRef = useRef<number | null>(null);

  // Mirrors of render-scope values the geolocation watchPosition callback needs to read at
  // call-time without forcing the GPS watch to be torn down and resubscribed on every change.
  const weatherRef = useRef(weather);
  const relativeWindAngleRef = useRef(0);

  const isDark = settings.theme !== 'light';
  const batteryCap = settings.batteryCapacityKwh || 51.87;

  // Notify parent of tracking status
  useEffect(() => {
    onTrackingChange?.(isTracking);
  }, [isTracking, onTrackingChange]);

  // Keep weatherRef in sync so the geolocation callback (subscribed once per trip) always reads
  // the latest fetched weather without needing to resubscribe watchPosition.
  useEffect(() => {
    weatherRef.current = weather;
  }, [weather]);

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

      const accMeters = accuracy ? Math.round(accuracy) : null;
      setGpsAccuracy(accMeters);

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

      setCurrentSpeed(smoothedSpeed);
      latestGpsSpeedRef.current = smoothedSpeed;

      let vehicleHeading = heading;
      if (vehicleHeading !== null && !isNaN(vehicleHeading) && vehicleHeading >= 0) {
        const roundedHeading = Math.round(vehicleHeading);
        setGpsHeading(roundedHeading);
        lastHeadingRef.current = roundedHeading;
      } else if (prevPositionRef.current && smoothedSpeed >= 5) {
        const bearing = calculateBearing(
          prevPositionRef.current.lat,
          prevPositionRef.current.lon,
          latitude,
          longitude
        );
        setGpsHeading(bearing);
        lastHeadingRef.current = bearing;
      }

      // === ELEVATION TRACKING (Рельеф и рекуперация) ===
      // Device altitude is often noisy (±5-10m), so we exponentially smooth it and only count a
      // change once it clears a noise threshold, similar to how we filter GPS speed glitches.
      const rawAltitude = pos.coords.altitude;
      if (isTracking && rawAltitude !== null && !isNaN(rawAltitude)) {
        setAltitudeAvailable(true);
        if (smoothedAltitudeRef.current === null) {
          smoothedAltitudeRef.current = rawAltitude;
          lastCountedAltitudeRef.current = rawAltitude;
        } else {
          smoothedAltitudeRef.current = smoothedAltitudeRef.current * 0.7 + rawAltitude * 0.3;
          const countedDelta = smoothedAltitudeRef.current - (lastCountedAltitudeRef.current ?? smoothedAltitudeRef.current);
          if (Math.abs(countedDelta) >= 2) {
            if (countedDelta > 0) {
              elevationGainRef.current += countedDelta;
            } else {
              elevationLossRef.current += Math.abs(countedDelta);
            }
            lastCountedAltitudeRef.current = smoothedAltitudeRef.current;
            setElevationGainM(Math.round(elevationGainRef.current));
            setElevationLossM(Math.round(elevationLossRef.current));
          }
        }
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
          setTripDistanceKm(Number(distanceRef.current.toFixed(2)));

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
          setLiveSegmentEnergyKwh(Number(segmentEnergyKwhRef.current.toFixed(3)));

          if (smoothedSpeed > 0) {
            speedHistoryRef.current.push(smoothedSpeed);
          }
          setMaxSpeed((prev) => Math.max(prev, smoothedSpeed));
        }
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
        color: 'text-emerald-500',
        badgeBg: isDark ? 'bg-emerald-950/70 border-emerald-800/80 text-emerald-300' : 'bg-emerald-50 border-emerald-200 text-emerald-700',
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

    const movingSpeeds = speedHistoryRef.current.filter((s) => s >= 5);
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
        color: 'text-emerald-500',
        badgeBg: isDark ? 'bg-emerald-950/70 border-emerald-800 text-emerald-300' : 'bg-emerald-50 border-emerald-200 text-emerald-800',
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
    passengers
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
    1
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
  // Elevation and HVAC energy are physically additive regardless of driving order (elevation is
  // pure m·g·h from total gain/loss; HVAC is power × elapsed time), so they're still taken from
  // the aggregate forecast and added once for the whole trip.
  const elevationEnergyKwh =
    forecast.elevationDeltaKwh100 !== undefined
      ? (tripDistanceKm / 100) * forecast.elevationDeltaKwh100
      : 0;
  const climateEnergyKwh = (tripDistanceKm / 100) * (forecast.climateDeltaKwh100 ?? 0);
  const energySpentKwh = isTracking
    ? Math.max(0, liveSegmentEnergyKwh + elevationEnergyKwh + climateEnergyKwh)
    : 0;

  // Percentage drop of battery based on energy spent and battery capacity
  const socSpentPercent = (energySpentKwh / batteryCap) * 100;

  // Raw live dynamic remaining SoC % (can theoretically rise slightly due to regen /
  // elevation / climate recalculations). We enforce a monotonic floor below.
  const rawLiveDynamicSoc = Math.max(0, Number((startTripSoc - socSpentPercent).toFixed(1)));

  // Monotonic current SoC: never allow the displayed value to increase during one trip.
  if (isTracking) {
    if (minLiveSocRef.current === null) {
      minLiveSocRef.current = rawLiveDynamicSoc;
    } else {
      minLiveSocRef.current = Math.min(minLiveSocRef.current, rawLiveDynamicSoc);
    }
  }
  const liveDynamicSoc = isTracking && minLiveSocRef.current !== null
    ? minLiveSocRef.current
    : rawLiveDynamicSoc;

  // Live SoC-at-destination: always derived from the *current* liveDynamicSoc + last
  // calculated remaining energy. This makes the big "SOC на финише" number move in real time
  // while tracking, even between full route recalculations.
  const livePredictedSoc =
    destinationResult != null
      ? Math.max(0, Number((liveDynamicSoc - (destinationResult.energyNeededKwh / batteryCap) * 100).toFixed(1)))
      : null;

  // Remaining battery kWh at live dynamic SoC
  const dynamicRemainingBatteryKwh = (liveDynamicSoc / 100) * batteryCap;

  // Remaining range in km dynamically calculated from live SoC & predicted consumption (style + weather + road)
  const dynamicRemainingRangeKm = Math.max(
    0,
    Math.round((dynamicRemainingBatteryKwh / rangeConsumption) * 100)
  );

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

  // START tracking
  const handleStartTracking = () => {
    triggerHaptic('success', settings.hapticFeedback);
    requestWakeLock();
    setIsTracking(true);
    setTripStartTime(Date.now());
    setElapsedSeconds(0);
    setTripDistanceKm(0);
    setMaxSpeed(0);
    distanceRef.current = 0;
    speedHistoryRef.current = [];
    smoothSpeedBufferRef.current = [];
    smoothedAltitudeRef.current = null;
    lastCountedAltitudeRef.current = null;
    elevationGainRef.current = 0;
    elevationLossRef.current = 0;
    setElevationGainM(0);
    setElevationLossM(0);
    setAltitudeAvailable(false);
    setCompletedTripSummary(null);
    setTrackingStopMessage('');
    segmentEnergyKwhRef.current = 0;
    setLiveSegmentEnergyKwh(0);
    minLiveSocRef.current = null; // reset monotonic SoC floor for the new trip
  };

  // STOP tracking
  const handleStopTracking = () => {
    triggerHaptic('medium', settings.hapticFeedback);
    setIsTracking(false);
    setDestinationResult(null);
    setDestinationError(null);
    setDestinationBreakdownOpen(false);
    cachedDestRef.current = null;
    lastDestRecalcAtRef.current = 0;
    lastDestRecalcDistanceRef.current = 0;
    destRecalcInFlightRef.current = false;
    minLiveSocRef.current = null;
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
    });
  };

  // RESET tracking
  const handleResetTracking = () => {
    triggerHaptic('light', settings.hapticFeedback);
    setIsTracking(false);
    setTrackingStopMessage('');
    setTripStartTime(null);
    setElapsedSeconds(0);
    setTripDistanceKm(0);
    setMaxSpeed(0);
    distanceRef.current = 0;
    speedHistoryRef.current = [];
    smoothSpeedBufferRef.current = [];
    smoothedAltitudeRef.current = null;
    lastCountedAltitudeRef.current = null;
    elevationGainRef.current = 0;
    elevationLossRef.current = 0;
    setElevationGainM(0);
    setElevationLossM(0);
    setAltitudeAvailable(false);
    setCompletedTripSummary(null);
    segmentEnergyKwhRef.current = 0;
    setLiveSegmentEnergyKwh(0);
    minLiveSocRef.current = null;
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
      }`,
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
          destinationSpeedKmH, sessions, settings.batteryCapacityKwh, climateOn, isTracking ? currentTripStyle.factor : undefined
        );
        const destForecast = estimateTripConsumption(
          destinationSpeedKmH, calcTemperature, sessions, settings.batteryCapacityKwh, climateOn,
          calcWindSpeed, calcRelativeWindAngle, isTracking ? currentTripStyle.factor : undefined,
          calcWeatherCode, calcPrecipitation, { gainM: projectedGainM, lossM: projectedLossM, distanceKm },
          etaMinutes ? etaMinutes / 60 : distanceKm / Math.max(5, destinationSpeedKmH), segmented.climatePowerKw, passengers
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
        destinationSpeedKmH, sessions, settings.batteryCapacityKwh, climateOn, isTracking ? currentTripStyle.factor : undefined
      );
      const destForecast = estimateTripConsumption(destinationSpeedKmH, calcTemperature, sessions, settings.batteryCapacityKwh, climateOn, segmented.avgWindSpeed, calcRelativeWindAngle, isTracking ? currentTripStyle.factor : undefined, calcWeatherCode, segmented.avgPrecipitation, { gainM, lossM, distanceKm: route.distanceKm }, segmented.durationHours, segmented.climatePowerKw, passengers);
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

  return (
    <div
      id="hud-tab-container"
      className={`relative h-[calc(100vh-7.5rem)] min-h-[520px] max-h-[980px] overflow-hidden rounded-3xl p-3 flex flex-col gap-2 select-none transition-all duration-200 ${
        isMirrored ? 'scale-x-[-1]' : ''
      } ${
        isDark
          ? 'bg-slate-950 text-white border border-slate-800/90 shadow-2xl'
          : 'bg-white text-slate-900 border border-slate-200 shadow-xl'
      }`}
    >
      {/* 1. Status */}
      <div className={`flex items-center justify-between gap-2 border-b pb-1.5 shrink-0 ${isDark ? 'border-slate-800/80' : 'border-slate-200'}`}>
        <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] border shrink-0 ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-slate-100 border-slate-200'}`}>
            <span className={`w-2 h-2 rounded-full ${gpsAccuracy !== null && gpsAccuracy <= 15 ? 'bg-emerald-400 animate-pulse' : gpsAccuracy !== null ? 'bg-amber-400' : 'bg-rose-500'}`} />
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
            <span className="text-[11px] font-bold text-emerald-400 shrink-0">● LIVE</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            triggerHaptic('light', settings.hapticFeedback);
            setIsMirrored(!isMirrored);
          }}
          title="Зеркальный режим"
          className={`p-2 rounded-xl border shrink-0 ${
            isMirrored
              ? 'bg-emerald-600 text-white border-emerald-500'
              : isDark
              ? 'bg-slate-800 text-slate-300 border-slate-700'
              : 'bg-slate-100 text-slate-700 border-slate-300'
          }`}
        >
          <FlipHorizontal className="w-4 h-4" />
        </button>
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
                  ? 'text-emerald-400'
                  : 'text-emerald-600'
              }`}
            >
              {isTracking ? liveDynamicSoc : startTripSoc}%
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
                  liveDynamicSoc < 20 ? 'bg-rose-500' : liveDynamicSoc < 40 ? 'bg-amber-500' : 'bg-emerald-500'
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
            className="w-full h-2 mt-2 accent-emerald-500 cursor-pointer touch-pan-x"
            aria-label="SOC на старте поездки"
          />
        )}
      </div>

      {/* 4. Destination + result details */}
      <div
        className={`rounded-2xl border px-3.5 py-2.5 shrink-0 ${
          isDark ? 'bg-slate-900/95 border-emerald-900/50' : 'bg-emerald-50/60 border-emerald-200'
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Flag className={`w-5 h-5 shrink-0 ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`} />
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
            <div className="text-right shrink-0">
              <span
                className={`font-mono font-black text-4xl leading-none tabular-nums ${
                  livePredictedSoc < 10
                    ? 'text-rose-500'
                    : livePredictedSoc < 20
                    ? 'text-amber-500'
                    : isDark
                    ? 'text-emerald-400'
                    : 'text-emerald-600'
                }`}
              >
                {livePredictedSoc}%
              </span>
              {isTracking && (
                <span className={`block text-[11px] font-mono mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                  сейчас {liveDynamicSoc}%
                </span>
              )}
            </div>
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
                className="px-3.5 py-2.5 rounded-xl bg-emerald-600 active:bg-emerald-500 text-white text-[12px] font-black disabled:opacity-60"
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
                isDark ? 'bg-slate-950 border-emerald-800 text-emerald-300' : 'bg-white border-emerald-300 text-emerald-700'
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
                <span className={`font-mono tabular-nums ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
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

      {/* 6. Controls */}
      <div className="grid grid-cols-2 gap-2 shrink-0">
        {isTracking ? (
          <>
            <button
              type="button"
              onClick={handleStopTracking}
              className="py-2.5 rounded-xl bg-rose-600 text-white font-black text-[13px] flex items-center justify-center gap-2 active:scale-[0.98]"
            >
              <Square className="w-4 h-4 fill-current" /> СТОП
            </button>
            <button
              type="button"
              onClick={handleResetTracking}
              className={`py-2.5 rounded-xl border font-bold text-[13px] flex items-center justify-center gap-2 active:scale-[0.98] ${
                isDark
                  ? 'bg-slate-800 text-slate-200 border-slate-700'
                  : 'bg-slate-100 text-slate-700 border-slate-300'
              }`}
            >
              <RotateCcw className="w-4 h-4" /> СБРОС
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
        className={`rounded-xl border grid grid-cols-3 divide-x shrink-0 ${
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
          <b className={`font-mono text-base tabular-nums ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
            {avgTripSpeedKmH}
            <small className="text-[10px]"> км/ч</small>
          </b>
        </div>
      </div>

      {/* Completed Trip Summary Modal */}
      {completedTripSummary && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className={`border rounded-3xl max-w-md w-full p-5 space-y-4 shadow-2xl text-left ${
            isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900'
          }`}>
            <div className={`flex items-center justify-between border-b pb-3 ${
              isDark ? 'border-slate-800' : 'border-slate-200'
            }`}>
              <div className="flex items-center gap-2">
                <div className={`p-2 rounded-xl ${
                  isDark ? 'bg-emerald-500/20 text-emerald-400' : 'bg-emerald-100 text-emerald-700'
                }`}>
                  <Check className="w-5 h-5" />
                </div>
                <div>
                  <h3 className={`text-base font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                    Поездка завершена
                  </h3>
                  <span className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    Данные по GPS треку (SoC: {completedTripSummary.startSoc}% → {completedTripSummary.endSoc}%)
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
                  isDark ? 'text-emerald-400' : 'text-emerald-600'
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
                  {completedTripSummary.energyUsedKwh} кВт⋅ч (SoC: {completedTripSummary.startSoc}% → {completedTripSummary.endSoc}%)
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
                    ? 'text-emerald-400'
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
                className="flex-1 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-md shadow-emerald-600/30 active:scale-95 transition-all flex items-center justify-center gap-1.5"
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
