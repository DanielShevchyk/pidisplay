// LG webOS TV control: find the TV on the network, pair with it once (the TV asks to
// allow it), switch it on with Wake-on-LAN, open its Spotify app for the Spotify
// widget, and act as a full remote (keys, volume, channels, apps, inputs, touchpad)
// for the TV remote widget.
//
// The TV speaks LG's SSAP protocol over a WebSocket (wss on 3001; older sets use
// plain ws on 3000). Its certificate is self-signed, so it can't be verified; the
// pairing key it hands out is kept in $PIDISPLAY_DATA/lgtv.json and only ever sent
// to the TV's own address on the home network.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { ssdpSearch } from './youtube.js';

export class TvError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const WSS_PORT = 3001;
const WS_PORT = 3000;
const LG_ST = 'urn:lge-com:service:webos-second-screen:1';
const DIAL_ST = 'urn:dial-multiscreen-org:service:dial:1';
const SPOTIFY_APP_ID = 'spotify-beehive';
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
const MAX_FRAME = 4 * 1024 * 1024;
// Keys the TV takes over its pointer socket, as its own remote sends them.
const BUTTONS = new Set([
  'UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK', 'HOME', 'MENU', 'EXIT', 'INFO', 'QMENU', 'GUIDE', 'LIST', 'DASH',
  'RED', 'GREEN', 'YELLOW', 'BLUE', 'VOLUMEUP', 'VOLUMEDOWN', 'MUTE', 'CHANNELUP', 'CHANNELDOWN',
  'PLAY', 'PAUSE', 'STOP', 'REWIND', 'FASTFORWARD', 'CC', 'ASTERISK',
  ...'0123456789'.split(''),
]);

// The registration every open-source webOS remote sends (this copy follows
// home-assistant-libs/aiowebostv). The TV only accepts permission lists signed by LG.
const SIGNATURE =
  'eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9.hrVRgjCwXVvE2OOSpDZ58hR' +
  '+59aFNwYDyjQgKk3auukd7pcegmE2CzPCa0bJ0ZsRAcKkCTJrWo5iDzNhMBWRyaMOv5zWSrthlf7G128qvIlpMT0YNY+n/FaOHE73uLrS/g7swl3/qH/BGFG2Hu4' +
  'RlL48eb3lLKqTt2xKHdCs6Cd4RMfJPYnzgvI4BNrFUKsjkcu+WD4OO2A27Pq1n50cMchmcaXadJhGrOqH5YmHdOCj5NSHzJYrsW0HPlpuAx/ECMeIZYDh6RMqaFM' +
  '2DXzdKX9NmmyqzJ3o/0lkk/N97gfVRLW5hA29yeAwaCViZNCP8iC9aO0q9fQojoa7NQnAtw==';
const MANIFEST = {
  appVersion: '1.1',
  manifestVersion: 1,
  permissions: [
    'LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CLOSE', 'TEST_OPEN', 'TEST_PROTECTED', 'CONTROL_AUDIO', 'CONTROL_DISPLAY',
    'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_MEDIA_PLAYBACK', 'CONTROL_INPUT_TV',
    'CONTROL_POWER', 'CONTROL_TV_SCREEN', 'READ_APP_STATUS', 'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST',
    'READ_NETWORK_STATE', 'READ_RUNNING_APPS', 'READ_TV_CHANNEL_LIST', 'WRITE_NOTIFICATION_TOAST', 'READ_POWER_STATE',
    'READ_COUNTRY_INFO', 'CONTROL_INPUT_TEXT', 'CONTROL_MOUSE_AND_KEYBOARD', 'READ_INSTALLED_APPS', 'READ_SETTINGS',
  ],
  signatures: [{ signature: SIGNATURE, signatureVersion: 1 }],
  signed: {
    appId: 'com.lge.test',
    created: '20140509',
    localizedAppNames: { '': 'LG Remote App', 'ko-KR': '리모컨 앱', 'zxx-XX': 'ЛГ Rэмotэ AПП' },
    localizedVendorNames: { '': 'LG Electronics' },
    permissions: [
      'TEST_SECURE', 'CONTROL_INPUT_TEXT', 'CONTROL_MOUSE_AND_KEYBOARD', 'READ_INSTALLED_APPS', 'READ_LGE_SDX',
      'READ_NOTIFICATIONS', 'SEARCH', 'WRITE_SETTINGS', 'WRITE_NOTIFICATION_ALERT', 'CONTROL_POWER', 'READ_CURRENT_CHANNEL',
      'READ_RUNNING_APPS', 'READ_UPDATE_INFO', 'UPDATE_FROM_REMOTE_APP', 'READ_LGE_TV_INPUT_EVENTS', 'READ_TV_CURRENT_TIME',
    ],
    serial: '2f930e2d2cfe083771f68e4fe7bb07',
    vendorId: 'com.lge',
  },
};

