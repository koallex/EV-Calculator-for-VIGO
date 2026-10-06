/**
 * Восход / закат по упрощённой формуле NOAA (точность ~1–2 мин — для переключения темы более чем достаточно).
 * Расчёт идёт по UTC-дате «сейчас»; для широт и долгот Беларуси (UTC+3) это даёт верный день.
 */
const RAD = Math.PI / 180;

/** Минск: используем, пока нет собственной позиции (авто едет по Беларуси). */
export const DEFAULT_LAT = 53.9;
export const DEFAULT_LON = 27.5667;

export function sunTimes(now: Date, lat = DEFAULT_LAT, lon = DEFAULT_LON): { sunrise: Date; sunset: Date } | null {
  const y = now.getUTCFullYear();
  const startOfYear = Date.UTC(y, 0, 0);
  const startOfDay = Date.UTC(y, now.getUTCMonth(), now.getUTCDate());
  const dayOfYear = Math.round((startOfDay - startOfYear) / 86_400_000);

  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1);
  const eqTime =
    229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);

  const cosHa = Math.cos(90.833 * RAD) / (Math.cos(lat * RAD) * Math.cos(decl)) - Math.tan(lat * RAD) * Math.tan(decl);
  if (cosHa > 1 || cosHa < -1) return null; // полярный день / ночь
  const haDeg = Math.acos(cosHa) / RAD;

  const sunriseMin = 720 - 4 * (lon + haDeg) - eqTime;
  const sunsetMin = 720 - 4 * (lon - haDeg) - eqTime;
  return {
    sunrise: new Date(startOfDay + sunriseMin * 60_000),
    sunset: new Date(startOfDay + sunsetMin * 60_000),
  };
}

/**
 * «Светло» = между восходом и закатом с запасом `marginMin` с обеих сторон: в сумерки экран остаётся тёмным,
 * чтобы не слепить, и не мигает туда-сюда у границы.
 */
export function isDaylight(now: Date, lat = DEFAULT_LAT, lon = DEFAULT_LON, marginMin = 20): boolean {
  const t = sunTimes(now, lat, lon);
  if (!t) {
    // полярные условия: считаем по месяцу (северное полушарие)
    const m = now.getUTCMonth();
    return lat >= 0 ? m >= 3 && m <= 8 : !(m >= 3 && m <= 8);
  }
  const ms = now.getTime();
  return ms >= t.sunrise.getTime() + marginMin * 60_000 && ms <= t.sunset.getTime() - marginMin * 60_000;
}
