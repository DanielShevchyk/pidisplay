// Route map for the big Fares tiles: one fare's outbound legs drawn as great-circle arcs
// over an offline coastline (no map tiles to download), plus the legs and layovers as text.
import { h } from '../../core/dom';

/** One flight of a live-checked itinerary, as fare_watch.py exports it from Google Flights. */
export interface Leg {
  from: string;
  fromName: string | null;
  to: string;
  toName: string | null;
  /** Local airport time, "2026-10-19 13:25". */
  departTime: string | null;
  arriveTime: string | null;
  durationMin: number | null;
  airline: string | null;
  flightNumber: string | null;
  airplane?: string | null;
  travelClass?: string | null;
  legroom?: string | null;
  overnight?: boolean;
}

export interface Layover {
  airport: string;
  name: string | null;
  durationMin: number | null;
  overnight?: boolean;
}

/** Outbound only: Google returns the return legs in a second (paid) search. No per-leg prices. */
export interface Itinerary {
  legs: Leg[];
  layovers: Layover[];
  totalDurationMin: number | null;
  price: number | null;
  carbonKg: number | null;
}

export interface Airport {
  name: string | null;
  lat: number;
  lon: number;
}

/** The fare the map shows: from a home airport to a destination (metro codes like TYO are fine). */
export interface Route {
  origin: string | null;
  code: string;
  stops: number | null;
  airline: string | null;
  itinerary: Itinerary | null;
  /** Open jaw: the flight home leaves from another city, which you get to on your own. */
  openJaw?: OpenJawRoute | null;
}

export interface OpenJawRoute {
  returnFrom: string;
  returnTo: string;
  /** The two one-way fares it adds up; null once Google priced the whole ticket. */
  outPrice: number | null;
  backPrice: number | null;
}

// ---- Panel pieces ---------------------------------------------------------

/** The map itself. It draws once it knows its size and redraws when the tile is resized. */
export function routeMap(route: Route | null, airports: Record<string, Airport> | undefined) {
  const canvas = h('div', { class: 'fares-map-canvas' });
  const stops = route && routeStops(route, airports);
  const back = stops && route.openJaw ? returnStops(route.openJaw, airports) : null;
  if (!stops) {
    canvas.append(h('div', { class: 'fares-map-empty' }, airports ? 'No map position for this route' : 'Map needs a newer Farewatcher'));
    return canvas;
  }
  let drawn = '';
  const observer = new ResizeObserver(() => {
    if (!canvas.isConnected) return observer.disconnect();
    const { clientWidth: w, clientHeight: hgt } = canvas;
    if (w < 40 || hgt < 40 || drawn === `${w}x${hgt}`) return;
    drawn = `${w}x${hgt}`;
    loadWorld().then((world) => {
      if (canvas.isConnected) canvas.replaceChildren(draw(world, stops, back, w, hgt, !route.itinerary));
    });
  });
  observer.observe(canvas);
  return canvas;
}

