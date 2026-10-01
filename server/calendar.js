// Calendar proxy for the calendar widget. Reads a list of iCal feeds (e.g. each
// Google calendar's "secret address in iCal format") from calendars.json in the
// data dir, fetches and caches them, expands recurring events, and returns the
// events in a time window. Feed URLs are secrets: they never leave the server.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const TTL = 5 * 60 * 1000;
const TIMEOUT = 15_000;
const MAX_FEED = 20 * 1024 * 1024;
const MAX_SPAN_DAYS = 62;
const DAY = 86_400_000;
const PALETTE = ['#4da3ff', '#3ccf8e', '#ffb443', '#ff6b9a', '#a78bfa', '#2dd4bf', '#ff8a4c', '#e5e7eb'];
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export class CalendarError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- Time zones -----------------------------------------------------------

const zoneFormats = new Map();

function zoneFormat(zone) {
  if (!zoneFormats.has(zone)) {
    let fmt = null;
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      // Not an IANA zone (e.g. Outlook's "Pacific Standard Time").
    }
    zoneFormats.set(zone, fmt);
  }
  return zoneFormats.get(zone);
}

export function validZone(zone) {
  return Boolean(zone && zoneFormat(zone));
}

/** Milliseconds the zone is ahead of UTC at instant ms. */
function zoneOffset(zone, ms) {
  const p = Object.fromEntries(zoneFormat(zone).formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Converts a wall-clock time (encoded as if it were UTC) in zone to a real instant.
 * zone 'UTC' = already UTC; an unknown or missing zone = the server's local zone.
 */
function wallToMs(wall, zone) {
  if (zone === 'UTC') return wall;
  if (!validZone(zone)) {
    const d = new Date(wall);
    return new Date(
      d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(),
    ).getTime();
  }
  const first = wall - zoneOffset(zone, wall);
  const second = wall - zoneOffset(zone, first);
  return second;
}

/** Real instant of local midnight for a 'YYYY-MM-DD' date in zone. */
function dateToMs(date, zone) {
  const [y, m, d] = date.split('-').map(Number);
  return wallToMs(Date.UTC(y, m - 1, d), zone);
}

// ---- ICS parsing ----------------------------------------------------------

function unescapeText(s) {
  return s.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

function parseLine(line) {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(';');
  const params = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

/** Parses a DATE or DATE-TIME value into { wall, zone, isDate }; wall is wall-clock time encoded as UTC ms. */
function parseDateValue(value, params, defaultZone) {
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, z] = m;
  const isDate = params.VALUE === 'DATE' || hh === undefined;
  const wall = Date.UTC(+y, +mo - 1, +d, isDate ? 0 : +hh, isDate ? 0 : +mi, isDate ? 0 : +(ss ?? 0));
  const zone = isDate ? null : z ? 'UTC' : validZone(params.TZID) ? params.TZID : defaultZone;
  return { wall, zone, isDate };
}

function parseDuration(value) {
  const m = value.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+(w ?? 0) * 7 + +(d ?? 0)) * 24 * 3600 + +(h ?? 0) * 3600 + +(mi ?? 0) * 60 + +(s ?? 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

export function parseIcs(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const cal = { name: '', zone: null, events: [] };
  const stack = [];
  let ev = null;
  const raw = []; // events with unresolved dates; resolved once X-WR-TIMEZONE is known

  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      stack.push(p.value.toUpperCase());
      if (p.value.toUpperCase() === 'VEVENT' && stack.length === 2) ev = { props: [] };
      continue;
    }
    if (p.name === 'END') {
      const top = stack.pop();
      if (top === 'VEVENT' && ev && stack.length === 1) {
        raw.push(ev);
        ev = null;
      }
      continue;
    }
    if (stack.length === 1 && stack[0] === 'VCALENDAR') {
      if (p.name === 'X-WR-CALNAME') cal.name = unescapeText(p.value);
      if (p.name === 'X-WR-TIMEZONE' && validZone(p.value.trim())) cal.zone = p.value.trim();
    } else if (ev && stack.length === 2 && stack[1] === 'VEVENT') {
      ev.props.push(p);
    }
  }

  for (const { props } of raw) {
    const e = { exdates: [], rdates: [] };
    for (const p of props) {
      switch (p.name) {
        case 'UID': e.uid = p.value; break;
        case 'SUMMARY': e.title = unescapeText(p.value); break;
        case 'LOCATION': e.location = unescapeText(p.value); break;
        case 'DESCRIPTION': e.description = unescapeText(p.value); break;
        case 'STATUS': e.status = p.value.toUpperCase(); break;
        case 'RRULE': e.rrule = p.value; break;
        case 'DTSTART': e.start = parseDateValue(p.value, p.params, cal.zone); break;
        case 'DTEND': e.end = parseDateValue(p.value, p.params, cal.zone); break;
        case 'DURATION': e.duration = parseDuration(p.value); break;
        case 'RECURRENCE-ID': e.recurrenceId = parseDateValue(p.value, p.params, cal.zone); break;
        case 'EXDATE':
        case 'RDATE':
          for (const v of p.value.split(',')) {
            const d = parseDateValue(v, p.params, cal.zone);
            if (d) (p.name === 'EXDATE' ? e.exdates : e.rdates).push(d);
          }
          break;
      }
    }
    if (e.start) cal.events.push(e);
  }
  return cal;
}

// ---- Recurrence -------------------------------------------------------------

function parseRule(text) {
  const r = {};
  for (const part of text.split(';')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) r[k.toUpperCase()] = v;
  }
  const list = (s) => (s ? s.split(',').map(Number).filter((n) => Number.isFinite(n) && n !== 0) : []);
  return {
    freq: r.FREQ,
    interval: Math.max(1, Number(r.INTERVAL) || 1),
    count: r.COUNT ? Number(r.COUNT) : Infinity,
    until: r.UNTIL ? parseDateValue(r.UNTIL, {}, null) : null,
    byDay: (r.BYDAY ? r.BYDAY.split(',') : [])
      .map((s) => s.trim().match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/))
      .filter(Boolean)
      .map((m) => ({ n: m[1] ? Number(m[1]) : 0, wd: WEEKDAYS.indexOf(m[2]) })),
    byMonthDay: list(r.BYMONTHDAY),
    byMonth: list(r.BYMONTH),
    bySetPos: list(r.BYSETPOS),
    wkst: WEEKDAYS.indexOf(r.WKST ?? 'MO'),
  };
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Candidate days (UTC ms at midnight) of one month for a MONTHLY/YEARLY rule. */
function monthDays(y, m, rule, startDay) {
  const dim = daysInMonth(y, m);
  let days;
  if (rule.byMonthDay.length) {
    days = rule.byMonthDay.map((d) => (d > 0 ? d : dim + d + 1)).filter((d) => d >= 1 && d <= dim);
  } else if (!rule.byDay.length) {
    days = startDay <= dim ? [startDay] : [];
  } else {
    days = null;
  }
  if (rule.byDay.length) {
    const matches = new Set();
    for (const { n, wd } of rule.byDay) {
      const all = [];
      for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, m, d)).getUTCDay() === wd) all.push(d);
      if (n === 0) all.forEach((d) => matches.add(d));
      else {
        const pick = n > 0 ? all[n - 1] : all[all.length + n];
        if (pick) matches.add(pick);
      }
    }
    days = days ? days.filter((d) => matches.has(d)) : [...matches];
  }
  return [...new Set(days)].sort((a, b) => a - b).map((d) => Date.UTC(y, m, d));
}

