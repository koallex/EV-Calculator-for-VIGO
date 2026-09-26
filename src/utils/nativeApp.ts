/**
 * Capacitor / native shell helpers.
 * Runs ONLY inside the Android/iOS WebView (window.Capacitor present).
 * Browser (Vercel) is unchanged — no @capacitor/* imports (Vite would fail the web build).
 */

type CapGeoCoords = {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number | null;
  altitudeAccuracy: number | null;
  heading: number | null;
  speed: number | null;
};

type CapGeoPosition = {
  coords: CapGeoCoords;
  timestamp: number;
};

type CapacitorBridge = {
  isNativePlatform?: () => boolean;
  Plugins?: {
    StatusBar?: {
      setOverlaysWebView: (o: { overlay: boolean }) => Promise<void>;
      setStyle: (o: { style: string }) => Promise<void>;
      setBackgroundColor: (o: { color: string }) => Promise<void>;
    };
    SplashScreen?: {
      hide: () => Promise<void>;
    };
    Geolocation?: {
      requestPermissions: () => Promise<{ location?: string; coarseLocation?: string }>;
      getCurrentPosition: (o?: {
        enableHighAccuracy?: boolean;
        timeout?: number;
        maximumAge?: number;
      }) => Promise<CapGeoPosition>;
      watchPosition: (
        o: { enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number },
        cb: (pos: CapGeoPosition | null, err?: unknown) => void,
      ) => Promise<string>;
      clearWatch: (o: { id: string }) => Promise<void>;
    };
  };
};

function getCapacitor(): CapacitorBridge | null {
  if (typeof window === 'undefined') return null;
  const cap = (window as unknown as { Capacitor?: CapacitorBridge }).Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  return cap;
}

export function isNativeApp(): boolean {
  return getCapacitor() != null;
}

/** Mark <html> so CSS can add Android safe paddings without touching web layout. */
export function markNativeDom(): void {
  if (!getCapacitor()) return;
  document.documentElement.classList.add('native-app');
  document.body.classList.add('native-app');
}

/**
 * Status bar: keep WebView below system chrome.
 * Uses Capacitor global Plugins API (injected by the native shell) — no npm import.
 */
export async function configureNativeChrome(): Promise<void> {
  const cap = getCapacitor();
  if (!cap?.Plugins) return;
  try {
    const StatusBar = cap.Plugins.StatusBar;
    if (StatusBar) {
      await StatusBar.setOverlaysWebView({ overlay: false });
      await StatusBar.setStyle({ style: 'DARK' });
      await StatusBar.setBackgroundColor({ color: '#090d16' });
    }
  } catch (e) {
    console.warn('[native] StatusBar', e);
  }
  try {
    await cap.Plugins.SplashScreen?.hide();
  } catch {
    /* optional */
  }
}

/** Runtime location permission dialog on Android. */
export async function requestNativeLocationPermission(): Promise<boolean> {
  const geo = getCapacitor()?.Plugins?.Geolocation;
  if (!geo) return true;
  try {
    const perm = await geo.requestPermissions();
    const loc = perm.location ?? perm.coarseLocation;
    return loc === 'granted' || loc === 'prompt';
  } catch (e) {
    console.warn('[native] Geolocation permission', e);
    return false;
  }
}

/**
 * Bridge navigator.geolocation → Capacitor Geolocation plugin inside the APK.
 * Web keeps the real browser geolocation API.
 */
export async function installNativeGeolocationBridge(): Promise<void> {
  const geo = getCapacitor()?.Plugins?.Geolocation;
  if (!geo) return;

  const toBrowserPosition = (p: CapGeoPosition): GeolocationPosition =>
    ({
      coords: {
        latitude: p.coords.latitude,
        longitude: p.coords.longitude,
        accuracy: p.coords.accuracy ?? 0,
        altitude: p.coords.altitude,
        altitudeAccuracy: p.coords.altitudeAccuracy,
        heading: p.coords.heading,
        speed: p.coords.speed,
        toJSON() {
          return this;
        },
      },
      timestamp: p.timestamp,
      toJSON() {
        return this;
      },
    }) as GeolocationPosition;

  const watchMap = new Map<number, string>();
  let nextWatchId = 1;

  const bridge = {
    getCurrentPosition(
      success: PositionCallback,
      error?: PositionErrorCallback | null,
      options?: PositionOptions,
    ) {
      void geo
        .getCurrentPosition({
          enableHighAccuracy: options?.enableHighAccuracy ?? true,
          timeout: options?.timeout ?? 15000,
          maximumAge: options?.maximumAge ?? 0,
        })
        .then((p) => success(toBrowserPosition(p)))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          error?.({
            code: 1,
            message,
            PERMISSION_DENIED: 1,
            POSITION_UNAVAILABLE: 2,
            TIMEOUT: 3,
          } as GeolocationPositionError);
        });
    },
    watchPosition(
      success: PositionCallback,
      error?: PositionErrorCallback | null,
      options?: PositionOptions,
    ) {
      const numericId = nextWatchId++;
      void geo
        .watchPosition(
          {
            enableHighAccuracy: options?.enableHighAccuracy ?? true,
            timeout: options?.timeout ?? 15000,
            maximumAge: options?.maximumAge ?? 0,
          },
          (pos, err) => {
            if (err) {
              error?.({
                code: 1,
                message: String(err),
                PERMISSION_DENIED: 1,
                POSITION_UNAVAILABLE: 2,
                TIMEOUT: 3,
              } as GeolocationPositionError);
              return;
            }
            if (pos) success(toBrowserPosition(pos));
          },
        )
        .then((nativeId) => {
          watchMap.set(numericId, nativeId);
        });
      return numericId;
    },
    clearWatch(id: number) {
      const nativeId = watchMap.get(id);
      if (nativeId) {
        void geo.clearWatch({ id: nativeId });
        watchMap.delete(id);
      }
    },
  };

  try {
    Object.defineProperty(navigator, 'geolocation', {
      value: bridge,
      configurable: true,
    });
  } catch (e) {
    console.warn('[native] geolocation bridge', e);
  }
}

/** Call once at app startup (main.tsx). Safe no-op on web. */
export async function initNativeApp(): Promise<void> {
  if (!getCapacitor()) return;
  markNativeDom();
  await configureNativeChrome();
  await requestNativeLocationPermission();
  await installNativeGeolocationBridge();
}
