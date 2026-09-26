/**
 * Capacitor / native shell helpers.
 * All effects run ONLY when the app is opened inside the Android/iOS WebView.
 * Browser (Vercel web) is unchanged.
 */

type CapGeoPosition = {
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number;
    altitude: number | null;
    altitudeAccuracy: number | null;
    heading: number | null;
    speed: number | null;
  };
  timestamp: number;
};

function hasCapacitor(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

export function isNativeApp(): boolean {
  return hasCapacitor();
}

/** Mark <html> so CSS can add Android/iOS safe paddings without touching web layout. */
export function markNativeDom(): void {
  if (!hasCapacitor()) return;
  document.documentElement.classList.add('native-app');
  document.body.classList.add('native-app');
}

/**
 * Status bar / navigation: keep WebView below system chrome so header & tab bar
 * are not drawn under Android status/nav bars. No effect in browser.
 */
export async function configureNativeChrome(): Promise<void> {
  if (!hasCapacitor()) return;
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setOverlaysWebView({ overlay: false });
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#090d16' });
  } catch (e) {
    console.warn('[native] StatusBar', e);
  }
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide();
  } catch {
    /* optional */
  }
}

/** Ask for location permission on Android (runtime dialog). */
export async function requestNativeLocationPermission(): Promise<boolean> {
  if (!hasCapacitor()) return true;
  try {
    const { Geolocation } = await import('@capacitor/geolocation');
    const perm = await Geolocation.requestPermissions();
    const loc = perm.location ?? perm.coarseLocation;
    return loc === 'granted' || loc === 'prompt';
  } catch (e) {
    console.warn('[native] Geolocation permission', e);
    return false;
  }
}

/**
 * Replace navigator.geolocation with Capacitor Geolocation inside the APK.
 * Existing call sites (Calculator, Map, HUD) keep using navigator.geolocation —
 * on the web they still use the browser API unchanged.
 */
export async function installNativeGeolocationBridge(): Promise<void> {
  if (!hasCapacitor()) return;
  try {
    const { Geolocation } = await import('@capacitor/geolocation');

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
      getCurrentPosition(success, error, options) {
        void Geolocation.getCurrentPosition({
          enableHighAccuracy: options?.enableHighAccuracy ?? true,
          timeout: options?.timeout ?? 15000,
          maximumAge: options?.maximumAge ?? 0,
        })
          .then((p) => success(toBrowserPosition(p as CapGeoPosition)))
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
      watchPosition(success, error, options) {
        const numericId = nextWatchId++;
        void Geolocation.watchPosition(
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
            if (pos) success(toBrowserPosition(pos as CapGeoPosition));
          },
        ).then((nativeId) => {
          watchMap.set(numericId, nativeId);
        });
        return numericId;
      },
      clearWatch(id: number) {
        const nativeId = watchMap.get(id);
        if (nativeId) {
          void Geolocation.clearWatch({ id: nativeId });
          watchMap.delete(id);
        }
      },
    };

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
  if (!hasCapacitor()) return;
  markNativeDom();
  await configureNativeChrome();
  await requestNativeLocationPermission();
  await installNativeGeolocationBridge();
}
