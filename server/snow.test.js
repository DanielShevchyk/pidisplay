import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSnow, localDate, parseAlerts, parseLifts, parseSnotel, RESORTS, summarizeForecast } from './snow.js';

const NOW = Date.UTC(2026, 11, 10, 20, 30); // Dec 10, 12:30 PM in the Sierra

/** Open-Meteo-shaped location: 7 past days + 10 forecast days, `perHour` inches of snow each hour from `fromDay`. */
function location({ perHour = 0.1, fromDay = '2026-12-09', toDay = '2026-12-12' } = {}) {
  const hours = [];
  const snow = [];
  const days = [];
  for (let d = -7; d < 10; d++) {
    const date = localDate(NOW + d * 86400000);
    days.push(date);
    for (let hr = 0; hr < 24; hr++) {
      hours.push(`${date}T${String(hr).padStart(2, '0')}:00`);
      snow.push(date >= fromDay && date <= toDay ? perHour : 0);
    }
  }
  return {
    current: { temperature_2m: 24, weather_code: 73, wind_speed_10m: 12, wind_gusts_10m: 30, snowfall: 0.2 },
    hourly: { time: hours, snowfall: snow },
    daily: {
      time: days,
      snowfall_sum: days.map((date) => (date >= fromDay && date <= toDay ? perHour * 24 : 0)),
      rain_sum: days.map(() => 0),
      temperature_2m_max: days.map(() => 30),
      temperature_2m_min: days.map(() => 18),
      weather_code: days.map(() => 73),
      precipitation_probability_max: days.map(() => 80),
      wind_gusts_10m_max: days.map(() => 35),
    },
  };
}

