import { h } from '../../core/dom';
import { defineWidget, type Placement } from '../../core/types';
import './weather.css';

interface WeatherConfig {
  /** City ("Austin, TX", "Paris, France") or "lat,lon". */
  location: string;
  units: 'imperial' | 'metric';
  /** Shown instead of the resolved place name when set. */
  label: string;
  [key: string]: unknown;
}

/** Mirrors the payload from GET /api/weather (server/weather.js). */
interface Forecast {
  location: { name: string; region: string; country: string; lat: number; lon: number };
  units: 'imperial' | 'metric';
  timezone: string;
  updated: number;
  stale?: boolean;
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
  }[];
}

interface SharedDefault {
  location: string;
}

interface Cached {
  query: string;
  data: Forecast;
}

const REFRESH_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;

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
  description: 'Current conditions and forecast for any city',
  icon: '⛅',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'large',
  supportsBar: true,
  defaultConfig: { location: '', units: 'imperial', label: '' },
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
  ],

  mount(el, { config, placement, storage, sharedStorage }) {
    const root = h('div', { class: `wx size-${placement}` });
    el.append(root);
    const own = config.location.trim();
    let location = '';
    let data: Forecast | null = null;
    let failed = '';
    let timer = 0;
    let alive = true;
    const queryFor = (loc: string) => `${loc}|${config.units}`;

    const paint = () => {
      if (!location) {
        root.replaceChildren(message('⛅', placement === 'bar' ? '' : 'Set a location in ⚙ settings'));
        return;
      }
      root.replaceChildren(
        data ? render(data, config, placement, Boolean(failed)) : failed ? message('⚠️', failed) : message('', 'Loading…'),
      );
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
        .then((d) => alive && !own && use(d?.location ?? ''))
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
        const loc = own || shared?.location || '';
        if (loc && cached?.query === queryFor(loc)) data = cached.data;
        location = loc;
        paint();
        refresh();
      });

    const unsubscribe = own ? () => {} : sharedStorage.onChange(followShared);

    return {
      destroy() {
        alive = false;
        clearTimeout(timer);
        unsubscribe();
      },
    };
  },
});

function message(icon: string, text: string) {
  return h('div', { class: 'wx-message' }, icon && h('div', { class: 'wx-message-icon' }, icon), text);
}

function render(d: Forecast, config: WeatherConfig, placement: Placement, offline: boolean) {
  const tz = validZone(d.timezone);
  const deg = (n: number | null) => (n === null ? '–' : `${n}°`);
  const today = d.daily[0];
  const place = config.label.trim() || d.location.name;
  const cur = d.current;

  if (placement === 'bar') {
    return h(
      'div',
      { class: 'wx-bar' },
      h('span', { class: 'wx-bar-icon' }, icon(cur.code, cur.isDay)),
      h('span', { class: 'wx-bar-temp' }, deg(cur.temp)),
    );
  }

  const spec = LAYOUT[placement];
  const now = h(
    'div',
    { class: 'wx-now' },
    h('div', { class: 'wx-now-icon' }, icon(cur.code, cur.isDay)),
    h('div', { class: 'wx-now-temp' }, deg(cur.temp)),
    h(
      'div',
      { class: 'wx-now-text' },
      h('div', { class: 'wx-place' }, place, offline && h('span', { class: 'wx-offline', title: 'Offline' }, ' ⚠')),
      h('div', { class: 'wx-cond' }, describe(cur.code)),
      today && h('div', { class: 'wx-hilo' }, `H ${deg(today.high)}  L ${deg(today.low)}`),
    ),
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
