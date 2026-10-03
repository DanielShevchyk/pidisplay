import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize,
  stripFiller,
  parseDuration,
  parseClock,
  resolveClock,
  parseDay,
  parseRepeat,
  similarity,
  sayDuration,
  sayClock,
  sayDay,
  wordsToNumbers,
} from './voice-parse.js';

// Saturday, October 3 2026, 10:00 local time.
const NOW = new Date(2026, 9, 3, 10, 0).getTime();
const clean = (s) => stripFiller(normalize(s));

test('normalizes what the recognizer hears into plain words and digits', () => {
  assert.equal(clean('Set a timer for twenty-five minutes.'), 'set a timer for 25 minutes');
  assert.equal(clean('Hey Jarvis, what\'s the weather tomorrow?'), 'what is the weather tomorrow');
  assert.equal(clean('wake me up at seven thirty a m'), 'wake me up at 7 30 am');
  assert.equal(clean('Remind me at 5 P.M. to call Mom'), 'remind me at 5 pm to call mom');
  assert.equal(clean('could you please add milk, eggs, and bread to my list'), 'add milk and eggs and bread to my list');
  assert.equal(clean('set volume to 50%'), 'set volume to 50 percent');
  assert.equal(clean('Turn it up please'), 'turn it up');
  assert.equal(clean('alarm at 6:45PM'), 'alarm at 6:45 pm');
});

test('reads spoken numbers without merging clock times', () => {
  assert.equal(wordsToNumbers('one hundred and five minutes'), '105 minutes');
  assert.equal(wordsToNumbers('seven thirty'), '7 30');
  assert.equal(wordsToNumbers('ten forty five'), '10 45');
  assert.equal(wordsToNumbers('a thirty second timer'), 'a 30 second timer');
  assert.equal(wordsToNumbers('october twenty second'), 'october 22nd');
  assert.equal(wordsToNumbers('the first page'), 'the 1st page');
  assert.equal(wordsToNumbers('one second'), '1 second');
  assert.equal(wordsToNumbers('a couple of minutes'), '2 minutes');
});

test('finds durations, including halves and combinations', () => {
  const ms = (s) => parseDuration(normalize(s))?.ms ?? null;
  assert.equal(ms('ten minutes'), 600000);
  assert.equal(ms('an hour and a half'), 5400000);
  assert.equal(ms('one and a half hours'), 5400000);
  assert.equal(ms('half an hour'), 1800000);
  assert.equal(ms('1 hour 30 minutes'), 5400000);
  assert.equal(ms('two hours and fifteen minutes'), 8100000);
  assert.equal(ms('ninety seconds'), 90000);
  assert.equal(ms('a quarter of an hour'), 900000);
  assert.equal(ms('3 days'), 3 * 86400000);
  assert.equal(ms('set a timer'), null);
  // Separate lengths in one sentence don't add up.
  assert.equal(ms('in 10 minutes stretch for 5 minutes'), 600000);
});

test('finds clock times only where a time is meant', () => {
  const c = (s) => {
    const x = parseClock(normalize(s));
    return x && [x.hour, x.minute, x.meridiem];
  };
  assert.deepEqual(c('at 7 am'), [7, 0, 'am']);
  assert.deepEqual(c('at seven thirty pm'), [7, 30, 'pm']);
  assert.deepEqual(c('for 6:45'), [6, 45, null]);
  assert.deepEqual(c('at seven oh five'), [7, 5, null]);
  assert.deepEqual(c('quarter to eight'), [7, 45, null]);
  assert.deepEqual(c('half past six in the evening'), [6, 30, 'pm']);
  assert.deepEqual(c('at noon'), [12, 0, 'pm']);
  assert.deepEqual(c('midnight'), [0, 0, 'am']);
  assert.deepEqual(c('at 9 oclock'), [9, 0, null]);
  assert.deepEqual(c('at 9 tonight'), [9, 0, 'pm']);
  assert.deepEqual(c('at 17 30'), [17, 30, null]);
  assert.equal(c('set volume to 5'), null);
  assert.equal(c('timer for 10 minutes'), null);
  assert.equal(c('add 3 eggs'), null);
});

