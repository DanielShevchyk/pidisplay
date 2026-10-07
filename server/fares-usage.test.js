import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { estimateUsage, eventUsage, openJawReturns } from './fares-usage.js';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const EXAMPLE = path.join(ROOT, 'farewatcher', 'config.example.json');
const example = () => JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
const today = new Date('2026-10-07T12:00:00Z');

// The coordinates fare_watch.py's open_jaw_returns() uses for these cities.
const COORDS = {
  TYO: [35.68, 139.69], SEL: [37.57, 126.98], LON: [51.51, -0.13], PAR: [48.86, 2.35], IST: [41.01, 28.98],
  WAW: [52.23, 21.01], SYD: [-33.87, 151.21], AKL: [-36.85, 174.76], YVR: [49.19, -123.18], AMS: [52.31, 4.76],
  MNL: [14.51, 121.02], MUC: [48.35, 11.79], FRA: [50.04, 8.56],
};
const coords = (c) => COORDS[c] ?? null;

test("today's config: 52 lookups plus open jaws, about 216 searches a month (amber)", () => {
  const est = estimateUsage(example(), { coords, today });
  assert.equal(est.travelpayouts.roundTrip, 52);
  assert.ok(est.travelpayouts.openJaw > 0);
  assert.equal(est.serpapi.dealChecks, 182);
  assert.equal(est.serpapi.eventChecks, 34);
  assert.equal(est.serpapi.worst, 216);
  assert.equal(est.serpapi.reserve, 10);
  assert.equal(est.serpapi.level, 'warn');
  assert.equal(est.serpapi.runsOutDay, null);
  assert.equal(est.serpapi.likely, null, 'no usage history yet');
});

test('more searches per run turns the meter red and says when it runs out', () => {
  const cfg = example();
  cfg.live_check.max_searches_per_run = 10;
  const est = estimateUsage(cfg, { coords, today });
  assert.equal(est.serpapi.level, 'over');
  // 304 deal + 34 event searches a month leave 240 usable: gone about 22 days in.
  assert.equal(est.serpapi.runsOutDay, 22);
});

test('turning live checks off leaves only the events', () => {
  const cfg = example();
  cfg.live_check.enabled = false;
  const est = estimateUsage(cfg, { coords, today });
  assert.equal(est.serpapi.dealChecks, 0);
  assert.equal(est.serpapi.worst, 34);
  assert.equal(est.serpapi.level, 'ok');
});

test('per-month queries multiply lookups by months ahead', () => {
  const cfg = example();
  cfg.trip.return_offset_months = 0;
  cfg.open_jaw.enabled = false;
  assert.equal(estimateUsage(cfg, { coords, today }).travelpayouts.perRun, 52 * 12);
});

test('events count from when Google opens the dates until departure', () => {
  const cfg = example();
  const ev = { name: 'X', dest: 'MUC', depart: '2026-12-01', target: 900 };
  assert.deepEqual(eventUsage(ev, cfg, today), { name: 'X', state: 'checking', opensOn: '2026-01-05', perMonth: 17, thisMonth: 17 });
  const past = eventUsage({ ...ev, depart: '2026-10-01' }, cfg, today);
  assert.equal(past.state, 'past');
  assert.equal(past.perMonth, 0);
  const soon = eventUsage({ ...ev, depart: '2027-09-17' }, cfg, today);
  assert.equal(soon.state, 'waiting');
  assert.equal(soon.opensOn, '2026-10-22');
  assert.ok(soon.thisMonth < soon.perMonth);
});

test('likely usage comes from what recent runs actually spent', () => {
  const runs = Array.from({ length: 10 }, (_, i) => ({
    startedAt: new Date(today.getTime() - (i + 1) * 86400000).toISOString(),
    travelpayouts: 72,
    seconds: 90,
    serpapi: 3,
    eventSearches: 1,
  }));
  const est = estimateUsage(example(), { coords, today, history: { runs } });
  assert.equal(est.serpapi.likely, Math.round(30.4 * 2) + 34);
  assert.equal(est.travelpayouts.seconds, Math.round(est.travelpayouts.perRun * 1.25));
});

test('open jaw return cities follow max_km', () => {
  const cfg = example();
  const near = openJawReturns(cfg, coords);
  assert.ok(near.FRA.includes('PAR'));
  assert.equal(near.TYO, undefined);
  cfg.open_jaw.max_km = 100;
  assert.deepEqual(openJawReturns(cfg, coords), {});
});

test('matches fare_watch.py --estimate', { skip: !hasPython() }, () => {
  const out = JSON.parse(
    execFileSync('python3', ['farewatcher/fare_watch.py', '--config', EXAMPLE, '--db', '/nonexistent/fares.db', '--estimate', 'json'], {
      cwd: ROOT,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }),
  );
  const js = estimateUsage(example(), { coords, today: new Date() });
  assert.equal(out.travelpayouts.perRun, js.travelpayouts.perRun);
  assert.equal(out.serpapi.dealChecks, js.serpapi.dealChecks);
  assert.equal(out.serpapi.eventChecks, js.serpapi.eventChecks);
  assert.equal(out.serpapi.level, js.serpapi.level);
});

function hasPython() {
  try {
    execFileSync('python3', ['--version']);
    return true;
  } catch {
    return false;
  }
}
