import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './server.js';
import { createSleep, inAwakeHours, parseInputDevices, DEFAULT_SETTINGS } from './sleep.js';

const at = (h, m = 0) => new Date(2026, 9, 3, h, m).getTime();

function fakes(start) {
  let t = start;
  const power = [];
  const events = [];
  let touch = () => {};
  const sleep = createSleep({
    now: () => t,
    tickMs: 60_000_000,
    broadcast: (e) => events.push(e),
    display: { setPower: async (on) => (power.push(on), null) },
    touch: { start: (fn) => (touch = fn), stop() {}, watching: 1 },
  });
  return {
    sleep,
    power,
    events,
    touch: () => touch(),
    set: (v) => (t = v),
    settle: () => new Promise((r) => setTimeout(r, 10)),
  };
}

test('awake hours default to 7 AM to 10 PM and can wrap midnight', () => {
  assert.equal(inAwakeHours(DEFAULT_SETTINGS, 6 * 60 + 59), false);
  assert.equal(inAwakeHours(DEFAULT_SETTINGS, 7 * 60), true);
  assert.equal(inAwakeHours(DEFAULT_SETTINGS, 21 * 60 + 59), true);
  assert.equal(inAwakeHours(DEFAULT_SETTINGS, 22 * 60), false);
  const night = { wakeAt: 20 * 60, sleepAt: 2 * 60 };
  assert.equal(inAwakeHours(night, 23 * 60), true);
  assert.equal(inAwakeHours(night, 60), true);
  assert.equal(inAwakeHours(night, 12 * 60), false);
});

test('"turn off now" sleeps until a touch, even in the day', async () => {
  const f = fakes(at(12, 0));
  f.sleep.start();
  await f.settle();
  assert.equal(f.sleep.asleep, false);

  await f.sleep.handle('POST', 'now');
  assert.equal(f.sleep.asleep, true);
  await f.settle();
  assert.deepEqual(f.power, [false]);

  f.touch();
  assert.equal(f.sleep.asleep, false);
  assert.equal(f.events.at(-1).reason, 'touch');
  await f.settle();
  assert.deepEqual(f.power, [false, true]);
  f.sleep.stop();
});

test('the schedule turns the screen off at night and back on in the morning', async () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));
  let clock = at(20, 0);
  const sleep = createSleep({
    now: () => clock,
    tickMs: 5,
    broadcast: () => {},
    display: { setPower: async () => null },
    touch: { start() {}, stop() {} },
  });
  sleep.start();
  await settle();
  assert.equal(sleep.asleep, false);
  clock = at(23, 0);
  await settle();
  assert.equal(sleep.asleep, true);
  sleep.wake('alarm');
  assert.equal(sleep.asleep, false);
  clock = at(23, 1);
  await settle();
  assert.equal(sleep.asleep, false, 'stays on for the night idle spell');
  clock = at(23, 3);
  await settle();
  assert.equal(sleep.asleep, true);
  clock = at(7, 0) + 24 * 3600_000;
  await settle();
  assert.equal(sleep.asleep, false);
  sleep.stop();
});

test('schedule off keeps the screen on at night; day idle turns it off', async () => {
  let clock = at(23, 0);
  const sleep = createSleep({
    now: () => clock,
    tickMs: 5,
    load: async () => ({ settings: { schedule: false, dayIdleMinutes: 10 } }),
    display: { setPower: async () => null },
    touch: { start() {}, stop() {} },
  });
  sleep.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sleep.asleep, false);
  clock = at(12, 0) + 86400_000;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sleep.asleep, true);
  sleep.stop();
});

test('settings are validated', async () => {
  const sleep = createSleep({ display: { setPower: async () => null }, touch: { start() {}, stop() {} } });
  await assert.rejects(sleep.handle('PUT', 'settings', { wakeAt: 2000 }), /wakeAt/);
  await assert.rejects(sleep.handle('PUT', 'settings', { nightIdleMinutes: 0 }), /nightIdleMinutes/);
  const s = await sleep.handle('PUT', 'settings', { wakeAt: 390, sleepAt: 1380, schedule: true });
  assert.equal(s.settings.wakeAt, 390);
  assert.equal(s.settings.sleepAt, 1380);
});

test('finds touchscreens and mice in /proc/bus/input/devices', () => {
  const text = `I: Bus=0003 Vendor=222a Product=0001 Version=0110
N: Name="ILITEK ILITEK-TP"
H: Handlers=mouse0 event4

I: Bus=0000 Vendor=0000 Product=0000 Version=0000
N: Name="vc4-hdmi-1"
H: Handlers=kbd event2
`;
  assert.deepEqual(parseInputDevices(text), [{ name: 'ILITEK ILITEK-TP', node: '/dev/input/event4' }]);
});

test('API: settings persist, sleep now, and a ringing timer wakes the screen', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pidisplay-sleep-'));
  const power = [];
  const sleep = createSleep({
    load: async () => JSON.parse(await fs.readFile(path.join(dataDir, 'sleep.json'), 'utf8').catch(() => 'null')),
    save: (v) => fs.writeFile(path.join(dataDir, 'sleep.json'), JSON.stringify(v)),
    display: { setPower: async (on) => (power.push(on), null) },
    touch: { start() {}, stop() {} },
  });
  const server = createServer({ dataDir, distDir: path.join(dataDir, 'dist'), sleep, timerTickMs: 20, stocksAutoStart: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  try {
    let r = await req('PUT', '/api/sleep/settings', { sleepAt: 23 * 60 });
    assert.equal(r.status, 200);
    assert.equal(r.data.settings.sleepAt, 23 * 60);
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'sleep.json'), 'utf8')).settings.sleepAt, 23 * 60);
    assert.equal((await req('PUT', '/api/sleep/settings', { wakeAt: -1 })).status, 400);

    r = await req('POST', '/api/sleep/now');
    assert.equal(r.data.asleep, true);

    await req('POST', '/api/timers', { durationMs: 1000 });
    for (let i = 0; i < 100 && sleep.asleep; i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(sleep.asleep, false, 'the ringing timer woke the screen');
    assert.deepEqual(power, [false, true]);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
