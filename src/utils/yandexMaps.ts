/**
 * Yandex Maps loader: prefers JS API 3.0, falls back to 2.1 if v3 key/referer fails.
 * v3 coordinates: [longitude, latitude].
 */

declare global {
  interface Window {
    ymaps3?: any;
    ymaps?: any;
  }
}

const YANDEX_MAPS_API_KEY = (import.meta.env.VITE_YANDEX_MAPS_API_KEY as string | undefined)?.trim();

export const YANDEX_MAPS_TERMS_URL = 'https://yandex.ru/legal/maps_api/';

export function getYandexMapsApiKey(): string | undefined {
  return YANDEX_MAPS_API_KEY || undefined;
}

let v3Promise: Promise<any> | null = null;
let v21Promise: Promise<any> | null = null;

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
    s.onerror = () => reject(new Error(`Script error: ${src}`));
    document.head.appendChild(s);
  });
}

/** Load JS API 3.0 */
export function loadYandexMapsV3(): Promise<any> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Нет window'));
  }
  if (v3Promise) return v3Promise;

  v3Promise = (async () => {
    if (!YANDEX_MAPS_API_KEY) {
      throw new Error(
        'Нет API-ключа. Добавьте VITE_YANDEX_MAPS_API_KEY в .env / Vercel и сделайте Redeploy.',
      );
    }
    if (!window.ymaps3) {
      const src = `https://api-maps.yandex.ru/v3/?apikey=${encodeURIComponent(YANDEX_MAPS_API_KEY)}&lang=ru_RU`;
      await injectScript(src);
    }
    if (!window.ymaps3) {
      throw new Error(
        'ymaps3 не загрузился (403 Invalid key?). Проверьте ключ JavaScript API и HTTP Referer: ev-calculator-for-vigo-va6e.vercel.app',
      );
    }
    await window.ymaps3.ready;
    try {
      window.ymaps3.import.registerCdn('https://cdn.jsdelivr.net/npm/{package}', [
        '@yandex/ymaps3-controls@0.0.2',
      ]);
    } catch {
      /* ok */
    }
    return window.ymaps3;
  })().catch((err) => {
    v3Promise = null;
    throw err;
  });

  return v3Promise;
}

/** Load JS API 2.1 (fallback) */
export function loadYandexMaps21(): Promise<any> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Нет window'));
  }
  if (v21Promise) return v21Promise;

  v21Promise = (async () => {
    if (window.ymaps) {
      await new Promise<void>((r) => window.ymaps.ready(() => r()));
      return window.ymaps;
    }
    const keyParam = YANDEX_MAPS_API_KEY
      ? `apikey=${encodeURIComponent(YANDEX_MAPS_API_KEY)}&`
      : '';
    await injectScript(`https://api-maps.yandex.ru/2.1/?${keyParam}lang=ru_RU`);
    if (!window.ymaps) throw new Error('ymaps 2.1 не загрузился');
    await new Promise<void>((r) => window.ymaps.ready(() => r()));
    return window.ymaps;
  })().catch((err) => {
    v21Promise = null;
    throw err;
  });

  return v21Promise;
}

/** Prefer v3, used by createV3Map */
export function loadYandexMaps(): Promise<any> {
  return loadYandexMapsV3();
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
  apiVersion: 3;
  destroy: () => void;
  setTheme: (isDark: boolean) => void;
  setLocation: (lat: number, lon: number, zoom?: number) => void;
};

export type V21MapBundle = {
  ymaps: any;
  map: any;
  apiVersion: 2;
  destroy: () => void;
  setTheme: (isDark: boolean) => void;
  setLocation: (lat: number, lon: number, zoom?: number) => void;
};

export type AnyMapBundle = V3MapBundle | V21MapBundle;

