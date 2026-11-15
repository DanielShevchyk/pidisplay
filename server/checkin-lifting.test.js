process.env.TZ = 'America/Los_Angeles';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCheckinLifting, matchPerson } from './checkin-lifting.js';
import { createCheckin, toCsv } from './checkin.js';
import { createServer } from './server.js';

const NOW = new Date(2026, 10, 14, 8).getTime();
const day = (date, sets, extra = {}) => ({ date, labels: ['A'], working_sets: sets, volume_lb: sets * 1000, groups: ['Legs', 'Back'], prs: 0, ...extra });

/** A pretend lifting service: people plus each one's days; `calls` records every URL asked for. */
function fakeLifting({ people = [{ id: 1, name: 'Dan' }], days = { 1: { first_date: '2026-10-01', days: [day('2026-11-12', 18)] } }, fail = false } = {}) {
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    if (fail) throw new Error('down');
    const u = new URL(url);
    if (u.pathname === '/api/people') return people;
    if (u.pathname === '/api/days') return days[u.searchParams.get('person')] ?? { first_date: null, days: [] };
    throw new Error('404');
  };
  return { calls, fetchJson };
}

test('matches a check-in person to a lifting person', () => {
  const people = [{ name: 'Dan' }, { name: 'Alex' }];
  const dan = { name: 'dan' };
  assert.equal(matchPerson(dan, [dan, { name: 'Sam' }], people).name, 'Dan');
  assert.equal(matchPerson({ name: 'Sam' }, [dan, { name: 'Sam' }], people), null);
  assert.equal(matchPerson({ name: 'Sam', lifting: 'alex' }, [], people).name, 'Alex');
  assert.equal(matchPerson({ name: 'Dan', lifting: '' }, [], people), null);
  assert.equal(matchPerson({ name: 'Dan', lifting: 'Nobody' }, [], people), null);
  // One check-in person and one lifting person go together whatever their names.
  const me = { name: 'Me' };
  assert.equal(matchPerson(me, [me], [{ name: 'Dan' }]).name, 'Dan');
  assert.equal(matchPerson(me, [me, dan], [{ name: 'Alex' }]), null);
});

test('reads lifting days for each profile and caches them for a minute', async () => {
  const clock = { t: NOW };
  const fake = fakeLifting();
  const lifting = createCheckinLifting({ liftingUrl: 'http://lift:8090', fetchJson: fake.fetchJson, now: () => clock.t });
  const profiles = [{ id: 'dan', name: 'Dan' }, { id: 'sam', name: 'Sam' }];
  const r = await lifting.forProfiles(profiles);
  assert.deepEqual(r, {
    available: true,
    people: ['Dan'],
    byProfile: { dan: { person: 'Dan', firstDate: '2026-10-01', from: '2025-10-10', days: { '2026-11-12': { sets: 18, volume: 18000, groups: ['Legs', 'Back'], labels: ['A'], prs: 0 } } } },
  });
  // About 400 days back.
  assert.equal(new URL(fake.calls[1]).searchParams.get('from'), '2025-10-10');
  await lifting.forProfiles(profiles);
  assert.equal(fake.calls.length, 2);
  clock.t += 61000;
  await lifting.forProfiles(profiles);
  assert.equal(fake.calls.length, 4);
  // The export asks for every day.
  await lifting.forProfiles(profiles, { allTime: true });
  assert.equal(new URL(fake.calls.at(-1)).searchParams.get('from'), null);
});

test('a lifting service that is down or empty means no lifting data', async () => {
  const down = fakeLifting({ fail: true });
  const lifting = createCheckinLifting({ liftingUrl: 'http://lift:8090', fetchJson: down.fetchJson, now: () => NOW });
  assert.deepEqual(await lifting.forProfiles([{ id: 'me', name: 'Me' }]), { available: false, people: [], byProfile: {} });
  // Failures are cached too, so a dead service isn't asked on every load.
  await lifting.forProfiles([{ id: 'me', name: 'Me' }]);
  assert.equal(down.calls.length, 1);
  const empty = createCheckinLifting({ liftingUrl: 'http://lift:8090', fetchJson: fakeLifting({ days: {} }).fetchJson, now: () => NOW });
  assert.deepEqual((await empty.forProfiles([{ id: 'dan', name: 'Dan' }])).byProfile.dan.days, {});
  // The real fetch gives up quickly on a service that never answers.
  const stuck = createCheckinLifting({ liftingUrl: 'http://10.255.255.1:8090', timeoutMs: 100 });
  const t = Date.now();
  assert.equal((await stuck.forProfiles([{ id: 'me', name: 'Me' }])).available, false);
  assert.ok(Date.now() - t < 1500);
});

