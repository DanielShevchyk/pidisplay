// Stock quotes, price history and price alerts for the stocks widget.
//
// The watchlist and alerts live here, on the Pi, and the server polls quotes on
// its own schedule, so an alert fires (bell notification plus a sound on every
// open screen) even when no Stocks tile is showing.
//
// Two data sources:
//   - Twelve Data (twelvedata.com), used once an API key is saved in
//     $PIDISPLAY_DATA/stocks-key.json. Free plan: 8 credits a minute and 800 a
//     day, one credit per symbol per request, so polling is paced to fit.
//   - Yahoo Finance's public chart endpoint when there is no key. No sign-up,
//     but unofficial: it can change or throttle without notice.

import { TONES } from './timers.js';

const TWELVE_URL = 'https://api.twelvedata.com';
const YAHOO_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const TIMEOUT = 15_000;
const MARKET_TZ = 'America/New_York';
const MIN = 60_000;

export const RANGES = ['1d', '5d', '1m', '6m', '1y', '5y'];
const RANGE_DAYS = { '1m': 31, '6m': 183, '1y': 366, '5y': 5 * 366 };
const KINDS = ['above', 'below', 'up', 'down'];
const SYMBOL = /^\^?[A-Z0-9][A-Z0-9.\-=/:]{0,14}$/;
const MAX_SYMBOLS = 20;
const MAX_ALERTS = 50;
const SPARK_DAYS = 30;
const MAX_DAILY = 1400;
/** A gap longer than this refetches the whole history instead of the last month. */
const RECENT_DAYS = 25;

// Twelve Data free plan, with a little headroom.
const TD_PER_MINUTE = 8;
const TD_PER_DAY = 790;
/** Credits per day the quote polling may plan to use; the rest is for charts. */
const TD_QUOTE_BUDGET = 560;
/** Minutes in a regular US session (9:30 to 16:00 ET). */
const SESSION_MINUTES = 390;
/** While the market is closed, refresh this often (catches the close and holidays). */
const CLOSED_POLL_MS = 3 * 60 * MIN;

const DEFAULT_SETTINGS = { refreshMinutes: 2, sound: 'bells', volume: 80, repeats: 3 };
const DEFAULT_STATE = { symbols: ['SPY', 'AAPL', 'MSFT'], alerts: [], settings: DEFAULT_SETTINGS, quotes: {} };

export class StocksError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new StocksError(400, message);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// ---- US market clock --------------------------------------------------------