function applySetPos(days, rule) {
  if (!rule.bySetPos.length) return days;
  return rule.bySetPos
    .map((p) => (p > 0 ? days[p - 1] : days[days.length + p]))
    .filter((d) => d !== undefined)
    .sort((a, b) => a - b);
}

/**
 * Yields occurrence start times (wall clock, encoded as UTC ms) of a recurring
 * event, in order, from DTSTART until the rule ends or limitWall is passed.
 */
function* expandRule(ruleText, start, limitWall) {
  const rule = parseRule(ruleText);
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)) {
    yield start.wall;
    return;
  }
  const timeOfDay = start.wall % DAY;
  const startDay = start.wall - timeOfDay;
  const s = new Date(startDay);
  const sy = s.getUTCFullYear();
  const sm = s.getUTCMonth();
  const sd = s.getUTCDate();
  const untilOk = (wall) => {
    if (!rule.until) return true;
    if (rule.until.zone === 'UTC' && start.zone !== null) return wallToMs(wall, start.zone) <= rule.until.wall;
    return wall <= rule.until.wall + (rule.until.isDate ? DAY - 1 : 0);
  };
  const monthOk = (day) => !rule.byMonth.length || rule.byMonth.includes(new Date(day).getUTCMonth() + 1);

  let emitted = 0;
  for (let k = 0; k < 50_000; k++) {
    let days;
    let periodStart;
    if (rule.freq === 'DAILY') {
      periodStart = startDay + k * rule.interval * DAY;
      const dt = new Date(periodStart);
      const ok =
        monthOk(periodStart) &&
        (!rule.byMonthDay.length ||
          rule.byMonthDay.some((d) => d === dt.getUTCDate() || dim(dt) + d + 1 === dt.getUTCDate())) &&
        (!rule.byDay.length || rule.byDay.some((b) => b.wd === dt.getUTCDay()));
      days = ok ? [periodStart] : [];
    } else if (rule.freq === 'WEEKLY') {
      const weekStart = startDay - ((s.getUTCDay() - rule.wkst + 7) % 7) * DAY;
      periodStart = weekStart + k * rule.interval * 7 * DAY;
      const wds = rule.byDay.length ? rule.byDay.map((b) => b.wd) : [s.getUTCDay()];
      days = wds
        .map((wd) => periodStart + ((wd - rule.wkst + 7) % 7) * DAY)
        .filter(monthOk)
        .sort((a, b) => a - b);
      days = applySetPos([...new Set(days)], rule);
    } else if (rule.freq === 'MONTHLY') {
      const total = sm + k * rule.interval;
      const y = sy + Math.floor(total / 12);
      const m = total % 12;
      periodStart = Date.UTC(y, m, 1);
      days = monthOk(periodStart) ? applySetPos(monthDays(y, m, rule, sd), rule) : [];
    } else {
      const y = sy + k * rule.interval;
      periodStart = Date.UTC(y, 0, 1);
      const months = rule.byMonth.length ? rule.byMonth.map((m) => m - 1) : [sm];
      days = applySetPos(
        months.flatMap((m) =>
          rule.byDay.length || rule.byMonthDay.length ? monthDays(y, m, rule, sd) : sd <= daysInMonth(y, m) ? [Date.UTC(y, m, sd)] : [],
        ).sort((a, b) => a - b),
        rule,
      );
    }
    // Every candidate day falls on or after its period's first day.
    if (periodStart > limitWall) return;
    for (const day of days) {
      const wall = day + timeOfDay;
      if (wall < start.wall) continue;
      if (!untilOk(wall) || emitted >= rule.count) return;
      if (wall > limitWall) return;
      emitted++;
      yield wall;
    }
  }
}

