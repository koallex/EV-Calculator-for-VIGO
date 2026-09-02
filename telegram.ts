// Minimal surface of the Telegram Mini Apps JS SDK we actually use. The full SDK has a much
// larger API — extend this as needed (BackButton, MainButton, HapticFeedback, etc.).
interface TelegramWebApp {
  ready: () => void;
  expand: () => void;
  setHeaderColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  platform: string;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

// Same color as the app's own theme-color/background (index.html, App shell), so the Telegram
// chrome around the Mini App matches instead of showing a mismatched default white/light bar.
const APP_BACKGROUND_COLOR = '#090d16';

/**
 * Initializes the Telegram Mini App SDK if the site is running inside Telegram, and is a no-op
 * everywhere else (regular browser tab, installed PWA). Safe to call unconditionally on startup.
 */
export function initTelegramWebApp(): boolean {
  const webApp = window.Telegram?.WebApp;
  if (!webApp) return false;

  // Tells Telegram the interface is ready — this is what dismisses the loading splash. Doing
  // this as early as possible (before the app renders, not after) avoids an extra blank flash.
  webApp.ready();
  // Expands the Mini App to full height instead of Telegram's default compact bottom sheet.
  webApp.expand();
  // Match Telegram's own chrome (header/background bars) to the app's dark theme so there's no
  // visible seam between Telegram's UI and the app's own background.
  webApp.setHeaderColor(APP_BACKGROUND_COLOR);
  webApp.setBackgroundColor(APP_BACKGROUND_COLOR);

  return true;
}

/** True when running inside the Telegram Mini App WebView. */
export function isTelegramMiniApp(): boolean {
  return Boolean(window.Telegram?.WebApp);
}