// ---- A minimal WebSocket client (text frames only) ----------------------------

/** One masked text (or control) frame, as a client must send it. */
export function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  let head;
  if (data.length < 126) head = Buffer.from([0x80 | opcode, 0x80 | data.length]);
  else if (data.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(data.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, masked]);
}

/** Feeds on raw bytes from the server and calls onMessage(opcode, payload) per complete message. */
export function frameReader(onMessage) {
  let buf = Buffer.alloc(0);
  let parts = [];
  let partsOpcode = 0;
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = Boolean(buf[0] & 0x80);
      const opcode = buf[0] & 0x0f;
      const masked = Boolean(buf[1] & 0x80);
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) throw new Error('WebSocket frame too large');
        len = Number(big);
        offset = 10;
      }
      const maskAt = offset;
      if (masked) offset += 4;
      if (buf.length < offset + len) return;
      let payload = buf.subarray(offset, offset + len);
      if (masked) {
        const mask = buf.subarray(maskAt, maskAt + 4);
        payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      }
      buf = buf.subarray(offset + len);
      if (opcode >= 0x8) {
        onMessage(opcode, payload);
        continue;
      }
      if (opcode !== 0) partsOpcode = opcode;
      parts.push(payload);
      if (fin) {
        onMessage(partsOpcode, Buffer.concat(parts));
        parts = [];
      }
    }
  };
}

/**
 * Opens a WebSocket to host:port. Resolves with { send(text), close(), onText, onClose }.
 * secure uses TLS without checking the certificate (the TV's is self-signed).
 */
export function openSocket(host, port, { secure, timeoutMs = 4000, path = '/' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = secure ? tls.connect({ host, port, rejectUnauthorized: false }) : net.connect({ host, port });
    // Key presses are tiny frames; don't let Nagle hold them back waiting for an ACK.
    socket.setNoDelay(true);
    const key = crypto.randomBytes(16).toString('base64');
    let head = Buffer.alloc(0);
    let open = false;
    let done = false;
    const ws = {
      onText: null,
      onClose: null,
      closed: false,
      send: (text) => {
        if (ws.closed) throw new Error('closed');
        socket.write(encodeFrame(text));
      },
      close: () => socket.destroy(),
    };
    const fail = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('timed out')), timeoutMs);
    const read = frameReader((opcode, payload) => {
      if (opcode === 0x1) ws.onText?.(payload.toString('utf8'));
      else if (opcode === 0x9) socket.write(encodeFrame(payload, 0xa));
      else if (opcode === 0x8) socket.destroy();
    });
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    socket.on('data', (chunk) => {
      try {
        if (open) return read(chunk);
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) {
          if (head.length > 16384) fail(new Error('bad handshake'));
          return;
        }
        const text = head.subarray(0, end).toString('latin1');
        const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        if (!/^HTTP\/1\.1 101/.test(text) || !new RegExp(`^sec-websocket-accept:\\s*${accept.replace(/[+/=]/g, '\\$&')}\\s*$`, 'im').test(text)) {
          return fail(new Error('not a WebSocket server'));
        }
        open = true;
        done = true;
        clearTimeout(timer);
        resolve(ws);
        const rest = head.subarray(end + 4);
        if (rest.length) read(rest);
      } catch (err) {
        socket.destroy();
        fail(err);
      }
    });
    socket.on('error', (err) => fail(err));
    socket.on('close', () => {
      ws.closed = true;
      fail(new Error('closed'));
      ws.onClose?.();
    });
  });
}

// ---- SSAP session ---------------------------------------------------------------

