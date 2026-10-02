// Timers and alarms. State lives here, on the Pi, so a ringing alarm doesn't
// depend on a browser tab being open or a page being visible, and survives
// reloads and reboots. The server clock decides when things fire; screens just
// follow the `timers` SSE event and play the sound.

export const TONES = ['chime', 'beep', 'bells', 'marimba', 'rise', 'pulse'];

const DEFAULT_SETTINGS = { snoozeMinutes: 9, sound: 'chime', volume: 80, ringMinutes: 10, fadeIn: true };
const MAX_TIMERS = 20;
const MAX_ALARMS = 50;
const MAX_DURATION_MS = 100 * 3600 * 1000;
/** Something due longer ago than this (the Pi was off) is reported as missed instead of ringing. */
const GRACE_MS = 10 * 60 * 1000;

export class TimersError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new TimersError(400, message);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function cleanLabel(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw bad('label must be text');
  return v.trim().slice(0, 60);
}

function cleanSound(v) {
  if (v === undefined || v === null || v === '') return null;
  if (!TONES.includes(v)) throw bad(`sound must be one of ${TONES.join(', ')}`);
  return v;
}

function cleanDays(v) {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((d) => isInt(d, 0, 6))) throw bad('days must be weekday numbers 0-6 (0 = Sunday)');
  return [...new Set(v)].sort();
}

/** Next local time (the Pi's time zone) after `from` that matches the alarm's time and days. */
export function nextOccurrence({ hour, minute, days }, from) {
  for (let i = 0; i <= 7; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() > from && (days.length === 0 || days.includes(d.getDay()))) return d.getTime();
  }
  return null;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (h) parts.push(`${h} hr`);
  if (m) parts.push(`${m} min`);
  if (s % 60 || parts.length === 0) parts.push(`${s % 60} sec`);
  return parts.join(' ');
}

