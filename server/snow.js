// Snow report for the snow widget: forecast and recent snowfall at Sierra Nevada ski
// resorts, from keyless public sources:
//   - Open-Meteo forecast at each resort's summit and base elevation (snowfall past and
//     next days, temperatures, conditions),
//   - NRCS SNOTEL, the nearest automatic snow station (measured snow depth),
//   - Liftie (liftie.info), open lifts as the resort reports them,
//   - National Weather Service active alerts (winter storm warnings and the like).
// Every source is optional: a resort still shows what the others returned. Results are
// cached in memory so any number of tiles cost one upstream call per resort per source.

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const SNOTEL_URL = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data';
const LIFTIE_URL = 'https://liftie.info/api/resort';
const NWS_URL = 'https://api.weather.gov/alerts/active';
const TIMEZONE = 'America/Los_Angeles';
const FORECAST_TTL = 30 * 60 * 1000;
const SNOTEL_TTL = 60 * 60 * 1000;
const LIFTS_TTL = 10 * 60 * 1000;
const ALERTS_TTL = 10 * 60 * 1000;
/** After a failure, wait this long before asking that source again. */
const RETRY_MS = 5 * 60 * 1000;
const TIMEOUT = 12_000;
const MAX_RESORTS = 12;
const FORECAST_DAYS = 10;
const FT = 0.3048;

/**
 * Sierra Nevada resorts. Elevations in feet. snotel is the nearest SNOTEL station (triplet,
 * name, elevation ft, miles away); liftie lists ids to try on liftie.info, first match wins.
 */
export const RESORTS = {
  heavenly: { name: 'Heavenly', area: 'South Lake Tahoe', lat: 38.935, lon: -119.94, base: 6540, summit: 10067,
    snotel: ['518:CA:SNTL', 'Heavenly Valley', 8540, 1], liftie: ['heavenly'] },
  northstar: { name: 'Northstar', area: 'Truckee', lat: 39.274, lon: -120.121, base: 6330, summit: 8610,
    snotel: ['834:CA:SNTL', 'Truckee #2', 6500, 4], liftie: ['northstar'] },
  kirkwood: { name: 'Kirkwood', area: 'Carson Pass', lat: 38.684, lon: -120.065, base: 7800, summit: 9876,
    snotel: ['1067:CA:SNTL', 'Carson Pass', 8360, 4], liftie: ['kirkwood'] },
  palisades: { name: 'Palisades Tahoe', area: 'Olympic Valley', lat: 39.197, lon: -120.235, base: 6200, summit: 9050,
    snotel: ['784:CA:SNTL', 'Palisades Tahoe', 8010, 2], liftie: ['palisades-tahoe', 'palisades', 'squaw'] },
  alpine: { name: 'Alpine Meadows', area: 'Palisades Tahoe', lat: 39.164, lon: -120.238, base: 6835, summit: 8637,
    snotel: ['848:CA:SNTL', 'Ward Creek #3', 6750, 3], liftie: ['alpine-meadows', 'alpine'] },
  sugarbowl: { name: 'Sugar Bowl', area: 'Donner Summit', lat: 39.304, lon: -120.335, base: 6883, summit: 8383,
    snotel: ['428:CA:SNTL', 'Central Sierra Snow Lab', 6890, 2], liftie: ['sugar-bowl', 'sugarbowl'] },
  boreal: { name: 'Boreal', area: 'Donner Summit', lat: 39.336, lon: -120.35, base: 7200, summit: 7700,
    snotel: ['428:CA:SNTL', 'Central Sierra Snow Lab', 6890, 1], liftie: ['boreal'] },
  sodasprings: { name: 'Soda Springs', area: 'Donner Summit', lat: 39.32, lon: -120.379, base: 6700, summit: 7352,
    snotel: ['428:CA:SNTL', 'Central Sierra Snow Lab', 6890, 1], liftie: ['soda-springs'] },
  donnerski: { name: 'Donner Ski Ranch', area: 'Donner Summit', lat: 39.318, lon: -120.33, base: 7031, summit: 7781,
    snotel: ['428:CA:SNTL', 'Central Sierra Snow Lab', 6890, 2], liftie: ['donner-ski-ranch'] },
  tahoedonner: { name: 'Tahoe Donner', area: 'Truckee', lat: 39.355, lon: -120.268, base: 6750, summit: 7350,
    snotel: ['834:CA:SNTL', 'Truckee #2', 6500, 6], liftie: ['tahoe-donner'] },
  homewood: { name: 'Homewood', area: 'West Shore', lat: 39.085, lon: -120.16, base: 6230, summit: 7880,
    snotel: ['848:CA:SNTL', 'Ward Creek #3', 6750, 5], liftie: ['homewood'] },
  sierra: { name: 'Sierra-at-Tahoe', area: 'Echo Summit', lat: 38.8, lon: -120.08, base: 6640, summit: 8852,
    snotel: ['463:CA:SNTL', 'Echo Peak', 7650, 3], liftie: ['sierra-at-tahoe', 'sierra'] },
  mtrose: { name: 'Mt. Rose', area: 'Reno', lat: 39.315, lon: -119.885, base: 7900, summit: 9700,
    snotel: ['652:NV:SNTL', 'Mt Rose Ski Area', 8810, 1], liftie: ['mt-rose', 'mtrose'] },
  diamondpeak: { name: 'Diamond Peak', area: 'Incline Village', lat: 39.254, lon: -119.92, base: 6700, summit: 8540,
    snotel: ['1242:NV:SNTL', 'Little Valley', 6500, 3], liftie: ['diamond-peak'] },
  bearvalley: { name: 'Bear Valley', area: 'Ebbetts Pass', lat: 38.468, lon: -120.04, base: 6600, summit: 8500,
    snotel: null, liftie: ['bear-valley'] },
  dodgeridge: { name: 'Dodge Ridge', area: 'Pinecrest', lat: 38.19, lon: -119.955, base: 6600, summit: 8200,
    snotel: null, liftie: ['dodge-ridge'] },
  mammoth: { name: 'Mammoth Mountain', area: 'Mammoth Lakes', lat: 37.651, lon: -119.027, base: 7953, summit: 11053,
    snotel: null, liftie: ['mammoth-mountain', 'mammoth'] },
  june: { name: 'June Mountain', area: 'June Lake', lat: 37.768, lon: -119.09, base: 7545, summit: 10090,
    snotel: null, liftie: ['june-mountain', 'june'] },
  chinapeak: { name: 'China Peak', area: 'Huntington Lake', lat: 37.236, lon: -119.157, base: 7030, summit: 8709,
    snotel: null, liftie: ['china-peak'] },
};

