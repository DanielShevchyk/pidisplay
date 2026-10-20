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

test('starts with one profile holding the built-in questions', async () => {
  const { call } = setup(null, at(2026, 10, 13, 23, 30));
  const s = await call('GET', 'checkin');
  assert.equal(s.today, '2026-10-13');
  assert.equal(s.profiles.length, 1);
  const me = s.profiles[0];
  assert.equal(me.id, 'me');
  assert.equal(me.prompt, true);
  assert.deepEqual(me.questions.map((q) => q.id), DEFAULT_QUESTIONS.map((q) => q.id));
  assert.equal(me.questions.find((q) => q.id === 'alcohol').enabled, false);
});

test('saves a day, validates answers, and refuses future days', async () => {
  const { call, events, stored } = setup();
  const s = await call('PUT', 'checkin/profiles/me/entries/2026-10-13', { answers: { sleep: 4, hours: 7.5, weight: 182.4, mood: 3, stress: null, meds: 'planned' }, note: ' ok ' });
  assert.deepEqual(s.profiles[0].entries['2026-10-13'].answers, { sleep: 4, hours: 7.5, weight: 182.4, mood: 3, meds: 'planned' });
  assert.equal(s.profiles[0].entries['2026-10-13'].note, 'ok');
  assert.equal(events.length, 1);
  assert.ok(stored().profiles[0].entries['2026-10-13']);

  const put = (date, answers) => call('PUT', `checkin/profiles/me/entries/${date}`, { answers: { weight: 180, ...answers } });
  await assert.rejects(put('2026-10-13', { sleep: 6 }), /answer it can't take/);
  await assert.rejects(put('2026-10-13', { hours: 7.3 }), /answer it can't take/);
  await assert.rejects(put('2026-10-13', { alcohol: 1 }), /answer it can't take/);
  await assert.rejects(put('2026-10-13', { nope: 1 }), /Unknown question/);
  await assert.rejects(put('2026-10-13', { weight: 15 }), /answer it can't take/);
  await assert.rejects(put('2026-10-13', { weight: 180.25 }), /answer it can't take/);
  await assert.rejects(put('2026-10-13', { meds: 'maybe' }), /answer it can't take/);
  // Weight is required; medication is not.
  await assert.rejects(call('PUT', 'checkin/profiles/me/entries/2026-10-13', { answers: { sleep: 3, meds: 'taken' } }), /Weight is required/);
  assert.equal((await put('2026-10-12', { weight: 180.2 })).profiles[0].entries['2026-10-12'].answers.weight, 180.2);
  await assert.rejects(put('2026-10-14', { sleep: 3 }), /hasn't happened/);
  await assert.rejects(put('2026-02-30', { sleep: 3 }), /real date/);
  await assert.rejects(call('PUT', 'checkin/profiles/nobody/entries/2026-10-13', { answers: { sleep: 3 } }), /No such person/);

  await put('2026-10-11', { alcohol: true });
  const after = await call('DELETE', 'checkin/profiles/me/entries/2026-10-11');
  assert.equal(after.profiles[0].entries['2026-10-11'], undefined);
});

test('profiles: add, rename, own questions and answers, delete', async () => {
  const { call } = setup();
  await call('PUT', 'checkin/profiles/me', { name: 'Dan', emoji: '🦊' });
  let s = await call('POST', 'checkin/profiles', { name: 'Alex' });
  const alex = s.profiles.find((p) => p.name === 'Alex');
  assert.equal(alex.id, 'alex');
  assert.ok(alex.emoji);
  await assert.rejects(call('POST', 'checkin/profiles', { name: 'alex' }), /already/);
  await assert.rejects(call('POST', 'checkin/profiles', {}), /Name is required/);

  // Alex gets a custom question; Dan doesn't see it.
  s = await call('PUT', 'checkin/profiles/alex/questions', [...alex.questions, { id: 'c-meds', label: 'Took my meds?', type: 'yesno' }]);
  await call('PUT', 'checkin/profiles/alex/entries/2026-10-13', { answers: { 'c-meds': true, sleep: 2, weight: 140 } });
  await assert.rejects(call('PUT', 'checkin/profiles/me/entries/2026-10-13', { answers: { 'c-meds': true } }), /Unknown question/);

  // Copying questions from someone else.
  s = await call('POST', 'checkin/profiles', { name: 'Sam', copyFrom: 'alex', prompt: false });
  const sam = s.profiles.find((p) => p.id === 'sam');
  assert.ok(sam.questions.some((q) => q.id === 'c-meds'));
  assert.equal(sam.prompt, false);
  assert.deepEqual(sam.entries, {});

  s = await call('DELETE', 'checkin/profiles/sam');
  s = await call('DELETE', 'checkin/profiles/alex');
  assert.deepEqual(s.profiles.map((p) => p.name), ['Dan']);
  await assert.rejects(call('DELETE', 'checkin/profiles/me'), /at least one/);
});

test('Later hides the prompt for today only', async () => {
  const { call, clock } = setup();
  assert.equal((await call('POST', 'checkin/skip')).skipped, '2026-10-13');
  clock.t = at(2026, 10, 14, 7);
  const s = await call('GET', 'checkin');
  assert.equal(s.today, '2026-10-14');
  assert.notEqual(s.skipped, s.today);
});

test('settings and question rules', async () => {
  const { call } = setup();
  const s = await call('PUT', 'checkin/settings', { promptAt: 6 * 60 + 30, note: false });
  assert.equal(s.settings.promptAt, 390);
  assert.equal(s.settings.note, false);
  await assert.rejects(call('PUT', 'checkin/settings', { promptUntil: 300 }), /stop after it starts/);

  const qs = s.profiles[0].questions;
  await assert.rejects(call('PUT', 'checkin/profiles/me/questions', qs.filter((q) => q.id !== 'sleep')), /turned off but not removed/);
  await assert.rejects(call('PUT', 'checkin/profiles/me/questions', qs.map((q) => ({ ...q, enabled: false }))), /at least one/);
  await assert.rejects(call('PUT', 'checkin/profiles/me/questions', qs.map((q) => (q.id === 'weight' ? { ...q, type: 'scale' } : q))), /Weight is a weight question/);
  await assert.rejects(call('PUT', 'checkin/profiles/me/questions', [...qs, { id: 'c-x', label: 'X?', type: 'choice' }]), /Your own questions/);
  // Turning weight off lets a day be saved without it.
  await call('PUT', 'checkin/profiles/me/questions', qs.map((q) => (q.id === 'weight' ? { ...q, enabled: false } : q)));
  await call('PUT', 'checkin/profiles/me/entries/2026-10-13', { answers: { sleep: 3 } });
  await call('PUT', 'checkin/profiles/me/questions', [...qs, { id: 'c-focus', label: 'Focus?', type: 'scale' }]);
  const s3 = await call('DELETE', 'checkin/profiles/me/questions');
  assert.ok(s3.profiles[0].questions.some((q) => q.id === 'c-focus'));
});

test('a file from before profiles becomes one profile', async () => {
  const saved = { questions: [{ id: 'sleep', label: 'Sleep?', type: 'scale' }], entries: { '2026-10-01': { answers: { sleep: 2 }, at: 1 } }, settings: { promptAt: 360 } };
  const { call } = setup(saved);
  const s = await call('GET', 'checkin');
  assert.equal(s.profiles.length, 1);
  assert.equal(s.profiles[0].name, 'Me');
  assert.equal(s.profiles[0].questions[0].label, 'Sleep?');
  // Built-in questions added since then appear in their usual places, on or off as by default.
  assert.deepEqual(s.profiles[0].questions.map((q) => q.id), DEFAULT_QUESTIONS.map((q) => q.id));
  assert.equal(s.profiles[0].questions.find((q) => q.id === 'weight').enabled, true);
  assert.equal(s.profiles[0].questions.find((q) => q.id === 'weight').required, true);
  assert.equal(s.profiles[0].questions.find((q) => q.id === 'alcohol').enabled, false);
  assert.equal(s.profiles[0].entries['2026-10-01'].answers.sleep, 2);
  assert.equal(s.settings.promptAt, 360);
});

test('CSV export has a row per person and day', () => {
  const csv = toCsv({
    profiles: [
      {
        name: 'Dan',
        questions: [
          { id: 'sleep', short: 'Sleep', type: 'scale' },
          { id: 'alcohol', short: 'Alcohol', type: 'yesno' },
          { id: 'meds', short: 'Medication', type: 'choice', options: [{ value: 'taken', label: 'Taken' }] },
        ],
        entries: {
          '2026-10-13': { answers: { sleep: 4, alcohol: false, meds: 'taken' }, note: 'tired, "meh"', at: Date.UTC(2026, 9, 13, 14) },
          '2026-10-12': { answers: { alcohol: true }, at: 0 },
        },
      },
      { name: 'Alex', questions: [{ id: 'c-meds', short: 'Meds', type: 'yesno' }, { id: 'sleep', short: 'Sleep', type: 'scale' }], entries: { '2026-10-13': { answers: { 'c-meds': true, sleep: 3 }, at: 0 } } },
    ],
  });
  assert.equal(
    csv,
    'person,date,Sleep,Alcohol,Medication,Meds,note,answered at\n' +
      'Dan,2026-10-12,,yes,,,,\n' +
      'Dan,2026-10-13,4,no,Taken,,"tired, ""meh""",2026-10-13T14:00:00.000Z\n' +
      'Alex,2026-10-13,3,,,yes,,\n',
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
