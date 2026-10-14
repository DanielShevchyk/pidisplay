import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVacuum, describe, mopWater, splitMode, withMode } from './vacuum.js';
import { DreameCloudError } from './dreame-cloud.js';
import { demoMapList, demoProps } from './vacuum.fixtures.js';

const ROBOT = { did: '42', model: 'dreame.vacuum.r2492', bindDomain: '10000.mt.us.iot.dreame.tech:19974', customName: '', deviceInfo: { displayName: 'L40 Ultra' } };

/** A fake Dreame cloud around a property table; records actions and settings. */
function fakeCloud({ props = demoProps(), devices = [ROBOT], authFail = false } = {}) {
  const log = [];
  const table = { ...props };
  const cloud = {
    log,
    table,
    async devices() {
      if (authFail) throw new DreameCloudError('Dreame refused the sign-in: Bad credentials', { auth: true });
      return devices;
    },
    async getProperties(device, pairs) {
      const out = {};
      for (const [s, p] of pairs) if (table[`${s}.${p}`] !== undefined) out[`${s}.${p}`] = table[`${s}.${p}`];
      return out;
    },
    async action(device, siid, aiid, input = []) {
      log.push(['action', siid, aiid, input]);
      return { code: 0 };
    },
    async setProperty(device, siid, piid, value) {
      log.push(['set', siid, piid, value]);
      table[`${siid}.${piid}`] = value;
      return { code: 0 };
    },
    async fileUrl(device, name) {
      return `https://oss.example/${name}`;
    },
    async download(url) {
      log.push(['download', url]);
      return Buffer.from(demoMapList());
    },
    close() {},
  };
  return cloud;
}

