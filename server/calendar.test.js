import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCalendar, eventsBetween, parseIcs } from './calendar.js';

const LA = 'America/Los_Angeles';
const ms = (iso) => Date.parse(iso);

function ics(...events) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'X-WR-CALNAME:Dan',
    'X-WR-TIMEZONE:America/Los_Angeles',
    'BEGIN:VTIMEZONE',
    'TZID:America/Los_Angeles',
    'BEGIN:DAYLIGHT',
    'DTSTART:19700308T020000',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
    ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']),
    'END:VCALENDAR',
  ].join('\r\n');
}

const between = (text, from, to) =>
  eventsBetween(parseIcs(text), ms(from), ms(to), LA).map((x) => ({
    title: x.e.title,
    start: x.allDay ? x.start : new Date(x.start).toISOString(),
    end: x.allDay ? x.end : new Date(x.end).toISOString(),
  }));

test('parses folded lines, escapes, time zones and all-day events', () => {
  const text = ics(
    [
      'UID:a',
      'SUMMARY:Dentist\\, then lunch',
      'LOCATION:Main St',
      'DESCRIPTION:Line one\\nline two that is long enough to be',
      '  folded',
      'DTSTART;TZID=America/Los_Angeles:20261005T093000',
      'DTEND;TZID=America/Los_Angeles:20261005T103000',
      'BEGIN:VALARM',
      'SUMMARY:Alarm should be ignored',
      'END:VALARM',
    ],
    ['UID:b', 'SUMMARY:Trip', 'DTSTART;VALUE=DATE:20261006', 'DTEND;VALUE=DATE:20261009'],
    ['UID:c', 'SUMMARY:Call', 'DTSTART:20261005T200000Z', 'DURATION:PT45M'],
  );
  const cal = parseIcs(text);
  assert.equal(cal.name, 'Dan');
  assert.equal(cal.events[0].title, 'Dentist, then lunch');
  assert.equal(cal.events[0].description, 'Line one\nline two that is long enough to be folded');
  assert.deepEqual(between(text, '2026-10-05T00:00:00-07:00', '2026-10-12T00:00:00-07:00'), [
    { title: 'Dentist, then lunch', start: '2026-10-05T16:30:00.000Z', end: '2026-10-05T17:30:00.000Z' },
    { title: 'Trip', start: '2026-10-06', end: '2026-10-09' },
    { title: 'Call', start: '2026-10-05T20:00:00.000Z', end: '2026-10-05T20:45:00.000Z' },
  ]);
});

test('weekly recurrence keeps wall-clock time across DST, with exceptions and moved instances', () => {
  const text = ics(
    [
      'UID:standup',
      'SUMMARY:Standup',
      'DTSTART;TZID=America/Los_Angeles:20261020T090000',
      'DTEND;TZID=America/Los_Angeles:20261020T091500',
      'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261113T075959Z',
      'EXDATE;TZID=America/Los_Angeles:20261029T090000',
    ],
    [
      'UID:standup',
      'RECURRENCE-ID;TZID=America/Los_Angeles:20261105T090000',
      'SUMMARY:Standup (moved)',
      'DTSTART;TZID=America/Los_Angeles:20261105T130000',
      'DTEND;TZID=America/Los_Angeles:20261105T131500',
    ],
  );
  const got = between(text, '2026-10-01T00:00:00Z', '2026-11-30T00:00:00Z');
  assert.deepEqual(
    got.map((e) => `${e.title} ${e.start}`),
    [
      'Standup 2026-10-20T16:00:00.000Z',
      'Standup 2026-10-22T16:00:00.000Z',
      'Standup 2026-10-27T16:00:00.000Z',
      // 10-29 excluded; DST ends 11-01 so 9am becomes 17:00Z
      'Standup 2026-11-03T17:00:00.000Z',
      'Standup 2026-11-10T17:00:00.000Z',
      'Standup 2026-11-12T17:00:00.000Z',
      'Standup (moved) 2026-11-05T21:00:00.000Z',
    ],
  );
});

