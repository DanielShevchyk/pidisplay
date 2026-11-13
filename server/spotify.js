// Spotify for the music widget: sign-in (OAuth with PKCE, so no client secret),
// now playing, playback control, playlists and search through the Spotify Web API.
// Sound itself comes from librespot ("PiDisplay" in the Spotify app), a Spotify
// Connect receiver run by deploy/pidisplay-spotify.service.
//
// Tokens live in $PIDISPLAY_DATA/spotify.json (mode 600) and never reach the browser.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class SpotifyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The Spotify Connect name librespot advertises; must match deploy/spotify-receiver.sh. */
export const RECEIVER_NAME = 'PiDisplay';

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
];
const CLIENT_ID = /^[0-9a-f]{32}$/i;
const PENDING_MS = 15 * 60 * 1000;
const REPEAT = new Set(['off', 'context', 'track']);
const URI = /^spotify:[a-z]+:[A-Za-z0-9:]+$/;
// Every screen polls /api/spotify/player; these keep that to a trickle of Spotify calls.
const PLAYER_CACHE_MS = 2000;
const DEVICES_CACHE_MS = 8000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function pickImage(images, minWidth) {
  const list = (images ?? []).filter((i) => i?.url);
  if (!list.length) return null;
  // Spotify lists the largest first; take the smallest that is still big enough.
  const sorted = [...list].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find((i) => (i.width ?? 0) >= minWidth) ?? sorted[sorted.length - 1]).url;
}

function mapDevice(d) {
  return {
    id: d.id,
    name: d.name,
    type: String(d.type ?? '').toLowerCase(),
    active: Boolean(d.is_active),
    restricted: Boolean(d.is_restricted),
    volume: typeof d.volume_percent === 'number' ? d.volume_percent : null,
    supportsVolume: d.supports_volume !== false,
  };
}

function mapItem(item) {
  if (!item) return null;
  const episode = item.type === 'episode';
  const images = episode ? item.images ?? item.show?.images : item.album?.images;
  return {
    uri: item.uri,
    type: item.type,
    name: item.name,
    artists: episode ? [item.show?.name].filter(Boolean) : (item.artists ?? []).map((a) => a.name),
    album: episode ? item.show?.name ?? '' : item.album?.name ?? '',
    image: pickImage(images, 600),
    thumb: pickImage(images, 100),
    durationMs: item.duration_ms ?? 0,
  };
}

/** Shapes GET /me/player (null when nothing is active) for the widget. */
export function mapPlayer(p) {
  if (!p || !p.device) return null;
  return {
    isPlaying: Boolean(p.is_playing),
    progressMs: p.progress_ms ?? 0,
    shuffle: Boolean(p.shuffle_state),
    repeat: REPEAT.has(p.repeat_state) ? p.repeat_state : 'off',
    device: mapDevice(p.device),
    item: mapItem(p.item),
    context: p.context ? { uri: p.context.uri, type: p.context.type } : null,
    disallows: Object.keys(p.actions?.disallows ?? {}).filter((k) => p.actions.disallows[k]),
  };
}

function mapPlaylist(p) {
  return {
    uri: p.uri,
    name: p.name,
    owner: p.owner?.display_name ?? '',
    // The February 2026 API renamed the playlist "tracks" summary to "items".
    count: p.items?.total ?? p.tracks?.total ?? null,
    image: pickImage(p.images, 200),
  };
}

export function mapSearch(data) {
  const items = (key) => (data?.[key]?.items ?? []).filter(Boolean);
  return {
    tracks: items('tracks').map((t) => ({ ...mapItem(t), albumUri: t.album?.uri ?? null })),
    playlists: items('playlists').map(mapPlaylist),
    albums: items('albums').map((a) => ({
      uri: a.uri,
      name: a.name,
      artists: (a.artists ?? []).map((x) => x.name),
      image: pickImage(a.images, 200),
    })),
    artists: items('artists').map((a) => ({ uri: a.uri, name: a.name, image: pickImage(a.images, 200) })),
  };
}

/** Explains a Web API error in words someone at the display can act on. */
function apiError(status, body) {
  const reason = body?.error?.reason ?? '';
  const message = body?.error?.message ?? '';
  if (status === 404 || reason === 'NO_ACTIVE_DEVICE') {
    return new SpotifyError(409, 'No speaker is playing Spotify right now. Pick one under Speakers.');
  }
  if (reason === 'PREMIUM_REQUIRED') return new SpotifyError(403, 'Controlling playback needs Spotify Premium.');
  if (status === 403 && /not registered|developer dashboard/i.test(message)) {
    return new SpotifyError(403, 'This Spotify account is not on the app\'s user list. Add it under User Management in the Spotify developer dashboard.');
  }
  if (status === 403) return Object.assign(new SpotifyError(403, 'Spotify didn\'t allow that right now.'), { restricted: true });
  if (status === 429) return new SpotifyError(429, 'Spotify is busy. Try again in a moment.');
  return new SpotifyError(502, message ? `Spotify: ${message}` : `Spotify answered ${status}`);
}

