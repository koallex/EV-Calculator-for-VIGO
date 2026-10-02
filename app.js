const map = L.map('map', {
  zoomControl: false,
  attributionControl: true,
  preferCanvas: true
}).setView([53.9, 27.55], 8);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '© OpenStreetMap'
}).addTo(map);

L.control.zoom({ position: 'topright' }).addTo(map);

L.marker([53.882, 28.03], {
  icon: L.divIcon({
    className: 'airport-marker',
    html: '<div class="airport-pin">✈</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14]
  })
}).addTo(map).bindTooltip('Национальный аэропорт Минск (UMMS)', { direction: 'top' });

const layer = L.layerGroup().addTo(map);
let selected = null;
let markersByIcao = new Map();
let timer = null;
let lastData = null;

function esc(s) {
  return String(s ?? '—').replace(/[&<>"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
  }[c]));
}

function aircraftIcon(heading, isSelected) {
  const rot = heading != null ? heading : 0;
  const cls = isSelected ? 'plane selected' : 'plane';
  return L.divIcon({
    className: '',
    html: `<div class="${cls}" style="transform:rotate(${rot}deg)">✈</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14]
  });
}

function formatAlt(m) {
  if (m == null) return '—';
  return Math.round(m) + ' м';
}

function formatSpeed(ms) {
  if (ms == null) return '—';
  return Math.round(ms * 3.6) + ' км/ч';
}

function showDetails(s) {
  const [icao, callsign, reg, , , , , alt, onGround, vel, track, vrate, acType] = s;
  const name = (callsign || reg || 'Без позывного').trim();
  document.getElementById('details').innerHTML = `
    <strong>${esc(name)}</strong>
    <div class="meta">
      ICAO: ${esc(icao)} ${reg ? '· ' + esc(reg) : ''}<br>
      ${acType ? 'Тип: ' + esc(acType) + '<br>' : ''}
      Высота: ${formatAlt(alt)} · Скорость: ${formatSpeed(vel)}<br>
      Курс: ${track == null ? '—' : Math.round(track) + '°'} ·
      ${onGround ? '<span class="tag ground">На земле</span>' : '<span class="tag air">В воздухе</span>'}
      ${vrate != null && Math.abs(vrate) > 0.5 ? '<br>Верт. скорость: ' + (vrate > 0 ? '↑' : '↓') + ' ' + Math.round(Math.abs(vrate * 196.85)) + ' ft/min' : ''}
    </div>`;
}

function clearSelection() {
  if (selected && markersByIcao.has(selected)) {
    const m = markersByIcao.get(selected);
    const s = m.__state;
    m.setIcon(aircraftIcon(s[10], false));
  }
  selected = null;
}

async function load() {
  const status = document.getElementById('status');
  status.textContent = 'Загрузка…';
  status.className = 'status loading';

  try {
    const r = await fetch('/api/aircraft', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (data.error) throw new Error(data.error);

    lastData = data;
    layer.clearLayers();
    markersByIcao.clear();

    const states = data.states || [];
    let visible = 0;

    states.forEach(s => {
      const [icao, callsign, , , , lon, lat, , , , track] = s;
      if (lon == null || lat == null) return;
      visible++;

      const isSel = selected === icao;
      const marker = L.marker([lat, lon], {
        icon: aircraftIcon(track, isSel),
        zIndexOffset: isSel ? 1000 : 0
      }).addTo(layer);

      marker.__state = s;
      markersByIcao.set(icao, marker);

      marker.on('click', () => {
        clearSelection();
        selected = icao;
        marker.setIcon(aircraftIcon(track, true));
        marker.setZIndexOffset(1000);
        showDetails(s);
      });
    });

    // Keep selection details if still present
    if (selected && markersByIcao.has(selected)) {
      showDetails(markersByIcao.get(selected).__state);
    } else if (selected) {
      selected = null;
      document.getElementById('details').innerHTML = 'Самолёт ушёл из зоны. Нажмите на другой.';
    }

    document.getElementById('count').textContent = visible + ' бортов';
    document.getElementById('updated').textContent =
      'Обновлено: ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    status.textContent = 'Онлайн';
    status.className = 'status ok';
  } catch (e) {
    status.textContent = 'Нет данных';
    status.className = 'status err';
    document.getElementById('updated').textContent = 'Ошибка: ' + e.message;
  }
}

document.getElementById('refresh').onclick = () => {
  load();
};

// Initial load + interval
load();
timer = setInterval(load, 15000);

// Prevent accidental zoom on double-tap etc.
document.addEventListener('gesturestart', e => e.preventDefault());
