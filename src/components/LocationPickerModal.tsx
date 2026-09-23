import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { MapContainer, TileLayer, Marker, useMapEvents } from 'react-leaflet';
import { X, MapPin, Check, Loader2, LocateFixed } from 'lucide-react';
import { Icon } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { reverseGeocode } from '../services/routeElevation';
import { triggerHaptic } from '../utils/haptics';
import { getBaseTileUrl, MAP_TILE_ATTRIBUTION } from '../utils/mapTiles';

// Default Leaflet marker assets don't resolve correctly under Vite's bundling; build an
// explicit icon from the CDN-hosted images (same approach used nowhere else yet in this
// app since RouteMap only used CircleMarker, not a draggable pin marker).
const pinIcon = new Icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

interface PickedPoint { lat: number; lon: number; }

function ClickCatcher({ onPick }: { onPick: (p: PickedPoint) => void }) {
  useMapEvents({
    click(e) {
      onPick({ lat: e.latlng.lat, lon: e.latlng.lng });
    },
  });
  return null;
}

interface LocationPickerModalProps {
  isOpen: boolean;
  isDark: boolean;
  /** Label shown in the modal header, e.g. "Точка А" or "Точка Б" */
  title: string;
  /** Where to center the map when it first opens */
  initialCenter?: { lat: number; lon: number };
  onClose: () => void;
  onConfirm: (point: { lat: number; lon: number; displayName: string }) => void;
  hapticFeedback?: boolean;
}

const FALLBACK_CENTER: [number, number] = [53.9, 27.5667]; // Minsk — sensible default for Belarus routes

export const LocationPickerModal: React.FC<LocationPickerModalProps> = ({
  isOpen,
  isDark,
  title,
  initialCenter,
  onClose,
  onConfirm,
  hapticFeedback,
}) => {
  const [point, setPoint] = useState<PickedPoint | null>(null);
  const [label, setLabel] = useState('');
  const [resolving, setResolving] = useState(false);
  const [locating, setLocating] = useState(false);
  const center: [number, number] = initialCenter ? [initialCenter.lat, initialCenter.lon] : FALLBACK_CENTER;

  // Reset picked point each time the modal is (re)opened for a fresh pick.
  useEffect(() => {
    if (isOpen) { setPoint(null); setLabel(''); }
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

  const handleLocateMe = () => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { handlePick({ lat: pos.coords.latitude, lon: pos.coords.longitude }); setLocating(false); },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  };

  const handleConfirm = () => {
    if (!point) return;
    triggerHaptic('medium', hapticFeedback);
    onConfirm({ lat: point.lat, lon: point.lon, displayName: label || `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}` });
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
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <motion.div
            className={`w-full sm:max-w-lg h-[88vh] sm:h-[80vh] rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col border shadow-2xl ${isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-900'}`}
            initial={{ y: 40, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 24, opacity: 0, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={`flex items-center justify-between px-4 py-3 border-b shrink-0 ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-amber-500" />
                <span className="text-sm font-bold">{title}</span>
              </div>
              <button onClick={onClose} aria-label="Закрыть" className={`p-1.5 rounded-full ${isDark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'}`}>
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="relative flex-1 min-h-0 location-picker-map">
              <MapContainer center={center} zoom={12} zoomControl={false} attributionControl={false} className="w-full h-full">
                <TileLayer url={getBaseTileUrl(isDark)} attribution={MAP_TILE_ATTRIBUTION} />
                <ClickCatcher onPick={handlePick} />
                {point && <Marker position={[point.lat, point.lon]} icon={pinIcon} />}
                {/* Place-name labels above the pin marker, on their own pane, so city names
                    stay legible under/near the marker instead of being covered by it. */}
              </MapContainer>

              <button
                type="button"
                onClick={handleLocateMe}
                aria-label="Моя геопозиция"
                className={`absolute top-3 right-3 z-[500] p-2.5 rounded-full border shadow-lg ${isDark ? 'bg-slate-900/90 border-slate-700 text-white' : 'bg-white/95 border-slate-200 text-slate-700'}`}
              >
                {locating ? <Loader2 className="w-4 h-4 animate-spin" /> : <LocateFixed className="w-4 h-4" />}
              </button>

              {!point && (
                <div className={`absolute left-3 right-3 top-3 z-[500] rounded-xl px-3 py-2 text-[11px] font-semibold text-center backdrop-blur-md ${isDark ? 'bg-slate-900/85 text-slate-300' : 'bg-white/90 text-slate-600'}`}>
                  Нажмите на карту, чтобы выбрать точку
                </div>
              )}
            </div>

            <div className={`shrink-0 p-3 space-y-2.5 border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
              <div className={`rounded-xl px-3 py-2.5 min-h-[2.75rem] flex items-center gap-2 text-sm ${isDark ? 'bg-slate-950 text-slate-200' : 'bg-slate-50 text-slate-700'}`}>
                {resolving ? (
                  <><Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /><span className="text-xs text-slate-500">Определяем адрес…</span></>
                ) : point ? (
                  <span className="truncate">{label || `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`}</span>
                ) : (
                  <span className="text-xs text-slate-500">Точка ещё не выбрана</span>
                )}
              </div>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={!point || resolving}
                className={`w-full rounded-xl py-3 text-sm font-bold flex items-center justify-center gap-2 transition-opacity ${(!point || resolving) ? 'opacity-40 cursor-not-allowed' : ''} ${isDark ? 'bg-amber-500 text-slate-950' : 'bg-slate-900 text-white'}`}
              >
                <Check className="w-4 h-4" /> Подтвердить точку
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
