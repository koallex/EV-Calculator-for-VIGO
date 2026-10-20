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
  let lastLh = -1;

  // «Большая» высота окна (lvh): когда панели браузера (Safari на iPhone) свёрнуты. Нужна, чтобы карта доходила
  // до нижнего края сразу, а не «доезжала» после первого скролла, когда панель Safari прячется.
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:100lvh;visibility:hidden;pointer-events:none;';
  (document.body || root).appendChild(probe);

  const measure = () => {
    raf = 0;
    measureNav();
    measureHud();
    const h = Math.round(window.innerHeight || root.clientHeight || 0);
    if (h > 0 && h !== last) {
      last = h;
      root.style.setProperty('--app-h', `${h}px`);
    }
    const lh = Math.max(h, Math.round(probe.offsetHeight || 0));
    if (lh > 0 && lh !== lastLh) {
      lastLh = lh;
      root.style.setProperty('--app-lh', `${lh}px`);
    }
  };
  // Высота плавающей нижней навигации (вместе с отступом от края) → --nav-clear.
  // Нужна экранам, у которых карта идёт под навигацией (калькулятор): их нижние шторки/диалоги поднимаются над баром.
  let navObserved: Element | null = null;
  let navRo: ResizeObserver | null = null;
  let lastNav = -1;
  const measureNav = () => {
    const wrap = document.getElementById('main-bottom-nav-wrap');
    if (wrap && wrap !== navObserved && typeof ResizeObserver !== 'undefined') {
      navRo?.disconnect();
      navRo = new ResizeObserver(measureNav);
      navRo.observe(wrap);
      const inner = wrap.firstElementChild;
      if (inner) navRo.observe(inner);
      navObserved = wrap;
    }
    const h = wrap ? Math.round(wrap.getBoundingClientRect().height) : 0;
    const clear = Math.max(h, 12);
    if (clear !== lastNav) {
      lastNav = clear;
      root.style.setProperty('--nav-clear', `${clear}px`);
    }
  };
  // Отступ HUD-карты от верха документа → --hud-top (в портрете карта HUD тянется до нижнего края экрана).
  let lastHud = -1;
  const measureHud = () => {
    const el = document.getElementById('hud-tab-container');
    if (!el || !(el.offsetParent || el.getClientRects().length)) return;
    const top = Math.round(el.getBoundingClientRect().top + window.scrollY);
    if (top > 0 && top !== lastHud) {
      lastHud = top;
      root.style.setProperty('--hud-top', `${top}px`);
    }
  };
  const schedule = () => {
    if (raf) return;
    raf = window.requestAnimationFrame(measure);
  };

  measure();
  // Браузеры ГУ уточняют размер окна уже после загрузки (скрывают/показывают свои панели) — перемеряем.
  const timers = [150, 500, 1200, 3000].map((ms) => window.setTimeout(measure, ms));

  // Переключение вкладки меняет data-tab у #app-main — перемеряем отступ HUD-карты.
  let mainMo: MutationObserver | null = null;
  const attachMainObserver = () => {
    const main = document.getElementById('app-main');
    if (!main || typeof MutationObserver === 'undefined') return false;
    mainMo = new MutationObserver(schedule);
    mainMo.observe(main, { attributes: true, attributeFilter: ['data-tab'] });
    return true;
  };
  if (!attachMainObserver()) {
    const retry = window.setInterval(() => {
      if (attachMainObserver()) window.clearInterval(retry);
    }, 400);
    timers.push(retry);
  }

  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('orientationchange', schedule, { passive: true });
  window.addEventListener('pageshow', schedule, { passive: true });
  document.addEventListener('fullscreenchange', schedule);
  window.visualViewport?.addEventListener('resize', schedule);

  return () => {
    if (raf) window.cancelAnimationFrame(raf);
    probe.remove();
    navRo?.disconnect();
    mainMo?.disconnect();
    timers.forEach((t) => { window.clearTimeout(t); window.clearInterval(t); });
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    window.removeEventListener('pageshow', schedule);
    document.removeEventListener('fullscreenchange', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
  };
}
