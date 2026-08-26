export interface ForecastWeather {
  temperature: number;
  weatherCode: number;
  precipitation: number;
  windSpeed: number; // km/h
  windDirection: number; // degrees, direction wind blows FROM
}

/**
 * Hourly forecast (not just "current conditions") for a given point, sampled at the hour closest
 * to the estimated arrival time — so a trip predicts against the weather it will actually be
 * driven through, not the weather at the moment the calculation button was pressed.
 *
 * Free, keyless Open-Meteo endpoint — best-effort public service, so callers should treat a
 * thrown error or null-ish result as "forecast unavailable" and fall back to current conditions.
 */
export async function fetchForecastWeatherAt(
  lat: number,
  lon: number,
  arrivalDate: Date
): Promise<ForecastWeather | null> {
  try {
    const now = Date.now();
    const targetMs = arrivalDate.getTime();
    const daysAhead = (targetMs - now) / 86400000;

    // Up to 16 days: use the normal hourly forecast. Beyond that, use the
    // seasonal ECMWF product. For long-range dates we intentionally use the
    // seasonal DAILY mean/dominant values rather than pretending that a
    // 6-hourly seasonal value is a precise local forecast for a specific hour.
    const useOperationalForecast = daysAhead <= 16;

    if (useOperationalForecast) {
      const params = new URLSearchParams({
        latitude: lat.toFixed(4),
        longitude: lon.toFixed(4),
        hourly: 'temperature_2m,weather_code,precipitation,wind_speed_10m,wind_direction_10m',
        timezone: 'UTC',
        forecast_days: '16',
      });
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
      if (!res.ok) return null;
      const data = await res.json();
      const times: string[] = data?.hourly?.time;
      if (!Array.isArray(times) || !times.length) return null;

      let bestIdx = -1;
      let bestDiffMs = Infinity;
      times.forEach((t, i) => {
        const timeMs = new Date(t.endsWith('Z') ? t : `${t}Z`).getTime();
        const diff = Math.abs(timeMs - targetMs);
        if (diff < bestDiffMs) { bestDiffMs = diff; bestIdx = i; }
      });
      if (bestIdx < 0 || bestDiffMs > 2 * 3600000) return null;

      const temperature = data.hourly.temperature_2m?.[bestIdx];
      if (!Number.isFinite(temperature)) return null;
      return {
        temperature: Math.round(temperature),
        weatherCode: data.hourly.weather_code?.[bestIdx] ?? 0,
        precipitation: Number((data.hourly.precipitation?.[bestIdx] ?? 0).toFixed(1)),
        windSpeed: Math.round(data.hourly.wind_speed_10m?.[bestIdx] ?? 0),
        windDirection: Math.round(data.hourly.wind_direction_10m?.[bestIdx] ?? 0),
      };
    }

    // Seasonal API supports a long-range timerange of up to 217 days (~7 months)
    // through the generic `forecast_days` parameter. Request the full window and
    // then select the matching calendar date from the returned daily series.
    // by the API. Daily values are the appropriate resolution for a seasonal
    // outlook; they are not an hourly forecast for the chosen departure time.
    const params = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      daily: 'temperature_2m_mean,weather_code,precipitation_sum,wind_speed_10m_mean,wind_direction_10m_dominant',
      timezone: 'UTC',
      // Seasonal API uses the same forecast_days timerange parameter; its
      // seasonal endpoint allows up to 217 days (~7 months).
      forecast_days: '217',
      models: 'ecmwf_seamless',
    });

    const res = await fetch(`https://seasonal-api.open-meteo.com/v1/seasonal?${params.toString()}`);
    if (!res.ok) return null;
    const data = await res.json();
    const times: string[] = data?.daily?.time;
    if (!Array.isArray(times) || !times.length) return null;

    // Match by calendar date in UTC, not by millisecond timestamp. Seasonal
    // data are daily aggregates and therefore have no meaningful departure hour.
    const targetMsUtc = Date.UTC(
      arrivalDate.getUTCFullYear(),
      arrivalDate.getUTCMonth(),
      arrivalDate.getUTCDate()
    );
    let idx = -1;
    let bestDayDiff = Infinity;
    times.forEach((t, i) => {
      const dayMs = Date.parse(`${t}T00:00:00Z`);
      if (!Number.isFinite(dayMs)) return;
      const diffDays = Math.abs(dayMs - targetMsUtc) / 86400000;
      if (diffDays < bestDayDiff) { bestDayDiff = diffDays; idx = i; }
    });
    // Seasonal data are daily aggregates; tolerate a one-day timezone boundary
    // difference, but never silently use a distant date.
    if (idx < 0 || bestDayDiff > 1) return null;

    const temperature = data.daily.temperature_2m_mean?.[idx];
    if (!Number.isFinite(temperature)) return null;
    return {
      temperature: Math.round(temperature),
      weatherCode: data.daily.weather_code?.[idx] ?? 0,
      precipitation: Number((data.daily.precipitation_sum?.[idx] ?? 0).toFixed(1)),
      windSpeed: Math.round(data.daily.wind_speed_10m_mean?.[idx] ?? 0),
      windDirection: Math.round(data.daily.wind_direction_10m_dominant?.[idx] ?? 0),
    };
  } catch {
    return null;
  }
}

export interface RouteWeatherSample {
  lat: number;
  lon: number;
  distanceFromStartKm: number;
  etaMinutes: number;
  weather: ForecastWeather;
}

export async function fetchForecastWeatherAlongRoute(
  points: Array<{ lat: number; lon: number; distanceFromStartKm: number }>,
  departureDate: Date,
  avgSpeedKmH: number
): Promise<RouteWeatherSample[]> {
  if (!points.length) return [];
  const count = Math.min(6, Math.max(3, points.length));
  const selected = Array.from({ length: count }, (_, i) => {
    const idx = Math.round((i / Math.max(1, count - 1)) * (points.length - 1));
    return points[idx];
  });

  const speed = Math.max(5, avgSpeedKmH);
  const results = await Promise.all(selected.map(async (point) => {
    const etaMinutes = Math.round((point.distanceFromStartKm / speed) * 60);
    const weather = await fetchForecastWeatherAt(
      point.lat,
      point.lon,
      new Date(departureDate.getTime() + etaMinutes * 60000)
    );
    return weather ? { ...point, etaMinutes, weather } : null;
  }));

  return results.filter((v): v is RouteWeatherSample => v !== null);
}

