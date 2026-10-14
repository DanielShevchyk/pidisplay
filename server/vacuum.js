// Robot vacuum control for the Vacuum widget: a Dreame robot (built for the
// L40 Ultra) reached through the Dreamehome cloud with the owner's account.
//
// The account is kept only on the Pi, in $PIDISPLAY_DATA/dreame.json, written
// by deploy/vacuum.ps1 and never sent to the browser. The server polls the
// robot (every 10 s while it works, every minute otherwise), pushes each change
// to the screens, and rings the bell when the robot reports a problem.
//
// Property and action numbers (MIoT siid/piid/aiid) are Dreame's common
// vacuum spec, as mapped by the Home Assistant integration Tasshack/dreame-vacuum
// (types.py DreameVacuumPropertyMapping / DreameVacuumActionMapping).

import { createDreameCloud, DreameCloudError, REGIONS } from './dreame-cloud.js';
import { parseMapList, MapError } from './dreame-map.js';

const ACTIVE_POLL_MS = 10_000;
const IDLE_POLL_MS = 60_000;
const EXTRA_EVERY_MS = 15 * 60_000;
const ROOMS_EVERY_MS = 6 * 60 * 60_000;
const RETRY_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000];

const P = {
  state: [2, 1],
  error: [2, 2],
  battery: [3, 1],
  charging: [3, 2],
  status: [4, 1],
  cleaningTime: [4, 2],
  cleanedArea: [4, 3],
  suction: [4, 4],
  water: [4, 5],
  task: [4, 7],
  mode: [4, 23],
  washBase: [4, 25],
  progress: [4, 63],
  cleanTank: [27, 1],
  dirtyTank: [27, 2],
  // Read less often:
  dustBag: [27, 3],
  mainBrush: [9, 2],
  sideBrush: [10, 2],
  filter: [11, 1],
  sensors: [16, 1],
  mopPad: [18, 1],
  mapList: [6, 8],
};
const CORE = ['state', 'error', 'battery', 'charging', 'status', 'cleaningTime', 'cleanedArea', 'suction', 'water', 'task', 'mode', 'washBase', 'progress', 'cleanTank', 'dirtyTank'];
const EXTRA = ['dustBag', 'mainBrush', 'sideBrush', 'filter', 'sensors', 'mopPad', 'mapList'];

const A = {
  start: [2, 1],
  pause: [2, 2],
  dock: [3, 1],
  startCustom: [4, 1],
  stop: [4, 2],
  baseAction: [4, 4],
  locate: [7, 1],
  empty: [15, 1],
};

/** Robot states (property 2.1) as people would say them. */
const STATES = {
  1: 'Vacuuming', 2: 'Idle', 3: 'Paused', 4: 'Problem', 5: 'Going back to the dock', 6: 'Charging', 7: 'Mopping',
  8: 'Drying the mops', 9: 'Washing the mops', 10: 'Going back to wash the mops', 11: 'Mapping', 12: 'Vacuuming and mopping',
  13: 'Fully charged', 14: 'Updating its software', 15: 'Cleaning', 16: 'Resetting the station',
  17: 'Going back to attach the mops', 18: 'Going back to drop off the mops', 19: 'Checking the water',
  20: 'Adding water', 21: 'Mop washing paused', 22: 'Emptying the dust bin', 23: 'Remote control', 24: 'Smart charging',
  25: 'Cleaning again', 26: 'Following', 27: 'Spot cleaning', 28: 'Going back to empty the bin', 29: 'Waiting',
  30: 'Cleaning the station', 31: 'Going back to drain', 32: 'Draining', 33: 'Draining water', 34: 'Emptying',
  35: 'Drying the dust bag', 36: 'Dust bag drying paused', 37: 'Heading to clean again', 38: 'Cleaning again',
  103: 'Sanitizing', 104: 'Sanitizing', 105: 'Changing mops', 106: 'Changing mops paused', 116: 'Attaching the mops',
  117: 'Dropping off the mops', 118: 'Recharging', 121: 'Docking', 122: 'Leaving the dock',
};
const ACTIVE_STATES = new Set([1, 7, 11, 12, 15, 25, 27, 37, 38]);
const RETURNING_STATES = new Set([5, 10, 17, 18, 28, 31, 118, 121]);
const DOCKED_STATES = new Set([6, 13, 24, 8, 9, 22, 30, 32, 33, 34, 35, 103, 104]);
const PAUSED_TASKS = new Set([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 23, 24, 31, 32, 33, 35, 42, 44]);
const CLEANING_STATUSES = new Set([2, 4, 5, 18, 19, 20, 21, 22, 23, 24, 25]);

