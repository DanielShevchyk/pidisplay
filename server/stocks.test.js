import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStocks, inSession, marketDay, twelveData, yahoo } from './stocks.js';

// Fri Oct 2 2026, 11:00 New York (15:00 UTC): the market is open.
const OPEN = Date.UTC(2026, 9, 2, 15, 0);
// Sat Oct 3 2026, 11:00 New York.
const WEEKEND = Date.UTC(2026, 9, 3, 15, 0);

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function tdQuote(symbol, close, prev, extra = {}) {
  return {
    symbol, name: `${symbol} Inc`, currency: 'USD', close: String(close), previous_close: String(prev),
    change: String(close - prev), percent_change: String(((close - prev) / prev) * 100),
    timestamp: OPEN / 1000, is_market_open: true, ...extra,
  };
}

function yahooChart(symbol, price, prev, closes = []) {
  return {
    chart: {
      result: [{
        meta: {
          symbol, currency: 'USD', regularMarketPrice: price, chartPreviousClose: prev, regularMarketTime: OPEN / 1000,
          longName: `${symbol} Corp`, currentTradingPeriod: { regular: { start: OPEN / 1000 - 5400, end: OPEN / 1000 + 18000 } },
        },
        timestamp: closes.map((_, i) => OPEN / 1000 - (closes.length - i) * 86400),
        indicators: { quote: [{ close: closes }] },
      }],
      error: null,
    },
  };
}

function setup({ saved = null, key = null, fetchImpl, start = OPEN } = {}) {
  const clock = { t: start };
  const notes = [];
  const sounds = [];
  const saves = [];
  const sleeps = [];
  const stocks = createStocks({
    load: async () => structuredClone(saved),
    save: async (v) => saves.push(v),
    loadKey: async () => (key ? { apiKey: key } : null),
    fetchImpl,
    notify: (n) => notes.push(n),
    sound: (s) => sounds.push(s),
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    autoStart: false,
  });
  return { stocks, clock, notes, sounds, saves, sleeps, call: (m, p, b) => stocks.handle(m, ['stocks', ...p.split('/').filter(Boolean)], b) };
}

test('knows US market hours in New York time', () => {
  assert.equal(inSession(OPEN), true);
  assert.equal(inSession(Date.UTC(2026, 9, 2, 13, 29)), false); // 9:29 EDT
  assert.equal(inSession(Date.UTC(2026, 9, 2, 13, 30)), true);
  assert.equal(inSession(Date.UTC(2026, 9, 2, 20, 0)), false); // 16:00
  assert.equal(inSession(WEEKEND), false);
  // 22:00 UTC on Friday is still Friday in New York.
  assert.equal(marketDay(Date.UTC(2026, 9, 3, 1, 0)), '2026-10-02');
});

test('Twelve Data: batch quotes, a bad symbol in the batch, and a lone bad symbol', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('symbol=NOPE&')) return reply({ code: 404, message: 'symbol not found. Visit our docs.', status: 'error' });
    return reply({ AAPL: tdQuote('AAPL', 210, 200), NOPE: { code: 404, message: 'symbol not found', status: 'error' } });
  };
  const td = twelveData('k3y', fetchImpl);
  const q = await td.quotes(['AAPL', 'NOPE']);
  assert.match(urls[0], /quote\?symbol=AAPL%2CNOPE&apikey=k3y/);
  assert.equal(q.AAPL.price, 210);
  assert.equal(q.AAPL.prevClose, 200);
  assert.equal(q.AAPL.changePct, 5);
  assert.equal(q.AAPL.name, 'AAPL Inc');
  assert.equal(q.NOPE.error, 'symbol not found');
  const lone = await td.quotes(['NOPE']);
  assert.equal(lone.NOPE.error, 'symbol not found.');
});

test('Twelve Data: a bad key is an error for the whole poll', async () => {
  const td = twelveData('bad', async () => reply({ code: 401, message: 'apikey is incorrect', status: 'error' }));
  await assert.rejects(td.quotes(['AAPL', 'MSFT']), /rejected the API key/);
});

