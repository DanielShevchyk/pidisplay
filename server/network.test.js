import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNetwork, splitTerse } from './network.js';

/** Fake command runner: answers from a table of `cmd args...` prefixes and records calls. */
function fakeRun(table) {
  const calls = [];
  const run = async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    for (const [prefix, answer] of table) {
      if (line.startsWith(prefix)) {
        const value = typeof answer === 'function' ? answer(line) : answer;
        if (value instanceof Error) throw value;
        return value;
      }
    }
    throw new Error(`unexpected command: ${line}`);
  };
  return { run, calls };
}

const home = 'aaaa-home';
let saved = [`Home Net:${home}:802-11-wireless`, 'lo:bbbb:loopback'];
const wifiTable = () => [
  ['nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device', 'wlan0:wifi:connected:Home Net\nlo:loopback:connected (externally):lo\n'],
  ['nmcli radio wifi', 'enabled\n'],
  ['nmcli -t -f NAME,UUID,TYPE connection show', () => saved.join('\n')],
  [`nmcli -t -g 802-11-wireless.ssid connection show uuid ${home}`, 'Home Net\n'],
  ['nmcli -t -g 802-11-wireless.ssid connection show uuid', 'Cafe\\:Guest\n'],
  ['nmcli -t -f NAME,UUID,DEVICE connection show --active', `Home Net:${home}:wlan0\nlo:bbbb:lo\n`],
  [
    'nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list',
    '*:Home Net:70:WPA2\n :Home Net:40:WPA2\n :Cafe\\:Guest:55:\n ::30:WPA2\n :Neighbor:80:WPA1 WPA2\n',
  ],
  ['nmcli -t -g IP4.ADDRESS device show wlan0', '192.168.1.20/24\n'],
];

test('splitTerse handles escaped colons and backslashes', () => {
  assert.deepEqual(splitTerse('a\\:b:c\\\\d:'), ['a:b', 'c\\d', '']);
});

test('wifi status merges scan results with saved networks', async () => {
  saved = [`Home Net:${home}:802-11-wireless`, 'lo:bbbb:loopback'];
  const { run } = fakeRun(wifiTable());
  const { wifi } = createNetwork({ run, platform: 'linux' });
  const s = await wifi.status();
  assert.equal(s.available, true);
  assert.deepEqual(s.current, { ssid: 'Home Net', uuid: home, ip: '192.168.1.20', signal: 70 });
  assert.deepEqual(
    s.networks.map((n) => [n.ssid, n.signal, n.secure, n.saved, n.inUse]),
    [
      ['Home Net', 70, true, true, true],
      ['Neighbor', 80, true, false, false],
      ['Cafe:Guest', 55, false, false, false],
    ],
  );
});

test('a failed connect removes the new profile and returns to the old network', async () => {
  saved = [`Home Net:${home}:802-11-wireless`];
  const table = [
    [
      'nmcli --wait 45 device wifi connect Neighbor',
      () => {
        saved.push('Neighbor:cccc-new:802-11-wireless');
        return new Error('Error: Connection activation failed: Secrets were required, but not provided.');
      },
    ],
    ['nmcli -t -g 802-11-wireless.ssid connection show uuid cccc-new', 'Neighbor\n'],
    ['nmcli connection delete uuid cccc-new', () => ((saved = saved.filter((l) => !l.includes('cccc-new'))), '')],
    ['nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device', 'wlan0:wifi:disconnected:\n'],
    [`nmcli --wait 45 connection up uuid ${home}`, ''],
    ...wifiTable(),
  ];
  const { run, calls } = fakeRun(table);
  // First device lookup sees the old connection; later ones see wlan0 dropped.
  let first = true;
  const wrapped = async (cmd, args) => {
    if (first && args.join(' ') === '-t -f DEVICE,TYPE,STATE,CONNECTION device') {
      first = false;
      return 'wlan0:wifi:connected:Home Net\n';
    }
    return run(cmd, args);
  };
  const { wifi: w } = createNetwork({ run: wrapped, platform: 'linux' });
  await assert.rejects(w.connect('Neighbor', 'wrongpass'), { status: 400, message: /Wrong password/ });
  assert.ok(calls.includes('nmcli connection delete uuid cccc-new'));
  assert.ok(calls.some((c) => c.startsWith(`nmcli --wait 45 connection up uuid ${home}`)));
});

test('wifi is reported unavailable off the Pi', async () => {
  const { wifi, bluetooth } = createNetwork({ run: async () => assert.fail('no commands'), platform: 'win32' });
  assert.deepEqual(await wifi.status(), { available: false });
  assert.deepEqual(await bluetooth.status(), { available: false });
});

test('bluetooth status lists named and paired devices, paired first', async () => {
  const { run } = fakeRun([
    ['bluetoothctl show', 'Controller DC:A6:32:08:56:55 (public)\n\tPowered: yes\n'],
    ['bluetoothctl devices', 'Device 11:11:11:11:11:11 Speaker\nDevice 22:22:22:22:22:22 22-22-22\nDevice 33:33:33:33:33:33 Keyboard\n'],
    ['bluetoothctl info 11:11:11:11:11:11', '\tName: Speaker\n\tIcon: audio-card\n\tPaired: no\n\tConnected: no\n'],
    ['bluetoothctl info 22:22:22:22:22:22', '\tPaired: no\n\tConnected: no\n'],
    ['bluetoothctl info 33:33:33:33:33:33', '\tName: Keyboard\n\tIcon: input-keyboard\n\tPaired: yes\n\tTrusted: yes\n\tConnected: yes\n'],
  ]);
  const { bluetooth } = createNetwork({ run, platform: 'linux' });
  const s = await bluetooth.status();
  assert.equal(s.powered, true);
  assert.deepEqual(
    s.devices.map((d) => [d.name, d.paired, d.connected]),
    [
      ['Keyboard', true, true],
      ['Speaker', false, false],
    ],
  );
});

test('bluetooth actions reject malformed addresses', async () => {
  const { bluetooth } = createNetwork({ run: async () => assert.fail('no commands'), platform: 'linux' });
  await assert.rejects(bluetooth.pair('11:22; rm -rf /'), { status: 400 });
});