/** Minimal official v3 map init */
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
  const ymaps3 = await loadYandexMapsV3();
  const { YMap, YMapDefaultSchemeLayer, YMapDefaultFeaturesLayer } = ymaps3;

  const lat = opts.lat ?? 53.9;
  const lon = opts.lon ?? 27.5667;
  const zoom = opts.zoom ?? 12;
  const isDark = !!opts.isDark;

  // Minimal options — avoid unsupported props that throw
  const map = new YMap(container, {
    location: {
      center: toLonLat(lat, lon),
      zoom,
    },
  });

  let schemeLayer: any;
  try {
    schemeLayer = new YMapDefaultSchemeLayer(
      isDark ? { theme: 'dark' } : { theme: 'light' },
    );
  } catch {
    schemeLayer = new YMapDefaultSchemeLayer();
  }
  map.addChild(schemeLayer);
  try {
    map.addChild(new YMapDefaultFeaturesLayer());
  } catch {
    /* optional */
  }

  if (opts.showZoom !== false) {
    try {
      const controlsPkg = await ymaps3.import('@yandex/ymaps3-controls@0.0.2');
      const { YMapControls, YMapZoomControl } = controlsPkg;
      map.addChild(
        new YMapControls({ position: 'right' }).addChild(new YMapZoomControl({})),
      );
    } catch {
      /* optional */
    }
  }

  return {
    ymaps3,
    map,
    schemeLayer,
    apiVersion: 3,
    destroy: () => {
      try {
        map.destroy();
      } catch {
        /* ignore */
      }
    },
    setTheme: (dark: boolean) => {
      try {
        schemeLayer.update?.({ theme: dark ? 'dark' : 'light' });
      } catch {
        /* ignore */
      }
    },
    setLocation: (la: number, lo: number, z?: number) => {
      try {
        map.setLocation({
          center: toLonLat(la, lo),
          zoom: z ?? map.zoom ?? zoom,
          duration: 300,
        });
      } catch {
        /* ignore */
      }
    },
  };
}

/** 2.1 map for fallback */
export async function createV21Map(
  container: HTMLElement,
  opts: {
    lat?: number;
    lon?: number;
    zoom?: number;
    isDark?: boolean;
  } = {},
): Promise<V21MapBundle> {
  const ymaps = await loadYandexMaps21();
  const lat = opts.lat ?? 53.9;
  const lon = opts.lon ?? 27.5667;
  const zoom = opts.zoom ?? 12;

  const map = new ymaps.Map(
    container,
    {
      center: [lat, lon],
      zoom,
      controls: ['zoomControl'],
      type: 'yandex#map',
    },
    {
      suppressMapOpenBlock: true,
      yandexMapDisablePoiInteractivity: true,
    },
  );

  const el: HTMLElement | null =
    typeof map.container?.getElement === 'function' ? map.container.getElement() : null;
  if (el && opts.isDark) el.classList.add('vigo-ymaps-dark');

  return {
    ymaps,
    map,
    apiVersion: 2,
    destroy: () => {
      try {
        map.destroy();
      } catch {
        /* ignore */
      }
    },
    setTheme: (dark: boolean) => {
      const node: HTMLElement | null =
        typeof map.container?.getElement === 'function' ? map.container.getElement() : null;
      node?.classList.toggle('vigo-ymaps-dark', !!dark);
    },
    setLocation: (la: number, lo: number, z?: number) => {
      try {
        map.setCenter([la, lo], z ?? map.getZoom(), { duration: 300 });
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Try v3, then 2.1. Surfaces a clear error if both fail.
 */
export async function createBestMap(
  container: HTMLElement,
  opts: {
    lat?: number;
    lon?: number;
    zoom?: number;
    isDark?: boolean;
    showZoom?: boolean;
  } = {},
): Promise<AnyMapBundle> {
  try {
    return await createV3Map(container, opts);
  } catch (e3) {
    console.warn('[maps] v3 failed, trying 2.1', e3);
    try {
      return await createV21Map(container, opts);
    } catch (e21) {
      const msg3 = e3 instanceof Error ? e3.message : String(e3);
      const msg21 = e21 instanceof Error ? e21.message : String(e21);
      throw new Error(`Карта недоступна.\nv3: ${msg3}\n2.1: ${msg21}`);
    }
  }
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

export function applyMapTheme(_a: any, bundle: any, isDark: boolean) {
  bundle?.setTheme?.(isDark);
}

export function bindDarkPanPerformance(_map: any) {
  return () => {};
}


/** @deprecated — use createBestMap */
export async function createOptimizedMap(
  _ymaps: any,
  container: HTMLElement,
  opts: { center?: number[]; zoom?: number; minZoom?: number; maxZoom?: number } = {},
) {
  const center = opts.center || [53.9, 27.5667];
  const bundle = await createBestMap(container, {
    lat: center[0],
    lon: center[1],
    zoom: opts.zoom ?? 12,
  });
  // Return 2.1-like map object when possible
  return (bundle as any).map;
}

/** @deprecated */
export function createStationObjectManager(_ymaps: any) {
  return {
    objects: { options: { set: () => {} }, events: { add: () => {} } },
    clusters: { options: { set: () => {} } },
    add: () => {},
    removeAll: () => {},
  };
}