export function createSpotify({
  configFile,
  receiverCacheDir,
  redirectUri = 'http://127.0.0.1:8080/api/spotify/callback',
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  let config = null; // { clientId, refreshToken, accessToken, expiresAt }
  let refreshing = null;
  const pending = new Map(); // OAuth state -> { verifier, returnTo, created }
  // Spotify said "too many requests": no calls until this time.
  let blockedUntil = 0;
  const cache = { player: null, devices: null }; // { at, value } or { promise }

  /** fetch with a timeout; network trouble becomes a SpotifyError instead of a stack trace per poll. */
  async function request(url, init) {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch {
      throw new SpotifyError(503, "Can't reach Spotify. Check the internet connection.");
    }
  }

  function dropCache() {
    cache.player = null;
    cache.devices = null;
  }

  /** One Spotify call per ttl, shared by every caller, including ones that arrive mid-request. */
  function cached(key, ttl, load) {
    const entry = cache[key];
    if (entry?.promise) return entry.promise;
    if (entry && now() - entry.at < ttl) return Promise.resolve(entry.value);
    const promise = load().then(
      (value) => {
        if (cache[key]?.promise === promise) cache[key] = { at: now(), value };
        return value;
      },
      (err) => {
        if (cache[key]?.promise === promise) cache[key] = null;
        throw err;
      },
    );
    cache[key] = { promise };
    return promise;
  }

  async function load() {
    if (config) return config;
    try {
      config = JSON.parse(await fs.readFile(configFile, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Reading spotify.json failed', err);
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

  async function receiverSignedIn() {
    if (!receiverCacheDir) return false;
    return fs.access(path.join(receiverCacheDir, 'credentials.json')).then(() => true, () => false);
  }

  async function status() {
    const c = await load();
    return {
      configured: Boolean(c.clientId),
      connected: Boolean(c.clientId && c.refreshToken),
      redirectUri,
      receiver: { name: RECEIVER_NAME, signedIn: await receiverSignedIn() },
      // Where new music starts when nothing is playing; null = this display.
      preferred: c.preferred?.name ? { id: c.preferred.id ?? null, name: c.preferred.name } : null,
    };
  }

  async function setClientId(clientId) {
    const id = String(clientId ?? '').trim();
    if (!id) {
      dropCache();
      await save({});
      return status();
    }
    if (!CLIENT_ID.test(id)) throw new SpotifyError(400, 'That doesn\'t look like a Spotify Client ID (32 letters and numbers).');
    const c = await load();
    // A different app can't use the old app's tokens.
    if (c.clientId !== id) dropCache();
    await save(c.clientId === id ? c : { clientId: id });
    return status();
  }

  async function logout() {
    const c = await load();
    dropCache();
    await save({ clientId: c.clientId, ...(c.preferred ? { preferred: c.preferred } : {}) });
    return status();
  }

  /** Sets (or with no name, clears) the speaker new music starts on. */
  async function setPreferred(body) {
    const name = String(body?.name ?? '').trim().slice(0, 100);
    const id = typeof body?.deviceId === 'string' && body.deviceId ? body.deviceId.slice(0, 200) : null;
    const { preferred, ...rest } = await load();
    await save(name && name !== RECEIVER_NAME ? { ...rest, preferred: { id, name } } : rest);
    return status();
  }

  async function loginUrl(returnTo) {
    const c = await load();
    if (!c.clientId) throw new SpotifyError(400, 'Add your Spotify Client ID first.');
    for (const [k, v] of pending) if (now() - v.created > PENDING_MS) pending.delete(k);
    const verifier = base64url(crypto.randomBytes(48));
    const state = base64url(crypto.randomBytes(16));
    const safeReturn = typeof returnTo === 'string' && /^\/(?!\/)/.test(returnTo) ? returnTo : null;
    pending.set(state, { verifier, returnTo: safeReturn, created: now() });
    const params = new URLSearchParams({
      client_id: c.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      code_challenge_method: 'S256',
      code_challenge: base64url(crypto.createHash('sha256').update(verifier).digest()),
      scope: SCOPES.join(' '),
      state,
    });
    return `${ACCOUNTS}/authorize?${params}`;
  }

  async function tokenRequest(params) {
    const res = await request(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, body };
  }

  function storeTokens(c, body) {
    return save({
      ...c,
      accessToken: body.access_token,
      // Refresh a minute early so a request never goes out with a dying token.
      expiresAt: now() + (Number(body.expires_in) || 3600) * 1000 - 60_000,
      // PKCE refresh tokens rotate; keep the old one if Spotify didn't send a new one.
      refreshToken: body.refresh_token || c.refreshToken,
    });
  }

  /** Finishes sign-in from the redirect. Returns where to send the browser next. */
  async function callback(params) {
    const state = params.get('state') ?? '';
    const entry = pending.get(state);
    pending.delete(state);
    if (params.get('error')) throw new SpotifyError(400, params.get('error') === 'access_denied' ? 'Spotify sign-in was cancelled.' : `Spotify sign-in failed: ${params.get('error')}`);
    if (!entry) throw new SpotifyError(400, 'This sign-in link expired. Start again from the display or the laptop script.');
    const c = await load();
    const { ok, body } = await tokenRequest({
      grant_type: 'authorization_code',
      code: params.get('code') ?? '',
      redirect_uri: redirectUri,
      client_id: c.clientId,
      code_verifier: entry.verifier,
    });
    if (!ok || !body.access_token) {
      throw new SpotifyError(400, `Spotify sign-in failed: ${body.error_description || body.error || 'no token'}`);
    }
    await storeTokens(c, body);
    return { returnTo: entry.returnTo };
  }

  async function accessToken(force = false) {
    const c = await load();
    if (!c.clientId || !c.refreshToken) throw new SpotifyError(401, 'Spotify is not connected yet.');
    if (!force && c.accessToken && now() < c.expiresAt) return c.accessToken;
    refreshing ??= (async () => {
      try {
        const { ok, body } = await tokenRequest({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: c.clientId });
        if (!ok || !body.access_token) {
          if (body.error === 'invalid_grant' || body.error === 'invalid_client') {
            if (config === c) await save({ clientId: c.clientId, ...(c.preferred ? { preferred: c.preferred } : {}) });
            throw new SpotifyError(401, 'Spotify signed this display out. Log in again.');
          }
          throw new SpotifyError(502, `Spotify sign-in refresh failed: ${body.error_description || body.error || 'unknown error'}`);
        }
        // Logged out (or switched apps) while this was in flight: don't sign back in.
        if (config !== c) throw new SpotifyError(401, 'Spotify is not connected yet.');
        await storeTokens(c, body);
        return body.access_token;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function api(method, pathAndQuery, body) {
    for (let attempt = 0; ; attempt++) {
      if (now() < blockedUntil) throw apiError(429, null);
      const token = await accessToken(attempt > 0);
      const res = await request(`${API}${pathAndQuery}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 429) {
        // Asking again before Retry-After only makes Spotify extend the block.
        const wait = Number(res.headers.get('retry-after')) || 5;
        blockedUntil = now() + Math.min(wait * 1000, MAX_BACKOFF_MS);
      }
      const text = await res.text().catch(() => '');
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok) throw apiError(res.status, data);
      return data;
    }
  }

  const devices = () =>
    cached('devices', DEVICES_CACHE_MS, async () => ((await api('GET', '/me/player/devices'))?.devices ?? []).map(mapDevice));
  const nowPlaying = () =>
    cached('player', PLAYER_CACHE_MS, async () => mapPlayer(await api('GET', '/me/player?additional_types=episode')));

  async function player() {
    const [p, list] = await Promise.all([nowPlaying(), devices()]);
    return { player: p, devices: list };
  }

  /**
   * The device to start music on, as { id, note? }: the one asked for; wherever music
   * is playing now; the preferred speaker (say, the TV) when Spotify can see it; the
   * last active device; or the Pi itself. note says when the preferred one was skipped.
   */
  async function targetDevice(deviceId) {
    if (deviceId) return { id: deviceId };
    // Fresh lists: a TV that was just switched on must not be missed.
    dropCache();
    const [{ preferred }, list, current] = await Promise.all([load(), devices(), nowPlaying().catch(() => null)]);
    if (current?.isPlaying && current.device.id) return { id: current.device.id };
    let note;
    if (preferred?.name) {
      const want = list.find((d) => d.id === preferred.id) ?? list.find((d) => d.name === preferred.name);
      if (want && !want.restricted) return { id: want.id };
      note = `${preferred.name} isn't showing up in Spotify, so this is playing somewhere else. Open the Spotify app on it, then pick it under Speakers.`;
    }
    const active = list.find((d) => d.active);
    if (active) return { id: active.id, note };
    const pi = list.find((d) => d.name === RECEIVER_NAME);
    if (pi) return { id: pi.id, note };
    throw new SpotifyError(
      409,
      (await receiverSignedIn())
        ? `The ${RECEIVER_NAME} speaker isn't showing up in Spotify. It may still be starting; try again in a moment.`
        : `The ${RECEIVER_NAME} speaker hasn't been linked yet. Open Spotify on your phone (same Wi-Fi), tap the speaker icon and pick ${RECEIVER_NAME} once.`,
    );
  }

  const q = (params) => `?${new URLSearchParams(params)}`;

  async function control(action, body = {}) {
    let note;
    try {
      note = await send(action, body);
    } finally {
      // Whatever happened, what the screens last saw is out of date.
      dropCache();
    }
    return note ? { ok: true, note } : { ok: true };
  }

  async function send(action, body) {
    switch (action) {
      case 'play': {
        const target = await targetDevice(body.deviceId);
        const payload = {};
        if (body.contextUri) {
          if (!URI.test(body.contextUri)) throw new SpotifyError(400, 'Bad context');
          payload.context_uri = body.contextUri;
          if (typeof body.offsetUri === 'string' && URI.test(body.offsetUri)) payload.offset = { uri: body.offsetUri };
        } else if (Array.isArray(body.uris)) {
          if (!body.uris.length || !body.uris.every((u) => typeof u === 'string' && URI.test(u))) throw new SpotifyError(400, 'Bad track list');
          payload.uris = body.uris.slice(0, 100);
        }
        const resume = !Object.keys(payload).length;
        try {
          await api('PUT', `/me/player/play${q({ device_id: target.id })}`, resume ? undefined : payload);
        } catch (err) {
          // Spotify refuses a bare "play" when it has no queue to pick up again.
          if (resume && err instanceof SpotifyError && err.restricted) {
            throw new SpotifyError(409, 'Nothing to resume. Pick something from the Library.');
          }
          throw err;
        }
        return target.note;
      }
      case 'pause':
        await api('PUT', '/me/player/pause');
        break;
      case 'next':
        await api('POST', '/me/player/next');
        break;
      case 'previous':
        await api('POST', '/me/player/previous');
        break;
      case 'seek': {
        const ms = Math.max(0, Math.round(Number(body.positionMs)));
        if (!Number.isFinite(ms)) throw new SpotifyError(400, 'Bad position');
        await api('PUT', `/me/player/seek${q({ position_ms: ms })}`);
        break;
      }
      case 'volume': {
        const v = Math.round(Number(body.percent));
        if (!Number.isFinite(v) || v < 0 || v > 100) throw new SpotifyError(400, 'Volume must be 0 to 100');
        await api('PUT', `/me/player/volume${q({ volume_percent: v })}`);
        break;
      }
      case 'shuffle':
        await api('PUT', `/me/player/shuffle${q({ state: Boolean(body.on) })}`);
        break;
      case 'repeat':
        if (!REPEAT.has(body.mode)) throw new SpotifyError(400, 'Repeat must be off, context or track');
        await api('PUT', `/me/player/repeat${q({ state: body.mode })}`);
        break;
      case 'transfer': {
        if (typeof body.deviceId !== 'string' || !body.deviceId) throw new SpotifyError(400, 'Pick a speaker');
        await api('PUT', '/me/player', { device_ids: [body.deviceId], play: body.play !== false });
        break;
      }
      default:
        throw new SpotifyError(404, 'Not found');
    }
    return undefined;
  }

  async function playlists() {
    const data = await api('GET', '/me/playlists?limit=50');
    return (data?.items ?? []).filter(Boolean).map(mapPlaylist);
  }

  async function search(text) {
    const query = String(text ?? '').trim().slice(0, 200);
    if (!query) return mapSearch({});
    // Development-mode apps are capped at 10 results per type.
    return mapSearch(await api('GET', `/search${q({ q: query, type: 'track,playlist,album,artist', limit: 10 })}`));
  }

  /** Routes /api/spotify/... (everything except login and callback, which redirect). */
  async function handle(method, parts, body, params) {
    const [, section, action] = parts; // parts[0] is "spotify"
    if (!section && method === 'GET') return status();
    if (section === 'client' && (method === 'PUT' || method === 'POST')) return setClientId(body?.clientId ?? params.get('clientId'));
    if (section === 'logout' && method === 'POST') return logout();
    if (section === 'preferred' && (method === 'PUT' || method === 'POST')) return setPreferred(body);
    if (section === 'player' && !action && method === 'GET') return player();
    if (section === 'player' && action && method === 'POST') return control(action, body ?? {});
    if (section === 'playlists' && method === 'GET') return playlists();
    if (section === 'search' && method === 'GET') return search(params.get('q'));
    throw new SpotifyError(404, 'Not found');
  }

  return { status, setClientId, setPreferred, logout, loginUrl, callback, player, control, playlists, search, handle };
}
