/**
 * Автоматический подсчёт средней скорости маршрута.
 *
 * Вход: профиль дороги маршрута (скорость и длина каждого участка по данным OSRM) и выбранная
 * пользователем максимальная скорость. Выход: средняя скорость (км/ч) — гармоническая, то есть
 * «расстояние / время», как её и понимает остальной расчёт.
 *
 * Идея: чем «открытее» дорога (по скорости OSRM), тем ближе скорость участка к крейсерской
 * (выбранный максимум минус запас CRUISE_OFFSET_KMH, как в профиле «крейсер»); город остаётся на скорости OSRM.
 *   • Город / медленные участки (OSRM < 45 км/ч) — берём скорость OSRM как есть: она уже учитывает
 *     перекрёстки и повороты.
 *   • Региональные дороги (OSRM ≈ 60–75) — частично «открытая дорога»: скорость между OSRM и крейсером.
 *   • Скоростные участки (OSRM ≥ 85) — идём на крейсере (максимум − запас).
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

/** Скорость OSRM, ниже которой участок считается городским/медленным (максимум на нём не влияет). */
export const OPEN_ROAD_FROM_KMH = 45;
/** Скорость OSRM, начиная с которой участок считается полностью «открытой дорогой» (идём на крейсере). */
export const OPEN_ROAD_FULL_KMH = 85;

/**
 * Насколько участок «открытая дорога» (0..1) по его скорости в OSRM:
 * 0 — город/посёлок, 1 — трасса. Региональные дороги (OSRM ≈ 60–75) получают промежуточные значения,
 * то есть выбранный максимум учитывается на них частично.
 */
export function openRoadShare(osrmSpeedKmH: number): number {
  return Math.max(0, Math.min(1, (osrmSpeedKmH - OPEN_ROAD_FROM_KMH) / (OPEN_ROAD_FULL_KMH - OPEN_ROAD_FROM_KMH)));
}

/** Скорость участка: от скорости OSRM (город) до крейсерской (открытая дорога), в зависимости от «открытости». */
export function segmentSpeedKmH(osrmSpeedKmH: number, cruiseKmH: number): number {
  if (cruiseKmH <= osrmSpeedKmH) return cruiseKmH; // максимум ниже скорости дороги — ограничивает он
  return osrmSpeedKmH + (cruiseKmH - osrmSpeedKmH) * openRoadShare(osrmSpeedKmH);
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
      // (съезд, развязка), поэтому всё, что выше 50 км/ч, подтягиваем к 50 пропорционально длине.
      const w = Math.max(0, Math.min(1, (p.roadSegmentLengthKm ?? LENGTH_CONFIDENCE_KM) / LENGTH_CONFIDENCE_KM));
      const clamped = Math.max(10, Math.min(140, raw as number));
      const osrm = clamped > 50 ? 50 + (clamped - 50) * w : clamped;
      segSpeeds.push(segmentSpeedKmH(osrm, cap));
    }
    if (!segSpeeds.length) continue;
    known += d;

    const v = Math.max(10, Math.min(cap, segSpeeds.reduce((a, b) => a + b, 0) / segSpeeds.length));
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
