// YouTube on the TV. Finds videos with YouTube's own web search (no API key) and
// plays them on a smart TV's YouTube app through the YouTube "Lounge" service,
// the same one the phone app uses to cast. The TV is linked once, either with the
// code from the TV's YouTube app (Settings > Link with TV code), which works for
// any brand, or found on the network with DIAL, which can also start the YouTube
// app when it is closed. Nothing plays on the Pi itself.
//
// Saved in youtube.json: the linked TVs (screen id and a lounge token that YouTube
// renews every couple of weeks) and a short history of what was played.

import dgram from 'node:dgram';
import crypto from 'node:crypto';

const LOUNGE = 'https://www.youtube.com/api/lounge';
const SEARCH_URL = 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false';
const OEMBED_URL = 'https://www.youtube.com/oembed';
// A recent web client; YouTube accepts older versions for a long time.
const CLIENT_VERSION = '2.20250925.01.00';
// Search filter "Type: Video", so channels, playlists and shelves are left out.
const VIDEOS_ONLY = 'EgIQAQ%3D%3D';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const DEVICE_NAME = 'PiDisplay';
const TIMEOUT = 10_000;
const SEARCH_TTL = 10 * 60 * 1000;
const MAX_RESULTS = 24;
const MAX_HISTORY = 30;
// Renew the lounge token this long before YouTube says it expires.
const TOKEN_MARGIN = 60 * 60 * 1000;
// Keep listening to the TV this long after the dashboard last asked about it.
const IDLE_MS = 30 * 60 * 1000;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const SSDP_ADDR = '239.255.255.250';
const DIAL_ST = 'urn:dial-multiscreen-org:service:dial:1';

/** Lounge playback state numbers. */
const STATES = { '-1': 'stopped', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued', 1081: 'ad' };

export class YouTubeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The text of a YouTube "runs" or "simpleText" object. */
function text(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (typeof t.simpleText === 'string') return t.simpleText;
  if (typeof t.content === 'string') return t.content;
  if (Array.isArray(t.runs)) return t.runs.map((r) => r.text ?? '').join('');
  return '';
}

export function thumbnail(id) {
  return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}

function fromVideoRenderer(v) {
  const id = v.videoId;
  if (!VIDEO_ID.test(id ?? '')) return null;
  const badges = JSON.stringify(v.badges ?? []) + JSON.stringify(v.thumbnailOverlays ?? []);
  const duration = text(v.lengthText);
  return {
    id,
    title: text(v.title),
    channel: text(v.ownerText) || text(v.longBylineText) || text(v.shortBylineText),
    duration,
    views: text(v.shortViewCountText) || text(v.viewCountText),
    published: text(v.publishedTimeText),
    live: /LIVE/.test(badges) && !duration,
    thumb: thumbnail(id),
  };
}

/** Newer layouts describe a video as a "lockup" with metadata rows. */
function fromLockup(l) {
  if (l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO' || !VIDEO_ID.test(l.contentId ?? '')) return null;
  const meta = l.metadata?.lockupMetadataViewModel;
  const rows = (meta?.metadata?.contentMetadataViewModel?.metadataRows ?? []).map((r) =>
    (r.metadataParts ?? []).map((p) => text(p.text)).filter(Boolean),
  );
  const overlay = JSON.stringify(l.contentImage ?? {});
  const duration = overlay.match(/"text":"(\d+(?::\d\d){1,2})"/)?.[1] ?? '';
  return {
    id: l.contentId,
    title: text(meta?.title),
    channel: rows[0]?.[0] ?? '',
    duration,
    views: rows[1]?.[0] ?? '',
    published: rows[1]?.[1] ?? '',
    live: /LIVE/.test(overlay) && !duration,
    thumb: thumbnail(l.contentId),
  };
}

/** Pulls the videos out of a youtubei search response, in order, without repeats. */
export function parseSearch(data) {
  const out = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || out.length >= MAX_RESULTS) return;
    if (Array.isArray(node)) return node.forEach(walk);
    for (const [key, value] of Object.entries(node)) {
      let video = null;
      if (key === 'videoRenderer' || key === 'compactVideoRenderer') video = fromVideoRenderer(value ?? {});
      else if (key === 'lockupViewModel') video = fromLockup(value ?? {});
      else {
        walk(value);
        continue;
      }
      if (video?.title && !seen.has(video.id) && out.length < MAX_RESULTS) {
        seen.add(video.id);
        out.push(video);
      }
    }
  };
  walk(data);
  return out;
}

