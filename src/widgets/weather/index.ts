import { h } from '../../core/dom';
import { openSheet } from '../../core/sheet';
import { defineWidget, type Placement } from '../../core/types';
import { homeSettings } from '../../core/home';
import { aqiBand, openAirMap, openUvGraph, uvBand } from './sheets';
import './weather.css';

interface WeatherConfig {
  /** City ("Austin, TX", "Paris, France") or "lat,lon". */
  location: string;
  units: 'imperial' | 'metric';
  /** Shown instead of the resolved place name when set. */
  label: string;
  showAirQuality: boolean;
  /** 'split' puts the forecast and a live map side by side; 'map' is map only. */
  view: 'split' | 'forecast' | 'map';
  mapLayer: MapLayer;
  [key: string]: unknown;
}

type MapLayer = 'rain' | 'temp' | 'wind' | 'clouds';

const MAP_LAYERS: { value: MapLayer; label: string; icon: string; name: string }[] = [
  { value: 'rain', label: '🌧️ Rain', icon: '🌧️', name: 'Rain' },
  { value: 'temp', label: '🌡️ Temperature', icon: '🌡️', name: 'Temperature' },
  { value: 'wind', label: '💨 Wind', icon: '💨', name: 'Wind' },
  { value: 'clouds', label: '☁️ Clouds', icon: '☁️', name: 'Clouds' },
];

interface AirQuality {
  aqi: number | null;
  category: string | null;
  pm25: number | null;
  pm10: number | null;
  ozone: number | null;
  no2: number | null;
  uv: number | null;
  hourly: { time: number; aqi: number | null }[];
}

/** Mirrors the payload from GET /api/weather (server/weather.js). */
interface Forecast {
  location: { name: string; region: string; country: string; lat: number; lon: number };
  units: 'imperial' | 'metric';
  timezone: string;
  updated: number;
  stale?: boolean;
  /** Null when the air quality service didn't answer. */
  airQuality?: AirQuality | null;
  current: {
    temp: number | null;
    feelsLike: number | null;
    humidity: number | null;
    wind: number | null;
    windDir: number | null;
    precip: number;
    code: number;
    isDay: boolean;
  };
  hourly: { time: number; temp: number | null; code: number; isDay: boolean; precipChance: number | null }[];
  daily: {
    date: number;
    high: number | null;
    low: number | null;
    code: number;
    precipChance: number | null;
    sunrise: number | null;
    sunset: number | null;
    /** Today's peak UV index, from the forecast. */
    uvMax?: number | null;
  }[];
  /** Today's UV index by hour from local midnight. */
  uvToday?: { time: number; uv: number | null }[];
}

interface SharedDefault {
  location: string;
}

interface Cached {
  query: string;
  data: Forecast;
}

/** Used until a location is set on any weather tile: the display's saved home location, if any. */
const fallbackLocation = async () => (await homeSettings()).location?.trim() || '';
const REFRESH_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;

/** Forecast days beside the map in the side-by-side view; 0 = too small for it. */
const SPLIT_DAYS: Record<Placement, number> = {
  bar: 0,
  small: 0,
  medium: 0,
  tall: 0,
  large: 5,
  xlarge: 5,
  full: 7,
};

/** How much each tile size shows: hourly entries and forecast days. */
const LAYOUT: Record<Placement, { hours: number; days: number; details: boolean }> = {
  bar: { hours: 0, days: 0, details: false },
  small: { hours: 0, days: 0, details: false },
  medium: { hours: 0, days: 3, details: false },
  tall: { hours: 0, days: 4, details: false },
  large: { hours: 6, days: 5, details: false },
  xlarge: { hours: 8, days: 7, details: true },
  full: { hours: 12, days: 7, details: true },
};

