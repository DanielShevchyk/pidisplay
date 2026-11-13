import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSpotify, mapPlayer, mapSearch } from './spotify.js';

const CLIENT = '0123456789abcdef0123456789abcdef';

async function setup({ routes = {}, token = {}, wakeTv = null, linkedTv = null, tvVolume = null } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pidisplay-spotify-'));
  const calls = [];
  let t = 1_000_000;
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, ...opts });
    if (url === 'https://accounts.spotify.com/api/token') {
      const params = new URLSearchParams(opts.body);
      const body = token[params.get('grant_type')] ?? { access_token: `tok-${calls.length}`, expires_in: 3600, refresh_token: 'refresh-2' };
      return new Response(JSON.stringify(body), { status: body.error ? 400 : 200 });
    }
    const key = `${opts.method} ${url.replace('https://api.spotify.com/v1', '')}`;
    const route = routes[key] ?? routes[key.split('?')[0]];
    if (!route) return new Response(null, { status: 204 });
    const [status, body] = typeof route === 'function' ? route(opts) : route;
    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  };
  const spotify = createSpotify({
    configFile: path.join(dir, 'spotify.json'),
    receiverCacheDir: path.join(dir, 'spotify-cache'),
    fetchImpl,
    now: () => t,
    wakeTv,
    linkedTv,
    tvVolume,
    wait: async () => {},
  });
  return { dir, spotify, calls, advance: (ms) => (t += ms) };
}

async function connect(spotify) {
  await spotify.setClientId(CLIENT);
  const url = new URL(await spotify.loginUrl('/?kiosk'));
  return spotify.callback(new URLSearchParams({ code: 'abc', state: url.searchParams.get('state') }));
}

test('rejects a malformed client id', async () => {
  const { spotify } = await setup();
  await assert.rejects(spotify.setClientId('nope'), /Client ID/);
  await spotify.setClientId(CLIENT);
  assert.equal((await spotify.setClientId('')).configured, false);
});

test('login uses PKCE and the callback stores tokens privately', async () => {
  const { spotify, calls, dir } = await setup();
  await spotify.setClientId(CLIENT);
  const url = new URL(await spotify.loginUrl('/?kiosk'));
  assert.equal(url.origin, 'https://accounts.spotify.com');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:8080/api/spotify/callback');
  assert.match(url.searchParams.get('scope'), /user-modify-playback-state/);

  const result = await spotify.callback(new URLSearchParams({ code: 'abc', state: url.searchParams.get('state') }));
  assert.equal(result.returnTo, '/?kiosk');
  const sent = new URLSearchParams(calls.at(-1).body);
  assert.equal(sent.get('grant_type'), 'authorization_code');
  assert.ok(sent.get('code_verifier').length >= 43);
  assert.equal(sent.get('client_secret'), null);

  const file = path.join(dir, 'spotify.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.refreshToken, 'refresh-2');
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await spotify.status()).connected, true);

  // A state can only be used once.
  await assert.rejects(spotify.callback(new URLSearchParams({ code: 'abc', state: url.searchParams.get('state') })), /expired/);
});

test('return addresses must stay on this site', async () => {
  const { spotify } = await setup();
  await spotify.setClientId(CLIENT);
  const url = new URL(await spotify.loginUrl('//evil.example'));
  const result = await spotify.callback(new URLSearchParams({ code: 'x', state: url.searchParams.get('state') }));
  assert.equal(result.returnTo, null);
});

test('refreshes an expired token and retries once on 401', async () => {
  let first = true;
  const { spotify, calls, advance } = await setup({
    routes: {
      'GET /me/playlists': () => {
        if (first) {
          first = false;
          return [401, { error: { status: 401, message: 'expired' } }];
        }
        return [200, { items: [{ uri: 'spotify:playlist:1', name: 'Mix', items: { total: 12 }, images: [{ url: 'a', width: 300 }] }] }];
      },
    },
  });
  await connect(spotify);
  const lists = await spotify.playlists();
  assert.deepEqual(lists, [{ uri: 'spotify:playlist:1', name: 'Mix', owner: '', count: 12, image: 'a' }]);
  const refreshes = calls.filter((c) => c.body && String(c.body).includes('grant_type=refresh_token'));
  assert.equal(refreshes.length, 1);
  advance(2 * 3600 * 1000);
  await spotify.playlists();
  assert.equal(calls.filter((c) => c.body && String(c.body).includes('grant_type=refresh_token')).length, 2);
});