/** Legs, layovers and total time under the map; a note when the fare hasn't been live-checked. */
export function legList(
  route: Route | null,
  airports: Record<string, Airport> | undefined,
  money: (n: number) => string,
) {
  const list = h('div', { class: 'fares-legs' });
  if (!route) return list;
  const it = route.itinerary;
  const jaw = route.openJaw;
  if (!it?.legs.length) {
    list.append(
      h(
        'div',
        { class: 'fares-leg-top' },
        h('span', { class: 'fares-leg-route' }, `${route.origin ?? '?'} → ${route.code}`),
        h(
          'span',
          { class: 'fares-leg-dur' },
          [stopsText(route.stops), route.airline, jaw?.outPrice ? money(jaw.outPrice) : ''].filter(Boolean).join(' · '),
        ),
      ),
      h('div', { class: 'fares-leg-note' }, 'Flights and layovers show up once Farewatcher checks this fare live on Google.'),
    );
    if (jaw) list.append(...homeFromElsewhere(jaw, route.code, airports, money));
    return list;
  }
  it.legs.forEach((leg, i) => {
    list.append(
      h(
        'div',
        { class: 'fares-leg' },
        h(
          'div',
          { class: 'fares-leg-top' },
          h('span', { class: 'fares-leg-route' }, `${leg.from} → ${leg.to}`),
          h('span', { class: 'fares-leg-dur' }, duration(leg.durationMin)),
        ),
        h(
          'div',
          { class: 'fares-leg-sub' },
          [legTimes(leg), [leg.airline, leg.flightNumber].filter(Boolean).join(' '), leg.airplane].filter(Boolean).join(' · '),
        ),
      ),
    );
    const stop = it.layovers[i];
    if (stop && i < it.legs.length - 1) {
      list.append(
        h(
          'div',
          { class: 'fares-layover' },
          `⏱ ${duration(stop.durationMin)} layover in ${city(stop.airport, stop.name, airports)}`,
          stop.overnight && ' · overnight',
        ),
      );
    }
  });
  if (jaw) list.append(...homeFromElsewhere(jaw, it.legs[it.legs.length - 1].to, airports, money));
  list.append(
    h(
      'div',
      { class: 'fares-leg-total' },
      ['Outbound', duration(it.totalDurationMin), it.carbonKg ? `${it.carbonKg} kg CO₂` : ''].filter(Boolean).join(' · '),
    ),
  );
  return list;
}

/** The open jaw's ground hop ("Frankfurt to Paris on your own") and its flight home. */
function homeFromElsewhere(
  jaw: OpenJawRoute,
  arrival: string,
  airports: Record<string, Airport> | undefined,
  money: (n: number) => string,
) {
  const a = airports?.[arrival];
  const b = airports?.[jaw.returnFrom];
  const km = a && b ? Math.round(distanceKm(a, b) / 10) * 10 : null;
  return [
    h(
      'div',
      { class: 'fares-ground' },
      `🚆 ${cityName(arrival, airports)} to ${cityName(jaw.returnFrom, airports)} on your own`,
      km ? ` · about ${km} km` : '',
    ),
    h(
      'div',
      { class: 'fares-leg-top fares-back' },
      h('span', { class: 'fares-leg-route' }, `${jaw.returnFrom} → ${jaw.returnTo}`),
      h('span', { class: 'fares-leg-dur' }, ['Flight home', jaw.backPrice ? money(jaw.backPrice) : ''].filter(Boolean).join(' · ')),
    ),
  ];
}

// ---- Geometry -------------------------------------------------------------

interface Stop {
  code: string;
  lat: number;
  lon: number;
  /** 'return' and 'home' are an open jaw's flight home. */
  kind: 'origin' | 'layover' | 'dest' | 'return' | 'home';
  /** Layover length, shown under the code. */
  note: string | null;
}

/** Airports along the route with coordinates, or null when an end can't be placed. */
function routeStops(route: Route, airports: Record<string, Airport> | undefined): Stop[] | null {
  if (!airports || !route.origin) return null;
  const legs = route.itinerary?.legs ?? [];
  const codes = legs.length ? [legs[0].from, ...legs.map((l) => l.to)] : [route.origin, route.code];
  const stops: Stop[] = [];
  codes.forEach((code, i) => {
    const at = airports[code];
    const kind = i === 0 ? 'origin' : i === codes.length - 1 ? 'dest' : 'layover';
    // A layover airport Farewatcher couldn't place is skipped; the line goes straight past it.
    if (!at) return;
    const layover = kind === 'layover' ? route.itinerary?.layovers.find((x) => x.airport === code) : null;
    stops.push({ code, lat: at.lat, lon: at.lon, kind, note: layover ? duration(layover.durationMin) : null });
  });
  const ends = stops.map((s) => s.kind);
  return ends[0] === 'origin' && ends[ends.length - 1] === 'dest' ? stops : null;
}

