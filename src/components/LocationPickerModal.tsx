import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, MapPin, Check, Loader2, LocateFixed } from 'lucide-react';
import { reverseGeocode } from '../services/routeElevation';
import { triggerHaptic } from '../utils/haptics';
import {
  createV3Map,
  makeDotMarkerEl,
  fromLonLat,
  toLonLat,
  type V3MapBundle,
} from '../utils/yandexMaps';

interface PickedPoint {
  lat: number;
  lon: number;
}

interface LocationPickerModalProps {
  isOpen: boolean;
  isDark: boolean;
  title: string;
  initialCenter?: { lat: number; lon: number };
  onClose: () => void;
  onConfirm: (point: { lat: number; lon: number; displayName: string }) => void;
  hapticFeedback?: boolean;
}

const FALLBACK = { lat: 53.9, lon: 27.5667 };

export const LocationPickerModal: React.FC<LocationPickerModalProps> = ({
  isOpen,
  isDark,
  title,
  initialCenter,
  onClose,
  onConfirm,
  hapticFeedback,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const bundleRef = useRef<V3MapBundle | null>(null);
  const markerRef = useRef<any>(null);
  const onPickRef = useRef<(p: PickedPoint) => void>(() => {});

  const [point, setPoint] = useState<PickedPoint | null>(null);
  const [label, setLabel] = useState('');
  const [resolving, setResolving] = useState(false);
  const [locating, setLocating] = useState(false);
  const [mapError, setMapError] = useState(false);

  const center = initialCenter || FALLBACK;

  useEffect(() => {
    if (isOpen) {
      setPoint(null);
      setLabel('');
    }
  }, [isOpen]);

  const handlePick = async (p: PickedPoint) => {
    triggerHaptic('light', hapticFeedback);
    setPoint(p);
    setResolving(true);
    setLabel('');
    try {
      const name = await reverseGeocode(p.lat, p.lon);
      setLabel(name);
    } finally {
      setResolving(false);
    }
  };
  onPickRef.current = handlePick;

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setMapError(false);

    const t = window.setTimeout(() => {
      if (!containerRef.current || cancelled) return;
      createV3Map(containerRef.current, {
        lat: center.lat,
        lon: center.lon,
        zoom: 12,
        isDark,
      })
        .then((bundle) => {
          if (cancelled) {
            bundle.destroy();
            return;
          }
          bundleRef.current = bundle;
          const { ymaps3, map } = bundle;
          const { YMapListener } = ymaps3;
          map.addChild(
            new YMapListener({
              layer: 'any',
              onClick: (_obj: unknown, event: any) => {
                if (!event?.coordinates) return;
                const { lat, lon } = fromLonLat(event.coordinates);
                onPickRef.current({ lat, lon });
              },
            }),
          );
        })
        .catch(() => setMapError(true));
    }, 50);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
      markerRef.current = null;
      bundleRef.current?.destroy();
      bundleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    const bundle = bundleRef.current;
    if (!bundle || !point) return;
    const { ymaps3, map } = bundle;
    const { YMapMarker } = ymaps3;
    const coords = toLonLat(point.lat, point.lon);

    if (markerRef.current) {
      try {
        markerRef.current.update({ coordinates: coords });
      } catch {
        /* ignore */
      }
    } else {
      const el = makeDotMarkerEl('#f43f5e', 18);
      const marker = new YMapMarker({ coordinates: coords }, el);
      map.addChild(marker);
      markerRef.current = marker;
    }
    bundle.setLocation(point.lat, point.lon, Math.max(13, 13));
  }, [point]);

  useEffect(() => {
    bundleRef.current?.setTheme(isDark);
  }, [isDark]);

  const handleLocateMe = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        handlePick({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setLocating(false);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  };

  const handleConfirm = () => {
    if (!point) return;
    triggerHaptic('medium', hapticFeedback);
    onConfirm({
      lat: point.lat,
      lon: point.lon,
      displayName: label || `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`,
    });
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[10000] bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            className={`w-full sm:max-w-lg h-[88vh] sm:h-[80vh] rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col border shadow-2xl ${
              isDark
                ? 'bg-slate-900 border-slate-800 text-white'
                : 'bg-white border-slate-200 text-slate-900'
            }`}
            initial={{ y: 40, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 24, opacity: 0, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className={`flex items-center justify-between px-4 py-3 border-b shrink-0 ${
                isDark ? 'border-slate-800' : 'border-slate-100'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <MapPin className="h-4 w-4 text-cyan-500 shrink-0" />
                <h3 className="text-sm font-bold truncate">{title}</h3>
              </div>
              <button
                type="button"
                onClick={onClose}
                className={`rounded-lg p-1.5 ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="relative flex-1 min-h-0">
              <div ref={containerRef} className="absolute inset-0 bg-slate-900" />
              {mapError && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 text-sm text-rose-300 p-4 text-center">
                  Не удалось загрузить карту. Проверьте API-ключ и HTTP Referer.
                </div>
              )}
              <button
                type="button"
                onClick={handleLocateMe}
                disabled={locating}
                className={`absolute top-3 right-3 z-10 flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-bold shadow-lg ${
                  isDark ? 'bg-slate-900/90 text-cyan-300' : 'bg-white/95 text-cyan-700'
                }`}
              >
                {locating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LocateFixed className="h-3.5 w-3.5" />
                )}
                Где я
              </button>
            </div>

            <div
              className={`shrink-0 border-t px-4 py-3 space-y-2 ${
                isDark ? 'border-slate-800' : 'border-slate-100'
              }`}
            >
              <p className={`text-[12px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Нажмите на карту, чтобы выбрать точку
              </p>
              {(point || resolving) && (
                <p className="text-[13px] font-semibold truncate">
                  {resolving ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Адрес…
                    </span>
                  ) : (
                    label || `${point!.lat.toFixed(5)}, ${point!.lon.toFixed(5)}`
                  )}
                </p>
              )}
              <button
                type="button"
                disabled={!point || resolving}
                onClick={handleConfirm}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-cyan-600 py-3 text-[14px] font-black text-white disabled:opacity-40"
              >
                <Check className="h-4 w-4" />
                Выбрать
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