test('a revoked refresh token signs the display out', async () => {
  const { spotify, advance } = await setup({ token: { refresh_token: { error: 'invalid_grant' } } });
  await connect(spotify);
  advance(2 * 3600 * 1000);
  await assert.rejects(spotify.playlists(), /Log in again/);
  const s = await spotify.status();
  assert.equal(s.connected, false);
  assert.equal(s.configured, true);
});

test('play starts on the PiDisplay receiver when nothing is active', async () => {
  const { spotify, calls } = await setup({
    routes: {
      'GET /me/player/devices': [200, { devices: [
        { id: 'phone', name: 'Pixel', type: 'Smartphone', is_active: false },
        { id: 'pi', name: 'PiDisplay', type: 'Speaker', is_active: false, volume_percent: 70 },
      ] }],
    },
  });
  await connect(spotify);
  await spotify.control('play', { contextUri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M' });
  const play = calls.at(-1);
  assert.equal(play.method, 'PUT');
  assert.ok(play.url.endsWith('/me/player/play?device_id=pi'));
  assert.deepEqual(JSON.parse(play.body), { context_uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M' });
});

test('explains when the receiver has never been linked', async () => {
  const { spotify } = await setup({ routes: { 'GET /me/player/devices': [200, { devices: [] }] } });
  await connect(spotify);
  await assert.rejects(spotify.control('play', {}), /hasn't been linked/);
});

test('maps Spotify errors to plain messages', async () => {
  const { spotify } = await setup({
    routes: {
      'PUT /me/player/pause': [403, { error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } }],
      'POST /me/player/next': [404, { error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } }],
    },
  });
  await connect(spotify);
  await assert.rejects(spotify.control('pause'), /Premium/);
  await assert.rejects(spotify.control('next'), (err) => err.status === 409);
  await assert.rejects(spotify.control('repeat', { mode: 'loud' }), /Repeat/);
  await assert.rejects(spotify.control('play', { contextUri: 'javascript:alert(1)', deviceId: 'pi' }), /Bad context/);
});

test('mapPlayer and mapSearch shape the payloads', () => {
  assert.equal(mapPlayer(null), null);
  const p = mapPlayer({
    is_playing: true,
    progress_ms: 5000,
    shuffle_state: true,
    repeat_state: 'context',
    device: { id: 'pi', name: 'PiDisplay', type: 'Speaker', is_active: true, volume_percent: 55 },
    item: {
      type: 'track', uri: 'spotify:track:1', name: 'Song', duration_ms: 200000,
      artists: [{ name: 'A' }, { name: 'B' }],
      album: { name: 'LP', images: [{ url: 'big', width: 640 }, { url: 'mid', width: 300 }, { url: 'small', width: 64 }] },
    },
    actions: { disallows: { skipping_prev: true, pausing: false } },
  });
  assert.equal(p.item.image, 'big');
  assert.equal(p.item.thumb, 'mid');
  assert.deepEqual(p.item.artists, ['A', 'B']);
  assert.deepEqual(p.disallows, ['skipping_prev']);
  assert.equal(p.device.volume, 55);

  const s = mapSearch({ tracks: { items: [null] }, playlists: { items: [null, { uri: 'spotify:playlist:2', name: 'P', tracks: { total: 3 } }] } });
  assert.equal(s.tracks.length, 0);
  assert.equal(s.playlists[0].count, 3);
  assert.deepEqual(s.albums, []);
});

const DEVICES = [200, { devices: [
  { id: 'tv', name: 'Living Room TV', type: 'TV', is_active: false },
  { id: 'pi', name: 'PiDisplay', type: 'Speaker', is_active: false },
] }];

test('screens polling together share one Spotify call, and actions refresh it', async () => {
  const { spotify, calls, advance } = await setup({ routes: { 'GET /me/player/devices': DEVICES } });
  await connect(spotify);
  const count = () => calls.filter((c) => c.url.startsWith('https://api.spotify.com')).length;
  await Promise.all([spotify.player(), spotify.player(), spotify.player()]);
  assert.equal(count(), 2); // one now-playing, one device list
  await spotify.player();
  assert.equal(count(), 2);
  advance(2500);
  await spotify.player();
  assert.equal(count(), 3); // now-playing again; devices are kept longer
  await spotify.control('pause');
  await spotify.player();
  assert.equal(count(), 6);
});

test('new music starts on the preferred speaker when Spotify can see it', async () => {
  const { spotify, calls } = await setup({ routes: { 'GET /me/player/devices': DEVICES } });
  await connect(spotify);
  assert.equal((await spotify.setPreferred({ deviceId: 'old-id', name: 'Living Room TV' })).preferred.name, 'Living Room TV');
  const res = await spotify.control('play', { uris: ['spotify:track:abc'] });
  assert.ok(calls.at(-1).url.endsWith('/me/player/play?device_id=tv')); // matched by name after its id changed
  assert.equal(res.note, undefined);
  assert.equal((await spotify.logout()).preferred.name, 'Living Room TV');
  assert.equal((await spotify.setPreferred({})).preferred, null);
});

test('falls back with a note when the preferred speaker is away, and never moves playing music', async () => {
  let playing = false;
  const { spotify, calls } = await setup({
    routes: {
      'GET /me/player/devices': [200, { devices: [{ id: 'pi', name: 'PiDisplay', type: 'Speaker' }, { id: 'phone', name: 'Pixel', type: 'Smartphone' }] }],
      'GET /me/player': () => (playing ? [200, { is_playing: true, device: { id: 'phone', name: 'Pixel' } }] : [204]),
    },
  });
  await connect(spotify);
  await spotify.setPreferred({ deviceId: 'tv', name: 'Living Room TV' });
  const res = await spotify.control('play', { uris: ['spotify:track:abc'] });
  assert.ok(calls.at(-1).url.endsWith('device_id=pi'));
  assert.match(res.note, /Living Room TV isn't showing up/);
  playing = true;
  await spotify.control('play', { uris: ['spotify:track:abc'] });
  assert.ok(calls.at(-1).url.endsWith('device_id=phone'));
});

test('backs off after Spotify rate limits, then recovers', async () => {
  let limited = true;
  const { spotify, calls, advance } = await setup({
    routes: { 'GET /me/playlists': () => (limited ? [429, { error: { status: 429 } }] : [200, { items: [] }]) },
  });
  await connect(spotify);
  await assert.rejects(spotify.playlists(), (err) => err.status === 429);
  const n = calls.length;
  await assert.rejects(spotify.playlists(), (err) => err.status === 429);
  assert.equal(calls.length, n); // no request while backing off
  limited = false;
  advance(6000);
  assert.deepEqual(await spotify.playlists(), []);
});

test('resume with nothing queued and network trouble get plain messages', async () => {
  let offline = false;
  const { dir, spotify } = await setup({
    routes: {
      'GET /me/player/devices': DEVICES,
      'PUT /me/player/play': [403, { error: { status: 403, message: 'Player command failed: Restriction violated', reason: 'UNKNOWN' } }],
    },
  });
  await connect(spotify);
  await assert.rejects(spotify.control('play', {}), /Nothing to resume/);
  await assert.rejects(spotify.control('play', { uris: ['spotify:track:abc'] }), /didn't allow/);
  const down = createSpotify({
    configFile: path.join(dir, 'spotify.json'),
    fetchImpl: async () => {
      if (offline) throw new TypeError('fetch failed');
      return new Response('{}', { status: 200 });
    },
  });
  offline = true;
  await assert.rejects(down.playlists(), (err) => err.status === 503 && /Can't reach Spotify/.test(err.message));
});

test('opens Spotify on a linked TV that is off, then plays there', async () => {
  let tvOn = false;
  let woke = 0;
  const { spotify, calls } = await setup({
    routes: {
      'GET /me/player/devices': () => [200, { devices: [{ id: 'pi', name: 'PiDisplay', type: 'Speaker' }, ...(tvOn ? [{ id: 'tv2', name: 'Living Room TV', type: 'TV' }] : [])] }],
    },
    wakeTv: async () => {
      woke++;
      tvOn = true;
      return { ok: true };
    },
  });
  await connect(spotify);
  await spotify.setPreferred({ deviceId: 'tv', name: 'Living Room TV', type: 'TV' });
  const res = await spotify.control('play', { contextUri: 'spotify:playlist:abc' });
  assert.equal(woke, 1);
  assert.ok(calls.at(-1).url.endsWith('device_id=tv2'));
  assert.equal(res.note, undefined);
  // Already visible: no second wake.
  await spotify.control('play', { contextUri: 'spotify:playlist:abc' });
  assert.equal(woke, 1);
});

test('a TV that cannot be woken falls back with the reason; other speakers are never woken', async () => {
  let woke = 0;
  const { spotify, calls } = await setup({
    routes: { 'GET /me/player/devices': [200, { devices: [{ id: 'pi', name: 'PiDisplay', type: 'Speaker' }] }] },
    wakeTv: async () => {
      woke++;
      throw new Error("Living Room TV didn't switch on.");
    },
  });
  await connect(spotify);
  await spotify.setPreferred({ deviceId: 'tv', name: 'Living Room TV', type: 'tv' });
  const res = await spotify.control('play', { uris: ['spotify:track:abc'] });
  assert.ok(calls.at(-1).url.endsWith('device_id=pi'));
  assert.match(res.note, /didn't switch on\. Playing somewhere else/);
  await spotify.setPreferred({ deviceId: 'echo', name: 'Kitchen Echo', type: 'speaker' });
  await spotify.control('play', { uris: ['spotify:track:abc'] });
  assert.equal(woke, 1);
});

test('liked and recent songs, and playing a list from one song', async () => {
  const track = (n) => ({ type: 'track', uri: `spotify:track:${n}`, name: `Song ${n}`, duration_ms: 1000, artists: [{ name: 'A' }], album: { uri: `spotify:album:${n}`, name: 'LP', images: [] } });
  const { spotify, calls } = await setup({
    routes: {
      'GET /me/tracks?limit=50': [200, { total: 51, next: 'more', items: [{ track: track(1) }, { track: null }, { track: track(2) }] }],
      'GET /me/tracks?limit=50&offset=50': [200, { items: [{ track: track(3) }] }],
      'GET /me/player/recently-played': [200, { items: [{ track: track(2) }, { track: track(1) }, { track: track(2) }] }],
      'GET /me/player/devices': [200, { devices: [{ id: 'pi', name: 'PiDisplay', type: 'Speaker' }] }],
    },
  });
  await connect(spotify);
  const liked = await spotify.liked();
  assert.equal(liked.total, 51);
  assert.deepEqual(liked.tracks.map((t) => t.uri), ['spotify:track:1', 'spotify:track:2', 'spotify:track:3']);
  assert.equal(liked.tracks[0].albumUri, 'spotify:album:1');
  assert.deepEqual((await spotify.recent()).tracks.map((t) => t.name), ['Song 2', 'Song 1']);
  await spotify.control('play', { uris: liked.tracks.map((t) => t.uri), offsetUri: 'spotify:track:2' });
  assert.deepEqual(JSON.parse(calls.at(-1).body), { uris: ['spotify:track:1', 'spotify:track:2', 'spotify:track:3'], offset: { uri: 'spotify:track:2' } });
});

test('recently played before signing in again explains the missing permission', async () => {
  const { spotify } = await setup({
    routes: { 'GET /me/player/recently-played': [403, { error: { status: 403, message: 'Insufficient client scope' } }] },
  });
  await connect(spotify);
  await assert.rejects(spotify.recent(), /log out and log in again/);
});

test('with no default picked, a linked TV is the default: Play wakes it, carries the paused song over and remembers it', async () => {
  let tvOn = false;
  let woke = 0;
  const { spotify, calls } = await setup({
    routes: {
      'GET /me/player/devices': () => [200, { devices: [{ id: 'pi', name: 'PiDisplay', type: 'Speaker', is_active: true }, ...(tvOn ? [{ id: 'tv9', name: '[LG] webOS TV UA7700AUA', type: 'TV' }] : [])] }],
      'GET /me/player': [200, { is_playing: false, progress_ms: 5, device: { id: 'pi', name: 'PiDisplay', type: 'Speaker', is_active: true }, item: null }],
    },
    wakeTv: async () => {
      woke++;
      tvOn = true;
      return { ok: true };
    },
    linkedTv: async () => ({ name: 'Living Room TV' }),
  });
  await connect(spotify);
  assert.deepEqual((await spotify.status()).tv, { name: 'Living Room TV' });
  const res = await spotify.control('play', {});
  assert.equal(woke, 1);
  assert.equal(res.note, undefined);
  const last = calls.at(-1);
  assert.equal(`${last.method} ${last.url}`, 'PUT https://api.spotify.com/v1/me/player');
  assert.deepEqual(JSON.parse(last.body), { device_ids: ['tv9'], play: true });
  assert.deepEqual((await spotify.status()).preferred, { id: 'tv9', name: '[LG] webOS TV UA7700AUA', type: 'tv' });
});

test('Play with nothing to pick up again starts Liked Songs on the TV', async () => {
  const { spotify, calls } = await setup({
    routes: {
      'GET /me/player/devices': [200, { devices: [{ id: 'tv9', name: 'TV', type: 'TV' }] }],
      'PUT /me/player/play': (opts) => (opts.body ? [200] : [404, { error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } }]),
      'GET /me/tracks?limit=50': [200, { items: [{ track: { uri: 'spotify:track:1' } }, { track: { uri: 'spotify:track:2' } }] }],
    },
  });
  await connect(spotify);
  await spotify.setPreferred({ deviceId: 'tv9', name: 'TV', type: 'tv' });
  const res = await spotify.control('play', {});
  assert.match(res.note, /Liked Songs/);
  assert.ok(calls.at(-1).url.endsWith('device_id=tv9'));
  assert.deepEqual(JSON.parse(calls.at(-1).body), { uris: ['spotify:track:1', 'spotify:track:2'] });
});

test('picking this display is remembered while a TV is linked', async () => {
  const { spotify } = await setup({ linkedTv: async () => ({ name: 'Living Room TV' }) });
  await connect(spotify);
  assert.equal((await spotify.status()).preferred, null);
  assert.deepEqual((await spotify.setPreferred({})).preferred, { id: null, name: 'PiDisplay', type: 'display' });
});

test('the volume slider turns the TV itself up when music plays on the TV', async () => {
  let tvLevel = 30;
  const onTv = { is_playing: true, progress_ms: 5, device: { id: 'tv9', name: 'TV', type: 'TV', is_active: true, volume_percent: null, supports_volume: false }, item: null };
  const { spotify, calls } = await setup({
    routes: { 'GET /me/player': [200, onTv] },
    tvVolume: { get: async () => tvLevel, set: async (v) => ({ volume: (tvLevel = v) }) },
  });
  await connect(spotify);
  const { player } = await spotify.player();
  assert.equal(player.device.volume, 30);
  assert.equal(player.device.supportsVolume, true);
  await spotify.control('volume', { percent: 45 });
  assert.equal(tvLevel, 45);
  assert.ok(!calls.some((c) => c.url.includes('/me/player/volume')));
  assert.equal((await spotify.player()).player.device.volume, 45);
});

test('music on a TV with a soundbar gets volume buttons, not a slider', async () => {
  const steps = [];
  const onTv = { is_playing: true, progress_ms: 5, device: { id: 'tv9', name: 'TV', type: 'TV', is_active: true, volume_percent: null, supports_volume: false }, item: null };
  const { spotify } = await setup({
    routes: { 'GET /me/player': [200, onTv] },
    tvVolume: { get: async () => ({ volume: 12, output: 'external_arc' }), set: async () => assert.fail('no levels on a soundbar'), step: async (d) => void steps.push(d) },
  });
  await connect(spotify);
  const { device } = (await spotify.player()).player;
  assert.equal(device.volumeSteps, true);
  assert.equal(device.supportsVolume, false);
  await spotify.control('volume', { step: 1 });
  await spotify.control('volume', { step: -1 });
  assert.deepEqual(steps, [1, -1]);
});

test('mute: the TV mutes itself; other speakers go to 0 and back', async () => {
  const tvMutes = [];
  let device = { id: 'tv9', name: 'TV', type: 'TV', is_active: true, volume_percent: null, supports_volume: false };
  const { spotify, calls, advance } = await setup({
    routes: { 'GET /me/player': () => [200, { is_playing: true, progress_ms: 5, device, item: null }] },
    tvVolume: { get: async () => ({ volume: 12, output: 'external_arc', muted: false }), step: async () => {}, mute: async (on) => void tvMutes.push(on) },
  });
  await connect(spotify);
  assert.equal((await spotify.player()).player.device.canMute, true);
  await spotify.control('mute', { on: true });
  assert.deepEqual(tvMutes, [true]);
  assert.equal((await spotify.player()).player.device.muted, true);

  device = { id: 'pi', name: 'PiDisplay', type: 'Speaker', is_active: true, volume_percent: 70, supports_volume: true };
  advance(5000);
  await spotify.control('mute', { on: true });
  assert.ok(calls.at(-1).url.includes('volume_percent=0'));
  device = { ...device, volume_percent: 0 };
  advance(5000);
  assert.equal((await spotify.player()).player.device.muted, true);
  await spotify.control('mute', { on: false });
  assert.ok(calls.at(-1).url.includes('volume_percent=70'));
});