function returnStops(jaw: OpenJawRoute, airports: Record<string, Airport> | undefined): Stop[] | null {
  const from = airports?.[jaw.returnFrom];
  const to = airports?.[jaw.returnTo];
  if (!from || !to) return null;
  return [
    { code: jaw.returnFrom, lat: from.lat, lon: from.lon, kind: 'return', note: null },
    { code: jaw.returnTo, lat: to.lat, lon: to.lon, kind: 'home', note: null },
  ];
}

function distanceKm(a: Airport, b: Airport) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(q));
}

type Ring = Float32Array;
interface World {
  land: Ring[];
  borders: Ring[];
}

let world: Promise<World> | null = null;

/** The coastline is ~40 KB, so it loads only once a big Fares tile needs it. */
function loadWorld() {
  world ??= import('./world').then((m) => ({ land: decode(m.LAND), borders: decode(m.BORDERS) }));
  return world;
}

function decode(data: string): Ring[] {
  return data.split(';').map((ring) => {
    const n = ring.split(',').map(Number);
    const out = new Float32Array(n.length);
    let lon = 0;
    let lat = 0;
    for (let i = 0; i < n.length; i += 2) {
      lon += n[i];
      lat += n[i + 1];
      out[i] = lon / 10;
      out[i + 1] = lat / 10;
    }
    return out;
  });
}

const RAD = Math.PI / 180;

/** Points along the shortest path over the globe, as [lon, lat]. */
function greatCircle(a: Stop, b: Stop): [number, number][] {
  const vec = (s: Stop) => {
    const lat = s.lat * RAD;
    const lon = s.lon * RAD;
    return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  };
  const va = vec(a);
  const vb = vec(b);
  const angle = Math.acos(Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2])));
  if (angle < 1e-6) return [[a.lon, a.lat], [b.lon, b.lat]];
  const steps = Math.max(8, Math.round(angle / RAD / 2));
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const s1 = Math.sin((1 - t) * angle) / Math.sin(angle);
    const s2 = Math.sin(t * angle) / Math.sin(angle);
    const [x, y, z] = [0, 1, 2].map((k) => s1 * va[k] + s2 * vb[k]);
    out.push([Math.atan2(y, x) / RAD, Math.atan2(z, Math.hypot(x, y)) / RAD]);
  }
  return out;
}

/** `lon` moved by whole turns to sit within 180° of `near`, so lines don't jump across the map. */
function unwrap(lon: number, near: number) {
  return lon + 360 * Math.round((near - lon) / 360);
}

const SVG = 'http://www.w3.org/2000/svg';

function svg(tag: string, attrs: Record<string, string | number>, text?: string) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text) el.textContent = text;
  return el;
}

/**
 * Equirectangular map fitted around the route. Longitudes are unwrapped from the origin so
 * a route across the Pacific stays in one piece.
 */