function mockFetch(handlers) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    for (const [match, body] of handlers) {
      if (String(url).includes(match)) {
        const value = typeof body === 'function' ? body(String(url)) : body;
        if (value instanceof Error) throw value;
        if (typeof value === 'number') return { ok: false, status: value, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => value };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

const snotelBody = [
  {
    stationTriplet: '518:CA:SNTL',
    data: [
      {
        stationElement: { elementCode: 'SNWD' },
        values: [
          { date: '2026-12-02', value: 20 },
          { date: '2026-12-08', value: 22 },
          { date: '2026-12-09', value: 30 },
          { date: '2026-12-10', value: 38 },
        ],
      },
      { stationElement: { elementCode: 'WTEQ' }, values: [{ date: '2026-12-10', value: 9.4 }] },
    ],
  },
];

test('summarizeForecast sums snow around the current hour and keeps future days', () => {
  const top = location({ perHour: 0.1 });
  const base = location({ perHour: 0.05 });
  const s = summarizeForecast([top, base], NOW);
  // Snow from Dec 9 00:00 to Dec 12 23:00; now is Dec 10 12:00.
  assert.equal(s.past24, 2.4);
  assert.equal(s.past72, 3.7); // Dec 9 00:00 .. Dec 10 12:00 = 37 hours
  assert.equal(s.next24, 2.4);
  assert.equal(s.next72, 5.9); // Dec 10 13:00 .. Dec 12 23:00 = 59 hours
  assert.equal(s.next24Base, 1.2);
  assert.equal(s.days[0].date, '2026-12-10');
  assert.equal(s.days.length, 10);
  assert.equal(s.next7d, 7.2);
  assert.equal(s.past7d, 2.4);
  assert.equal(s.now.temp, 24);
  assert.equal(s.now.snowing, true);
});

test('parseSnotel reads depth, daily and weekly change, and water content', () => {
  const s = parseSnotel(snotelBody)['518:CA:SNTL'];
  assert.deepEqual(s, { depth: 38, change24: 8, change7: null, swe: 9.4, date: '2026-12-10' });
  assert.deepEqual(parseSnotel([{ stationTriplet: 'x', data: [] }]), {});
  assert.deepEqual(parseSnotel(null), {});
});

test('parseLifts counts lift states', () => {
  assert.deepEqual(parseLifts({ lifts: { status: { A: 'open', B: 'open', C: 'hold', D: 'closed', E: 'weird' } } }), {
    open: 2, hold: 1, scheduled: 0, closed: 2, total: 5,
  });
  assert.equal(parseLifts({ lifts: { status: {} } }), null);
  assert.equal(parseLifts({}), null);
});

test('parseAlerts keeps one entry per event', () => {
  const a = parseAlerts({
    features: [
      { properties: { event: 'Winter Storm Warning', headline: 'WSW until Fri', severity: 'Moderate', ends: '2026-12-12T04:00:00-08:00' } },
      { properties: { event: 'Winter Storm Warning', headline: 'dup' } },
      { properties: {} },
    ],
  });
  assert.equal(a.length, 1);
  assert.equal(a[0].event, 'Winter Storm Warning');
});

test('get combines all sources and caches them', async () => {
  const fetchImpl = mockFetch([
    ['api.open-meteo.com', [location(), location({ perHour: 0.05 })]],
    ['awdbRestApi', snotelBody],
    ['liftie.info/api/resort/heavenly', { lifts: { status: { Gondola: 'open', Comet: 'closed' } } }],
    ['api.weather.gov', { features: [{ properties: { event: 'Winter Storm Warning', headline: 'h' } }] }],
  ]);
  const snow = createSnow({ fetchImpl, now: () => NOW });
  const out = await snow.get({ resorts: 'heavenly', units: 'imperial' });
  const r = out.resorts[0];
  assert.equal(r.name, 'Heavenly');
  assert.equal(r.summit, 10067);
  assert.equal(r.next24, 2.4);
  assert.equal(r.station.depth, 38);
  assert.equal(r.station.change24, 8);
  assert.deepEqual(r.lifts, { open: 1, hold: 0, scheduled: 0, closed: 1, total: 2 });
  assert.equal(r.alerts[0].event, 'Winter Storm Warning');
  const forecastUrl = fetchImpl.calls.find((u) => u.includes('open-meteo'));
  assert.match(decodeURIComponent(forecastUrl), /elevation=3068,1993/);
  const n = fetchImpl.calls.length;
  await snow.get({ resorts: 'heavenly', units: 'imperial' });
  assert.equal(fetchImpl.calls.length, n, 'second call is served from cache');
});

test('a failing source leaves the others, and metric converts station numbers', async () => {
  const fetchImpl = mockFetch([
    ['api.open-meteo.com', new Error('offline')],
    ['awdbRestApi', snotelBody],
    ['liftie.info', 404],
    ['api.weather.gov', 500],
  ]);
  const snow = createSnow({ fetchImpl, now: () => NOW });
  const r = (await snow.get({ resorts: 'heavenly', units: 'metric' })).resorts[0];
  assert.match(r.forecastError, /unreachable/);
  assert.equal(r.summit, 3068);
  assert.equal(r.station.depth, 97);
  assert.equal(r.lifts, null);
  assert.deepEqual(r.alerts, []);
});

test('liftie ids are tried in order until one has lifts', async () => {
  const fetchImpl = mockFetch([
    ['api.open-meteo.com', [location(), location()]],
    ['liftie.info/api/resort/palisades-tahoe', 404],
    ['liftie.info/api/resort/palisades', { lifts: { status: { KT: 'open' } } }],
  ]);
  const snow = createSnow({ fetchImpl, now: () => NOW });
  const r = (await snow.get({ resorts: 'palisades' })).resorts[0];
  assert.equal(r.lifts.open, 1);
});

test('rejects unknown resorts and bad units', async () => {
  const snow = createSnow({ fetchImpl: mockFetch([]), now: () => NOW });
  await assert.rejects(snow.get({ resorts: 'nowhere' }), /Unknown resort/);
  await assert.rejects(snow.get({ units: 'kelvin' }), /units/);
  assert.ok(snow.catalog().some((r) => r.id === 'kirkwood'));
  assert.ok(Object.values(RESORTS).every((r) => r.summit > r.base));
});
