import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWeather } from './weather.js';

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
    },
    daily: {
      time: Array.from({ length: 7 }, (_, i) => midnight + i * 24 * HOUR),
      weather_code: Array(7).fill(61),
      temperature_2m_max: Array(7).fill(75.4),
      temperature_2m_min: Array(7).fill(55.5),
      precipitation_probability_max: Array(7).fill(60),
      sunrise: Array(7).fill(NOW - 2 * HOUR),
      sunset: Array(7).fill(NOW + 10 * HOUR),
    },
  };
}

function mockFetch() {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    const body = String(url).includes('geocoding') ? geocode : forecast();
    return { ok: true, status: 200, json: async () => body };
  };
  fn.calls = calls;
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
