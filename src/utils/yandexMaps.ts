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
