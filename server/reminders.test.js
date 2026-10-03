process.env.TZ = 'America/Los_Angeles';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReminders, nextOccurrence } from './reminders.js';

const MIN = 60000;
const at = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();

function setup(saved = null, start = at(2026, 10, 3, 8, 0)) {
  const clock = { t: start };
  const notes = [];
  const sounds = [];
  const events = [];
  const reminders = createReminders({
    load: async () => structuredClone(saved),
    save: async () => {},
    notify: (n) => notes.push(n),
    broadcast: (s) => events.push(s),
    sound: (s) => sounds.push(s),
    now: () => clock.t,
    tickMs: 1e9,
  });
  const pass = (ms) => {
    clock.t += ms;
    reminders.tick();
  };
  const call = (m, p, b) => reminders.handle(m, p.split('/'), b);
  return { reminders, clock, notes, sounds, events, pass, call };
}

const base = { title: 'x', date: '2026-10-03', hour: 9, minute: 0, interval: 1, days: [], until: null };

test('one-time and hourly occurrences', () => {
  const r = { ...base, repeat: 'none' };
  assert.equal(nextOccurrence(r, at(2026, 10, 3, 8)), at(2026, 10, 3, 9));
  assert.equal(nextOccurrence(r, at(2026, 10, 3, 9)), null);
  const h = { ...base, repeat: 'hourly', interval: 2 };
  assert.equal(nextOccurrence(h, at(2026, 10, 3, 9)), at(2026, 10, 3, 11));
  assert.equal(nextOccurrence(h, at(2026, 10, 3, 12, 30)), at(2026, 10, 3, 13));
});

test('daily every N days, and the end date', () => {
  const r = { ...base, repeat: 'daily', interval: 3 };
  assert.equal(nextOccurrence(r, at(2026, 10, 3, 8)), at(2026, 10, 3, 9));
  assert.equal(nextOccurrence(r, at(2026, 10, 3, 9)), at(2026, 10, 6, 9));
  assert.equal(nextOccurrence(r, at(2026, 10, 7, 10)), at(2026, 10, 9, 9));
  assert.equal(nextOccurrence({ ...r, until: '2026-10-08' }, at(2026, 10, 6, 10)), null);
  // Across the November DST change it stays at 9:00 wall-clock time.
  const d = new Date(nextOccurrence({ ...base, repeat: 'daily' }, at(2026, 11, 1, 10)));
  assert.equal(d.getHours(), 9);
  assert.equal(d.getDate(), 2);
});

test('weekly on chosen days, every other week', () => {
  // Oct 3 2026 is a Saturday.
  const r = { ...base, repeat: 'weekly', days: [2, 4] }; // Tue, Thu
  assert.equal(nextOccurrence(r, at(2026, 10, 3, 8)), at(2026, 10, 6, 9));
  assert.equal(nextOccurrence(r, at(2026, 10, 6, 9)), at(2026, 10, 8, 9));
  const two = { ...r, interval: 2 };
  // The start date's week (Sep 27 - Oct 3) counts, so the next on-week is Oct 11-17.
  assert.equal(nextOccurrence(two, at(2026, 10, 3, 8)), at(2026, 10, 13, 9));
  assert.equal(nextOccurrence(two, at(2026, 10, 15, 10)), at(2026, 10, 27, 9));
  // No days chosen: the start date's weekday.
  assert.equal(nextOccurrence({ ...base, repeat: 'weekly' }, at(2026, 10, 3, 10)), at(2026, 10, 10, 9));
});

test('monthly and yearly, clamped to short months', () => {
  const r = { ...base, date: '2026-01-31', repeat: 'monthly' };
  assert.equal(nextOccurrence(r, at(2026, 1, 31, 10)), at(2026, 2, 28, 9));
  assert.equal(nextOccurrence(r, at(2026, 3, 1)), at(2026, 3, 31, 9));
  assert.equal(nextOccurrence({ ...r, interval: 3 }, at(2026, 2, 1)), at(2026, 4, 30, 9));
  const y = { ...base, date: '2028-02-29', repeat: 'yearly' };
  assert.equal(nextOccurrence(y, at(2028, 3, 1)), at(2029, 2, 28, 9));
  assert.equal(nextOccurrence(y, at(2026, 1, 1)), at(2028, 2, 29, 9));
});