export const DEFAULT_RESORTS = ['heavenly', 'northstar', 'kirkwood'];

export class SnowError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const sum = (xs) => xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

/** Calendar date (YYYY-MM-DD) in the Sierra's time zone. */
export function localDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

/** "YYYY-MM-DDTHH" of the current hour in the Sierra's time zone, matching Open-Meteo's hourly times. */
function localHour(ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
}

/**
 * Summarizes Open-Meteo's two-location answer ([summit, base]) into what the widget shows.
 * Hourly snowfall is summed around the current hour for "last 24h" and "next 72h".
 */
export function summarizeForecast([top, base], nowMs) {
  const hours = top?.hourly?.time ?? [];
  const snowTop = top?.hourly?.snowfall ?? [];
  const snowBase = base?.hourly?.snowfall ?? [];
  const nowKey = localHour(nowMs);
  let i = hours.findIndex((t) => t.startsWith(nowKey));
  if (i < 0) i = Math.min(hours.length, Math.max(0, hours.findIndex((t) => t > nowKey)));
  const past = (arr, n) => round1(sum(arr.slice(Math.max(0, i - n + 1), i + 1)));
  const next = (arr, n) => round1(sum(arr.slice(i + 1, i + 1 + n)));

  const today = localDate(nowMs);
  const d = top?.daily ?? {};
  const db = base?.daily ?? {};
  const days = [];
  (d.time ?? []).forEach((date, k) => {
    if (date < today) return;
    days.push({
      date,
      snowTop: round1(d.snowfall_sum?.[k]),
      snowBase: round1(db.snowfall_sum?.[k]),
      rainBase: round1(db.rain_sum?.[k]),
      hi: round1(d.temperature_2m_max?.[k]),
      lo: round1(d.temperature_2m_min?.[k]),
      code: d.weather_code?.[k] ?? null,
      pop: d.precipitation_probability_max?.[k] ?? null,
      wind: round1(d.wind_gusts_10m_max?.[k]),
    });
  });
  const pastDays = (d.time ?? [])
    .map((date, k) => ({ date, snowTop: round1(d.snowfall_sum?.[k]) }))
    .filter((x) => x.date < today)
    .slice(-7);
  const c = top?.current ?? {};
  return {
    now: {
      temp: round1(c.temperature_2m),
      baseTemp: round1(base?.current?.temperature_2m),
      code: c.weather_code ?? null,
      wind: round1(c.wind_speed_10m),
      gust: round1(c.wind_gusts_10m),
      snowing: Number(c.snowfall) > 0,
    },
    past24: past(snowTop, 24),
    past72: past(snowTop, 72),
    past7d: round1(sum(pastDays.map((x) => x.snowTop))),
    next24: next(snowTop, 24),
    next72: next(snowTop, 72),
    next24Base: next(snowBase, 24),
    next72Base: next(snowBase, 72),
    next7d: round1(sum(days.slice(0, 7).map((x) => x.snowTop))),
    next7dBase: round1(sum(days.slice(0, 7).map((x) => x.snowBase))),
    days: days.slice(0, FORECAST_DAYS),
    pastDays,
  };
}

