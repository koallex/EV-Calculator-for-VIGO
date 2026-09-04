import React, { useEffect, useState } from 'react';
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
} from 'lucide-react';
import { UserSettings, RoadType, TripSession } from '../types';
import { BatteryVisual } from './BatteryVisual';
import { DecimalInput } from './DecimalInput';
import { getTariffForType, getOperatorLabel, estimateTripConsumption, estimateSegmentedRouteConsumption, calculateClimateImpact } from '../utils/storage';
import { triggerHaptic } from '../utils/haptics';
import { saveLastRouteForecast } from '../utils/routeForecastBridge';
import { buildRouteElevation, geocodeAddress, RouteElevationData, RouteProgress } from '../services/routeElevation';
import { fetchForecastWeatherAt, fetchForecastWeatherAlongRoute, RouteWeatherSample } from '../services/weatherForecast';
import { RouteMap } from './RouteMap';
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
  const [routeStatus, setRouteStatus] = useState('');
  const [routeElevation, setRouteElevation] = useState<RouteElevationData | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState('');
  const [plannedSpeedKmH, setPlannedSpeedKmH] = useState(70);
  const [plannedMaxSpeedKmH, setPlannedMaxSpeedKmH] = useState(120);
  const [routeWeather, setRouteWeather] = useState<{ temperature:number; windSpeed:number; windDirection:number; weatherCode:number; precipitation:number; routeBearing:number; etaMinutes:number; arrivalDate: Date; samples: RouteWeatherSample[] } | null>(null);
  const [routeForecast, setRouteForecast] = useState<{ consumption:number; energyKwh:number; arrivalSoc:number; windLabel:string; weatherLabel:string; precipitationLabel:string; relativeWindAngle:number; driverStyleFactor:number; driverStyleSource:string; climateLabel:string; climateImpactPct:number; climateDeltaKwh100:number; speedImpactPct:number; breakdown?: any } | null>(null);
  const [gpsStatus, setGpsStatus] = useState<'searching' | 'ok' | 'error'>('searching');
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
      const el =
        document.getElementById('route-result-main') ||
        document.getElementById('route-result-summary');
      el?.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [resultHighlight, routeForecast]);

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

  const calculateRouteProfile = async () => {
    if (!destinationAddress.trim()) { setRouteError('Введите адрес точки Б'); return; }
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
      } else { setRouteStatus('Ищем начальный адрес…'); start = await geocodeAddress(startAddress.trim()); }
      setRouteStatus('Ищем адрес назначения…');
      const destination = await geocodeAddress(destinationAddress.trim());
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
        fallbackWeather, plannedSpeedKmH, sessions, settings.batteryCapacityKwh, climateOn, undefined, passengers, plannedMaxSpeedKmH
      );
      const energyKwh = segmented.energyKwh;
      const arrivalSoc = Math.max(0, Number((startSoc - (energyKwh/(settings.batteryCapacityKwh||51.87))*100).toFixed(1)));
      const segmentedForecast = estimateTripConsumption(
        plannedSpeedKmH, segmented.avgTemperature, sessions, settings.batteryCapacityKwh, climateOn,
        segmented.avgWindSpeed, avgRelativeWindAngle, undefined, avgWeatherCode, segmented.avgPrecipitation,
        {gainM:data.elevationGainM, lossM:data.elevationLossM, distanceKm:data.distanceKm}, segmented.durationHours, segmented.climatePowerKw, passengers
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
      climateOn, undefined, passengers, Math.max(plannedMaxSpeedKmH, speed)
    );
    const energyKwh = breakdown.energyKwh;
    const arrivalSoc = Math.max(0, Number((startSoc - (energyKwh / (settings.batteryCapacityKwh || 51.87)) * 100).toFixed(1)));
    const forecast = estimateTripConsumption(
      speed, breakdown.avgTemperature, sessions, settings.batteryCapacityKwh, climateOn,
      breakdown.avgWindSpeed, routeForecast?.relativeWindAngle ?? 0, undefined,
      routeWeather.weatherCode, breakdown.avgPrecipitation,
      { gainM: routeElevation.elevationGainM, lossM: routeElevation.elevationLossM, distanceKm: routeElevation.distanceKm },
      breakdown.durationHours, breakdown.climatePowerKw, passengers
    );
    return { speed, consumption: Number((energyKwh / routeElevation.distanceKm * 100).toFixed(2)), arrivalSoc, speedImpactPct: forecast.speedImpactPct, breakdown };
  };

  const applyWhatIfSpeed = (speed: number) => {
    const scenario = getWhatIfScenario(speed);
    if (!scenario || !routeForecast || !routeElevation) return;
    const energyKwh = Number(((routeElevation.distanceKm / 100) * scenario.consumption).toFixed(2));
    setPlannedSpeedKmH(speed);
    setRouteForecast({ ...routeForecast, consumption: scenario.consumption, energyKwh, arrivalSoc: scenario.arrivalSoc, speedImpactPct: scenario.speedImpactPct, breakdown: scenario.breakdown });
    setEndSoc(scenario.arrivalSoc);
  };

  /** Compare current route with HVAC on vs off without rebuilding the route. */
  const getClimateScenario = (withClimate: boolean) => {
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
      plannedSpeedKmH,
      sessions,
      settings.batteryCapacityKwh,
      withClimate,
      undefined,
      passengers,
      plannedMaxSpeedKmH
    );
    const energyKwh = breakdown.energyKwh;
    const arrivalSoc = Math.max(0, Number((startSoc - (energyKwh / (settings.batteryCapacityKwh || 51.87)) * 100).toFixed(1)));
    return {
      withClimate,
      consumption: Number((energyKwh / routeElevation.distanceKm * 100).toFixed(2)),
      energyKwh: Number(energyKwh.toFixed(2)),
      arrivalSoc,
      breakdown,
    };
  };

  const applyClimateScenario = (withClimate: boolean) => {
    const scenario = getClimateScenario(withClimate);
    if (!scenario || !routeForecast) return;
    setClimateOn(withClimate);
    setRouteForecast({
      ...routeForecast,
      consumption: scenario.consumption,
      energyKwh: scenario.energyKwh,
      arrivalSoc: scenario.arrivalSoc,
      breakdown: scenario.breakdown,
      climateLabel: withClimate ? routeForecast.climateLabel : 'Климат выкл',
      climateImpactPct: withClimate ? routeForecast.climateImpactPct : 0,
    });
    setEndSoc(scenario.arrivalSoc);
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
    if (cons < 13.5) return { label: 'Супер экономно', color: 'text-emerald-400', bg: 'bg-emerald-950/80 border-emerald-800/60' };
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
            <span className={`inline-flex h-2 w-2 shrink-0 rounded-full ${gpsStatus === 'ok' ? 'bg-emerald-500' : gpsStatus === 'error' ? 'bg-rose-500' : 'bg-amber-500 animate-pulse'}`} />
            <LocateFixed className={`w-4 h-4 shrink-0 ${gpsStatus === 'ok' ? 'text-emerald-500' : gpsStatus === 'error' ? 'text-rose-500' : 'text-amber-500'}`} />
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
          <span className={`text-xl font-black font-mono tabular-nums ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>{Math.round(startSoc)}%</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => updateRouteStartSoc(startSoc - 5)} className={`w-10 h-9 rounded-lg font-bold text-xs border ${isDark ? 'bg-slate-950 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'}`}>−5</button>
          <input type="range" min={1} max={100} value={startSoc} onChange={(e) => updateRouteStartSoc(Number(e.target.value))} className="flex-1 accent-emerald-500 h-1.5 rounded-lg cursor-pointer" />
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
                ? isDark ? 'bg-emerald-950/70 text-emerald-300 border-emerald-500/60' : 'bg-emerald-600 text-white border-emerald-700'
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
                className="absolute inset-0 rounded-xl bg-emerald-600 shadow-sm"
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
                className="absolute inset-0 rounded-xl bg-emerald-600 shadow-sm"
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

      {/* Compact result strip — always visible at top once a route is calculated */}
      {routeForecast && (
        <section
          id="route-result-summary"
          className={`rounded-2xl border px-3.5 py-3 transition-shadow duration-500 ${
            resultHighlight
              ? isDark
                ? 'bg-emerald-950/50 border-emerald-400/70 shadow-lg shadow-emerald-500/20 ring-2 ring-emerald-400/40'
                : 'bg-emerald-50 border-emerald-400 shadow-lg shadow-emerald-500/15 ring-2 ring-emerald-400/50'
              : isDark
              ? 'bg-emerald-950/40 border-emerald-800/60'
              : 'bg-emerald-50 border-emerald-200'
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-emerald-300/80' : 'text-emerald-700'}`}>
                SOC на финише
              </div>
              <div className="flex items-baseline gap-2 mt-0.5">
                <AnimatedNumber
                  value={routeForecast.arrivalSoc}
                  decimals={1}
                  suffix="%"
                  className={`text-3xl font-black font-mono ${
                    routeForecast.arrivalSoc >= 20
                      ? isDark ? 'text-emerald-400' : 'text-emerald-600'
                      : routeForecast.arrivalSoc >= ARRIVAL_RESERVE_SOC
                      ? 'text-amber-500'
                      : 'text-rose-500'
                  }`}
                />
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className={`text-sm font-bold font-mono ${isDark ? 'text-white' : 'text-slate-900'}`}>
                <AnimatedNumber value={routeForecast.consumption} decimals={1} className={isDark ? 'text-white' : 'text-slate-900'} /> <span className="text-[10px] font-semibold text-slate-500">кВт⋅ч/100</span>
              </div>
              <div className={`text-[11px] mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {routeForecast.energyKwh.toFixed(1)} кВт⋅ч
                {routeElevation ? ` · ${routeElevation.distanceKm} км` : ''}
                {routeWeather?.etaMinutes != null ? ` · ~${routeWeather.etaMinutes} мин` : ''}
              </div>
            </div>
          </div>
          </section>
      )}

      {/* Route: A → B + calculate */}
      <section className={`calculator-route rounded-2xl border p-3 space-y-3 ${isDark ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200 shadow-xs'}`}>
        <div className={`grid grid-cols-2 rounded-xl p-1 ${isDark ? 'bg-slate-950' : 'bg-slate-100'}`}>
          <button onClick={() => setStartMode('gps')} className={`rounded-lg py-2 text-xs font-semibold ${startMode === 'gps' ? (isDark ? 'bg-slate-800 text-white' : 'bg-white text-slate-900 shadow-sm') : 'text-slate-500'}`}>📍 Здесь</button>
          <button onClick={() => setStartMode('address')} className={`rounded-lg py-2 text-xs font-semibold ${startMode === 'address' ? (isDark ? 'bg-slate-800 text-white' : 'bg-white text-slate-900 shadow-sm') : 'text-slate-500'}`}>🏠 Адрес А</button>
        </div>

        {startMode === 'address' && (
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input value={startAddress} onChange={e => setStartAddress(e.target.value)} placeholder="Откуда? Город, улица, дом" className={`w-full rounded-xl border py-3 pl-9 pr-3 text-sm outline-none ${isDark ? 'bg-slate-950 border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'}`} />
          </div>
        )}

        {startMode === 'address' && (startAddress || destinationAddress) && (
          <div className="flex justify-center -my-1.5 relative z-10">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light', settings.hapticFeedback);
                const from = startAddress;
                setStartAddress(destinationAddress);
                setDestinationAddress(from);
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
          <input value={destinationAddress} onChange={e => setDestinationAddress(e.target.value)} placeholder="Куда? Город, улица, дом" className={`w-full rounded-xl border py-3 pl-9 pr-3 text-sm outline-none ${isDark ? 'bg-slate-950 border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900'}`} />
        </div>

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
          onClick={calculateRouteProfile}
          disabled={routeLoading}
          className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 py-3.5 text-sm font-bold text-white disabled:opacity-60 flex items-center justify-center gap-2 active:scale-[0.98] transition-all shadow-sm shadow-emerald-600/20"
        >
          {routeLoading
            ? <><Loader2 className="w-5 h-5 animate-spin" /> Считаем маршрут…</>
            : <><Navigation className="w-5 h-5" /> Рассчитать маршрут</>}
        </button>

        {routeLoading && <div className="text-xs text-emerald-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />{routeStatus || 'Подготавливаем расчёт…'}</div>}
        {routeError && <div className="text-xs text-rose-500">{routeError}</div>}
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
                  ? '⚠ Небольшой запас по прибытию'
                  : startSoc >= 99
                  ? '⚠ Потребуется зарядка в пути'
                  : '⚠ Недостаточно заряда — зарядка до поездки или в пути';
              const statusColor =
                statusTone === 'good'
                  ? isDark
                    ? 'text-emerald-400'
                    : 'text-emerald-600'
                  : statusTone === 'ok'
                  ? 'text-amber-500'
                  : 'text-rose-500';
              const slower = getWhatIfScenario(Math.max(20, plannedSpeedKmH - 10));
              const noClimate = getClimateScenario(false);
              return (
              <div
                id="route-result-main"
                className={`rounded-2xl border p-4 transition-shadow duration-500 ${
                  resultHighlight
                    ? isDark
                      ? 'bg-slate-950/80 border-emerald-400/70 shadow-lg shadow-emerald-500/15 ring-2 ring-emerald-400/30'
                      : 'bg-emerald-50/80 border-emerald-400 shadow-lg shadow-emerald-500/10 ring-2 ring-emerald-400/40'
                    : isDark
                    ? 'bg-slate-950/70 border-emerald-900/60'
                    : 'bg-emerald-50/60 border-emerald-200'
                }`}
              >
                <div className="text-center">
                  <div className={`text-[11px] font-bold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>SOC на финише</div>
                  <div className={`mt-1 text-5xl font-black font-mono ${statusColor}`}>
                    <AnimatedNumber value={arrival} decimals={0} suffix="%" className={statusColor} />
                  </div>
                  <div className={`mt-1 text-xs font-semibold px-1 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{statusText}</div>
                  <div className={`mt-1.5 text-[11px] leading-snug px-2 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    Ориентировочно — зависит от стиля езды и погоды
                  </div>
                </div>

                <div className={`mt-4 h-3 rounded-full overflow-hidden ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`}>
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${statusTone === 'good' ? 'bg-emerald-500' : statusTone === 'ok' ? 'bg-amber-500' : 'bg-rose-500'}`}
                    style={{ width: `${Math.min(100, Math.max(0, arrival))}%` }}
                  />
                </div>
                <div className="mt-2 flex justify-between text-[10px] text-slate-500">
                  <span>0%</span>
                  <span>старт {Math.round(startSoc)}%</span>
                  <span>100%</span>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 text-center">
                  <div className={`rounded-xl px-2 py-2 ${isDark ? 'bg-slate-900/80' : 'bg-white/80'}`}>
                    <div className={`text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Расход</div>
                    <div className="text-sm font-black font-mono">
                      <AnimatedNumber value={routeForecast.consumption} decimals={1} />
                    </div>
                    <div className="text-[10px] text-slate-500">кВт⋅ч/100</div>
                  </div>
                  <div className={`rounded-xl px-2 py-2 ${isDark ? 'bg-slate-900/80' : 'bg-white/80'}`}>
                    <div className={`text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Всего</div>
                    <div className="text-sm font-black font-mono">
                      <AnimatedNumber value={routeForecast.energyKwh} decimals={1} />
                    </div>
                    <div className="text-[10px] text-slate-500">кВт⋅ч</div>
                  </div>
                </div>

                {/* Low-reserve action banner */}
                {statusTone === 'low' && (
                  <div className={`mt-3 rounded-xl border p-3 ${isDark ? 'bg-rose-950/40 border-rose-700/50' : 'bg-rose-50 border-rose-300'}`}>
                    <div className={`text-xs font-bold ${isDark ? 'text-rose-300' : 'text-rose-800'}`}>
                      Низкий запас на финише
                    </div>
                    <p className={`mt-1 text-[11px] ${isDark ? 'text-rose-200/80' : 'text-rose-700'}`}>
                      При текущих скорости, климате и стартовом SOC запас будет очень маленьким. Варианты:
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {slower && (
                        <button
                          type="button"
                          onClick={() => {
                            triggerHaptic('light', settings.hapticFeedback);
                            applyWhatIfSpeed(Math.max(20, plannedSpeedKmH - 10));
                          }}
                          className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold border ${
                            isDark ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-white border-rose-200 text-rose-900'
                          }`}
                        >
                          Снизить скорость до {Math.max(20, plannedSpeedKmH - 10)} км/ч
                          <span className="opacity-70"> → {Math.round(slower.arrivalSoc)}%</span>
                        </button>
                      )}
                      {climateOn && noClimate && (
                        <button
                          type="button"
                          onClick={() => {
                            triggerHaptic('light', settings.hapticFeedback);
                            applyClimateScenario(false);
                          }}
                          className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold border ${
                            isDark ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-white border-rose-200 text-rose-900'
                          }`}
                        >
                          Выключить климат
                          <span className="opacity-70"> → {Math.round(noClimate.arrivalSoc)}%</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light', settings.hapticFeedback);
                          updateRouteStartSoc(Math.min(100, startSoc + 10));
                        }}
                        className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold border ${
                          isDark ? 'bg-slate-900 border-slate-700 text-slate-200' : 'bg-white border-rose-200 text-rose-900'
                        }`}
                      >
                        +10% к стартовому SOC
                      </button>
                    </div>
                  </div>
                )}

                {routeWeather && (
                  <ChipRow
                    isDark={isDark}
                    className="mt-3 justify-center"
                    items={[
                      {
                        label: (
                          <span className="inline-flex items-center gap-1"><CloudSun className="w-3 h-3" />Погода</span>
                        ),
                        value: (
                          <>
                            {routeForecast.weatherLabel}
                            <span className="font-normal opacity-70">
                              {' · '}{weatherMode === 'planning' ? 'ручные условия' : `к ${routeWeather.arrivalDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`}
                            </span>
                          </>
                        ),
                      },
                      {
                        label: (
                          <span className="inline-flex items-center gap-1">
                            <ArrowDown className="w-3 h-3 shrink-0" style={{ transform: `rotate(${routeForecast.relativeWindAngle}deg)` }} />
                            Ветер
                          </span>
                        ),
                        value: routeForecast.windLabel,
                      },
                    ]}
                  />
                )}
              </div>
              );
            })()}

            {/* Primary post-calc UI: SOC (above) → What if → HUD → Details */}
            <div className={`rounded-xl border p-3 ${isDark ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold inline-flex items-center gap-2"><Gauge className="w-4 h-4 text-emerald-500" />А что если?</span>
                <span className="text-[10px] text-slate-500">Без пересчёта маршрута</span>
              </div>

              {/* Climate on/off comparison */}
              <div className="mt-3">
                <div className={`text-[10px] font-semibold mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Климат</div>
                <div className="grid grid-cols-2 gap-2">
                  {([true, false] as const).map((withClimate) => {
                    const scenario = getClimateScenario(withClimate);
                    const active = climateOn === withClimate;
                    return (
                      <button
                        key={withClimate ? 'on' : 'off'}
                        type="button"
                        onClick={() => applyClimateScenario(withClimate)}
                        className={`rounded-lg border px-2 py-2 text-left transition-colors ${
                          active
                            ? 'border-emerald-500 bg-emerald-500/10'
                            : isDark
                            ? 'border-slate-800 bg-slate-900'
                            : 'border-slate-200 bg-white'
                        }`}
                      >
                        <div className="text-xs font-bold">{withClimate ? 'С климатом' : 'Без климата'}</div>
                        <div className={`mt-1 text-[11px] font-bold ${scenario && scenario.arrivalSoc >= 20 ? 'text-emerald-500' : scenario && scenario.arrivalSoc >= 10 ? 'text-amber-500' : 'text-rose-500'}`}>
                          {scenario ? `${Math.round(scenario.arrivalSoc)}% SOC` : '—'}
                        </div>
                        {scenario && (
                          <div className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                            {scenario.consumption.toFixed(1)} кВт⋅ч/100 · {scenario.energyKwh.toFixed(1)} кВт⋅ч
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Speed what-if */}
              <div className="mt-3">
                <div className={`text-[10px] font-semibold mb-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Скорость</div>
                <div className="grid grid-cols-3 gap-2">
                  {[Math.max(20, plannedSpeedKmH - 10), plannedSpeedKmH, Math.min(140, plannedSpeedKmH + 10)].map((speed) => {
                    const scenario = getWhatIfScenario(speed);
                    const active = speed === plannedSpeedKmH;
                    return (
                      <button
                        key={speed}
                        type="button"
                        onClick={() => applyWhatIfSpeed(speed)}
                        className={`rounded-lg border px-2 py-2 text-center transition-colors ${
                          active
                            ? 'border-emerald-500 bg-emerald-500/10'
                            : isDark
                            ? 'border-slate-800 bg-slate-900'
                            : 'border-slate-200 bg-white'
                        }`}
                      >
                        <div className="text-xs font-bold">{speed} км/ч</div>
                        <div className={`mt-1 text-[11px] font-bold ${scenario && scenario.arrivalSoc >= 20 ? 'text-emerald-500' : scenario && scenario.arrivalSoc >= 10 ? 'text-amber-500' : 'text-rose-500'}`}>
                          {scenario ? `${Math.round(scenario.arrivalSoc)}% SOC` : '—'}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="mt-2 text-[10px] text-slate-500">Нажмите вариант — прогноз SOC обновится сразу, без нового запроса маршрута.</div>
            </div>

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
                  <div className={`rounded-xl border p-3 ${isDark ? 'bg-emerald-950/30 border-emerald-900/60' : 'bg-emerald-50 border-emerald-200'}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className={`text-[10px] font-bold uppercase tracking-wide ${isDark ? 'text-emerald-300' : 'text-emerald-700'}`}>Оптимальная скорость</div>
                        <div className={`mt-0.5 text-2xl font-black font-mono ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>{optimalSpeedScenario.speed} км/ч</div>
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
                  <div className="flex justify-between mt-1"><span>Рекуперация</span><b className="text-emerald-500">−{routeElevation.recoveredEnergyKwh.toFixed(2)} кВт⋅ч</b></div>
                  <div className="flex justify-between mt-2 pt-2 border-t border-slate-500/20"><span>Скорр. расход</span><b>{elevationAdjustedConsumption.toFixed(1)} кВт⋅ч/100 км</b></div>
                </div>

                <div className={`rounded-xl border overflow-hidden ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                  <RouteMap points={routeElevation.points} isDark={isDark} />
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
        icon={<CloudSun className="w-4 h-4 text-emerald-500" />}
        open={weatherPanelOpen}
        onToggle={() => setWeatherPanelOpen(v => !v)}
        className="rounded-2xl"
      >
        <div className="space-y-3">
          <div className={`grid grid-cols-2 rounded-xl p-1 ${isDark ? 'bg-slate-950' : 'bg-slate-100'}`}>
            <button type="button" onClick={() => setWeatherMode('current')} className={`rounded-lg py-2 text-xs font-semibold ${weatherMode === 'current' ? (isDark ? 'bg-slate-800 text-white' : 'bg-white text-slate-900 shadow-sm') : 'text-slate-500'}`}>Сейчас</button>
            <button type="button" onClick={() => setWeatherMode('planning')} className={`rounded-lg py-2 text-xs font-semibold ${weatherMode === 'planning' ? (isDark ? 'bg-slate-800 text-white' : 'bg-white text-slate-900 shadow-sm') : 'text-slate-500'}`}>Планирование</button>
          </div>
          {weatherMode === 'current' ? (
            <div className="text-xs text-slate-500">Актуальная погода по маршруту и времени прибытия.</div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs"><span className="block text-slate-500 mb-1">🌡️ °C</span><DecimalInput value={manualTemperature} onChange={setManualTemperature} min={-40} max={50} allowNegative className="w-full" /></label>
                <label className="text-xs"><span className="block text-slate-500 mb-1">💨 м/с</span><DecimalInput value={manualWindSpeed} onChange={setManualWindSpeed} min={0} max={40} className="w-full" /></label>
              </div>
              <div className="flex items-center gap-2"><Navigation className="w-4 h-4 text-slate-400" style={{transform:`rotate(${manualWindDirection}deg)`}} /><span className="text-xs text-slate-500">Ветер</span><DecimalInput value={manualWindDirection} onChange={(v) => setManualWindDirection(((Math.round(v)%360)+360)%360)} min={0} max={359} className="ml-auto w-20 text-right" /><span className="text-xs text-slate-500">°</span></div>
              <div><div className="text-[11px] text-slate-500 mb-1.5">Осадки</div><div className="grid grid-cols-3 gap-1">{([['none','Нет'],['rain','Дождь'],['snow','Снег']] as const).map(([v,label]) => <button key={v} type="button" onClick={() => setManualPrecipitationType(v)} className={`rounded-lg py-2 text-xs font-semibold border ${manualPrecipitationType===v ? 'border-emerald-500 bg-emerald-500/10 text-emerald-500' : (isDark ? 'border-slate-800 text-slate-400' : 'border-slate-200 text-slate-600')}`}>{label}</button>)}</div></div>
              {manualPrecipitationType !== 'none' && (
                <div className="grid grid-cols-3 gap-1">
                  {(['light','moderate','heavy'] as const).map((v) => {
                    const label = v === 'light' ? 'Лёгкая' : v === 'moderate' ? 'Умеренная' : 'Сильная';
                    return (
                      <button key={v} type="button" onClick={() => setManualPrecipitationIntensity(v)}
                        className={`rounded-lg py-2 text-xs font-semibold border ${manualPrecipitationIntensity===v ? 'border-emerald-500 bg-emerald-500/10 text-emerald-500' : (isDark ? 'border-slate-800 text-slate-400' : 'border-slate-200 text-slate-600')}`}>
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
              isDark ? 'bg-emerald-950/40 border-emerald-800/60' : 'bg-emerald-50 border-emerald-200'
            }`}
          >
            <div className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-emerald-300/80' : 'text-emerald-700'}`}>
              Расход
            </div>
            <div className={`mt-1 text-5xl font-black font-mono tabular-nums ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
              {consumptionPer100Km > 0 ? (
                <AnimatedNumber value={consumptionPer100Km} decimals={1} className={isDark ? 'text-emerald-400' : 'text-emerald-600'} />
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
                <span className={`text-xl font-black font-mono ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>{Math.round(endSoc)}%</span>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => adjustValue(setEndSoc, -5, 0, Math.max(0, startSoc - 1))} className={`w-10 h-9 rounded-lg text-xs font-bold border ${isDark ? 'bg-slate-950 border-slate-800 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'}`}>−5</button>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, startSoc - 1)}
                  value={Math.min(endSoc, Math.max(0, startSoc - 1))}
                  onChange={(e) => setEndSoc(Number(e.target.value))}
                  className="flex-1 accent-emerald-500 h-1.5 cursor-pointer"
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
                        ? 'bg-slate-950 border-slate-700 text-emerald-400'
                        : 'bg-slate-50 border-slate-200 text-emerald-600'
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
                          ? 'bg-emerald-950/70 text-emerald-300 border-emerald-500/60'
                          : 'bg-emerald-600 text-white border-emerald-700'
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
                  <b className="text-emerald-500">+{moneySaved.toFixed(2)} {settings.currency}</b>
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
              className="flex-1 py-3.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm shadow-sm shadow-emerald-600/20 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
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
