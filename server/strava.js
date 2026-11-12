// Strava for the activity widget: sign-in (OAuth, Strava needs the app's client secret),
// a full copy of the athlete's activity list kept on disk, and per-activity details
// (splits, best efforts, elevation and heart-rate streams) fetched only when tapped.
//
// Strava's limits for Dan's app: 100 reads / 15 min and 1,000 reads / day (200 / 2,000
// overall). The background sync keeps itself under half of each, so taps on activities
// always have room. Normal use is one request every 15 minutes.
//
// Files in $PIDISPLAY_DATA:
//   strava.json          client ID + secret + tokens (mode 600, never sent to the browser)
//   strava-data.json     athlete profile and every activity summary
//   strava-details.json  details and streams of the activities opened on the screen
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class StravaError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const OAUTH = 'https://www.strava.com/oauth';
const API = 'https://www.strava.com/api/v3';
const SCOPE = 'read,activity:read_all';
const PENDING_MS = 15 * 60 * 1000;
const POLL_MS = 15 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;
const SYNC_COOLDOWN_MS = 60 * 1000;
const RECENT_WINDOW_S = 7 * 86400;
const DEEP_WINDOW_S = 45 * 86400;
const ATHLETE_EVERY_MS = 24 * 3600 * 1000;
const PAGE = 200;
/** Pages of old activities fetched per sync while the first download is still going. */
const BACKFILL_PAGES_PER_RUN = 8;
const MAX_DETAILS = 150;
const STREAM_POINTS = 400;
/** How many of the newest activities carry their route line in GET /api/strava. */
const ROUTES_IN_SNAPSHOT = 40;

/** Strava's published read limits for this app; the response headers override them. */
const DEFAULT_LIMITS = { short: 100, daily: 1000 };
/** Share of each limit the background sync may use. Taps may go to USER_SHARE. */
const BACKGROUND_SHARE = 0.5;
const USER_SHARE = 0.85;

const CLIENT_ID = /^\d{1,10}$/;
const CLIENT_SECRET = /^[0-9a-f]{40}$/i;

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const round = (n, d = 0) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

/** Strava counts in 15-minute windows on the quarter hour and in UTC days. */
const windowOf = (ms) => Math.floor(ms / (15 * 60 * 1000));
const dayOf = (ms) => Math.floor(ms / 86400000);

/** Shapes a SummaryActivity for the cache: short keys, only what the widget shows. */
export function compactActivity(a) {
  return {
    id: a.id,
    name: String(a.name ?? '').slice(0, 200),
    sport: a.sport_type || a.type || 'Workout',
    start: a.start_date,
    // Wall-clock time where the activity happened; Strava marks it with a fake Z.
    local: String(a.start_date_local ?? a.start_date ?? '').replace(/Z$/, ''),
    dist: round(a.distance, 1) ?? 0,
    move: a.moving_time ?? 0,
    elapsed: a.elapsed_time ?? 0,
    elev: round(a.total_elevation_gain, 1) ?? 0,
    speed: round(a.average_speed, 3),
    maxSpeed: round(a.max_speed, 3),
    hr: a.has_heartrate ? round(a.average_heartrate) : null,
    maxHr: a.has_heartrate ? round(a.max_heartrate) : null,
    watts: round(a.weighted_average_watts ?? a.average_watts),
    kj: round(a.kilojoules),
    effort: round(a.suffer_score),
    kudos: a.kudos_count ?? 0,
    achievements: a.achievement_count ?? 0,
    prs: a.pr_count ?? 0,
    photos: a.total_photo_count ?? a.photo_count ?? 0,
    trainer: Boolean(a.trainer),
    commute: Boolean(a.commute),
    private: Boolean(a.private) || a.visibility === 'only_me',
    workout: a.workout_type ?? null,
    poly: a.map?.summary_polyline || null,
  };
}

