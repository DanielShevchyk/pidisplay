// Photos for the photo gallery widget, from two kinds of source:
//  - local: image files in $PIDISPLAY_DATA/photos, one subfolder per album
//    (deploy/photos.ps1 uploads them from the laptop). Big camera files are shrunk
//    to screen size with ImageMagick and cached, so the Pi's browser never has to
//    decode a 12-megapixel photo.
//  - google: public Google Photos shared-album links listed in photos.json. Google
//    removed library access for personal apps in 2025, but a shared album's page
//    still carries its whole photo list, and Google's image server resizes for us.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff']);
const HEIC_EXT = new Set(['.heic', '.heif']);
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
/** Screen-sized and grid-thumbnail renditions. The display is 1920x1080. */
export const SIZES = { full: [1920, 1080], thumb: [400, 400] };
const GOOGLE_TTL = 30 * 60 * 1000;
const LOCAL_TTL = 60 * 1000;
const PRUNE_EVERY = 10 * 60 * 1000;
const TIMEOUT = 15_000;
const MAX_DEPTH = 3;
const DEFAULT_ALBUM = 'Photos';
const GOOGLE_PHOTO = /"(https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_-]{20,})"(?:,(\d+),(\d+))?/g;
const SHARE_HOSTS = new Set(['photos.app.goo.gl', 'photos.google.com', 'goo.gl']);

export class PhotosError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Unique /pw/ photo URLs (with pixel size when given) from a shared album's page. */
export function parseGoogleAlbum(html) {
  const seen = new Map();
  for (const m of html.matchAll(GOOGLE_PHOTO)) {
    const prev = seen.get(m[1]);
    if (!prev || (!prev.w && m[2])) seen.set(m[1], { base: m[1], w: Number(m[2]) || null, h: Number(m[3]) || null });
  }
  return [...seen.values()];
}

export function isShareUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && SHARE_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** ImageMagick 6 (`convert`) as Raspberry Pi OS ships it; null when it isn't installed. */
export async function detectImageMagick() {
  const run = (cmd, args) =>
    new Promise((resolve) => execFile(cmd, args, { timeout: 10_000, maxBuffer: 4 << 20 }, (err, out) => resolve(err ? null : out)));
  const version = await run('convert', ['-version']);
  if (!version || !/ImageMagick/.test(version)) return null;
  const formats = (await run('convert', ['-list', 'format'])) ?? '';
  const nice = process.platform === 'linux' && (await run('nice', ['true'])) !== null;
  return {
    heic: /^\s*HEIC\*?\s+\S+\s+r/m.test(formats),
    resize(src, dest, [w, h]) {
      const args = [
        // Lets libjpeg decode at a fraction of full size: much faster on the Pi.
        '-define', `jpeg:size=${w * 2}x${h * 2}`,
        `${src}[0]`, '-auto-orient', '-resize', `${w}x${h}${w === h ? '^' : '>'}`,
        ...(w === h ? ['-gravity', 'center', '-extent', `${w}x${h}`] : []),
        '-strip', '-quality', '82', `jpg:${dest}`,
      ];
      return new Promise((resolve, reject) =>
        execFile(nice ? 'nice' : 'convert', nice ? ['-n', '15', 'convert', ...args] : args, { timeout: 120_000 }, (err) =>
          err ? reject(err) : resolve(),
        ),
      );
    },
  };
}

