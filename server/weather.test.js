import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aqiCategory, createWeather } from './weather.js';

const NOW = 1_790_000_000; // a fixed unix time
const HOUR = 3600;

const geocode = {
  results: [
    { name: 'Springfield', latitude: 39.8, longitude: -89.64, country: 'United States', country_code: 'US', admin1: 'Illinois' },
    { name: 'Springfield', latitude: 37.2, longitude: -93.29, country: 'United States', country_code: 'US', admin1: 'Missouri' },
  ],
};

function forecast() {
  const midnight = NOW - 5 * HOUR;
  return {
    timezone: 'America/Chicago',
    current: {
      time: NOW, temperature_2m: 71.6, apparent_temperature: 70.2, relative_humidity_2m: 40,
      is_day: 1, weather_code: 2, wind_speed_10m: 8.4, wind_direction_10m: 200, precipitation: 0,
    },
    hourly: {
      time: Array.from({ length: 48 }, (_, i) => midnight + i * HOUR),
      temperature_2m: Array.from({ length: 48 }, (_, i) => 60 + i),
      weather_code: Array(48).fill(3),
      precipitation_probability: Array(48).fill(10),
      is_day: Array(48).fill(1),
      uv_index: Array.from({ length: 48 }, (_, i) => (i % 24 >= 7 && i % 24 <= 18 ? 4.26 : 0)),
    },
    daily: {
      time: Array.from({ length: 7 }, (_, i) => midnight + i * 24 * HOUR),
      weather_code: Array(7).fill(61),
      temperature_2m_max: Array(7).fill(75.4),
      temperature_2m_min: Array(7).fill(55.5),
      precipitation_probability_max: Array(7).fill(60),
      sunrise: Array(7).fill(NOW - 2 * HOUR),
      sunset: Array(7).fill(NOW + 10 * HOUR),
      uv_index_max: Array(7).fill(7.84),
    },
  };
}

const air = {
  current: { time: NOW, us_aqi: 72.4, pm2_5: 18.2, pm10: 25.9, ozone: 80, nitrogen_dioxide: 9.6, uv_index: 5.25 },
  hourly: {
    time: Array.from({ length: 48 }, (_, i) => NOW - 5 * HOUR + i * HOUR),
    us_aqi: Array.from({ length: 48 }, (_, i) => 40 + i),
  },
};

let alertsBody = { features: [] };

function mockFetch({ airDown = false } = {}) {
  const calls = [];
  const airCalls = [];
  const alertCalls = [];
  const pastCalls = [];
  const fn = async (url) => {
    if (String(url).includes('air-quality')) {
      airCalls.push(String(url));
      if (airDown) throw new Error('offline');
      return { ok: true, status: 200, json: async () => air };
    }
    if (String(url).includes('api.weather.gov')) {
      alertCalls.push(String(url));
      return { ok: true, status: 200, json: async () => alertsBody };
    }
    if (String(url).includes('past_days=1')) {
      pastCalls.push(String(url));
      const y = NOW - 29 * HOUR;
      return { ok: true, status: 200, json: async () => ({ daily: { time: [y, y + 24 * HOUR], temperature_2m_max: [70.4, 75], temperature_2m_min: [50.2, 55] } }) };
    }
    calls.push(String(url));
    const body = String(url).includes('geocoding') ? geocode : forecast();
    return { ok: true, status: 200, json: async () => body };
  };
  fn.calls = calls;
  fn.airCalls = airCalls;
  fn.alertCalls = alertCalls;
  fn.pastCalls = pastCalls;
  return fn;
}

test('resolves "City, ST" with the state and normalizes the forecast', async () => {
  const fetchImpl = mockFetch();
  const w = createWeather({ fetchImpl });
  const data = await w.get('Springfield, MO', 'imperial');
  assert.equal(data.location.region, 'Missouri');
  assert.equal(data.current.temp, 72);
  assert.equal(data.hourly.length, 24);
  assert.equal(data.hourly[0].time, NOW); // starts at the current hour
  assert.equal(data.daily.length, 7);
  assert.equal(data.daily[0].high, 75);
  assert.equal(data.daily[0].uvMax, 7.8);
  assert.equal(data.uvToday.length, 24);
  assert.equal(data.uvToday[0].time, NOW - 5 * HOUR); // from local midnight
  assert.equal(data.uvToday[12].uv, 4.3);
  assert.match(fetchImpl.calls[1], /latitude=37\.2/);
  assert.match(fetchImpl.calls[1], /temperature_unit=fahrenheit/);
});

