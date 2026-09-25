// Shared loader for Yandex Maps JS API 2.1. Both RouteMap and LocationPickerModal need the
// same `ymaps` global, so the script is injected once and every caller awaits the same
// promise. Map "hits" (just showing the map) are free and unlimited on the free tier — see
// project notes — so no request budgeting is needed here, just a single script load.

declare global {
  interface Window {
    ymaps: any;
  }
}

const YANDEX_MAPS_API_KEY = import.meta.env.VITE_YANDEX_MAPS_API_KEY as string | undefined;

// Link required by the free-tier terms to be reachable from the app (see condition 6,
// https://yandex.ru/dev/commercial/doc/ru/).
export const YANDEX_MAPS_TERMS_URL = 'https://yandex.ru/legal/maps_api/';

let loadPromise: Promise<any> | null = null;

export function loadYandexMaps(): Promise<any> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Яндекс Карты недоступны вне браузера.'));
  }
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    if (window.ymaps) {
      window.ymaps.ready(() => resolve(window.ymaps));
      return;
    }
    const script = document.createElement('script');
    const keyParam = YANDEX_MAPS_API_KEY ? `apikey=${encodeURIComponent(YANDEX_MAPS_API_KEY)}&` : '';
    // Default package (no traffic/panorama extras). Avoid package.full — heavier download.
    script.src = `https://api-maps.yandex.ru/2.1/?${keyParam}lang=ru_RU`;
    script.async = true;
    script.onload = () => {
      if (!window.ymaps) {
        reject(new Error('Яндекс Карты не загрузились.'));
        return;
      }
      window.ymaps.ready(() => resolve(window.ymaps));
    };
    script.onerror = () => reject(new Error('Не удалось загрузить скрипт Яндекс Карт.'));
    document.head.appendChild(script);
  });

  return loadPromise;
}

export type OptimizedMapOptions = {
  center?: number[];
  zoom?: number;
  /** Keep zoom control (default true). */
  zoomControl?: boolean;
  minZoom?: number;
  maxZoom?: number;
};

/**
 * Map options that strip interactive POI, balloons, and other heavy chrome.
 * API 2.1 does not expose a true "disable 3D buildings" flag (that is v3/vector);
 * the closest wins are: scheme map only, no POI hits, no traffic, fewer controls.
 */
export const LIGHT_MAP_OPTIONS = {
  // Don't open org cards / "open in maps" overlays on basemap clicks
  suppressMapOpenBlock: true,
  yandexMapDisablePoiInteractivity: true,
  // Avoid auto-switching to satellite at high zoom (heavier tiles)
  yandexMapAutoSwitch: false,
  // Smoother continuous pan (less work between frames)
  autoFitToViewport: false as const,
  // Slightly cheaper hit-testing
  exitFullscreenByEsc: false,
};

/**
 * Create a lean Map instance for mobile EV UI.
 */
export function createOptimizedMap(
  ymaps: any,
  container: HTMLElement,
  opts: OptimizedMapOptions = {},
): any {
  const controls = opts.zoomControl === false ? [] : ['zoomControl'];
  const map = new ymaps.Map(
    container,
    {
      center: opts.center || [53.9, 27.5667],
      zoom: opts.zoom ?? 12,
      controls,
      type: 'yandex#map',
    },
    {
      ...LIGHT_MAP_OPTIONS,
      minZoom: opts.minZoom ?? 6,
      maxZoom: opts.maxZoom ?? 17,
    },
  );

  // Strip leftover default controls if the API injected any
  try {
    ['searchControl', 'trafficControl', 'typeSelector', 'fullscreenControl', 'rulerControl', 'geolocationControl', 'routeButtonControl', 'routePanelControl'].forEach(
      (name) => {
        try {
          map.controls.remove(name);
        } catch {
          /* not present */
        }
      },
    );
  } catch {
    /* ignore */
  }

  // Behaviors: keep drag / pinch / scrollZoom; drop rarer costly ones
  try {
    map.behaviors.disable(['rightMouseButtonMagnifier', 'routeEditor', 'ruler']);
  } catch {
    /* ignore */
  }

  // Prefer no animation on setBounds/setCenter from our code (callers can pass duration: 0)
  try {
    map.options.set({
      maxAnimationZoomDifference: 0,
    });
  } catch {
    /* ignore */
  }

  return map;
}

/** Lean ObjectManager defaults for station pins. */
export function createStationObjectManager(ymaps: any) {
  const om = new ymaps.ObjectManager({
    clusterize: true,
    // Larger grid → fewer cluster nodes while panning
    gridSize: 128,
    clusterDisableClickZoom: false,
    geoObjectOpenBalloonOnClick: false,
    clusterOpenBalloonOnClick: false,
    // Don't show balloon on hover
    geoObjectHideIconOnBalloonOpen: false,
  });
  om.objects.options.set({
    preset: 'islands#circleDotIcon',
    iconColor: '#22d3ee',
    hasBalloon: false,
    hasHint: true,
    // Interactivity only click — less hit testing
    cursor: 'pointer',
  });
  om.clusters.options.set({
    preset: 'islands#invertedCyanClusterIcons',
    hasBalloon: false,
    hasHint: false,
  });
  return om;
}

/**
 * Dark map: standard tiles + CSS invert class.
 * Invert is GPU-heavy while dragging — pause it during actionbegin/actionend.
 */
export function applyMapTheme(_ymaps: any, map: any, isDark: boolean) {
  if (!map) return;
  try {
    map.setType('yandex#map');
  } catch {
    /* ignore */
  }
  const el: HTMLElement | null =
    typeof map.container?.getElement === 'function' ? map.container.getElement() : null;
  if (!el) return;
  el.classList.toggle('vigo-ymaps-dark', !!isDark);
  el.classList.remove('vigo-ymaps-dark-panning');
}

/**
 * While the user pans/zooms, disable the expensive CSS invert filter.
 * Re-enable when the gesture ends. Call once after map create if isDark.
 */
export function bindDarkPanPerformance(map: any) {
  if (!map) return () => {};
  const el: HTMLElement | null =
    typeof map.container?.getElement === 'function' ? map.container.getElement() : null;
  if (!el) return () => {};

  const onBegin = () => {
    if (el.classList.contains('vigo-ymaps-dark')) {
      el.classList.add('vigo-ymaps-dark-panning');
    }
  };
  const onEnd = () => {
    el.classList.remove('vigo-ymaps-dark-panning');
  };

  map.events.add('actionbegin', onBegin);
  map.events.add('actionend', onEnd);
  return () => {
    try {
      map.events.remove('actionbegin', onBegin);
      map.events.remove('actionend', onEnd);
    } catch {
      /* ignore */
    }
  };
}
