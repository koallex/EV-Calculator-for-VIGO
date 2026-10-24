/**
 * Автоматический подсчёт средней скорости маршрута.
 *
 * Вход: профиль дороги маршрута (скорость и длина каждого участка по данным OSRM) и выбранная
 * пользователем максимальная скорость. Выход: средняя скорость (км/ч) — гармоническая, то есть
 * «расстояние / время», как её и понимает остальной расчёт.
 *
 * Идея: на каждом участке водитель едет на «свободной» скорости, которую допускает класс дороги,
 * но не быстрее выбранного максимума (с тем же запасом CRUISE_OFFSET_KMH, что и в профиле «крейсер»).
 *   • Город / медленные участки (OSRM < 45 км/ч) — берём скорость OSRM как есть: она уже учитывает
 *     перекрёстки и повороты.
 *   • Региональные дороги (OSRM ≈ 60–75) — свободная скорость ≈ 90–100 км/ч.
 *   • Скоростные участки (OSRM ≥ 85) — свободная скорость растёт до 120+ км/ч.
 *   • Короткие шаги OSRM (< 0.75 км) — это развязки и съезды, а не открытая дорога: им доверяем
 *     меньше и оставляем скорость OSRM (та же логика «уверенности по длине», что и в движке прогноза).
 * Чем больше на маршруте скоростных участков и чем выше выбранный максимум, тем выше средняя.
 *
 * Модуль чистый: без React, без запросов, без побочных эффектов — легко тестируется.
 */

export interface AutoSpeedPoint {
  distanceFromStartKm: number;
  roadSpeedKmH?: number;
  roadSegmentLengthKm?: number;
}

/** Тот же запас под максимум, что и в профиле «крейсер» (storage.ts → CRUISE_OFFSET_KMH). */
export const AUTO_SPEED_CRUISE_OFFSET_KMH = 5;
/** Короткие шаги OSRM короче этого значения считаются «шумом» (развязки, съезды). */
const LENGTH_CONFIDENCE_KM = 0.75;
/** Границы допустимого результата — совпадают с полем ручного ввода средней скорости. */
export const AUTO_SPEED_MIN_KMH = 20;
export const AUTO_SPEED_MAX_KMH = 140;

/** Свободная скорость участка по его скорости в OSRM (км/ч), без учёта выбранного максимума. */
export function freeFlowSpeedKmH(osrmSpeedKmH: number): number {
  const v = osrmSpeedKmH;
  if (v < 45) return v;                                   // город, дворы, повороты — как даёт OSRM
  if (v < 60) return v + ((v - 45) / 15) * (90 - v);      // переход «посёлок → открытая дорога»
  return Math.min(125, 90 + (v - 60) * 0.6);              // открытая дорога и скоростные участки
}

export interface AutoAvgSpeedResult {
  /** Средняя скорость, км/ч, округлённая до целого. */
  avgSpeedKmH: number;
  /** Доля пути, которую модель считает «скоростной» (свободная скорость ≥ 85 км/ч), 0..1. */
  fastShare: number;
}

/**
 * Возвращает null, если по маршруту нет данных о скоростях участков (тогда вызывающий код
 * оставляет значение, введённое вручную / по умолчанию).
 */
export function estimateAutoAvgSpeed(
  points: AutoSpeedPoint[] | undefined | null,
  maxSpeedKmH: number,
): AutoAvgSpeedResult | null {
  if (!points || points.length < 2 || !Number.isFinite(maxSpeedKmH)) return null;

  const cap = Math.max(AUTO_SPEED_MIN_KMH, Math.min(150, maxSpeedKmH) - AUTO_SPEED_CRUISE_OFFSET_KMH);

  let dSum = 0;
  let tSum = 0;
  let fastD = 0;
  let known = 0;

  for (let i = 1; i < points.length; i++) {
    const d = Math.max(0, points[i].distanceFromStartKm - points[i - 1].distanceFromStartKm);
    if (d <= 0.001) continue;

    // Как и в движке прогноза, скорость сегмента — среднее скоростей двух его концов.
    const segSpeeds: number[] = [];
    for (const p of [points[i - 1], points[i]]) {
      const raw = p.roadSpeedKmH;
      if (!Number.isFinite(raw) || (raw as number) <= 0) continue;
      // Доверие к скорости шага по его длине: у короткого шага «быстрая» скорость OSRM — шум
      // (съезд, развязка), поэтому всё, что выше 50 км/ч, подтягиваем к 50 пропорционально длине,
      // и только заслуживающую доверия часть разгоняем до свободной скорости дороги.
      const w = Math.max(0, Math.min(1, (p.roadSegmentLengthKm ?? LENGTH_CONFIDENCE_KM) / LENGTH_CONFIDENCE_KM));
      const clamped = Math.max(10, Math.min(140, raw as number));
      const osrm = clamped > 50 ? 50 + (clamped - 50) * w : clamped;
      const free = freeFlowSpeedKmH(osrm);
      segSpeeds.push(osrm + (free - osrm) * w);
    }
    if (!segSpeeds.length) continue;
    known += d;

    const free = segSpeeds.reduce((a, b) => a + b, 0) / segSpeeds.length;
    const v = Math.max(10, Math.min(cap, free));
    dSum += d;
    tSum += d / v;
    if (v >= 85) fastD += d;
  }

  if (dSum <= 0 || tSum <= 0) return null;
  // Если скорости известны лишь для малой части маршрута, оценке доверять нельзя.
  const total = points[points.length - 1].distanceFromStartKm - points[0].distanceFromStartKm;
  if (total > 0 && known / total < 0.5) return null;

  const avg = dSum / tSum;
  return {
    avgSpeedKmH: Math.round(Math.max(AUTO_SPEED_MIN_KMH, Math.min(AUTO_SPEED_MAX_KMH, avg))),
    fastShare: fastD / dSum,
  };
}