function draw(world: World, stops: Stop[], back: Stop[] | null, w: number, hgt: number, guessed: boolean) {
  let prev = stops[0].lon;
  const legs = stops.slice(1).map((stop, i) =>
    greatCircle(stops[i], stop).map(([lon, lat]): [number, number] => {
      prev = unwrap(lon, prev);
      return [prev, lat];
    }),
  );
  const at = stops.map((s, i) => (i === 0 ? ([s.lon, s.lat] as [number, number]) : legs[i - 1][legs[i - 1].length - 1]));
  // An open jaw's flight home, unwrapped next to the arrival city so both sit on the same map.
  prev = at[at.length - 1][0];
  const home = back
    ? greatCircle(back[0], back[1]).map(([lon, lat]): [number, number] => {
        prev = unwrap(lon, prev);
        return [prev, lat];
      })
    : [];

  const all = [...legs.flat(), ...home];
  const lons = all.map((p) => p[0]);
  const lats = all.map((p) => p[1]);
  const lon0 = (Math.min(...lons) + Math.max(...lons)) / 2;
  const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
  // Short hops (SFO-YVR) stay zoomed out enough to recognize the coastline.
  const lonSpan = Math.max(Math.max(...lons) - Math.min(...lons), 24);
  const latSpan = Math.max(Math.max(...lats) - Math.min(...lats), 14);
  const squash = Math.cos(Math.min(60, Math.abs(lat0)) * RAD);
  const padX = 60;
  const padY = 40;
  const k = Math.min((w - 2 * padX) / (lonSpan * squash), (hgt - 2 * padY) / latSpan);
  const x = (lon: number) => w / 2 + (lon - lon0) * squash * k;
  const y = (lat: number) => hgt / 2 - (lat - lat0) * k;
  const viewLon = w / 2 / (squash * k);

  const map = svg('svg', { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, class: 'fares-map-svg' });
  map.append(
    svg('path', { d: shapes(world.land, true), class: 'fares-map-land' }),
    svg('path', { d: shapes(world.borders, false), class: 'fares-map-border' }),
  );

  /** Path data for rings, each unwrapped around the view and repeated a turn left or right if that's visible. */
  function shapes(rings: Ring[], closed: boolean) {
    let d = '';
    for (const ring of rings) {
      const n = ring.length / 2;
      const pts = new Float64Array(ring.length);
      let p = lon0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < n; i++) {
        p = unwrap(ring[2 * i], p);
        pts[2 * i] = p;
        pts[2 * i + 1] = ring[2 * i + 1];
        lo = Math.min(lo, p);
        hi = Math.max(hi, p);
      }
      for (const turn of [-360, 0, 360]) {
        if (hi + turn < lon0 - viewLon || lo + turn > lon0 + viewLon) continue;
        for (let i = 0; i < n; i++) {
          d += `${i ? 'L' : 'M'}${x(pts[2 * i] + turn).toFixed(1)} ${y(pts[2 * i + 1]).toFixed(1)}`;
        }
        if (closed) d += 'Z';
      }
    }
    return d;
  }

  const px = at.map(([lon, lat]) => [x(lon), y(lat)]);
  const line = (pts: [number, number][]) => pts.map(([lon, lat]) => `${x(lon).toFixed(1)},${y(lat).toFixed(1)}`).join(' ');
  if (home.length) {
    const [ax, ay] = px[px.length - 1];
    map.append(
      svg('line', { x1: ax, y1: ay, x2: x(home[0][0]), y2: y(home[0][1]), class: 'fares-map-ground' }),
      svg('polyline', { points: line(home), class: 'fares-map-route back' }),
    );
  }
  for (const leg of legs) {
    map.append(
      svg('polyline', {
        points: line(leg),
        class: `fares-map-route${guessed ? ' guessed' : ''}`,
      }),
    );
  }

  // Labels sit on the outside of the route: behind the origin, past the destination, and
  // beside a layover, away from the line.
  // Each mark: the stop, where it is, and which way its label goes.
  const marks: [Stop, number, number, number, number][] = stops.map((stop, i) => {
    const [cx, cy] = px[i];
    const [dx, dy] =
      stop.kind === 'origin'
        ? [cx - px[1][0], cy - px[1][1]]
        : stop.kind === 'dest'
          ? [cx - px[i - 1][0], cy - px[i - 1][1]]
          : [-(px[i + 1][1] - px[i - 1][1]), px[i + 1][0] - px[i - 1][0]];
    return [stop, cx, cy, dx, dy];
  });
  if (back && home.length) {
    // The city you fly home from is labelled away from the arrival city; a different home
    // airport (in SFO, back to SMF) gets its own label past the end of the line.
    const [ax, ay] = px[px.length - 1];
    const [bx, by] = [x(home[0][0]), y(home[0][1])];
    marks.push([back[0], bx, by, bx - ax, by - ay]);
    if (back[1].code !== stops[0].code) {
      const [hx, hy] = [x(home[home.length - 1][0]), y(home[home.length - 1][1])];
      const [qx, qy] = [x(home[home.length - 2][0]), y(home[home.length - 2][1])];
      const homeMark: [Stop, number, number, number, number] = [back[1], hx, hy, hx - qx, hy - qy];
      // SFO and SMF sit close together: put their labels on opposite sides.
      const [, ox, oy] = marks[0];
      if (Math.hypot(hx - ox, hy - oy) < 60) {
        const side = ox >= hx ? 1 : -1;
        marks[0] = [marks[0][0], ox, oy, side, 0];
        [homeMark[3], homeMark[4]] = [-side, 0];
      }
      marks.push(homeMark);
    }
  }
  for (const [stop, cx, cy, dx0, dy0] of marks) {
    let [dx, dy] = [dx0, dy0];
    if (stop.kind === 'layover' && dy > 0) [dx, dy] = [-dx, -dy]; // prefer above the line
    const len = Math.hypot(dx, dy) || 1;
    [dx, dy] = [dx / len, dy / len];
    let anchor = dx > 0.35 ? 'start' : dx < -0.35 ? 'end' : 'middle';
    let lx = cx + dx * 14;
    const lines = stop.note ? 2 : 1;
    let ly = dy > 0.35 ? cy + 14 + 14 : dy < -0.35 ? cy - 12 - (lines - 1) * 15 : cy + 5 - (lines - 1) * 7;
    // Keep labels on the map (bold 15px is about 10px a character).
    const width = Math.max(stop.code.length * 10, stop.note ? stop.note.length * 8 : 0);
    const left = anchor === 'end' ? lx - width : anchor === 'middle' ? lx - width / 2 : lx;
    if (left + width > w - 4) [anchor, lx] = ['end', Math.min(cx - 10, w - 4)];
    else if (left < 4) [anchor, lx] = ['start', Math.max(cx + 10, 4)];
    ly = Math.min(hgt - 6 - (lines - 1) * 15, Math.max(18, ly));

    map.append(svg('circle', { cx, cy, r: stop.kind === 'layover' ? 5 : 6.5, class: `fares-map-stop ${stop.kind}` }));
    map.append(svg('text', { x: lx, y: ly, 'text-anchor': anchor, class: 'fares-map-code' }, stop.code));
    if (stop.note) {
      map.append(svg('text', { x: lx, y: ly + 15, 'text-anchor': anchor, class: 'fares-map-note' }, stop.note));
    }
  }
  return map;
}

