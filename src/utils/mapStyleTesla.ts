/**
 * Tesla-like dark basemap for Yandex Maps JS API v3 (YMapDefaultSchemeLayer.customization).
 * Tag names vary by API build — always apply inside try/catch with plain dark fallback.
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

export const TESLA_ROUTE_BLUE = '#3E6AE1';
export const TESLA_ROUTE_TRAVELED = '#3a4a7a';
export const TESLA_ROUTE_GLOW = 'rgba(62, 106, 225, 0.28)';

/**
 * Goal: quiet graphite ground, readable roads, almost no label noise,
 * water/parks do not compete with the route blue.
 */
export const TESLA_DARK_STYLE: VectorCustomizationItem[] = [
  // —— Ground ——
  { tags: { any: ['landscape', 'land', 'landcover'] }, elements: 'geometry', stylers: [{ color: '#12151c' }] },
  { tags: { any: ['building'] }, elements: 'geometry', stylers: [{ color: '#1a1e27' }] },

  // —— Water (muted, not electric blue) ——
  { tags: { any: ['water', 'waterway', 'ocean'] }, elements: 'geometry', stylers: [{ color: '#0f1520' }] },
  { tags: { any: ['water'] }, elements: 'label', stylers: [{ visibility: 'off' }] },

  // —— Parks / vegetation (1–2 tones above ground, no bright green/gray blobs) ——
  {
    tags: { any: ['vegetation', 'park', 'landscape_vegetation', 'wood', 'forest'] },
    elements: 'geometry',
    stylers: [{ color: '#161b24' }],
  },

  // —— Roads: clearly lighter than ground ——
  {
    tags: { any: ['road', 'road_unclassified', 'road_limited', 'road_minor', 'road_3', 'road_4', 'road_5', 'road_6', 'road_7'] },
    elements: 'geometry.fill',
    stylers: [{ color: '#3a4152' }],
  },
  {
    tags: { any: ['road', 'road_unclassified', 'road_limited', 'road_minor', 'road_3', 'road_4', 'road_5', 'road_6', 'road_7'] },
    elements: 'geometry.outline',
    stylers: [{ color: '#12151c' }],
  },
  {
    tags: { any: ['road_major', 'road_trunk', 'road_motorway', 'highway', 'road_1', 'road_2'] },
    elements: 'geometry.fill',
    stylers: [{ color: '#4c5568' }],
  },
  {
    tags: { any: ['road_major', 'road_trunk', 'road_motorway', 'highway', 'road_1', 'road_2'] },
    elements: 'geometry.outline',
    stylers: [{ color: '#12151c' }],
  },

  // —— Labels: hide districts, villages, most street names, route shields ——
  { tags: { any: ['district', 'suburb', 'neighbourhood', 'neighborhood'] }, elements: 'label', stylers: [{ visibility: 'off' }] },
  { tags: { any: ['locality', 'village', 'hamlet', 'town'] }, elements: 'label', stylers: [{ visibility: 'off' }] },
  // Keep large admin/city labels only as soft text (if present)
  { tags: { any: ['admin', 'country', 'province', 'region'] }, elements: 'label.text.fill', stylers: [{ color: '#6b7280' }] },
  { tags: { any: ['admin', 'country', 'province', 'region'] }, elements: 'label.text.outline', stylers: [{ color: '#12151c' }] },
  // Hide minor road labels + highway number badges (M-9, H-9034, etc.)
  {
    tags: { any: ['road_3', 'road_4', 'road_5', 'road_6', 'road_7', 'road_minor', 'road_unclassified', 'road_limited'] },
    elements: 'label',
    stylers: [{ visibility: 'off' }],
  },
  {
    tags: { any: ['road', 'road_1', 'road_2', 'highway', 'road_major'] },
    elements: 'label.icon',
    stylers: [{ visibility: 'off' }],
  },
  // Major road names: very muted, optional
  {
    tags: { any: ['road_1', 'road_2', 'road_major', 'road_motorway', 'highway'] },
    elements: 'label.text.fill',
    stylers: [{ color: '#6b7382' }],
  },
  {
    tags: { any: ['road_1', 'road_2', 'road_major', 'road_motorway', 'highway'] },
    elements: 'label.text.outline',
    stylers: [{ color: '#12151c' }],
  },

  // —— POI / transit noise off ——
  { tags: { any: ['poi', 'transit', 'entrance', 'airport'] }, elements: 'label.icon', stylers: [{ visibility: 'off' }] },
  { tags: { any: ['poi', 'transit'] }, elements: 'label', stylers: [{ visibility: 'off' }] },
];