function dim(dt) {
  return daysInMonth(dt.getUTCFullYear(), dt.getUTCMonth());
}

const isoDate = (wall) => new Date(wall).toISOString().slice(0, 10);
const instanceKey = (d, allDay, zone) => (allDay ? isoDate(d.wall) : String(wallToMs(d.wall, d.zone ?? zone)));

/**
 * Expands parsed events into concrete instances overlapping [fromMs, toMs).
 * All-day events are placed using displayZone (the screen's time zone).
 */
export function eventsBetween(cal, fromMs, toMs, displayZone) {
  const out = [];
  const overrides = new Map(); // uid -> Map(instanceKey -> event)
  for (const e of cal.events) {
    if (!e.recurrenceId || !e.uid) continue;
    if (!overrides.has(e.uid)) overrides.set(e.uid, new Map());
    overrides.get(e.uid).set(instanceKey(e.recurrenceId, e.recurrenceId.isDate, cal.zone), e);
  }
  // Generous wall-clock bound: zones are at most ~14h off UTC.
  const limitWall = toMs + 2 * DAY;

  const push = (e, wall) => {
    const allDay = e.start.isDate;
    const zone = e.start.zone ?? cal.zone;
    let length;
    if (e.end) length = e.end.wall - e.start.wall;
    else if (e.duration !== null && e.duration !== undefined) length = e.duration;
    else length = allDay ? DAY : 0;
    length = Math.max(0, length);
    if (allDay) {
      const days = Math.max(1, Math.round(length / DAY));
      const start = isoDate(wall);
      const end = isoDate(wall + days * DAY);
      if (dateToMs(start, displayZone) < toMs && dateToMs(end, displayZone) > fromMs) {
        out.push({ e, allDay, start, end });
      }
    } else {
      const start = wallToMs(wall, zone);
      const end = e.end ? wallToMs(wall + length, e.end.zone ?? zone) : start + length;
      if (start < toMs && (end > fromMs || (end === start && start >= fromMs))) {
        out.push({ e, allDay, start, end: Math.max(start, end) });
      }
    }
  };

  for (const e of cal.events) {
    if (e.recurrenceId) {
      if (e.status !== 'CANCELLED') push(e, e.start.wall);
      continue;
    }
    if (e.status === 'CANCELLED') continue;
    const zone = e.start.zone ?? cal.zone;
    const allDay = e.start.isDate;
    if (!e.rrule && !e.rdates.length) {
      push(e, e.start.wall);
      continue;
    }
    const skip = new Set(e.exdates.map((d) => instanceKey(d, allDay, zone)));
    const moved = overrides.get(e.uid);
    const walls = e.rrule ? [...expandRule(e.rrule, e.start, limitWall)] : [e.start.wall];
    for (const d of e.rdates) if (d.wall <= limitWall) walls.push(d.wall);
    for (const wall of new Set(walls)) {
      const key = instanceKey({ wall, zone }, allDay, zone);
      if (skip.has(key) || moved?.has(key)) continue;
      push(e, wall);
    }
  }
  return out;
}

