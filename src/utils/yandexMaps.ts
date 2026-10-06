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

import { TESLA_DARK_STYLE, LITE_STYLE_EXTRAS } from './mapStyleTesla';

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

/**
 * Force-remove the "Открыть / Показать в Яндекс.Картах" promo block.
 * suppressMapOpenBlock is unreliable across API builds; DOM scrub + MutationObserver is.
 * Keeps the small © attribution when possible.
 */
export function scrubYandexOpenMapsPromo(root: HTMLElement | null | undefined): () => void {
  if (!root || typeof MutationObserver === 'undefined') return () => {};

  const PROMO_RE =
    /открыть\s+в\s+яндекс|показать\s+в\s+яндекс|open\s+in\s+yandex|yandex\.ru\/maps/i;

  const hide = (el: Element) => {
    const html = el as HTMLElement;
    html.style.setProperty('display', 'none', 'important');
    html.style.setProperty('visibility', 'hidden', 'important');
    html.style.setProperty('opacity', '0', 'important');
    html.style.setProperty('pointer-events', 'none', 'important');
    html.setAttribute('aria-hidden', 'true');
    html.setAttribute('data-vigo-promo-hidden', '1');
  };

  const isPromoCandidate = (el: Element): boolean => {
    const cls = (el.className && String(el.className)) || '';
    if (/gotoymaps|goto-ymaps|map-copyrights-promo|copyrights-promo|gototech/i.test(cls)) {
      return true;
    }
    if (el instanceof HTMLAnchorElement) {
      const href = el.getAttribute('href') || '';
      if (/maps\.yandex|yandex\.(ru|com)\/maps/i.test(href)) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        // Keep bare © logo links without CTA text
        if (PROMO_RE.test(text) || text.length === 0 || /яндекс\.?карт/i.test(text)) {
          // Only hide if it looks like the open-in-maps CTA, not the tiny © mark alone
          if (PROMO_RE.test(text) || /открыть|показать|open/i.test(text)) return true;
        }
      }
    }
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > 0 && text.length < 64 && PROMO_RE.test(text)) return true;
    return false;
  };

  const sweep = () => {
    try {
      // Class-based promo nodes
      root
        .querySelectorAll(
          [
            '[class*="gotoymaps"]',
            '[class*="goto-ymaps"]',
            '[class*="map-copyrights-promo"]',
            '[class*="copyrights-promo"]',
            '[class*="gototech"]',
            'a[href*="maps.yandex"]',
            'a[href*="yandex.ru/maps"]',
            'a[href*="yandex.com/maps"]',
          ].join(','),
        )
        .forEach((el) => {
          if (isPromoCandidate(el)) hide(el);
        });

      // Text walk — catches localized CTA even with hashed class names
      root.querySelectorAll('a, button, span, div').forEach((el) => {
        if (el.getAttribute('data-vigo-promo-hidden') === '1') return;
        if (isPromoCandidate(el)) hide(el);
      });
    } catch {
      /* ignore */
    }
  };

  sweep();
  const observer = new MutationObserver(() => sweep());
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  // Promo is often injected a few hundred ms after init
  const t1 = window.setTimeout(sweep, 200);
  const t2 = window.setTimeout(sweep, 800);
  const t3 = window.setTimeout(sweep, 2000);
  const t4 = window.setTimeout(sweep, 5000);

  return () => {
    observer.disconnect();
    window.clearTimeout(t1);
    window.clearTimeout(t2);
    window.clearTimeout(t3);
    window.clearTimeout(t4);
  };
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
    /** Lighter basemap: no buildings, no road/admin labels (HUD "Лёгкая карта"). */
    lite?: boolean;
    /** Enabled gestures. Omit for the API default (which includes two-finger rotate and tilt). */
    behaviors?: string[];
  } = {},
): Promise<V3MapBundle> {
  const ymaps3 = await loadYandexMapsV3();
  const { YMap, YMapDefaultSchemeLayer, YMapDefaultFeaturesLayer } = ymaps3;

  const lat = opts.lat ?? 53.9;
  const lon = opts.lon ?? 27.5667;
  const zoom = opts.zoom ?? 12;
  const isDark = !!opts.isDark;

  // Minimal options — avoid unsupported props that throw
  const baseProps = {
    location: {
      center: toLonLat(lat, lon),
      zoom,
    },
  };
  let map: any;
  if (opts.behaviors && opts.behaviors.length) {
    // Explicit gesture list: the default set lets a two-finger pinch rotate/tilt the camera,
    // which fights the navigation camera (and looked like the map "spinning by itself").
    try {
      map = new YMap(container, { ...baseProps, behaviors: opts.behaviors });
    } catch {
      map = new YMap(container, baseProps);
    }
  } else {
    map = new YMap(container, baseProps);
  }

  let schemeLayer: any;
  try {
    if (isDark) {
      // Tesla-like dark basemap: try customization, fall back to plain dark theme.
      try {
        schemeLayer = new YMapDefaultSchemeLayer({
          theme: 'dark',
          customization: opts.lite ? [...TESLA_DARK_STYLE, ...LITE_STYLE_EXTRAS] : TESLA_DARK_STYLE,
        });
      } catch (styleErr) {
        console.warn('[maps] Tesla customization unsupported, plain dark theme', styleErr);
        schemeLayer = new YMapDefaultSchemeLayer({ theme: 'dark' });
      }
    } else if (opts.lite) {
      try {
        schemeLayer = new YMapDefaultSchemeLayer({ theme: 'light', customization: LITE_STYLE_EXTRAS });
      } catch {
        schemeLayer = new YMapDefaultSchemeLayer({ theme: 'light' });
      }
    } else {
      schemeLayer = new YMapDefaultSchemeLayer({ theme: 'light' });
    }
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

  const stopPromoScrub = scrubYandexOpenMapsPromo(container);

  return {
    ymaps3,
    map,
    schemeLayer,
    apiVersion: 3,
    destroy: () => {
      try {
        stopPromoScrub();
      } catch {
        /* ignore */
      }
      try {
        map.destroy();
      } catch {
        /* ignore */
      }
    },
    setTheme: (dark: boolean) => {
      try {
        if (dark) {
          try {
            schemeLayer.update?.({
              theme: 'dark',
              customization: opts.lite ? [...TESLA_DARK_STYLE, ...LITE_STYLE_EXTRAS] : TESLA_DARK_STYLE,
            });
          } catch {
            schemeLayer.update?.({ theme: 'dark' });
          }
        } else {
          schemeLayer.update?.({ theme: 'light', customization: opts.lite ? LITE_STYLE_EXTRAS : [] });
        }
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
      // Official switch for "Открыть в Яндекс.Картах" (often ignored by later builds).
      suppressMapOpenBlock: true,
      yandexMapDisablePoiInteractivity: true,
    },
  );

  try {
    map.options.set('suppressMapOpenBlock', true);
  } catch {
    /* ignore */
  }

  // Extra safety: remove promo control if API still injects it.
  try {
    const ctrls = (map as any).controls;
    if (ctrls && typeof ctrls.each === 'function') {
      const toRemove: any[] = [];
      ctrls.each((c: any) => {
        const name = String(c?.constructor?.name || c?.options?.get?.('name') || '');
        if (/goto|open|promo|mapOpen/i.test(name)) toRemove.push(c);
      });
      toRemove.forEach((c) => {
        try {
          ctrls.remove(c);
        } catch {
          /* ignore */
        }
      });
    }
  } catch {
    /* ignore */
  }

  const el: HTMLElement | null =
    typeof map.container?.getElement === 'function' ? map.container.getElement() : null;
  if (el && opts.isDark) el.classList.add('vigo-ymaps-dark');

  // DOM scrub — covers hashed class names and late-injected promo nodes.
  const stopPromoScrub = scrubYandexOpenMapsPromo(el || container);

  return {
    ymaps,
    map,
    apiVersion: 2,
    destroy: () => {
      try {
        stopPromoScrub();
      } catch {
        /* ignore */
      }
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
    lite?: boolean;
    /** Enabled gestures. Omit for the API default (which includes two-finger rotate and tilt). */
    behaviors?: string[];
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


/** Unified plan-stop color: calculator + HUD */
export const PLAN_CHARGER_ACCENT = '#22d3ee';

/** Static CSS for charger / cluster markers (no enter animation — avoids flicker on redraw). */
let chargerMarkerCssReady = false;
function ensureChargerMarkerCss() {
  if (chargerMarkerCssReady || typeof document === 'undefined') return;
  chargerMarkerCssReady = true;
  const s = document.createElement('style');
  s.setAttribute('data-vigo-charger-marker', '1');
  s.textContent = `
.vigo-chg-marker {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 3px;
  transform: translate(-50%, -50%);
  cursor: pointer;
  pointer-events: auto;
  user-select: none;
}
.vigo-chg-marker__disc {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  box-sizing: border-box;
  flex-shrink: 0;
}
.vigo-chg-marker__disc svg { display: block; }
.vigo-chg-marker__kw {
  font: 700 9px/1 system-ui, sans-serif;
  padding: 2px 4px;
  border-radius: 4px;
  white-space: nowrap;
  letter-spacing: -0.02em;
}
.vigo-chg-marker--rec .vigo-chg-marker__disc {
  width: 22px;
  height: 22px;
  background: #22d3ee;
  border: 1.5px solid rgba(255,255,255,0.95);
  box-shadow: 0 1px 3px rgba(0,0,0,0.35);
}
.vigo-chg-marker--rec .vigo-chg-marker__kw {
  background: #22d3ee;
  color: #0f172a;
  box-shadow: 0 1px 2px rgba(0,0,0,0.3);
}
/* Glow only on disc — never opacity/scale on root (avoids flicker when markers rebuild) */
@keyframes vigoPlanGlow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(34, 211, 238, 0.55), 0 1px 3px rgba(0,0,0,0.35); }
  50%      { box-shadow: 0 0 0 8px rgba(34, 211, 238, 0), 0 1px 3px rgba(0,0,0,0.35); }
}
.vigo-chg-marker--plan .vigo-chg-marker__disc {
  animation: vigoPlanGlow 2.4s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .vigo-chg-marker--plan .vigo-chg-marker__disc { animation: none; }
}
.vigo-chg-marker--dim .vigo-chg-marker__disc {
  width: 18px;
  height: 18px;
  background: rgba(15, 23, 42, 0.9);
  border: 1px solid rgba(148, 163, 184, 0.55);
}
.vigo-chg-marker--dim .vigo-chg-marker__kw {
  background: rgba(15, 23, 42, 0.88);
  color: #cbd5e1;
  border: 1px solid rgba(148, 163, 184, 0.4);
}
.vigo-chg-cluster {
  transform: translate(-50%, -50%) scale(1);
  cursor: pointer;
  pointer-events: auto;
  user-select: none;
  min-width: 28px;
  height: 28px;
  padding: 0 7px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  font: 800 11px/1 system-ui, sans-serif;
  color: #f8fafc;
  border: 2px solid rgba(255,255,255,0.9);
  box-shadow: 0 2px 6px rgba(0,0,0,0.4);
  /* resting state always fully visible — no opacity:0 (prevents flicker on redraw) */
}
.vigo-chg-cluster--rec {
  background: #d97706;
}
.vigo-chg-cluster--dim {
  background: #475569;
}
/* Scale-only enter; runs at most once per stableKey (see makeClusterMarkerEl). */
@keyframes vigoClusterIn {
  from { transform: translate(-50%, -50%) scale(0.72); }
  to   { transform: translate(-50%, -50%) scale(1); }
}
.vigo-chg-cluster--enter {
  animation: vigoClusterIn 0.2s cubic-bezier(0.22, 1, 0.36, 1) 1 forwards;
}
`;
  document.head.appendChild(s);
}

/** Relative luminance 0–1 for hex #rgb / #rrggbb */
function hexLuminance(hex: string): number {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (full.length < 6) return 0.5;
  const n = parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n)) return 0.5;
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function accentIsLight(hex: string): boolean {
  return hexLuminance(hex) > 0.55;
}

const BOLT_SVG = (fill: string, size: number) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
  `<path fill="${fill}" d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/></svg>`;

/**
 * Bolt + optional power (kW). No CSS enter animation — map often rebuilds markers.
 */
export function makeChargerMarkerEl(opts: {
  powerKw?: number | null;
  recommended?: boolean;
  title?: string;
  index?: number;
  /**
   * Operator (or other) fill for the EVSE map only.
   * Calculator leaves this unset and keeps amber/slate plan styles.
   */
  accentColor?: string | null;
}): HTMLElement {
  ensureChargerMarkerCss();
  const power = opts.powerKw != null && Number.isFinite(opts.powerKw) && opts.powerKw > 0
    ? Math.round(Number(opts.powerKw))
    : null;
  const rec = !!opts.recommended;
  // Plan stops (calc + HUD): same cyan. Explicit accentColor still wins for operator map.
  const rawAccent = opts.accentColor && /^#|[a-z]/i.test(String(opts.accentColor))
    ? String(opts.accentColor)
    : rec
      ? PLAN_CHARGER_ACCENT
      : null;
  const accent = rawAccent;
  const isPlan = rec || (accent != null && accent.toLowerCase() === PLAN_CHARGER_ACCENT.toLowerCase());
  const el = document.createElement('div');
  el.className =
    'vigo-chg-marker ' +
    (isPlan ? 'vigo-chg-marker--rec vigo-chg-marker--plan' : 'vigo-chg-marker--dim');
  el.title = opts.title || (power != null ? `${power} кВт` : '');
  const disc = document.createElement('div');
  disc.className = 'vigo-chg-marker__disc';
  if (accent) {
    const light = accentIsLight(accent);
    const fg = light ? '#0f172a' : '#ffffff';
    disc.style.background = accent;
    disc.style.borderColor = light ? 'rgba(15,23,42,0.25)' : 'rgba(255,255,255,0.9)';
    disc.style.width = isPlan ? '22px' : '20px';
    disc.style.height = isPlan ? '22px' : '20px';
    disc.innerHTML = BOLT_SVG(fg, isPlan ? 11 : 10);
  } else {
    disc.innerHTML = BOLT_SVG('#94a3b8', 9);
  }
  el.appendChild(disc);
  if (power != null) {
    const kw = document.createElement('span');
    kw.className = 'vigo-chg-marker__kw';
    kw.textContent = String(power);
    if (accent) {
      const light = accentIsLight(accent);
      const fg = light ? '#0f172a' : '#ffffff';
      kw.style.background = accent;
      kw.style.color = fg;
      kw.style.border = light ? '1px solid rgba(15,23,42,0.2)' : '1px solid rgba(255,255,255,0.35)';
    }
    el.appendChild(kw);
  }
  return el;
}

/** Keys already enter-animated this page session — skip on marker rebuild. */
const clusterEnterPlayed = new Set<string>();

/** Call when the underlying station set changes (new route / new fetch). */
export function resetClusterEnterAnimations() {
  clusterEnterPlayed.clear();
}

/** Cluster bubble with station count. Scale-in once per stableKey; never starts hidden. */
export function makeClusterMarkerEl(opts: {
  count: number;
  recommended?: boolean;
  title?: string;
  /** Same cell across redraws — prevents replaying enter animation. */
  stableKey?: string;
}): HTMLElement {
  ensureChargerMarkerCss();
  const el = document.createElement('div');
  const key = opts.stableKey || `c:${opts.count}:${opts.recommended ? 1 : 0}`;
  const playEnter = !clusterEnterPlayed.has(key);
  if (playEnter) clusterEnterPlayed.add(key);
  el.className =
    'vigo-chg-cluster ' +
    (opts.recommended ? 'vigo-chg-cluster--rec' : 'vigo-chg-cluster--dim') +
    (playEnter ? ' vigo-chg-cluster--enter' : '');
  el.textContent = String(opts.count);
  el.title = opts.title || `${opts.count} станций`;
  // Drop enter class after animation so a later classList tweak cannot restart it
  if (playEnter) {
    const done = () => {
      el.classList.remove('vigo-chg-cluster--enter');
      el.removeEventListener('animationend', done);
    };
    el.addEventListener('animationend', done);
  }
  return el;
}

export type ClusterablePoint = {
  lat: number;
  lon: number;
  recommended?: boolean;
  [key: string]: unknown;
};

export type ClusterBucket<T extends ClusterablePoint> =
  | { type: 'point'; item: T }
  | {
      type: 'cluster';
      lat: number;
      lon: number;
      count: number;
      recommended: boolean;
      items: T[];
      /** Grid cell id for stable animation keys */
      cellKey: string;
    };

/**
 * Grid cluster by map zoom. Zoom is quantized to 0.5 steps by callers to limit redraw churn.
 */
export function clusterPointsByZoom<T extends ClusterablePoint>(
  points: T[],
  zoom: number,
  opts?: {
    /** Zoom at/above which all points stay individual (default 13.2). */
    individualAboveZoom?: number;
    /** Multiplier on grid cell size (>1 → fewer, larger clusters). */
    cellScale?: number;
  },
): ClusterBucket<T>[] {
  if (!points.length) return [];
  const individualAbove = opts?.individualAboveZoom ?? 13.2;
  const cellScale = opts?.cellScale ?? 1;
  if (zoom >= individualAbove || points.length <= 3) {
    return points.map((item) => ({ type: 'point' as const, item }));
  }
  const cell = Math.max(0.008, (0.55 * cellScale) / Math.pow(2, Math.max(0, zoom - 9)));
  const bins = new Map<string, T[]>();
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const key = `${Math.floor(p.lat / cell)}_${Math.floor(p.lon / cell)}`;
    const arr = bins.get(key);
    if (arr) arr.push(p);
    else bins.set(key, [p]);
  }
  const out: ClusterBucket<T>[] = [];
  for (const [cellKey, group] of bins) {
    if (group.length === 1) {
      out.push({ type: 'point', item: group[0] });
      continue;
    }
    let lat = 0;
    let lon = 0;
    let rec = false;
    for (const g of group) {
      lat += g.lat;
      lon += g.lon;
      if (g.recommended) rec = true;
    }
    out.push({
      type: 'cluster',
      lat: lat / group.length,
      lon: lon / group.length,
      count: group.length,
      recommended: rec,
      items: group,
      cellKey,
    });
  }
  return out;
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


/**
 * Navigation chevron for HUD live position.
 * Default shape points UP (screen north). `headingDeg` is CSS rotation (clockwise).
 */
export function makeNavArrowEl(color = '#f8fafc', headingDeg = 0): HTMLElement {
  // Крупный шеврон (читается с расстояния вытянутой руки на экране авто): светлая стрелка с тёмной обводкой
  // на циановом «ореоле». Поворот — CSS-transform на самом элементе (RouteMap выставляет его напрямую).
  const SIZE = 48;
  const el = document.createElement('div');
  el.setAttribute('data-vigo-nav-arrow', '1');
  const deg = Number.isFinite(headingDeg) ? headingDeg : 0;
  el.innerHTML = `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="24" cy="24" r="21" fill="rgba(60,224,245,0.16)" stroke="rgba(60,224,245,0.55)" stroke-width="1.5"/>
    <path d="M24 5 L37 40 L24 32 L11 40 Z" fill="${color}" stroke="rgba(11,14,20,0.92)" stroke-width="2" stroke-linejoin="round"/>
  </svg>`;
  el.style.cssText = [
    `width:${SIZE}px`,
    `height:${SIZE}px`,
    'transform:translate(-50%,-50%) rotate(' + String(deg) + 'deg)',
    'transform-origin:50% 50%',
    'will-change:transform',
    'pointer-events:none',
    'filter:drop-shadow(0 2px 6px rgba(0,0,0,0.55))',
  ].join(';');
  (el as any).__setHeading = (h: number) => {
    const d = Number.isFinite(h) ? h : 0;
    el.style.transform = `translate(-50%,-50%) rotate(${d}deg)`;
  };
  return el;
}

/** Normalize degrees to [-180, 180]. */
export function normalizeDeg180(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * Geographic heading (0=N, 90=E, clockwise) → Yandex camera azimuth in radians [-π, π].
 * Setting camera.azimuth to this value makes that heading point to the top of the screen (course-up).
 */
export function headingDegToAzimuthRad(headingDeg: number): number {
  const rad = (normalizeDeg180(headingDeg) * Math.PI) / 180;
  return rad;
}