// ---- Formatting -----------------------------------------------------------

/** 805 -> "13h 25m". */
export function duration(min: number | null | undefined) {
  if (!min && min !== 0) return '';
  const hours = Math.floor(min / 60);
  return hours ? `${hours}h${min % 60 ? ` ${min % 60}m` : ''}` : `${min}m`;
}

function stopsText(n: number | null) {
  if (n === null || n === undefined) return '';
  return n === 0 ? 'Nonstop' : `${n} stop${n > 1 ? 's' : ''}`;
}

/** "1:25 PM – 6:40 PM +1" in each airport's local time, as Google gives it. */
function legTimes(leg: Leg) {
  const dep = parseLocal(leg.departTime);
  const arr = parseLocal(leg.arriveTime);
  if (!dep || !arr) return '';
  const days = Math.round(
    (new Date(arr.getFullYear(), arr.getMonth(), arr.getDate()).getTime() -
      new Date(dep.getFullYear(), dep.getMonth(), dep.getDate()).getTime()) /
      86400000,
  );
  return `${clock(dep)} – ${clock(arr)}${days > 0 ? ` +${days}` : ''}`;
}

function parseLocal(s: string | null) {
  const m = s && /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(s);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

function clock(d: Date) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "Taipei (TPE)" from the airports table, else the airport's own name. */
function city(code: string, name: string | null, airports: Record<string, Airport> | undefined) {
  const known = airports?.[code]?.name?.split(',')[0].trim();
  return `${known || name || code} (${code})`;
}

/** "Frankfurt", or the code when the airports table doesn't know it. */
function cityName(code: string, airports: Record<string, Airport> | undefined) {
  return airports?.[code]?.name?.split(',')[0].trim() || code;
}
