import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStrava, compactActivity, thin, summaryLine } from './strava.js';

const SECRET = 'a'.repeat(40);

function activity(id, daysAgo, extra = {}) {
  const start = new Date(Date.UTC(2026, 10, 12, 15) - daysAgo * 86400000).toISOString();
  return {
    id,
    name: `Run ${id}`,
    sport_type: 'Run',
    start_date: start,
    start_date_local: start,
    distance: 5000,
    moving_time: 1500,
    elapsed_time: 1600,
    total_elevation_gain: 40,
    average_speed: 3.33,
    has_heartrate: true,
    average_heartrate: 150,
    map: { summary_polyline: '_p~iF~ps|U_ulLnnqC' },
    ...extra,
  };
}

/** A pretend Strava: an activity list, token endpoint and rate-limit headers. */
function fakeStrava({ list = [], scopeOk = true, readUsage = '1,1' } = {}) {
  const calls = [];
  const headers = new Map([
    ['x-readratelimit-limit', '100,1000'],
    ['x-readratelimit-usage', readUsage],
  ]);
  const respond = (status, body) => ({
    ok: status < 400,
    status,
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push(`${opts.method ?? 'GET'} ${u.pathname}${u.search}`);
    if (u.pathname === '/oauth/token') {
      const p = new URLSearchParams(opts.body);
      if (p.get('client_secret') !== SECRET) return respond(401, { message: 'Bad secret' });
      return respond(200, {
        access_token: `acc-${calls.length}`,
        refresh_token: 'ref-2',
        expires_at: Math.floor(Date.now() / 1000) + 21600,
        athlete: { id: 7, firstname: 'Dan', lastname: 'S', measurement_preference: 'feet' },
      });
    }
    if (u.pathname === '/oauth/deauthorize') return respond(200, {});
    if (!scopeOk && u.pathname.startsWith('/api/v3/athlete/activities')) {
      return respond(401, { message: 'Authorization Error', errors: [{ resource: 'AccessToken', field: 'activity:read_permission', code: 'missing' }] });
    }
    if (u.pathname === '/api/v3/athlete') return respond(200, { id: 7, firstname: 'Dan', lastname: 'S', city: 'Sacramento', state: 'CA' });
    if (u.pathname === '/api/v3/athlete/activities') {
      const after = Number(u.searchParams.get('after') ?? 0);
      const before = Number(u.searchParams.get('before') ?? Infinity);
      const per = Number(u.searchParams.get('per_page'));
      const page = Number(u.searchParams.get('page') ?? 1);
      const hits = list
        .filter((a) => {
          const t = Date.parse(a.start_date) / 1000;
          return t > after && t < before;
        })
        .sort((a, b) => Date.parse(b.start_date) - Date.parse(a.start_date));
      return respond(200, hits.slice((page - 1) * per, page * per));
    }
    const m = u.pathname.match(/^\/api\/v3\/activities\/(\d+)(\/streams)?$/);
    if (m && m[2]) return respond(200, { distance: { data: [0, 1000, 2000] }, altitude: { data: [10, 12, 11] }, heartrate: { data: [120, 150, 160] } });
    if (m) return respond(200, { description: 'Easy', calories: 400, splits_standard: [{ distance: 1609, moving_time: 480, average_speed: 3.35 }], best_efforts: [{ name: '1 mile', moving_time: 470, distance: 1609, pr_rank: 1 }] });
    return respond(404, {});
  };
  return { fetchImpl, calls, list };
}

async function setup(fake, opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'strava-'));
  const strava = createStrava({
    configFile: path.join(dir, 'strava.json'),
    dataFile: path.join(dir, 'strava-data.json'),
    detailsFile: path.join(dir, 'strava-details.json'),
    fetchImpl: fake.fetchImpl,
    autoStart: false,
    ...opts,
  });
  return { dir, strava };
}

async function connect(strava) {
  await strava.handle('POST', ['strava', 'client'], { clientId: '12345', clientSecret: SECRET });
  const url = new URL(await strava.loginUrl('/'));
  assert.equal(url.searchParams.get('scope'), 'read,activity:read_all');
  const state = url.searchParams.get('state');
  await strava.callback(new URLSearchParams({ state, code: 'c1', scope: 'read,activity:read_all' }));
}

test('compactActivity keeps the fields the widget uses', () => {
  const a = compactActivity(activity(1, 0));
  assert.equal(a.sport, 'Run');
  assert.equal(a.dist, 5000);
  assert.equal(a.hr, 150);
  assert.ok(a.poly);
  assert.equal(summaryLine(a), '3.1 mi · 25 min · 131 ft up');
});

test('thin keeps the first and last point', () => {
  const t = thin([...Array(1000).keys()], 10);
  assert.equal(t.length, 10);
  assert.equal(t[0], 0);
  assert.equal(t[9], 999);
});

test('rejects bad client credentials', async () => {
  const { strava, dir } = await setup(fakeStrava());
  await assert.rejects(strava.handle('POST', ['strava', 'client'], { clientId: 'abc', clientSecret: SECRET }), /Client ID/);
  await assert.rejects(strava.handle('POST', ['strava', 'client'], { clientId: '1', clientSecret: 'short' }), /Secret/);
  await fs.rm(dir, { recursive: true });
});

