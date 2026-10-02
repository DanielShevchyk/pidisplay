process.env.TZ = 'America/Los_Angeles';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimers, nextOccurrence } from './timers.js';

const MIN = 60000;

function setup(saved = null, start = new Date(2026, 9, 2, 7, 0, 0).getTime()) {
  const clock = { t: start };
  const notes = [];
  const saves = [];
  const events = [];
  const timers = createTimers({
    load: async () => structuredClone(saved),
    save: async (v) => saves.push(v),
    notify: (n) => notes.push(n),
    broadcast: (s) => events.push(s),
    now: () => clock.t,
    tickMs: 1e9,
  });
  const at = (ms) => {
    clock.t += ms;
    timers.tick();
  };
  return { timers, clock, notes, saves, events, at, call: (m, p, b) => timers.handle(m, p.split('/'), b) };
}

test('next occurrence follows the time and weekdays', () => {
  // Fri Oct 2 2026, 07:00 local.
  const from = new Date(2026, 9, 2, 7, 0).getTime();
  assert.equal(nextOccurrence({ hour: 7, minute: 30, days: [] }, from), new Date(2026, 9, 2, 7, 30).getTime());
  assert.equal(nextOccurrence({ hour: 6, minute: 0, days: [] }, from), new Date(2026, 9, 3, 6, 0).getTime());
  // Weekdays only: Friday 6:00 has passed, so Monday.
  assert.equal(nextOccurrence({ hour: 6, minute: 0, days: [1, 2, 3, 4, 5] }, from), new Date(2026, 9, 5, 6, 0).getTime());
  // Across the November DST change the wall-clock time stays put.
  const sat = new Date(2026, 9, 31, 12, 0).getTime();
  const sun = new Date(nextOccurrence({ hour: 7, minute: 0, days: [0] }, sat));
  assert.equal(sun.getHours(), 7);
  assert.equal(sun.getDate(), 1);
});

test('a timer counts down, rings, snoozes and is dismissed', async () => {
  const { call, at, notes } = setup();
  let s = await call('POST', 'timers', { durationMs: 5 * MIN, label: 'Pasta' });
  const id = s.timers[0].id;
  assert.equal(s.timers[0].state, 'running');

  at(4 * MIN);
  s = await call('GET', 'timers');
  assert.equal(s.timers[0].state, 'running');

  at(MIN);
  s = await call('GET', 'timers');
  assert.equal(s.timers[0].state, 'ringing');
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /Pasta is done/);

  s = await call('POST', `timers/${id}/snooze`);
  assert.equal(s.timers[0].state, 'snoozed');
  at(9 * MIN);
  assert.equal((await call('GET', 'timers')).timers[0].state, 'ringing');

  s = await call('POST', `timers/${id}/dismiss`);
  assert.deepEqual(s.timers, []);
});

test('pause, resume and add time', async () => {
  const { call, at } = setup();
  let s = await call('POST', 'timers', { durationMs: 2 * MIN });
  const id = s.timers[0].id;
  at(MIN);
  s = await call('POST', `timers/${id}/pause`);
  assert.equal(s.timers[0].remainingMs, MIN);
  at(10 * MIN);
  assert.equal((await call('GET', 'timers')).timers[0].state, 'paused');
  s = await call('POST', `timers/${id}/add`, { ms: MIN });
  assert.equal(s.timers[0].remainingMs, 2 * MIN);
  s = await call('POST', `timers/${id}/resume`);
  at(2 * MIN);
  assert.equal((await call('GET', 'timers')).timers[0].state, 'ringing');
  // +1 min from the ringing screen counts down again.
  s = await call('POST', `timers/${id}/add`, { ms: MIN });
  assert.equal(s.timers[0].state, 'running');
});

