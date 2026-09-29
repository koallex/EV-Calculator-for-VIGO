/**
 * Tesla-like dark basemap for Yandex Maps JS API v3 (YMapDefaultSchemeLayer customization).
 * Tags/elements may differ slightly by API build — always apply inside try/catch.
 */
export type VectorCustomizationItem = {
  tags?: { any?: string[]; all?: string[]; none?: string[] };
  elements?: string | string[];
  stylers: Array<Record<string, string | number | boolean>>;
  zoom?: { min?: number; max?: number };
};

/** Primary route blue used by Tesla UI (approx). */
export const TESLA_ROUTE_BLUE = '#3E6AE1';
export const TESLA_ROUTE_TRAVELED = '#3a4a7a';
export const TESLA_ROUTE_GLOW = 'rgba(62, 106, 225, 0.22)';

export const TESLA_DARK_STYLE: VectorCustomizationItem[] = [
  // Land / background
  { tags: { any: ['landscape', 'land'] }, elements: 'geometry', stylers: [{ color: '#14171d' }] },
  // Water
  { tags: { any: ['water', 'waterway'] }, elements: 'geometry', stylers: [{ color: '#0e1116' }] },
  // Parks / vegetation — nearly same as ground
  { tags: { any: ['vegetation', 'park', 'landscape_vegetation'] }, elements: 'geometry', stylers: [{ color: '#171b22' }] },
  // Buildings
  { tags: { any: ['building'] }, elements: 'geometry', stylers: [{ color: '#1b1f27' }] },
  // Roads — light graphite, outline blends into ground
  { tags: { any: ['road', 'road_minor', 'road_limited', 'road_unclassified'] }, elements: 'geometry.fill', stylers: [{ color: '#3a404b' }] },
  { tags: { any: ['road', 'road_minor', 'road_limited', 'road_unclassified'] }, elements: 'geometry.outline', stylers: [{ color: '#14171d' }] },
  { tags: { any: ['road_major', 'road_trunk', 'road_motorway', 'highway'] }, elements: 'geometry.fill', stylers: [{ color: '#4a5160' }] },
  { tags: { any: ['road_major', 'road_trunk', 'road_motorway', 'highway'] }, elements: 'geometry.outline', stylers: [{ color: '#14171d' }] },
  // Labels — muted, readable
  { tags: { any: ['admin', 'road', 'place', 'locality'] }, elements: 'label.text.fill', stylers: [{ color: '#7d8593' }] },
  { tags: { any: ['admin', 'road', 'place', 'locality'] }, elements: 'label.text.outline', stylers: [{ color: '#14171d' }] },
  // Hide POI / transit icon noise
  { tags: { any: ['poi', 'transit', 'entrance'] }, elements: 'label.icon', stylers: [{ visibility: 'off' }] },
  { tags: { any: ['poi'] }, elements: 'label.text.fill', stylers: [{ visibility: 'off' }] },
];

/** Optional light style is left to Yandex default `theme: 'light'`. */
