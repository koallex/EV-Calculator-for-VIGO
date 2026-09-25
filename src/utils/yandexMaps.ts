/**
 * Yandex Maps JavaScript API 3.0 loader and helpers.
 * Coord order in v3 is always [longitude, latitude] (GeoJSON-style).
 */

declare global {
  interface Window {
    ymaps3: any;
  }
}

const YANDEX_MAPS_API_KEY = import.meta.env.VITE_YANDEX_MAPS_API_KEY as string | undefined;

export const YANDEX_MAPS_TERMS_URL = 'https://yandex.ru/legal/maps_api/';

let loadPromise: Promise<any> | null = null;

export function loadYandexMaps(): Promise<any> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Яндекс Карты недоступны вне браузера.'));
  }
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    if (!window.ymaps3) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        const keyParam = YANDEX_MAPS_API_KEY
          ? `apikey=${encodeURIComponent(YANDEX_MAPS_API_KEY)}&`
          : '';
        script.src = `https://api-maps.yandex.ru/v3/?${keyParam}lang=ru_RU`;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Не удалось загрузить Яндекс Карты v3.'));
        document.head.appendChild(script);
      });
    }
    if (!window.ymaps3) throw new Error('ymaps3 не загрузился.');
    await window.ymaps3.ready;

    try {
      window.ymaps3.import.registerCdn('https://cdn.jsdelivr.net/npm/{package}', [
        '@yandex/ymaps3-controls@0.0.2',
        '@yandex/ymaps3-clusterer@0.0.12',
      ]);
    } catch {
      /* already registered */
    }

    return window.ymaps3;
  })();

  return loadPromise;
}

export function toLonLat(lat: number, lon: number): [number, number] {
  return [lon, lat];
}

export function fromLonLat(coords: number[]): { lat: number; lon: number } {
  return { lon: coords[0], lat: coords[1] };
}

export type V3MapBundle = {
  ymaps3: any;
  map: any;
  schemeLayer: any;
  destroy: () => void;
  setTheme: (isDark: boolean) => void;
  setLocation: (lat: number, lon: number, zoom?: number) => void;
};

export async function createV3Map(
  container: HTMLElement,
  opts: {
    lat?: number;
    lon?: number;
    zoom?: number;
    isDark?: boolean;
    showZoom?: boolean;
  } = {},
): Promise<V3MapBundle> {
  const ymaps3 = await loadYandexMaps();
  const {
    YMap,
    YMapDefaultSchemeLayer,
    YMapDefaultFeaturesLayer,
  } = ymaps3;

  const lat = opts.lat ?? 53.9;
  const lon = opts.lon ?? 27.5667;
  const zoom = opts.zoom ?? 12;
  const isDark = !!opts.isDark;

  const map = new YMap(container, {
    location: {
      center: toLonLat(lat, lon),
      zoom,
    },
    theme: isDark ? 'dark' : 'light',
  });

  const schemeLayer = new YMapDefaultSchemeLayer({
    theme: isDark ? 'dark' : 'light',
  });
  map.addChild(schemeLayer);
  map.addChild(new YMapDefaultFeaturesLayer());

  if (opts.showZoom !== false) {
    try {
      const controlsPkg = await ymaps3.import('@yandex/ymaps3-controls@0.0.2');
      const { YMapControls, YMapZoomControl } = controlsPkg;
      map.addChild(
        new YMapControls({ position: 'right' }).addChild(new YMapZoomControl({})),
      );
    } catch {
      /* zoom optional */
    }
  }

  return {
    ymaps3,
    map,
    schemeLayer,
    destroy: () => {
      try {
        map.destroy();
      } catch {
        /* ignore */
      }
    },
    setTheme: (dark: boolean) => {
      try {
        map.setTheme?.(dark ? 'dark' : 'light');
      } catch {
        /* ignore */
      }
      try {
        schemeLayer.update?.({ theme: dark ? 'dark' : 'light' });
      } catch {
        /* ignore */
      }
    },
    setLocation: (la: number, lo: number, z?: number) => {
      map.setLocation({
        center: toLonLat(la, lo),
        zoom: z ?? map.zoom,
        duration: 300,
      });
    },
  };
}

export function makeDotMarkerEl(
  color: string,
  size = 16,
  border = '#0f172a',
): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = [
    `width:${size}px`,
    `height:${size}px`,
    `background:${color}`,
    `border:2px solid ${border}`,
    'border-radius:50%',
    'box-shadow:0 1px 4px rgba(0,0,0,.45)',
    'transform:translate(-50%,-50%)',
    'cursor:pointer',
  ].join(';');
  return el;
}

export function makeLabelMarkerEl(text: string, color: string): HTMLElement {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = [
    'min-width:22px',
    'height:22px',
    'padding:0 6px',
    `background:${color}`,
    'color:#0f172a',
    'border-radius:999px',
    'font:800 11px/22px system-ui,sans-serif',
    'text-align:center',
    'box-shadow:0 1px 4px rgba(0,0,0,.4)',
    'transform:translate(-50%,-50%)',
    'cursor:pointer',
  ].join(';');
  return el;
}

export function applyMapTheme(_ymaps: any, mapOrBundle: any, isDark: boolean) {
  if (mapOrBundle?.setTheme) mapOrBundle.setTheme(isDark);
}

export function bindDarkPanPerformance(_map: any) {
  return () => {};
}
