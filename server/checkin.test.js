process.env.TZ = 'America/Los_Angeles';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckin, DEFAULT_QUESTIONS, toCsv } from './checkin.js';

const at = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();

function setup(saved = null, start = at(2026, 10, 13, 7, 30)) {
  const clock = { t: start };
  const events = [];
  let stored = saved;
  const checkin = createCheckin({
    load: async () => structuredClone(saved),
    save: async (v) => (stored = structuredClone(v)),
    broadcast: (s) => events.push(s),
    now: () => clock.t,
  });
  const call = (m, p, b) => checkin.handle(m, p.split('/'), b);
  return { checkin, clock, events, call, stored: () => stored };
}

test('starts with the built-in questions and today in the Pi time zone', async () => {
  const { call } = setup(null, at(2026, 10, 13, 23, 30));
  const s = await call('GET', 'checkin');
  assert.equal(s.today, '2026-10-13');
  assert.deepEqual(s.questions.map((q) => q.id), DEFAULT_QUESTIONS.map((q) => q.id));
  assert.equal(s.questions.find((q) => q.id === 'alcohol').enabled, false);
  assert.deepEqual(s.entries, {});
});

test('saves a day, validates answers, and refuses future days', async () => {
  const { call, events, stored } = setup();
  const s = await call('PUT', 'checkin/entries/2026-10-13', { answers: { sleep: 4, hours: 7.5, mood: 3, stress: null }, note: ' ok ' });
  assert.deepEqual(s.entries['2026-10-13'].answers, { sleep: 4, hours: 7.5, mood: 3 });
  assert.equal(s.entries['2026-10-13'].note, 'ok');
  assert.equal(events.length, 1);
  assert.ok(stored().entries['2026-10-13']);

  await assert.rejects(call('PUT', 'checkin/entries/2026-10-13', { answers: { sleep: 6 } }), /answer it can't take/);
  await assert.rejects(call('PUT', 'checkin/entries/2026-10-13', { answers: { hours: 7.3 } }), /answer it can't take/);
  await assert.rejects(call('PUT', 'checkin/entries/2026-10-13', { answers: { alcohol: 1 } }), /answer it can't take/);
  await assert.rejects(call('PUT', 'checkin/entries/2026-10-13', { answers: { nope: 1 } }), /Unknown question/);
  await assert.rejects(call('PUT', 'checkin/entries/2026-10-13', { answers: {} }), /at least one/);
  await assert.rejects(call('PUT', 'checkin/entries/2026-10-14', { answers: { sleep: 3 } }), /hasn't happened/);
  await assert.rejects(call('PUT', 'checkin/entries/2026-02-30', { answers: { sleep: 3 } }), /real date/);

  // Filling in a missed day, then removing it.
  await call('PUT', 'checkin/entries/2026-10-11', { answers: { alcohol: true } });
  const after = await call('DELETE', 'checkin/entries/2026-10-11');
  assert.equal(after.entries['2026-10-11'], undefined);
});

test('Later hides the prompt for today only', async () => {
  const { call, clock } = setup();
  assert.equal((await call('POST', 'checkin/skip')).skipped, '2026-10-13');
  clock.t = at(2026, 10, 14, 7);
  const s = await call('GET', 'checkin');
  assert.equal(s.today, '2026-10-14');
  assert.notEqual(s.skipped, s.today);
});

test('settings and custom questions', async () => {
  const { call } = setup();
  const s = await call('PUT', 'checkin/settings', { promptAt: 6 * 60 + 30, note: false });
  assert.equal(s.settings.promptAt, 390);
  assert.equal(s.settings.note, false);
  await assert.rejects(call('PUT', 'checkin/settings', { promptUntil: 300 }), /stop after it starts/);

  const qs = [...s.questions, { id: 'c-meds', label: 'Took my meds?', type: 'yesno' }];
  const s2 = await call('PUT', 'checkin/questions', qs);
  const meds = s2.questions.find((q) => q.id === 'c-meds');
  assert.equal(meds.custom, true);
  assert.equal(meds.short, 'Took my meds?');
  await call('PUT', 'checkin/entries/2026-10-13', { answers: { 'c-meds': true } });

  await assert.rejects(call('PUT', 'checkin/questions', s.questions.filter((q) => q.id !== 'sleep')), /turned off but not removed/);
  await assert.rejects(
    call('PUT', 'checkin/questions', s.questions.map((q) => ({ ...q, enabled: false }))),
    /at least one/,
  );

  // Reset keeps custom questions.
  const s3 = await call('DELETE', 'checkin/questions');
  assert.ok(s3.questions.some((q) => q.id === 'c-meds'));
  assert.equal(s3.questions.find((q) => q.id === 'alcohol').enabled, false);
});

test('an old file gains new built-in questions, turned off', async () => {
  const saved = { questions: [{ id: 'sleep', label: 'Sleep?', type: 'scale' }], entries: { '2026-10-01': { answers: { sleep: 2 }, at: 1 } } };
  const { call } = setup(saved);
  const s = await call('GET', 'checkin');
  assert.equal(s.questions[0].label, 'Sleep?');
  assert.equal(s.questions.find((q) => q.id === 'mood').enabled, false);
  assert.equal(s.entries['2026-10-01'].answers.sleep, 2);
});

test('CSV export', () => {
  const csv = toCsv({
    questions: [
      { id: 'sleep', short: 'Sleep', type: 'scale' },
      { id: 'alcohol', short: 'Alcohol', type: 'yesno' },
    ],
    entries: {
      '2026-10-13': { answers: { sleep: 4, alcohol: false }, note: 'tired, "meh"', at: Date.UTC(2026, 9, 13, 14) },
      '2026-10-12': { answers: { alcohol: true }, at: 0 },
    },
  });
  assert.equal(
    csv,
    'date,Sleep,Alcohol,note,answered at\n' +
      '2026-10-12,,yes,,\n' +
      '2026-10-13,4,no,"tired, ""meh""",2026-10-13T14:00:00.000Z\n',
  );
});

test('broadcasts when the day rolls over', async () => {
  const { checkin, clock, events, call } = setup(null, at(2026, 10, 13, 23, 59));
  await call('GET', 'checkin');
  checkin.tick();
  assert.equal(events.length, 0);
  clock.t = at(2026, 10, 14, 0, 0);
  checkin.tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].today, '2026-10-14');
});