test('Twelve Data: time series in UTC, oldest first', async () => {
  let seen = '';
  const td = twelveData('k', async (url) => {
    seen = String(url);
    return reply({
      meta: { symbol: 'AAPL' },
      values: [
        { datetime: '2026-10-02 14:35:00', close: '211.5' },
        { datetime: '2026-10-02 14:30:00', close: '210' },
      ],
      status: 'ok',
    });
  });
  const pts = await td.series('AAPL', '1d');
  assert.match(seen, /interval=5min/);
  assert.match(seen, /timezone=UTC/);
  assert.deepEqual(pts, [[Date.UTC(2026, 9, 2, 14, 30), 210], [Date.UTC(2026, 9, 2, 14, 35), 211.5]]);
});

test('Yahoo: quote from chart meta and history without gaps', async () => {
  const fetchImpl = async (url) =>
    String(url).includes('/ZZZZ?')
      ? reply({ chart: { result: null, error: { code: 'Not Found', description: 'No data found' } } }, 404)
      : reply(yahooChart('MSFT', 420, 400, [390, null, 410]));
  const y = yahoo(fetchImpl, () => OPEN);
  const q = await y.quotes(['MSFT', 'ZZZZ']);
  assert.equal(q.MSFT.price, 420);
  assert.equal(q.MSFT.changePct, 5);
  assert.equal(q.MSFT.name, 'MSFT Corp');
  assert.equal(q.MSFT.marketOpen, true);
  assert.equal(q.ZZZZ.error, 'Unknown symbol');
  const pts = await y.series('MSFT', 'daily');
  assert.deepEqual(pts.map((p) => p[1]), [390, 410]);
});

test('price alerts fire once, notify, play the sound, then switch off', async () => {
  let price = 205;
  const fetchImpl = async (url) => reply(yahooChart('AAPL', price, 200, [190, 195, 200]));
  const { stocks, call, notes, sounds } = setup({ saved: { symbols: ['AAPL'] }, fetchImpl });
  await call('POST', 'alerts', { symbol: 'aapl', kind: 'above', value: 210 });
  await stocks.poll();
  assert.equal(notes.length, 0);
  price = 211;
  await stocks.poll();
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /AAPL is above \$210\.00/);
  assert.match(notes[0].body, /Now \$211\.00 \(\+5\.50% today\)/);
  assert.equal(notes[0].level, 'alert');
  assert.deepEqual(sounds.map((s) => [s.sound, s.repeats]), [['bells', 3]]);
  const snap = stocks.snapshot();
  assert.equal(snap.alerts[0].enabled, false);
  assert.equal(snap.alerts[0].firedPrice, 211);
  await stocks.poll();
  assert.equal(notes.length, 1, 'a one-time alert does not fire again');
});

test('daily alerts fire at most once per trading day; percent moves both ways', async () => {
  let price = 180;
  const fetchImpl = async () => reply(yahooChart('TSLA', price, 200));
  const { stocks, call, notes, clock } = setup({ saved: { symbols: ['TSLA'] }, fetchImpl });
  await call('POST', 'alerts', { symbol: 'TSLA', kind: 'down', value: 5, repeat: 'daily', note: 'buy?' });
  await call('POST', 'alerts', { symbol: 'TSLA', kind: 'up', value: 5, repeat: 'daily' });
  await stocks.poll();
  await stocks.poll();
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /TSLA is down 10\.0% today/);
  assert.match(notes[0].body, /buy\?$/);
  // Next trading day (quotes carry their own time, so move it too).
  clock.t += 3 * 86400 * 1000;
  const later = clock.t;
  const fetch2 = async () => {
    const body = yahooChart('TSLA', price, 200);
    body.chart.result[0].meta.regularMarketTime = later / 1000;
    return reply(body);
  };
  const s2 = setup({ saved: { symbols: ['TSLA'], alerts: stocks.snapshot().alerts }, fetchImpl: fetch2, start: later });
  await s2.stocks.poll();
  assert.equal(s2.notes.length, 1);
});

