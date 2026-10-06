import { useEffect, useSyncExternalStore } from 'react';

/**
 * «Режим авто» — верстка под экран мультимедиа (браузер на головном устройстве).
 *
 * На таком экране вьюпорт большой (1200–1900 CSS px), а смотрят на него с расстояния вытянутой руки и тапают на ходу.
 * Поэтому оверлеи (панель HUD, нижняя навигация, кнопки) масштабируются через CSS `zoom` (см. index.css, блок «Car mode»),
 * а сама карта остаётся как есть.
 *
 *  auto — включается сама: ландшафт, ширина ≥ 1100 px, основной указатель — палец (pointer: coarse)
 *  on   — включено всегда (если авто-определение не сработало)
 *  off  — выключено всегда
 */
export type CarModePref = 'auto' | 'on' | 'off';

const STORAGE_KEY = 'vigo_car_mode';
const AUTO_THEME_KEY = 'vigo_car_auto_theme';

interface CarModeSnapshot {
  pref: CarModePref;
  active: boolean;
  /** Коэффициент `zoom` для оверлеев. */
  scale: number;
  /** Днём — светлая тема, ночью — тёмная (работает только пока режим авто активен). По умолчанию включено. */
  autoTheme: boolean;
}

function readPref(): CarModePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'on' || v === 'off' || v === 'auto') return v;
  } catch {
    /* localStorage недоступен — работаем в режиме auto */
  }
  return 'auto';
}

function readAutoTheme(): boolean {
  try {
    return localStorage.getItem(AUTO_THEME_KEY) !== '0';
  } catch {
    return true;
  }
}

function detectAuto(): boolean {
  if (typeof window === 'undefined') return false;
  const landscape = window.innerWidth > window.innerHeight * 1.05;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return landscape && window.innerWidth >= 1100 && coarse;
}

/** 1280 px → ~1.4, 1920 px → 1.6 (потолок). Округляем до 0.05, чтобы не дёргать стили на каждый пиксель ресайза. */
function computeScale(): number {
  if (typeof window === 'undefined') return 1;
  const raw = Math.min(1.6, Math.max(1.25, window.innerWidth / 900));
  return Math.round(raw * 20) / 20;
}

function compute(): CarModeSnapshot {
  const pref = readPref();
  const active = pref === 'on' || (pref === 'auto' && detectAuto());
  return { pref, active, scale: computeScale(), autoTheme: readAutoTheme() };
}

let snapshot: CarModeSnapshot = compute();
const listeners = new Set<() => void>();

function applyToDocument(s: CarModeSnapshot): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.car = s.active ? '1' : '0';
  root.style.setProperty('--car-zoom', String(s.scale));
}

function refresh(): void {
  const next = compute();
  if (
    next.pref === snapshot.pref &&
    next.active === snapshot.active &&
    next.scale === snapshot.scale &&
    next.autoTheme === snapshot.autoTheme
  )
    return;
  snapshot = next;
  applyToDocument(snapshot);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setCarModePref(pref: CarModePref): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* ignore */
  }
  refresh();
}

export function setCarAutoTheme(on: boolean): void {
  try {
    localStorage.setItem(AUTO_THEME_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
  refresh();
}

/** Подписка на режим авто: вызывать один раз в App (вешает слушатели ресайза) и где угодно ещё — только читать. */
export function useCarMode(): CarModeSnapshot {
  useEffect(() => {
    applyToDocument(snapshot);
    const onChange = () => refresh();
    window.addEventListener('resize', onChange, { passive: true });
    window.addEventListener('orientationchange', onChange, { passive: true });
    return () => {
      window.removeEventListener('resize', onChange);
      window.removeEventListener('orientationchange', onChange);
    };
  }, []);
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

// ── Полноэкранный режим ──────────────────────────────────────────────────────

export function isFullscreenSupported(): boolean {
  return typeof document !== 'undefined' && !!document.documentElement.requestFullscreen;
}

export function isFullscreen(): boolean {
  return typeof document !== 'undefined' && !!document.fullscreenElement;
}

export async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
  } catch {
    /* браузер головного устройства может не разрешать — молча игнорируем */
  }
}

/** Реактивное состояние «сейчас во весь экран» (для иконки кнопки). */
export function useFullscreen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      document.addEventListener('fullscreenchange', cb);
      return () => document.removeEventListener('fullscreenchange', cb);
    },
    isFullscreen,
    () => false,
  );
}
