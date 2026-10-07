// Farewatcher settings from the Fares widget: reads and writes the parts of
// ~/fare_watch/config.json that are safe to edit on screen, keeps the last few versions
// for undo, and starts an on-demand run ("Check now").
//
// Never sent to the browser or editable here: API keys (they live in /etc/fare_watch.env),
// the ntfy topic (it works like a password) and email settings.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

export class FaresConfigError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const KEEP_VERSIONS = 10;
const CHECK_COOLDOWN_MS = 60 * 60 * 1000;
const IATA = /^[A-Z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const bad = (message) => new FaresConfigError(400, message);

function code(v, what) {
  const c = String(v ?? '').trim().toUpperCase();
  if (!IATA.test(c)) throw bad(`${what}: "${v}" is not a 3-letter airport or city code`);
  return c;
}

function codes(v, what, { min = 0, max = 20 } = {}) {
  if (!Array.isArray(v)) throw bad(`${what} must be a list`);
  const out = [...new Set(v.map((c) => code(c, what)))];
  if (out.length < min) throw bad(`${what} needs at least ${min}`);
  if (out.length > max) throw bad(`${what} can have at most ${max}`);
  return out;
}

function num(v, what, min, max, { int = false } = {}) {
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n)) throw bad(`${what} must be a number`);
  if (n < min || n > max) throw bad(`${what} must be between ${min} and ${max}`);
  return int ? Math.round(n) : n;
}

function bool(v, what) {
  if (typeof v !== 'boolean') throw bad(`${what} must be on or off`);
  return v;
}

function text(v, what, max) {
  const s = String(v ?? '').trim();
  if (!s) throw bad(`${what} can't be empty`);
  if (s.length > max) throw bad(`${what} is too long`);
  return s;
}

function day(v, what) {
  const s = String(v ?? '');
  if (!DAY.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw bad(`${what} must be a date`);
  return s;
}

function object(v, what) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(`${what} is missing`);
  return v;
}

/** Validators for each editable section. Each returns the cleaned value to store. */
const SECTIONS = {
  origins: (v) => codes(v, 'Home airports', { min: 1, max: 6 }),
  compare_origins: (v) => codes(v, 'Airports compared in alerts', { max: 4 }),
  origin_allowance: (v) =>
    Object.fromEntries(Object.entries(object(v, 'Airport allowances')).map(([k, x]) => [code(k, 'Allowance airport'), num(x, `${k} allowance`, 0, 2000, { int: true })])),
  destinations: (v) => {
    const entries = Object.entries(object(v, 'Destinations'));
    if (!entries.length) throw bad('Watch at least one destination');
    if (entries.length > 40) throw bad('At most 40 destinations');
    return Object.fromEntries(entries.map(([k, x]) => [code(k, 'Destination'), num(x, `${k} target`, 50, 20000, { int: true })]));
  },
  place_names: (v) =>
    Object.fromEntries(Object.entries(object(v, 'Place names')).map(([k, x]) => [code(k, 'Place'), text(x, `${k} name`, 60)])),
  months_ahead: (v) => num(v, 'Months ahead', 1, 12, { int: true }),
  events: (v) => {
    if (!Array.isArray(v)) throw bad('Events must be a list');
    if (v.length > 10) throw bad('At most 10 events');
    return v.map((ev, i) => {
      object(ev, `Event ${i + 1}`);
      const name = text(ev.name, `Event ${i + 1} name`, 60);
      const out = { name, dest: code(ev.dest, `${name} destination`), depart: day(ev.depart, `${name} departure`) };
      out.return = ev.return ? day(ev.return, `${name} return`) : null;
      if (out.return && out.return <= out.depart) throw bad(`${name}: return must be after departure`);
      out.target = num(ev.target, `${name} target`, 50, 20000, { int: true });
      if (ev.tag) out.tag = text(ev.tag, `${name} tag`, 30);
      return out;
    });
  },
  event_settings: (v) => {
    object(v, 'Event settings');
    return {
      check_every_days: num(v.check_every_days, 'Event check interval', 1, 30),
      horizon_days: num(v.horizon_days, 'Event horizon', 30, 365, { int: true }),
    };
  },
  open_jaw: (v) => {
    object(v, 'Open jaw settings');
    const nights = Array.isArray(v.nights) ? v.nights.map((n) => num(n, 'Nights', 1, 60, { int: true })) : null;
    if (!nights || nights.length !== 2 || nights[0] > nights[1]) throw bad('Nights must be a range like 5 to 21');
    return {
      enabled: bool(v.enabled, 'Open jaws'),
      max_km: num(v.max_km, 'Open jaw distance', 100, 3000, { int: true }),
      extra_return_from: codes(v.extra_return_from ?? [], 'Extra return cities', { max: 10 }),
      home: codes(v.home, 'Open jaw home airports', { min: 1, max: 4 }),
      nights,
      min_saving: num(v.min_saving, 'Minimum saving', 0, 2000, { int: true }),
      live_check: bool(v.live_check, 'Open jaw live check'),
    };
  },
  live_check: (v) => {
    object(v, 'Live check settings');
    return {
      enabled: bool(v.enabled, 'Live checks'),
      origins: codes(v.origins, 'Live check airports', { min: 1, max: 4 }),
      max_searches_per_run: num(v.max_searches_per_run, 'Searches per run', 0, 20, { int: true }),
      reserve_searches: num(v.reserve_searches, 'Reserve', 0, 100, { int: true }),
      require_live_confirmation: bool(v.require_live_confirmation, 'Require live confirmation'),
      confirm_leeway: num(v.confirm_leeway, 'Confirm leeway', 0, 0.5),
      recheck_after_days: num(v.recheck_after_days, 'Recheck days', 0, 30, { int: true }),
    };
  },
  alerting: (v) => {
    object(v, 'Alert settings');
    return {
      drop_vs_median: num(v.drop_vs_median, 'Drop vs median', 0.05, 0.9),
      history_window_days: num(v.history_window_days, 'History window', 7, 120, { int: true }),
      min_history_days: num(v.min_history_days, 'Minimum history', 1, 60, { int: true }),
      realert_drop: num(v.realert_drop, 'Re-alert drop', 0, 0.5),
      realert_cooldown_days: num(v.realert_cooldown_days, 'Re-alert cooldown', 0, 90, { int: true }),
      max_alerts_per_run: num(v.max_alerts_per_run, 'Max alerts per run', 1, 20, { int: true }),
    };
  },
  notify: (v) => {
    object(v, 'Notification settings');
    return {
      urgent_below_target: num(v.urgent_below_target, 'Urgent threshold', 0, 0.9),
      high_below_target: num(v.high_below_target, 'High threshold', 0, 0.9),
    };
  },
};