const etParts = new Intl.DateTimeFormat('en-US', {
  timeZone: MARKET_TZ,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function marketClock(ms) {
  const p = Object.fromEntries(etParts.formatToParts(ms).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** Trading day (YYYY-MM-DD in New York) a timestamp belongs to. */
export const marketDay = (ms) => marketClock(ms).day;

/** Regular session hours on a weekday. Holidays are caught by the data source saying it's closed. */
export function inSession(ms) {
  const { weekday, minutes } = marketClock(ms);
  return weekday !== 'Sat' && weekday !== 'Sun' && minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/** The weekday before a YYYY-MM-DD trading day (holidays aren't known, so they look like gaps). */
export function prevWeekday(day) {
  const d = new Date(`${day}T12:00:00Z`);
  do d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

/** Daily closes merged by trading day; newer data wins. Keeps about five years. */
export function mergeDaily(points, fresh) {
  const byDay = new Map(points.map((p) => [marketDay(p[0]), p]));
  for (const p of fresh) byDay.set(marketDay(p[0]), p);
  return [...byDay.values()].sort((a, b) => a[0] - b[0]).slice(-MAX_DAILY);
}

// ---- Data sources -----------------------------------------------------------

async function getJson(fetchImpl, url, headers) {
  let res;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (err) {
    throw new StocksError(502, `Stock service unreachable (${err.message})`);
  }
  const body = await res.json().catch(() => null);
  if (res.status === 429) throw new StocksError(429, 'The stock service is rate limiting us; trying again shortly');
  if (!res.ok && !body) throw new StocksError(502, `Stock service returned ${res.status}`);
  return { status: res.status, body };
}

/** Twelve Data: one request quotes up to 8 symbols (one credit each). */
export function twelveData(apiKey, fetchImpl) {
  const call = async (path, params) => {
    const { body } = await getJson(fetchImpl, `${TWELVE_URL}/${path}?${new URLSearchParams({ ...params, apikey: apiKey })}`);
    // Errors come back as HTTP 200 with a status field.
    if (body?.status === 'error' && body.code && !body.symbol) {
      if (body.code === 401 || body.code === 403) throw new StocksError(502, `Twelve Data rejected the API key: ${body.message}`);
      if (body.code === 429) throw new StocksError(429, 'Twelve Data credit limit reached; waiting before retrying');
      throw new StocksError(body.code === 404 || body.code === 400 ? 404 : 502, cleanMessage(body.message || 'Twelve Data error'));
    }
    return body;
  };

  return {
    id: 'twelvedata',
    name: 'Twelve Data',
    batch: TD_PER_MINUTE,
    costs: true,
    async quotes(symbols) {
      let body;
      try {
        body = await call('quote', { symbol: symbols.join(',') });
      } catch (err) {
        // A lone unknown symbol fails the whole request.
        if (err.status === 404 && symbols.length === 1) return { [symbols[0]]: { error: err.message } };
        throw err;
      }
      // A single symbol comes back as the quote itself, several as a map.
      const bySymbol = symbols.length === 1 ? { [symbols[0]]: body } : body ?? {};
      const out = {};
      for (const s of symbols) {
        const q = bySymbol[s];
        if (!q || q.status === 'error' || num(q.close) === null) {
          out[s] = { error: q?.message ? cleanMessage(q.message) : 'No data for this symbol' };
          continue;
        }
        const price = num(q.close);
        const prevClose = num(q.previous_close);
        out[s] = {
          name: q.name || s,
          currency: q.currency || 'USD',
          price,
          prevClose,
          change: num(q.change) ?? (prevClose !== null ? price - prevClose : null),
          changePct: num(q.percent_change) ?? (prevClose ? ((price - prevClose) / prevClose) * 100 : null),
          time: (num(q.last_quote_at) ?? num(q.timestamp) ?? Date.now() / 1000) * 1000,
          marketOpen: q.is_market_open === true,
        };
      }
      return out;
    },
    async series(symbol, kind) {
      const params = {
        daily: { interval: '1day', outputsize: '1300' },
        recent: { interval: '1day', outputsize: '30' },
        '1d': { interval: '5min', outputsize: '90' },
        '5d': { interval: '30min', outputsize: '70' },
      }[kind];
      const body = await call('time_series', { symbol, ...params, timezone: 'UTC' });
      const points = [];
      for (const v of body?.values ?? []) {
        const close = num(v.close);
        if (close === null) continue;
        // Daily bars are dates; place them at the 4 pm New York close.
        const t = v.datetime.length === 10 ? Date.parse(`${v.datetime}T20:00:00Z`) : Date.parse(`${v.datetime.replace(' ', 'T')}Z`);
        if (Number.isFinite(t)) points.push([t, close]);
      }
      return points.sort((a, b) => a[0] - b[0]);
    },
  };
}

/** Yahoo Finance chart endpoint: no key, one request per symbol. */
export function yahoo(fetchImpl, now = Date.now) {
  const chart = async (symbol, range, interval) => {
    const url = `${YAHOO_URL}/${encodeURIComponent(symbol)}?${new URLSearchParams({ range, interval, includePrePost: 'false' })}`;
    const { body } = await getJson(fetchImpl, url, { 'User-Agent': 'Mozilla/5.0 (X11; Linux aarch64) PiDisplay' });
    const err = body?.chart?.error;
    if (err) throw new StocksError(404, err.code === 'Not Found' ? 'Unknown symbol' : cleanMessage(err.description || 'Yahoo error'));
    const result = body?.chart?.result?.[0];
    if (!result) throw new StocksError(502, 'Yahoo returned no data');
    return result;
  };

  return {
    id: 'yahoo',
    name: 'Yahoo Finance',
    batch: 1,
    costs: false,
    async quotes(symbols) {
      const out = {};
      for (const s of symbols) {
        try {
          const m = (await chart(s, '1d', '1d')).meta ?? {};
          const price = num(m.regularMarketPrice);
          if (price === null) throw new StocksError(404, 'No data for this symbol');
          const prevClose = num(m.chartPreviousClose) ?? num(m.previousClose);
          const period = m.currentTradingPeriod?.regular;
          const nowSec = now() / 1000;
          out[s] = {
            name: m.longName || m.shortName || s,
            currency: m.currency || 'USD',
            price,
            prevClose,
            change: prevClose !== null ? price - prevClose : null,
            changePct: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
            time: (num(m.regularMarketTime) ?? nowSec) * 1000,
            marketOpen: period ? nowSec >= period.start && nowSec < period.end : null,
          };
        } catch (err) {
          if (err.status === 429) throw err;
          out[s] = { error: err.message };
        }
      }
      return out;
    },
    async series(symbol, kind) {
      const [range, interval] = { daily: ['5y', '1d'], recent: ['1mo', '1d'], '1d': ['1d', '5m'] }[kind] ?? ['5d', '30m'];
      const r = await chart(symbol, range, interval);
      const closes = r.indicators?.quote?.[0]?.close ?? [];
      const points = [];
      (r.timestamp ?? []).forEach((t, i) => {
        if (num(closes[i]) !== null) points.push([t * 1000, num(closes[i])]);
      });
      return points;
    },
  };
}

function cleanMessage(text) {
  // Twelve Data error texts link to their pricing page; keep the first sentence.
  return String(text).split(/(?<=\.)\s/)[0].slice(0, 160);
}

// ---- Alerts -----------------------------------------------------------------

function money(n, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: n < 10 ? 4 : 2 }).format(n);
  } catch {
    return n.toFixed(2);
  }
}

const pct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

export function alertMet(alert, q) {
  if (!q || q.price === null || q.price === undefined) return false;
  if (alert.kind === 'above') return q.price >= alert.value;
  if (alert.kind === 'below') return q.price <= alert.value;
  if (q.changePct === null || q.changePct === undefined) return false;
  if (alert.kind === 'up') return q.changePct >= alert.value;
  return q.changePct <= -alert.value;
}

export function describeAlert(a, currency) {
  if (a.kind === 'above') return `${a.symbol} at or above ${money(a.value, currency)}`;
  if (a.kind === 'below') return `${a.symbol} at or below ${money(a.value, currency)}`;
  return `${a.symbol} ${a.kind === 'up' ? 'up' : 'down'} ${a.value}% in a day`;
}

function alertNotification(a, q) {
  const icon = a.kind === 'above' || a.kind === 'up' ? '📈' : '📉';
  const title =
    a.kind === 'above'
      ? `${a.symbol} is above ${money(a.value, q.currency)}`
      : a.kind === 'below'
        ? `${a.symbol} is below ${money(a.value, q.currency)}`
        : `${a.symbol} is ${a.kind} ${Math.abs(q.changePct).toFixed(1)}% today`;
  const now = `Now ${money(q.price, q.currency)}${q.changePct !== null ? ` (${pct(q.changePct)} today)` : ''}`;
  return { title: `${icon} ${title}`, body: a.note ? `${now} · ${a.note}` : now, level: 'alert' };
}

// ---- Validation -------------------------------------------------------------

function cleanSymbol(v) {
  if (typeof v !== 'string') throw bad('symbol must be text');
  const s = v.trim().toUpperCase();
  if (!SYMBOL.test(s)) throw bad(`"${v.trim().slice(0, 20)}" doesn't look like a ticker symbol`);
  return s;
}

function cleanAlert(body, existing) {
  const a = { ...existing };
  if (!existing || body.symbol !== undefined) a.symbol = cleanSymbol(body.symbol);
  if (!existing || body.kind !== undefined) {
    if (!KINDS.includes(body.kind)) throw bad(`kind must be one of ${KINDS.join(', ')}`);
    a.kind = body.kind;
  }
  if (!existing || body.value !== undefined) {
    if (typeof body.value !== 'number' || !Number.isFinite(body.value) || body.value <= 0) throw bad('value must be a positive number');
    a.value = body.value;
  }
  if ((a.kind === 'up' || a.kind === 'down') && a.value > 100) throw bad('A daily move can be at most 100%');
  if (!existing || body.repeat !== undefined) {
    if (body.repeat !== undefined && !['once', 'daily'].includes(body.repeat)) throw bad('repeat must be once or daily');
    a.repeat = body.repeat ?? 'once';
  }
  if (body.note !== undefined) {
    if (typeof body.note !== 'string') throw bad('note must be text');
    a.note = body.note.trim().slice(0, 80);
  }
  if (body.enabled !== undefined) a.enabled = Boolean(body.enabled);
  return a;
}

// ---- The service ------------------------------------------------------------

export function createStocks({
  load,
  save,
  loadKey = async () => null,
  loadHistory = async () => null,
  saveHistory = async () => {},
  fetchImpl = globalThis.fetch,
  notify = () => {},
  broadcast = () => {},
  sound = () => {},
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  autoStart = true,
}) {
  let state = structuredClone(DEFAULT_STATE);
  let saving = Promise.resolve();
  let provider = yahoo(fetchImpl, now);
  let providerKey = null;
  let error = null;
  let lastPoll = 0;
  let nextPollAt = 0;
  /** Set when the data source says the market is shut on a weekday (a holiday). */
  let closedDay = null;
  let pollTimer = null;
  let polling = null;
  let stopped = false;
  let counter = 0;
  // Daily closes per symbol, saved on disk so a restart doesn't refetch years of
  // history. Kept current from quotes (today's bar follows the live price), so the
  // source is only asked again to fill gaps, e.g. after the Pi was off for days.
  const daily = new Map(); // symbol -> { checked: day the series was last confirmed complete, points }
  let historyDirty = false;
  let historySaving = Promise.resolve();
  const intraday = new Map(); // "symbol|range" -> { at, points }
  const inflight = new Map();
  // Twelve Data credit accounting: timestamps of the last minute, and a daily count.
  let recent = [];
  let used = { day: '', count: 0 };

  const ready = (async () => {
    const saved = await load();
    if (saved && typeof saved === 'object') {
      state = {
        symbols: Array.isArray(saved.symbols) ? saved.symbols.filter((s) => typeof s === 'string') : DEFAULT_STATE.symbols,
        alerts: Array.isArray(saved.alerts) ? saved.alerts : [],
        settings: { ...DEFAULT_SETTINGS, ...saved.settings },
        quotes: saved.quotes && typeof saved.quotes === 'object' ? saved.quotes : {},
      };
      if (saved.used?.day) used = saved.used;
    }
    try {
      const hist = await loadHistory();
      for (const [sym, d] of Object.entries(hist?.symbols ?? {})) {
        if (Array.isArray(d?.points)) daily.set(sym, { checked: d.checked ?? null, points: d.points });
      }
    } catch (err) {
      console.error('Reading saved stock history failed', err);
    }
  })();

  function persistHistory() {
    if (!historyDirty) return;
    historyDirty = false;
    const symbols = {};
    for (const s of state.symbols) if (daily.has(s)) symbols[s] = daily.get(s);
    const copy = structuredClone({ version: 1, symbols });
    historySaving = historySaving.then(() => saveHistory(copy)).catch((err) => console.error('Saving stock history failed', err));
  }

  /** Moves today's daily bar to the live price; a new day also settles the last one at the official previous close. */
  function applyQuote(symbol, q) {
    const d = daily.get(symbol);
    if (!d?.points.length || q.price == null || !q.time) return;
    const day = marketDay(q.time);
    const last = d.points[d.points.length - 1];
    const lastDay = marketDay(last[0]);
    if (day === lastDay) {
      if (last[1] !== q.price) {
        d.points[d.points.length - 1] = [Math.max(last[0], q.time), q.price];
        // Only worth a disk write once the market has closed for the day.
        if (!inSession(now())) historyDirty = true;
      }
    } else if (day > lastDay) {
      if (q.prevClose != null && lastDay === prevWeekday(day)) d.points[d.points.length - 1] = [last[0], q.prevClose];
      d.points.push([q.time, q.price]);
      historyDirty = true;
    }
  }

  /** What the saved history lacks: nothing, the last few weeks, or all of it. */
  function missingHistory(symbol) {
    const d = daily.get(symbol);
    if (!d || d.points.length < 2) return 'daily';
    const today = marketDay(state.quotes[symbol]?.time ?? now());
    if (d.checked === today) return null;
    const before = d.points.filter(([t]) => marketDay(t) < today);
    if (!before.length) return 'daily';
    const last = marketDay(before[before.length - 1][0]);
    if (last >= prevWeekday(today)) return null;
    return daysBetween(last, today) > RECENT_DAYS ? 'daily' : 'recent';
  }

  async function pickProvider() {
    let key = null;
    try {
      const cfg = await loadKey();
      key = typeof cfg?.apiKey === 'string' && cfg.apiKey.trim() ? cfg.apiKey.trim() : null;
    } catch (err) {
      console.error('Reading stocks-key.json failed', err);
    }
    if (key !== providerKey) {
      providerKey = key;
      provider = key ? twelveData(key, fetchImpl) : yahoo(fetchImpl, now);
      intraday.clear();
    }
    return provider;
  }

  // -- Credits (Twelve Data only) --

  const utcDay = () => new Date(now()).toISOString().slice(0, 10);
  function creditsLeft() {
    if (used.day !== utcDay()) used = { day: utcDay(), count: 0 };
    return TD_PER_DAY - used.count;
  }

  /** Waits until n credits fit in the per-minute window, then books them. */
  async function spend(n) {
    if (!provider.costs) return;
    if (creditsLeft() < n) throw new StocksError(429, 'Out of Twelve Data credits for today; back after midnight UTC');
    for (;;) {
      const t = now();
      recent = recent.filter((x) => t - x < MIN);
      if (recent.length + n <= TD_PER_MINUTE) break;
      await sleep(recent[0] + MIN - t + 250);
    }
    const t = now();
    for (let i = 0; i < n; i++) recent.push(t);
    used.count += n;
  }

  // -- Snapshot and persistence --

  function sparkFor(symbol) {
    const d = daily.get(symbol);
    if (!d) return state.quotes[symbol]?.spark ?? null;
    const today = state.quotes[symbol]?.time ? marketDay(state.quotes[symbol].time) : marketDay(now());
    return d.points.filter(([t]) => marketDay(t) !== today).slice(-SPARK_DAYS).map(([, c]) => c);
  }

  function snapshot() {
    const quotes = {};
    for (const s of state.symbols) {
      const q = state.quotes[s];
      if (q) quotes[s] = { ...q, spark: sparkFor(s) };
    }
    return {
      now: now(),
      provider: provider.id,
      providerName: provider.name,
      marketOpen: isOpen(),
      symbols: state.symbols,
      quotes,
      alerts: state.alerts,
      settings: state.settings,
      updated: lastPoll || null,
      nextPollAt: nextPollAt || null,
      error,
      credits: provider.costs ? { used: TD_PER_DAY - creditsLeft(), limit: TD_PER_DAY } : null,
      tones: TONES,
    };
  }

  function commit() {
    // Keep sparklines with the quotes so tiles have a trend right after a restart.
    for (const s of state.symbols) if (state.quotes[s]) state.quotes[s].spark = sparkFor(s);
    const copy = structuredClone({ ...state, used });
    saving = saving.then(() => save(copy)).catch((err) => console.error('Saving stocks failed', err));
    broadcast(snapshot());
  }

  // -- Polling --

  function isOpen() {
    const t = now();
    return inSession(t) && closedDay !== marketDay(t);
  }

  function pollEveryMs() {
    if (!isOpen()) return CLOSED_POLL_MS;
    let minutes = state.settings.refreshMinutes;
    if (provider.costs) minutes = Math.max(minutes, Math.ceil((state.symbols.length * SESSION_MINUTES) / TD_QUOTE_BUDGET));
    return minutes * MIN;
  }

  function schedule() {
    clearTimeout(pollTimer);
    if (stopped) return;
    let at = lastPoll + pollEveryMs();
    // Wake just after the opening bell and the close rather than sleeping through them.
    const t = now();
    const open = inSession(t);
    for (let m = 1; t + m * MIN < at && m <= 240; m++) {
      if (inSession(t + m * MIN) !== open) {
        at = t + m * MIN + (open ? 2 * MIN : 30_000);
        break;
      }
    }
    nextPollAt = Math.max(at, t + 5000);
    pollTimer = setTimeout(() => void poll().catch(() => {}), nextPollAt - t);
    pollTimer.unref?.();
  }

  /** Fetches quotes (all symbols, or just `only`), checks alerts, and refreshes sparklines. */
  function poll(only) {
    if (polling) return polling.then(() => poll(only), () => poll(only));
    polling = (async () => {
      await ready;
      const src = await pickProvider();
      const symbols = only ?? [...state.symbols];
      try {
        for (let i = 0; i < symbols.length; i += src.batch) {
          const chunk = symbols.slice(i, i + src.batch);
          await spend(chunk.length);
          const quotes = await src.quotes(chunk);
          for (const s of chunk) {
            const q = quotes[s];
            if (!state.symbols.includes(s) || !q) continue;
            if (q.error) {
              // Keep the last good price; just flag the problem.
              state.quotes[s] = { ...state.quotes[s], error: q.error };
              continue;
            }
            state.quotes[s] = { ...q, error: null };
            applyQuote(s, q);
            // Closed on a weekday mid-session means a holiday. Wait past the open so a
            // source that's slow to flip its flag at 9:30 doesn't park us for the day.
            if (q.marketOpen === false && inSession(now()) && marketClock(now()).minutes >= 9 * 60 + 45) closedDay = marketDay(now());
            checkAlerts(s);
          }
        }
        error = null;
      } catch (err) {
        error = err.message;
        if (err.status !== 429) console.error('Stock quotes failed:', err.message);
      }
      if (!only) lastPoll = now();
      commit();
      // Sparklines and charts: fetch only what the saved history is missing.
      for (const s of symbols) {
        if (!missingHistory(s)) continue;
        try {
          await dailySeries(s);
        } catch {
          // The chart will show the error when someone opens it.
        }
      }
      persistHistory();
      commit();
    })().finally(() => {
      polling = null;
      schedule();
    });
    return polling;
  }

  function checkAlerts(symbol) {
    const q = state.quotes[symbol];
    for (const a of state.alerts) {
      if (a.symbol !== symbol || !a.enabled || !alertMet(a, q)) continue;
      const day = marketDay(q.time);
      if (a.repeat === 'daily' && a.firedDay === day) continue;
      a.firedAt = now();
      a.firedDay = day;
      a.firedPrice = q.price;
      if (a.repeat !== 'daily') a.enabled = false;
      fire(alertNotification(a, q));
    }
  }

  function fire(n) {
    notify(n);
    const { sound: tone, volume, repeats } = state.settings;
    sound({ sound: tone, volume, repeats, title: n.title });
  }

  // -- History --

  async function dailySeries(symbol) {
    const cached = daily.get(symbol);
    const need = missingHistory(symbol);
    if (!need) return cached.points;
    const key = `daily|${symbol}`;
    if (!inflight.has(key)) {
      inflight.set(
        key,
        (async () => {
          const src = await pickProvider();
          await spend(1);
          const fresh = await src.series(symbol, need);
          const current = daily.get(symbol);
          const points = mergeDaily(need === 'recent' && current ? current.points : [], fresh);
          const q = state.quotes[symbol];
          daily.set(symbol, { checked: marketDay(q?.time ?? now()), points });
          if (q) applyQuote(symbol, q);
          historyDirty = true;
          persistHistory();
          return daily.get(symbol).points;
        })().finally(() => inflight.delete(key)),
      );
    }
    try {
      return await inflight.get(key);
    } catch (err) {
      if (cached) return cached.points;
      throw err;
    }
  }

  async function intradaySeries(symbol, range) {
    const key = `${symbol}|${range}`;
    const cached = intraday.get(key);
    const ttl = isOpen() ? 5 * MIN : 60 * MIN;
    if (cached && now() - cached.at < ttl) return cached.points;
    if (!inflight.has(key)) {
      inflight.set(
        key,
        (async () => {
          const src = await pickProvider();
          await spend(1);
          let points = await src.series(symbol, range);
          // Keep whole trading days only: the latest one (1d) or the latest five (5d).
          const days = [...new Set(points.map(([t]) => marketDay(t)))].slice(range === '1d' ? -1 : -5);
          points = points.filter(([t]) => days.includes(marketDay(t)));
          intraday.set(key, { at: now(), points });
          return points;
        })().finally(() => inflight.delete(key)),
      );
    }
    try {
      return await inflight.get(key);
    } catch (err) {
      if (cached) return cached.points;
      throw err;
    }
  }

  async function history(symbolRaw, range) {
    await ready;
    const symbol = cleanSymbol(symbolRaw ?? '');
    if (!RANGES.includes(range)) throw bad(`range must be one of ${RANGES.join(', ')}`);
    let points;
    if (range === '1d' || range === '5d') points = await intradaySeries(symbol, range);
    else {
      const from = now() - RANGE_DAYS[range] * 24 * 3600 * 1000;
      points = (await dailySeries(symbol)).filter(([t]) => t >= from);
    }
    const q = state.quotes[symbol];
    // Finish the line at the live price when it is newer than the last bar.
    if (q?.price != null && q.time && points.length && q.time > points[points.length - 1][0]) {
      if (range === '1d' || range === '5d' || marketDay(q.time) !== marketDay(points[points.length - 1][0])) points = [...points, [q.time, q.price]];
      else points = [...points.slice(0, -1), [q.time, q.price]];
    }
    return { symbol, range, points, prevClose: q?.prevClose ?? null, currency: q?.currency ?? 'USD' };
  }

  // -- API --

  async function handle(method, parts, body) {
    await ready;
    const [, action, id] = parts; // parts[0] is "stocks"
    if (method === 'GET' && !action) {
      await pickProvider();
      return snapshot();
    }
    if (method === 'POST' && action === 'refresh') {
      await poll();
      return snapshot();
    }
    if (method === 'PUT' && action === 'symbols') {
      if (!Array.isArray(body?.symbols)) throw bad('symbols must be a list');
      const symbols = [...new Set(body.symbols.map(cleanSymbol))];
      if (symbols.length > MAX_SYMBOLS) throw bad(`At most ${MAX_SYMBOLS} symbols`);
      const added = symbols.filter((s) => !state.symbols.includes(s));
      state.symbols = symbols;
      for (const s of Object.keys(state.quotes)) if (!symbols.includes(s)) delete state.quotes[s];
      commit();
      if (added.length) void poll(added).catch(() => {});
      return snapshot();
    }
    if (method === 'PUT' && action === 'settings') {
      const s = { ...state.settings };
      if (body?.refreshMinutes !== undefined) {
        if (!isInt(body.refreshMinutes, 1, 60)) throw bad('refreshMinutes must be 1-60');
        s.refreshMinutes = body.refreshMinutes;
      }
      if (body?.sound !== undefined) {
        if (!TONES.includes(body.sound)) throw bad(`sound must be one of ${TONES.join(', ')}`);
        s.sound = body.sound;
      }
      if (body?.volume !== undefined) {
        if (!isInt(body.volume, 0, 100)) throw bad('volume must be 0-100');
        s.volume = body.volume;
      }
      if (body?.repeats !== undefined) {
        if (!isInt(body.repeats, 1, 20)) throw bad('repeats must be 1-20');
        s.repeats = body.repeats;
      }
      state.settings = s;
      commit();
      schedule();
      return snapshot();
    }
    if (method === 'POST' && action === 'test') {
      fire({ title: '📈 Test stock alert', body: 'This is how a price alert looks and sounds.', level: 'alert' });
      return snapshot();
    }
    if (action === 'alerts') {
      if (method === 'POST' && !id) {
        if (state.alerts.length >= MAX_ALERTS) throw new StocksError(409, `At most ${MAX_ALERTS} alerts`);
        const a = cleanAlert(body ?? {}, null);
        const watch = !state.symbols.includes(a.symbol);
        if (watch && state.symbols.length >= MAX_SYMBOLS) throw new StocksError(409, `The watchlist is full (${MAX_SYMBOLS} symbols)`);
        state.alerts.push({ id: `alert-${now().toString(36)}-${(counter++).toString(36)}`, enabled: true, note: '', ...a, firedAt: null, firedDay: null, firedPrice: null, created: now() });
        if (watch) state.symbols.push(a.symbol);
        commit();
        // Check the new alert against a fresh price straight away.
        void poll([a.symbol]).catch(() => {});
        return snapshot();
      }
      const i = state.alerts.findIndex((a) => a.id === id);
      if (i < 0) throw new StocksError(404, 'No such alert');
      if (method === 'PUT') {
        const next = cleanAlert(body ?? {}, state.alerts[i]);
        // Turning an alert back on, or changing its condition, re-arms it.
        if (next.enabled && (!state.alerts[i].enabled || next.value !== state.alerts[i].value || next.kind !== state.alerts[i].kind)) {
          next.firedDay = null;
        }
        state.alerts[i] = next;
        commit();
        return snapshot();
      }
      if (method === 'DELETE') {
        state.alerts.splice(i, 1);
        commit();
        return snapshot();
      }
    }
    throw new StocksError(404, 'Not found');
  }

  if (autoStart) void ready.then(() => poll()).catch((err) => console.error('Starting stocks failed', err));

  return {
    handle,
    history,
    poll,
    snapshot,
    ready,
    stop() {
      stopped = true;
      clearTimeout(pollTimer);
    },
  };
}