test('the profile keeps its lifting choice', async () => {
  let stored = null;
  const checkin = createCheckin({ load: async () => null, save: async (v) => (stored = structuredClone(v)), broadcast: () => {}, now: () => NOW });
  const call = (m, p, b) => checkin.handle(m, p.split('/'), b);
  let s = await call('PUT', 'checkin/profiles/me', { lifting: 'Dan' });
  assert.equal(s.profiles[0].lifting, 'Dan');
  s = await call('PUT', 'checkin/profiles/me', { lifting: '' });
  assert.equal(s.profiles[0].lifting, '');
  await assert.rejects(call('PUT', 'checkin/profiles/me', { lifting: 3 }), /Lifting data/);
  await assert.rejects(call('PUT', 'checkin/profiles/me', { lifting: 'x'.repeat(41) }), /Lifting data/);
  s = await call('PUT', 'checkin/profiles/me', { lifting: null });
  assert.equal('lifting' in s.profiles[0], false);
  await call('PUT', 'checkin/profiles/me', { lifting: 'Alex' });
  const again = createCheckin({ load: async () => stored, save: async () => {}, broadcast: () => {} });
  assert.equal((await again.handle('GET', ['checkin'])).profiles[0].lifting, 'Alex');
});

test('CSV adds lifting columns when there is lifting data', () => {
  const state = {
    profiles: [
      { id: 'dan', name: 'Dan', questions: [{ id: 'sleep', short: 'Sleep', type: 'scale' }], entries: { '2026-11-12': { answers: { sleep: 4 }, at: 0 }, '2026-11-13': { answers: { sleep: 3 }, at: 0 } } },
      { id: 'sam', name: 'Sam', questions: [{ id: 'sleep', short: 'Sleep', type: 'scale' }], entries: { '2026-11-12': { answers: { sleep: 2 }, at: 0 } } },
    ],
  };
  const lifting = { dan: { person: 'Dan', firstDate: '2026-10-01', days: { '2026-11-12': { sets: 18, volume: 12345, groups: [], labels: [], prs: 0 } } } };
  assert.equal(
    toCsv(state, lifting),
    'person,date,Sleep,lifted,lifting sets,lifting volume lb,note,answered at\n' +
      'Dan,2026-11-12,4,yes,18,12345,,\n' +
      'Dan,2026-11-13,3,,,,,\n' +
      'Sam,2026-11-12,2,,,,,\n',
  );
  assert.equal(toCsv(state), 'person,date,Sleep,note,answered at\nDan,2026-11-12,4,,\nDan,2026-11-13,3,,\nSam,2026-11-12,2,,\n');
});

test('GET /api/checkin/lifting and the export, with the lifting service up and down', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pidisplay-checkin-lifting-'));
  await fs.writeFile(path.join(dataDir, 'checkin.json'), JSON.stringify({ version: 3, profiles: [{ id: 'dan', name: 'Dan', entries: { '2026-11-12': { answers: { sleep: 4 }, at: 0 } } }] }));
  const make = (opts) =>
    createServer({
      dataDir,
      distDir: path.join(dataDir, 'dist'),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      faresConfigFile: path.join(dataDir, 'fw.json'),
      stocksAutoStart: false,
      stravaAutoStart: false,
      ...opts,
    });
  const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
  const up = make({ liftingUrl: 'http://lift:8090', liftingFetchJson: fakeLifting().fetchJson });
  const down = make({ liftingUrl: 'http://127.0.0.1:9' }); // nothing listens there
  try {
    const upBase = await listen(up);
    const downBase = await listen(down);
    const r = await (await fetch(`${upBase}/api/checkin/lifting`)).json();
    assert.equal(r.available, true);
    assert.equal(r.byProfile.dan.days['2026-11-12'].sets, 18);
    assert.match(await (await fetch(`${upBase}/api/checkin/export.csv`)).text(), /^person,date,.*,lifted,lifting sets,lifting volume lb,note/);
    const d = await fetch(`${downBase}/api/checkin/lifting`);
    assert.equal(d.status, 200);
    assert.deepEqual(await d.json(), { available: false, people: [], byProfile: {} });
    const csv = await (await fetch(`${downBase}/api/checkin/export.csv`)).text();
    assert.match(csv, /^person,date,/);
    assert.doesNotMatch(csv, /lifted/);
  } finally {
    for (const s of [up, down]) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