/** SNOTEL /data answer -> { triplet: { depth, change24, change7, swe, date } } (inches). */
export function parseSnotel(json) {
  const out = {};
  for (const station of Array.isArray(json) ? json : []) {
    const series = {};
    for (const d of station?.data ?? []) {
      const code = d?.stationElement?.elementCode;
      if (code) series[code] = (d.values ?? []).filter((v) => Number.isFinite(v?.value));
    }
    const depth = series.SNWD ?? [];
    const swe = series.WTEQ ?? [];
    if (!depth.length && !swe.length) continue;
    const last = depth.at(-1);
    const back = (n) => {
      if (!last) return null;
      const target = new Date(Date.parse(last.date) - n * 86400000).toISOString().slice(0, 10);
      const then = depth.find((v) => v.date === target);
      return then ? last.value - then.value : null;
    };
    out[station.stationTriplet] = {
      depth: last?.value ?? null,
      change24: back(1),
      change7: back(7),
      swe: swe.at(-1)?.value ?? null,
      date: last?.date ?? swe.at(-1)?.date ?? null,
    };
  }
  return out;
}

/** Liftie answer -> { open, hold, scheduled, closed, total } or null when it has no lifts. */
export function parseLifts(json) {
  const status = json?.lifts?.status;
  if (!status || typeof status !== 'object' || !Object.keys(status).length) return null;
  const counts = { open: 0, hold: 0, scheduled: 0, closed: 0 };
  for (const s of Object.values(status)) if (s in counts) counts[s]++;
  else counts.closed++;
  return { ...counts, total: Object.keys(status).length };
}

/** NWS GeoJSON -> [{ event, headline, severity, ends, description }]. */
export function parseAlerts(json) {
  const seen = new Set();
  const out = [];
  for (const f of json?.features ?? []) {
    const p = f?.properties ?? {};
    if (!p.event || seen.has(p.event)) continue;
    seen.add(p.event);
    out.push({
      event: String(p.event),
      headline: String(p.headline ?? ''),
      severity: String(p.severity ?? ''),
      ends: p.ends ?? p.expires ?? null,
      description: String(p.description ?? '').slice(0, 2000),
    });
  }
  return out;
}