test('watchlist: validates symbols, drops removed quotes, adding an alert watches its symbol', async () => {
  const fetchImpl = async () => reply(yahooChart('X', 10, 10));
  const { call, stocks } = setup({ fetchImpl });
  await assert.rejects(call('PUT', 'symbols', { symbols: ['AAPL', 'bad symbol!'] }), /doesn't look like a ticker/);
  let snap = await call('PUT', 'symbols', { symbols: ['aapl', 'BRK.B', 'AAPL', '^GSPC'] });
  assert.deepEqual(snap.symbols, ['AAPL', 'BRK.B', '^GSPC']);
  await stocks.poll();
  snap = await call('PUT', 'symbols', { symbols: ['AAPL'] });
  assert.deepEqual(Object.keys(snap.quotes), ['AAPL']);
  snap = await call('POST', 'alerts', { symbol: 'nvda', kind: 'below', value: 100 });
  assert.ok(snap.symbols.includes('NVDA'));
  await assert.rejects(call('POST', 'alerts', { symbol: 'NVDA', kind: 'sideways', value: 1 }), /kind must be/);
  await assert.rejects(call('POST', 'alerts', { symbol: 'NVDA', kind: 'up', value: 0 }), /positive/);
  await assert.rejects(call('PUT', 'settings', { sound: 'kazoo' }), /sound must be/);
});

test('Twelve Data polling stays inside 8 credits a minute', async () => {
  const symbols = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  const batches = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/time_series') return reply({ values: [], status: 'ok' });
    const list = u.searchParams.get('symbol').split(',');
    batches.push(list.length);
    return reply(Object.fromEntries(list.map((s) => [s, tdQuote(s, 10, 10)])));
  };
  const { stocks, sleeps } = setup({ saved: { symbols }, key: 'k', fetchImpl });
  await stocks.poll();
  assert.deepEqual(batches, [8, 2]);
  assert.ok(sleeps.length >= 1 && sleeps[0] >= 60000, 'waited for the next minute before the second batch');
  const snap = stocks.snapshot();
  assert.equal(snap.provider, 'twelvedata');
  assert.ok(snap.credits.used >= 10);
});

test('history: 1d keeps the latest trading day and ends at the live price', async () => {
  const day1 = Date.UTC(2026, 9, 1, 15, 0);
  const fetchImpl = async (url) => {
    if (String(url).includes('interval=5m')) {
      const body = yahooChart('AAPL', 0, 0, []);
      body.chart.result[0].timestamp = [day1 / 1000, (OPEN - 600000) / 1000];
      body.chart.result[0].indicators.quote[0].close = [190, 200];
      return reply(body);
    }
    return reply(yahooChart('AAPL', 205, 199));
  };
  const { stocks } = setup({ saved: { symbols: ['AAPL'] }, fetchImpl, start: OPEN + 60000 });
  await stocks.poll(['AAPL']);
  const h = await stocks.history('AAPL', '1d');
  assert.deepEqual(h.points.map((p) => p[1]), [200, 205]);
  assert.equal(h.prevClose, 199);
  await assert.rejects(stocks.history('AAPL', '3w'), /range must be/);
});

test('a weekend poll is scheduled hours apart, an open market every few minutes', async () => {
  const fetchImpl = async () => reply(yahooChart('AAPL', 1, 1));
  const open = setup({ saved: { symbols: ['AAPL'] }, fetchImpl });
  await open.stocks.poll();
  const s1 = open.stocks.snapshot();
  assert.equal(s1.marketOpen, true);
  assert.equal(s1.nextPollAt - s1.updated, 2 * 60000);
  open.stocks.stop();
  const closed = setup({ saved: { symbols: ['AAPL'] }, fetchImpl, start: WEEKEND });
  await closed.stocks.poll();
  const s2 = closed.stocks.snapshot();
  assert.equal(s2.marketOpen, false);
  assert.equal(s2.nextPollAt - s2.updated, 3 * 3600000);
  closed.stocks.stop();
});
