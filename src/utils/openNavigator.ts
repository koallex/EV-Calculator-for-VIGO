/**
 * Открытие маршрута во внешнем навигаторе.
 *
 * Почему не просто `window.location.href = 'yandexnavi://...'`: в браузере на головном устройстве (Android) такой переход
 * либо ничего не делает, либо, если приложение не установлено, заменяет страницу ошибкой ERR_UNKNOWN_URL_SCHEME.
 * Поэтому на Android схема запускается через `intent://…` (без обработчика Chromium просто остаётся на странице),
 * а если за ~2 с мы так и не «ушли» со страницы — сообщаем вызывающему коду, чтобы показать подсказку и запасной вариант.
 *
 * Какой навигатор есть на ГУ, заранее неизвестно, поэтому выбор хранится в настройках («Ещё» → «Навигатор»).
 */
export type NavApp = 'auto' | 'yandexnavi' | 'yandexmaps' | '2gis' | 'geo' | 'web';

export interface LatLon {
  lat: number;
  lon: number;
}

export interface NavTarget {
  from?: LatLon | null;
  to: LatLon;
  vias?: LatLon[];
}

export const NAV_APP_OPTIONS: ReadonlyArray<{ id: NavApp; label: string }> = [
  { id: 'auto', label: 'Авто' },
  { id: 'yandexnavi', label: 'Яндекс Навигатор' },
  { id: 'yandexmaps', label: 'Яндекс Карты' },
  { id: '2gis', label: '2ГИС' },
  { id: 'geo', label: 'Любое приложение' },
  { id: 'web', label: 'Сайт Яндекс Карт' },
];

const KEY = 'vigo_nav_app';

export function getNavApp(): NavApp {
  try {
    const v = localStorage.getItem(KEY) as NavApp | null;
    if (v && NAV_APP_OPTIONS.some((o) => o.id === v)) return v;
  } catch {
    /* ignore */
  }
  return 'auto';
}

export function setNavApp(app: NavApp): void {
  try {
    localStorage.setItem(KEY, app);
  } catch {
    /* ignore */
  }
}

const pt = (p: LatLon) => `${p.lat},${p.lon}`;

/** Ссылка на сайт Яндекс Карт: работает в любом браузере, ничего не требует от устройства. */
export function webUrl(t: NavTarget): string {
  const pts = [...(t.from ? [t.from] : []), ...(t.vias ?? []), t.to].map(pt);
  const rtext = t.from ? pts.join('~') : `~${pts.join('~')}`;
  return `https://yandex.ru/maps/?rtext=${rtext}&rtt=auto`;
}

function nativeUrl(app: Exclude<NavApp, 'auto' | 'web'>, t: NavTarget): string {
  switch (app) {
    case 'yandexnavi': {
      let u = `yandexnavi://build_route_on_map?`;
      if (t.from) u += `lat_from=${t.from.lat}&lon_from=${t.from.lon}&`;
      u += `lat_to=${t.to.lat}&lon_to=${t.to.lon}`;
      (t.vias ?? []).forEach((v, i) => {
        u += `&lat_via_${i}=${v.lat}&lon_via_${i}=${v.lon}`;
      });
      return u;
    }
    case 'yandexmaps': {
      const pts = [...(t.from ? [t.from] : []), ...(t.vias ?? []), t.to].map(pt);
      return `yandexmaps://maps.yandex.ru/?rtext=${t.from ? pts.join('~') : `~${pts.join('~')}`}&rtt=auto`;
    }
    case '2gis':
      // 2ГИС не принимает промежуточные точки по схеме — только старт и финиш.
      return `dgis://2gis.ru/routeSearch/rsType/car/${t.from ? `from/${t.from.lon},${t.from.lat}/` : ''}to/${t.to.lon},${t.to.lat}`;
    case 'geo':
      return `geo:${t.to.lat},${t.to.lon}?q=${t.to.lat},${t.to.lon}`;
  }
}

/** `scheme://rest` → `intent://rest#Intent;scheme=scheme;end` (geo: и прочие схемы без «//» не трогаем). */
function toIntentUrl(native: string): string {
  const m = /^([a-z0-9+.-]+):\/\/(.*)$/i.exec(native);
  if (!m) return native;
  return `intent://${m[2]}#Intent;scheme=${m[1]};end`;
}

/** Открыть ссылку в новой вкладке. Через <a>.click() — в рамках жеста пользователя, без блокировки всплывающих окон. */
export function openWebInNewTab(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export const isAndroidUa = (): boolean => /Android/i.test(navigator.userAgent || '');

export interface NavFailInfo {
  app: NavApp;
  appLabel: string;
  web: string;
}

/**
 * Открывает маршрут. Вызывать только из обработчика клика.
 * `onFail` — если после запуска приложения страница так и осталась на экране (приложения нет / ГУ запретил).
 */
export function openInNavigator(t: NavTarget, onFail?: (info: NavFailInfo) => void): void {
  const android = isAndroidUa();
  let app = getNavApp();
  if (app === 'auto') app = android ? 'yandexnavi' : 'web';

  const web = webUrl(t);
  if (app === 'web') {
    openWebInNewTab(web);
    return;
  }

  const native = nativeUrl(app, t);
  const url = android ? toIntentUrl(native) : native;
  const appLabel = NAV_APP_OPTIONS.find((o) => o.id === app)?.label ?? app;

  let left = false;
  const onVis = () => {
    if (document.visibilityState === 'hidden') left = true;
  };
  const onBlur = () => {
    left = true;
  };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('blur', onBlur);
  window.setTimeout(() => {
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('blur', onBlur);
    if (!left) onFail?.({ app, appLabel, web });
  }, 2200);

  window.location.href = url;
}
