// PiDisplay backend: serves the built UI, persists layout and widget data as
// JSON files, and pushes live events (notifications, data changes) over SSE.
// Dependency-free on purpose so it runs on a bare Raspberry Pi Node install.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createWeather, WeatherError } from './weather.js';
import { createSystem } from './system.js';
import { createCalendar, CalendarError } from './calendar.js';
import { createKiosk } from './kiosk.js';
import { createNetwork, NetworkError } from './network.js';
import { createTimers, TimersError } from './timers.js';
import { createSpotify, SpotifyError } from './spotify.js';
import { createAudio, AudioError } from './audio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 1024 * 1024;
const MAX_NOTIFICATIONS = 100;
const STORE_KEY = /^[a-zA-Z0-9._-]{1,120}$/;
const LEVELS = new Set(['info', 'success', 'warning', 'alert']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// Write to a temp file then rename, so a power cut never leaves half a file.
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Unique per write: two saves of the same key can overlap.
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A small standalone page for the Spotify sign-in redirect, shown in whichever browser signed in. */
function sendPage(res, status, title, message, returnTo) {
  const back = returnTo
    ? `<p><a href="${escapeHtml(returnTo)}">Back to the dashboard</a></p><script>setTimeout(() => location.replace(${JSON.stringify(returnTo)}), 2500)</script>`
    : '<p>You can close this tab.</p>';
  res.writeHead(status, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:20px system-ui,sans-serif;background:#0b0e13;color:#eef2f7;display:grid;place-items:center;min-height:90vh;margin:0;text-align:center;padding:16px}a{color:#4da3ff}h1{font-size:30px}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${back}</main></body></html>`);
}

function validateLayout(layout) {
  const ok =
    layout &&
    typeof layout === 'object' &&
    layout.settings &&
    typeof layout.settings === 'object' &&
    Array.isArray(layout.pages) &&
    layout.pages.length > 0 &&
    layout.pages.every((p) => p && typeof p.id === 'string' && Array.isArray(p.tiles)) &&
    layout.topBar &&
    Array.isArray(layout.topBar.left) &&
    Array.isArray(layout.topBar.right);
  if (!ok) throw new HttpError(400, 'Invalid layout');
}

export function createServer({
  dataDir = process.env.PIDISPLAY_DATA || path.join(ROOT, 'data'),
  distDir = path.join(ROOT, 'dist'),
  defaultLayoutFile = path.join(ROOT, 'server', 'default-layout.json'),
  fetchImpl = globalThis.fetch,
  system = createSystem(),
  kiosk = createKiosk(),
  network = createNetwork(),
  audio = createAudio(),
  spotify = undefined,
  timerTickMs = 1000,
} = {}) {
  const layoutFile = path.join(dataDir, 'layout.json');
  const notificationsFile = path.join(dataDir, 'notifications.json');
  const storeDir = path.join(dataDir, 'store');
  // Written by Farewatcher (Python, systemd timer) after each run; read-only here.
  const faresFile = path.join(dataDir, 'farewatcher.json');
  const clients = new Set();
  const weather = createWeather({ fetchImpl });
  // Secret iCal feed URLs, edited by hand on the Pi; see docs/CALENDAR.md.
  const calendar = createCalendar({ configFile: path.join(dataDir, 'calendars.json'), fetchImpl });
  // Spotify tokens, plus librespot's cache, which holds its login once it has been linked.
  spotify ??= createSpotify({
    configFile: path.join(dataDir, 'spotify.json'),
    receiverCacheDir: path.join(dataDir, 'spotify-cache'),
    redirectUri: `http://127.0.0.1:${Number(process.env.PORT) || 8080}/api/spotify/callback`,
    fetchImpl,
  });

  function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  }

  // Serialized so two notifications arriving together can't drop one another.
  let notifyQueue = Promise.resolve();
  function addNotification({ title, body, source, level }) {
    const n = {
      id: crypto.randomUUID(),
      title: title.slice(0, 200),
      body: typeof body === 'string' ? body.slice(0, 2000) : '',
      source: typeof source === 'string' ? source.slice(0, 60) : 'system',
      level: LEVELS.has(level) ? level : 'info',
      time: new Date().toISOString(),
    };
    const done = notifyQueue.then(async () => {
      const list = await readJson(notificationsFile, []);
      await writeJson(notificationsFile, [n, ...list].slice(0, MAX_NOTIFICATIONS));
      broadcast('notification', n);
      return n;
    });
    notifyQueue = done.catch((err) => console.error('Saving notification failed', err));
    return done;
  }

  const timersFile = path.join(dataDir, 'timers.json');
  const timers = createTimers({
    load: () => readJson(timersFile, null),
    save: (value) => writeJson(timersFile, value),
    notify: (n) => void addNotification({ ...n, source: 'Timers' }).catch(() => {}),
    broadcast: (snapshot) => broadcast('timers', snapshot),
    tickMs: timerTickMs,
  });

  async function loadLayout() {
    const saved = await readJson(layoutFile, null);
    return saved ?? readJson(defaultLayoutFile, null);
  }

  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
    const clientId = String(req.headers['x-client-id'] ?? '');
    const [resource, key] = parts;

    if (resource === 'health' && req.method === 'GET') return send(res, 200, { ok: true });

    if (resource === 'events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (resource === 'layout' && !key) {
      if (req.method === 'GET') return send(res, 200, await loadLayout());
      if (req.method === 'PUT') {
        const layout = await readBody(req);
        validateLayout(layout);
        await writeJson(layoutFile, layout);
        broadcast('layout', { clientId });
        return send(res, 204);
      }
      if (req.method === 'DELETE') {
        await fs.rm(layoutFile, { force: true });
        broadcast('layout', { clientId });
        return send(res, 204);
      }
    }

    if (resource === 'store' && key) {
      if (!STORE_KEY.test(key)) throw new HttpError(400, 'Invalid store key');
      const file = path.join(storeDir, `${key}.json`);
      if (req.method === 'GET') {
        const value = await readJson(file, undefined);
        return value === undefined ? send(res, 404, { error: 'Not found' }) : send(res, 200, value);
      }
      if (req.method === 'PUT') {
        await writeJson(file, await readBody(req));
        broadcast('store', { key, clientId });
        return send(res, 204);
      }
    }

    if (resource === 'kiosk' && key === 'exit' && req.method === 'POST') {
      if (!kiosk.supported) throw new HttpError(501, 'Exit to desktop only works on the Pi');
      await kiosk.exit();
      return send(res, 204);
    }

    if (resource === 'wifi' || resource === 'bluetooth') {
      try {
        return await handleNetwork(req, res, url, resource, key);
      } catch (err) {
        if (err instanceof NetworkError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }

    if (resource === 'timers' || resource === 'alarms') {
      try {
        const body = req.method === 'GET' || req.method === 'DELETE' ? null : await readBody(req);
        return send(res, 200, await timers.handle(req.method, parts, body));
      } catch (err) {
        if (err instanceof TimersError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }

    if (resource === 'spotify') {
      try {
        return await handleSpotify(req, res, url, parts, key);
      } catch (err) {
        if (err instanceof SpotifyError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }

    if (resource === 'audio') {
      try {
        if (req.method === 'GET' && !key) return send(res, 200, await audio.status());
        if (req.method === 'POST' && key === 'select') return send(res, 200, await audio.select((await readBody(req))?.name));
        if (req.method === 'POST' && key === 'volume') {
          const body = (await readBody(req)) ?? {};
          return send(res, 200, await audio.setVolume(body.name, body.volume));
        }
        throw new HttpError(404, 'Not found');
      } catch (err) {
        if (err instanceof AudioError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }

    if (resource === 'system' && !key && req.method === 'GET') return send(res, 200, await system.get());

    if (resource === 'fares' && !key && req.method === 'GET') {
      const summary = await readJson(faresFile, null).catch(() => null);
      return send(res, 200, summary ? { available: true, ...summary } : { available: false });
    }

    if (resource === 'weather' && !key && req.method === 'GET') {
      try {
        const data = await weather.get(url.searchParams.get('location'), url.searchParams.get('units') ?? undefined);
        return send(res, 200, data);
      } catch (err) {
        if (err instanceof WeatherError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }

    if (resource === 'calendar' && !key && req.method === 'GET') {
      try {
        const q = url.searchParams;
        return send(res, 200, await calendar.get({ from: q.get('from'), to: q.get('to'), tz: q.get('tz') }));
      } catch (err) {
        if (err instanceof CalendarError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }

    if (resource === 'notifications') {
      const list = await readJson(notificationsFile, []);
      if (req.method === 'GET' && !key) return send(res, 200, list);
      if (req.method === 'POST' && !key) {
        const body = await readBody(req);
        if (!body || typeof body.title !== 'string' || !body.title.trim()) {
          throw new HttpError(400, 'title is required');
        }
        const n = await addNotification(body);
        return send(res, 201, n);
      }
      if (req.method === 'DELETE') {
        const next = key ? list.filter((n) => n.id !== key) : [];
        await writeJson(notificationsFile, next);
        broadcast('notifications-cleared', { id: key ?? null });
        return send(res, 204);
      }
    }

    throw new HttpError(404, 'Not found');
  }

  async function handleSpotify(req, res, url, parts, key) {
    // Sign-in happens in a browser tab (on the Pi, or on the laptop through an SSH
    // tunnel), so these two answer with redirects and pages instead of JSON.
    if (key === 'login' && req.method === 'GET') {
      try {
        res.writeHead(302, { Location: await spotify.loginUrl(url.searchParams.get('return')), 'Cache-Control': 'no-store' });
        return res.end();
      } catch (err) {
        if (!(err instanceof SpotifyError)) throw err;
        return sendPage(res, err.status, 'Spotify', err.message, url.searchParams.get('return')?.startsWith('/') ? '/' : null);
      }
    }
    if (key === 'callback' && req.method === 'GET') {
      try {
        const { returnTo } = await spotify.callback(url.searchParams);
        broadcast('spotify', { connected: true });
        return sendPage(res, 200, 'Spotify connected', 'PiDisplay can now show and control your music.', returnTo);
      } catch (err) {
        if (!(err instanceof SpotifyError)) throw err;
        return sendPage(res, err.status, 'Spotify sign-in failed', err.message, null);
      }
    }
    const body = req.method === 'GET' ? null : await readBody(req);
    const result = await spotify.handle(req.method, parts, body, url.searchParams);
    if (key === 'client' || key === 'logout') broadcast('spotify', { connected: Boolean(result.connected) });
    return send(res, 200, result);
  }

  async function handleNetwork(req, res, url, resource, action) {
    const { wifi, bluetooth } = network;
    if (req.method === 'GET' && !action) {
      if (resource === 'wifi') return send(res, 200, await wifi.status({ rescan: url.searchParams.has('rescan') }));
      return send(res, 200, await bluetooth.status());
    }
    if (req.method !== 'POST') throw new HttpError(404, 'Not found');
    const body = (await readBody(req)) ?? {};
    if (resource === 'wifi') {
      if (action === 'connect') await wifi.connect(body.ssid, body.password || undefined);
      else if (action === 'disconnect') await wifi.disconnect();
      else if (action === 'forget') await wifi.forget(body.uuid);
      else if (action === 'power') await wifi.setEnabled(Boolean(body.on));
      else throw new HttpError(404, 'Not found');
      return send(res, 200, await wifi.status());
    }
    if (action === 'scan') return send(res, 200, await bluetooth.scan());
    if (action === 'power') await bluetooth.setPowered(Boolean(body.on));
    else if (action === 'pair') await bluetooth.pair(body.mac);
    else if (action === 'connect') await bluetooth.connect(body.mac);
    else if (action === 'disconnect') await bluetooth.disconnect(body.mac);
    else if (action === 'forget') await bluetooth.remove(body.mac);
    else throw new HttpError(404, 'Not found');
    return send(res, 200, await bluetooth.status());
  }

  async function serveStatic(req, res, url) {
    const rel = decodeURIComponent(url.pathname);
    let file = path.resolve(distDir, `.${rel}`);
    if (!file.startsWith(distDir)) throw new HttpError(403, 'Forbidden');
    let stat = await fs.stat(file).catch(() => null);
    if (!stat || stat.isDirectory()) {
      file = path.join(distDir, 'index.html');
      stat = await fs.stat(file).catch(() => null);
      if (!stat) throw new HttpError(404, 'UI not built yet. Run `npm run build`.');
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      // Vite fingerprints assets, so they can be cached forever; index.html can't.
      'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(await fs.readFile(file));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, url);
      else throw new HttpError(405, 'Method not allowed');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: err.message });
      else res.end();
    }
  });

  // Keep SSE connections alive through proxies and detect dead clients.
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25000);
  server.on('close', () => {
    clearInterval(heartbeat);
    timers.stop();
    for (const res of clients) res.end();
  });

  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  // Localhost by default: the API can rewrite the dashboard, so only expose it
  // on the LAN deliberately (HOST=0.0.0.0) e.g. to edit from a phone.
  const host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => {
    console.log(`PiDisplay listening on http://${host}:${port}`);
  });
}
