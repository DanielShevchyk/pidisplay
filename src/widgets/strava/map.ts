// Route maps for the Strava widget: Google-encoded polylines from Strava drawn on
// CARTO basemap tiles (the same tiles the weather air-quality map uses), sized to
// fit their box. Redraws when the box changes size.
import { h } from '../../core/dom';

export type LatLng = [number, number];

/** Decodes a Google encoded polyline (what Strava's map.summary_polyline holds). */
export function decodePolyline(str: string): LatLng[] {
  const out: LatLng[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0;
      let result = 0;
      let b: number;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && i < str.length);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d;
      else lng += d;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

const TILE = 256;

/** World pixel position at zoom z (Web Mercator). */
function project([lat, lon]: LatLng, z: number): { x: number; y: number } {
  const s = TILE * 2 ** z;
  const sin = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * s, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s };
}

function bounds(points: LatLng[]) {
  let [minLat, minLon, maxLat, maxLon] = [90, 180, -90, -180];
  for (const [la, lo] of points) {
    minLat = Math.min(minLat, la);
    maxLat = Math.max(maxLat, la);
    minLon = Math.min(minLon, lo);
    maxLon = Math.max(maxLon, lo);
  }
  return { minLat, minLon, maxLat, maxLon };
}

export interface Route {
  points: LatLng[];
  /** Drawn on top, thicker, with start and finish dots. */
  main?: boolean;
}

export interface MapOptions {
  /** Points the view must contain; defaults to every route point. */
  fit?: LatLng[];
  padding?: number;
  maxZoom?: number;
  /** Faint lines, many on top of each other (the personal heatmap). */
  heat?: boolean;
  credit?: boolean;
}

const isLight = () => document.documentElement.dataset.theme === 'light';

/**
 * Fills el (position: relative, with a size) with a map of the routes. Returns a
 * function that stops watching el's size.
 */
export function routeMap(el: HTMLElement, routes: Route[], opts: MapOptions = {}): () => void {
  el.classList.add('strava-map');
  let lastSize = '';
  const draw = () => {
    const w = el.clientWidth;
    const ht = el.clientHeight;
    if (!w || !ht || `${w}x${ht}` === lastSize) return;
    lastSize = `${w}x${ht}`;
    el.replaceChildren();
    const all = opts.fit ?? routes.flatMap((r) => r.points);
    if (!all.length) {
      el.append(h('div', { class: 'strava-map-empty' }, 'No GPS route'));
      return;
    }
    const pad = opts.padding ?? Math.min(36, w * 0.08);
    const b = bounds(all);
    let z = opts.maxZoom ?? 16;
    for (; z > 2; z--) {
      const a = project([b.maxLat, b.minLon], z);
      const c = project([b.minLat, b.maxLon], z);
      if (c.x - a.x <= w - pad * 2 && c.y - a.y <= ht - pad * 2) break;
    }
    const a = project([b.maxLat, b.minLon], z);
    const c = project([b.minLat, b.maxLon], z);
    const left = (a.x + c.x) / 2 - w / 2;
    const top = (a.y + c.y) / 2 - ht / 2;
    const style = isLight() ? 'light_all' : 'dark_all';
    const n = 2 ** z;
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w) / TILE); tx++) {
      for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + ht) / TILE); ty++) {
        if (ty < 0 || ty >= n) continue;
        el.append(
          h('img', {
            class: 'strava-map-tile',
            src: `https://basemaps.cartocdn.com/${style}/${z}/${((tx % n) + n) % n}/${ty}.png`,
            style: `left:${tx * TILE - left}px;top:${ty * TILE - top}px`,
            alt: '',
            draggable: 'false',
            onerror: (e: Event) => ((e.target as HTMLElement).style.visibility = 'hidden'),
          }),
        );
      }
    }
    const canvas = h('canvas', { class: 'strava-map-layer' }) as HTMLCanvasElement;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = ht * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const color = getComputedStyle(el).getPropertyValue('--strava').trim() || '#fc4c02';
    const xy = (p: LatLng) => {
      const q = project(p, z);
      return [q.x - left, q.y - top] as const;
    };
    const stroke = (pts: LatLng[]) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(...xy(p)) : ctx.moveTo(...xy(p))));
      ctx.stroke();
    };
    if (opts.heat) {
      // Overlapping faint lines brighten where you go most often.
      ctx.strokeStyle = color;
      ctx.globalAlpha = Math.max(0.12, Math.min(0.5, 6 / Math.sqrt(routes.length + 1)));
      ctx.lineWidth = 2.5;
      for (const r of routes) stroke(r.points);
      ctx.globalAlpha = 1;
    }
    for (const r of routes.filter((r) => !opts.heat || r.main)) {
      // A dark casing keeps the line readable over any map color.
      ctx.strokeStyle = isLight() ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.65)';
      ctx.lineWidth = r.main ? 8 : 5;
      stroke(r.points);
      ctx.strokeStyle = color;
      ctx.lineWidth = r.main ? 4.5 : 2.5;
      stroke(r.points);
      if (r.main && r.points.length > 1) {
        const dot = (p: LatLng, fill: string) => {
          ctx.beginPath();
          ctx.arc(...xy(p), 7, 0, Math.PI * 2);
          ctx.fillStyle = fill;
          ctx.fill();
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = '#fff';
          ctx.stroke();
        };
        dot(r.points[0], '#2fb36b');
        dot(r.points[r.points.length - 1], '#e0413a');
      }
    }
    el.append(canvas);
    if (opts.credit !== false) el.append(h('div', { class: 'strava-map-credit' }, '© OpenStreetMap © CARTO'));
  };
  const ro = new ResizeObserver(draw);
  ro.observe(el);
  requestAnimationFrame(draw);
  return () => ro.disconnect();
}

/**
 * Points near where most activities start (within ~radiusKm of the median start),
 * so one trip far away doesn't zoom the heatmap out to the whole country.
 */
export function homeArea(routes: LatLng[][], radiusKm = 40): LatLng[] {
  const starts = routes.filter((r) => r.length).map((r) => r[0]);
  if (!starts.length) return [];
  const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const c: LatLng = [med(starts.map((s) => s[0])), med(starts.map((s) => s[1]))];
  const km = ([la, lo]: LatLng) => Math.hypot((la - c[0]) * 111, (lo - c[1]) * 111 * Math.cos((c[0] * Math.PI) / 180));
  return routes.filter((r) => r.length && km(r[0]) < radiusKm).flat();
}