test('sign-in, full history download, secret never in the snapshot', async () => {
  const fake = fakeStrava({ list: Array.from({ length: 450 }, (_, i) => activity(i + 1, i * 2)) });
  const { strava, dir } = await setup(fake);
  await connect(strava);
  await strava.syncNow();
  const snap = await strava.snapshot();
  assert.equal(snap.connected, true);
  assert.equal(snap.scopeOk, true);
  assert.equal(snap.count, 450);
  assert.equal(snap.backfilled, true);
  assert.equal(snap.athlete.city, 'Sacramento, CA');
  assert.ok(!JSON.stringify(snap).includes(SECRET));
  assert.ok(!JSON.stringify(snap).includes('ref-2'));
  // Routes ride along only for the newest activities.
  assert.ok(snap.activities[0].poly);
  assert.equal(snap.activities[100].poly, undefined);
  assert.equal(snap.activities[100].hasRoute, true);
  const mode = (await fs.stat(path.join(dir, 'strava.json'))).mode & 0o777;
  assert.equal(mode, 0o600);
  await fs.rm(dir, { recursive: true });
});

test('later syncs ask for one page of recent activities and pick up edits and deletions', async () => {
  const fake = fakeStrava({ list: [activity(1, 1), activity(2, 3), activity(3, 30)] });
  const { strava, dir } = await setup(fake);
  await connect(strava);
  await strava.syncNow();
  fake.calls.length = 0;
  fake.list.splice(1, 1); // activity 2 deleted on Strava
  fake.list[0].name = 'Renamed';
  fake.list.push(activity(4, 0));
  // Bypass the manual cooldown by making a fresh instance over the same files.
  const again = createStrava({
    configFile: path.join(dir, 'strava.json'),
    dataFile: path.join(dir, 'strava-data.json'),
    detailsFile: path.join(dir, 'strava-details.json'),
    fetchImpl: fake.fetchImpl,
    autoStart: false,
  });
  await again.syncNow();
  const snap = await again.snapshot();
  assert.deepEqual(snap.activities.map((a) => a.id), [4, 1, 3]);
  assert.equal(snap.activities[1].name, 'Renamed');
  const listCalls = fake.calls.filter((c) => c.includes('/athlete/activities'));
  assert.equal(listCalls.length, 1);
  await fs.rm(dir, { recursive: true });
});

test('a sign-in without activity permission is refused with a clear message', async () => {
  const { strava, dir } = await setup(fakeStrava());
  await strava.handle('POST', ['strava', 'client'], { clientId: '12345', clientSecret: SECRET });
  const state = new URL(await strava.loginUrl('/')).searchParams.get('state');
  await assert.rejects(strava.callback(new URLSearchParams({ state, code: 'c', scope: 'read' })), /View data about your activities/);
  await fs.rm(dir, { recursive: true });
});

test('a token missing activity permission shows the reconnect message', async () => {
  const { strava, dir } = await setup(fakeStrava({ scopeOk: false }));
  await connect(strava);
  await strava.syncNow();
  const snap = await strava.snapshot();
  assert.match(snap.error, /Connect Strava again/);
  await fs.rm(dir, { recursive: true });
});

test('background sync stops at half the read limit Strava reports', async () => {
  const fake = fakeStrava({ list: [activity(1, 1)], readUsage: '50,10' });
  const { strava, dir } = await setup(fake);
  await connect(strava);
  await strava.syncNow(); // first call reads the headers: 50 of 100 used
  const snap = await strava.snapshot();
  assert.match(snap.error ?? '', /Saving Strava requests|limit/);
  await fs.rm(dir, { recursive: true });
});

test('activity details are fetched once and then served from disk', async () => {
  const fake = fakeStrava({ list: [activity(1, 10)] });
  const { strava, dir } = await setup(fake);
  await connect(strava);
  await strava.syncNow();
  fake.calls.length = 0;
  const d = await strava.activity(1);
  assert.equal(d.detail.calories, 400);
  assert.equal(d.detail.bestEfforts[0].pr, 1);
  assert.deepEqual(d.streams.heartrate, [120, 150, 160]);
  assert.equal(fake.calls.length, 2);
  await strava.activity(1);
  assert.equal(fake.calls.length, 2);
  await fs.rm(dir, { recursive: true });
});

test('a rejected refresh token signs out and keeps the app credentials', async () => {
  const fake = fakeStrava({ list: [activity(1, 1)] });
  const { strava, dir } = await setup(fake);
  await connect(strava);
  // Expire the token and break the secret on disk, as if the app was reset.
  const file = path.join(dir, 'strava.json');
  const cfg = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...cfg, expiresAt: 0, clientSecret: 'b'.repeat(40) }));
  await strava.handle('POST', ['strava', 'reload'], null);
  await strava.syncNow();
  const snap = await strava.snapshot();
  assert.equal(snap.connected, false);
  assert.equal(snap.configured, true);
  await fs.rm(dir, { recursive: true });
});
