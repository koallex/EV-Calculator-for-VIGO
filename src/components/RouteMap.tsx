import React, { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, Marker, Popup, useMap } from 'react-leaflet';
import { latLngBounds, DivIcon } from 'leaflet';
import type { RoutePoint } from '../services/routeElevation';
import { getBaseTileUrl, MAP_TILE_ATTRIBUTION } from '../utils/mapTiles';
import 'leaflet/dist/leaflet.css';

function FitRoute({
  positions,
  extras,
}: {
  positions: [number, number][];
  extras?: [number, number][];
}) {
  const map = useMap();
  useEffect(() => {
    if (positions.length < 2) return;
    const bounds = latLngBounds(extras?.length ? [...positions, ...extras] : positions);
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 13, animate: false });
  }, [map, positions, extras]);
  return null;
}

const chargingStopIcon = new DivIcon({
  className: '',
  html: '<div class="route-map-charge-pin">⚡</div>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

export interface RouteMapChargingStop {
  lat: number;
  lon: number;
  name: string;
  address?: string;
}

interface RouteMapProps {
  points: RoutePoint[];
  isDark: boolean;
  /** @deprecated use chargingStops */
  chargingStop?: RouteMapChargingStop | null;
  chargingStops?: RouteMapChargingStop[];
}

export const RouteMap: React.FC<RouteMapProps> = ({
  points,
  isDark,
  chargingStop,
  chargingStops,
}) => {
  const positions = points.map((p) => [p.lat, p.lon] as [number, number]);
  const [drawCount, setDrawCount] = useState(positions.length);
  const start = positions[0];
  const end = positions[positions.length - 1];
  const stops =
    chargingStops && chargingStops.length
      ? chargingStops
      : chargingStop
        ? [chargingStop]
        : [];
  const stopPositions = stops.map((s) => [s.lat, s.lon] as [number, number]);

  useEffect(() => {
    if (positions.length < 2) return;
    setDrawCount(2);
    const frames = 70;
    const step = Math.max(1, Math.ceil(positions.length / frames));
    let count = 2;
    const timer = window.setInterval(() => {
      count = Math.min(positions.length, count + step);
      setDrawCount(count);
      if (count >= positions.length) window.clearInterval(timer);
    }, 28);
    return () => window.clearInterval(timer);
  }, [points]);

  const animatedPositions = positions.slice(0, drawCount);

  return (
    <div className={`route-map-shell overflow-hidden ${isDark ? 'bg-slate-950' : 'bg-slate-100'}`}>
      <div className="route-map">
        <MapContainer
          center={start}
          zoom={12}
          scrollWheelZoom={true}
          zoomControl={false}
          attributionControl={false}
          className="route-map-leaflet"
        >
          <TileLayer url={getBaseTileUrl(isDark)} attribution={MAP_TILE_ATTRIBUTION} />
          <FitRoute positions={positions} extras={stopPositions} />
          <Polyline
            positions={animatedPositions}
            pathOptions={{ color: '#06b6d4', weight: 5, opacity: 0.92 }}
          />
          <CircleMarker
            center={start}
            radius={8}
            pathOptions={{ color: '#fff', weight: 3, fillColor: '#22d3ee', fillOpacity: 1 }}
          />
          <CircleMarker
            center={end}
            radius={8}
            pathOptions={{ color: '#fff', weight: 3, fillColor: '#ef4444', fillOpacity: 1 }}
          />
          {stops.map((s, i) => (
            <Marker key={`${s.lat}-${s.lon}-${i}`} position={[s.lat, s.lon]} icon={chargingStopIcon}>
              <Popup>
                <span className="text-xs font-semibold">
                  {stops.length > 1 ? `${i + 1}. ` : ''}
                  {s.name}
                </span>
                {s.address ? (
                  <>
                    <br />
                    <span className="text-xs">{s.address}</span>
                  </>
                ) : null}
              </Popup>
            </Marker>
          ))}
        </MapContainer>
        <div className="route-map-legend">
          <span>
            <i className="route-dot route-dot-start" />А
          </span>
          <span>
            <i className="route-dot route-dot-end" />Б
          </span>
          {stops.length > 0 && (
            <span>
              ⚡ {stops.length > 1 ? `${stops.length} остановки` : 'Зарядка'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