/** Accepts a video id or any youtube.com / youtu.be link; returns the id or null. */
export function videoIdFrom(input) {
  const s = String(input ?? '').trim();
  if (VIDEO_ID.test(s)) return s;
  const m = s.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/live\/|\/embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/**
 * Splits Lounge channel output ("<length>\n[[id,[event,...]],...]" repeated) into
 * event batches. Returns the parsed batches and whatever trailing text is still incomplete.
 */
export function parseChunks(buffer) {
  const batches = [];
  let rest = buffer;
  for (;;) {
    const m = rest.match(/^\s*\d+\s*\n/);
    if (!m) break;
    const start = m[0].length;
    const end = jsonArrayEnd(rest, start);
    if (end < 0) break;
    try {
      batches.push(JSON.parse(rest.slice(start, end)));
    } catch {
      // A malformed batch is skipped rather than stalling the channel.
    }
    rest = rest.slice(end);
  }
  return { batches, rest };
}

/** Index just past the JSON array starting at (or after whitespace from) start; -1 if incomplete. */
function jsonArrayEnd(s, start) {
  let i = start;
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] !== '[') return -1;
  let depth = 0;
  let inString = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// ---- DIAL (finding TVs on the network) ----------------------------------------

/** Asks the network for DIAL devices; resolves with their description URLs. */
export function ssdpSearch({ timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const found = new Set();
    let socket;
    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      return resolve([]);
    }
    const finish = () => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve([...found]);
    };
    socket.on('error', finish);
    socket.on('message', (msg) => {
      const loc = String(msg).match(/^location:\s*(\S+)/im)?.[1];
      if (loc && /^http:\/\//i.test(loc)) found.add(loc);
    });
    socket.bind(0, () => {
      const query = Buffer.from(
        `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${DIAL_ST}\r\nUSER-AGENT: PiDisplay/1.0\r\n\r\n`,
      );
      try {
        socket.setMulticastTTL(2);
      } catch {
        // not fatal
      }
      // UDP can drop a packet; ask twice.
      socket.send(query, 1900, SSDP_ADDR, () => {});
      setTimeout(() => socket.send(query, 1900, SSDP_ADDR, () => {}), 400);
    });
    setTimeout(finish, timeoutMs);
  });
}