test('caches places and forecasts', async () => {
  const fetchImpl = mockFetch();
  const w = createWeather({ fetchImpl });
  await w.get('Springfield', 'imperial');
  await w.get('  springfield ', 'imperial');
  assert.equal(fetchImpl.calls.length, 2);
  await w.get('Springfield', 'metric');
  assert.equal(fetchImpl.calls.length, 3);
  assert.match(fetchImpl.calls[2], /temperature_unit=celsius/);
});

test('accepts lat,lon without geocoding', async () => {
  const fetchImpl = mockFetch();
  const data = await createWeather({ fetchImpl }).get('40.71, -74.01');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(data.location.lat, 40.71);
});

test('reports unknown places and bad input', async () => {
  const w = createWeather({ fetchImpl: mockFetch() });
  await assert.rejects(w.get('Springfield, Atlantis'), { status: 404 });
  await assert.rejects(w.get(''), { status: 400 });
  await assert.rejects(w.get('Springfield', 'kelvin'), { status: 400 });
  await assert.rejects(w.get('95, 200'), { status: 400 });
});

test('serves the last forecast when the service goes down', async () => {
  let t = 0;
  let down = false;
  const ok = mockFetch();
  const fetchImpl = async (url) => {
    if (down) throw new Error('offline');
    return ok(url);
  };
  const w = createWeather({ fetchImpl, now: () => t });
  await w.get('Springfield');
  down = true;
  t += 60 * 60 * 1000;
  const data = await w.get('Springfield');
  assert.equal(data.stale, true);
  assert.equal(data.current.temp, 72);
  await assert.rejects(createWeather({ fetchImpl }).get('Springfield'), { status: 502 });
});

test('adds US AQI air quality from the same coordinates', async () => {
  const fetchImpl = mockFetch();
  const data = await createWeather({ fetchImpl }).get('Springfield, MO');
  assert.match(fetchImpl.airCalls[0], /latitude=37\.2/);
  assert.deepEqual(
    { aqi: data.airQuality.aqi, category: data.airQuality.category, pm25: data.airQuality.pm25, uv: data.airQuality.uv },
    { aqi: 72, category: 'Moderate', pm25: 18, uv: 5.3 },
  );
  assert.equal(data.airQuality.hourly[0].time, NOW);
  assert.equal(data.airQuality.hourly.length, 24);
});

test('still returns the forecast when air quality is unavailable', async () => {
  const data = await createWeather({ fetchImpl: mockFetch({ airDown: true }) }).get('Springfield');
  assert.equal(data.airQuality, null);
  assert.equal(data.current.temp, 72);
});

test('maps AQI values to EPA categories', () => {
  assert.equal(aqiCategory(0), 'Good');
  assert.equal(aqiCategory(50), 'Good');
  assert.equal(aqiCategory(51), 'Moderate');
  assert.equal(aqiCategory(151), 'Unhealthy');
  assert.equal(aqiCategory(420), 'Hazardous');
  assert.equal(aqiCategory(null), null);
});

test('builds a cached AQI grid for the air quality map', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const n = new URL(url).searchParams.get('latitude').split(',').length;
    const body = Array.from({ length: n }, (_, i) => ({ current: { time: NOW, us_aqi: i === 0 ? null : 40.6 } }));
    return { ok: true, status: 200, json: async () => body };
  };
  const w = createWeather({ fetchImpl });
  const map = await w.airMap('38.7', '-121.28');
  assert.equal(map.points.length, 13 * 9);
  assert.equal(map.points[0].aqi, null);
  assert.equal(map.points[1].aqi, 41);
  assert.equal(map.points[58].lat, 38.8); // center snapped to the 0.4° grid
  await w.airMap('38.75', '-121.3');
  assert.equal(urls.length, 1);
  await assert.rejects(w.airMap('x', '1'), { status: 400 });
});

test('suggests places with labels that resolve back to the same place', async () => {
  const fetchImpl = mockFetch();
  const w = createWeather({ fetchImpl });
  const list = await w.search('Springf');
  assert.deepEqual(list.map((p) => p.label), ['Springfield, Illinois', 'Springfield, Missouri']);
  assert.deepEqual(await w.search('s'), []);
  const data = await w.get(list[1].label);
  assert.equal(data.location.region, 'Missouri');
});

