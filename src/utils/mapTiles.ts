// Shared CARTO basemap tile URLs, used by both RouteMap.tsx (finished route) and
// LocationPickerModal.tsx (tap-to-pick point). Split into a roads/terrain base layer and a
// separate place-name labels layer so labels can be rendered on their own Leaflet pane, above
// the route polyline/markers — otherwise city names get visually cut by the route line.
//
// Light theme uses CARTO Voyager: unlike plain OSM tiles, it color-codes the road hierarchy
// (motorways/primary/residential get distinct colors+widths), so "road scheme" is actually
// legible at a glance instead of uniform thin grey lines.
export const getBaseTileUrl = (isDark: boolean) =>
  isDark
    ? 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png';

export const getLabelsTileUrl = (isDark: boolean) =>
  isDark
    ? 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png';

export const MAP_TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors &copy; CARTO';

/** Name of the custom Leaflet pane the labels layer renders into, above the default
 *  overlayPane (z-index 400) where Polyline/Marker/CircleMarker live. */
export const LABELS_PANE_NAME = 'placeLabelsPane';
export const LABELS_PANE_Z_INDEX = 450;
