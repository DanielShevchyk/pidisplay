// Weather proxy for the weather widget. Wraps Open-Meteo (free, no API key):
// resolves a place name to coordinates, fetches the forecast, and returns a
// small normalized payload. Results are cached in memory so any number of
// tiles and screens cost one upstream call per location every few minutes.

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const FORECAST_TTL = 10 * 60 * 1000;
const TIMEOUT = 10_000;
const AIR_MAP_TTL = 30 * 60 * 1000;
// Air quality map grid: points every 0.4° (about the model's resolution) around the center.
const AIR_MAP_STEP = 0.4;
const AIR_MAP_COLS = 13;
const AIR_MAP_ROWS = 9;

export const US_STATES = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado',
  ct: 'connecticut', de: 'delaware', dc: 'district of columbia', fl: 'florida', ga: 'georgia',
  hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas',
  ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland', ma: 'massachusetts',
  mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri', mt: 'montana',
  ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico',
  ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma',
  or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina',
  sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia',
  wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
};

const UNITS = {
  imperial: { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch' },
  metric: { temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm' },
};

export class WeatherError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createWeather({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const places = new Map(); // normalized query -> place
  const forecasts = new Map(); // "lat,lon,units" -> { at, data }
  const inflight = new Map();

  async function getJson(url) {
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT) });
    } catch (err) {
      throw new WeatherError(502, `Weather service unreachable (${err.message})`);
    }
    if (!res.ok) throw new WeatherError(502, `Weather service returned ${res.status}`);
    return res.json();
  }

  async function resolvePlace(query) {
    const coords = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (coords) {
      const lat = Number(coords[1]);
      const lon = Number(coords[2]);
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new WeatherError(400, 'Coordinates out of range');
      return { name: `${lat.toFixed(2)}, ${lon.toFixed(2)}`, region: '', country: '', lat, lon };
    }

    const key = query.trim().toLowerCase().replace(/\s+/g, ' ');
    if (places.has(key)) return places.get(key);

    // "Austin, TX" / "Paris, France": search the city, then use the rest to pick.
    const [city, ...qualifiers] = key.split(',').map((s) => s.trim()).filter(Boolean);
    if (!city) throw new WeatherError(400, 'Location is empty');
    const url = `${GEOCODE_URL}?${new URLSearchParams({ name: city, count: '10', language: 'en', format: 'json' })}`;
    const results = (await getJson(url)).results ?? [];
    const matches = (r) =>
      qualifiers.every((q) => {
        const region = (r.admin1 ?? '').toLowerCase();
        const country = (r.country ?? '').toLowerCase();
        return (
          region.startsWith(q) ||
          region === US_STATES[q] ||
          country.startsWith(q) ||
          (r.country_code ?? '').toLowerCase() === q ||
          (q === 'usa' && r.country_code === 'US') ||
          (q === 'uk' && r.country_code === 'GB')
        );
      });
    const hit = results.find(matches) ?? (qualifiers.length ? undefined : results[0]);
    if (!hit) throw new WeatherError(404, `Couldn't find "${query.trim()}"`);
    const place = {
      name: hit.name,
      region: hit.admin1 ?? '',
      country: hit.country ?? '',
      lat: hit.latitude,
      lon: hit.longitude,
    };
    places.set(key, place);
    return place;
  }

  async function fetchForecast(place, units) {
    const params = new URLSearchParams({
      latitude: String(place.lat),
      longitude: String(place.lon),
      current:
        'temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,wind_speed_10m,wind_direction_10m,precipitation',
      hourly: 'temperature_2m,weather_code,precipitation_probability,is_day,uv_index',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max',
      timezone: 'auto',
      timeformat: 'unixtime',
      forecast_days: '7',
      ...UNITS[units],
    });
    // Air quality is a separate Open-Meteo API; the forecast still shows if it fails.
    const airParams = new URLSearchParams({
      latitude: String(place.lat),
      longitude: String(place.lon),
      current: 'us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,uv_index',
      hourly: 'us_aqi',
      timezone: 'auto',
      timeformat: 'unixtime',
      forecast_days: '2',
    });
    const [raw, air] = await Promise.all([
      getJson(`${FORECAST_URL}?${params}`),
      getJson(`${AIR_URL}?${airParams}`).catch(() => null),
    ]);
    return { ...normalize(raw, place, units), airQuality: air ? normalizeAir(air) : null };
  }

  /** Returns the forecast for a place name or "lat,lon", in 'imperial' or 'metric'. */
  async function get(query, units = 'imperial') {
    if (typeof query !== 'string' || !query.trim()) throw new WeatherError(400, 'location is required');
    if (query.length > 120) throw new WeatherError(400, 'location is too long');
    if (!UNITS[units]) throw new WeatherError(400, 'units must be imperial or metric');

    const place = await resolvePlace(query);
    const key = `${place.lat},${place.lon},${units}`;
    const cached = forecasts.get(key);
    if (cached && now() - cached.at < FORECAST_TTL) return cached.data;

    if (!inflight.has(key)) {
      inflight.set(
        key,
        fetchForecast(place, units)
          .then((data) => {
            forecasts.set(key, { at: now(), data });
            return data;
          })
          .finally(() => inflight.delete(key)),
      );
    }
    try {
      return await inflight.get(key);
    } catch (err) {
      // Keep showing the last good forecast through a network blip.
      if (cached) return { ...cached.data, stale: true };
      throw err;
    }
  }

  const airMaps = new Map(); // "lat,lon" -> { at, data }

  /** Current US AQI on a grid of points around lat/lon, for the air quality map. */
  async function airMap(latIn, lonIn) {
    const lat = Number(latIn);
    const lon = Number(lonIn);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
      throw new WeatherError(400, 'lat and lon are required');
    }
    // Snap to the grid so nearby tiles share one upstream call.
    const cLat = Math.round(lat / AIR_MAP_STEP) * AIR_MAP_STEP;
    const cLon = Math.round(lon / AIR_MAP_STEP) * AIR_MAP_STEP;
    const key = `${cLat.toFixed(1)},${cLon.toFixed(1)}`;
    const cached = airMaps.get(key);
    if (cached && now() - cached.at < AIR_MAP_TTL) return cached.data;

    const lats = [];
    const lons = [];
    for (let r = 0; r < AIR_MAP_ROWS; r++) {
      for (let c = 0; c < AIR_MAP_COLS; c++) {
        lats.push((cLat + (r - (AIR_MAP_ROWS - 1) / 2) * AIR_MAP_STEP).toFixed(2));
        lons.push((cLon + (c - (AIR_MAP_COLS - 1) / 2) * AIR_MAP_STEP).toFixed(2));
      }
    }
    const params = new URLSearchParams({ latitude: lats.join(','), longitude: lons.join(','), current: 'us_aqi', timeformat: 'unixtime' });
    try {
      const raw = await getJson(`${AIR_URL}?${params}`);
      const list = Array.isArray(raw) ? raw : [raw];
      const points = lats.map((la, i) => {
        const aqi = list[i]?.current?.us_aqi;
        return { lat: Number(la), lon: Number(lons[i]), aqi: typeof aqi === 'number' ? Math.round(aqi) : null };
      });
      const data = { step: AIR_MAP_STEP, updated: list[0]?.current?.time ?? Math.floor(now() / 1000), points };
      airMaps.set(key, { at: now(), data });
      return data;
    } catch (err) {
      if (cached) return { ...cached.data, stale: true };
      throw err;
    }
  }

  return { get, airMap };
}

