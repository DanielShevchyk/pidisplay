// Expected Farewatcher API usage for a config, shared by the server and the Fares
// widget's settings wizard (which recomputes it on every change). fare_watch.py has a
// Python twin in estimate_usage(); server/fares-usage.test.js checks they agree.
//
// Travelpayouts (cached fares) has no monthly cap, so it's counted per run. SerpApi (live
// Google Flights) is the scarce one: 250 searches a month on the free plan.

export const DAYS_PER_MONTH = 30.4;
export const SERPAPI_FREE_PLAN = 250;
/** Average seconds a run spends per Travelpayouts lookup (request + delay + saving). */
export const SECONDS_PER_LOOKUP = 1.3;
/** Meter thresholds, as a share of the SerpApi plan. */
export const WARN_SHARE = 0.7;
/** Travelpayouts lookups per run above which a run gets long. */
export const LOOKUPS_WARN = 150;
export const LOOKUPS_OVER = 300;

const OPEN_JAW_DEFAULTS = { enabled: false, max_km: 700, extra_return_from: [], home: ['SFO', 'SMF'], live_check: true };

/** Great-circle km between two [lat, lon] points. */
export function kmBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const [la1, lo1, la2, lo2] = [a[0], a[1], b[0], b[1]].map(rad);
  const h = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/**
 * {arrival city: [cities to fly home from]}, like open_jaw_returns() in fare_watch.py.
 * coords(code) returns [lat, lon] or null; cities with unknown coordinates are left out.
 */
export function openJawReturns(cfg, coords) {
  const oj = { ...OPEN_JAW_DEFAULTS, ...(cfg.open_jaw || {}) };
  const dests = Object.keys(cfg.destinations || {});
  const extra = (oj.extra_return_from || []).filter((c) => !dests.includes(c));
  const out = {};
  for (const a of dests) {
    const pa = coords(a);
    if (!pa) continue;
    const near = [...dests, ...extra].filter((b) => {
      const pb = b !== a && coords(b);
      return pb && kmBetween(pa, pb) <= Number(oj.max_km);
    });
    if (near.length) out[a] = near;
  }
  return out;
}