function compactAthlete(a) {
  if (!a) return null;
  return {
    id: a.id,
    name: [a.firstname, a.lastname].filter(Boolean).join(' '),
    firstname: a.firstname ?? '',
    city: [a.city, a.state].filter(Boolean).join(', '),
    photo: a.profile_medium || a.profile || null,
    units: a.measurement_preference === 'meters' ? 'metric' : 'imperial',
    weight: round(a.weight, 1),
    ftp: a.ftp ?? null,
  };
}

/** Evenly thins a stream to at most n points, always keeping the last one. */
export function thin(arr, n = STREAM_POINTS) {
  if (!Array.isArray(arr) || arr.length <= n) return arr ?? null;
  const out = [];
  const step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

function compactDetail(d) {
  const split = (s) => ({
    dist: round(s.distance, 1),
    move: s.moving_time,
    elev: round(s.elevation_difference, 1),
    speed: round(s.average_speed, 3),
    hr: round(s.average_heartrate),
  });
  return {
    description: d.description ? String(d.description).slice(0, 2000) : '',
    calories: round(d.calories),
    device: d.device_name ?? null,
    gear: d.gear?.name ?? null,
    poly: d.map?.polyline || d.map?.summary_polyline || null,
    photo: d.photos?.primary?.urls?.['600'] ?? d.photos?.primary?.urls?.['100'] ?? null,
    splitsMetric: (d.splits_metric ?? []).map(split),
    splitsStandard: (d.splits_standard ?? []).map(split),
    laps: (d.laps ?? []).length > 1 ? d.laps.slice(0, 60).map((l) => ({ name: l.name, ...split(l), dist: round(l.distance, 1), move: l.moving_time })) : [],
    bestEfforts: (d.best_efforts ?? []).map((b) => ({ name: b.name, time: b.moving_time, dist: round(b.distance, 1), pr: b.pr_rank ?? null })),
    segments: (d.segment_efforts ?? [])
      .filter((s) => s.pr_rank || s.kom_rank || (s.achievements ?? []).length)
      .slice(0, 20)
      .map((s) => ({ name: s.name, time: s.elapsed_time, dist: round(s.distance, 1), pr: s.pr_rank ?? null, kom: s.kom_rank ?? null })),
  };
}

function compactStreams(s) {
  if (!s || typeof s !== 'object') return null;
  const pick = (k, d = 1) => {
    const data = s[k]?.data;
    if (!Array.isArray(data)) return null;
    return thin(data).map((v) => round(v, d));
  };
  return {
    distance: pick('distance', 0),
    time: pick('time', 0),
    altitude: pick('altitude', 1),
    heartrate: pick('heartrate', 0),
    speed: pick('velocity_smooth', 2),
    watts: pick('watts', 0),
    cadence: pick('cadence', 0),
  };
}

/** Explains a failed API answer in words someone at the display can act on. */
function apiError(status, body) {
  const fields = (body?.errors ?? []).map((e) => `${e.field ?? ''}:${e.code ?? ''}`).join(' ');
  if (status === 401 && /activity:read_permission|missing/i.test(fields)) {
    return new StravaError(403, 'This sign-in can\'t read activities. Connect Strava again and leave "View data about your activities" ticked.');
  }
  if (status === 401) return new StravaError(401, 'Strava signed this display out. Connect Strava again.');
  if (status === 404) return new StravaError(404, 'Strava doesn\'t have that activity any more.');
  if (status === 429) return new StravaError(429, 'Strava\'s request limit is used up for now; the display waits and tries again.');
  return new StravaError(502, body?.message ? `Strava: ${body.message}` : `Strava answered ${status}`);
}

export function createStrava({
  configFile,
  dataFile,
  detailsFile,
  redirectUri = 'http://127.0.0.1:8080/api/strava/callback',
  fetchImpl = globalThis.fetch,
  now = Date.now,
  broadcast = () => {},
  notify = () => {},
  autoStart = true,
  pollMs = POLL_MS,
} = {}) {
  let config = null; // { clientId, clientSecret, accessToken, refreshToken, expiresAt, scope, athleteId }
  let data = null; // { athlete, activities: [...], backfilled, lastSync, lastAthlete, lastDeep }
  let details = null; // { [id]: { at, detail, streams } }
  let refreshing = null;
  let syncing = null;
  let timer = null;
  let lastManual = 0;
  let lastError = null;
  const pending = new Map(); // OAuth state -> { returnTo, created }

  // ---- Rate limits ----
  const limits = { ...DEFAULT_LIMITS };
  const usage = { window: -1, short: 0, day: -1, daily: 0 };
  let blockedUntil = 0;

  function rollUsage() {
    const t = now();
    if (usage.window !== windowOf(t)) Object.assign(usage, { window: windowOf(t), short: 0 });
    if (usage.day !== dayOf(t)) Object.assign(usage, { day: dayOf(t), daily: 0 });
  }

  /** May a request go out now? kind 'background' keeps to half the limits. */
  function canSpend(kind) {
    rollUsage();
    if (now() < blockedUntil) return false;
    const share = kind === 'background' ? BACKGROUND_SHARE : USER_SHARE;
    return usage.short < Math.floor(limits.short * share) && usage.daily < Math.floor(limits.daily * share);
  }

  function readHeaders(res) {
    rollUsage();
    usage.short++;
    usage.daily++;
    // Prefer the read limits (activity GETs count against them); fall back to overall.
    const get = (name) => res.headers?.get?.(name) ?? null;
    const limit = get('x-readratelimit-limit') ?? get('x-ratelimit-limit');
    const used = get('x-readratelimit-usage') ?? get('x-ratelimit-usage');
    const parse = (v) => String(v).split(',').map((x) => Number(x.trim()));
    if (limit) {
      const [s, d] = parse(limit);
      if (s > 0) limits.short = s;
      if (d > 0) limits.daily = d;
    }
    if (used) {
      // Strava's own count also includes anything else using this app.
      const [s, d] = parse(used);
      if (Number.isFinite(s)) usage.short = Math.max(usage.short, s);
      if (Number.isFinite(d)) usage.daily = Math.max(usage.daily, d);
    }
  }

  function blockAfter429() {
    const t = now();
    rollUsage();
    const dailyOut = usage.daily >= limits.daily * 0.98;
    // Daily limit resets at midnight UTC, the 15-minute one on the next quarter hour.
    blockedUntil = dailyOut ? (dayOf(t) + 1) * 86400000 + 60_000 : (windowOf(t) + 1) * 15 * 60 * 1000 + 30_000;
  }

  // ---- Files ----
  async function readJson(file, fallback) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`Reading ${path.basename(file)} failed`, err);
      return fallback;
    }
  }

  async function writeJson(file, value, mode = 0o644) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value), { mode });
    await fs.rename(tmp, file);
  }

  async function loadConfig() {
    config ??= (await readJson(configFile, {})) ?? {};
    return config;
  }
  async function saveConfig(next) {
    config = next;
    await writeJson(configFile, next, 0o600);
  }
  async function loadData() {
    data ??= (await readJson(dataFile, null)) ?? { athlete: null, activities: [], backfilled: false };
    if (!Array.isArray(data.activities)) data.activities = [];
    return data;
  }
  const saveData = () => writeJson(dataFile, data);
  async function loadDetails() {
    details ??= (await readJson(detailsFile, {})) ?? {};
    return details;
  }

  // ---- Sign-in ----
  const connected = (c) => Boolean(c.clientId && c.clientSecret && c.refreshToken);
  const scopeOk = (scope) => /activity:read/.test(String(scope ?? ''));

  async function setClient(body) {
    const id = String(body?.clientId ?? '').trim();
    const secret = String(body?.clientSecret ?? '').trim();
    if (!CLIENT_ID.test(id)) throw new StravaError(400, 'The Client ID is the number shown on strava.com/settings/api.');
    if (!CLIENT_SECRET.test(secret)) throw new StravaError(400, 'The Client Secret is 40 letters and numbers, shown on strava.com/settings/api.');
    const c = await loadConfig();
    // Another app can't use the old app's tokens.
    await saveConfig(c.clientId === id ? { ...c, clientSecret: secret } : { clientId: id, clientSecret: secret });
    return status();
  }

  async function loginUrl(returnTo) {
    const c = await loadConfig();
    if (!c.clientId || !c.clientSecret) throw new StravaError(400, 'Save the Strava app\'s Client ID and secret first (deploy/strava.ps1).');
    for (const [k, v] of pending) if (now() - v.created > PENDING_MS) pending.delete(k);
    const state = base64url(crypto.randomBytes(16));
    const safeReturn = typeof returnTo === 'string' && /^\/(?!\/)/.test(returnTo) ? returnTo : null;
    pending.set(state, { returnTo: safeReturn, created: now() });
    const params = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      approval_prompt: 'auto',
      scope: SCOPE,
      state,
    });
    return `${OAUTH}/authorize?${params}`;
  }

  async function tokenRequest(params) {
    const res = await fetchImpl(`${OAUTH}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }

  function withTokens(c, body) {
    return {
      ...c,
      accessToken: body.access_token,
      // Strava gives an absolute expiry; refresh five minutes early.
      expiresAt: (Number(body.expires_at) ? Number(body.expires_at) * 1000 : now() + (Number(body.expires_in) || 21600) * 1000) - 300_000,
      // Refresh tokens can rotate; keep the old one only if no new one came.
      refreshToken: body.refresh_token || c.refreshToken,
    };
  }

  async function callback(params) {
    const state = params.get('state') ?? '';
    const entry = pending.get(state);
    pending.delete(state);
    if (params.get('error')) {
      throw new StravaError(400, params.get('error') === 'access_denied' ? 'Strava sign-in was cancelled.' : `Strava sign-in failed: ${params.get('error')}`);
    }
    if (!entry) throw new StravaError(400, 'This sign-in link expired. Start again from the display or the laptop script.');
    const granted = params.get('scope') ?? '';
    if (!scopeOk(granted)) {
      throw new StravaError(400, 'Strava was connected without permission to read activities. Try again and leave "View data about your activities" ticked.');
    }
    const c = await loadConfig();
    const { ok, body } = await tokenRequest({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      code: params.get('code') ?? '',
      grant_type: 'authorization_code',
    });
    if (!ok || !body.access_token) {
      throw new StravaError(400, `Strava sign-in failed: ${body.message || body.error || 'no token'}`);
    }
    const prevAthlete = c.athleteId;
    await saveConfig({ ...withTokens(c, body), scope: granted, athleteId: body.athlete?.id ?? null });
    const d = await loadData();
    // A different Strava account starts from scratch.
    if (prevAthlete && body.athlete?.id && prevAthlete !== body.athlete.id) {
      data = { athlete: null, activities: [], backfilled: false };
      details = {};
      await Promise.all([saveData(), writeJson(detailsFile, details)]);
    }
    if (body.athlete) {
      data.athlete = compactAthlete(body.athlete) ?? d.athlete;
      await saveData();
    }
    lastError = null;
    blockedUntil = 0;
    queueSync();
    return { returnTo: entry.returnTo };
  }

  async function logout() {
    const c = await loadConfig();
    if (c.accessToken) {
      // Best effort: also revoke it at Strava so the app disappears from the athlete's list.
      fetchImpl(`${OAUTH}/deauthorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ access_token: c.accessToken }).toString(),
      }).catch(() => {});
    }
    await saveConfig({ clientId: c.clientId, clientSecret: c.clientSecret });
    return status();
  }

  async function accessToken(force = false) {
    const c = await loadConfig();
    if (!connected(c)) throw new StravaError(401, 'Strava is not connected yet.');
    if (!force && c.accessToken && now() < (c.expiresAt ?? 0)) return c.accessToken;
    refreshing ??= (async () => {
      try {
        const { ok, status: code, body } = await tokenRequest({
          client_id: c.clientId,
          client_secret: c.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: c.refreshToken,
        });
        if (!ok || !body.access_token) {
          if (code === 400 || code === 401) {
            await saveConfig({ clientId: c.clientId, clientSecret: c.clientSecret });
            throw new StravaError(401, 'Strava signed this display out. Connect Strava again.');
          }
          throw new StravaError(502, `Strava token refresh failed: ${body.message || code}`);
        }
        await saveConfig(withTokens(await loadConfig(), body));
        return body.access_token;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function api(pathAndQuery, kind = 'background') {
    for (let attempt = 0; ; attempt++) {
      if (!canSpend(kind)) {
        throw new StravaError(429, now() < blockedUntil ? 'Strava\'s request limit is used up for now; the display waits and tries again.' : 'Saving Strava requests for now; try again in a few minutes.');
      }
      const token = await accessToken(attempt > 0);
      const res = await fetchImpl(`${API}${pathAndQuery}`, { headers: { Authorization: `Bearer ${token}` } });
      readHeaders(res);
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (res.status === 401 && attempt === 0 && !/permission/.test(text)) continue;
      if (res.status === 429) blockAfter429();
      if (!res.ok) {
        const err = apiError(res.status, body);
        if (err.status === 401) {
          const c = await loadConfig();
          await saveConfig({ clientId: c.clientId, clientSecret: c.clientSecret });
        }
        throw err;
      }
      return body;
    }
  }

  // ---- Sync ----
  const epoch = (iso) => Math.floor(Date.parse(iso) / 1000);
  const sortActivities = () => data.activities.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));

  /** Replaces every cached activity that started after `after` with what Strava lists now. */
  async function syncWindow(after) {
    const fresh = [];
    for (let page = 1; page <= 5; page++) {
      const list = await api(`/athlete/activities?after=${after}&per_page=${PAGE}&page=${page}`);
      if (!Array.isArray(list)) break;
      fresh.push(...list.map(compactActivity));
      if (list.length < PAGE) break;
    }
    const before = JSON.stringify(data.activities.filter((a) => epoch(a.start) > after));
    data.activities = [...data.activities.filter((a) => epoch(a.start) <= after), ...fresh];
    sortActivities();
    const changed = before !== JSON.stringify(data.activities.filter((a) => epoch(a.start) > after));
    // Edited activities: their cached details may be out of date too.
    if (changed && details) for (const a of fresh) if (details[a.id]) details[a.id].stale = true;
    return { changed, fresh };
  }

  /** Downloads older activities a page at a time until the whole history is cached. */
  async function backfill() {
    let changed = false;
    for (let i = 0; i < BACKFILL_PAGES_PER_RUN && !data.backfilled; i++) {
      if (!canSpend('background')) break;
      const oldest = data.activities.length ? epoch(data.activities[data.activities.length - 1].start) : Math.floor(now() / 1000) + 86400;
      const list = await api(`/athlete/activities?before=${oldest}&per_page=${PAGE}&page=1`);
      if (!Array.isArray(list) || list.length === 0) {
        data.backfilled = true;
        changed = true;
        break;
      }
      const known = new Set(data.activities.map((a) => a.id));
      data.activities.push(...list.map(compactActivity).filter((a) => !known.has(a.id)));
      sortActivities();
      changed = true;
      if (list.length < PAGE) data.backfilled = true;
    }
    return changed;
  }

  async function runSync() {
    const c = await loadConfig();
    if (!connected(c)) return;
    await loadData();
    const t = now();
    let changed = false;
    let newOnes = [];
    try {
      if (!data.athlete || !data.lastAthlete || t - data.lastAthlete > ATHLETE_EVERY_MS) {
        data.athlete = compactAthlete(await api('/athlete')) ?? data.athlete;
        data.lastAthlete = t;
        changed = true;
      }
      const known = new Set(data.activities.map((a) => a.id));
      const firstRun = data.activities.length === 0;
      // Once a day look further back, for activities uploaded late from a watch.
      const deep = !data.lastDeep || t - data.lastDeep > ATHLETE_EVERY_MS;
      const win = await syncWindow(Math.floor(t / 1000) - (deep ? DEEP_WINDOW_S : RECENT_WINDOW_S));
      if (deep) data.lastDeep = t;
      changed ||= win.changed;
      if (!firstRun) newOnes = win.fresh.filter((a) => !known.has(a.id));
      if (!data.backfilled) changed = (await backfill()) || changed;
      data.lastSync = t;
      lastError = null;
    } catch (err) {
      lastError = err instanceof StravaError ? err.message : `Strava sync failed: ${err.message}`;
      if (!(err instanceof StravaError)) console.error('Strava sync failed', err);
    }
    await saveData();
    if (details) await writeJson(detailsFile, details).catch(() => {});
    for (const a of newOnes.slice(0, 3)) {
      notify({ title: `New ${sportLabel(a.sport).toLowerCase()}: ${a.name}`, body: summaryLine(a, data.athlete?.units), level: 'success' });
    }
    broadcast({ updated: data.lastSync, changed, error: lastError });
  }

  function queueSync() {
    syncing ??= runSync().finally(() => {
      syncing = null;
    });
    return syncing;
  }

  function schedule() {
    clearTimeout(timer);
    // Keep downloading history every couple of minutes until it's all here.
    const backlog = data && !data.backfilled && config && connected(config);
    const wait = Math.max(blockedUntil - now(), lastError || backlog ? RETRY_MS : pollMs);
    timer = setTimeout(async () => {
      await queueSync().catch(() => {});
      schedule();
    }, wait);
    timer.unref?.();
  }

  async function start() {
    await Promise.all([loadConfig(), loadData()]);
    await queueSync().catch(() => {});
    schedule();
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  async function syncNow() {
    if (now() - lastManual < SYNC_COOLDOWN_MS) return snapshot();
    lastManual = now();
    await queueSync();
    if (autoStart) schedule();
    return snapshot();
  }

  // ---- Details ----
  async function activity(idRaw) {
    const id = Number(idRaw);
    if (!Number.isSafeInteger(id) || id <= 0) throw new StravaError(400, 'Bad activity id');
    await Promise.all([loadData(), loadDetails()]);
    const summary = data.activities.find((a) => a.id === id) ?? null;
    if (!summary) throw new StravaError(404, 'That activity isn\'t in the Strava list.');
    const cached = details[id];
    // Today's activities are often still being renamed or described: re-check after an hour.
    const young = now() - Date.parse(summary.start) < 2 * 86400000;
    const fresh = cached && !cached.stale && !(young && now() - cached.at > 3600_000);
    if (fresh) return { summary, ...cached };
    try {
      const d = await api(`/activities/${id}?include_all_efforts=false`, 'user');
      let streams = cached?.streams ?? null;
      if (!summary.trainer || summary.dist > 0) {
        streams = compactStreams(
          await api(`/activities/${id}/streams?keys=distance,time,altitude,heartrate,velocity_smooth,watts,cadence&key_by_type=true`, 'user').catch((err) => {
            if (err.status === 404) return null;
            throw err;
          }),
        );
      }
      details[id] = { at: now(), detail: compactDetail(d), streams };
      // Keep the file small: drop the oldest opened.
      const ids = Object.keys(details);
      if (ids.length > MAX_DETAILS) {
        ids.sort((a, b) => details[a].at - details[b].at);
        for (const k of ids.slice(0, ids.length - MAX_DETAILS)) delete details[k];
      }
      await writeJson(detailsFile, details);
      return { summary, ...details[id] };
    } catch (err) {
      if (cached) return { summary, ...cached, note: err.message };
      if (err instanceof StravaError && err.status === 429) return { summary, detail: null, streams: null, note: err.message };
      throw err;
    }
  }

  // ---- Snapshot ----
  async function status() {
    const c = await loadConfig();
    rollUsage();
    return {
      configured: Boolean(c.clientId && c.clientSecret),
      connected: connected(c),
      scopeOk: connected(c) ? scopeOk(c.scope) : null,
      redirectUri,
      error: lastError,
      syncing: Boolean(syncing),
      usage: { short: usage.short, daily: usage.daily, limits: { ...limits }, waitUntil: now() < blockedUntil ? blockedUntil : null },
    };
  }

  async function snapshot() {
    await loadData();
    return {
      ...(await status()),
      athlete: data.athlete,
      lastSync: data.lastSync ?? null,
      backfilled: Boolean(data.backfilled),
      count: data.activities.length,
      activities: data.activities.map((a, i) => (i < ROUTES_IN_SNAPSHOT ? a : { ...a, poly: undefined, hasRoute: Boolean(a.poly) })),
    };
  }

  /** Every route line, for the personal heatmap. */
  async function routes() {
    await loadData();
    return data.activities.filter((a) => a.poly).map((a) => ({ id: a.id, sport: a.sport, start: a.start, poly: a.poly }));
  }

  /** Re-reads strava.json after deploy/strava.ps1 changed it on disk. */
  async function reload() {
    config = null;
    await loadConfig();
    queueSync();
    return status();
  }

  async function handle(method, parts, body) {
    const [, key, arg] = parts;
    if (method === 'GET' && !key) return snapshot();
    if (method === 'GET' && key === 'status') return status();
    if (method === 'GET' && key === 'routes') return routes();
    if (method === 'GET' && key === 'activities' && arg) return activity(arg);
    if (method === 'POST' && key === 'sync') return syncNow();
    if (method === 'POST' && key === 'client') return setClient(body);
    if (method === 'POST' && key === 'reload') return reload();
    if (method === 'POST' && key === 'logout') return logout();
    throw new StravaError(404, 'Not found');
  }

  if (autoStart) start().catch((err) => console.error('Strava start failed', err));

  return { handle, loginUrl, callback, snapshot, status, start, stop, syncNow, activity, _usage: () => ({ ...usage, limits: { ...limits }, blockedUntil }) };
}

// ---- Words for notifications (the widget has its own richer formatting) ----

const SPORT_LABELS = {
  Run: 'Run',
  TrailRun: 'Trail run',
  VirtualRun: 'Virtual run',
  Ride: 'Ride',
  MountainBikeRide: 'Mountain bike ride',
  GravelRide: 'Gravel ride',
  EBikeRide: 'E-bike ride',
  VirtualRide: 'Virtual ride',
  Walk: 'Walk',
  Hike: 'Hike',
  Swim: 'Swim',
  WeightTraining: 'Weight training',
  Workout: 'Workout',
  Yoga: 'Yoga',
};

export function sportLabel(sport) {
  return SPORT_LABELS[sport] ?? String(sport ?? 'Activity').replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function summaryLine(a, units = 'imperial') {
  const parts = [];
  if (a.dist > 0) parts.push(units === 'metric' ? `${(a.dist / 1000).toFixed(1)} km` : `${(a.dist / 1609.344).toFixed(1)} mi`);
  const m = Math.round(a.move / 60);
  parts.push(m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`);
  if (a.elev > 0) parts.push(units === 'metric' ? `${Math.round(a.elev)} m up` : `${Math.round(a.elev * 3.28084)} ft up`);
  return parts.join(' · ');
}
