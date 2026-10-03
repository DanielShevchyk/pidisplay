// Screen sleep. The Pi keeps running (a Raspberry Pi 4 has no suspend mode that a
// touch could wake), so alarms, timers and reminders still fire; only the screen
// turns off. By default it stays on from 7 AM to 10 PM; outside those hours it
// turns off, a touch wakes it, and it turns off again after a short idle spell.
//
// The screen is powered down with wlopm (wlr output power management, which labwc
// supports), and the kiosk page also goes black, so the screen is dark even when
// wlopm is missing. Touches are read straight from the touchscreen's /dev/input
// node, because Chromium may get no input while its output is off.
import fs from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';

export class SleepError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const DEFAULT_SETTINGS = {
  /** Turn the screen off outside the awake hours below. */
  schedule: true,
  /** Minutes after midnight. */
  wakeAt: 7 * 60,
  sleepAt: 22 * 60,
  /** Outside the awake hours, a touch keeps the screen on this long. */
  nightIdleMinutes: 2,
  /** During the awake hours, turn off after this long without a touch (0 = never). */
  dayIdleMinutes: 0,
};

const TICK_MS = 5000;
const MINUTES_IN_DAY = 24 * 60;

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** True when minute-of-day m falls in the awake window [wakeAt, sleepAt), which may wrap midnight. */
export function inAwakeHours(settings, m) {
  const { wakeAt, sleepAt } = settings;
  if (wakeAt === sleepAt) return true;
  return wakeAt < sleepAt ? m >= wakeAt && m < sleepAt : m >= wakeAt || m < sleepAt;
}

function minuteOfDay(t) {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
}

export function validateSettings(body, current) {
  if (!body || typeof body !== 'object') throw new SleepError(400, 'Expected an object');
  const next = { ...current };
  if (body.schedule !== undefined) {
    if (typeof body.schedule !== 'boolean') throw new SleepError(400, 'schedule must be true or false');
    next.schedule = body.schedule;
  }
  for (const key of ['wakeAt', 'sleepAt']) {
    if (body[key] === undefined) continue;
    if (!isInt(body[key], 0, MINUTES_IN_DAY - 1)) throw new SleepError(400, `${key} must be minutes after midnight`);
    next[key] = body[key];
  }
  if (body.nightIdleMinutes !== undefined) {
    if (!isInt(body.nightIdleMinutes, 1, 120)) throw new SleepError(400, 'nightIdleMinutes must be 1-120');
    next.nightIdleMinutes = body.nightIdleMinutes;
  }
  if (body.dayIdleMinutes !== undefined) {
    if (!isInt(body.dayIdleMinutes, 0, 240)) throw new SleepError(400, 'dayIdleMinutes must be 0-240');
    next.dayIdleMinutes = body.dayIdleMinutes;
  }
  return next;
}

// ---- Screen power (wlopm) ------------------------------------------------

function waylandEnv() {
  const runtime = process.env.XDG_RUNTIME_DIR || (process.getuid ? `/run/user/${process.getuid()}` : '');
  return { runtime, display: process.env.WAYLAND_DISPLAY };
}

/** Finds labwc's socket; the pidisplay service is a system unit, so it has no WAYLAND_DISPLAY of its own. */
async function findWaylandDisplay(runtime) {
  try {
    const names = (await fs.readdir(runtime)).filter((n) => /^wayland-\d+$/.test(n)).sort();
    return names[0] ?? 'wayland-0';
  } catch {
    return 'wayland-0';
  }
}

export function createDisplay({ supported = process.platform === 'linux' } = {}) {
  return {
    supported,
    /** Resolves to null on success or an error message. */
    async setPower(on) {
      if (!supported) return 'Screen power control only works on the Pi';
      const { runtime, display } = waylandEnv();
      const env = { ...process.env, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: display || (await findWaylandDisplay(runtime)) };
      return new Promise((resolve) => {
        execFile('wlopm', [on ? '--on' : '--off', '*'], { env, timeout: 5000 }, (err, _out, stderr) => {
          if (!err) return resolve(null);
          resolve(err.code === 'ENOENT' ? 'wlopm is not installed' : String(stderr || err.message).trim().slice(0, 200));
        });
      });
    },
  };
}

