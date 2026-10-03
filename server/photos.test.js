import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPhotos, detectImageMagick, isShareUrl, parseGoogleAlbum } from './photos.js';

const ID = (n) => `AP1GczN${String(n).padStart(3, '0')}_abcdefghijklmnopqrstuvwxyz-0123456789`;
const lh3 = (n) => `https://lh3.googleusercontent.com/pw/${ID(n)}`;
// Shaped like the share page: og:image cover, contributor avatar, and the hydration payload.
const sharePage = (...ns) => `<!doctype html><html><head>
<meta property="og:image" content="${lh3(ns[0])}=w600-h315-p-k">
</head><body><img src="https://lh3.googleusercontent.com/a/ACg8ocJavatarAvatarAvatar=s40">
<script>AF_initDataCallback({key: 'ds:1', data:[null,[${ns
  .map((n) => `["AF1Qip${n}",["${lh3(n)}",4032,3024,null,null,null,null,null,null,[1]],1696000000000,"x"]`)
  .join(',')}]]});</script></body></html>`;

async function tempDirs() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photos-'));
  return { root, dir: path.join(root, 'photos'), cacheDir: path.join(root, 'cache'), configFile: path.join(root, 'photos.json') };
}

async function put(file, text = 'x') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

/** Stands in for ImageMagick: "resizes" by copying, and records each call. */
function fakeMagick() {
  const calls = [];
  return {
    calls,
    heic: false,
    async resize(src, dest, size) {
      calls.push([path.basename(src), size]);
      await fs.copyFile(src, dest);
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

test('parseGoogleAlbum finds each shared photo once, with its size, and skips avatars', () => {
  const photos = parseGoogleAlbum(sharePage(1, 2, 3));
  assert.deepEqual(
    photos.map((p) => [p.base, p.w, p.h]),
    [
      [lh3(1), 4032, 3024],
      [lh3(2), 4032, 3024],
      [lh3(3), 4032, 3024],
    ],
  );
  assert.deepEqual(parseGoogleAlbum('<html>nothing here</html>'), []);
});

test('isShareUrl accepts Google Photos share links only', () => {
  assert.ok(isShareUrl('https://photos.app.goo.gl/AbCdEf123'));
  assert.ok(isShareUrl('https://photos.google.com/share/AF1Qip?key=abc'));
  assert.ok(!isShareUrl('http://photos.app.goo.gl/AbCdEf123'));
  assert.ok(!isShareUrl('https://example.com/photos'));
  assert.ok(!isShareUrl('not a url'));
});

test('local photos: subfolders become albums, other files and dotfiles are ignored', async () => {
  const d = await tempDirs();
  await put(path.join(d.dir, 'loose.jpg'));
  await put(path.join(d.dir, 'Beach', 'img10.JPG'));
  await put(path.join(d.dir, 'Beach', 'img2.png'));
  await put(path.join(d.dir, 'Beach', 'notes.txt'));
  await put(path.join(d.dir, 'Beach', '.hidden.jpg'));
  await put(path.join(d.dir, 'Beach', 'phone.heic'));
  const photos = createPhotos({ ...d, imageMagick: Promise.resolve(null) });
  const res = await photos.list();
  assert.deepEqual(
    res.photos.map((p) => [p.album, p.name]),
    [
      ['Beach', 'img2'],
      ['Beach', 'img10'],
      ['Photos', 'loose'],
    ],
  );
  assert.deepEqual(res.albums, [
    { name: 'Beach', source: 'local', count: 2 },
    { name: 'Photos', source: 'local', count: 1 },
  ]);
  assert.equal(res.resizing, false);
  assert.match(res.photos[0].src, /^\/api\/photos\/image\?path=Beach%2Fimg2\.png&v=\w+&size=full$/);
  assert.equal(res.photos[0].file, undefined);

  assert.equal((await photos.list({ source: 'beach' })).photos.length, 2);
  assert.equal((await photos.list({ source: 'Nope' })).photos.length, 0);
});

test('a missing photos folder is just an empty list', async () => {
  const d = await tempDirs();
  const res = await createPhotos({ ...d, imageMagick: Promise.resolve(null) }).list();
  assert.deepEqual(res, { photos: [], albums: [], resizing: false, heic: false });
});

test('image() serves resized copies, warms the cache, and refuses unknown paths', async () => {
  const d = await tempDirs();
  await put(path.join(d.dir, 'Beach', 'a.jpg'), 'AAA');
  await put(path.join(d.dir, 'secret.txt'), 'no');
  await put(path.join(d.root, 'outside.jpg'), 'no');
  const magick = fakeMagick();
  const photos = createPhotos({ ...d, imageMagick: Promise.resolve(magick) });

  const thumb = await photos.image('Beach/a.jpg', 'thumb');
  assert.equal(thumb.type, 'image/jpeg');
  assert.ok(thumb.file.startsWith(d.cacheDir));
  assert.equal(await fs.readFile(thumb.file, 'utf8'), 'AAA');
  await settle();
  // Background warm-up made the full-size copy too, and nothing twice.
  assert.deepEqual(magick.calls.map((c) => c[1]).sort(), [[1920, 1080], [400, 400]]);
  await photos.image('Beach/a.jpg', 'thumb');
  assert.equal(magick.calls.length, 2);

  await assert.rejects(photos.image('../outside.jpg'), { status: 404 });
  await assert.rejects(photos.image('secret.txt'), { status: 404 });
  await assert.rejects(photos.image('Beach/a.jpg', 'huge'), { status: 400 });
});

test('image() falls back to the original when ImageMagick is missing', async () => {
  const d = await tempDirs();
  await put(path.join(d.dir, 'b.png'), 'PNG');
  const photos = createPhotos({ ...d, imageMagick: Promise.resolve(null) });
  const res = await photos.image('b.png');
  assert.deepEqual(res, { file: path.join(d.dir, 'b.png'), type: 'image/png' });
});

test('Google shared albums are fetched, cached, and kept through outages', async () => {
  const d = await tempDirs();
  await fs.writeFile(
    d.configFile,
    JSON.stringify({
      albums: [
        { name: 'Family', url: 'https://photos.app.goo.gl/family123' },
        { name: 'Broken', url: 'https://example.com/not-google' },
      ],
    }),
  );
  let clock = 0;
  let calls = 0;
  let fail = false;
  const fetchImpl = async (url) => {
    calls++;
    assert.equal(url, 'https://photos.app.goo.gl/family123');
    if (fail) throw new Error('offline');
    return new Response(sharePage(7, 8), { status: 200 });
  };
  const photos = createPhotos({ ...d, fetchImpl, now: () => clock, imageMagick: Promise.resolve(null) });

  const res = await photos.list({ source: 'google' });
  assert.deepEqual(res.albums, [{ name: 'Family', source: 'google', count: 2 }]);
  assert.equal(res.photos[0].src, `${lh3(7)}=w1920-h1080`);
  assert.equal(res.photos[0].thumb, `${lh3(7)}=w400-h400-c`);
  assert.equal(res.photos[0].album, 'Family');
  await photos.list();
  assert.equal(calls, 1);

  clock += 31 * 60 * 1000;
  fail = true;
  const stale = await photos.list();
  assert.equal(calls, 2);
  assert.equal(stale.photos.length, 2);
  assert.equal(stale.albums[0].stale, true);
  assert.match(stale.albums[0].error, /unreachable/);
});

test('an album page without photos reports why', async () => {
  const d = await tempDirs();
  await fs.writeFile(d.configFile, JSON.stringify({ albums: [{ name: 'Private', url: 'https://photos.google.com/share/x' }] }));
  const photos = createPhotos({
    ...d,
    fetchImpl: async () => new Response('<html>Sign in</html>', { status: 200 }),
    imageMagick: Promise.resolve(null),
  });
  const res = await photos.list();
  assert.equal(res.albums[0].count, 0);
  assert.match(res.albums[0].error, /shared with a link/);
});

test('real ImageMagick, when installed, shrinks a photo and crops a square thumbnail', async (t) => {
  const magick = await detectImageMagick();
  if (!magick) return t.skip('ImageMagick not installed');
  const d = await tempDirs();
  await fs.mkdir(d.dir, { recursive: true });
  const { execFileSync } = await import('node:child_process');
  execFileSync('convert', ['-size', '4000x3000', 'gradient:red-blue', path.join(d.dir, 'big.jpg')]);
  const photos = createPhotos({ ...d, imageMagick: Promise.resolve(magick) });
  const full = await photos.image('big.jpg', 'full');
  const thumb = await photos.image('big.jpg', 'thumb');
  const dims = (f) => execFileSync('identify', ['-format', '%wx%h', f]).toString();
  assert.equal(dims(full.file), '1440x1080');
  assert.equal(dims(thumb.file), '400x400');
});
