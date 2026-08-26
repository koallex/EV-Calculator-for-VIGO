import React, { useEffect } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, useMap } from 'react-leaflet';
import { latLngBounds } from 'leaflet';
import type { RoutePoint } from '../services/routeElevation';
import 'leaflet/dist/leaflet.css';

function FitRoute({ positions }: { positions: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (positions.length < 2) return;
    const bounds = latLngBounds(positions);
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: 14, animate: false });
  }, [map, positions]);
  return null;
}

interface RouteMapProps { points: RoutePoint[]; isDark: boolean; }

export const RouteMap: React.FC<RouteMapProps> = ({ points, isDark }) => {
  const positions = points.map((p) => [p.lat, p.lon] as [number, number]);
  if (positions.length < 2) return null;
  const start = positions[0];
  const end = positions[positions.length - 1];
  const tileUrl = isDark
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const attribution = isDark ? '&copy; OpenStreetMap &copy; CARTO' : '&copy; OpenStreetMap contributors';

  return (
    <div className={`overflow-hidden rounded-2xl border ${isDark ? 'border-slate-800 bg-slate-950' : 'border-slate-200 bg-slate-50'}`}>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-bold">Маршрут</span>
        <span className="text-[10px] text-slate-500">Панорамирование и масштабирование</span>
      </div>
      <div className="route-map">
        <MapContainer center={start} zoom={12} scrollWheelZoom={false} zoomControl={false} attributionControl={false}>
          <TileLayer url={tileUrl} attribution={attribution} />
          <FitRoute positions={positions} />
          <Polyline positions={positions} pathOptions={{ color: '#10b981', weight: 5, opacity: 0.9 }} />
          <CircleMarker center={start} radius={7} pathOptions={{ color: '#ffffff', weight: 3, fillColor: '#10b981', fillOpacity: 1 }} />
          <CircleMarker center={end} radius={7} pathOptions={{ color: '#ffffff', weight: 3, fillColor: '#ef4444', fillOpacity: 1 }} />
        </MapContainer>
        <div className="route-map-legend"><span><i className="route-dot route-dot-start" />А</span><span><i className="route-dot route-dot-end" />Б</span></div>
      </div>
    </div>
  );
};
