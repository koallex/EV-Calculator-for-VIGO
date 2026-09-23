// Basemap for RouteMap and LocationPickerModal.
// Standard OpenStreetMap tiles use local OSM names — in Belarus that is typically Russian
// for streets and settlements, which is more readable for this app than CARTO's mixed labels.
export const getBaseTileUrl = (_isDark: boolean) =>
  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

// Labels are already baked into the OSM raster; keep helpers for call sites that still
// import a separate labels URL (they simply reuse the same tiles / no-op second layer).
export const getLabelsTileUrl = (isDark: boolean) => getBaseTileUrl(isDark);

export const MAP_TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors';

export const LABELS_PANE_NAME = 'placeLabelsPane';
export const LABELS_PANE_Z_INDEX = 450;
