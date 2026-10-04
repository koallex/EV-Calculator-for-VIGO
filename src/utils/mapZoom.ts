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

/**
 * Один шаг масштаба на живой карте (общий для калькулятора, HUD, ЭЗС и выбора точки).
 * Работает с обеими версиями Яндекс.Карт: v3 (map.zoom + setLocation) и 2.1 (getZoom + setZoom).
 * Возвращает новый уровень или null, если карта ещё не готова / уничтожена.
 * Центр карты не меняется.
 */
export function zoomMapBundle(bundle: any, delta: number, fallbackZoom: number = MAP_ZOOM_DEFAULT): number | null {
  if (!bundle || !bundle.map) return null;
  const map = bundle.map;
  try {
    if (bundle.apiVersion === 3) {
      const cur = typeof map.zoom === 'number' ? map.zoom : fallbackZoom;
      const z = nextZoom(cur, delta);
      const c = map.center ?? map.location?.center;
      if (Array.isArray(c) && c.length >= 2) map.setLocation({ center: c, zoom: z, duration: 250 });
      else map.setLocation({ zoom: z, duration: 250 });
      return z;
    }
    const cur = typeof map.getZoom === 'function' ? map.getZoom() : fallbackZoom;
    const z = nextZoom(cur, delta);
    map.setZoom(z, { duration: 250, checkZoomRange: true });
    return z;
  } catch {
    return null; // карта могла быть уничтожена — молча игнорируем
  }
}