const xmlTag = (xml, name) => xml.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([^<]*)</(?:\\w+:)?${name}>`, 'i'))?.[1]?.trim() ?? '';

/** Reads a DIAL app description: { state, screenId }. */
export function parseDialApp(xml) {
  return { state: xmlTag(xml, 'state') || null, screenId: xmlTag(xml, 'screenId') || null };
}

function appUrlFor(base) {
  return `${base.endsWith('/') ? base : `${base}/`}YouTube`;
}

// ---- The service ----------------------------------------------------------------

export function createYouTube({
  load = async () => null,
  save = async () => {},
  fetchImpl = globalThis.fetch,
  broadcast = () => {},
  discoverLocations = ssdpSearch,
  now = () => Date.now(),
  wait = sleepMs,
  idleMs = IDLE_MS,
  // How long to wait for a TV's YouTube app to start after a DIAL launch.
  launchWaitMs = 25_000,
} = {}) {
  let config = null;
  let saving = Promise.resolve();
  const searchCache = new Map();
  const titles = new Map(); // videoId -> { title, channel }
  const dialSeen = new Map(); // udn -> device from the last scan
  let session = null; // { screenId, token, sid, gsession, aid, ofs, abort }
  let connecting = null;
  let lastUse = now();
  let stopped = false;
  const tv = { videoId: null, title: '', channel: '', state: 'stopped', currentTime: 0, duration: 0, at: 0, volume: null, muted: false, online: null };

  async function cfg() {
    if (!config) {
      const saved = (await load().catch(() => null)) ?? {};
      config = {
        screens: Array.isArray(saved.screens) ? saved.screens.filter((s) => s && typeof s.id === 'string') : [],
        current: typeof saved.current === 'string' ? saved.current : null,
        history: Array.isArray(saved.history) ? saved.history.filter((v) => VIDEO_ID.test(v?.id ?? '')) : [],
      };
      if (!config.screens.some((s) => s.id === config.current)) config.current = config.screens[0]?.id ?? null;
      for (const v of config.history) titles.set(v.id, { title: v.title, channel: v.channel });
    }
    return config;
  }

  function persist() {
    const snapshot = JSON.parse(JSON.stringify(config));
    saving = saving.then(() => save(snapshot)).catch((err) => console.error('Saving youtube.json failed', err));
    return saving;
  }

  async function status() {
    const c = await cfg();
    return {
      screens: c.screens.map((s) => ({ id: s.id, name: s.name, dial: Boolean(s.dial) })),
      current: c.current,
      connected: Boolean(session?.sid),
      tv: { ...tv, thumb: tv.videoId ? thumbnail(tv.videoId) : null },
      history: c.history.map((v) => ({ ...v, thumb: thumbnail(v.id) })),
    };
  }

  let broadcastTimer = null;
  function changed() {
    // Events often arrive in bursts; one update per burst is enough.
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(async () => {
      broadcastTimer = null;
      broadcast(await status());
    }, 150);
  }

  async function currentScreen() {
    const c = await cfg();
    const screen = c.screens.find((s) => s.id === c.current);
    if (!screen) throw new YouTubeError(409, 'No TV is linked yet');
    return screen;
  }

  // ---- HTTP helpers ----

  async function request(url, init = {}) {
    try {
      return await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT), ...init });
    } catch (err) {
      throw new YouTubeError(502, `YouTube unreachable (${err.message})`);
    }
  }

  const form = (url, fields, init = {}) =>
    request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(init.headers ?? {}) },
      body: new URLSearchParams(fields).toString(),
      ...init,
    });

  async function json(res) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  // ---- Linking ----

  async function addScreen({ id, name, token, expires, dial = null }) {
    const c = await cfg();
    const existing = c.screens.find((s) => s.id === id);
    const screen = { id, name: name || existing?.name || 'TV', token, expires: Number(expires) || null, dial: dial ?? existing?.dial ?? null };
    c.screens = [...c.screens.filter((s) => s.id !== id), screen];
    if (c.current !== id) await disconnect();
    c.current = id;
    await persist();
    changed();
    return screen;
  }

  async function pair(code) {
    const digits = String(code ?? '').replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 16) throw new YouTubeError(400, 'Enter the 12-digit code shown on the TV');
    const res = await form(`${LOUNGE}/pairing/get_screen`, { pairing_code: digits });
    const screen = res.ok ? (await json(res))?.screen : null;
    if (!screen?.screenId || !screen.loungeToken) {
      throw new YouTubeError(400, "That code didn't work. Codes change often: check the TV and try again.");
    }
    await addScreen({ id: screen.screenId, name: screen.name, token: screen.loungeToken, expires: screen.expiration });
    void ensureSession().catch(() => {});
    return status();
  }

  /** Swaps a screen id for a fresh lounge token. */
  async function tokenFor(screenId) {
    const res = await form(`${LOUNGE}/pairing/get_lounge_token_batch`, { screen_ids: screenId });
    const screen = res.ok ? (await json(res))?.screens?.[0] : null;
    if (!screen?.loungeToken) throw new YouTubeError(502, 'YouTube no longer knows this TV. Link it again.');
    return { token: screen.loungeToken, expires: Number(screen.expiration) || null };
  }

  async function freshToken(screen, force = false) {
    if (!force && screen.token && (!screen.expires || screen.expires - now() > TOKEN_MARGIN)) return screen.token;
    Object.assign(screen, await tokenFor(screen.id));
    await persist();
    return screen.token;
  }

  // ---- DIAL ----

  async function describe(location) {
    let res;
    try {
      res = await fetchImpl(location, { signal: AbortSignal.timeout(4000) });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const appBase = res.headers.get('application-url');
    const xml = await res.text();
    if (!appBase) return null;
    let appUrl;
    try {
      appUrl = appUrlFor(new URL(appBase, location).href);
    } catch {
      return null;
    }
    const device = {
      location,
      appUrl,
      udn: xmlTag(xml, 'UDN') || location,
      name: xmlTag(xml, 'friendlyName') || 'TV',
      model: [xmlTag(xml, 'manufacturer'), xmlTag(xml, 'modelName')].filter(Boolean).join(' '),
    };
    const app = await dialApp(appUrl);
    return app ? { ...device, ...app } : null;
  }

  async function dialApp(appUrl) {
    try {
      const res = await fetchImpl(appUrl, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return null;
      return parseDialApp(await res.text());
    } catch {
      return null;
    }
  }

  async function dialLaunch(appUrl, fields) {
    const res = await fetchImpl(appUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset="utf-8"' },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    return Boolean(res && res.status < 300);
  }

  async function discover() {
    const locations = await discoverLocations();
    const devices = (await Promise.all(locations.map(describe))).filter(Boolean);
    const c = await cfg();
    dialSeen.clear();
    for (const d of devices) dialSeen.set(d.udn, d);
    return {
      devices: devices.map((d) => ({
        udn: d.udn,
        name: d.name,
        model: d.model,
        running: d.state === 'running',
        linked: c.screens.some((s) => s.dial?.udn === d.udn || (d.screenId && s.id === d.screenId)),
      })),
    };
  }

  /** The TV's current DIAL address; looks again if it moved (new IP from the router). */
  async function dialDevice(dial) {
    if (await dialApp(dial.appUrl)) return dial;
    await discover().catch(() => {});
    const found = dialSeen.get(dial.udn);
    return found ? { location: found.location, appUrl: found.appUrl, udn: found.udn } : null;
  }

  async function link(udn) {
    const device = dialSeen.get(String(udn ?? ''));
    if (!device) throw new YouTubeError(404, 'That TV is no longer on the list. Search again.');
    const dial = { location: device.location, appUrl: device.appUrl, udn: device.udn };
    let screenId = device.state === 'running' ? device.screenId : null;
    const pairingCode = crypto.randomUUID();
    if (!screenId && !(await dialLaunch(device.appUrl, { pairingCode, theme: 'cl' }))) {
      throw new YouTubeError(502, `${device.name} didn't open YouTube. Use the TV code instead.`);
    }
    const deadline = now() + launchWaitMs;
    while (!screenId && now() < deadline) {
      await wait(1500);
      // Newer apps answer the pairing code we launched with; older ones show their screen id.
      const res = await form(`${LOUNGE}/pairing/get_screen`, { pairing_code: pairingCode }).catch(() => null);
      const screen = res?.ok ? (await json(res))?.screen : null;
      if (screen?.screenId && screen.loungeToken) {
        await addScreen({ id: screen.screenId, name: device.name, token: screen.loungeToken, expires: screen.expiration, dial });
        void ensureSession().catch(() => {});
        return status();
      }
      screenId = (await dialApp(device.appUrl))?.screenId ?? null;
    }
    if (!screenId) throw new YouTubeError(504, `${device.name} opened YouTube but didn't answer. Use the TV code instead.`);
    const { token, expires } = await tokenFor(screenId);
    await addScreen({ id: screenId, name: device.name, token, expires, dial });
    void ensureSession().catch(() => {});
    return status();
  }

  // ---- The Lounge session ----

  /** Query parameters every request on an open session carries. */
  function common(s) {
    const p = {
      name: DEVICE_NAME,
      loungeIdToken: s.token,
      SID: s.sid,
      gsessionid: s.gsession,
      device: 'REMOTE_CONTROL',
      app: 'youtube-desktop',
      VER: '8',
      v: '2',
    };
    if (s.aid !== null) p.AID = String(s.aid);
    return p;
  }

  function applyNowPlaying(data) {
    const id = data?.videoId;
    if (id && VIDEO_ID.test(id) && id !== tv.videoId) {
      tv.videoId = id;
      const known = titles.get(id);
      tv.title = known?.title ?? '';
      tv.channel = known?.channel ?? '';
      if (!known) void lookupTitle(id);
    } else if (!id) {
      tv.videoId = null;
      tv.title = '';
      tv.channel = '';
    }
    applyState(data);
  }

  function applyState(data) {
    if (!data) return;
    if (data.state !== undefined) tv.state = STATES[String(data.state)] ?? tv.state;
    if (data.currentTime !== undefined) tv.currentTime = Number(data.currentTime) || 0;
    if (data.duration !== undefined) tv.duration = Number(data.duration) || 0;
    tv.at = now();
  }

  async function lookupTitle(id) {
    try {
      const res = await fetchImpl(`${OEMBED_URL}?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, {
        signal: AbortSignal.timeout(TIMEOUT),
      });
      const data = res.ok ? await res.json() : null;
      if (!data?.title) return;
      titles.set(id, { title: data.title, channel: data.author_name ?? '' });
      if (tv.videoId === id) {
        tv.title = data.title;
        tv.channel = data.author_name ?? '';
        changed();
      }
    } catch {
      // The title just stays blank.
    }
  }

  function processEvents(s, batch) {
    if (!Array.isArray(batch)) return;
    for (const event of batch) {
      if (!Array.isArray(event) || !Array.isArray(event[1])) continue;
      const [id, [type, ...args]] = event;
      if (typeof id === 'number') s.aid = id;
      const data = args[0];
      switch (type) {
        case 'c':
          s.sid = data;
          break;
        case 'S':
          s.gsession = data;
          break;
        case 'nowPlaying':
          applyNowPlaying(data);
          tv.online = true;
          break;
        case 'onStateChange':
          applyState(data);
          tv.online = true;
          break;
        case 'onVolumeChanged':
          tv.volume = Number(data?.volume);
          if (!Number.isFinite(tv.volume)) tv.volume = null;
          tv.muted = data?.muted === 'true' || data?.muted === true;
          break;
        case 'onAdStateChange':
        case 'adPlaying':
          tv.state = 'ad';
          break;
        case 'loungeStatus':
          try {
            const devices = JSON.parse(data?.devices ?? '[]');
            tv.online = devices.some((d) => d.type === 'LOUNGE_SCREEN');
          } catch {
            // leave as is
          }
          break;
        case 'loungeScreenDisconnected':
          tv.online = false;
          tv.state = 'stopped';
          if (session === s) dropSession();
          break;
        default:
          break;
      }
    }
    changed();
  }

  function dropSession() {
    session?.abort.abort();
    session = null;
    changed();
  }

  async function connect(screen) {
    const token = await freshToken(screen);
    const res = await form(`${LOUNGE}/bc/bind?RID=1&VER=8&CVER=1&auth_failure_option=send_error`, {
      app: 'web',
      'mdx-version': '3',
      name: DEVICE_NAME,
      id: screen.id,
      device: 'REMOTE_CONTROL',
      capabilities: 'que,dsdtr,atp,vsp',
      magnaKey: 'cloudPairedDevice',
      ui: 'false',
      deviceContext: 'user_agent=dunno&window_width_points=&window_height_points=&os_name=android&ms=',
      theme: 'cl',
      loungeIdToken: token,
    });
    if (res.status === 401) return null;
    if (!res.ok) throw new YouTubeError(502, `YouTube refused the connection (${res.status})`);
    const s = { screenId: screen.id, token, sid: null, gsession: null, aid: null, ofs: 1, abort: new AbortController() };
    for (const batch of parseChunks(await res.text()).batches) processEvents(s, batch);
    if (!s.sid || !s.gsession) throw new YouTubeError(502, 'YouTube sent an unexpected reply');
    return s;
  }

  async function ensureSession() {
    lastUse = now();
    const screen = await currentScreen();
    if (session?.screenId === screen.id) return session;
    if (connecting) return connecting;
    connecting = (async () => {
      let s = await connect(screen);
      if (!s) {
        // The lounge token expired early; renew it once.
        await freshToken(screen, true);
        s = await connect(screen);
        if (!s) throw new YouTubeError(502, 'YouTube rejected the TV link. Link the TV again.');
      }
      session?.abort.abort();
      session = s;
      changed();
      void listen(s);
      return s;
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  /** Long-polls the TV's events (play state, position, volume) while the session lasts. */
  async function listen(s) {
    let failures = 0;
    while (session === s && !stopped) {
      if (now() - lastUse > idleMs && tv.state !== 'playing') {
        await disconnect();
        return;
      }
      const params = new URLSearchParams({ ...common(s), RID: 'rpc', CI: '0', TYPE: 'xmlhttp' });
      const started = now();
      try {
        const res = await fetchImpl(`${LOUNGE}/bc/bind?${params}`, { signal: s.abort.signal });
        if (res.status === 400 || res.status === 404 || res.status === 410 || res.status === 401) {
          // The session ended on YouTube's side; the next use opens a new one.
          if (session === s) dropSession();
          return;
        }
        if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          const { batches, rest } = parseChunks(buffer);
          buffer = rest;
          for (const batch of batches) processEvents(s, batch);
          if (session !== s) return;
        }
        failures = 0;
        // A poll normally stays open for minutes; don't spin if YouTube keeps closing it at once.
        if (now() - started < 1000) await wait(2000);
      } catch {
        if (s.abort.signal.aborted || session !== s) return;
        failures++;
        await wait(Math.min(30_000, 1000 * 2 ** failures));
      }
    }
  }

  async function disconnect() {
    const s = session;
    if (!s) return;
    session = null;
    s.abort.abort();
    changed();
    const params = new URLSearchParams({ ...common(s), RID: String(s.ofs + 1), CVER: '1', auth_failure_option: 'send_error' });
    await form(`${LOUNGE}/bc/bind?${params}`, {
      ui: '',
      TYPE: 'terminate',
      clientDisconnectReason: 'MDX_SESSION_DISCONNECT_REASON_DISCONNECTED_BY_USER',
    }).catch(() => {});
  }

  /** Sends one remote command, reopening the session once if YouTube dropped it. */
  async function command(name, params = {}, retry = true) {
    const s = await ensureSession();
    const body = { count: '1', ofs: String(s.ofs), req0__sc: name };
    for (const [k, v] of Object.entries(params)) body[`req0_${k}`] = String(v);
    s.ofs++;
    const query = new URLSearchParams({ ...common(s), RID: String(s.ofs) });
    const res = await form(`${LOUNGE}/bc/bind?${query}`, body);
    if (res.ok) return;
    if (retry && [400, 401, 404, 410].includes(res.status)) {
      if (session === s) dropSession();
      if (res.status === 401) await freshToken(await currentScreen(), true);
      return command(name, params, false);
    }
    throw new YouTubeError(502, `The TV didn't take the command (${res.status})`);
  }

  async function isOnline(screen) {
    try {
      const res = await form(`${LOUNGE}/pairing/get_screen_availability`, { lounge_token: await freshToken(screen) });
      const status = res.ok ? (await json(res))?.screens?.[0]?.status : null;
      return status ? status === 'online' : null;
    } catch {
      return null;
    }
  }

  /** If the TV's YouTube app is closed and the TV was found by DIAL, starts it. Returns online state. */
  async function wakeTv(screen, videoId) {
    let online = await isOnline(screen);
    if (online !== false || !screen.dial) return online;
    const dial = await dialDevice(screen.dial);
    if (!dial || !(await dialLaunch(dial.appUrl, { v: videoId, theme: 'cl' }))) return false;
    if (dial.appUrl !== screen.dial.appUrl) {
      screen.dial = dial;
      await persist();
    }
    const deadline = now() + launchWaitMs;
    while (!online && now() < deadline) {
      await wait(1500);
      online = await isOnline(screen);
    }
    return online;
  }

  async function remember(video) {
    const c = await cfg();
    const entry = { id: video.id, title: video.title, channel: video.channel, at: now() };
    titles.set(video.id, { title: video.title, channel: video.channel });
    c.history = [entry, ...c.history.filter((v) => v.id !== video.id)].slice(0, MAX_HISTORY);
    await persist();
  }

  function videoFrom(body) {
    const id = videoIdFrom(body?.videoId ?? body?.id);
    if (!id) throw new YouTubeError(400, 'videoId is required');
    const known = titles.get(id);
    const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    return { id, title: str(body.title, 300) || known?.title || '', channel: str(body.channel, 120) || known?.channel || '' };
  }

  async function play(body) {
    const video = videoFrom(body);
    const screen = await currentScreen();
    const online = await wakeTv(screen, video.id);
    await command('setPlaylist', { videoId: video.id });
    if (!video.title) await lookupTitle(video.id);
    await remember({ ...video, ...(titles.get(video.id) ?? {}) });
    Object.assign(tv, { videoId: video.id, title: titles.get(video.id)?.title ?? video.title, channel: titles.get(video.id)?.channel ?? video.channel });
    Object.assign(tv, { state: 'buffering', currentTime: 0, duration: 0, at: now() });
    if (online !== null) tv.online = online;
    changed();
    return { ...(await status()), tvOnline: online };
  }

  async function queue(body) {
    const video = videoFrom(body);
    if (!tv.videoId || tv.state === 'stopped' || tv.state === 'ended') return play(body);
    await command('addVideo', { videoId: video.id });
    titles.set(video.id, { title: video.title, channel: video.channel });
    return status();
  }

  async function control(body) {
    const action = String(body?.action ?? '');
    const value = Number(body?.value);
    if (action === 'play' || action === 'pause') {
      await command(action);
      if (tv.videoId) {
        tv.currentTime = position();
        tv.at = now();
        tv.state = action === 'play' ? 'playing' : 'paused';
      }
    } else if (action === 'next' || action === 'previous') await command(action);
    else if (action === 'seek') {
      if (!Number.isFinite(value) || value < 0) throw new YouTubeError(400, 'value must be a time in seconds');
      await command('seekTo', { newTime: Math.round(value) });
      tv.currentTime = Math.round(value);
      tv.at = now();
    } else if (action === 'volume') {
      if (!Number.isFinite(value)) throw new YouTubeError(400, 'value must be 0-100');
      const volume = Math.max(0, Math.min(100, Math.round(value)));
      await command('setVolume', { volume });
      tv.volume = volume;
    } else throw new YouTubeError(400, 'action must be play, pause, next, previous, seek or volume');
    changed();
    return status();
  }

  function position() {
    const elapsed = tv.state === 'playing' ? (now() - tv.at) / 1000 : 0;
    return tv.duration ? Math.min(tv.duration, tv.currentTime + elapsed) : tv.currentTime + elapsed;
  }

  async function search(q) {
    const query = String(q ?? '').trim();
    if (!query) throw new YouTubeError(400, 'q is required');
    if (query.length > 150) throw new YouTubeError(400, 'Search is too long');
    const direct = videoIdFrom(query);
    if (direct && query.includes('/')) {
      await lookupTitle(direct);
      const t = titles.get(direct);
      return { results: [{ id: direct, title: t?.title ?? 'YouTube video', channel: t?.channel ?? '', duration: '', views: '', published: '', live: false, thumb: thumbnail(direct) }] };
    }
    const key = query.toLowerCase();
    const cached = searchCache.get(key);
    if (cached && now() - cached.at < SEARCH_TTL) return { results: cached.results };
    const ask = (params) =>
      request(SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          Origin: 'https://www.youtube.com',
          'X-YouTube-Client-Name': '1',
          'X-YouTube-Client-Version': CLIENT_VERSION,
        },
        body: JSON.stringify({
          context: { client: { clientName: 'WEB', clientVersion: CLIENT_VERSION, hl: 'en', gl: 'US' } },
          query,
          ...(params ? { params } : {}),
        }),
      });
    let res = await ask(VIDEOS_ONLY);
    // If YouTube stops understanding the filter, plain search still works.
    if (!res.ok) res = await ask(null);
    if (!res.ok) throw new YouTubeError(502, `YouTube search returned ${res.status}`);
    const results = parseSearch(await json(res));
    for (const v of results) if (!titles.has(v.id)) titles.set(v.id, { title: v.title, channel: v.channel });
    searchCache.set(key, { at: now(), results });
    if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);
    return { results };
  }

  async function select(id) {
    const c = await cfg();
    if (!c.screens.some((s) => s.id === id)) throw new YouTubeError(404, 'Unknown TV');
    if (c.current !== id) {
      await disconnect();
      c.current = id;
      Object.assign(tv, { videoId: null, title: '', channel: '', state: 'stopped', online: null, volume: null });
      await persist();
    }
    void ensureSession().catch(() => {});
    return status();
  }

  async function forget(id) {
    const c = await cfg();
    if (c.current === id) {
      await disconnect();
      Object.assign(tv, { videoId: null, title: '', channel: '', state: 'stopped', online: null, volume: null });
    }
    c.screens = c.screens.filter((s) => s.id !== id);
    if (!c.screens.some((s) => s.id === c.current)) c.current = c.screens[0]?.id ?? null;
    await persist();
    changed();
    return status();
  }

  async function handle(method, parts, body, query = new URLSearchParams()) {
    const [, action, arg] = parts;
    lastUse = now();
    if (method === 'GET' && !action) {
      // A screen showing the widget keeps the TV session open, so the tile can show what's on.
      if (query.has('connect') && (await cfg()).current && !session) void ensureSession().catch(() => {});
      return status();
    }
    if (method === 'GET' && action === 'search') return search(query.get('q'));
    if (method === 'GET' && action === 'discover') return discover();
    if (method === 'POST' && action === 'pair') return pair(body?.code);
    if (method === 'POST' && action === 'link') return link(body?.udn);
    if (method === 'POST' && action === 'play') return play(body);
    if (method === 'POST' && action === 'queue') return queue(body);
    if (method === 'POST' && action === 'control') return control(body);
    if (method === 'POST' && action === 'select') return select(String(body?.id ?? ''));
    if (method === 'DELETE' && action === 'screens' && arg) return forget(arg);
    if (method === 'DELETE' && action === 'history') {
      (await cfg()).history = [];
      await persist();
      changed();
      return status();
    }
    throw new YouTubeError(404, 'Not found');
  }

  function stop() {
    stopped = true;
    clearTimeout(broadcastTimer);
    session?.abort.abort();
    session = null;
  }

  return { handle, status, search, play, queue, control, pair, discover, link, stop, position };
}