/** Keys of each object section the screen may see and change; the rest stay as they are. */
const SUBKEYS = {
  event_settings: ['check_every_days', 'horizon_days'],
  open_jaw: ['enabled', 'max_km', 'extra_return_from', 'home', 'nights', 'min_saving', 'live_check'],
  live_check: ['enabled', 'origins', 'max_searches_per_run', 'reserve_searches', 'require_live_confirmation', 'confirm_leeway', 'recheck_after_days'],
  alerting: ['drop_vs_median', 'history_window_days', 'min_history_days', 'realert_drop', 'realert_cooldown_days', 'max_alerts_per_run'],
  notify: ['urgent_below_target', 'high_below_target'],
};

/** Same defaults fare_watch.py uses when a key is missing. */
const DEFAULTS = {
  origins: ['SFO', 'SMF'],
  compare_origins: ['SFO', 'SMF'],
  origin_allowance: {},
  destinations: {},
  place_names: {},
  months_ahead: 6,
  events: [],
  event_settings: { check_every_days: 3.5, horizon_days: 330 },
  open_jaw: { enabled: false, max_km: 700, extra_return_from: [], home: ['SFO', 'SMF'], nights: [5, 21], min_saving: 50, live_check: true },
  live_check: { enabled: true, origins: ['SFO', 'SMF'], max_searches_per_run: 6, reserve_searches: 10, require_live_confirmation: true, confirm_leeway: 0, recheck_after_days: 3 },
  alerting: { drop_vs_median: 0.25, history_window_days: 30, min_history_days: 7, realert_drop: 0.05, realert_cooldown_days: 14, max_alerts_per_run: 8 },
  notify: { urgent_below_target: 0.25, high_below_target: 0.1 },
};