test('day() returns every hour of one forecast day from the cached forecast', async () => {
  const fetchImpl = mockFetch();
  const w = createWeather({ fetchImpl });
  const data = await w.get('Springfield, MO');
  const tomorrow = data.daily[1].date;
  const d = await w.day('Springfield, MO', 'imperial', tomorrow);
  assert.equal(d.hours.length, 24);
  assert.equal(d.hours[0].time, tomorrow);
  assert.equal(d.hours[0].temp, 84);
  assert.equal(d.day.date, tomorrow);
  assert.equal(fetchImpl.calls.filter((u) => u.includes('/forecast')).length, 1); // no second upstream call
  await assert.rejects(w.day('Springfield, MO', 'imperial', 'x'), { status: 400 });
  await assert.rejects(w.day('Springfield, MO', 'imperial', data.daily[5].date), { status: 404 });
});

test('NWS alerts: worst first, one per event, bell once per new alert', async () => {
  alertsBody = {
    features: [
      { properties: { id: 'a1', event: 'Frost Advisory', severity: 'Minor', headline: 'Frost tonight', description: 'Cold.', ends: '2026-10-25T08:00:00-07:00' } },
      { properties: { id: 'a2', event: 'Red Flag Warning', severity: 'Severe', headline: 'Fire danger', description: 'Wind and dry air.', instruction: 'No burning.' } },
      { properties: { id: 'a3', event: 'Red Flag Warning', severity: 'Severe', headline: 'Fire danger (update)' } },
    ],
  };
  const bell = [];
  let saved = [];
  let t = 0;
  const fetchImpl = mockFetch();
  const w = createWeather({ fetchImpl, now: () => (t += 11 * 60 * 1000), notify: (n) => bell.push(n), alertsSeen: { load: async () => saved, save: async (ids) => (saved = ids) } });
  const data = await w.get('Springfield, MO');
  assert.deepEqual(data.alerts.map((a) => a.event), ['Red Flag Warning', 'Frost Advisory']);
  assert.equal(data.alerts[1].ends, Date.parse('2026-10-25T08:00:00-07:00') / 1000);
  assert.equal(data.alerts[0].instruction, 'No burning.');
  assert.match(fetchImpl.alertCalls[0], /point=37\.2000,-93\.2900/);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(bell.length, 1); // the Minor frost advisory only shows on the tile
  assert.match(bell[0].title, /Red Flag Warning for Springfield/);
  assert.equal(bell[0].level, 'alert');
  assert.deepEqual(saved.sort(), ['a1', 'a2']);
  await w.get('Springfield, MO'); // cache expired: fetched again, same alerts
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(bell.length, 1);
  alertsBody = { features: [] };
});

test('yesterday comes from one extra call per day; alerts and yesterday failing leave the forecast', async () => {
  const fetchImpl = mockFetch();
  let t = 0;
  const w = createWeather({ fetchImpl, now: () => (t += 11 * 60 * 1000) });
  const data = await w.get('Springfield, MO');
  assert.deepEqual(data.yesterday, { high: 70, low: 50 });
  await w.get('Springfield, MO');
  assert.equal(fetchImpl.pastCalls.length, 1);
  assert.equal(data.daily[0].gustMax, null);
  assert.deepEqual(data.soon, []);

  const down = async (url) => {
    if (String(url).includes('api.weather.gov') || String(url).includes('past_days')) throw new Error('offline');
    return fetchImpl(url);
  };
  const d2 = await createWeather({ fetchImpl: down }).get('Springfield, MO');
  assert.deepEqual(d2.alerts, []);
  assert.equal(d2.yesterday, null);
});

test('soon keeps the next two hours of 15-minute precipitation', async () => {
  const base = mockFetch();
  const fetchImpl = async (url) => {
    const res = await base(url);
    if (!String(url).includes('/forecast?') || String(url).includes('past_days')) return res;
    const body = await res.json();
    body.minutely_15 = { time: Array.from({ length: 10 }, (_, i) => NOW - 1800 + i * 900), precipitation: [0, 0, 0, 0, 0.02, 0.05, 0, 0, 0, 0] };
    return { ok: true, status: 200, json: async () => body };
  };
  const data = await createWeather({ fetchImpl }).get('Springfield, MO');
  assert.equal(data.soon.length, 7); // quarter hours ending after now
  assert.equal(data.soon[0].time, NOW + 900);
  assert.equal(data.soon[2].precip, 0.05);
});