// ---- CPU speed -------------------------------------------------------------

// One policy covers all four cores on a Pi 4. Writing it needs root; deploy/pidisplay-sudoers
// lets dan run exactly `tee` on this file and nothing else.
export const GOVERNOR_FILE = '/sys/devices/system/cpu/cpufreq/policy0/scaling_governor';
const LOW_POWER = 'powersave';
const DEFAULT_GOVERNOR = 'ondemand';

/** Holds the CPU at its lowest speed while the screen sleeps (saves a few tenths of a watt). */
export function createCpu({ supported = process.platform === 'linux', file = GOVERNOR_FILE } = {}) {
  let normal = null;
  let warned = false;
  const read = () => fs.readFile(file, 'utf8').then((s) => s.trim(), () => null);
  const write = (governor) =>
    new Promise((resolve) => {
      const child = spawn('sudo', ['-n', '/usr/bin/tee', file], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => resolve(e.message));
      child.on('close', (code) => resolve(code === 0 ? null : err.trim().slice(0, 200) || `exit ${code}`));
      child.stdin.on('error', () => {});
      child.stdin.end(`${governor}\n`);
    }).then((err) => {
      if (err && !warned) {
        warned = true;
        console.error(`Sleep: couldn't set the CPU to ${governor}: ${err}`);
      }
    });

  return {
    async setLowPower(low) {
      if (!supported) return;
      const current = await read();
      if (!current) return;
      if (low) {
        if (current === LOW_POWER) return;
        normal = current;
        await write(LOW_POWER);
      } else if (current === LOW_POWER) {
        // normal is unknown when the server restarted mid-sleep.
        await write(normal ?? DEFAULT_GOVERNOR);
      }
    },
  };
}

// ---- Touch input -----------------------------------------------------------

/** Event nodes of pointer devices (touchscreens, mice) from /proc/bus/input/devices. */
export function parseInputDevices(text) {
  const found = [];
  for (const block of text.split(/\n\s*\n/)) {
    const name = /^N: Name="(.*)"$/m.exec(block)?.[1] ?? '';
    const handlers = /^H: Handlers=(.*)$/m.exec(block)?.[1] ?? '';
    const event = /\b(event\d+)\b/.exec(handlers)?.[1];
    if (!event) continue;
    if (/\bmouse\d+\b/.test(handlers) || /touch|ilitek/i.test(name)) found.push({ name, node: `/dev/input/${event}` });
  }
  return found;
}

/**
 * Calls onTouch (at most once a second) whenever a pointer device reports input.
 * Each device is read by a `cat` child so a blocking read never ties up Node's
 * thread pool. Reading /dev/input needs the `input` group (see pidisplay.service).
 */
export function createTouchWatcher({ supported = process.platform === 'linux' } = {}) {
  const readers = new Map();
  let onTouch = () => {};
  let last = 0;
  let scanTimer = null;
  let warned = false;
  let stopped = false;

  const fire = () => {
    const t = Date.now();
    if (t - last < 1000) return;
    last = t;
    onTouch();
  };

  async function scan() {
    if (stopped) return;
    let devices = [];
    try {
      devices = parseInputDevices(await fs.readFile('/proc/bus/input/devices', 'utf8'));
    } catch {}
    for (const { name, node } of devices) {
      if (readers.has(node)) continue;
      const child = spawn('cat', [node], { stdio: ['ignore', 'pipe', 'pipe'] });
      readers.set(node, child);
      child.stdout.on('data', fire);
      child.stderr.on('data', (d) => {
        if (warned) return;
        warned = true;
        console.error(`Sleep: can't read touches from ${name} (${node}): ${String(d).trim()}`);
      });
      child.on('error', () => readers.delete(node));
      child.on('close', () => readers.delete(node));
    }
  }

  return {
    supported,
    get watching() {
      return readers.size;
    },
    start(handler) {
      if (!supported) return;
      onTouch = handler;
      void scan();
      // Picks up a touchscreen plugged in (or replugged) later.
      scanTimer = setInterval(() => void scan(), 60000);
      scanTimer.unref();
    },
    stop() {
      stopped = true;
      clearInterval(scanTimer);
      for (const child of readers.values()) child.kill();
      readers.clear();
    },
  };
}

