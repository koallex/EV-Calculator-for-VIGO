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
import { CollapsibleDetails } from './ui/CollapsibleDetails';

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
  const [factorsOpen, setFactorsOpen] = useState(false);

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
  const [destinationBusy, setDestinationBusy] = useState(false);
  const [destinationError, setDestinationError] = useState<string | null>(null);
  const [destinationBreakdownOpen, setDestinationBreakdownOpen] = useState(false);
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
    // Live in-trip recalculation support (address mode only — distance mode has no coordinates
    // to re-measure from). originCoords + routeTortuosity let remaining distance be re-estimated
    // from the current GPS fix via straight-line distance, without re-fetching the route/weather
    // on every position update.
    destCoords?: { lat: number; lon: number };
    originCoords?: { lat: number; lon: number };
    routeTortuosity?: number;
    energyPerKm?: number;
    isLive?: boolean;
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
    if (!isTracking || tripDistanceKm < 0.05 || elapsedSeconds < 6 || speedHistoryRef.current.length < 4) {
      return {
        factor: 1.0, label: 'Калибровка', subLabel: 'Анализ темпа в пути...',
        details: 'Определение стиля вождения', diffPct: 0,
        color: isDark ? 'text-slate-300' : 'text-slate-700',
        badgeBg: isDark ? 'bg-slate-800/80 border-slate-700 text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-700',
      };
    }
    const movingSpeeds = speedHistoryRef.current.filter((s) => s >= 5);
    if (movingSpeeds.length < 4) {
      return {
        factor: 1.0, label: 'Сбалансированный', subLabel: 'Штатный темп', details: 'Штатный темп', diffPct: 0,
        color: isDark ? 'text-slate-200' : 'text-slate-800',
        badgeBg: isDark ? 'bg-slate-800/80 border-slate-700 text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-700',
      };
    }

    // Driving style is now about kinetics, not speed itself. A steady 120 km/h cruise
    // is expensive because of aerodynamics, but it is not automatically an aggressive style.
    const mean = movingSpeeds.reduce((a, b) => a + b, 0) / movingSpeeds.length;
    const variance = movingSpeeds.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / movingSpeeds.length;
    const stdDev = Math.sqrt(variance);
    const deltas = movingSpeeds.slice(1).map((v, i) => Math.abs(v - movingSpeeds[i]));
    const meanDelta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
    const sharpChangeRatio = deltas.length ? deltas.filter((d) => d >= 6).length / deltas.length : 0;

    let factor = 1.0;
    if (stdDev < 8 && meanDelta < 2.5) factor -= 0.03;
    else if (stdDev < 14 && meanDelta < 4) factor -= 0.01;
    else if (stdDev > 30 || sharpChangeRatio > 0.20) factor += 0.07;
    else if (stdDev > 23 || sharpChangeRatio > 0.10) factor += 0.04;
    else if (meanDelta > 5) factor += 0.03;

    const clamped = Number(Math.max(0.97, Math.min(1.10, factor)).toFixed(2));
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
  }, [isTracking, tripDistanceKm, elapsedSeconds, isDark]);

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

  // Live dynamic remaining SoC %
  const liveDynamicSoc = Math.max(0, Number((startTripSoc - socSpentPercent).toFixed(1)));

  // Remaining battery kWh at live dynamic SoC
  const dynamicRemainingBatteryKwh = (liveDynamicSoc / 100) * batteryCap;

  // Remaining range in km dynamically calculated from live SoC & predicted consumption (style + weather + road)
  const dynamicRemainingRangeKm = Math.max(
    0,
    Math.round((dynamicRemainingBatteryKwh / forecast.estimatedConsumption) * 100)
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
    Math.round((safeDynamicBatteryKwh / forecast.estimatedConsumption) * 100)
  );

  // Total consumption multiplier factor relative to base
  const totalConsumptionFactor = Number(
    (forecast.estimatedConsumption / forecast.baseConsumption).toFixed(2)
  );

  // One-tap primary action: prepare the destination forecast (when a destination is set)
  // and start live tracking. The actual average speed is learned from GPS during the trip.
  const handleStartWithLiveForecast = async () => {
    if (isTracking) return;
    if (destinationQuery.trim()) {
      await handleCalculateDestination();
    }
    handleStartTracking();
  };

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
    segmentEnergyKwhRef.current = 0;
    setLiveSegmentEnergyKwh(0);
  };

  // STOP tracking
  const handleStopTracking = () => {
    triggerHaptic('medium', settings.hapticFeedback);
    setIsTracking(false);

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

  const handleCalculateDestination = async () => {
    if (!destinationQuery.trim() || destinationBusy) return;
    triggerHaptic('light', settings.hapticFeedback);
    setDestinationBusy(true);
    setDestinationError(null);
    setDestinationResult(null);
    setDestinationBreakdownOpen(false);

    // While tracking, use the live GPS-derived average. Before the trip starts,
    // use a conservative fallback; the forecast is immediately updated from live pace.
    const destinationSpeedKmH = isTracking ? avgTripSpeedKmH : 60;

    try {
      if (destinationMode === 'distance') {
        const distanceKm = parseFloat(destinationQuery.replace(',', '.'));
        if (isNaN(distanceKm) || distanceKm <= 0) {
          setDestinationError('Введите дистанцию в км, например 45');
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
        return;
      }

      // Address mode: geocode -> real route -> elevation profile along the route
      if (!prevPositionRef.current) {
        setDestinationError('Нет текущих координат GPS. Дождитесь сигнала GPS.');
        return;
      }

      const geo = await geocodeAddress(destinationQuery.trim());

      const route = await buildRouteElevation(
        prevPositionRef.current.lat,
        prevPositionRef.current.lon,
        geo.lat,
        geo.lon,
        geo.displayName
      );
      const gainM = route.elevationGainM;
      const lossM = route.elevationLossM;

      const etaMinutes = destinationSpeedKmH > 3 ? Math.round((route.distanceKm / destinationSpeedKmH) * 60) : undefined;
      const arrivalDate = new Date(Date.now() + (etaMinutes ?? 0) * 60000);

      // Load a small number of weather samples along the route. The calculation itself is then
      // performed segment-by-segment; weather between samples is interpolated by distance.
      const routeWeatherSamples = await fetchForecastWeatherAlongRoute(route.points, new Date(), destinationSpeedKmH);
      const forecastWeather = await fetchForecastWeatherAt(geo.lat, geo.lon, arrivalDate);
      const forecastUsed = forecastWeather !== null;
      const calcTemperature = forecastWeather?.temperature ?? (weather.isLoaded ? weather.temperature : undefined);
      const calcWindSpeed = forecastWeather?.windSpeed ?? (weather.isLoaded ? weather.windSpeed : undefined);
      const calcWeatherCode = forecastWeather?.weatherCode ?? (weather.isLoaded ? weather.weatherCode : undefined);
      const calcPrecipitation = forecastWeather?.precipitation ?? (weather.isLoaded ? weather.precipitation : undefined);

      const routeBearing = calculateBearing(prevPositionRef.current.lat, prevPositionRef.current.lon, geo.lat, geo.lon);
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
      const originStraightKm = Math.max(0.1, calculateDistance(prevPositionRef.current.lat, prevPositionRef.current.lon, geo.lat, geo.lon));
      const routeTortuosity = Math.min(3, Math.max(1, route.distanceKm / originStraightKm));

      setDestinationResult({
        name: geo.displayName.split(',').slice(0, 3).join(','),
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
        destCoords: { lat: geo.lat, lon: geo.lon },
        originCoords: { lat: prevPositionRef.current.lat, lon: prevPositionRef.current.lon },
        routeTortuosity,
        energyPerKm: route.distanceKm > 0 ? energyNeededKwh / route.distanceKm : undefined,
        isLive: isTracking,
      });
    } catch (e) {
      // geocodeAddress / buildRouteElevation throw with a specific, user-readable message
      // (e.g. "Адрес не найден", "Не удалось построить маршрут") — surface that directly
      // instead of a generic network error, same as the Calculator tab's route planner does.
      const msg = e instanceof Error ? e.message : '';
      setDestinationError(msg || 'Ошибка сети при расчете маршрута. Проверьте соединение.');
    } finally {
      setDestinationBusy(false);
    }
  };

  // Live recalculation of "% at arrival" while tracking. Runs off tripDistanceKm (already updates
  // on every accepted GPS fix) instead of position state directly, since position itself only
  // lives in a ref. Deliberately does NOT re-run geocoding / route-building / weather-along-route —
  // those are the expensive network calls handleCalculateDestination already paid for once. It
  // only re-measures straight-line distance to the pinned destination and scales it by the
  // route's curviness ratio captured at calc time, which is enough to keep the remaining-distance
  // (and therefore predicted SoC) honest as you actually drive, at effectively zero cost per tick.
  useEffect(() => {
    if (!isTracking || !destinationResult || destinationResult.approximate) return;
    const { destCoords, originCoords, routeTortuosity, energyPerKm } = destinationResult;
    if (!destCoords || !originCoords || !routeTortuosity || energyPerKm === undefined) return;
    const pos = prevPositionRef.current;
    if (!pos) return;

    const straightNowKm = calculateDistance(pos.lat, pos.lon, destCoords.lat, destCoords.lon);
    const remainingKm = Math.max(0, straightNowKm * routeTortuosity);
    const newPredictedSoc = Math.max(0, Math.min(100, Number((liveDynamicSoc - (remainingKm * energyPerKm / batteryCap) * 100).toFixed(1))));
    const liveAvgSpeed = avgTripSpeedKmH > 3 ? avgTripSpeedKmH : undefined;
    const newEtaMinutes = liveAvgSpeed ? Math.round((remainingKm / liveAvgSpeed) * 60) : undefined;
    const arrivalDate = new Date(Date.now() + (newEtaMinutes ?? 0) * 60000);

    setDestinationResult(prev => prev ? {
      ...prev,
      distanceKm: Number(remainingKm.toFixed(1)),
      predictedSoc: newPredictedSoc,
      etaMinutes: newEtaMinutes,
      arrivalTimeLabel: newEtaMinutes
        ? arrivalDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
        : prev.arrivalTimeLabel,
      isLive: true,
    } : prev);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripDistanceKm, isTracking]);

  return (
    <div
      id="hud-tab-container"
      className={`hud-minimal-shell relative min-h-[82vh] rounded-3xl p-3 sm:p-5 flex flex-col gap-2 select-none transition-all duration-200 ${
        isMirrored ? 'scale-x-[-1]' : ''
      } ${
        isDark
          ? 'bg-slate-950 text-white border border-slate-800/90 shadow-2xl'
          : 'bg-white text-slate-900 border border-slate-200 shadow-xl'
      }`}
    >
      {/* Top HUD Controls & Sensor Status Bar */}
      <div className={`hud-topbar flex items-center justify-between gap-2 border-b pb-3 ${
        isDark ? 'border-slate-800/80' : 'border-slate-200'
      }`}>
        {/* GPS, Temp, and Screen Wake Lock Status */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* GPS Accuracy Indicator */}
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border ${
            isDark ? 'bg-slate-900/90 border-slate-800' : 'bg-slate-100 border-slate-200'
          }`}>
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                gpsAccuracy !== null && gpsAccuracy <= 15
                  ? 'bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.8)]'
                  : gpsAccuracy !== null
                  ? 'bg-amber-400'
                  : 'bg-rose-500'
              }`}
            />
            <span className={`text-[11px] font-mono font-bold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              {gpsAccuracy !== null ? `GPS ±${gpsAccuracy}м` : 'Поиск GPS...'}
            </span>
          </div>

          {/* Temperature */}
          <div className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-mono border ${
            isDark ? 'bg-slate-900/90 border-slate-800' : 'bg-slate-100 border-slate-200'
          }`}>
            <Thermometer className="w-3.5 h-3.5 text-cyan-500" />
            <span className={`font-bold ${isDark ? 'text-cyan-300' : 'text-cyan-700'}`}>
              {weather.isLoaded ? `${weather.temperature > 0 ? '+' : ''}${weather.temperature}°C` : '20°C'}
            </span>
          </div>

          {/* WakeLock Active Indicator */}
          <div
            title="Экран iPhone не заблокируется во время работы HUD"
            className={`hidden sm:flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] border font-medium ${
              wakeLockActive
                ? isDark
                  ? 'bg-emerald-950/60 border-emerald-800/70 text-emerald-300'
                  : 'bg-emerald-50 border-emerald-300 text-emerald-800'
                : isDark
                ? 'bg-slate-900/80 border-slate-800 text-slate-400'
                : 'bg-slate-100 border-slate-200 text-slate-500'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
            <span>Экран активен</span>
          </div>
        </div>

        {/* Action Controls: Mirror Mode */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => {
              triggerHaptic('light', settings.hapticFeedback);
              setIsMirrored(!isMirrored);
            }}
            title="Зеркальный режим для проекции на лобовое стекло (HUD)"
            className={`p-2 sm:px-3 sm:py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 transition-all active:scale-95 ${
              isMirrored
                ? 'bg-emerald-600 text-white border-emerald-500 shadow-sm'
                : isDark
                ? 'bg-slate-800/80 hover:bg-slate-700 text-slate-300 border-slate-700'
                : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300'
            }`}
          >
            <FlipHorizontal className="w-4 h-4" />
            <span className="hidden sm:inline text-[11px]">Зеркало HUD</span>
          </button>
        </div>
      </div>

      {/* Initial / Live SOC — intentionally high in the HUD so the driver cannot miss it */}
      <div className={`rounded-2xl border p-3 sm:p-3.5 mb-2.5 ${
        isDark ? 'bg-slate-900/95 border-slate-700/90' : 'bg-white border-slate-200 shadow-xs'
      }`}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className={`text-[11px] font-extrabold tracking-wide ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              {isTracking ? 'ТЕКУЩИЙ ЗАРЯД' : 'SOC НА СТАРТЕ ПОЕЗДКИ'}
            </div>
            <div className={`font-mono font-black text-3xl leading-none mt-1 ${
              liveDynamicSoc < 20 ? 'text-rose-500' : liveDynamicSoc < 40 ? 'text-amber-500' : isDark ? 'text-emerald-400' : 'text-emerald-600'
            }`}>
              {isTracking ? liveDynamicSoc : startTripSoc}%
            </div>
            {isTracking && tripDistanceKm > 0 && (
              <div className={`text-[10px] mt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Старт: {startTripSoc}% · потрачено {energySpentKwh.toFixed(2)} кВт⋅ч
              </div>
            )}
          </div>

          {!isTracking && (
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => { triggerHaptic('light', settings.hapticFeedback); setStartTripSoc(prev => Math.max(1, prev - 10)); }}
                className={`px-2 py-1.5 rounded-lg border text-xs font-bold ${isDark ? 'bg-slate-950 text-slate-300 border-slate-800' : 'bg-white text-slate-700 border-slate-200'}`}
                title="Уменьшить на 10%"
              >−10%</button>
              <button
                onClick={() => { triggerHaptic('light', settings.hapticFeedback); setStartTripSoc(prev => Math.max(1, prev - 1)); }}
                className={`p-1.5 rounded-lg border ${isDark ? 'bg-slate-950 text-slate-300 border-slate-800' : 'bg-white text-slate-700 border-slate-200'}`}
                title="Уменьшить на 1%"
              ><Minus className="w-3.5 h-3.5" /></button>
              <button
                onClick={() => { triggerHaptic('light', settings.hapticFeedback); setStartTripSoc(prev => Math.min(100, prev + 1)); }}
                className={`p-1.5 rounded-lg border ${isDark ? 'bg-slate-950 text-slate-300 border-slate-800' : 'bg-white text-slate-700 border-slate-200'}`}
                title="Увеличить на 1%"
              ><Plus className="w-3.5 h-3.5" /></button>
              <button
                onClick={() => { triggerHaptic('light', settings.hapticFeedback); setStartTripSoc(prev => Math.min(100, prev + 10)); }}
                className={`px-2 py-1.5 rounded-lg border text-xs font-bold ${isDark ? 'bg-slate-950 text-slate-300 border-slate-800' : 'bg-white text-slate-700 border-slate-200'}`}
                title="Увеличить на 10%"
              >+10%</button>
            </div>
          )}
        </div>

        <div className={`w-full h-2 rounded-full overflow-hidden mt-2 ${isDark ? 'bg-slate-950 border border-slate-800' : 'bg-slate-200 border border-slate-300'}`}>
          <div
            className={`h-full rounded-full transition-all duration-300 ${liveDynamicSoc < 20 ? 'bg-rose-500' : liveDynamicSoc < 40 ? 'bg-amber-500' : 'bg-emerald-500'}`}
            style={{ width: `${Math.min(100, Math.max(0, isTracking ? liveDynamicSoc : startTripSoc))}%` }}
          />
        </div>
      </div>

      {/* Primary Live Consumption Action */}
      <div className={`rounded-2xl border p-2.5 ${
        isDark ? 'bg-slate-900/90 border-slate-800' : 'bg-slate-50 border-slate-200'
      }`}>
        <div className="flex items-center gap-2.5">
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
            isDark ? 'bg-emerald-950 text-emerald-300' : 'bg-emerald-100 text-emerald-700'
          }`}>
            <Gauge className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1 text-left">
            <div className={`text-sm font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>
              {isTracking ? 'Живой расход активен' : 'Живой расход'}
            </div>
            <div className={`text-[10px] truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              {isTracking
                ? `SOC на финише пересчитывается в реальном времени · ${avgTripSpeedKmH} км/ч`
                : destinationQuery.trim()
                ? 'Цель задана — одной кнопкой рассчитаем маршрут и начнём поездку'
                : 'GPS автоматически определит реальный темп поездки'}
            </div>
          </div>
          {!isTracking ? (
            <button
              onClick={handleStartWithLiveForecast}
              disabled={destinationBusy || isTracking}
              className="py-3 px-4 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-50 text-white font-black text-xs shadow-lg shadow-emerald-600/25 active:scale-[0.98] transition-all flex items-center gap-1.5 shrink-0"
            >
              {destinationBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
              <span>{destinationQuery.trim() ? 'РАСЧЁТ + СТАРТ' : 'НАЧАТЬ ПОЕЗДКУ'}</span>
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-xl bg-emerald-950/70 text-emerald-300 text-[10px] font-bold border border-emerald-800/70 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> LIVE
            </span>
          )}
        </div>
      </div>

      {/* GPS Error Warning Banner */}
      {gpsError && (
        <div className={`mt-2 rounded-xl p-2 flex items-center gap-2 text-xs border ${
          isDark
            ? 'bg-amber-950/60 border-amber-800/70 text-amber-200'
            : 'bg-amber-50 border-amber-200 text-amber-900'
        }`}>
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
          <span>{gpsError}</span>
        </div>
      )}

      {/* Main Cockpit Speedometer & Info Display */}
      <div className="hud-speed-block my-auto py-2 sm:py-3 flex flex-col items-center justify-center text-center space-y-2.5">
        {/* Live Speed Header */}
        <div className="flex items-center gap-2 font-bold uppercase tracking-widest text-xs">
          <Gauge className={`w-4 h-4 ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`} />
          <span className={isDark ? 'text-emerald-400' : 'text-emerald-700'}>Скорость GPS</span>
          {gpsHeading !== null && (
            <span className={`text-[11px] font-mono font-normal ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              • {gpsHeading}° ({currentHeading < 45 || currentHeading >= 315 ? 'С' : currentHeading < 135 ? 'В' : currentHeading < 225 ? 'Ю' : 'З'})
            </span>
          )}
        </div>

        {/* GIANT SPEED NUMBER */}
        <div className="relative my-0.5 flex items-baseline justify-center">
          <span className={`text-8xl sm:text-9xl font-black font-mono tracking-tighter ${
            isDark
              ? 'text-transparent bg-clip-text bg-gradient-to-b from-white via-slate-100 to-slate-300 drop-shadow-[0_0_24px_rgba(16,185,129,0.3)]'
              : 'text-slate-900 drop-shadow-sm'
          }`}>
            {currentSpeed}
          </span>
          <span className={`text-sm sm:text-base font-bold ml-2 tracking-wider uppercase ${
            isDark ? 'text-slate-400' : 'text-slate-500'
          }`}>
            км/ч
          </span>
        </div>

        {/* 2. DYNAMIC RELATIVE WIND & CLIMATE CONTROL */}
        <div className={`hud-wind-block w-full max-w-lg rounded-2xl p-3 border transition-colors ${
          isDark
            ? 'bg-slate-900/90 border-slate-800/90 shadow-lg'
            : 'bg-slate-50 border-slate-200 shadow-xs'
        }`}>
          <div className="flex items-center justify-between gap-2">
            {/* Wind Direction with Relative Dynamic Vector Arrow */}
            <div className="flex items-center gap-2.5 min-w-0">
              {/* Dynamic Rotating Wind Vector Compass */}
              <div className={`relative w-9 h-9 rounded-full border flex items-center justify-center shrink-0 shadow-inner ${
                isDark ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-200'
              }`}>
                {/* Vehicle Front Indicator (12 o'clock / 0 deg) */}
                <div className="absolute top-1 w-1.5 h-1.5 rounded-full bg-emerald-500" title="Направление движения авто" />
                
                {/* Wind Flow Vector Arrow rotating dynamically relative to vehicle heading */}
                <div
                  className="transition-transform duration-500 ease-out"
                  style={{
                    transform: `rotate(${windInfo.arrowRotation}deg)`,
                  }}
                  title={`Поток ветра относительно движения авто (${relativeWindAngle}°)`}
                >
                  <ArrowDown className={`w-4 h-4 ${windInfo.color}`} />
                </div>
              </div>

              <div className="text-left min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className={`text-xs font-bold truncate ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                    Ветер: {windSpeedMs} м/с
                  </span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${windInfo.badgeBg}`}>
                    {windInfo.label}
                  </span>
                  {livePrecipitation.impactPct > 0 && (
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                      livePrecipitation.type.includes('snow')
                        ? isDark ? 'bg-indigo-950/80 text-indigo-300 border-indigo-700/70' : 'bg-indigo-50 text-indigo-800 border-indigo-200'
                        : isDark ? 'bg-blue-950/80 text-blue-300 border-blue-700/70' : 'bg-blue-50 text-blue-800 border-blue-200'
                    }`} title={livePrecipitation.description}>
                      {livePrecipitation.type.includes('snow') ? '❄️' : '🌧️'} {livePrecipitation.label}
                    </span>
                  )}
                </div>
                <span className={`text-[10px] block truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {forecast.windImpactPct !== undefined && forecast.windImpactPct !== 0
                    ? `Аэродинамика: ${forecast.windImpactPct > 0 ? '+' : ''}${forecast.windImpactPct}% к расходу`
                    : 'Штиль / минимальное влияние'}
                </span>
              </div>
            </div>

            {/* A/C / Climate quick toggle with real ambient temperature impact */}
            <button
              onClick={() => {
                triggerHaptic('light', settings.hapticFeedback);
                setClimateOn(!climateOn);
              }}
              className={`px-2.5 py-1.5 rounded-xl border text-[11px] font-bold shrink-0 transition-all active:scale-95 flex items-center gap-1 ${
                climateOn
                  ? outdoorTemp < 19
                    ? isDark
                      ? 'bg-amber-950/80 text-amber-300 border-amber-700/80'
                      : 'bg-amber-100 text-amber-900 border-amber-300'
                    : isDark
                    ? 'bg-cyan-950/80 text-cyan-300 border-cyan-700/80'
                    : 'bg-cyan-100 text-cyan-900 border-cyan-300'
                  : isDark
                  ? 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
              }`}
              title={`За бортом: ${outdoorTemp}°C. Переключить климат.`}
            >
              {climateOn
                ? outdoorTemp < 19
                  ? `🔥 Обогрев (+${liveClimate.impactPct}%)`
                  : `❄️ A/C (+${liveClimate.impactPct}%)`
                : '🍃 Климат ЭКО (0%)'}
            </button>
          </div>
        </div>

        <div className={`hud-passengers-block w-full max-w-lg rounded-2xl p-3 border text-left transition-colors ${isDark ? 'bg-slate-900/90 border-slate-800/90' : 'bg-slate-50 border-slate-200 shadow-xs'}`}>
          <div className="flex items-center justify-between">
            <div><span className={`text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Людей в салоне</span><span className="block text-[10px] text-slate-500">Включая водителя</span></div>
            <div className="flex items-center gap-2">
              <button onClick={() => setPassengers(p => Math.max(1, p - 1))} className={`w-9 h-9 rounded-lg border font-bold ${isDark ? 'bg-slate-950 border-slate-800 text-slate-300' : 'bg-white border-slate-200 text-slate-700'}`}>−</button>
              <span className={`min-w-7 text-center font-mono font-bold ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>{passengers}</span>
              <button onClick={() => setPassengers(p => Math.min(5, p + 1))} className={`w-9 h-9 rounded-lg border font-bold ${isDark ? 'bg-slate-950 border-slate-800 text-slate-300' : 'bg-white border-slate-200 text-slate-700'}`}>+</button>
            </div>
          </div>
        </div>

        {/* 3. MINIMALIST DRIVING STYLE & CONDITIONS COEFFICIENTS */}
        <CollapsibleDetails
          isDark={isDark}
          open={factorsOpen}
          onToggle={() => setFactorsOpen(v => !v)}
          className="hud-factors-block w-full max-w-lg"
          label={
            <span className="inline-flex items-center gap-1.5">
              <Activity className={`w-3.5 h-3.5 ${isDark ? 'text-amber-400' : 'text-amber-600'}`} />
              <span className="normal-case font-bold">Факторы расхода</span>
              <span className={`ml-1 text-xs font-mono font-extrabold px-2 py-0.5 rounded-lg border ${
                totalConsumptionFactor > 1.15
                  ? isDark ? 'bg-rose-950/70 border-rose-800 text-rose-300' : 'bg-rose-50 border-rose-300 text-rose-800'
                  : totalConsumptionFactor < 0.95
                  ? isDark ? 'bg-emerald-950/70 border-emerald-800 text-emerald-300' : 'bg-emerald-50 border-emerald-300 text-emerald-800'
                  : isDark ? 'bg-amber-950/70 border-amber-800 text-amber-300' : 'bg-amber-50 border-amber-300 text-amber-800'
              }`}>
                x{totalConsumptionFactor.toFixed(2)}
              </span>
            </span>
          }
        >
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-1.5 text-[11px]">
            {/* Live Driving Style Factor (pure driving kinetics) */}
            <div className={`p-2 rounded-xl border ${
              isDark ? 'bg-slate-950/80 border-slate-800' : 'bg-white border-slate-200'
            }`}>
              <div className="flex items-center justify-between">
                <span className={`block text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Стиль езды</span>
                {isTracking && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" title="Текущий трек" />
                )}
              </div>
              <span className={`font-mono font-bold ${currentTripStyle.color}`}>
                x{currentTripStyle.factor.toFixed(2)}
              </span>
              <span className={`block text-[9px] truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`} title={currentTripStyle.details}>
                {currentTripStyle.label}
              </span>
            </div>

            {/* Climate Impact (ratio of ambient temp & climateOn) */}
            <div className={`p-2 rounded-xl border ${
              isDark ? 'bg-slate-950/80 border-slate-800' : 'bg-white border-slate-200'
            }`}>
              <span className={`block text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Климат & A/C</span>
              <span className={`font-mono font-bold ${
                liveClimate.powerKw > 0
                  ? 'text-rose-500'
                  : isDark ? 'text-emerald-400' : 'text-emerald-600'
              }`}>
                {liveClimate.powerKw > 0 ? `${liveClimate.powerKw.toFixed(1)} кВт·ч/ч` : '0 кВт·ч/ч'}
              </span>
              <span className={`block text-[9px] truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`} title={liveClimate.description}>
                {climateOn ? `${outdoorTemp}°C · +${liveClimate.impactPct}% экв.` : 'Откл. (ЭКО)'}
              </span>
            </div>

            {/* Precipitation & Road Surface Condition */}
            <div className={`p-2 rounded-xl border ${
              isDark ? 'bg-slate-950/80 border-slate-800' : 'bg-white border-slate-200'
            }`}>
              <div className="flex items-center justify-between">
                <span className={`block text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Осадки/Дорога</span>
                {livePrecipitation.impactPct > 0 && (
                  <span className="text-[10px]">
                    {livePrecipitation.type.includes('snow') ? '❄️' : '🌧️'}
                  </span>
                )}
              </div>
              <span className={`font-mono font-bold ${
                livePrecipitation.impactPct > 0
                  ? 'text-blue-400'
                  : isDark ? 'text-emerald-400' : 'text-emerald-600'
              }`}>
                {livePrecipitation.impactPct > 0 ? `+${livePrecipitation.impactPct}%` : '0%'}
              </span>
              <span className={`block text-[9px] truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`} title={livePrecipitation.description}>
                {livePrecipitation.roadState}
              </span>
            </div>

            {/* Wind Impact */}
            <div className={`p-2 rounded-xl border ${
              isDark ? 'bg-slate-950/80 border-slate-800' : 'bg-white border-slate-200'
            }`}>
              <span className={`block text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Ветер ({windSpeedMs} м/с)</span>
              <span className={`font-mono font-bold ${
                (forecast.windImpactPct ?? 0) > 0
                  ? 'text-rose-500'
                  : (forecast.windImpactPct ?? 0) < 0
                  ? 'text-emerald-500'
                  : isDark ? 'text-slate-200' : 'text-slate-800'
              }`}>
                {(forecast.windImpactPct ?? 0) > 0 ? `+${forecast.windImpactPct}%` : `${forecast.windImpactPct ?? 0}%`}
              </span>
              <span className={`block text-[9px] truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {windInfo.label}
              </span>
            </div>

            {/* Speed Impact */}
            <div className={`p-2 rounded-xl border ${
              isDark ? 'bg-slate-950/80 border-slate-800' : 'bg-white border-slate-200'
            }`}>
              <span className={`block text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Скорость</span>
              <span className={`font-mono font-bold ${
                forecast.speedImpactPct > 0
                  ? 'text-rose-500'
                  : forecast.speedImpactPct < 0
                  ? 'text-emerald-500'
                  : isDark ? 'text-slate-200' : 'text-slate-800'
              }`}>
                {forecast.speedImpactPct > 0 ? `+${forecast.speedImpactPct}%` : `${forecast.speedImpactPct}%`}
              </span>
              <span className={`block text-[9px] truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                {avgTripSpeedKmH} км/ч
              </span>
            </div>

            {/* Elevation / Regen Impact (Рельеф) */}
            <div className={`p-2 rounded-xl border ${
              isDark ? 'bg-slate-950/80 border-slate-800' : 'bg-white border-slate-200'
            }`}>
              <div className="flex items-center justify-between">
                <span className={`block text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Рельеф</span>
                <Mountain className={`w-3 h-3 ${isDark ? 'text-slate-500' : 'text-slate-400'}`} />
              </div>
              {isTracking && tripDistanceKm > 0.3 ? (
                <>
                  <span className={`font-mono font-bold ${
                    (forecast.elevationImpactPct ?? 0) > 0
                      ? 'text-rose-500'
                      : (forecast.elevationImpactPct ?? 0) < 0
                      ? 'text-emerald-500'
                      : isDark ? 'text-slate-200' : 'text-slate-800'
                  }`}>
                    {(forecast.elevationImpactPct ?? 0) > 0 ? `+${forecast.elevationImpactPct}%` : `${forecast.elevationImpactPct ?? 0}%`}
                  </span>
                  <span className={`block text-[9px] truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`} title="Подъём / спуск (сглажено по GPS-высоте)">
                    ▲{elevationGainM}м ▼{elevationLossM}м
                  </span>
                </>
              ) : (
                <>
                  <span className={`font-mono font-bold ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>—</span>
                  <span className={`block text-[9px] truncate ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {altitudeAvailable ? 'Начните поездку' : 'Высота недоступна'}
                  </span>
                </>
              )}
            </div>
          </div>
        </CollapsibleDetails>

        {/* 4. DYNAMIC CALCULATED REMAINING RANGE INDICATOR (Стиль + Погода + SoC) */}
        <div
          id="hud-calculated-range-indicator"
          className={`hud-range-block w-full max-w-lg rounded-2xl p-3 sm:p-4 border transition-colors ${
            isDark
              ? 'bg-slate-900/90 border-slate-800/90 shadow-lg'
              : 'bg-slate-50 border-slate-200 shadow-xs'
          }`}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-2 mb-2.5">
            <div className="flex items-center gap-1.5 min-w-0">
              <div className={`p-1.5 rounded-lg border shrink-0 ${
                isDark ? 'bg-slate-950 border-slate-800 text-amber-400' : 'bg-white border-slate-200 text-amber-600'
              }`}>
                <Zap className="w-4 h-4" />
              </div>
              <div className="text-left">
                <span className={`text-xs font-bold uppercase tracking-wider block ${
                  isDark ? 'text-slate-200' : 'text-slate-800'
                }`}>
                  Расчетный остаток пробега
                </span>
                <span className={`text-[10px] block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  Динамический пересчет • Стиль + Погода + SoC
                </span>
              </div>
            </div>

            {/* Live recalculation badge */}
            <div className="shrink-0">
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                isDark
                  ? 'bg-emerald-950/80 border-emerald-800 text-emerald-300'
                  : 'bg-emerald-50 border-emerald-200 text-emerald-800'
              }`}>
                ⚡ Live пересчет
              </span>
            </div>
          </div>

          {/* Core Large Range Display & Quick Telemetry Metrics */}
          <div className={`p-3 rounded-2xl border text-left mb-2.5 ${
            isDark
              ? 'bg-slate-950/90 border-slate-800/80'
              : 'bg-white border-slate-200 shadow-xs'
          }`}>
            <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2">
              <div>
                <span className={`text-[11px] font-semibold block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  Заряд сейчас
                </span>
                <div className="flex items-baseline gap-1 mt-0.5">
                  <span className={`text-6xl sm:text-7xl font-black font-mono tracking-tighter ${
                    liveDynamicSoc < 20
                      ? 'text-rose-500'
                      : liveDynamicSoc < 40
                      ? 'text-amber-500'
                      : isDark
                      ? 'text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 via-teal-300 to-cyan-400'
                      : 'text-emerald-600'
                  }`}>
                    {liveDynamicSoc}
                  </span>
                  <span className={`text-2xl font-bold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>%</span>
                </div>
                <div className="flex items-baseline gap-1 mt-0.5">
                  <span className={`text-xl font-bold font-mono ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                    ~{dynamicRemainingRangeKm}
                  </span>
                  <span className={`text-xs font-bold ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>км запас хода</span>
                </div>
              </div>

              {/* Delta relative to baseline nominal rating & Safe Reserve */}
              <div className="flex sm:flex-col items-end gap-1 text-right">
                {rangeDeltaKm !== 0 ? (
                  <span className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded-md border inline-flex items-center gap-1 ${
                    rangeDeltaKm > 0
                      ? isDark
                        ? 'bg-emerald-950/70 border-emerald-800 text-emerald-300'
                        : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : isDark
                      ? 'bg-amber-950/70 border-amber-800 text-amber-300'
                      : 'bg-amber-50 border-amber-200 text-amber-800'
                  }`} title="Сравнение с паспортным запасом хода (340 км при 100% заряда)">
                    {rangeDeltaKm > 0 ? (
                      <>
                        <TrendingUp className="w-3 h-3 text-emerald-400" />
                        <span>+{rangeDeltaKm} км к паспорту</span>
                      </>
                    ) : (
                      <>
                        <TrendingDown className="w-3 h-3 text-amber-400" />
                        <span>{rangeDeltaKm} км к паспорту</span>
                      </>
                    )}
                  </span>
                ) : (
                  <span className={`text-[10px] font-mono ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    Паспортный эквивалент
                  </span>
                )}

                {/* Safe buffer to 10% */}
                <span className={`text-[10px] font-mono block ${isDark ? 'text-slate-400' : 'text-slate-500'}`} title="Запас хода с запасом 10% на непредвиденный доезд">
                  🛡️ До 10% SoC: <strong className={isDark ? 'text-slate-200' : 'text-slate-700'}>~{safeDynamicRangeKm} км</strong>
                </span>
              </div>
            </div>

            {/* Quick Metrics Sub-grid: Расход & Доступно энергии */}
            <div className={`mt-2.5 pt-2 border-t grid grid-cols-2 gap-2 text-[11px] ${
              isDark ? 'border-slate-800/80' : 'border-slate-100'
            }`}>
              <div>
                <span className={`block text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  Расчетный расход ({avgTripSpeedKmH} км/ч):
                </span>
                <span className={`font-mono font-bold ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                  {forecast.estimatedConsumption.toFixed(1)} кВт⋅ч/100
                </span>
              </div>
              <div className="text-right">
                <span className={`block text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  Доступно в батарее:
                </span>
                <span className={`font-mono font-bold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                  {dynamicRemainingBatteryKwh.toFixed(1)} / {batteryCap} кВт⋅ч
                </span>
              </div>
            </div>
          </div>

          {/* Factors Contribution Chips (Стиль + Погода + Осадки + Заряд) */}
          <div className="flex items-center gap-1.5 flex-wrap text-[10px] mb-2.5">
            {/* SoC */}
            <span className={`px-2 py-0.5 rounded-lg border font-mono font-semibold ${
              isDark ? 'bg-slate-950/80 border-slate-800 text-slate-300' : 'bg-white border-slate-200 text-slate-700'
            }`}>
              🔋 {liveDynamicSoc}% SoC
            </span>
            {/* Style */}
            <span className={`px-2 py-0.5 rounded-lg border font-semibold ${
              isDark ? 'bg-slate-950/80 border-slate-800 text-slate-300' : 'bg-white border-slate-200 text-slate-700'
            }`}>
              ⚡ Стиль: {currentTripStyle.label} (x{currentTripStyle.factor.toFixed(2)})
            </span>
            {/* Weather & Road */}
            <span className={`px-2 py-0.5 rounded-lg border font-semibold ${
              isDark ? 'bg-slate-950/80 border-slate-800 text-slate-300' : 'bg-white border-slate-200 text-slate-700'
            }`}>
              🌤️ {outdoorTemp > 0 ? `+${outdoorTemp}` : outdoorTemp}°C {climateOn ? (outdoorTemp < 19 ? '• Обогрев' : '• A/C') : '• ЭКО'}
              {livePrecipitation.impactPct > 0 ? ` • ${livePrecipitation.label}` : ''}
              {forecast.windImpactPct !== 0 ? ` • Ветер ${(forecast.windImpactPct ?? 0) > 0 ? '+' : ''}${forecast.windImpactPct}%` : ''}
            </span>
          </div>

      </div>

      {/* 5. SoC AT DESTINATION FORECAST (Цель поездки) */}
      <div className={`order-1 w-full max-w-lg mx-auto rounded-2xl p-3 sm:p-4 border transition-colors ${
        isDark
          ? 'bg-slate-900/90 border-slate-800/90 shadow-lg'
          : 'bg-slate-50 border-slate-200 shadow-xs'
      }`}>
        <div className="flex items-center gap-1.5 mb-2.5">
          <div className={`p-1.5 rounded-lg border shrink-0 ${
            isDark ? 'bg-slate-950 border-slate-800 text-violet-400' : 'bg-white border-slate-200 text-violet-600'
          }`}>
            <Flag className="w-4 h-4" />
          </div>
          <div className="text-left min-w-0">
            <span className={`text-xs font-bold uppercase tracking-wider block ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
              SOC на финише
            </span>
            <span className={`text-[10px] block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Живой прогноз заряда на финише по маршруту
            </span>
          </div>
        </div>

        {/* Destination — address only in Live Consumption mode */}
        {/* Input + Submit */}
        <div className="flex gap-1.5">
          <input
            type="text"
            inputMode="text" 
            value={destinationQuery}
            onChange={(e) => setDestinationQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCalculateDestination();
            }}
            placeholder="Город, улица, дом…"
            className={`flex-1 min-w-0 px-3 py-2 rounded-xl border text-xs font-medium focus:outline-hidden focus:ring-1 focus:ring-emerald-500 ${
              isDark
                ? 'bg-slate-950 border-slate-800 text-white placeholder:text-slate-600'
                : 'bg-white border-slate-200 text-slate-900 placeholder:text-slate-400'
            }`}
          />
          <span className={`px-2.5 py-2 rounded-xl border text-[10px] font-semibold flex items-center gap-1 shrink-0 ${
            isDark ? 'bg-slate-950 border-slate-800 text-slate-500' : 'bg-white border-slate-200 text-slate-500'
          }`}>
            <MapPin className="w-3.5 h-3.5" /> Цель
          </span>
        </div>

        {/* Error */}
        {destinationError && (
          <div className={`mt-2 rounded-xl p-2 flex items-center gap-2 text-[11px] border ${
            isDark ? 'bg-amber-950/60 border-amber-800/70 text-amber-200' : 'bg-amber-50 border-amber-200 text-amber-900'
          }`}>
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
            <span>{destinationError}</span>
          </div>
        )}

        {/* Result */}
        {destinationResult && (
          <div className={`mt-2.5 p-3 rounded-2xl border text-left ${
            isDark ? 'bg-slate-950/90 border-slate-800/80' : 'bg-white border-slate-200'
          }`}>
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="min-w-0">
                <span className={`text-[10px] block ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {destinationResult.approximate ? 'Оценка по прямой (без учета дорог)' : 'До'}
                </span>
                <span className={`text-xs font-bold block truncate ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                  {destinationResult.name}
                </span>
              </div>
              <button
                onClick={() => {
                  setDestinationResult(null);
    setDestinationBreakdownOpen(false);
                  setDestinationQuery('');
                }}
                className={`shrink-0 text-[11px] ${isDark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-700'}`}
              >
                ✕
              </button>
            </div>

            <div className="flex items-baseline gap-2 mb-2 flex-wrap">
              <span className={`text-[11px] font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Ожидаемый SOC на финише:
              </span>
              <span className={`text-5xl font-black font-mono tracking-tight ${
                destinationResult.predictedSoc < 10
                  ? 'text-rose-500'
                  : destinationResult.predictedSoc < 20
                  ? 'text-amber-500'
                  : isDark ? 'text-emerald-400' : 'text-emerald-600'
              }`}>
                {destinationResult.predictedSoc}%
              </span>
              {destinationResult.isLive && (
                <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-md ${
                  isDark ? 'bg-emerald-950/70 text-emerald-400' : 'bg-emerald-50 text-emerald-700'
                }`}>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  LIVE · SOC
                </span>
              )}
            </div>

            {destinationResult.predictedSoc <= 0 && (
              <div className={`mb-2 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold border ${
                isDark ? 'bg-rose-950/70 border-rose-800 text-rose-300' : 'bg-rose-50 border-rose-300 text-rose-800'
              }`}>
                ⚠️ Заряда не хватит — потребуется подзарядка в пути
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <span className={`block text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{destinationResult.isLive ? 'Осталось' : 'Дистанция'}</span>
                <span className={`font-mono font-bold ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`}>{destinationResult.distanceKm} км</span>
              </div>
              <div>
                <span className={`block text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Время в пути</span>
                <span className={`font-mono font-bold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                  {destinationResult.etaMinutes ? `~${destinationResult.etaMinutes} мин` : '—'}
                  {destinationResult.arrivalTimeLabel && (
                    <span className={`ml-1 font-normal ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      (к {destinationResult.arrivalTimeLabel})
                    </span>
                  )}
                </span>
              </div>
              <div>
                <span className={`block text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Расход маршрута</span>
                <span className={`font-mono font-bold ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                  {destinationResult.predictedConsumption.toFixed(1)} кВт⋅ч/100
                </span>
              </div>
              <div>
                <span className={`block text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Рельеф</span>
                <span className={`font-mono font-bold flex items-center gap-1 ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                  <Mountain className="w-3 h-3" /> ▲{destinationResult.gainM}м ▼{destinationResult.lossM}м
                </span>
              </div>
              <div>
                <span className={`block text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  Погода {destinationResult.forecastUsed ? 'к прибытию' : '(текущая)'}
                </span>
                <span className={`font-mono font-bold flex items-center gap-1 ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                  {destinationResult.forecastTemperature !== undefined
                    ? `${destinationResult.forecastTemperature > 0 ? '+' : ''}${destinationResult.forecastTemperature}°C`
                    : weather.isLoaded ? `${weather.temperature > 0 ? '+' : ''}${weather.temperature}°C` : '—'}
                  {destinationResult.forecastWindSpeed !== undefined && (
                    <span className={isDark ? 'text-cyan-400' : 'text-cyan-600'}>· {destinationResult.forecastWindSpeed} км/ч</span>
                  )}
                </span>
              </div>
            </div>
            {destinationResult.forecastPrecipLabel && (
              <span className={`block mt-1.5 text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {destinationResult.forecastPrecipLabel}
              </span>
            )}
            {destinationResult.breakdown && (
              <div className={`mt-3 rounded-xl border ${isDark ? 'bg-slate-900/80 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'}`}>
                <button onClick={() => setDestinationBreakdownOpen(v => !v)} className="w-full p-3 flex items-center justify-between text-left">
                  <span className="text-[10px] font-bold uppercase tracking-wider">Разбор поездки</span>
                  <ChevronDown className={`w-4 h-4 transition-transform ${destinationBreakdownOpen ? 'rotate-180' : ''}`} />
                </button>
                {destinationBreakdownOpen && <div className="px-3 pb-3">
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
                    <div className="flex justify-between gap-2"><span>Базовое движение</span><b>{destinationResult.breakdown.baseEnergyKwh.toFixed(2)} кВт⋅ч</b></div>
                    <div className="flex justify-between gap-2"><span>Температура</span><b>{destinationResult.breakdown.temperatureDeltaKwh >= 0 ? '+' : ''}{destinationResult.breakdown.temperatureDeltaKwh.toFixed(2)}</b></div>
                    <div className="flex justify-between gap-2"><span>Ветер</span><b>{destinationResult.breakdown.windDeltaKwh >= 0 ? '+' : ''}{destinationResult.breakdown.windDeltaKwh.toFixed(2)}</b></div>
                    <div className="flex justify-between gap-2"><span>Осадки / дорога</span><b>{destinationResult.breakdown.precipitationDeltaKwh >= 0 ? '+' : ''}{destinationResult.breakdown.precipitationDeltaKwh.toFixed(2)}</b></div>
                    <div className="flex justify-between gap-2"><span>Стиль</span><b>{destinationResult.breakdown.driverDeltaKwh >= 0 ? '+' : ''}{destinationResult.breakdown.driverDeltaKwh.toFixed(2)}</b></div>
                    <div className="flex justify-between gap-2"><span>Рельеф</span><b>{destinationResult.breakdown.elevationDeltaKwh >= 0 ? '+' : ''}{destinationResult.breakdown.elevationDeltaKwh.toFixed(2)}</b></div>
                    <div className="flex justify-between gap-2"><span>Климат</span><b>+{destinationResult.breakdown.climateEnergyKwh.toFixed(2)}</b></div>
                    <div className="flex justify-between gap-2"><span>Рекуперация</span><b>−{destinationResult.breakdown.regenEnergyKwh.toFixed(2)}</b></div>
                  </div>
                  <div className="mt-2 pt-2 border-t border-slate-500/20 flex justify-between text-[10px] font-bold"><span>Сегментов</span><span>{destinationResult.breakdown.segments}</span></div>
                  <div className="mt-2 text-[9px] text-slate-500">Погода и ветер интерполируются по маршруту, рельеф считается по каждому сегменту.</div>
                </div>}
              </div>
            )}
            <span className={`block mt-2 text-[9px] ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
              {destinationResult.forecastUsed
                ? `Расчет использует прогноз погоды на время прибытия (${destinationResult.arrivalTimeLabel ?? '—'}), а не текущие условия.`
                : 'Прогноз погоды на время прибытия получить не удалось — использованы текущие условия.'}
              {' '}
              {destinationResult.approximate
                ? 'Режим "по дистанции" не строит маршрут — рельеф экстраполирован из уже проеханного пути (или считается ровным).'
                : 'Маршрут через публичный OSRM-роутер, высоты через Open-Elevation — оценка, а не точная навигация.'}
            </span>
          </div>
        )}
      </div>

      {/* Trip Tracking Metrics & Controls */}
      <div className="hud-trip-stats space-y-2.5 pt-1">
        {/* Live Trip Stats Grid (Distance, Average Speed, Time) */}
        <div className="grid grid-cols-3 gap-2">
          {/* Distance */}
          <div className={`rounded-xl p-2 text-center border transition-colors ${
            isDark ? 'bg-slate-900/90 border-slate-800' : 'bg-slate-50 border-slate-200 shadow-2xs'
          }`}>
            <span className={`text-[9px] uppercase font-bold tracking-wider block ${
              isDark ? 'text-slate-400' : 'text-slate-500'
            }`}>
              Дистанция
            </span>
            <div className="flex items-baseline justify-center gap-0.5 mt-0.5">
              <span className={`text-xl sm:text-2xl font-black font-mono ${
                isDark ? 'text-cyan-400' : 'text-cyan-600'
              }`}>
                {tripDistanceKm.toFixed(1)}
              </span>
              <span className={`text-[9px] font-bold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>км</span>
            </div>
          </div>

          {/* Average Speed */}
          <div className={`rounded-xl p-2 text-center border transition-colors ${
            isDark ? 'bg-slate-900/90 border-slate-800' : 'bg-slate-50 border-slate-200 shadow-2xs'
          }`}>
            <span className={`text-[9px] uppercase font-bold tracking-wider block ${
              isDark ? 'text-slate-400' : 'text-slate-500'
            }`}>
              Ср. скорость
            </span>
            <div className="flex items-baseline justify-center gap-0.5 mt-0.5">
              <span className={`text-xl sm:text-2xl font-black font-mono ${
                isDark ? 'text-emerald-400' : 'text-emerald-600'
              }`}>
                {avgTripSpeedKmH}
              </span>
              <span className={`text-[9px] font-bold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>км/ч</span>
            </div>
          </div>

          {/* Elapsed Time */}
          <div className={`rounded-xl p-2 text-center border transition-colors ${
            isDark ? 'bg-slate-900/90 border-slate-800' : 'bg-slate-50 border-slate-200 shadow-2xs'
          }`}>
            <span className={`text-[9px] uppercase font-bold tracking-wider block ${
              isDark ? 'text-slate-400' : 'text-slate-500'
            }`}>
              Время
            </span>
            <div className="flex items-baseline justify-center gap-0.5 mt-0.5">
              <span className={`text-base sm:text-lg font-bold font-mono ${
                isDark ? 'text-slate-200' : 'text-slate-800'
              }`}>
                {formatTime(elapsedSeconds)}
              </span>
            </div>
          </div>
        </div>

        {/* Secondary trip controls — the primary start action is kept near the top. */}
        {isTracking && (
          <div className="grid grid-cols-2 gap-2 mt-1">
            <button
              onClick={handleStopTracking}
              className="py-2.5 px-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-black text-xs shadow-md shadow-rose-600/20 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
            >
              <Square className="w-4 h-4 fill-current" />
              <span>Завершить поездку</span>
            </button>
            <button
              onClick={handleResetTracking}
              className={`py-2.5 px-3 rounded-xl font-bold text-xs border active:scale-[0.98] transition-all flex items-center justify-center gap-2 ${
                isDark
                  ? 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300'
              }`}
            >
              <RotateCcw className="w-4 h-4" />
              <span>Сбросить</span>
            </button>
          </div>
        )}
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
    </div>
  );
};
