/** Dynamic loader for Leaflet + MarkerCluster (CDN). Used only by ЭЗС map. */

export type LeafletNS = any;

declare global {
  interface Window {
    L?: LeafletNS;
  }
}

let loadPromise: Promise<LeafletNS> | null = null;

function injectCss(href: string, id: string) {
  if (typeof document === 'undefined') return;
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Не удалось загрузить ${src}`));
    document.head.appendChild(s);
  });
}

/**
 * Leaflet 1.9 + MarkerCluster from unpkg.
 * No npm install required.
 */
export function loadLeaflet(): Promise<LeafletNS> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Leaflet недоступен вне браузера'));
  }
  if (window.L?.map && window.L?.markerClusterGroup) {
    return Promise.resolve(window.L);
  }
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    injectCss('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'vigo-leaflet-css');
    injectCss(
      'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css',
      'vigo-leaflet-mc-css',
    );
    injectCss(
      'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css',
      'vigo-leaflet-mc-default-css',
    );

    await injectScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
    if (!window.L) throw new Error('Leaflet не загрузился');

    await injectScript(
      'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js',
    );
    if (!window.L.markerClusterGroup) {
      throw new Error('MarkerCluster не загрузился');
    }

    // Vite/React often breaks default marker icon paths — we use circle markers anyway.
    return window.L;
  })();

  return loadPromise;
}

/** OSM standard — decent detail for BY without API key. */
export function osmTileUrl() {
  return 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
}

/** Carto dark — native dark tiles (no CSS invert flash). */
export function cartoDarkTileUrl() {
  return 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
}

export function cartoLightTileUrl() {
  return 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
}

export const OSM_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
export const CARTO_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>';
