import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFaresConfig, applyChanges, editableView, FaresConfigError } from './fares-config.js';

const EXAMPLE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'farewatcher', 'config.example.json');
let dir, configFile, calls, summary, clock, settings;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fares-config-'));
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function fresh() {
  configFile = path.join(dir, `config-${Math.random().toString(16).slice(2)}.json`);
  const cfg = JSON.parse(await fs.readFile(EXAMPLE, 'utf8'));
  cfg.notify.ntfy_topic = 'secret-topic';
  await fs.writeFile(configFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  calls = [];
  summary = null;
  clock = Date.parse('2026-10-07T12:00:00Z');
  settings = createFaresConfig({
    configFile,
    historyDir: path.join(dir, `history-${path.basename(configFile)}`),
    summaryFile: path.join(dir, 'farewatcher.json'),
    readSummary: async () => summary,
    exec: async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (args[0] === 'is-active') return { ok: false, stdout: 'inactive\n', stderr: '' };
      return { ok: true, stdout: '', stderr: '' };
    },
    now: () => clock,
  });
  return cfg;
}

test('the editable view leaves out secrets and email settings', async () => {
  await fresh();
  const { config, versions } = await settings.get();
  assert.equal(versions, 0);
  assert.deepEqual(Object.keys(config.notify), ['urgent_below_target', 'high_below_target']);
  assert.equal(JSON.stringify(config).includes('secret-topic'), false);
  assert.equal('travelpayouts_token' in config, false);
  assert.equal(config.destinations.TYO, 750);
  assert.equal(config.live_check.max_searches_per_run, 6);
});

test('saving merges into config.json and keeps notes, secrets and permissions', async () => {
  await fresh();
  const { config } = await settings.get();
  config.destinations.LIS = 700;
  delete config.destinations.MNL;
  config.live_check.max_searches_per_run = 4;
  const saved = await settings.save({ destinations: config.destinations, live_check: config.live_check });
  assert.equal(saved.versions, 1);
  assert.equal(saved.config.destinations.LIS, 700);

  const onDisk = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(onDisk.destinations.LIS, 700);
  assert.equal('MNL' in onDisk.destinations, false);
  assert.equal(onDisk.live_check.max_searches_per_run, 4);
  assert.equal(onDisk.notify.ntfy_topic, 'secret-topic');
  assert.ok(onDisk._destinations_note);
  assert.ok(onDisk.live_check._confirm_note, 'notes inside a section survive');
  assert.equal((await fs.stat(configFile)).mode & 0o777, 0o600);
  // The summary is rewritten from fares.db only when fare_watch.py is next to the config.
  assert.equal(saved.refreshed, false);
});

test('undo puts back the previous version', async () => {
  await fresh();
  await settings.save({ months_ahead: 3 });
  clock += 1000;
  await settings.save({ months_ahead: 9 });
  let back = await settings.undo();
  assert.equal(back.config.months_ahead, 3);
  back = await settings.undo();
  assert.equal(back.config.months_ahead, 12);
  await assert.rejects(settings.undo(), (e) => e instanceof FaresConfigError && e.status === 404);
});

test('bad settings are refused with a readable message', () => {
  const cfg = { origins: ['SFO'], destinations: { TYO: 700 } };
  const refuse = (changes, re) => assert.throws(() => applyChanges(cfg, changes), (e) => e.status === 400 && re.test(e.message));
  refuse({ destinations: {} }, /at least one destination/);
  refuse({ destinations: { TOKYO: 700 } }, /3-letter/);
  refuse({ destinations: { TYO: 10 } }, /between 50/);
  refuse({ origins: [] }, /at least 1/);
  refuse({ ntfy_topic: 'x' }, /can't be changed/);
  refuse(
    { events: [{ name: 'Trip', dest: 'MUC', depart: '2027-09-20', return: '2027-09-10', target: 900 }] },
    /return must be after/,
  );
  refuse({ open_jaw: { ...editableView(cfg).open_jaw, nights: [21, 5] } }, /range/);
  refuse({ live_check: { ...editableView(cfg).live_check, max_searches_per_run: 50 } }, /between 0 and 20/);
});

test('notify only takes the priority thresholds, never the topic', () => {
  const cfg = { origins: ['SFO'], destinations: { TYO: 700 }, notify: { ntfy_topic: 'keep' } };
  const next = applyChanges(cfg, { notify: { urgent_below_target: 0.3, high_below_target: 0.1, ntfy_topic: 'evil' } });
  assert.equal(next.notify.ntfy_topic, 'keep');
  assert.equal(next.notify.urgent_below_target, 0.3);
});

test('check now starts the service, but not twice within an hour', async () => {
  await fresh();
  assert.deepEqual(await settings.checkNow(), { started: true });
  assert.ok(calls.includes('systemctl start --no-block fare_watch.service'));

  summary = { lastRun: { startedAt: new Date(clock - 20 * 60000).toISOString() } };
  await assert.rejects(settings.checkNow(), (e) => e.status === 429 && /40 min/.test(e.message));
  summary = { lastRun: { startedAt: new Date(clock - 2 * 3600000).toISOString() } };
  assert.deepEqual(await settings.checkNow(), { started: true });
});

test('a missing config says Farewatcher is not set up', async () => {
  const s = createFaresConfig({ configFile: path.join(dir, 'nope.json'), historyDir: dir, readSummary: async () => null });
  await assert.rejects(s.get(), (e) => e.status === 503);
});
