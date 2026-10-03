// Pop-up sheets behind the AQI and UV pills: an air quality map and today's UV by hour.
import { h } from '../../core/dom';
import { openSheet } from '../../core/sheet';

export interface AirSummary {
  aqi: number | null;
  category: string | null;
  pm25: number | null;
  ozone: number | null;
}

interface AirMapData {
  step: number;
  updated: number;
  stale?: boolean;
  points: { lat: number; lon: number; aqi: number | null }[];
}

/** EPA AQI bands: upper bound, CSS class, label, color. */
const AQI_BANDS: [number, string, string, string][] = [
  [50, 'aqi-good', 'Good', '#3ccf8e'],
  [100, 'aqi-moderate', 'Moderate', '#f5d33d'],
  [150, 'aqi-sensitive', 'Sensitive groups', '#ff9a3c'],
  [200, 'aqi-unhealthy', 'Unhealthy', '#ff5d5d'],
  [300, 'aqi-very', 'Very unhealthy', '#a35cd6'],
  [Infinity, 'aqi-hazardous', 'Hazardous', '#8c2a3c'],
];

/** WHO UV index bands: upper bound, CSS class, label, color. */
const UV_BANDS: [number, string, string, string][] = [
  [2, 'uv-low', 'Low', '#3ccf8e'],
  [5, 'uv-moderate', 'Moderate', '#f5d33d'],
  [7, 'uv-high', 'High', '#ff9a3c'],
  [10, 'uv-very', 'Very high', '#ff5d5d'],
  [Infinity, 'uv-extreme', 'Extreme', '#a35cd6'],
];

export function aqiBand(aqi: number) {
  const [, cls, name, color] = AQI_BANDS.find(([max]) => aqi <= max)!;
  return { cls, name, color };
}

export function uvBand(uv: number) {
  const [, cls, name, color] = UV_BANDS.find(([max]) => Math.round(uv) <= max)!;
  return { cls, name, color };
}

// ---- Air quality map ----

const ZOOM = 9;
const TILE = 256;
const WORLD = TILE * 2 ** ZOOM;

/** Web Mercator pixel position at ZOOM, matching the map tiles. */
function project(lat: number, lon: number) {
  const s = Math.sin((lat * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * WORLD, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD };
}

export function openAirMap(place: string, lat: number, lon: number, air: AirSummary | null) {
  const map = h('div', { class: 'wx-airmap' });
  const status = h('div', { class: 'wx-airmap-status' }, 'Loading air quality…');
  map.append(status);
  const facts = air
    ? h(
        'div',
        { class: 'wx-sheet-facts' },
        air.aqi != null && h('span', { class: `wx-aqi ${aqiBand(air.aqi).cls}` }, `AQI ${air.aqi}`, h('span', { class: 'wx-aqi-cat' }, ` ${air.category ?? ''}`)),
        air.pm25 != null && h('span', {}, `PM2.5 ${air.pm25} µg/m³`),
        air.ozone != null && h('span', {}, `Ozone ${air.ozone} µg/m³`),
      )
    : null;
  const legend = h(
    'div',
    { class: 'wx-legend' },
    ...AQI_BANDS.map(([max, , name, color], i) =>
      h('span', { class: 'wx-legend-item' }, h('i', { style: `background:${color}` }), `${name} ${i ? AQI_BANDS[i - 1][0] + 1 : 0}${max === Infinity ? '+' : `–${max}`}`),
    ),
  );
  const sheet = openSheet(`🌫️ ${place} air quality`, [facts, map, legend].filter(Boolean) as Node[]);
  sheet.body.closest('.sheet')?.classList.add('wx-map-sheet');

  fetch(`/api/weather/airmap?lat=${lat}&lon=${lon}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((data: AirMapData) => {
      if (!map.isConnected) return;
      status.remove();
      drawAirMap(map, data, lat, lon);
    })
    .catch(() => {
      status.textContent = "Couldn't load the air quality map";
    });
}

function drawAirMap(el: HTMLElement, data: AirMapData, lat: number, lon: number) {
  const w = el.clientWidth;
  const ht = el.clientHeight;
  const c = project(lat, lon);
  const left = c.x - w / 2;
  const top = c.y - ht / 2;

  for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w) / TILE); tx++) {
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + ht) / TILE); ty++) {
      el.append(
        h('img', {
          class: 'wx-airmap-tile',
          src: `https://basemaps.cartocdn.com/dark_all/${ZOOM}/${tx}/${ty}.png`,
          style: `left:${tx * TILE - left}px;top:${ty * TILE - top}px`,
          alt: '',
          onerror: (e: Event) => ((e.target as HTMLElement).style.visibility = 'hidden'),
        }),
      );
    }
  }

  const canvas = h('canvas', { class: 'wx-airmap-layer', width: String(w), height: String(ht) }) as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  const half = data.step / 2;
  // Soft colored cells, then crisp numbers on top.
  ctx.filter = 'blur(28px)';
  ctx.globalAlpha = 0.55;
  for (const p of data.points) {
    if (p.aqi == null) continue;
    const a = project(p.lat + half, p.lon - half);
    const b = project(p.lat - half, p.lon + half);
    ctx.fillStyle = aqiBand(p.aqi).color;
    ctx.fillRect(a.x - left - 1, a.y - top - 1, b.x - a.x + 2, b.y - a.y + 2);
  }
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.font = '600 20px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = '#fff';
  for (const p of data.points) {
    if (p.aqi == null) continue;
    const q = project(p.lat, p.lon);
    ctx.fillText(String(p.aqi), q.x - left, q.y - top);
  }
  el.append(
    canvas,
    h('div', { class: 'wx-airmap-home', style: `left:${w / 2}px;top:${ht / 2}px` }),
    h('div', { class: 'wx-airmap-credit' }, `${data.stale ? 'Offline, last known · ' : ''}US AQI from Open-Meteo (CAMS) · © OpenStreetMap © CARTO`),
  );
}

