/**
 * Minimal native helpers. APK only (window.Capacitor).
 * No @capacitor npm imports — Vercel build stays clean.
 * Deliberately conservative for old Android WebViews.
 */

type CapacitorBridge = {
  isNativePlatform?: () => boolean;
  Plugins?: {
    Geolocation?: {
      requestPermissions: () => Promise<{ location?: string; coarseLocation?: string }>;
    };
  };
};

function getCapacitor(): CapacitorBridge | null {
  try {
    if (typeof window === 'undefined') return null;
    const cap = (window as unknown as { Capacitor?: CapacitorBridge }).Capacitor;
    if (!cap?.isNativePlatform?.()) return null;
    return cap;
  } catch {
    return null;
  }
}

export function isNativeApp(): boolean {
  return getCapacitor() != null;
}

export function markNativeDom(): void {
  if (!getCapacitor()) return;
  try {
    document.documentElement.classList.add('native-app');
    document.body.classList.add('native-app');
    // Old WebViews: kill expensive effects that often paint as solid black
    document.documentElement.classList.add('native-app-lite');
  } catch {
    /* ignore */
  }
}

/** Only request location permission — do NOT replace navigator.geolocation (breaks some WebViews). */
export async function requestNativeLocationPermission(): Promise<void> {
  const geo = getCapacitor()?.Plugins?.Geolocation;
  if (!geo) return;
  try {
    await geo.requestPermissions();
  } catch (e) {
    console.warn('[native] location permission', e);
  }
}

export async function initNativeApp(): Promise<void> {
  if (!getCapacitor()) return;
  markNativeDom();
  await requestNativeLocationPermission();
}