test('a reminder comes due with a notification and sound, then Done finishes it', async () => {
  const { call, pass, notes, sounds } = setup();
  let s = await call('POST', 'reminders', { title: 'Take out trash', notes: 'Blue bin', date: '2026-10-03', hour: 9, minute: 0 });
  const id = s.reminders[0].id;
  assert.equal(s.reminders[0].nextAt, at(2026, 10, 3, 9));

  pass(59 * MIN);
  assert.equal(notes.length, 0);
  pass(MIN);
  s = await call('GET', 'reminders');
  assert.equal(s.reminders[0].state, 'due');
  assert.equal(s.reminders[0].nextAt, null);
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /Take out trash/);
  assert.match(notes[0].body, /9:00 AM · Blue bin/);
  assert.deepEqual(sounds, [{ id, sound: 'marimba', volume: 80, repeats: 3 }]);

  s = await call('POST', `reminders/${id}/snooze`, { minutes: 10 });
  assert.equal(s.reminders[0].state, 'snoozed');
  pass(10 * MIN);
  s = await call('GET', 'reminders');
  assert.equal(s.reminders[0].state, 'due');
  assert.equal(sounds.length, 2);

  s = await call('POST', `reminders/${id}/done`);
  assert.equal(s.reminders[0].state, 'idle');
  assert.ok(s.reminders[0].completedAt);
  s = await call('DELETE', 'reminders');
  assert.equal(s.reminders.length, 0);
});

test('a repeating reminder lines up its next time and Done keeps it', async () => {
  const { call, pass } = setup();
  let s = await call('POST', 'reminders', { title: 'Pills', date: '2026-10-03', hour: 9, minute: 0, repeat: 'daily' });
  const id = s.reminders[0].id;
  pass(60 * MIN);
  s = await call('GET', 'reminders');
  assert.equal(s.reminders[0].state, 'due');
  assert.equal(s.reminders[0].nextAt, at(2026, 10, 4, 9));
  s = await call('POST', `reminders/${id}/done`);
  assert.equal(s.reminders[0].state, 'idle');
  assert.equal(s.reminders[0].completedAt, null);
  assert.equal(s.reminders[0].nextAt, at(2026, 10, 4, 9));
});

test('missed while the Pi was off: due but silent, skipping to the next time', async () => {
  const saved = {
    settings: {},
    reminders: [{ id: 'r1', ...base, title: 'Water plants', notes: '', repeat: 'daily', sound: null, enabled: true, nextAt: at(2026, 10, 1, 9), state: 'idle', completedAt: null }],
  };
  const { reminders, notes, sounds } = setup(saved, at(2026, 10, 3, 8));
  await reminders.ready;
  const s = reminders.snapshot();
  assert.equal(s.reminders[0].state, 'due');
  assert.equal(s.reminders[0].nextAt, at(2026, 10, 3, 9));
  assert.equal(notes[0].level, 'warning');
  assert.match(notes[0].body, /Missed/);
  assert.equal(sounds.length, 0);
});

test('re-chimes every N minutes while due, for up to an hour', async () => {
  const { call, pass, sounds } = setup();
  await call('PUT', 'reminders/settings', { nagMinutes: 5 });
  await call('POST', 'reminders', { title: 'Call mom', date: '2026-10-03', hour: 8, minute: 1 });
  pass(MIN);
  assert.equal(sounds.length, 1);
  for (let i = 0; i < 20; i++) pass(5 * MIN);
  assert.equal(sounds.length, 12);
});

test('test reminder rings in 5 seconds and disappears on Done', async () => {
  const { call, pass, sounds } = setup();
  let s = await call('POST', 'reminders/test');
  const id = s.reminders[0].id;
  pass(5000);
  assert.equal(sounds.length, 1);
  s = await call('POST', `reminders/${id}/done`);
  assert.equal(s.reminders.length, 0);
});

test('rejects bad input', async () => {
  const { call } = setup();
  await assert.rejects(call('POST', 'reminders', { title: '', date: '2026-10-03', hour: 9, minute: 0 }), /title/);
  await assert.rejects(call('POST', 'reminders', { title: 'a', date: '2026-02-30', hour: 9, minute: 0 }), /real date/);
  await assert.rejects(call('POST', 'reminders', { title: 'a', date: '2026-10-03', hour: 9, minute: 0, repeat: 'daily', until: '2026-10-01' }), /end date/);
  await assert.rejects(call('POST', 'reminders', { title: 'a', date: '2026-10-03', hour: 9, minute: 0, sound: 'kazoo' }), /sound/);
});