// ---- Sleep controller ------------------------------------------------------

export function createSleep({
  load = async () => null,
  save = async () => {},
  broadcast = () => {},
  display = createDisplay(),
  touch = createTouchWatcher(),
  cpu = createCpu(),
  now = Date.now,
  tickMs = TICK_MS,
} = {}) {
  let settings = { ...DEFAULT_SETTINGS };
  let asleep = false;
  /** "Turn off now": stays off until a touch, whatever the hours say. */
  let forced = false;
  let lastActivity = now();
  let screenError = null;
  let timer = null;
  let started = false;
  let power = Promise.resolve();

  const ready = load()
    .then((saved) => {
      if (saved?.settings) settings = validateSettings(saved.settings, DEFAULT_SETTINGS);
    })
    .catch((err) => console.error('Loading sleep settings failed', err));

  function status() {
    const awakeHours = inAwakeHours(settings, minuteOfDay(now()));
    return { settings, asleep, awakeHours, screenError, touchWatching: touch.watching ?? 0 };
  }

  function setAsleep(next, reason) {
    if (next === asleep) return;
    asleep = next;
    broadcast({ asleep, reason });
    // Serialized so a quick off-then-on can't land in the wrong order.
    power = power.then(async () => {
      // Full speed first on waking, so the dashboard comes back quickly.
      if (!next) await cpu.setLowPower(false);
      const err = await display.setPower(!next);
      if (next) await cpu.setLowPower(true);
      if (err !== screenError) {
        screenError = err;
        if (err) console.error(`Sleep: screen ${next ? 'off' : 'on'} failed: ${err}`);
      }
    });
  }

  function shouldSleep(t) {
    if (forced) return true;
    const idle = t - lastActivity;
    if (!inAwakeHours(settings, minuteOfDay(t))) return settings.schedule && idle >= settings.nightIdleMinutes * 60000;
    return settings.dayIdleMinutes > 0 && idle >= settings.dayIdleMinutes * 60000;
  }

  function evaluate() {
    setAsleep(shouldSleep(now()), 'schedule');
  }

  /** A touch, or something that should light the screen (an alarm ringing, the wake word). */
  function wake(reason = 'touch') {
    lastActivity = now();
    forced = false;
    setAsleep(false, reason);
  }

  return {
    ready,
    status,
    wake,
    get asleep() {
      return asleep;
    },
    start() {
      if (started) return;
      started = true;
      touch.start(() => wake('touch'));
      // Undoes a low-power CPU left over from a restart while asleep.
      if (!asleep) power = power.then(() => cpu.setLowPower(false));
      void ready.then(() => {
        evaluate();
        timer = setInterval(evaluate, tickMs);
        timer.unref?.();
      });
    },
    stop() {
      clearInterval(timer);
      touch.stop();
    },
    async handle(method, action, body) {
      await ready;
      if (method === 'GET' && !action) return status();
      if (method === 'PUT' && action === 'settings') {
        settings = validateSettings(body, settings);
        await save({ settings });
        // Changing the hours shouldn't black out the screen under the finger that changed them.
        lastActivity = now();
        evaluate();
        broadcast({ asleep, reason: 'settings', settings });
        return status();
      }
      if (method === 'POST' && action === 'now') {
        forced = true;
        setAsleep(true, 'manual');
        return status();
      }
      if (method === 'POST' && action === 'wake') {
        wake(body?.reason === 'activity' ? 'activity' : 'touch');
        return status();
      }
      throw new SleepError(404, 'Not found');
    },
  };
}
