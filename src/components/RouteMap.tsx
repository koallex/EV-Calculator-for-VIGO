import React, { useEffect } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, Popup, Pane, useMap } from 'react-leaflet';
import { latLngBounds, DivIcon } from 'leaflet';
import type { RoutePoint } from '../services/routeElevation';
import { getBaseTileUrl, getLabelsTileUrl, MAP_TILE_ATTRIBUTION, LABELS_PANE_NAME, LABELS_PANE_Z_INDEX } from '../utils/mapTiles';
import 'leaflet/dist/leaflet.css';

function FitRoute({ positions, extra }: { positions: [number, number][]; extra?: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (positions.length < 2) return;
    const bounds = latLngBounds(extra ? [...positions, extra] : positions);
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: 14, animate: false });
  }, [map, positions, extra]);
  return null;
}

// A small amber plug badge, built as a DivIcon (plain HTML/CSS, no extra image asset) so it's
// visually distinct at a glance from the green/red start-end dots and from any Leaflet default
// marker pin used elsewhere (e.g. LocationPickerModal's tap-to-pick pin).
const chargingStopIcon = new DivIcon({
  className: '',
  html: '<div class="route-map-charge-pin">⚡</div>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

export interface RouteMapChargingStop { lat: number; lon: number; name: string; address?: string; }

interface RouteMapProps { points: RoutePoint[]; isDark: boolean; chargingStop?: RouteMapChargingStop | null; }

export const RouteMap: React.FC<RouteMapProps> = ({ points, isDark, chargingStop }) => {
  const positions = points.map((p) => [p.lat, p.lon] as [number, number]);
  if (positions.length < 2) return null;
  const start = positions[0];
  const end = positions[positions.length - 1];
  const stopPos: [number, number] | null = chargingStop ? [chargingStop.lat, chargingStop.lon] : null;

  return (
    <div className={`overflow-hidden rounded-2xl border ${isDark ? 'border-slate-800 bg-slate-950' : 'border-slate-200 bg-slate-50'}`}>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-bold">Маршрут</span>
        <span className="text-[10px] text-slate-500">Панорамирование и масштабирование</span>
      </div>
      <div className="route-map">
        <MapContainer center={start} zoom={12} scrollWheelZoom={false} zoomControl={false} attributionControl={false}>
          {/* Roads/terrain base, below the route line and markers. */}
          <TileLayer url={getBaseTileUrl(isDark)} attribution={MAP_TILE_ATTRIBUTION} />
          <FitRoute positions={positions} extra={stopPos} />
          <Polyline positions={positions} pathOptions={{ color: '#10b981', weight: 5, opacity: 0.9 }} />
          <CircleMarker center={start} radius={7} pathOptions={{ color: '#ffffff', weight: 3, fillColor: '#10b981', fillOpacity: 1 }} />
          <CircleMarker center={end} radius={7} pathOptions={{ color: '#ffffff', weight: 3, fillColor: '#ef4444', fillOpacity: 1 }} />
          {stopPos && (
            <Marker position={stopPos} icon={chargingStopIcon}>
              <Popup>
                <span className="text-xs font-semibold">{chargingStop!.name}</span>
                {chargingStop!.address ? <><br /><span className="text-xs">{chargingStop!.address}</span></> : null}
              </Popup>
            </Marker>
          )}
          {/* Place-name labels on their own pane, above the route line so city names stay
              readable even where the route passes directly under them. */}
          <Pane name={LABELS_PANE_NAME} style={{ zIndex: LABELS_PANE_Z_INDEX, pointerEvents: 'none' }}>
            <TileLayer url={getLabelsTileUrl(isDark)} pane={LABELS_PANE_NAME} />
          </Pane>
        </MapContainer>
        <div className="route-map-legend">
          <span><i className="route-dot route-dot-start" />А</span>
          <span><i className="route-dot route-dot-end" />Б</span>
          {chargingStop && <span>⚡ Зарядка</span>}
        </div>
      </div>
    </div>
  );
};