test('resolves a time to its next occurrence', () => {
  const at = (s, day = null) => resolveClock(parseClock(normalize(s)), NOW, day);
  // At 10 AM, "7" means 7 PM today, "11" means 11 AM today.
  assert.equal(at('at 7').getHours(), 19);
  assert.equal(at('at 11').getHours(), 11);
  assert.equal(at('at 7 am').getDate(), 4);
  // On a named day, a missing am/pm is a daytime guess.
  const tomorrow = new Date(2026, 9, 4);
  assert.equal(at('at 8', tomorrow).getHours(), 8);
  assert.equal(at('at 3', tomorrow).getHours(), 15);
});

test('finds days', () => {
  const d = (s) => parseDay(normalize(s), NOW)?.date.toDateString() ?? null;
  assert.equal(d('today'), 'Sat Oct 03 2026');
  assert.equal(d('tomorrow morning'), 'Sun Oct 04 2026');
  assert.equal(d('the day after tomorrow'), 'Mon Oct 05 2026');
  assert.equal(d('on friday'), 'Fri Oct 09 2026');
  assert.equal(d('saturday'), 'Sat Oct 03 2026');
  assert.equal(d('next saturday'), 'Sat Oct 10 2026');
  assert.equal(d('on october twenty second'), 'Thu Oct 22 2026');
  assert.equal(d('the 5th of november'), 'Thu Nov 05 2026');
  assert.equal(d('january 2nd'), 'Sat Jan 02 2027');
  assert.equal(d('february 30th'), null);
  assert.equal(d('every friday'), null);
  assert.equal(parseDay('tonight', NOW).part, 'night');
});

test('finds repeats', () => {
  const r = (s) => {
    const x = parseRepeat(normalize(s));
    return x && [x.repeat, x.interval, x.days];
  };
  assert.deepEqual(r('every day'), ['daily', 1, []]);
  assert.deepEqual(r('every weekday'), ['weekly', 1, [1, 2, 3, 4, 5]]);
  assert.deepEqual(r('on weekends'), ['weekly', 1, [0, 6]]);
  assert.deepEqual(r('every monday and thursday'), ['weekly', 1, [1, 4]]);
  assert.deepEqual(r('on tuesdays'), ['weekly', 1, [2]]);
  assert.deepEqual(r('every other week'), ['weekly', 2, []]);
  assert.deepEqual(r('every 3 days'), ['daily', 3, []]);
  assert.deepEqual(r('monthly'), ['monthly', 1, []]);
  assert.deepEqual(r('every morning'), ['daily', 1, []]);
  assert.equal(r('on tuesday'), null);
});

test('matches names loosely', () => {
  assert.equal(similarity('grocery', 'Groceries'), 1);
  assert.equal(similarity('to do', 'To-do'), 1);
  assert.ok(similarity('my chill playlist', 'Chill') >= 0.9);
  assert.ok(similarity('pasta', 'tea') < 0.5);
});

test('says times and lengths naturally', () => {
  assert.equal(sayDuration(3900000), '1 hour and 5 minutes');
  assert.equal(sayDuration(150000), '2 minutes and 30 seconds');
  assert.equal(sayDuration(1000), '1 second');
  assert.equal(sayClock(new Date(2026, 9, 3, 19, 5)), '7:05 PM');
  assert.equal(sayClock(new Date(2026, 9, 3, 0, 0)), '12 AM');
  assert.equal(sayDay(new Date(2026, 9, 4), NOW), 'tomorrow');
  assert.equal(sayDay(new Date(2026, 9, 6), NOW), 'Tuesday');
  assert.equal(sayDay(new Date(2026, 9, 20), NOW), 'Tuesday, October 20');
});
