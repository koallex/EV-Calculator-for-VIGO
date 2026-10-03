/**
 * Кнопки «+» / «−» на карте (для CarPlay и других экранов без мультитача, где щипок невозможен).
 * Логика вынесена из компонента, чтобы её можно было проверить тестом без карты.
 */

export const MAP_ZOOM_MIN = 3;
export const MAP_ZOOM_MAX = 19;
export const MAP_ZOOM_DEFAULT = 12;

/**
 * Следующий уровень масштаба после нажатия кнопки.
 *
 * После жеста щипком zoom дробный (12.37). Чтобы шаг был предсказуемым, кнопки всегда приводят
 * масштаб к целому уровню в сторону нажатия: «+» → 13, «−» → 12 (а не 13.37 / 11.37).
 * Результат ограничен диапазоном карты.
 */
export function nextZoom(current: number, delta: number): number {
  const base = Number.isFinite(current) ? current : MAP_ZOOM_DEFAULT;
  const EPS = 1e-6;
  const target = delta > 0 ? Math.floor(base + EPS) + delta : Math.ceil(base - EPS) + delta;
  return Math.max(MAP_ZOOM_MIN, Math.min(MAP_ZOOM_MAX, target));
}
