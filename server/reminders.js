// Reminders: things to do at a date and time, once or on a repeat (every N
// hours, days, weeks on chosen weekdays, months or years). Like timers, the
// server clock (the Pi's local time zone) decides when one is due, so it fires
// whether or not a screen is showing the Reminders tile. A due reminder stays
// "due" until someone taps Done or Snooze; screens follow the `reminders` SSE
// event and play the sound on `reminder-sound`.
import { TONES } from './timers.js';

const DEFAULT_SETTINGS = { sound: 'marimba', volume: 80, repeats: 3, nagMinutes: 0 };
const REPEATS = ['none', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'];
const MAX_REMINDERS = 200;
/** Something due longer ago than this (the Pi was off) shows as due, but silently. */
const GRACE_MS = 10 * 60 * 1000;
/** Stop re-chiming a due reminder after this long. */
const NAG_LIMIT_MS = 60 * 60 * 1000;
/** Completed one-time reminders are cleared out after this long. */
const KEEP_DONE_MS = 30 * 24 * 3600 * 1000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export class RemindersError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new RemindersError(400, message);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function parseDate(v, name) {
  const m = typeof v === 'string' && DATE_RE.exec(v);
  if (!m) throw bad(`${name} must be a date like 2026-10-03`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const check = new Date(y, mo, d);
  if (check.getFullYear() !== y || check.getMonth() !== mo || check.getDate() !== d) throw bad(`${name} is not a real date`);
  return v;
}

const ymd = (s) => s.split('-').map(Number);
const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Whole calendar days from a to b, immune to DST (both are local Y-M-D). */
const dayNumber = (y, m, d) => Math.round(Date.UTC(y, m, d) / 86400000);
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

/** Local time (the Pi's zone) of the first occurrence. */
export function startTime(r) {
  const [y, m, d] = ymd(r.date);
  return new Date(y, m - 1, d, r.hour, r.minute, 0, 0).getTime();
}

/**
 * The first occurrence of r strictly after `from`, or null when there are no more.
 * Monthly and yearly reminders on a day a month lacks (31st, Feb 29) use that month's last day.
 */
export function nextOccurrence(r, from) {
  const start = startTime(r);
  const [sy, sm, sd] = ymd(r.date);
  const n = r.interval || 1;
  const untilKey = r.until || null;
  const ok = (t) => (t === null || untilKey === null || dateKey(new Date(t)) <= untilKey ? t : null);
  const at = (y, m, d) => new Date(y, m, d, r.hour, r.minute, 0, 0).getTime();

  if (r.repeat === 'none') return ok(start > from ? start : null);

  if (r.repeat === 'hourly') {
    const step = n * 3600000;
    if (start > from) return ok(start);
    return ok(start + (Math.floor((from - start) / step) + 1) * step);
  }

  if (r.repeat === 'daily' || r.repeat === 'weekly') {
    const f = new Date(Math.max(from, start));
    const startDay = dayNumber(sy, sm - 1, sd);
    // Weeks run Sunday to Saturday; "every 2 weeks" counts from the start date's week.
    const startWeek = Math.floor((startDay + 4) / 7); // day 0 (1970-01-01) was a Thursday
    const days = r.days?.length ? r.days : [new Date(start).getDay()];
    const limit = r.repeat === 'daily' ? n + 1 : n * 7 + 7;
    for (let i = 0; i <= limit; i++) {
      const y = f.getFullYear();
      const m = f.getMonth();
      const d = f.getDate() + i;
      const t = at(y, m, d);
      if (t <= from || t < start) continue;
      const day = dayNumber(y, m, d);
      if (r.repeat === 'daily') {
        if ((day - startDay) % n === 0) return ok(t);
      } else if (days.includes(new Date(t).getDay()) && (Math.floor((day + 4) / 7) - startWeek) % n === 0) {
        return ok(t);
      }
    }
    return null;
  }

  if (r.repeat === 'monthly' || r.repeat === 'yearly') {
    const step = r.repeat === 'monthly' ? n : n * 12;
    const f = new Date(from);
    const behind = (f.getFullYear() - sy) * 12 + f.getMonth() - (sm - 1);
    let k = Math.max(0, Math.floor(behind / step));
    for (let tries = 0; tries < 3; tries++, k++) {
      const total = sm - 1 + k * step;
      const y = sy + Math.floor(total / 12);
      const m = total % 12;
      const t = at(y, m, Math.min(sd, daysInMonth(y, m)));
      if (t > from) return ok(t);
    }
    return null;
  }
  return null;
}

function cleanText(v, name, max) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw bad(`${name} must be text`);
  return v.trim().slice(0, max);
}

function cleanSound(v) {
  if (v === undefined || v === null || v === '') return null;
  if (!TONES.includes(v)) throw bad(`sound must be one of ${TONES.join(', ')}`);
  return v;
}

const formatClock = (hour, minute) =>
  new Date(2000, 0, 1, hour, minute).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function createReminders({ load, save, notify, broadcast, sound, now = Date.now, tickMs = 1000 }) {
  let state = { settings: { ...DEFAULT_SETTINGS }, reminders: [] };
  let saving = Promise.resolve();
  let counter = 0;
  const newId = () => `rem-${now().toString(36)}-${(counter++).toString(36)}`;

  const ready = (async () => {
    const saved = await load();
    if (saved && typeof saved === 'object') {
      state = {
        settings: { ...DEFAULT_SETTINGS, ...saved.settings },
        reminders: Array.isArray(saved.reminders) ? saved.reminders : [],
      };
    }
    tick();
  })();

  function snapshot() {
    return { now: now(), settings: state.settings, reminders: state.reminders };
  }

  function commit() {
    const copy = structuredClone(state);
    saving = saving.then(() => save(copy)).catch((err) => console.error('Saving reminders failed', err));
    broadcast(snapshot());
  }

  function chime(r) {
    const s = state.settings;
    sound({ id: r.id, sound: r.sound ?? s.sound, volume: s.volume, repeats: s.repeats });
  }

  /** Marks r due for the occurrence at `occurrence`; quietly when it was missed while the Pi was off. */
  function fire(r, occurrence, t) {
    const late = t - occurrence > GRACE_MS;
    r.state = 'due';
    r.dueAt = occurrence;
    r.snoozeUntil = null;
    r.lastSoundAt = t;
    const when = new Date(occurrence);
    const sameDay = when.toDateString() === new Date(t).toDateString();
    const time = formatClock(when.getHours(), when.getMinutes());
    const at = sameDay ? time : `${when.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
    notify({
      title: `📌 ${r.title}`,
      body: [late ? `Missed while the display was off (${at})` : at, r.notes].filter(Boolean).join(' · '),
      level: late ? 'warning' : 'alert',
    });
    if (!late) chime(r);
  }

  /** After Done, an edit or a test: not due, waiting for the next occurrence (if any). */
  function settle(r, t) {
    r.state = 'idle';
    r.dueAt = null;
    r.snoozeUntil = null;
    r.lastSoundAt = null;
    r.nextAt = r.enabled && !r.completedAt ? nextOccurrence(r, t) : null;
  }

  function tick() {
    const t = now();
    const s = state.settings;
    let changed = false;

    for (const r of state.reminders) {
      if (r.state === 'snoozed' && r.snoozeUntil <= t) {
        changed = true;
        fire(r, r.snoozeUntil, t);
      } else if (r.enabled && r.nextAt !== null && r.nextAt <= t) {
        changed = true;
        const occurrence = r.nextAt;
        // Line up the following occurrence now (skipping any the Pi slept through).
        r.nextAt = nextOccurrence(r, t);
        fire(r, occurrence, t);
      } else if (
        r.state === 'due' &&
        s.nagMinutes > 0 &&
        r.lastSoundAt !== null &&
        t - r.lastSoundAt >= s.nagMinutes * 60000 &&
        t - r.dueAt < NAG_LIMIT_MS
      ) {
        r.lastSoundAt = t;
        chime(r);
      }
    }

    const before = state.reminders.length;
    state.reminders = state.reminders.filter((r) => !r.completedAt || t - r.completedAt < KEEP_DONE_MS);
    if (state.reminders.length !== before) changed = true;
    if (changed) commit();
  }

  const interval = setInterval(() => ready.then(tick), tickMs);
  interval.unref?.();

  function find(id) {
    const r = state.reminders.find((x) => x.id === id);
    if (!r) throw new RemindersError(404, 'No such reminder');
    return r;
  }

  function fields(body, base) {
    const r = { ...base };
    const has = (k) => body[k] !== undefined || !base;
    if (has('title')) {
      r.title = cleanText(body.title, 'title', 120);
      if (!r.title) throw bad('title is required');
    }
    if (has('notes')) r.notes = cleanText(body.notes, 'notes', 500);
    if (has('date')) r.date = parseDate(body.date, 'date');
    if (has('hour')) {
      if (!isInt(body.hour, 0, 23)) throw bad('hour must be 0-23');
      r.hour = body.hour;
    }
    if (has('minute')) {
      if (!isInt(body.minute, 0, 59)) throw bad('minute must be 0-59');
      r.minute = body.minute;
    }
    if (has('repeat')) {
      const v = body.repeat ?? 'none';
      if (!REPEATS.includes(v)) throw bad(`repeat must be one of ${REPEATS.join(', ')}`);
      r.repeat = v;
    }
    if (has('interval')) {
      const v = body.interval ?? 1;
      if (!isInt(v, 1, 99)) throw bad('interval must be 1-99');
      r.interval = v;
    }
    if (has('days')) {
      const v = body.days ?? [];
      if (!Array.isArray(v) || !v.every((d) => isInt(d, 0, 6))) throw bad('days must be weekday numbers 0-6 (0 = Sunday)');
      r.days = [...new Set(v)].sort();
    }
    if (has('until')) r.until = body.until ? parseDate(body.until, 'until') : null;
    if (has('sound')) r.sound = cleanSound(body.sound);
    if (has('enabled')) r.enabled = body.enabled === undefined ? true : Boolean(body.enabled);
    if (r.until && r.until < r.date) throw bad('The end date is before the start date');
    return r;
  }

  function updateSettings(body) {
    const s = { ...state.settings };
    if (body.sound !== undefined) s.sound = cleanSound(body.sound) ?? DEFAULT_SETTINGS.sound;
    if (body.volume !== undefined) {
      if (!isInt(body.volume, 0, 100)) throw bad('volume must be 0-100');
      s.volume = body.volume;
    }
    if (body.repeats !== undefined) {
      if (!isInt(body.repeats, 1, 10)) throw bad('repeats must be 1-10');
      s.repeats = body.repeats;
    }
    if (body.nagMinutes !== undefined) {
      if (!isInt(body.nagMinutes, 0, 60)) throw bad('nagMinutes must be 0-60');
      s.nagMinutes = body.nagMinutes;
    }
    state.settings = s;
  }

  /**
   * Handles /api/reminders[...]; parts is the path after /api.
   * Returns the full snapshot so the caller's screen can update without waiting for SSE.
   */
  async function handle(method, parts, body) {
    await ready;
    body = body ?? {};
    const [, id, action] = parts;
    const t = now();

    if (method === 'GET' && !id) return snapshot();

    if (id === 'settings' && method === 'PUT' && !action) {
      updateSettings(body);
    } else if (id === 'test' && method === 'POST' && !action) {
      // A throwaway reminder that comes due in 5 seconds, for checking the sound on the Pi.
      const d = new Date(t);
      const r = {
        id: newId(),
        ...fields({ title: 'Test reminder', notes: 'Tap Done to remove it', date: dateKey(d), hour: d.getHours(), minute: d.getMinutes(), repeat: 'none' }, null),
        test: true,
        createdAt: t,
        completedAt: null,
      };
      settle(r, t);
      Object.assign(r, { enabled: false, nextAt: null, state: 'snoozed', snoozeUntil: t + 5000 });
      state.reminders.push(r);
    } else if (!id && method === 'POST') {
      if (state.reminders.length >= MAX_REMINDERS) throw new RemindersError(409, `At most ${MAX_REMINDERS} reminders`);
      const r = { id: newId(), ...fields(body, null), createdAt: t, completedAt: null };
      settle(r, t);
      state.reminders.push(r);
    } else if (!id && method === 'DELETE') {
      // Clear the completed list.
      state.reminders = state.reminders.filter((r) => !r.completedAt);
    } else if (id && method === 'PUT' && !action) {
      const r = find(id);
      Object.assign(r, fields(body, r));
      // Editing a finished one-time reminder (e.g. moving its date) brings it back.
      if (body.enabled !== false) r.completedAt = null;
      settle(r, t);
    } else if (id && method === 'DELETE' && !action) {
      find(id);
      state.reminders = state.reminders.filter((r) => r.id !== id);
    } else if (id && method === 'POST' && action === 'done') {
      const r = find(id);
      if (r.test) {
        state.reminders = state.reminders.filter((x) => x.id !== id);
      } else {
        // A one-time reminder is finished; a repeating one waits for its next time.
        if (r.repeat === 'none' || r.nextAt === null) r.completedAt = t;
        settle(r, t);
      }
    } else if (id && method === 'POST' && action === 'snooze') {
      const r = find(id);
      const minutes = body.minutes ?? 10;
      if (!isInt(minutes, 1, 24 * 60)) throw bad('minutes must be 1-1440');
      if (r.state !== 'due' && r.state !== 'snoozed') throw new RemindersError(409, 'That reminder is not due');
      Object.assign(r, { state: 'snoozed', snoozeUntil: t + minutes * 60000, lastSoundAt: null });
    } else throw new RemindersError(404, 'Not found');

    commit();
    return snapshot();
  }

  return {
    ready,
    handle,
    tick,
    snapshot,
    flush: () => saving,
    stop: () => clearInterval(interval),
  };
}