/**
 * Connects to the TV and registers. With a saved key this is silent; without one the
 * TV shows an "allow this device?" prompt and this waits promptMs for the answer.
 * Resolves with { key, secure, request(uri, payload), close() }.
 */
export async function defaultConnect(ip, { key = null, secure = null, promptMs = 60000, ports = { wss: WSS_PORT, ws: WS_PORT } } = {}) {
  // Newer firmware only answers on wss; try what worked last time first.
  const order = secure === false ? [false, true] : [true, false];
  let ws = null;
  let usedSecure = true;
  for (const s of order) {
    try {
      ws = await openSocket(ip, s ? ports.wss : ports.ws, { secure: s });
      usedSecure = s;
      break;
    } catch {
      ws = null;
    }
  }
  if (!ws) throw new TvError(503, "Can't reach the TV.");

  const waiting = new Map(); // id -> { resolve, reject }
  let nextId = 1;
  let registered = null;
  ws.onText = (text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id === 'register_0') {
      if (msg.type === 'registered') registered?.resolve(msg.payload?.['client-key'] ?? key);
      else if (msg.type === 'error') registered?.reject(new TvError(403, /cancel|denied|reject/i.test(msg.error ?? '') ? 'The TV said no. Choose Accept on the TV when it asks.' : `The TV refused: ${msg.error ?? 'unknown error'}`));
      return;
    }
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.type === 'error' || msg.payload?.returnValue === false) {
      w.reject(new TvError(502, `The TV answered: ${msg.error ?? msg.payload?.errorText ?? 'error'}`));
    } else w.resolve(msg.payload ?? {});
  };
  let closed = false;
  ws.onClose = () => {
    closed = true;
    const gone = new TvError(503, 'The TV closed the connection.');
    registered?.reject(gone);
    for (const w of waiting.values()) w.reject(gone);
    waiting.clear();
  };

  const withTimeout = (promise, ms, message) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TvError(504, message)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  };

  try {
    const newKey = await withTimeout(
      new Promise((resolve, reject) => {
        registered = { resolve, reject };
        ws.send(
          JSON.stringify({
            type: 'register',
            id: 'register_0',
            payload: { forcePairing: false, pairingType: 'PROMPT', manifest: MANIFEST, ...(key ? { 'client-key': key } : {}) },
          }),
        );
      }),
      key ? 8000 : promptMs,
      key ? "The TV didn't answer." : 'Nobody chose Accept on the TV in time. Try again.',
    );
    return {
      key: newKey,
      secure: usedSecure,
      get closed() {
        return closed;
      },
      request(uri, payload = {}) {
        if (closed) return Promise.reject(new TvError(503, 'The TV closed the connection.'));
        const id = `req_${nextId++}`;
        const reply = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
        try {
          ws.send(JSON.stringify({ type: 'request', id, uri: `ssap://${uri}`, payload }));
        } catch {
          waiting.delete(id);
          return Promise.reject(new TvError(503, 'The TV closed the connection.'));
        }
        return withTimeout(reply, 8000, "The TV didn't answer.").finally(() => waiting.delete(id));
      },
      close: () => ws.close(),
    };
  } catch (err) {
    ws.close();
    throw err;
  }
}

// ---- Wake-on-LAN and discovery ---------------------------------------------------

export function magicPacket(mac) {
  const bytes = Buffer.from(mac.replace(/[^0-9a-f]/gi, ''), 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)]);
}

function defaultWake(mac, ip) {
  return new Promise((resolve) => {
    const packet = magicPacket(mac);
    const m = IPV4.exec(ip ?? '');
    // The whole network, plus the TV's own subnet for routers that drop the first.
    const targets = ['255.255.255.255', ...(m ? [`${m[1]}.${m[2]}.${m[3]}.255`] : [])];
    let socket;
    try {
      socket = dgram.createSocket('udp4');
    } catch {
      return resolve();
    }
    socket.on('error', () => {});
    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        // still try
      }
      let sends = 0;
      const burst = () => {
        for (const t of targets) for (const port of [9, 7]) socket.send(packet, port, t, () => {});
        if (++sends < 3) setTimeout(burst, 250);
        else setTimeout(() => (socket.close(), resolve()), 100);
      };
      burst();
    });
  });
}

