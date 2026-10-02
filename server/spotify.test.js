import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSpotify, mapPlayer, mapSearch } from './spotify.js';

const CLIENT = '0123456789abcdef0123456789abcdef';

async function setup({ routes = {}, token = {} } = {}) {
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
