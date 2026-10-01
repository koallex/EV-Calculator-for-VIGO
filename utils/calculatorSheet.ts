/**
 * Чистая логика экрана Калькулятора «карта + карточки»: отступы карты и режимы нижней панели.
 * Здесь нет React и DOM — файл целиком покрывается тестами (tests/calculatorSheet.test.ts).
 */

/** Положения нижней панели результата: свёрнута / наполовину / раскрыта. */
export type SheetMode = 'peek' | 'half' | 'full';

const ORDER: SheetMode[] = ['peek', 'half', 'full'];

/** Ступень вверх (свайп вверх) или вниз (свайп вниз); на краях остаётся на месте. */
export function stepSheetMode(mode: SheetMode, dir: 'up' | 'down'): SheetMode {
  const i = ORDER.indexOf(mode);
  const next = dir === 'up' ? Math.min(ORDER.length - 1, i + 1) : Math.max(0, i - 1);
  return ORDER[next];
}

/** Тап по ручке: свёрнута → наполовину, наполовину → свёрнута, раскрыта → наполовину. */
export function tapSheetMode(mode: SheetMode): SheetMode {
  return mode === 'half' ? 'peek' : 'half';
}

/** Порог смещения (px), с которого жест считается свайпом; меньше — это тап. */
export const SWIPE_THRESHOLD_PX = 36;
export const TAP_SLOP_PX = 8;

/** Итог жеста по ручке. dy < 0 — палец ушёл вверх. */
export function resolveHandleGesture(mode: SheetMode, dy: number): SheetMode {
  if (Math.abs(dy) <= TAP_SLOP_PX) return tapSheetMode(mode);
  if (dy <= -SWIPE_THRESHOLD_PX) return stepSheetMode(mode, 'up');
  if (dy >= SWIPE_THRESHOLD_PX) return stepSheetMode(mode, 'down');
  return mode; // короткое неопределённое смещение — ничего не меняем
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MapInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const ZERO_INSETS: MapInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Сколько места на карте закрыто карточками. Все прямоугольники — в одной системе координат
 * (getBoundingClientRect). `pad` — небольшой запас, чтобы линия маршрута не прилипала к карточке.
 *
 * Портрет: верхняя карточка занимает верх, панель — низ.
 * Ландшафт: обе карточки стоят слева колонкой, поэтому закрыта левая часть карты.
 */
export function computeMapInsets(args: {
  shell: Rect;
  topPanel: Rect | null;
  bottomPanel: Rect | null;
  landscape: boolean;
  pad?: number;
}): MapInsets {
  const { shell, topPanel, bottomPanel, landscape } = args;
  const pad = args.pad ?? 12;
  const w = shell.right - shell.left;
  const h = shell.bottom - shell.top;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(Math.round(v), max));

  if (landscape) {
    const panels = [topPanel, bottomPanel].filter((r): r is Rect => !!r);
    const rightEdge = panels.length ? Math.max(...panels.map((r) => r.right)) - shell.left : 0;
    return {
      top: pad,
      right: pad,
      bottom: pad,
      left: clamp(rightEdge + pad, Math.round(w * 0.6)),
    };
  }

  const top = topPanel ? topPanel.bottom - shell.top + pad : pad;
  const bottom = bottomPanel ? shell.bottom - bottomPanel.top + pad : pad;
  // Свободное окно не должно схлопнуться: оставляем карте минимум 28% высоты.
  const maxTotal = Math.round(h * 0.72);
  let t = clamp(top, maxTotal);
  let b = clamp(bottom, maxTotal);
  if (t + b > maxTotal) {
    const k = maxTotal / (t + b);
    t = Math.floor(t * k);
    b = Math.floor(b * k);
  }
  return { top: t, right: pad, bottom: b, left: pad };
}

/** Ключ для сравнения: перерасчёт вида карты нужен, только если отступы заметно изменились. */
export function insetsKey(i: MapInsets, bucket = 16): string {
  const q = (v: number) => Math.round(v / bucket);
  return `${q(i.top)}|${q(i.right)}|${q(i.bottom)}|${q(i.left)}`;
}

/** Предельная высота панели (px) в каждом положении. `topEdge` — низ верхней карточки в системе оболочки. */
export function sheetMaxHeightPx(mode: SheetMode, shellHeight: number, topEdge: number, bottomGap = 36): number {
  if (mode === 'peek') return Math.round(shellHeight);
  if (mode === 'half') return Math.max(180, Math.round(shellHeight * 0.6));
  return Math.max(220, Math.round(shellHeight - topEdge - bottomGap - 8));
}

/** Подпись точки для свёрнутой верхней карточки. */
export function shortPlaceLabel(text: string, fallback: string): string {
  const t = (text || '').trim();
  if (!t) return fallback;
  // «Брест, Брестская область, Беларусь» → «Брест»
  const first = t.split(',')[0].trim();
  return first || fallback;
}