// ---- Today's UV by hour ----

export function openUvGraph(place: string, timeZone: string | undefined, hours: { time: number; uv: number | null }[]) {
  const hourFmt = new Intl.DateTimeFormat([], { hour: 'numeric', timeZone });
  const label = (t: number) => hourFmt.format(t * 1000).replace(/\s?([AP])M/i, (_, x) => x.toLowerCase());
  const lit = hours.map((p, i) => ((p.uv ?? 0) >= 0.5 ? i : -1)).filter((i) => i >= 0);
  const from = lit.length ? Math.max(0, lit[0] - 1) : 6;
  const to = lit.length ? Math.min(hours.length - 1, lit[lit.length - 1] + 1) : 20;
  const shown = hours.slice(from, to + 1);

  const peak = hours.reduce((best, p) => ((p.uv ?? -1) > (best?.uv ?? -1) ? p : best), hours[0]);
  const safe = hours.filter((p) => (p.uv ?? 0) >= 3);
  const summary = h(
    'div',
    { class: 'wx-sheet-facts' },
    peak?.uv != null
      ? h('span', { class: `wx-aqi ${uvBand(peak.uv).cls}` }, `Peak UV ${Math.round(peak.uv)}`, h('span', { class: 'wx-aqi-cat' }, ` ${uvBand(peak.uv).name} around ${hourFmt.format(peak.time * 1000)}`))
      : h('span', {}, 'No UV data for today'),
    safe.length
      ? h('span', {}, `Sun protection ${hourFmt.format(safe[0].time * 1000)} – ${hourFmt.format((safe[safe.length - 1].time + 3600) * 1000)} (UV 3+)`)
      : peak?.uv != null && h('span', {}, 'Low all day, no sun protection needed'),
  );

  const W = 1000;
  const H = 440;
  const padL = 40;
  const padB = 44;
  const padT = 36;
  const max = Math.max(8, Math.ceil(peak?.uv ?? 0) + 1);
  const y = (v: number) => padT + (1 - v / max) * (H - padT - padB);
  const slot = (W - padL) / Math.max(1, shown.length);
  const nowSec = Date.now() / 1000;
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="wx-uv-chart" role="img" aria-label="UV index by hour today">`;
  for (const g of [3, 6, 8, 11].filter((v) => v <= max)) {
    svg += `<line x1="${padL}" x2="${W}" y1="${y(g)}" y2="${y(g)}" class="wx-grid"/><text x="${padL - 8}" y="${y(g) + 6}" text-anchor="end" class="wx-axis">${g}</text>`;
  }
  shown.forEach((p, i) => {
    const x = padL + i * slot;
    const uv = p.uv ?? 0;
    const isNow = nowSec >= p.time && nowSec < p.time + 3600;
    if (uv > 0) {
      svg += `<rect x="${x + slot * 0.15}" y="${y(uv)}" width="${slot * 0.7}" height="${y(0) - y(uv)}" rx="6" fill="${uvBand(uv).color}"${isNow ? ' class="wx-now-bar"' : ''}/>`;
    }
    if (uv >= 0.5) svg += `<text x="${x + slot / 2}" y="${y(uv) - 10}" text-anchor="middle" class="wx-val">${Math.round(uv)}</text>`;
    if (isNow) svg += `<text x="${x + slot / 2}" y="${H - 4}" text-anchor="middle" class="wx-axis wx-axis-now">Now</text>`;
    else if (i % 2 === 0) svg += `<text x="${x + slot / 2}" y="${H - 12}" text-anchor="middle" class="wx-axis">${label(p.time)}</text>`;
  });
  svg += `<line x1="${padL}" x2="${W}" y1="${y(0)}" y2="${y(0)}" class="wx-base"/></svg>`;
  const chart = h('div', { class: 'wx-uv-chart-wrap' });
  chart.innerHTML = svg;

  const sheet = openSheet(`☀️ ${place} UV today`, [summary, chart]);
  sheet.body.closest('.sheet')?.classList.add('wx-uv-sheet');
}