export function createPhotos({
  dir,
  cacheDir,
  configFile,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  imageMagick = detectImageMagick(),
} = {}) {
  const google = new Map(); // url -> { at, photos, error? }
  const inflight = new Map();
  let local = null; // { at, photos }
  let scanning = null;
  let lastPrune = 0;

  // ---- Local folder ------------------------------------------------------

  async function walk(rel, depth, out, heic) {
    const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch((err) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < MAX_DEPTH) await walk(child, depth + 1, out, heic);
      else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!IMAGE_EXT.has(ext) && !(heic && HEIC_EXT.has(ext))) continue;
        const stat = await fs.stat(path.join(dir, child)).catch(() => null);
        if (stat) out.push({ rel: child, mtime: Math.round(stat.mtimeMs), size: stat.size });
      }
    }
    return out;
  }

  async function scanLocal() {
    if (local && now() - local.at < LOCAL_TTL) return local.photos;
    scanning ??= (async () => {
      const magick = await imageMagick;
      const files = await walk('', 0, [], Boolean(magick?.heic));
      files.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
      const photos = files.map((f) => {
        const slash = f.rel.indexOf('/');
        const v = `${f.mtime.toString(36)}${f.size.toString(36)}`;
        const q = `path=${encodeURIComponent(f.rel)}&v=${v}`;
        return {
          id: `local:${f.rel}`,
          source: 'local',
          album: slash > 0 ? f.rel.slice(0, slash) : DEFAULT_ALBUM,
          name: path.basename(f.rel, path.extname(f.rel)),
          src: `/api/photos/image?${q}&size=full`,
          thumb: `/api/photos/image?${q}&size=thumb`,
          file: f,
        };
      });
      local = { at: now(), photos };
      if (magick) warm(photos, magick);
      return photos;
    })().finally(() => {
      scanning = null;
    });
    return scanning;
  }

  const cacheName = (f, size) =>
    `${crypto.createHash('sha1').update(`${f.rel}\0${f.mtime}\0${f.size}\0${size}`).digest('hex')}.jpg`;

  // One ImageMagick at a time, niced, so resizing never starves the dashboard.
  // Browser requests jump ahead of the background warm-up.
  const queue = [];
  const jobs = new Map(); // dest -> promise
  let running = false;
  function resize(magick, f, size, urgent) {
    const dest = path.join(cacheDir, cacheName(f, size));
    let job = jobs.get(dest);
    if (job) {
      if (urgent) {
        const i = queue.findIndex((q) => q.dest === dest);
        if (i > 0) queue.unshift(...queue.splice(i, 1));
      }
      return job.promise;
    }
    job = { dest };
    job.promise = new Promise((resolve, reject) => Object.assign(job, { resolve, reject, magick, f, size }));
    jobs.set(dest, job);
    urgent ? queue.unshift(job) : queue.push(job);
    pump();
    return job.promise;
  }
  async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
      const job = queue.shift();
      try {
        if (!(await exists(job.dest))) {
          await fs.mkdir(cacheDir, { recursive: true });
          const tmp = `${job.dest}.${process.pid}.tmp`;
          await job.magick.resize(path.join(dir, job.f.rel), tmp, SIZES[job.size]);
          await fs.rename(tmp, job.dest);
        }
        job.resolve(job.dest);
      } catch (err) {
        job.reject(err);
      } finally {
        jobs.delete(job.dest);
      }
    }
    running = false;
  }

  function warm(photos, magick) {
    const keep = new Set();
    for (const p of photos) {
      for (const size of ['full', 'thumb']) {
        keep.add(cacheName(p.file, size));
        exists(path.join(cacheDir, cacheName(p.file, size))).then((ok) => {
          if (!ok) resize(magick, p.file, size, false).catch((err) => console.error(`Resizing ${p.file.rel} failed:`, err.message));
        });
      }
    }
    if (now() - lastPrune < PRUNE_EVERY) return;
    lastPrune = now();
    // Drop renditions of photos that were deleted or replaced.
    fs.readdir(cacheDir)
      .then((names) => Promise.all(names.filter((n) => n.endsWith('.jpg') && !keep.has(n)).map((n) => fs.rm(path.join(cacheDir, n), { force: true }))))
      .catch(() => {});
  }

  /** The file to send for a local photo: a cached rendition, or the original as a fallback. */
  async function image(rel, size = 'full') {
    if (!SIZES[size]) throw new PhotosError(400, 'Unknown size');
    const photos = await scanLocal();
    const photo = photos.find((p) => p.file.rel === rel);
    if (!photo) throw new PhotosError(404, 'No such photo');
    const magick = await imageMagick;
    if (magick) {
      try {
        return { file: await resize(magick, photo.file, size, true), type: 'image/jpeg' };
      } catch (err) {
        console.error(`Resizing ${rel} failed:`, err.message);
      }
    }
    const type = TYPES[path.extname(rel).toLowerCase()];
    if (!type) throw new PhotosError(415, 'This photo needs ImageMagick to be shown');
    return { file: path.join(dir, rel), type };
  }

  // ---- Google Photos shared albums --------------------------------------

  async function fetchGoogle(url) {
    let res;
    try {
      res = await fetchImpl(url, {
        signal: AbortSignal.timeout(TIMEOUT),
        redirect: 'follow',
        headers: {
          // The share page only includes the photo list for a normal browser.
          'User-Agent': 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
    } catch (err) {
      throw new PhotosError(502, `Google Photos unreachable (${err.message})`);
    }
    if (res.status === 404) throw new PhotosError(502, 'Album not found; is the link still shared?');
    if (!res.ok) throw new PhotosError(502, `Google Photos returned ${res.status}`);
    const photos = parseGoogleAlbum(await res.text());
    if (!photos.length) throw new PhotosError(502, 'No photos found; is the album shared with a link?');
    return photos;
  }

  async function googleAlbum(album) {
    const cached = google.get(album.url);
    if (cached && now() - cached.at < GOOGLE_TTL) return cached;
    if (!inflight.has(album.url)) {
      inflight.set(
        album.url,
        fetchGoogle(album.url)
          .then((photos) => ({ at: now(), photos }))
          .catch((err) => ({ at: now(), photos: cached?.photos ?? [], error: err.message, stale: Boolean(cached?.photos?.length) }))
          .then((entry) => {
            google.set(album.url, entry);
            return entry;
          })
          .finally(() => inflight.delete(album.url)),
      );
    }
    return inflight.get(album.url);
  }

  async function readConfig() {
    try {
      const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
      return (Array.isArray(config?.albums) ? config.albums : []).filter(
        (a) => a && typeof a.name === 'string' && a.name.trim() && isShareUrl(a.url),
      );
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw new PhotosError(500, `photos.json is not valid JSON (${err.message})`);
    }
  }

  // ---- Listing -----------------------------------------------------------

  /**
   * Photos and albums for the widget. source: 'all', 'local', 'google' or an album name.
   * Album links stay on the Pi; only image URLs reach the browser.
   */
  async function list({ source = 'all' } = {}) {
    const [w, h] = SIZES.full;
    const [tw, th] = SIZES.thumb;
    const albums = [];
    let photos = [];

    const wantLocal = source !== 'google';
    if (wantLocal) {
      const localPhotos = await scanLocal();
      const counts = new Map();
      for (const p of localPhotos) counts.set(p.album, (counts.get(p.album) ?? 0) + 1);
      for (const [name, count] of counts) albums.push({ name, source: 'local', count });
      photos.push(...localPhotos.map(({ file, ...p }) => p));
    }

    if (source !== 'local') {
      const configured = await readConfig();
      const entries = await Promise.all(configured.map(googleAlbum));
      configured.forEach((album, i) => {
        const entry = entries[i];
        albums.push({
          name: album.name,
          source: 'google',
          count: entry.photos.length,
          ...(entry.error && { error: entry.error }),
          ...(entry.stale && { stale: true }),
        });
        photos.push(
          ...entry.photos.map((p) => ({
            id: `google:${crypto.createHash('sha1').update(p.base).digest('hex').slice(0, 16)}`,
            source: 'google',
            album: album.name,
            name: '',
            src: `${p.base}=w${w}-h${h}`,
            thumb: `${p.base}=w${tw}-h${th}-c`,
          })),
        );
      });
    }

    if (!['all', 'local', 'google'].includes(source)) {
      const want = source.trim().toLowerCase();
      photos = photos.filter((p) => p.album.toLowerCase() === want);
    }
    const magick = await imageMagick;
    return { photos, albums, resizing: Boolean(magick), heic: Boolean(magick?.heic) };
  }

  return { list, image };
}

async function exists(file) {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}