test('monthly by weekday, yearly birthdays, counts and intervals', () => {
  const text = ics(
    ['UID:m', 'SUMMARY:Book club', 'DTSTART;TZID=America/Los_Angeles:20260108T190000', 'RRULE:FREQ=MONTHLY;BYDAY=2TH'],
    ['UID:l', 'SUMMARY:Rent', 'DTSTART;VALUE=DATE:20260131', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1'],
    ['UID:y', 'SUMMARY:Birthday', 'DTSTART;VALUE=DATE:19900215', 'RRULE:FREQ=YEARLY'],
    ['UID:n', 'SUMMARY:PT', 'DTSTART;TZID=America/Los_Angeles:20260201T080000', 'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3'],
  );
  const got = between(text, '2026-02-01T00:00:00-08:00', '2026-03-01T00:00:00-08:00');
  assert.deepEqual(
    got.map((e) => `${e.title} ${e.start}`).sort(),
    [
      'Birthday 2026-02-15',
      'Book club 2026-02-13T03:00:00.000Z',
      'PT 2026-02-01T16:00:00.000Z',
      'PT 2026-02-03T16:00:00.000Z',
      'PT 2026-02-05T16:00:00.000Z',
      'Rent 2026-02-28',
    ],
  );
});

test('cancelled events and instances are dropped', () => {
  const text = ics(
    ['UID:x', 'SUMMARY:Gone', 'STATUS:CANCELLED', 'DTSTART:20261005T200000Z'],
    ['UID:w', 'SUMMARY:Weekly', 'DTSTART:20261005T200000Z', 'RRULE:FREQ=WEEKLY'],
    ['UID:w', 'RECURRENCE-ID:20261012T200000Z', 'STATUS:CANCELLED', 'DTSTART:20261012T200000Z'],
  );
  const got = between(text, '2026-10-01T00:00:00Z', '2026-10-20T00:00:00Z');
  assert.deepEqual(got.map((e) => e.start), ['2026-10-05T20:00:00.000Z', '2026-10-19T20:00:00.000Z']);
});

test('service merges calendars, hides URLs, caches and reports feed errors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pidisplay-cal-'));
  const configFile = path.join(dir, 'calendars.json');
  const svc0 = createCalendar({ configFile });
  const range = { from: ms('2026-10-05T00:00:00-07:00'), to: ms('2026-10-06T00:00:00-07:00'), tz: LA };
  assert.deepEqual(await svc0.get(range), { configured: false, calendars: [], events: [] });

  await fs.writeFile(
    configFile,
    JSON.stringify({
      calendars: [
        { name: 'Dan', color: '#ff0000', url: 'webcal://example.com/dan.ics' },
        { name: 'Sam', url: 'https://example.com/broken.ics' },
      ],
    }),
  );
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('broken')) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => ics(['UID:a', 'SUMMARY:Lunch', 'DTSTART:20261005T190000Z', 'DTEND:20261005T200000Z']) };
  };
  const svc = createCalendar({ configFile, fetchImpl });
  const res = await svc.get(range);
  assert.equal(res.configured, true);
  assert.deepEqual(res.calendars.map((c) => [c.name, c.color]), [['Dan', '#ff0000'], ['Sam', '#3ccf8e']]);
  assert.match(res.calendars[1].error, /not found/);
  assert.equal(res.events.length, 1);
  assert.equal(res.events[0].title, 'Lunch');
  assert.equal(res.events[0].calendar, res.calendars[0].id);
  assert.ok(!JSON.stringify(res).includes('example.com'), 'feed URLs must not be returned');
  assert.equal(calls[0], 'https://example.com/dan.ics');

  await svc.get(range);
  assert.equal(calls.length, 2, 'second request is served from cache');
  await assert.rejects(svc.get({ from: 0, to: 100 * 86_400_000 }), /At most/);
  await fs.rm(dir, { recursive: true, force: true });
});