/** The TV's network card address, from the Pi's own neighbour table once they have talked. */
async function defaultMacOf(ip) {
  const table = await fs.readFile('/proc/net/arp', 'utf8').catch(() => '');
  for (const line of table.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] === ip && MAC.test(cols[3] ?? '') && cols[3] !== '00:00:00:00:00:00') return cols[3].toLowerCase();
  }
  return null;
}

const xmlTag = (xml, name) => xml.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([^<]*)</(?:\\w+:)?${name}>`, 'i'))?.[1]?.trim() ?? '';

// ---- The service -------------------------------------------------------------------

export function createLgTv({
  configFile,
  connect = defaultConnect,
  wake = defaultWake,
  macOf = defaultMacOf,
  search = ssdpSearch,
  fetchImpl = globalThis.fetch,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  // How long a switched-off TV gets to boot and answer after the wake-up packet.
  bootMs = 30000,
  // The remote's session closes after this long without a press.
  idleMs = 20000,
  openPointer = openSocket,
} = {}) {
  let config = null; // { ip, name, model, mac, key, secure }
  let busy = null;
  // The remote control's held session, its last state answer, and the app list.
  let remote = null; // { ready: Promise<session>, pointer: Promise<ws> | null, timer }
  let state = null; // { at, value }
  let stateBusy = null;
  let catalog = null; // { at, value }

  async function load() {
    if (config) return config;
    try {
      config = JSON.parse(await fs.readFile(configFile, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Reading lgtv.json failed', err);
      config = {};
    }
    return config;
  }

  async function save(next) {
    config = next;
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    const tmp = `${configFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.rename(tmp, configFile);
  }

  async function status() {
    const c = await load();
    return { linked: Boolean(c.ip && c.key), name: c.name ?? null, ip: c.ip ?? null, canWake: Boolean(c.mac) };
  }

  /** LG TVs that answer on the network right now, as [{ ip, name, model }]. */
  async function find() {
    const lists = await Promise.all([search({ st: LG_ST }), search({ st: DIAL_ST })]);
    const byIp = new Map();
    await Promise.all(
      lists.flatMap((locations, i) =>
        locations.map(async (location) => {
          let ip;
          try {
            ip = new URL(location).hostname;
          } catch {
            return;
          }
          if (!IPV4.test(ip)) return;
          const xml = await fetchImpl(location, { signal: AbortSignal.timeout(4000) })
            .then((res) => (res.ok ? res.text() : ''))
            .catch(() => '');
          const maker = xmlTag(xml, 'manufacturer');
          // The first search only reaches LG sets; the DIAL one finds every brand.
          if (i === 1 && !/\blg\b/i.test(maker) && !/webos/i.test(xml)) return;
          const found = { ip, name: xmlTag(xml, 'friendlyName') || 'LG TV', model: xmlTag(xml, 'modelName') || xmlTag(xml, 'modelNumber') || '' };
          const had = byIp.get(ip);
          if (!had || (had.name === 'LG TV' && found.name !== 'LG TV')) byIp.set(ip, found);
        }),
      ),
    );
    return [...byIp.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Pairs with the TV at ip: the TV shows a prompt and someone must choose Accept. */
  async function link(body) {
    const ip = String(body?.ip ?? '').trim();
    const m = IPV4.exec(ip);
    if (!m || m.slice(1).some((n) => Number(n) > 255)) throw new TvError(400, "That doesn't look like the TV's address (for example 192.168.1.50).");
    const old = await load();
    const session = await connect(ip, { key: old.ip === ip ? old.key : null, secure: old.ip === ip ? old.secure : null }).catch((err) => {
      if (err instanceof TvError && err.status === 503) throw new TvError(503, "Can't reach the TV. Switch it on and check it is on the same network.");
      throw err;
    });
    try {
      const info = await session.request('system/getSystemInfo').catch(() => ({}));
      const name = String(body?.name ?? '').trim().slice(0, 80) || old.name || info.modelName || 'LG TV';
      dropRemote();
      state = null;
      catalog = null;
      await save({ ip, name, model: info.modelName ?? old.model ?? '', mac: (await macOf(ip)) ?? (old.ip === ip ? old.mac : null) ?? null, key: session.key, secure: session.secure });
    } finally {
      session.close();
    }
    return status();
  }

  async function unlink() {
    dropRemote();
    state = null;
    catalog = null;
    await save({});
    return status();
  }

  /** A registered session with the TV, switching it on first if it is off. */
  async function awake() {
    const c = await load();
    if (!c.ip || !c.key) throw new TvError(409, 'No TV is linked yet. Link it under Speakers.');
    const opts = { key: c.key, secure: c.secure };
    const remember = async (session) => {
      const mac = (await macOf(c.ip)) ?? c.mac ?? null;
      if (mac !== c.mac || session.key !== c.key || session.secure !== c.secure) await save({ ...c, mac, key: session.key, secure: session.secure });
    };
    const isOn = async (session) => {
      const power = await session.request('com.webos.service.tvpower/power/getPowerState').catch(() => null);
      // Older sets don't report it; if they answer at all, they're on.
      return !power?.state || power.state === 'Active';
    };

    let session = await connect(c.ip, opts).catch((err) => {
      if (err instanceof TvError && err.status === 503) return null;
      throw err;
    });
    if (session && (await isOn(session))) {
      await remember(session);
      return session;
    }
    // Off, or in a standby where the network stays up but the screen is dark.
    session?.close();
    if (!c.mac) {
      throw new TvError(409, `${c.name} is off, and PiDisplay hasn't learned how to switch it on yet. Turn it on with its remote once.`);
    }
    const deadline = Date.now() + bootMs;
    for (let attempt = 0; attempt === 0 || Date.now() < deadline; attempt++) {
      if (attempt % 3 === 0) await wake(c.mac, c.ip);
      await wait(2000);
      session = await connect(c.ip, opts).catch(() => null);
      if (session && (await isOn(session))) {
        await remember(session);
        return session;
      }
      session?.close();
    }
    throw new TvError(
      504,
      `${c.name} didn't switch on. On the TV, turn on Settings > General > Devices > External Devices > TV On With Mobile > Turn on via Wi-Fi (or via LAN).`,
    );
  }

  /** Switches the TV on if needed and brings up its Spotify app. One at a time. */
  function openSpotify() {
    busy ??= (async () => {
      const session = await awake();
      try {
        // The app's id has been stable for years, but ask the TV in case this set differs.
        const apps = await session.request('com.webos.applicationManager/listLaunchPoints').catch(() => null);
        const app = (apps?.launchPoints ?? []).find((a) => /spotify/i.test(`${a.id} ${a.title}`));
        if (apps?.launchPoints?.length && !app) {
          throw new TvError(404, 'The TV has no Spotify app. Install Spotify from the LG Content Store and sign in.');
        }
        await session.request('system.launcher/launch', { id: app?.id ?? SPOTIFY_APP_ID });
        return { ok: true, name: (await load()).name };
      } finally {
        session.close();
      }
    })().finally(() => {
      busy = null;
    });
    return busy;
  }

  /** A session with the TV only if it is already on; volume changes never switch it on. */
  async function session() {
    const c = await load();
    if (!c.ip || !c.key) throw new TvError(409, 'No TV is linked yet. Link it under Speakers.');
    return connect(c.ip, { key: c.key, secure: c.secure });
  }

  const readVolume = (r) => {
    const v = r?.volumeStatus?.volume ?? r?.volume;
    return typeof v === 'number' && v >= 0 ? v : null;
  };
  const readOutput = (r) => String(r?.volumeStatus?.soundOutput ?? r?.soundOutput ?? '');
  // Where the sound goes decides how volume works: the TV's own speakers take a set level;
  // a soundbar or receiver (HDMI ARC, optical, Bluetooth) only follows up/down presses,
  // which the TV passes on, and a set level is accepted but does nothing there.
  const external = (output) => Boolean(output) && !/^tv_speaker$/.test(output);
  let lastLevel = null; // what the slider last asked for, when the TV can't say

  /** The TV's own volume, 0-100, or null when it doesn't say (some sound outputs). */
  async function getVolume() {
    const s = await session();
    try {
      const r = await s.request('audio/getVolume');
      const output = readOutput(r);
      // Through a soundbar the TV's own number may not move at all, so trust the slider.
      return { volume: external(output) ? (lastLevel ?? readVolume(r)) : readVolume(r), output };
    } finally {
      s.close();
    }
  }

  /** Sets the volume of whatever the TV plays through. */
  async function setVolume(percent, held = null) {
    const v = Math.round(Number(percent));
    if (!Number.isFinite(v) || v < 0 || v > 100) throw new TvError(400, 'Volume must be 0 to 100');
    // The remote passes its own open session, which stays open afterwards.
    const s = held ?? (await session());
    try {
      const before = await s.request('audio/getVolume').catch(() => null);
      const output = readOutput(before);
      let now = readVolume(before);
      if (!external(output)) {
        const ok = await s.request('audio/setVolume', { volume: v }).then(() => true, () => false);
        const after = ok ? readVolume(await s.request('audio/getVolume').catch(() => null)) : null;
        // Took it (or can't tell): done. Otherwise press the buttons like the remote does.
        if (ok && (after === null || Math.abs(after - v) <= 1)) {
          lastLevel = v;
          return { volume: v, output };
        }
        if (after !== null) now = after;
      }
      if (external(output)) now = lastLevel ?? now;
      now ??= lastLevel ?? 50;
      const steps = Math.min(Math.abs(v - now), 25);
      if (!steps) return { volume: v, output };
      const button = v > now ? 'audio/volumeUp' : 'audio/volumeDown';
      for (let i = 0; i < steps; i++) {
        await s.request(button);
        await wait(60);
      }
      lastLevel = v;
      if (external(output)) return { volume: v, output };
      const after = readVolume(await s.request('audio/getVolume').catch(() => null));
      return { volume: after ?? v, output };
    } catch (err) {
      if (err instanceof TvError) throw err;
      throw new TvError(409, `The TV didn't let PiDisplay change its volume (${err.message}). Use the TV remote for this speaker.`);
    } finally {
      if (!held) s.close();
    }
  }

  // ---- Remote control ------------------------------------------------------------
  //
  // Button presses come in quick runs, and every new connection costs a TLS handshake
  // and a register round trip, so the remote keeps one session (and the pointer socket
  // for arrow keys and the touchpad) open until it has been idle for idleMs.


  function dropRemote() {
    const r = remote;
    if (!r) return;
    remote = null;
    clearTimeout(r.timer);
    r.ready.then((s) => s.close(), () => {});
    r.pointer?.then((p) => p.close(), () => {});
  }

  function touch(r) {
    clearTimeout(r.timer);
    r.timer = setTimeout(() => remote === r && dropRemote(), idleMs);
    r.timer.unref?.();
  }

  /** The held session; wakeUp switches the TV on first (power button), otherwise an off TV is an error. */
  async function remoteSession(wakeUp = false) {
    const had = remote;
    if (had) {
      const s = await had.ready.catch(() => null);
      if (s && !s.closed && remote === had) {
        touch(had);
        return s;
      }
      if (remote === had) dropRemote();
    }
    if (remote) return remoteSession(wakeUp); // someone else just opened one
    const r = { ready: null, pointer: null, timer: 0 };
    remote = r;
    r.ready = (async () => {
      if (wakeUp) return awake();
      const c = await load();
      const s = await session().catch((err) => {
        if (err instanceof TvError && err.status === 503) throw new TvError(503, `${c.name ?? 'The TV'} is off or not answering.`);
        throw err;
      });
      return s;
    })();
    r.ready.catch(() => remote === r && dropRemote());
    touch(r);
    return r.ready;
  }

  const plainError = (err) => {
    if (err instanceof TvError && /\b401\b|permission/i.test(err.message)) {
      return new TvError(403, "The TV won't let PiDisplay do that yet. Unlink the TV and link it again so it can grant the newer permissions.");
    }
    return err;
  };

  /** One SSAP request on the held session, retried once on a fresh session if the old one had gone stale. */
  async function ask(uri, payload) {
    for (let attempt = 0; ; attempt++) {
      const s = await remoteSession().catch((err) => {
        throw plainError(err);
      });
      try {
        return await s.request(uri, payload);
      } catch (err) {
        if (attempt === 0 && err instanceof TvError && err.status === 503) {
          dropRemote();
          continue;
        }
        throw plainError(err);
      }
    }
  }

  async function pointer() {
    const s = await remoteSession();
    const r = remote;
    if (!r) throw new TvError(503, 'Lost the connection to the TV. Try again.');
    r.pointer ??= (async () => {
      const reply = await s.request('com.webos.service.networkinput/getPointerInputSocket').catch((err) => {
        throw plainError(err);
      });
      let url;
      try {
        url = new URL(reply.socketPath);
      } catch {
        throw new TvError(502, "The TV didn't give PiDisplay its remote-control socket.");
      }
      const secure = url.protocol === 'wss:';
      // Only ever the TV itself, whatever host name the reply carries.
      const ws = await openPointer((await load()).ip, Number(url.port) || (secure ? 443 : 80), { secure, path: `${url.pathname}${url.search}` });
      return ws;
    })();
    r.pointer.catch(() => {
      if (remote === r) r.pointer = null;
    });
    return r.pointer;
  }

  /** Sends one pointer-socket message, reopening the socket once if it had closed. */
  async function sendPointer(text) {
    for (let attempt = 0; ; attempt++) {
      const p = await pointer();
      try {
        p.send(text);
        return;
      } catch {
        if (remote?.pointer) remote.pointer = null;
        if (attempt > 0) throw new TvError(503, 'Lost the connection to the TV. Try again.');
      }
    }
  }

  const readMuted = (r) => Boolean(r?.volumeStatus?.muteStatus ?? r?.muteStatus ?? r?.muted ?? r?.mute ?? false);

  /** Volume as the remote shows it. On a soundbar (HDMI ARC and the like) the level is only a guess. */
  async function sound() {
    const r = await ask('audio/getVolume').catch(() => null);
    const output = readOutput(r);
    return { volume: external(output) ? (lastLevel ?? readVolume(r)) : readVolume(r), muted: readMuted(r), output, external: external(output) };
  }

  /** Whether the TV is on, what it is showing and how loud. Cached briefly so several screens can poll. */
  function getState() {
    const ttl = state?.value.on ? 2000 : 8000;
    if (state && Date.now() - state.at < ttl) return Promise.resolve(state.value);
    stateBusy ??= (async () => {
      const c = await load();
      const base = { linked: Boolean(c.ip && c.key), name: c.name ?? null, canWake: Boolean(c.mac) };
      if (!base.linked) return { ...base, on: false };
      try {
        await remoteSession(); // an unreachable TV is off
        const power = await ask('com.webos.service.tvpower/power/getPowerState').catch(() => null);
        if (power?.state && power.state !== 'Active') {
          dropRemote();
          return { ...base, on: false };
        }
        const [app, s] = await Promise.all([ask('com.webos.applicationManager/getForegroundAppInfo').catch(() => null), sound()]);
        return { ...base, on: true, appId: app?.appId || null, ...s };
      } catch (err) {
        if (err instanceof TvError && err.status === 503) return { ...base, on: false };
        throw err;
      }
    })()
      .then((value) => {
        state = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        stateBusy = null;
      });
    return stateBusy;
  }

  const httpUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

  /** The TV's apps and inputs, for the launcher. Kept for ten minutes. */
  async function getApps(fresh = false) {
    if (!fresh && catalog && Date.now() - catalog.at < 10 * 60 * 1000) return catalog.value;
    const [apps, inputs] = await Promise.all([ask('com.webos.applicationManager/listLaunchPoints'), ask('tv/getExternalInputList').catch(() => null)]);
    const value = {
      apps: (apps?.launchPoints ?? [])
        .filter((a) => a?.id && a.title)
        .map((a) => ({ id: String(a.id), title: String(a.title), icon: httpUrl(a.icon) ?? httpUrl(a.largeIcon) })),
      inputs: (inputs?.devices ?? [])
        .filter((d) => d?.id)
        .map((d) => ({ id: String(d.id), label: String(d.label || d.id), icon: httpUrl(d.icon), connected: d.connected !== false })),
    };
    catalog = { at: Date.now(), value };
    return value;
  }

  const SIMPLE = {
    volumeUp: 'audio/volumeUp',
    volumeDown: 'audio/volumeDown',
    channelUp: 'tv/channelUp',
    channelDown: 'tv/channelDown',
    play: 'media.controls/play',
    pause: 'media.controls/pause',
    stop: 'media.controls/stop',
    rewind: 'media.controls/rewind',
    fastForward: 'media.controls/fastForward',
    enter: 'com.webos.ime/sendEnterKey',
  };
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

  /** One remote action: { action, ...args }. */
  async function press(body) {
    const action = String(body?.action ?? '');
    const done = (extra = {}) => {
      state = null; // the next /state read is fresh
      return { ok: true, ...extra };
    };
    if (action === 'key') {
      const name = String(body?.key ?? '').toUpperCase();
      if (!BUTTONS.has(name)) throw new TvError(400, `Unknown button ${name || '(none)'}`);
      await sendPointer(`type:button\nname:${name}\n\n`);
      return done();
    }
    if (action === 'move') {
      await sendPointer(`type:move\ndx:${clampInt(body?.dx, -500, 500)}\ndy:${clampInt(body?.dy, -500, 500)}\ndown:0\n\n`);
      return { ok: true };
    }
    if (action === 'click') {
      await sendPointer('type:click\n\n');
      return done();
    }
    if (action === 'scroll') {
      await sendPointer(`type:scroll\ndx:0\ndy:${clampInt(body?.dy, -500, 500)}\n\n`);
      return { ok: true };
    }
    if (action === 'power') {
      if (body?.on) {
        dropRemote();
        await remoteSession(true);
        return done({ on: true });
      }
      await ask('system/turnOff');
      dropRemote();
      state = { at: Date.now(), value: { ...(await status()), on: false } };
      return { ok: true, on: false };
    }
    if (action === 'volumeUp' || action === 'volumeDown') {
      await ask(SIMPLE[action]);
      // Through a soundbar the TV's number may not move; keep the Spotify slider's guess in step.
      if (lastLevel !== null) lastLevel = Math.max(0, Math.min(100, lastLevel + (action === 'volumeUp' ? 1 : -1)));
      return done(await sound());
    }
    if (action === 'volume') {
      const v = await setVolume(body?.percent, await remoteSession());
      return done({ ...(await sound()), volume: v.volume });
    }
    if (action === 'mute') {
      const muted = typeof body?.mute === 'boolean' ? body.mute : !(await sound()).muted;
      await ask('audio/setMute', { mute: muted });
      return done({ muted });
    }
    if (action in SIMPLE) {
      await ask(SIMPLE[action]);
      return done();
    }
    if (action === 'launch') {
      const id = String(body?.id ?? '').trim();
      if (!id || id.length > 200) throw new TvError(400, 'Which app?');
      await ask('system.launcher/launch', { id });
      return done();
    }
    if (action === 'input') {
      const id = String(body?.id ?? '').trim();
      if (!id || id.length > 200) throw new TvError(400, 'Which input?');
      await ask('tv/switchInput', { inputId: id });
      return done();
    }
    if (action === 'text') {
      const text = String(body?.text ?? '').slice(0, 500);
      if (!text) throw new TvError(400, 'Nothing to type');
      await ask('com.webos.ime/insertText', { text, replace: 0 });
      if (body?.enter) await ask('com.webos.ime/sendEnterKey');
      return done();
    }
    if (action === 'toast') {
      const message = String(body?.message ?? '').trim().slice(0, 200);
      if (!message) throw new TvError(400, 'Nothing to show');
      await ask('system.notifications/createToast', { message });
      return { ok: true };
    }
    throw new TvError(400, `Unknown remote action ${action || '(none)'}`);
  }

  /** Routes /api/tv/... */
  async function handle(method, parts, body) {
    const [, action] = parts; // parts[0] is "tv"
    if (!action && method === 'GET') return status();
    if (action === 'state' && method === 'GET') return getState();
    if (action === 'apps' && method === 'GET') return getApps();
    if (method !== 'POST') throw new TvError(404, 'Not found');
    if (action === 'apps') return getApps(true);
    if (action === 'remote') return press(body);
    if (action === 'find') return { tvs: await find() };
    if (action === 'link') return link(body);
    if (action === 'unlink') return unlink();
    if (action === 'spotify') return openSpotify();
    if (action === 'volume') return setVolume(body?.percent);
    throw new TvError(404, 'Not found');
  }

  return { status, find, link, unlink, openSpotify, getVolume, setVolume, getState, getApps, press, close: dropRemote, handle };
}