/** The editable view of a full config.json. */
export function editableView(cfg) {
  const out = {};
  for (const key of Object.keys(SECTIONS)) {
    const value = cfg[key] ?? DEFAULTS[key];
    if (SUBKEYS[key]) {
      out[key] = Object.fromEntries(SUBKEYS[key].map((k) => [k, value?.[k] ?? DEFAULTS[key][k]]));
    } else {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

/** Validates the sections present in `changes` and merges them into a copy of `cfg`. */
export function applyChanges(cfg, changes) {
  object(changes, 'Settings');
  const next = structuredClone(cfg);
  for (const [key, value] of Object.entries(changes)) {
    if (!SECTIONS[key]) throw bad(`"${key}" can't be changed here`);
    const clean = SECTIONS[key](value);
    // Object sections: replace only the editable keys, so notes and other keys survive.
    next[key] = SUBKEYS[key] ? { ...(next[key] || {}), ...clean } : clean;
  }
  if (!Object.keys(next.destinations || {}).length) throw bad('Watch at least one destination');
  if (!(next.origins || []).length) throw bad('Pick at least one home airport');
  return next;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

export function createFaresConfig({
  configFile,
  historyDir,
  summaryFile,
  readSummary,
  // Runs commands; injectable for tests.
  exec = run,
  now = () => Date.now(),
}) {
  const fareWatchDir = path.dirname(configFile);
  let queue = Promise.resolve();
  const serial = (fn) => {
    const done = queue.then(fn);
    queue = done.catch(() => {});
    return done;
  };

  async function readConfig() {
    let raw;
    try {
      raw = await fs.readFile(configFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') throw new FaresConfigError(503, 'Farewatcher is not set up on this device');
      throw err;
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new FaresConfigError(500, 'Farewatcher config.json is not valid JSON');
    }
  }

  // Temp file + rename, keeping the original's permissions (it can hold the ntfy topic).
  async function writeConfig(cfg) {
    const mode = await fs
      .stat(configFile)
      .then((s) => s.mode & 0o777)
      .catch(() => 0o600);
    const tmp = `${configFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode });
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, configFile);
  }

  async function versions() {
    const names = await fs.readdir(historyDir).catch(() => []);
    return names.filter((n) => /^config-.*\.json$/.test(n)).sort();
  }

  async function backup() {
    await fs.mkdir(historyDir, { recursive: true, mode: 0o700 });
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    await fs.copyFile(configFile, path.join(historyDir, `config-${stamp}.json`));
    const all = await versions();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP_VERSIONS))) {
      await fs.rm(path.join(historyDir, old), { force: true });
    }
  }

  // Rewrite the widget summary from fares.db so added/removed destinations show at once.
  // No API calls; best effort, the next run rewrites it anyway.
  async function refreshSummary() {
    const script = path.join(fareWatchDir, 'fare_watch.py');
    const exists = await fs.access(script).then(() => true, () => false);
    if (!exists || !summaryFile) return false;
    const res = await exec('python3', [script, '--config', configFile, '--export-summary'], {
      cwd: fareWatchDir,
      env: { ...process.env, FARE_WATCH_SUMMARY: summaryFile },
    });
    return res.ok;
  }

  async function serviceState() {
    const res = await exec('systemctl', ['is-active', 'fare_watch.service']);
    return res.stdout.trim() || 'unknown';
  }

  return {
    async get() {
      const cfg = await readConfig();
      return { config: editableView(cfg), versions: (await versions()).length };
    },

    save(changes) {
      return serial(async () => {
        const cfg = await readConfig();
        const next = applyChanges(cfg, changes);
        await backup();
        await writeConfig(next);
        const refreshed = await refreshSummary();
        return { config: editableView(next), versions: (await versions()).length, refreshed };
      });
    },

    /** Puts back the version saved before the last change. */
    undo() {
      return serial(async () => {
        const all = await versions();
        const last = all.at(-1);
        if (!last) throw new FaresConfigError(404, 'No earlier settings to go back to');
        const file = path.join(historyDir, last);
        const cfg = JSON.parse(await fs.readFile(file, 'utf8'));
        await writeConfig(cfg);
        await fs.rm(file, { force: true });
        const refreshed = await refreshSummary();
        return { config: editableView(cfg), versions: all.length - 1, refreshed };
      });
    },

    /** Starts fare_watch.service now (allowed for dan by farewatcher/fare_watch-polkit.rules). */
    async checkNow() {
      const state = await serviceState();
      if (state === 'activating' || state === 'active') throw new FaresConfigError(409, 'Farewatcher is already checking fares');
      const summary = await readSummary().catch(() => null);
      const last = Date.parse(summary?.lastRun?.startedAt ?? '');
      if (Number.isFinite(last) && now() - last < CHECK_COOLDOWN_MS) {
        const mins = Math.ceil((CHECK_COOLDOWN_MS - (now() - last)) / 60000);
        throw new FaresConfigError(429, `Farewatcher checked less than an hour ago. Try again in ${mins} min.`);
      }
      const res = await exec('systemctl', ['start', '--no-block', 'fare_watch.service']);
      if (!res.ok) {
        throw new FaresConfigError(502, `Couldn't start Farewatcher: ${res.stderr.trim().split('\n')[0] || 'systemctl failed'}`);
      }
      return { started: true };
    },

    async status() {
      return { state: await serviceState() };
    },
  };
}