const formatClock = (hour, minute) =>
  new Date(2000, 0, 1, hour, minute).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function createTimers({ load, save, notify, broadcast, now = Date.now, tickMs = 1000 }) {
  let state = { settings: { ...DEFAULT_SETTINGS }, timers: [], alarms: [] };
  let saving = Promise.resolve();
  let counter = 0;
  const newId = (prefix) => `${prefix}-${now().toString(36)}-${(counter++).toString(36)}`;

  const ready = (async () => {
    const saved = await load();
    if (saved && typeof saved === 'object') {
      state = {
        settings: { ...DEFAULT_SETTINGS, ...saved.settings },
        timers: Array.isArray(saved.timers) ? saved.timers : [],
        alarms: Array.isArray(saved.alarms) ? saved.alarms : [],
      };
    }
    tick();
  })();

  function snapshot() {
    return { now: now(), settings: state.settings, timers: state.timers, alarms: state.alarms };
  }

  function commit() {
    const copy = structuredClone(state);
    saving = saving.then(() => save(copy)).catch((err) => console.error('Saving timers failed', err));
    broadcast(snapshot());
  }

  const alarmTitle = (a) => a.label || 'Alarm';
  const timerTitle = (t) => t.label || 'Timer';

  function ring(item, kind, t) {
    item.state = 'ringing';
    item.ringingSince = t;
    item.snoozeUntil = null;
    notify(
      kind === 'alarm'
        ? { title: `⏰ ${alarmTitle(item)}`, body: `Alarm · ${formatClock(item.hour, item.minute)}`, level: 'alert' }
        : { title: `⏱️ ${timerTitle(item)} is done`, body: `${formatDuration(item.durationMs)} timer`, level: 'alert' },
    );
  }

  /** Back to waiting for the next occurrence (repeating) or off (one-time). */
  function settleAlarm(a, t) {
    a.state = 'idle';
    a.ringingSince = null;
    a.snoozeUntil = null;
    a.nextAt = a.enabled ? nextOccurrence(a, t) : null;
  }

  function missed(kind, item, why) {
    const title = kind === 'alarm' ? `⏰ ${alarmTitle(item)}` : `⏱️ ${timerTitle(item)}`;
    notify({ title: `${title} ${why}`, body: kind === 'alarm' ? `Alarm · ${formatClock(item.hour, item.minute)}` : `${formatDuration(item.durationMs)} timer`, level: 'warning' });
  }

  function tick() {
    const t = now();
    const ringLimit = state.settings.ringMinutes * 60000;
    let changed = false;

    state.timers = state.timers.filter((timer) => {
      const due = timer.state === 'running' ? timer.endsAt : timer.state === 'snoozed' ? timer.snoozeUntil : null;
      if (due !== null && due <= t) {
        changed = true;
        if (t - due > GRACE_MS) {
          missed('timer', timer, 'went off while the display was off');
          return false;
        }
        ring(timer, 'timer', t);
      } else if (timer.state === 'ringing' && t - timer.ringingSince >= ringLimit) {
        changed = true;
        missed('timer', timer, 'rang without an answer');
        return false;
      }
      return true;
    });

    for (const a of state.alarms) {
      if (a.state === 'idle' && a.enabled && a.nextAt !== null && a.nextAt <= t) {
        changed = true;
        const late = t - a.nextAt > GRACE_MS;
        // Line up the following occurrence now, so the list already shows it.
        if (a.days.length === 0) a.enabled = false;
        a.nextAt = a.enabled ? nextOccurrence(a, t) : null;
        if (late) missed('alarm', a, 'went off while the display was off');
        else ring(a, 'alarm', t);
      } else if (a.state === 'snoozed' && a.snoozeUntil <= t) {
        changed = true;
        if (t - a.snoozeUntil > GRACE_MS) settleAlarm(a, t);
        else ring(a, 'alarm', t);
      } else if (a.state === 'ringing' && t - a.ringingSince >= ringLimit) {
        changed = true;
        missed('alarm', a, 'rang without an answer');
        settleAlarm(a, t);
      }
    }
    if (changed) commit();
  }

  const interval = setInterval(() => ready.then(tick), tickMs);
  interval.unref?.();

  function findIn(list, id) {
    const item = list.find((x) => x.id === id);
    if (!item) throw new TimersError(404, 'No such timer or alarm');
    return item;
  }

  function snooze(item, t) {
    if (item.state !== 'ringing' && item.state !== 'snoozed') throw new TimersError(409, 'It is not ringing');
    item.state = 'snoozed';
    item.ringingSince = null;
    item.snoozeUntil = t + state.settings.snoozeMinutes * 60000;
  }

  function alarmFields(body, base) {
    const a = { ...base };
    if (body.hour !== undefined || !base) {
      if (!isInt(body.hour, 0, 23)) throw bad('hour must be 0-23');
      a.hour = body.hour;
    }
    if (body.minute !== undefined || !base) {
      if (!isInt(body.minute, 0, 59)) throw bad('minute must be 0-59');
      a.minute = body.minute;
    }
    if (body.days !== undefined || !base) a.days = cleanDays(body.days);
    if (body.label !== undefined || !base) a.label = cleanLabel(body.label);
    if (body.sound !== undefined || !base) a.sound = cleanSound(body.sound);
    if (body.enabled !== undefined || !base) a.enabled = body.enabled === undefined ? true : Boolean(body.enabled);
    return a;
  }

  function updateSettings(body) {
    const s = { ...state.settings };
    if (body.snoozeMinutes !== undefined) {
      if (!isInt(body.snoozeMinutes, 1, 60)) throw bad('snoozeMinutes must be 1-60');
      s.snoozeMinutes = body.snoozeMinutes;
    }
    if (body.ringMinutes !== undefined) {
      if (!isInt(body.ringMinutes, 1, 60)) throw bad('ringMinutes must be 1-60');
      s.ringMinutes = body.ringMinutes;
    }
    if (body.volume !== undefined) {
      if (!isInt(body.volume, 0, 100)) throw bad('volume must be 0-100');
      s.volume = body.volume;
    }
    if (body.sound !== undefined) s.sound = cleanSound(body.sound) ?? DEFAULT_SETTINGS.sound;
    if (body.fadeIn !== undefined) s.fadeIn = Boolean(body.fadeIn);
    state.settings = s;
  }

  /**
   * Handles /api/timers[...] and /api/alarms[...]; parts is the path after /api.
   * Returns the full snapshot so the caller's screen can update without waiting for SSE.
   */
  async function handle(method, parts, body) {
    await ready;
    body = body ?? {};
    const [resource, id, action] = parts;
    const t = now();

    if (method === 'GET' && !id) return snapshot();

    if (resource === 'timers') {
      if (id === 'settings' && method === 'PUT' && !action) {
        updateSettings(body);
      } else if (!id && method === 'POST') {
        if (!isInt(body.durationMs, 1000, MAX_DURATION_MS)) throw bad('durationMs must be between 1 second and 100 hours');
        if (state.timers.length >= MAX_TIMERS) throw new TimersError(409, `At most ${MAX_TIMERS} timers`);
        state.timers.push({
          id: newId('timer'),
          label: cleanLabel(body.label),
          sound: cleanSound(body.sound),
          durationMs: body.durationMs,
          state: 'running',
          endsAt: t + body.durationMs,
          remainingMs: null,
          ringingSince: null,
          snoozeUntil: null,
        });
      } else if (id && method === 'DELETE' && !action) {
        findIn(state.timers, id);
        state.timers = state.timers.filter((x) => x.id !== id);
      } else if (id && method === 'POST') {
        const timer = findIn(state.timers, id);
        if (action === 'pause') {
          if (timer.state !== 'running') throw new TimersError(409, 'Timer is not running');
          Object.assign(timer, { state: 'paused', remainingMs: Math.max(0, timer.endsAt - t), endsAt: null });
        } else if (action === 'resume') {
          if (timer.state !== 'paused') throw new TimersError(409, 'Timer is not paused');
          Object.assign(timer, { state: 'running', endsAt: t + timer.remainingMs, remainingMs: null });
        } else if (action === 'add') {
          if (!isInt(body.ms, 1000, MAX_DURATION_MS)) throw bad('ms must be between 1 second and 100 hours');
          if (timer.state === 'running') timer.endsAt += body.ms;
          else if (timer.state === 'paused') timer.remainingMs += body.ms;
          // "+1 min" on a ringing timer: stop ringing and count down again.
          else Object.assign(timer, { state: 'running', endsAt: t + body.ms, ringingSince: null, snoozeUntil: null });
        } else if (action === 'restart') {
          Object.assign(timer, { state: 'running', endsAt: t + timer.durationMs, remainingMs: null, ringingSince: null, snoozeUntil: null });
        } else if (action === 'snooze') {
          snooze(timer, t);
        } else if (action === 'dismiss') {
          state.timers = state.timers.filter((x) => x.id !== id);
        } else throw new TimersError(404, 'Not found');
      } else throw new TimersError(404, 'Not found');
    } else if (resource === 'alarms') {
      if (!id && method === 'POST') {
        if (state.alarms.length >= MAX_ALARMS) throw new TimersError(409, `At most ${MAX_ALARMS} alarms`);
        const a = { id: newId('alarm'), ...alarmFields(body, null) };
        settleAlarm(a, t);
        state.alarms.push(a);
      } else if (id && method === 'PUT' && !action) {
        const a = findIn(state.alarms, id);
        Object.assign(a, alarmFields(body, a));
        // Any edit (including switching it off) stops it ringing and re-plans it.
        settleAlarm(a, t);
      } else if (id && method === 'DELETE' && !action) {
        findIn(state.alarms, id);
        state.alarms = state.alarms.filter((x) => x.id !== id);
      } else if (id && method === 'POST' && action === 'snooze') {
        snooze(findIn(state.alarms, id), t);
      } else if (id && method === 'POST' && action === 'dismiss') {
        settleAlarm(findIn(state.alarms, id), t);
      } else throw new TimersError(404, 'Not found');
    } else throw new TimersError(404, 'Not found');

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
