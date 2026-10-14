/**
 * Basemap: стандартная схема Яндекс.Карт (светлая / тёмная — штатная `theme`, без собственной кастомизации цветов).
 * Здесь остались только «Лёгкая карта» (опция HUD) и цвета линии маршрута поверх карты.
 */
export type VectorCustomizationItem = {
  tags?: { any?: string[]; all?: string[]; none?: string[] };
  elements?: string | string[];
  stylers: Array<Record<string, string | number | boolean>>;
  zoom?: { min?: number; max?: number };
};

/**
 * "Lite" extras, appended after the base style: no 3D/flat buildings and no road/admin labels.
 * Fewer vector layers and no label collision work => noticeably lighter on the GPU/CPU while driving.
 * Unsupported tags are ignored by the API; a hard failure is caught by the caller (falls back to the base style).
 */
export const LITE_STYLE_EXTRAS: VectorCustomizationItem[] = [
  { tags: { any: ['building'] }, elements: 'geometry', stylers: [{ visibility: 'off' }] },
  {
    tags: { any: ['road', 'road_1', 'road_2', 'road_major', 'road_motorway', 'highway', 'admin', 'country', 'province', 'region'] },
    elements: 'label',
    stylers: [{ visibility: 'off' }],
  },
];

// Маршрут — ярко-салатовый: хорошо виден на стандартной карте Яндекса и не сливается с водой, дорогами и парками.
// Имена констант оставлены прежними, чтобы не трогать RouteMap.
export const TESLA_ROUTE_BLUE = '#39FF5A';
export const TESLA_ROUTE_TRAVELED = '#3b4a63';
export const TESLA_ROUTE_GLOW = 'rgba(57, 255, 90, 0.30)';
// Светлая тема: чуть темнее салатовый, чтобы линия не терялась на светлой карте.
export const ROUTE_GREEN_LIGHT = '#16D945';
export const ROUTE_GREEN_LIGHT_GLOW = 'rgba(22, 217, 69, 0.22)';