export function createSnow({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const cache = new Map(); // key -> { at, value, failedAt? }
  const inflight = new Map();
  const liftieIds = new Map(); // resort -> working liftie id

  async function getJson(url, what, headers = {}) {
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT), headers });
    } catch (err) {
      throw new SnowError(502, `${what} unreachable (${err.message})`);
    }
    if (!res.ok) throw new SnowError(res.status === 404 ? 404 : 502, `${what} returned ${res.status}`);
    return res.json();
  }

  /**
   * Cached call: fresh within ttl; after a failure, the last good value (stale) and no
   * retry for RETRY_MS so a dead source doesn't slow every request.
   */
  async function cached(key, ttl, load) {
    const hit = cache.get(key);
    const t = now();
    if (hit && 'value' in hit && t - hit.at < ttl) return { value: hit.value, at: hit.at };
    if (hit?.failedAt && t - hit.failedAt < RETRY_MS) {
      if ('value' in hit) return { value: hit.value, at: hit.at, stale: true };
      throw hit.error;
    }
    if (!inflight.has(key)) {
      inflight.set(
        key,
        load()
          .then((value) => cache.set(key, { at: now(), value }))
          .catch((error) => {
            cache.set(key, { ...cache.get(key), failedAt: now(), error });
            throw error;
          })
          .finally(() => inflight.delete(key)),
      );
    }
    try {
      await inflight.get(key);
      const fresh = cache.get(key);
      return { value: fresh.value, at: fresh.at };
    } catch (err) {
      const old = cache.get(key);
      if (old && 'value' in old) return { value: old.value, at: old.at, stale: true };
      throw err;
    }
  }

  function forecast(id, units) {
    const r = RESORTS[id];
    const metric = units === 'metric';
    const params = new URLSearchParams({
      latitude: `${r.lat},${r.lat}`,
      longitude: `${r.lon},${r.lon}`,
      elevation: `${Math.round(r.summit * FT)},${Math.round(r.base * FT)}`,
      current: 'temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m,snowfall',
      hourly: 'snowfall',
      daily: 'snowfall_sum,rain_sum,temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,wind_gusts_10m_max',
      past_days: '7',
      forecast_days: String(FORECAST_DAYS),
      timezone: TIMEZONE,
      temperature_unit: metric ? 'celsius' : 'fahrenheit',
      wind_speed_unit: metric ? 'kmh' : 'mph',
      precipitation_unit: metric ? 'mm' : 'inch',
    });
    return cached(`forecast:${id}:${units}`, FORECAST_TTL, async () => {
      const json = await getJson(`${FORECAST_URL}?${params}`, 'Forecast service');
      const pair = Array.isArray(json) ? json : [json];
      if (!pair[0]?.daily) throw new SnowError(502, 'Forecast service sent no data');
      // Open-Meteo reports snowfall in cm when precipitation is in mm.
      return summarizeForecast(pair, now());
    });
  }

  function snotel(triplets) {
    const list = [...new Set(triplets)].sort();
    if (!list.length) return Promise.resolve({ value: {} });
    const end = localDate(now());
    const begin = localDate(now() - 9 * 86400000);
    const params = new URLSearchParams({
      stationTriplets: list.join(','),
      elements: 'SNWD,WTEQ',
      duration: 'DAILY',
      beginDate: begin,
      endDate: end,
    });
    return cached(`snotel:${list.join(',')}`, SNOTEL_TTL, async () =>
      parseSnotel(await getJson(`${SNOTEL_URL}?${params}`, 'SNOTEL')),
    );
  }

  function lifts(id) {
    return cached(`lifts:${id}`, LIFTS_TTL, async () => {
      const known = liftieIds.get(id);
      for (const lid of known ? [known] : RESORTS[id].liftie) {
        try {
          const parsed = parseLifts(await getJson(`${LIFTIE_URL}/${encodeURIComponent(lid)}`, 'Liftie'));
          if (parsed) {
            liftieIds.set(id, lid);
            return parsed;
          }
        } catch (err) {
          if (err.status !== 404) throw err;
        }
      }
      return null;
    });
  }

  function alerts(id) {
    const r = RESORTS[id];
    return cached(`alerts:${id}`, ALERTS_TTL, async () =>
      parseAlerts(
        await getJson(`${NWS_URL}?point=${r.lat},${r.lon}`, 'Weather Service alerts', {
          'User-Agent': '(PiDisplay home dashboard, github.com/DanielShevchyk/pidisplay)',
          Accept: 'application/geo+json',
        }),
      ),
    );
  }

  const settle = (p) => p.then((r) => r, (error) => ({ error }));

  /** The catalog for the resort picker. */
  function catalog() {
    return Object.entries(RESORTS).map(([id, r]) => ({ id, name: r.name, area: r.area }));
  }

  async function get({ resorts = DEFAULT_RESORTS.join(','), units = 'imperial' } = {}) {
    if (units !== 'imperial' && units !== 'metric') throw new SnowError(400, 'units must be imperial or metric');
    const ids = [...new Set(String(resorts).split(',').map((s) => s.trim()).filter(Boolean))];
    if (ids.length > MAX_RESORTS) throw new SnowError(400, `At most ${MAX_RESORTS} resorts`);
    const unknown = ids.filter((id) => !RESORTS[id]);
    if (unknown.length) throw new SnowError(400, `Unknown resort: ${unknown.join(', ')}`);
    const metric = units === 'metric';
    const elev = (ft) => (metric ? Math.round(ft * FT) : ft);
    const depth = (inches) => (inches == null ? null : metric ? Math.round(inches * 2.54) : inches);

    const stations = settle(snotel(ids.map((id) => RESORTS[id].snotel?.[0]).filter(Boolean)));
    const rows = await Promise.all(
      ids.map(async (id) => {
        const r = RESORTS[id];
        const [f, l, a, s] = await Promise.all([settle(forecast(id, units)), settle(lifts(id)), settle(alerts(id)), stations]);
        const obs = r.snotel && s.value?.[r.snotel[0]];
        return {
          id,
          name: r.name,
          area: r.area,
          base: elev(r.base),
          summit: elev(r.summit),
          ...(f.value ?? {}),
          forecastError: f.error ? f.error.message : undefined,
          stale: f.stale || undefined,
          station: obs
            ? {
                name: r.snotel[1],
                elevation: elev(r.snotel[2]),
                distance: metric ? Math.round(r.snotel[3] * 1.609) : r.snotel[3],
                depth: depth(obs.depth),
                change24: depth(obs.change24),
                change7: depth(obs.change7),
                swe: depth(obs.swe),
                date: obs.date,
              }
            : null,
          lifts: l.value ?? null,
          alerts: a.value ?? [],
        };
      }),
    );
    return { units, updated: now(), resorts: rows };
  }

  return { get, catalog };
}