export default defineWidget<WeatherConfig>({
  type: 'weather',
  name: 'Weather',
  description: 'Conditions, forecast, air quality and a forecast map for any city',
  icon: '⛅',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'large',
  supportsBar: true,
  defaultConfig: { location: '', units: 'imperial', label: '', showAirQuality: true, view: 'split', mapLayer: 'rain' },
  settings: [
    { key: 'location', label: 'Location (blank = same as other weather tiles)', type: 'text', placeholder: 'e.g. Austin, TX or 40.71,-74.01' },
    {
      key: 'units',
      label: 'Units',
      type: 'select',
      options: [
        { value: 'imperial', label: '°F, mph' },
        { value: 'metric', label: '°C, km/h' },
      ],
    },
    { key: 'label', label: 'Label (blank = city name)', type: 'text', placeholder: 'e.g. Home' },
    { key: 'showAirQuality', label: 'Show air quality', type: 'boolean' },
    {
      key: 'view',
      label: 'Tile shows',
      type: 'select',
      options: [
        { value: 'split', label: 'Forecast and map side by side' },
        { value: 'forecast', label: 'Forecast only (tap for the map)' },
        { value: 'map', label: 'Map only' },
      ],
    },
    { key: 'mapLayer', label: 'Map layer', type: 'select', options: MAP_LAYERS.map(({ value, label }) => ({ value, label })) },
  ],

  mount(el, { config, placement, storage, sharedStorage, saveConfig }) {
    const root = h('div', { class: `wx size-${placement}` });
    el.append(root);
    const own = config.location.trim();
    let location = '';
    let data: Forecast | null = null;
    let failed = '';
    let timer = 0;
    let alive = true;
    const queryFor = (loc: string) => `${loc}|${config.units}`;

    const mapTile = config.view === 'map' && placement !== 'bar';
    // Side by side needs a 2x2 tile or bigger; smaller tiles show the forecast.
    const splitDays = config.view === 'split' ? SPLIT_DAYS[placement] : 0;
    let mapAt = '';
    let split: ReturnType<typeof splitView> | null = null;

    const paint = () => {
      if (!location) {
        root.replaceChildren(
          placement === 'bar'
            ? ''
            : h('button', { class: 'wx-set-location', onclick: pick }, message('📍', 'Tap to set a location')),
        );
        return;
      }
      if (mapTile && data) {
        // Only rebuild the map when the place changes, so refreshes don't reload it.
        const at = `${data.location.lat},${data.location.lon}`;
        if (at !== mapAt) {
          mapAt = at;
          root.replaceChildren(tapToLoad(() => lockedMap(mapFrame(data!, config, config.mapLayer, placement === 'small' ? 6 : 7))));
        }
        return;
      }
      if (splitDays && data) {
        if (!split) {
          split = splitView(config);
          root.replaceChildren(split.el);
          root.classList.add('wx-split-mode');
        }
        split.left.replaceChildren(render(data, config, 'tall', Boolean(failed), splitDays, pick));
        split.setPlace(data);
        return;
      }
      split = null;
      root.classList.remove('wx-split-mode');
      root.replaceChildren(
        data ? render(data, config, placement, Boolean(failed), undefined, pick) : failed ? message('⚠️', failed) : message('', 'Loading…'),
      );
    };

    // Tapping the place name changes this tile's location without going through ⚙.
    const pick = (e?: Event) => {
      e?.stopPropagation();
      pickLocation(own, location, (next) => saveConfig({ location: next }));
    };

    const refresh = async () => {
      clearTimeout(timer);
      if (!location) return paint();
      const loc = location;
      let next = REFRESH_MS;
      try {
        const params = new URLSearchParams({ location: loc, units: config.units });
        const res = await fetch(`/api/weather?${params}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `Weather failed (${res.status})`);
        if (!alive || loc !== location) return;
        data = body as Forecast;
        failed = data.stale ? 'Offline' : '';
        storage.save({ query: queryFor(loc), data } satisfies Cached).catch(() => {});
      } catch (err) {
        if (!alive || loc !== location) return;
        failed = err instanceof Error ? err.message : String(err);
        next = RETRY_MS;
      }
      paint();
      timer = window.setTimeout(refresh, next);
    };

    const use = (loc: string) => {
      if (loc === location) return;
      location = loc;
      data = null;
      failed = '';
      refresh();
    };

    // Tiles with a blank location follow the one most recently set on any
    // weather tile, so the city only has to be entered once.
    const followShared = () =>
      sharedStorage
        .load<SharedDefault | null>(null)
        .then(async (d) => {
          const loc = d?.location || (await fallbackLocation());
          if (alive && !own) use(loc);
        })
        .catch(() => {});

    // Show this tile's last forecast right away (e.g. after a reboot), then refresh.
    storage
      .load<Cached | null>(null)
      .catch(() => null)
      .then(async (cached) => {
        if (!alive) return;
        // A tile whose location was just edited becomes the default for blank tiles.
        if (own && cached?.query.split('|')[0] !== own) {
          sharedStorage.save({ location: own } satisfies SharedDefault).catch(() => {});
        }
        const shared = own ? null : await sharedStorage.load<SharedDefault | null>(null).catch(() => null);
        const loc = own || shared?.location || (await fallbackLocation());
        if (loc && cached?.query === queryFor(loc)) data = cached.data;
        location = loc;
        paint();
        refresh();
      });

    const unsubscribe = own ? () => {} : sharedStorage.onChange(followShared);

    // A tap (not a swipe between pages) opens the full-screen forecast map.
    let down: { x: number; y: number } | null = null;
    root.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    root.addEventListener('click', (e) => {
      const moved = down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) : 0;
      if (mapTile || split || !data || moved > 12) return;
      openMap(data, config);
    });

    return {
      destroy() {
        alive = false;
        clearTimeout(timer);
        unsubscribe();
      },
    };
  },
});

/** Sheet for typing a new location. Blank means "same as the other weather tiles". */
function pickLocation(own: string, current: string, save: (location: string) => void) {
  const input = h('input', {
    type: 'text',
    class: 'wx-location-input',
    value: own || current,
    placeholder: 'e.g. Citrus Heights, CA or 38.7,-121.3',
    autocomplete: 'off',
  });
  const done = (loc: string) => {
    sheet.close();
    if (loc !== own) save(loc);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) done(input.value.trim());
  });
  const sheet = openSheet('📍 Weather location', [
    h('p', { class: 'wx-location-help' }, 'City and state, city and country, or lat,lon.'),
    input,
    h(
      'div',
      { class: 'wx-location-actions' },
      h('button', { class: 'btn btn-primary', onclick: () => input.value.trim() && done(input.value.trim()) }, 'Save'),
      own && h('button', { class: 'btn', onclick: () => done('') }, 'Use the other weather tiles\' location'),
    ),
  ]);
  setTimeout(() => {
    input.focus();
    input.select();
  }, 50);
}

function message(icon: string, text: string) {
  return h('div', { class: 'wx-message' }, icon && h('div', { class: 'wx-message-icon' }, icon), text);
}

function render(
  d: Forecast,
  config: WeatherConfig,
  placement: Placement,
  offline: boolean,
  daysOverride?: number,
  onPlace?: (e: Event) => void,
) {
  const tz = validZone(d.timezone);
  const deg = (n: number | null) => (n === null ? '–' : `${n}°`);
  const today = d.daily[0];
  const place = config.label.trim() || d.location.name;
  const cur = d.current;
  const aq = config.showAirQuality && d.airQuality?.aqi != null ? d.airQuality : null;

  if (placement === 'bar') {
    return h(
      'div',
      { class: 'wx-bar' },
      h('span', { class: 'wx-bar-icon' }, icon(cur.code, cur.isDay)),
      h('span', { class: 'wx-bar-temp' }, deg(cur.temp)),
    );
  }

  const spec = daysOverride ? { ...LAYOUT[placement], days: daysOverride } : LAYOUT[placement];
  const now = h(
    'div',
    { class: 'wx-now' },
    h('div', { class: 'wx-now-icon' }, icon(cur.code, cur.isDay)),
    h('div', { class: 'wx-now-temp' }, deg(cur.temp)),
    h(
      'div',
      { class: 'wx-now-text' },
      h(
        onPlace ? 'button' : 'div',
        { class: 'wx-place', onclick: onPlace, title: onPlace && 'Change location' },
        onPlace && '📍 ',
        place,
        offline && h('span', { class: 'wx-offline', title: 'Offline' }, ' ⚠'),
      ),
      h('div', { class: 'wx-cond' }, describe(cur.code)),
      today && h('div', { class: 'wx-hilo' }, `H ${deg(today.high)}  L ${deg(today.low)}`),
      pills(d, place, aq, placement !== 'small' && placement !== 'medium'),
    ),
    placement !== 'small' && h('div', { class: 'wx-map-hint', 'aria-hidden': 'true' }, '🗺️'),
  );

  const sections: (HTMLElement | null)[] = [now];

  if (spec.details) {
    const speed = d.units === 'imperial' ? 'mph' : 'km/h';
    const time = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', timeZone: tz });
    const item = (label: string, value: string) =>
      h('div', { class: 'wx-detail' }, h('span', { class: 'wx-detail-label' }, label), value);
    sections.push(
      h(
        'div',
        { class: 'wx-details' },
        item('Feels like', deg(cur.feelsLike)),
        item('Humidity', cur.humidity === null ? '–' : `${cur.humidity}%`),
        item('Wind', cur.wind === null ? '–' : `${cur.wind} ${speed} ${compass(cur.windDir)}`),
        today?.sunrise ? item('Sunrise', time.format(today.sunrise * 1000)) : null,
        today?.sunset ? item('Sunset', time.format(today.sunset * 1000)) : null,
        aq?.pm25 != null ? item('PM2.5', `${aq.pm25} µg/m³`) : null,
        aq?.uv != null ? item('UV index', String(aq.uv)) : null,
      ),
    );
  }

  if (spec.hours) {
    const hourFmt = new Intl.DateTimeFormat([], { hour: 'numeric', timeZone: tz });
    const nowSec = Date.now() / 1000;
    const hours = d.hourly.filter((x) => x.time + 3600 > nowSec).slice(0, spec.hours);
    sections.push(
      h(
        'div',
        { class: 'wx-hours' },
        ...hours.map((x, i) =>
          h(
            'div',
            { class: 'wx-hour' },
            h('div', { class: 'wx-small-label' }, i === 0 ? 'Now' : hourFmt.format(x.time * 1000)),
            h('div', { class: 'wx-small-icon' }, icon(x.code, x.isDay)),
            h('div', { class: 'wx-small-temp' }, deg(x.temp)),
            h('div', { class: 'wx-pop' }, chance(x.precipChance)),
          ),
        ),
      ),
    );
  }

  if (spec.days) {
    const dayFmt = new Intl.DateTimeFormat([], { weekday: 'short', timeZone: tz });
    // In the wide tile the current block already covers today.
    const days = d.daily.slice(placement === 'medium' ? 1 : 0, (placement === 'medium' ? 1 : 0) + spec.days);
    sections.push(
      h(
        'div',
        { class: 'wx-days' },
        ...days.map((x, i) =>
          h(
            'div',
            { class: 'wx-day' },
            h('div', { class: 'wx-small-label' }, i === 0 && placement !== 'medium' ? 'Today' : dayFmt.format(x.date * 1000)),
            h('div', { class: 'wx-small-icon' }, icon(x.code, true)),
            h(
              'div',
              { class: 'wx-small-temp' },
              deg(x.high),
              h('span', { class: 'wx-low' }, ` ${deg(x.low)}`),
            ),
            h('div', { class: 'wx-pop' }, chance(x.precipChance)),
          ),
        ),
      ),
    );
  }

  return h('div', { class: 'wx-body' }, ...sections);
}

/** "AQI 72 Moderate" and "UV 8 Very high today" side by side; each opens a detail sheet. */
function pills(d: Forecast, place: string, aq: AirQuality | null, large: boolean) {
  const uvMax = large ? d.daily[0]?.uvMax : null;
  if (!aq && uvMax == null) return null;
  const tap = (open: () => void) => (e: Event) => {
    e.stopPropagation(); // don't also open the forecast map
    open();
  };
  return h(
    'div',
    { class: 'wx-pills' },
    aq &&
      h(
        'button',
        { class: `wx-aqi ${aqiBand(aq.aqi!).cls}`, onclick: tap(() => openAirMap(place, d.location.lat, d.location.lon, aq)) },
        `AQI ${aq.aqi}`,
        large && aq.category && h('span', { class: 'wx-aqi-cat' }, ` ${aq.category}`),
      ),
    uvMax != null &&
      h(
        'button',
        { class: `wx-aqi wx-uv ${uvBand(uvMax).cls}`, onclick: tap(() => openUvGraph(place, validZone(d.timezone), d.uvToday ?? [])) },
        `UV ${Math.round(uvMax)}`,
        h('span', { class: 'wx-aqi-cat' }, ` ${uvBand(uvMax).name}`),
      ),
  );
}

/** Windy's free embeddable forecast map (no key), animated over the coming days. */
function windyUrl(d: Forecast, layer: MapLayer, zoom: number): string {
  const { lat, lon } = d.location;
  const imperial = d.units === 'imperial';
  const params = new URLSearchParams({
    type: 'map',
    location: 'coordinates',
    lat: String(lat),
    lon: String(lon),
    detailLat: String(lat),
    detailLon: String(lon),
    zoom: String(zoom),
    level: 'surface',
    overlay: layer,
    product: 'ecmwf',
    menu: '',
    message: 'true',
    marker: 'true',
    calendar: 'now',
    pressure: '',
    detail: '',
    metricWind: imperial ? 'mph' : 'km/h',
    metricTemp: imperial ? '°F' : '°C',
    radarRange: '-1',
  });
  return `https://embed.windy.com/embed2.html?${params}`;
}

function mapFrame(d: Forecast, config: WeatherConfig, layer: MapLayer, zoom: number) {
  const name = config.label.trim() || d.location.name;
  return h('iframe', {
    class: 'wx-map-frame',
    src: windyUrl(d, MAP_LAYERS.some((l) => l.value === layer) ? layer : 'rain', zoom),
    title: `Weather map for ${name}`,
  });
}

const UNLOCK_MS = 60_000;
/** A loaded map on a tile goes back to "tap to load" after this long, once it's locked again. */
const TILE_MAP_MS = 10 * 60_000;

/**
 * Live Windy maps animate nonstop, which is heavy for the Pi and makes swipes
 * stutter, so a map only loads when it's tapped. `loaded` skips the button
 * (switching layers on a map that's already showing). Tile maps (`unloadAfter`)
 * close again after a while, once they're locked and not in use.
 */
function tapToLoad(load: () => HTMLElement, { loaded = false, unloadAfter = 0 } = {}): HTMLElement {
  const wrap = h('div', { class: 'wx-map-live' });
  let timer = 0;
  const showButton = () =>
    wrap.replaceChildren(
      h(
        'button',
        {
          class: 'wx-map-load',
          onclick: (e: Event) => {
            e.stopPropagation();
            showMap();
          },
        },
        h('span', { class: 'wx-map-load-icon' }, '🗺️'),
        h('span', { class: 'wx-map-load-text' }, 'Tap to load live map'),
      ),
    );
  const showMap = () => {
    const map = load();
    wrap.replaceChildren(map);
    clearTimeout(timer);
    if (!unloadAfter) return;
    const check = () => {
      if (!wrap.isConnected || !wrap.contains(map)) return;
      if (map.classList.contains('locked')) showButton();
      else timer = window.setTimeout(check, 60_000);
    };
    timer = window.setTimeout(check, unloadAfter);
  };
  if (loaded) showMap();
  else showButton();
  return wrap;
}

/**
 * Covers a map on the dashboard so swipes still change pages. Double-tap to
 * pan and zoom it; it locks again after a minute or with the lock button.
 */
function lockedMap(frame: HTMLIFrameElement) {
  const hint = h('div', { class: 'wx-map-lock-hint' }, 'Double-tap to move the map');
  const cover = h('div', { class: 'wx-map-cover' }, hint);
  const lockBtn = h('button', { class: 'wx-map-lock-btn', title: 'Lock map' }, '🔒 Done');
  const wrap = h('div', { class: 'wx-map-wrap locked' }, frame, cover, lockBtn);
  let relock = 0;
  let keepAwake = 0;

  const lock = () => {
    wrap.classList.add('locked');
    clearTimeout(relock);
    clearInterval(keepAwake);
  };
  const unlock = () => {
    wrap.classList.remove('locked');
    relock = window.setTimeout(lock, UNLOCK_MS);
    // Touches inside the map don't reach the dashboard; this keeps pages from
    // rotating away while the map is in use.
    keepAwake = window.setInterval(() => {
      if (!wrap.isConnected) return lock();
      document.dispatchEvent(new PointerEvent('pointerdown'));
    }, 5000);
  };

  let lastTap: { t: number; x: number; y: number } | null = null;
  let start: { x: number; y: number } | null = null;
  cover.addEventListener('pointerdown', (e) => (start = { x: e.clientX, y: e.clientY }));
  cover.addEventListener('pointerup', (e) => {
    // Ignore swipes; only count taps that stay put.
    if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 12) return (lastTap = null);
    const now = Date.now();
    if (lastTap && now - lastTap.t < 400 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      lastTap = null;
      unlock();
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  });
  lockBtn.addEventListener('click', lock);
  return wrap;
}

/** Forecast on the left, map with layer buttons on the right. The map only reloads when the place or layer changes. */
function splitView(config: WeatherConfig) {
  const left = h('div', { class: 'wx-split-left size-tall' });
  const holder = h('div', { class: 'wx-map-holder' });
  let layer: MapLayer = MAP_LAYERS.some((l) => l.value === config.mapLayer) ? config.mapLayer : 'rain';
  let place: Forecast | null = null;
  let shownAt = '';
  const chips = MAP_LAYERS.map((l) =>
    h(
      'button',
      { class: 'chip wx-chip', title: l.name, onclick: () => show(l.value) },
      l.icon,
      h('span', { class: 'wx-chip-text' }, ` ${l.name}`),
    ),
  );
  const show = (next: MapLayer) => {
    layer = next;
    chips.forEach((c, i) => c.classList.toggle('active', MAP_LAYERS[i].value === layer));
    if (!place) return;
    shownAt = `${place.location.lat},${place.location.lon},${layer}`;
    const live = Boolean(holder.querySelector('iframe'));
    const at = place;
    holder.replaceChildren(tapToLoad(() => lockedMap(mapFrame(at, config, layer, 7)), { loaded: live, unloadAfter: TILE_MAP_MS }));
  };
  const el = h(
    'div',
    { class: 'wx-split' },
    left,
    h('div', { class: 'wx-split-right' }, h('div', { class: 'wx-map-layers' }, ...chips), holder),
  );
  return {
    el,
    left,
    setPlace(d: Forecast) {
      place = d;
      if (`${d.location.lat},${d.location.lon},${layer}` !== shownAt) show(layer);
    },
  };
}

function openMap(d: Forecast, config: WeatherConfig) {
  const holder = h('div', { class: 'wx-map-holder' });
  const chips = MAP_LAYERS.map((l) =>
    h('button', { class: 'chip', onclick: () => show(l.value) }, l.label),
  );
  const show = (layer: MapLayer) => {
    chips.forEach((c, i) => c.classList.toggle('active', MAP_LAYERS[i].value === layer));
    const live = Boolean(holder.querySelector('iframe'));
    holder.replaceChildren(tapToLoad(() => mapFrame(d, config, layer, 7), { loaded: live }));
  };
  const sheet = openSheet(`🗺️ ${config.label.trim() || d.location.name} forecast map`, [
    h('div', { class: 'wx-map-layers' }, ...chips),
    holder,
  ]);
  sheet.body.closest('.sheet')?.classList.add('wx-map-sheet');
  show(config.mapLayer);
}

function chance(p: number | null): string {
  return p && p >= 10 ? `💧${p}%` : '';
}

function compass(deg: number | null): string {
  if (deg === null) return '';
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

function validZone(zone: string): string | undefined {
  try {
    new Intl.DateTimeFormat([], { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** WMO weather interpretation codes, as used by Open-Meteo. */
function describe(code: number): string {
  if (code === 0) return 'Clear';
  if (code === 1) return 'Mostly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Cloudy';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 55) return 'Drizzle';
  if (code === 56 || code === 57) return 'Freezing drizzle';
  if (code === 61) return 'Light rain';
  if (code === 63) return 'Rain';
  if (code === 65) return 'Heavy rain';
  if (code === 66 || code === 67) return 'Freezing rain';
  if (code === 71) return 'Light snow';
  if (code === 73) return 'Snow';
  if (code === 75) return 'Heavy snow';
  if (code === 77) return 'Snow grains';
  if (code >= 80 && code <= 82) return code === 82 ? 'Heavy showers' : 'Showers';
  if (code === 85 || code === 86) return 'Snow showers';
  if (code === 95) return 'Thunderstorm';
  if (code === 96 || code === 99) return 'Thunderstorm, hail';
  return 'Unknown';
}

function icon(code: number, isDay: boolean): string {
  if (code === 0) return isDay ? '☀️' : '🌙';
  if (code === 1) return isDay ? '🌤️' : '🌙';
  if (code === 2) return isDay ? '⛅' : '☁️';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 51 && code <= 57) return '🌦️';
  if (code >= 61 && code <= 67) return '🌧️';
  if (code >= 71 && code <= 77) return '🌨️';
  if (code >= 80 && code <= 82) return isDay ? '🌦️' : '🌧️';
  if (code === 85 || code === 86) return '🌨️';
  if (code >= 95) return '⛈️';
  return '🌡️';
}