// ---- Service ----------------------------------------------------------------

function normalizeConfig(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.calendars) ? raw.calendars : [];
  return list
    .filter((c) => c && typeof c.url === 'string' && c.url.trim())
    .map((c, i) => {
      const url = c.url.trim().replace(/^webcal:\/\//i, 'https://');
      return {
        id: crypto.createHash('sha256').update(url).digest('hex').slice(0, 12),
        name: typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 40) : `Calendar ${i + 1}`,
        color: typeof c.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(c.color.trim()) ? c.color.trim() : PALETTE[i % PALETTE.length],
        url,
      };
    });
}

export function createCalendar({ configFile, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const feeds = new Map(); // url -> { at, cal, error, errorAt }
  const inflight = new Map();

  async function loadConfig() {
    let text;
    try {
      text = await fs.readFile(configFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    try {
      return normalizeConfig(JSON.parse(text));
    } catch {
      throw new CalendarError(500, 'calendars.json is not valid JSON');
    }
  }

  async function download(url) {
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { Accept: 'text/calendar' } });
    } catch (err) {
      throw new Error(`unreachable (${err.message})`);
    }
    if (!res.ok) {
      throw new Error(res.status === 404 ? 'link not found (was the secret address reset?)' : `returned ${res.status}`);
    }
    const text = await res.text();
    if (text.length > MAX_FEED) throw new Error('feed too large');
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('not an iCal feed (use the "secret address in iCal format")');
    return parseIcs(text);
  }

  async function feed(url) {
    const cached = feeds.get(url);
    const fresh = cached && (cached.error ? now() - cached.errorAt < 60_000 : now() - cached.at < TTL);
    if (fresh) return cached;
    if (!inflight.has(url)) {
      inflight.set(
        url,
        download(url)
          .then((cal) => feeds.set(url, { at: now(), cal, error: null }))
          // Keep serving the last good copy while the feed is failing.
          .catch((err) => feeds.set(url, { ...(cached ?? { at: 0, cal: null }), error: err.message, errorAt: now() }))
          .finally(() => inflight.delete(url)),
      );
    }
    await inflight.get(url);
    return feeds.get(url);
  }

  return {
    async get({ from, to, tz } = {}) {
      const fromMs = Number(from);
      const toMs = Number(to);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
        throw new CalendarError(400, 'from and to must be millisecond timestamps, from < to');
      }
      if (toMs - fromMs > MAX_SPAN_DAYS * DAY) throw new CalendarError(400, `At most ${MAX_SPAN_DAYS} days at a time`);
      const zone = validZone(tz) ? tz : Intl.DateTimeFormat().resolvedOptions().timeZone;

      const config = await loadConfig();
      if (!config) return { configured: false, calendars: [], events: [] };

      const calendars = [];
      const events = [];
      await Promise.all(
        config.map(async (c) => {
          const f = await feed(c.url);
          calendars.push({
            id: c.id,
            name: c.name,
            color: c.color,
            updated: f.at || null,
            error: f.error ? `${c.name}: ${f.error}` : null,
          });
          if (!f.cal) return;
          for (const x of eventsBetween(f.cal, fromMs, toMs, zone)) {
            events.push({
              id: `${c.id}:${x.e.uid ?? ''}:${x.start}`,
              calendar: c.id,
              title: x.e.title?.trim() || '(No title)',
              location: x.e.location?.trim() || '',
              description: (x.e.description ?? '').trim().slice(0, 1000),
              allDay: x.allDay,
              start: x.start,
              end: x.end,
            });
          }
        }),
      );
      const order = new Map(config.map((c, i) => [c.id, i]));
      calendars.sort((a, b) => order.get(a.id) - order.get(b.id));
      const startMs = (e) => (e.allDay ? dateToMs(e.start, zone) : e.start);
      events.sort((a, b) => startMs(a) - startMs(b) || Number(b.allDay) - Number(a.allDay) || a.title.localeCompare(b.title));
      return { configured: true, calendars, events };
    },
  };
}