test('a repeating alarm rings, snoozes, and lines up the next day', async () => {
  const { call, at, clock, notes } = setup();
  let s = await call('POST', 'alarms', { hour: 7, minute: 30, days: [1, 2, 3, 4, 5], label: 'Work' });
  const id = s.alarms[0].id;
  assert.equal(s.alarms[0].nextAt, new Date(2026, 9, 2, 7, 30).getTime());

  at(30 * MIN);
  s = await call('GET', 'alarms');
  assert.equal(s.alarms[0].state, 'ringing');
  assert.equal(s.alarms[0].nextAt, new Date(2026, 9, 5, 7, 30).getTime(), 'next is Monday');
  assert.match(notes[0].body, /7:30 AM/);

  await call('PUT', 'timers/settings', { snoozeMinutes: 5 });
  s = await call('POST', `alarms/${id}/snooze`);
  assert.equal(s.alarms[0].snoozeUntil, clock.t + 5 * MIN);
  at(5 * MIN);
  assert.equal((await call('GET', 'alarms')).alarms[0].state, 'ringing');
  s = await call('POST', `alarms/${id}/dismiss`);
  assert.equal(s.alarms[0].state, 'idle');
  assert.equal(s.alarms[0].enabled, true);
});

test('a one-time alarm turns itself off', async () => {
  const { call, at } = setup();
  let s = await call('POST', 'alarms', { hour: 7, minute: 1 });
  at(MIN);
  s = await call('GET', 'alarms');
  assert.equal(s.alarms[0].state, 'ringing');
  assert.equal(s.alarms[0].enabled, false);
  s = await call('POST', `alarms/${s.alarms[0].id}/dismiss`);
  assert.equal(s.alarms[0].nextAt, null);
});

test('stops ringing on its own after the ring limit', async () => {
  const { call, at, notes } = setup();
  await call('PUT', 'timers/settings', { ringMinutes: 2 });
  await call('POST', 'timers', { durationMs: MIN });
  at(MIN);
  at(2 * MIN);
  assert.deepEqual((await call('GET', 'timers')).timers, []);
  assert.match(notes.at(-1).title, /without an answer/);
});

test('turning an alarm off stops it ringing', async () => {
  const { call, at } = setup();
  let s = await call('POST', 'alarms', { hour: 7, minute: 1, days: [5] });
  at(MIN);
  s = await call('PUT', `alarms/${s.alarms[0].id}`, { enabled: false });
  assert.equal(s.alarms[0].state, 'idle');
  assert.equal(s.alarms[0].nextAt, null);
});

test('after a long outage, overdue items are reported missed instead of ringing', async () => {
  const start = new Date(2026, 9, 2, 7, 0).getTime();
  const saved = {
    settings: {},
    timers: [{ id: 't1', label: '', sound: null, durationMs: MIN, state: 'running', endsAt: start - 3600000, remainingMs: null, ringingSince: null, snoozeUntil: null }],
    alarms: [{ id: 'a1', label: '', hour: 6, minute: 0, days: [], enabled: true, sound: null, nextAt: start - 3600000, state: 'idle', ringingSince: null, snoozeUntil: null }],
  };
  const { timers, notes } = setup(saved, start);
  await timers.ready;
  const s = timers.snapshot();
  assert.deepEqual(s.timers, []);
  assert.equal(s.alarms[0].state, 'idle');
  assert.equal(s.alarms[0].enabled, false);
  assert.equal(notes.length, 2);
  assert.ok(notes.every((n) => /display was off/.test(n.title)));
});

test('a recent missed tick still rings after a restart', async () => {
  const start = new Date(2026, 9, 2, 7, 0).getTime();
  const saved = {
    timers: [{ id: 't1', label: '', sound: null, durationMs: MIN, state: 'running', endsAt: start - MIN, remainingMs: null, ringingSince: null, snoozeUntil: null }],
    alarms: [],
  };
  const { timers } = setup(saved, start);
  await timers.ready;
  assert.equal(timers.snapshot().timers[0].state, 'ringing');
});

test('validates input', async () => {
  const { call } = setup();
  await assert.rejects(call('POST', 'timers', { durationMs: 10 }), { status: 400 });
  await assert.rejects(call('POST', 'alarms', { hour: 24, minute: 0 }), { status: 400 });
  await assert.rejects(call('POST', 'alarms', { hour: 7, minute: 0, days: [7] }), { status: 400 });
  await assert.rejects(call('POST', 'alarms', { hour: 7, minute: 0, sound: 'airhorn' }), { status: 400 });
  await assert.rejects(call('PUT', 'timers/settings', { volume: 101 }), { status: 400 });
  await assert.rejects(call('POST', 'timers/nope/pause'), { status: 404 });
});