function setup(opts = {}) {
  const cloud = fakeCloud(opts);
  const saved = { value: opts.saved ?? null };
  const events = [];
  const notes = [];
  const vac = createVacuum({
    loadConfig: async () => (opts.config === undefined ? { username: 'dan@example.com', password: 'pw', region: 'us' } : opts.config),
    load: async () => saved.value,
    save: async (v) => {
      saved.value = structuredClone(v);
    },
    cloudFactory: () => cloud,
    broadcast: (s) => events.push(s),
    notify: (n) => notes.push(n),
    autoStart: false,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  return { vac, cloud, saved, events, notes };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('cleaning mode bits: low two bits only, everything else kept', () => {
  const v = (20 << 16) | (10 << 8) | 0;
  assert.deepEqual(splitMode(v), { mode: 0, wetness: 20 });
  assert.equal(withMode(v, 2), (20 << 16) | (10 << 8) | 2);
  assert.equal(withMode(2, 1), 1);
});

test('mop water level for room cleaning', () => {
  assert.equal(mopWater(3, null), 3);
  assert.equal(mopWater(20, null), 2);
  assert.equal(mopWater(30, null), 3);
  assert.equal(mopWater(4, null), 1);
  assert.equal(mopWater(5, 1), 1);
  assert.equal(mopWater(0, 1), 1);
  assert.equal(mopWater(0, null), 2);
});

test('describes what the robot is doing', () => {
  const docked = describe({ state: 6, status: 6, task: 0, charging: 1, battery: 92 });
  assert.equal(docked.phase, 'docked');
  assert.equal(docked.label, 'Charging');
  const cleaning = describe({ state: 12, status: 18, task: 3, charging: 2, cleaningTime: 23, cleanedArea: 31, progress: 46 });
  assert.equal(cleaning.phase, 'cleaning');
  assert.equal(cleaning.label, 'Vacuuming and mopping');
  assert.equal(cleaning.cleanedArea, 31);
  // Going back to wash the mops mid-clean is still part of the clean.
  assert.equal(describe({ state: 10, status: 2, task: 1 }).phase, 'cleaning');
  assert.equal(describe({ state: 3, status: 1, task: 8 }).phase, 'paused');
  assert.equal(describe({ state: 5, status: 3, task: 0 }).phase, 'returning');
  const err = describe({ state: 4, error: 106, task: 0 });
  assert.equal(err.phase, 'error');
  assert.equal(err.error.text, 'Empty the dirty water tank');
  assert.equal(describe({ state: 4, error: 9999, task: 0 }).error.text, 'Error 9999');
});

test('without an account it says so and makes no calls', async () => {
  const { vac, cloud } = setup({ config: null });
  const s = await vac.reload();
  assert.equal(s.configured, false);
  assert.equal(s.status, 'unconfigured');
  assert.equal(cloud.log.length, 0);
  await assert.rejects(vac.command({ command: 'start' }), /Add your Dreame account/);
});

test('connects, reads the robot and its rooms, and remembers them', async () => {
  const { vac, saved, events } = setup();
  const s = await vac.reload();
  assert.equal(s.status, 'ok');
  assert.deepEqual(s.device, { name: 'L40 Ultra', model: 'dreame.vacuum.r2492' });
  assert.equal(s.state.phase, 'docked');
  assert.equal(s.state.battery, 92);
  assert.equal(s.state.suction, 1);
  assert.equal(s.state.mode, 0);
  assert.deepEqual(s.state.parts, { mainBrush: 64, sideBrush: 41, filter: 77, mopPads: 55, sensors: 8 });
  await settle();
  const after = vac.snapshot();
  assert.equal(after.rooms.length, 5);
  assert.equal(after.hasMap, true);
  assert.equal(saved.value.device.did, '42');
  assert.equal(saved.value.rooms.rooms[2].name, "Dan's Office");
  assert.ok(events.length >= 2);
  // The account itself is never part of what screens get.
  assert.doesNotMatch(JSON.stringify(after), /dan@example\.com|"pw"/);
  const map = await vac.map();
  assert.equal(map.rooms.length, 5);
  assert.ok(map.pixels.length > 100);
});

test('rooms come back from the saved file after a restart, without a download', async () => {
  const first = setup();
  await first.vac.reload();
  await settle();
  const second = setup({ saved: first.saved.value });
  const s = await second.vac.reload();
  assert.equal(s.rooms.length, 5);
  assert.equal(second.cloud.log.filter((l) => l[0] === 'download').length, 0);
});

test('buttons send the right robot actions', async () => {
  const { vac, cloud } = setup();
  await vac.reload();
  for (const command of ['start', 'pause', 'resume', 'stop', 'dock', 'locate', 'empty', 'wash', 'dry']) await vac.command({ command });
  assert.deepEqual(cloud.log.filter((l) => l[0] === 'action').map((l) => [l[1], l[2], l[3]]), [
    [2, 1, []],
    [2, 2, []],
    [2, 1, []],
    [4, 2, []],
    [3, 1, []],
    [7, 1, []],
    [15, 1, []],
    [4, 4, [{ piid: 10, value: '2,1' }]],
    [4, 4, [{ piid: 10, value: '3,1' }]],
  ]);
});

test('room cleaning sends the selected rooms with the current suction and wetness', async () => {
  const { vac, cloud } = setup();
  await vac.reload();
  await settle();
  await vac.command({ command: 'rooms', rooms: [3, 1, 3] });
  const [, siid, aiid, input] = cloud.log.find((l) => l[0] === 'action');
  assert.deepEqual([siid, aiid], [4, 1]);
  assert.deepEqual(input, [
    { piid: 1, value: 18 },
    { piid: 10, value: '{"selects":[[3,1,1,2,1],[1,1,1,2,1]]}' },
  ]);
  await assert.rejects(vac.command({ command: 'rooms', rooms: [] }), /at least one room/);
  await assert.rejects(vac.command({ command: 'rooms', rooms: [9] }), /Unknown room/);
  await assert.rejects(vac.command({ command: 'rooms', rooms: [1], repeat: 5 }), /Repeat/);
});

test('suction and mode settings write the right properties', async () => {
  const { vac, cloud } = setup();
  await vac.reload();
  await vac.command({ command: 'suction', level: 3 });
  await vac.command({ command: 'mode', mode: 2 });
  assert.deepEqual(cloud.log.filter((l) => l[0] === 'set'), [
    ['set', 4, 4, 3],
    ['set', 4, 23, (20 << 16) | (10 << 8) | 2],
  ]);
  assert.equal(vac.snapshot().state.mode, 2);
  await assert.rejects(vac.command({ command: 'suction', level: 9 }), /Unknown suction/);
  await assert.rejects(vac.command({ command: 'mode', mode: 7 }), /Unknown cleaning mode/);
  await assert.rejects(vac.command({ command: 'selfdestruct' }), /Unknown command/);
});

test('a new robot problem rings the bell once', async () => {
  const { vac, cloud, notes } = setup();
  await vac.reload();
  Object.assign(cloud.table, demoProps('error'));
  await vac.refresh();
  await vac.refresh();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, 'L40 Ultra: Empty the dirty water tank');
});

test('a wrong password shows as a sign-in problem', async () => {
  const { vac } = setup({ authFail: true });
  const s = await vac.reload();
  assert.equal(s.status, 'signin');
  assert.match(s.problem, /Bad credentials/);
});

test('an account without a vacuum explains itself', async () => {
  const { vac } = setup({ devices: [{ did: '1', model: 'dreame.hold.w2' }] });
  const s = await vac.reload();
  assert.equal(s.status, 'error');
  assert.match(s.problem, /No robot vacuum/);
});

test('handle() routes the HTTP API', async () => {
  const { vac } = setup();
  await vac.reload();
  assert.equal((await vac.handle('GET', ['vacuum'], null)).status, 'ok');
  assert.equal((await vac.handle('POST', ['vacuum', 'command'], { command: 'dock' })).status, 'ok');
  await assert.rejects(vac.handle('DELETE', ['vacuum'], null), (err) => err.status === 404);
});