function normalize(raw, place, units) {
  const c = raw.current ?? {};
  const hourly = raw.hourly ?? {};
  const daily = raw.daily ?? {};
  const nowSec = c.time ?? Math.floor(Date.now() / 1000);
  const round = (n) => (typeof n === 'number' ? Math.round(n) : null);

  // Hourly starts at local midnight; keep the current hour onward.
  const hours = [];
  for (let i = 0; i < (hourly.time ?? []).length && hours.length < 24; i++) {
    if (hourly.time[i] + 3600 <= nowSec) continue;
    hours.push({
      time: hourly.time[i],
      temp: round(hourly.temperature_2m?.[i]),
      code: hourly.weather_code?.[i] ?? 0,
      isDay: hourly.is_day?.[i] !== 0,
      precipChance: hourly.precipitation_probability?.[i] ?? null,
    });
  }

  const days = (daily.time ?? []).map((t, i) => ({
    date: t,
    high: round(daily.temperature_2m_max?.[i]),
    low: round(daily.temperature_2m_min?.[i]),
    code: daily.weather_code?.[i] ?? 0,
    precipChance: daily.precipitation_probability_max?.[i] ?? null,
    sunrise: daily.sunrise?.[i] ?? null,
    sunset: daily.sunset?.[i] ?? null,
    uvMax: typeof daily.uv_index_max?.[i] === 'number' ? Math.round(daily.uv_index_max[i] * 10) / 10 : null,
  }));

  return {
    location: place,
    units,
    timezone: raw.timezone ?? 'UTC',
    updated: nowSec,
    current: {
      temp: round(c.temperature_2m),
      feelsLike: round(c.apparent_temperature),
      humidity: c.relative_humidity_2m ?? null,
      wind: round(c.wind_speed_10m),
      windDir: c.wind_direction_10m ?? null,
      precip: c.precipitation ?? 0,
      code: c.weather_code ?? 0,
      isDay: c.is_day !== 0,
    },
    hourly: hours,
    daily: days,
    // Today's UV by hour from local midnight, for the UV graph.
    uvToday: (hourly.time ?? []).slice(0, 24).map((t, i) => ({
      time: t,
      uv: typeof hourly.uv_index?.[i] === 'number' ? Math.round(hourly.uv_index[i] * 10) / 10 : null,
    })),
  };
}

/** US AQI bands (EPA). */
const AQI_BANDS = [
  [50, 'Good'],
  [100, 'Moderate'],
  [150, 'Unhealthy for sensitive groups'],
  [200, 'Unhealthy'],
  [300, 'Very unhealthy'],
  [Infinity, 'Hazardous'],
];

export function aqiCategory(aqi) {
  if (typeof aqi !== 'number') return null;
  return AQI_BANDS.find(([max]) => aqi <= max)[1];
}

function normalizeAir(raw) {
  const c = raw.current ?? {};
  const round = (n) => (typeof n === 'number' ? Math.round(n) : null);
  const aqi = round(c.us_aqi);
  const nowSec = c.time ?? Math.floor(Date.now() / 1000);
  const hours = [];
  const h = raw.hourly ?? {};
  for (let i = 0; i < (h.time ?? []).length && hours.length < 24; i++) {
    if (h.time[i] + 3600 <= nowSec) continue;
    hours.push({ time: h.time[i], aqi: round(h.us_aqi?.[i]) });
  }
  return {
    aqi,
    category: aqiCategory(aqi),
    pm25: round(c.pm2_5),
    pm10: round(c.pm10),
    ozone: round(c.ozone),
    no2: round(c.nitrogen_dioxide),
    uv: typeof c.uv_index === 'number' ? Math.round(c.uv_index * 10) / 10 : null,
    hourly: hours,
  };
}
