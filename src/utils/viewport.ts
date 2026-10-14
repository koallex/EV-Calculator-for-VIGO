/**
 * Надёжная высота окна для браузеров головных устройств (Яндекс Браузер в ГУ авто и т.п.).
 *
 * Проблемы, которые это решает:
 *  - старые Chromium не знают единиц `dvh` → `h-[100dvh]` выбрасывается, карта схлопывается или вылезает за экран;
 *  - `100vh` на таких браузерах считается БЕЗ панелей браузера → низ интерфейса (нижняя навигация) уходит под край;
 *  - на старте браузер ГУ часто отдаёт неверный innerHeight и корректирует его позже, resize при этом может не прийти.
 *
 * Результат — CSS-переменная `--app-h` (в px) на <html>. В index.css у неё есть fallback (100vh / 100dvh),
 * а здесь она точно подстраивается под реально видимую область. Все «на весь экран» размеры используют var(--app-h).
 */
export function initViewportHeight(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const root = document.documentElement;
  let raf = 0;
  let last = -1;

  const measure = () => {
    raf = 0;
    const h = Math.round(window.innerHeight || root.clientHeight || 0);
    if (h > 0 && h !== last) {
      last = h;
      root.style.setProperty('--app-h', `${h}px`);
    }
  };
  const schedule = () => {
    if (raf) return;
    raf = window.requestAnimationFrame(measure);
  };

  measure();
  // Браузеры ГУ уточняют размер окна уже после загрузки (скрывают/показывают свои панели) — перемеряем.
  const timers = [150, 500, 1200, 3000].map((ms) => window.setTimeout(measure, ms));

  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('orientationchange', schedule, { passive: true });
  window.addEventListener('pageshow', schedule, { passive: true });
  document.addEventListener('fullscreenchange', schedule);
  window.visualViewport?.addEventListener('resize', schedule);

  return () => {
    if (raf) window.cancelAnimationFrame(raf);
    timers.forEach((t) => window.clearTimeout(t));
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    window.removeEventListener('pageshow', schedule);
    document.removeEventListener('fullscreenchange', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
  };
}