/** Error codes (property 2.2) worth explaining; others show as "Error N". */
const ERRORS = {
  1: 'A wheel is hanging off an edge', 2: 'Cliff sensors are blocked or dirty', 3: 'The bumper is stuck',
  5: 'The bumper keeps getting stuck', 8: 'The dust bin is missing', 9: 'The water tank is missing',
  10: 'The water tank is empty', 11: 'The dust bin is full', 12: 'The main brush is tangled',
  13: 'The side brush is tangled', 14: 'The fan is blocked', 15: 'The left wheel is stuck', 16: 'The right wheel is stuck',
  17: 'The robot is stuck', 18: 'The robot is stuck', 19: "It can't find the dock", 20: 'The battery is low',
  21: 'Charging problem', 24: 'The camera is blocked or dirty', 47: 'The robot is blocked', 48: 'The laser sensor has a problem',
  49: 'The laser cover is stuck', 51: 'The filter is blocked', 59: "It's in a no-go zone", 68: 'Take the mop pads off',
  69: 'The mop pads fell off', 70: 'The mop pads fell off', 71: 'The mop pads stopped turning', 72: 'The mop pads stopped turning',
  74: "The mop pads didn't attach", 75: 'Battery too low, turned off', 76: 'The dirty water tank is missing',
  80: 'The robot is stuck', 81: 'The robot is stuck', 82: 'Slippery floor', 85: 'Check that the mop pads are attached',
  86: 'The dirty water tank is full', 90: 'The robot is stuck', 101: "The station's dust bin is full", 102: "The station's dust bin is open",
  103: "The station's dust bin is open", 104: "The station's dust bin is full", 105: 'Fill the clean water tank',
  106: 'Empty the dirty water tank', 107: 'The clean water tank is empty', 108: 'Empty the dirty water tank',
  109: 'The dirty water tank is blocked', 111: 'Check the mop pads', 116: 'Fill the clean water tank',
  117: 'The station is unplugged', 118: 'Empty the dirty water tank', 119: "Clean the station's wash tray",
  120: 'No mop pads in the station', 121: 'The dust bag is full', 125: 'The station could not drain',
  126: 'Mop pads not found', 128: 'Station problem', 129: 'Mop washing failed', 1000: "It couldn't get back to the dock",
};

const SUCTION = ['Quiet', 'Standard', 'Strong', 'Turbo'];
/** Cleaning mode codes in the low bits of property 4.23 (robots that lift or drop their mops). */
const MODES = { 2: 'Vacuum', 0: 'Vacuum and mop', 1: 'Mop', 3: 'Vacuum, then mop' };

export class VacuumError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new VacuumError(400, message);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pct = (v) => {
  const n = num(v);
  return n === null || n < 0 || n > 100 ? null : n;
};

function errorText(code) {
  if (!code) return null;
  return ERRORS[code] ?? `Error ${code}`;
}

/**
 * Property 4.23 on robots with a self-wash station: the low two bits are the
 * cleaning mode, the bits from 16 up the mop wetness (see split_group_value()).
 */
export function splitMode(value) {
  const v = num(value);
  if (v === null) return null;
  return { mode: v & 0x03, wetness: v >> 16 };
}

/** The new 4.23 value for a cleaning mode, keeping every other setting packed into it. */
export const withMode = (value, mode) => (num(value) & ~0x03) | mode;

/**
 * Mop water for room cleaning, 1 (slightly dry) to 3 (wet), from the wetness
 * packed into 4.23 when it's a plain level, else from a 1-32 (or 1-255) wetness
 * scale as the integration maps it, else the water volume property.
 */
export function mopWater(wetness, water) {
  const w = num(wetness);
  if (w >= 1 && w <= 3) return w;
  if (w > 32) return w > 200 ? 3 : w < 200 ? 1 : 2;
  if (w > 0) return w > 26 ? 3 : w < 6 ? 1 : 2;
  const v = num(water);
  return v >= 1 && v <= 3 ? v : 2;
}

