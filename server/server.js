// PiDisplay backend: serves the built UI, persists layout and widget data as
// JSON files, and pushes live events (notifications, data changes) over SSE.
// Dependency-free on purpose so it runs on a bare Raspberry Pi Node install.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
  const tmp = `${file}.${process.pid}.tmp`;
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
} = {}) {
  const layoutFile = path.join(dataDir, 'layout.json');
  const notificationsFile = path.join(dataDir, 'notifications.json');
  const storeDir = path.join(dataDir, 'store');
  const clients = new Set();

  function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  }

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

    if (resource === 'notifications') {
      const list = await readJson(notificationsFile, []);
      if (req.method === 'GET' && !key) return send(res, 200, list);
      if (req.method === 'POST' && !key) {
        const body = await readBody(req);
        if (!body || typeof body.title !== 'string' || !body.title.trim()) {
          throw new HttpError(400, 'title is required');
        }
        const n = {
          id: crypto.randomUUID(),
          title: body.title.slice(0, 200),
          body: typeof body.body === 'string' ? body.body.slice(0, 2000) : '',
          source: typeof body.source === 'string' ? body.source.slice(0, 60) : 'system',
          level: LEVELS.has(body.level) ? body.level : 'info',
          time: new Date().toISOString(),
        };
        await writeJson(notificationsFile, [n, ...list].slice(0, MAX_NOTIFICATIONS));
        broadcast('notification', n);
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