function liveOrigins(cfg) {
  const lc = cfg.live_check || {};
  return lc.origins?.length ? lc.origins : cfg.compare_origins?.length ? cfg.compare_origins : ['SFO'];
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

/**
 * SerpApi searches one fixed-date event uses: one search per live-check origin every
 * check_every_days, while the dates are within horizon_days and still ahead. perMonth is a
 * full month of checks (what the meter counts, since checks run until the trip); thisMonth
 * is what the next 30 days will use.
 */
export function eventUsage(ev, cfg, today) {
  const es = cfg.event_settings || {};
  const every = Math.max(0.5, Number(es.check_every_days ?? 3.5));
  const horizon = Number(es.horizon_days ?? 330);
  const depart = new Date(`${ev.depart}T00:00:00Z`);
  const opens = addDays(depart, -horizon);
  const from = Math.max(today.getTime(), opens.getTime());
  const to = Math.min(addDays(today, DAYS_PER_MONTH).getTime(), depart.getTime());
  const perDay = liveOrigins(cfg).length / every;
  const past = depart <= today;
  return {
    name: ev.name,
    state: past ? 'past' : opens > today ? 'waiting' : 'checking',
    opensOn: opens.toISOString().slice(0, 10),
    perMonth: past ? 0 : Math.round(DAYS_PER_MONTH * perDay),
    thisMonth: Math.round((Math.max(0, to - from) / 86400000) * perDay),
  };
}

/** The last 30 days of runs that recorded usage (fare_watch.py adds these fields from Oct 2026). */
function recentRuns(history, today) {
  const since = addDays(today, -30).getTime();
  return (history?.runs || []).filter((r) => r.startedAt && Date.parse(r.startedAt) >= since);
}

/**
 * Expected usage for a Farewatcher config.
 * ctx.coords(code) -> [lat, lon] | null, ctx.history = summary.usage (recent runs), ctx.plan =
 * SerpApi searches per month, ctx.today = Date.
 */
export function estimateUsage(cfg, ctx = {}) {
  const today = ctx.today || new Date();
  const coords = ctx.coords || (() => null);
  const plan = Number(ctx.plan) || SERPAPI_FREE_PLAN;

  // ---- Travelpayouts, per run
  const origins = cfg.origins || [];
  const dests = Object.keys(cfg.destinations || {});
  const trip = cfg.trip || {};
  const perMonthQueries = !trip.one_way && trip.return_offset_months != null;
  const roundTrip = dests.length * origins.length * (perMonthQueries ? Number(cfg.months_ahead ?? 6) : 1);
  const oj = { ...OPEN_JAW_DEFAULTS, ...(cfg.open_jaw || {}) };
  let openJaw = 0;
  if (oj.enabled) {
    const pairs = new Set();
    for (const [a, bs] of Object.entries(openJawReturns(cfg, coords))) {
      for (const home of oj.home || []) {
        pairs.add(`${home}-${a}`);
        for (const b of bs) pairs.add(`${b}-${home}`);
      }
    }
    openJaw = pairs.size;
  }
  const lookups = roundTrip + openJaw;
  const runs = recentRuns(ctx.history, today);
  const timed = runs.filter((r) => r.travelpayouts > 0 && r.seconds > 0);
  const perLookup = timed.length
    ? timed.reduce((s, r) => s + r.seconds, 0) / timed.reduce((s, r) => s + r.travelpayouts, 0)
    : SECONDS_PER_LOOKUP;

  // ---- SerpApi, per month
  const lc = cfg.live_check || {};
  const liveOn = lc.enabled !== false;
  const perRun = liveOn ? Math.max(0, Number(lc.max_searches_per_run ?? 6)) : 0;
  const reserve = liveOn ? Math.max(0, Number(lc.reserve_searches ?? 10)) : 0;
  // The timer runs daily; extra runs (Check now) show up in the history.
  const days = runs.length ? Math.max(1, (today.getTime() - Math.min(...runs.map((r) => Date.parse(r.startedAt)))) / 86400000) : 0;
  const runsPerMonth = days >= 7 ? Math.max(DAYS_PER_MONTH, (runs.length / days) * DAYS_PER_MONTH) : DAYS_PER_MONTH;
  const dealChecks = Math.round(runsPerMonth * perRun);
  const events = (cfg.events || []).map((ev) => eventUsage(ev, cfg, today));
  const eventChecks = events.reduce((s, e) => s + e.perMonth, 0);
  const worst = dealChecks + eventChecks;

  // What deal checks actually used lately (they stop early when there are few deals).
  const measured = runs.filter((r) => r.serpapi != null);
  let likely = null;
  if (measured.length >= 3) {
    const avg = measured.reduce((s, r) => s + Math.max(0, r.serpapi - (r.eventSearches || 0)), 0) / measured.length;
    likely = Math.round(runsPerMonth * Math.min(perRun, avg)) + eventChecks;
  }

  const share = (worst + reserve) / plan;
  const runsOutDay = (n) => {
    if (n + reserve <= plan || n <= 0) return null;
    return Math.max(1, Math.floor((plan - reserve) / (n / DAYS_PER_MONTH)) + 1);
  };

  return {
    travelpayouts: {
      perRun: lookups,
      roundTrip,
      openJaw,
      seconds: Math.round(lookups * perLookup),
      level: lookups > LOOKUPS_OVER ? 'over' : lookups > LOOKUPS_WARN ? 'warn' : 'ok',
    },
    serpapi: {
      plan,
      reserve,
      perRun,
      runsPerMonth: Math.round(runsPerMonth * 10) / 10,
      dealChecks,
      events,
      eventChecks,
      worst,
      likely,
      share,
      level: share > 1 ? 'over' : share > WARN_SHARE ? 'warn' : 'ok',
      runsOutDay: runsOutDay(worst),
      likelyRunsOutDay: likely == null ? null : runsOutDay(likely),
    },
  };
}