/** What the robot is doing, from the raw property values. */
export function describe(props) {
  const state = num(props.state);
  const status = num(props.status);
  const task = num(props.task);
  const error = num(props.error) || 0;
  const charging = num(props.charging);
  const started = task !== null ? task !== 0 && task !== 36 : CLEANING_STATUSES.has(status) || status === 1;
  let phase;
  if (error && state === 4) phase = 'error';
  else if (started) phase = PAUSED_TASKS.has(task) || state === 3 || status === 1 ? 'paused' : 'cleaning';
  else if (RETURNING_STATES.has(state) || status === 3) phase = 'returning';
  else if (charging === 1 || charging === 3 || DOCKED_STATES.has(state)) phase = 'docked';
  else phase = ACTIVE_STATES.has(state) ? 'cleaning' : state === 3 ? 'paused' : 'idle';
  let label = STATES[state] ?? (phase === 'docked' ? 'Docked' : phase === 'idle' ? 'Idle' : 'Working');
  if (phase === 'paused') label = 'Paused';
  if (phase === 'docked' && (state === 2 || state === null)) label = charging === 1 ? 'Charging' : 'Docked';
  const modeParts = splitMode(props.mode);
  const water = num(props.water);
  return {
    phase,
    label,
    stateCode: state,
    error: error ? { code: error, text: errorText(error) } : null,
    battery: pct(props.battery),
    charging: charging === 1,
    cleaningMinutes: started ? num(props.cleaningTime) : null,
    cleanedArea: started ? num(props.cleanedArea) : null,
    progress: started ? pct(props.progress) : null,
    suction: num(props.suction) !== null && SUCTION[num(props.suction)] ? num(props.suction) : null,
    mode: modeParts && MODES[modeParts.mode] !== undefined ? modeParts.mode : null,
    mopWater: mopWater(modeParts?.wetness, water),
    tanks: {
      clean: num(props.cleanTank) === null ? null : ['ok', 'missing', 'low', 'checking'][num(props.cleanTank)] ?? null,
      dirty: num(props.dirtyTank) === null ? null : ['ok', 'full'][num(props.dirtyTank)] ?? null,
      dustBag: num(props.dustBag) === null ? null : ['ok', 'missing', 'check'][num(props.dustBag)] ?? null,
    },
    parts: {
      mainBrush: pct(props.mainBrush),
      sideBrush: pct(props.sideBrush),
      filter: pct(props.filter),
      mopPads: pct(props.mopPad),
      sensors: pct(props.sensors),
    },
  };
}

/**
 * @param {object} o
 * @param {() => Promise<object|null>} o.loadConfig  {username, password, region, device?}
 * @param {() => Promise<object|null>} o.load        saved device + rooms
 * @param {(v: object) => Promise<void>} o.save
 */
