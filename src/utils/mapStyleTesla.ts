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

// Маршрут — яркий циан: по тону и яркости отличается от воды (тёмно-бирюзовая) и от дорог (серо-голубые).
// Имена констант оставлены прежними, чтобы не трогать RouteMap.
export const TESLA_ROUTE_BLUE = '#3CE0F5';
export const TESLA_ROUTE_TRAVELED = '#3b4a63';
export const TESLA_ROUTE_GLOW = 'rgba(60, 224, 245, 0.26)';