export function createVacuum({
  loadConfig,
  load = async () => null,
  save = async () => {},
  cloudFactory = createDreameCloud,
  broadcast = () => {},
  notify = () => {},
  now = () => Date.now(),
  autoStart = true,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let cloud = null;
  let config = null;
  let device = null;
  let props = {};
  let saved = null;
  let rooms = null;
  let status = 'unconfigured';
  let problem = null;
  let updatedAt = null;
  let lastExtra = 0;
  let lastRooms = 0;
  let mapListValue = null;
  let timer = null;
  let failures = 0;
  let lastError = 0;
  let stopped = false;
  let busy = null;
  let roomsBusy = null;

  const snapshot = () => ({
    configured: status !== 'unconfigured',
    status,
    problem,
    region: config?.region ?? null,
    device: device ? { name: device.name, model: device.model } : null,
    state: device && updatedAt ? describe(props) : null,
    rooms: rooms?.rooms ?? [],
    mapName: rooms?.mapName ?? null,
    hasMap: Boolean(rooms?.picture),
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
    labels: { suction: SUCTION, modes: MODES },
  });

  const push = () => broadcast(snapshot());

  function schedule(ms) {
    clearTimer(timer);
    if (stopped) return;
    timer = setTimer(() => void poll().catch(() => {}), ms);
    timer?.unref?.();
  }

  async function connect() {
    config = await loadConfig();
    cloud?.close();
    cloud = null;
    device = null;
    if (!config?.username || !config?.password) {
      status = 'unconfigured';
      problem = null;
      return false;
    }
    saved ??= (await load()) ?? {};
    rooms = saved.rooms ?? null;
    lastRooms = saved.roomsAt ?? 0;
    mapListValue = saved.mapList ?? null;
    status = 'connecting';
    problem = null;
    cloud = cloudFactory({ username: config.username, password: config.password, region: config.region || 'us' });
    const list = await cloud.devices();
    const vacuums = list.filter((d) => String(d.model ?? '').includes('.vacuum.'));
    const want = config.device ? String(config.device).toLowerCase() : null;
    const pick =
      (want && vacuums.find((d) => String(d.did) === want || String(d.customName ?? '').toLowerCase() === want || String(d.deviceInfo?.displayName ?? '').toLowerCase() === want)) ||
      vacuums.find((d) => String(d.did) === String(saved.device?.did)) ||
      vacuums[0];
    if (!pick) {
      status = 'error';
      problem = list.length ? 'No robot vacuum on this Dreame account' : 'This Dreame account has no devices';
      return false;
    }
    device = {
      did: String(pick.did),
      model: pick.model,
      bindDomain: pick.bindDomain,
      name: pick.customName || pick.deviceInfo?.displayName || 'Robot vacuum',
    };
    if (saved.device?.did !== device.did) {
      rooms = null;
      lastRooms = 0;
      mapListValue = null;
    }
    saved.device = { did: device.did, name: device.name, model: device.model };
    await save(saved);
    status = 'ok';
    return true;
  }

  async function refreshRooms(force = false) {
    if (!device || !mapListValue) return;
    let info;
    try {
      info = typeof mapListValue === 'string' ? JSON.parse(mapListValue) : mapListValue;
    } catch {
      return;
    }
    const objectName = info?.object_name ?? info?.obj_name;
    if (!objectName) return;
    if (!force && rooms && saved.roomsMd5 === (info.md5 ?? objectName) && now() - lastRooms < ROOMS_EVERY_MS) return;
    roomsBusy ??= (async () => {
      try {
        const fetchObject = async (name) => cloud.download(await cloud.fileUrl(device, name));
        const list = await fetchObject(objectName);
        const parsed = await parseMapList(list, { fetchObject, ivHint: saved.mapIv ?? null });
        const current = parsed.maps.find((m) => m.mapId === Number(parsed.currentId)) ?? parsed.maps[0];
        rooms = current ? { rooms: current.rooms, mapName: parsed.maps.length > 1 ? current.name : null, picture: current.picture } : { rooms: [], picture: null };
        lastRooms = now();
        Object.assign(saved, { rooms, roomsAt: lastRooms, roomsMd5: info.md5 ?? objectName, mapIv: parsed.iv ?? saved.mapIv ?? null, mapList: mapListValue });
        await save(saved);
        push();
      } catch (err) {
        if (!(err instanceof MapError) && !(err instanceof DreameCloudError)) throw err;
        console.warn('vacuum: could not read the room map:', err.message);
      } finally {
        roomsBusy = null;
      }
    })();
    return roomsBusy;
  }

  async function readProps(keys) {
    const values = await cloud.getProperties(device, keys.map((k) => P[k]));
    const out = {};
    for (const k of keys) {
      const v = values[P[k].join('.')];
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  async function refresh() {
    if (!device && !(await connect())) return;
    const wantExtra = now() - lastExtra > EXTRA_EVERY_MS;
    const fresh = await readProps(wantExtra ? [...CORE, ...EXTRA] : CORE);
    const before = updatedAt ? describe(props) : null;
    props = { ...props, ...fresh };
    if (wantExtra) lastExtra = now();
    updatedAt = now();
    status = 'ok';
    problem = null;
    const after = describe(props);
    if (before && after.error && after.error.code !== before.error?.code && now() - lastError > 60_000) {
      lastError = now();
      notify({ title: `${device.name}: ${after.error.text}`, body: 'Check the robot or the Dreamehome app.', level: 'warning' });
    }
    if (fresh.mapList !== undefined && fresh.mapList !== mapListValue) {
      mapListValue = fresh.mapList;
      void refreshRooms(true);
    } else if (now() - lastRooms > ROOMS_EVERY_MS) void refreshRooms();
  }

  async function poll() {
    if (stopped) return;
    try {
      busy ??= refresh().finally(() => {
        busy = null;
      });
      await busy;
      failures = 0;
      push();
      if (status === 'unconfigured') return;
      const phase = device ? describe(props).phase : 'idle';
      schedule(phase === 'cleaning' || phase === 'returning' || phase === 'paused' ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    } catch (err) {
      failures++;
      if (err instanceof DreameCloudError && err.auth) {
        status = 'signin';
        problem = err.message;
        push();
        return; // wrong password: wait for new credentials (deploy/vacuum.ps1 calls reload)
      }
      status = device ? 'offline' : 'error';
      problem = err.message;
      push();
      schedule(RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)]);
      if (!(err instanceof DreameCloudError) && !(err instanceof MapError)) console.error('vacuum:', err);
    }
  }

  function soon() {
    // The robot takes a moment to report a new state after a command.
    schedule(2500);
  }

  async function act(fn) {
    if (status === 'unconfigured') throw new VacuumError(409, 'Add your Dreame account first (deploy/vacuum.ps1)');
    if (!device) {
      try {
        await connect();
      } catch (err) {
        throw new VacuumError(502, err.message);
      }
      if (!device) throw new VacuumError(409, problem ?? 'Robot not found');
    }
    try {
      await fn();
    } catch (err) {
      if (err instanceof DreameCloudError) throw new VacuumError(502, err.message);
      throw err;
    }
    soon();
    return snapshot();
  }

  /** Room cleaning: each selected room once (or `repeat` times) with the current suction and water settings. */
  function roomPayload(ids, repeat) {
    const d = describe(props);
    const suction = d.suction ?? 1;
    const water = d.mopWater;
    const selects = ids.map((id) => [id, repeat, suction, water, 1]);
    return [
      { piid: 1, value: 18 },
      { piid: 10, value: JSON.stringify({ selects }) },
    ];
  }

  const commands = {
    start: () => cloud.action(device, ...A.start),
    resume: () => cloud.action(device, ...A.start),
    pause: () => cloud.action(device, ...A.pause),
    stop: () => cloud.action(device, ...A.stop),
    dock: () => cloud.action(device, ...A.dock),
    locate: () => cloud.action(device, ...A.locate),
    empty: () => cloud.action(device, ...A.empty),
    wash: () => cloud.action(device, ...A.baseAction, [{ piid: 10, value: '2,1' }]),
    dry: () => cloud.action(device, ...A.baseAction, [{ piid: 10, value: '3,1' }]),
    rooms: (body) => {
      const known = new Set((rooms?.rooms ?? []).map((r) => r.id));
      const ids = Array.isArray(body?.rooms) ? [...new Set(body.rooms.map(Number))] : [];
      if (!ids.length) throw bad('Pick at least one room');
      if (ids.some((id) => !Number.isInteger(id) || id < 1 || id > 63 || (known.size && !known.has(id)))) throw bad('Unknown room');
      const repeat = body?.repeat === undefined ? 1 : Number(body.repeat);
      if (![1, 2, 3].includes(repeat)) throw bad('Repeat must be 1, 2 or 3');
      return cloud.action(device, ...A.startCustom, roomPayload(ids, repeat));
    },
    suction: async (body) => {
      const level = Number(body?.level);
      if (!Number.isInteger(level) || !SUCTION[level]) throw bad('Unknown suction level');
      await cloud.setProperty(device, ...P.suction, level);
      props.suction = level;
    },
    mode: async (body) => {
      const mode = Number(body?.mode);
      if (MODES[mode] === undefined) throw bad('Unknown cleaning mode');
      if (num(props.mode) === null) throw new VacuumError(409, "The robot hasn't reported its cleaning mode yet");
      const value = withMode(props.mode, mode);
      await cloud.setProperty(device, ...P.mode, value);
      props.mode = value;
    },
  };

  async function command(body) {
    const name = body?.command;
    if (!Object.hasOwn(commands, name)) throw bad('Unknown command');
    return act(() => commands[name](body));
  }

  async function reload() {
    clearTimer(timer);
    failures = 0;
    props = {};
    updatedAt = null;
    lastExtra = 0;
    saved = null;
    try {
      await connect();
    } catch (err) {
      status = err instanceof DreameCloudError && err.auth ? 'signin' : 'error';
      problem = err.message;
      push();
      if (status === 'error') schedule(RETRY_MS[0]);
      return snapshot();
    }
    await poll();
    return snapshot();
  }

  if (autoStart) void reload();

  return {
    snapshot,
    reload,
    command,
    /** Fetch the state now (pull to refresh, or right after opening the widget). */
    async refresh() {
      await poll();
      return snapshot();
    },
    async map() {
      if (!rooms?.picture) {
        if (device && mapListValue) await refreshRooms(true);
        if (!rooms?.picture) throw new VacuumError(404, 'No room map yet');
      }
      return { ...rooms.picture, rooms: rooms.rooms };
    },
    async handle(method, parts, body) {
      const [, key] = parts;
      if (method === 'GET' && !key) return snapshot();
      if (method === 'GET' && key === 'map') return this.map();
      if (method === 'POST' && key === 'refresh') return this.refresh();
      if (method === 'POST' && key === 'reload') return reload();
      if (method === 'POST' && key === 'command') return command(body);
      if (method === 'POST' && key === 'rooms') {
        await refreshRooms(true);
        return snapshot();
      }
      throw new VacuumError(404, 'Not found');
    },
    stop() {
      stopped = true;
      clearTimer(timer);
      cloud?.close();
    },
    regions: REGIONS,
  };
}
