import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAudio, describeSink, hdmiPort } from './audio.js';

// Trimmed from `pactl -f json list sinks` on a Pi 4 with PipeWire.
const SINKS = [
  {
    index: 46,
    name: 'alsa_output.platform-fef00700.hdmi.hdmi-stereo',
    description: 'Built-in Audio Digital Stereo (HDMI)',
    mute: false,
    volume: { 'front-left': { value_percent: '100%' }, 'front-right': { value_percent: '100%' } },
    properties: { 'alsa.card_name': 'vc4-hdmi-0', 'device.bus': 'platform' },
  },
  {
    index: 47,
    name: 'alsa_output.platform-fef05700.hdmi.hdmi-stereo',
    description: 'Built-in Audio Digital Stereo (HDMI)',
    mute: false,
    volume: { 'front-left': { value_percent: '80%' }, 'front-right': { value_percent: '80%' } },
    properties: { 'alsa.card_name': 'vc4-hdmi-1', 'device.bus': 'platform' },
  },
  {
    index: 48,
    name: 'alsa_output.platform-bcm2835_audio.stereo-fallback',
    description: 'Built-in Audio Stereo',
    mute: true,
    volume: { mono: { value_percent: '40%' } },
    properties: { 'alsa.card_name': 'bcm2835 Headphones' },
  },
  {
    index: 60,
    name: 'bluez_output.11_22_33_44_55_66.1',
    description: 'JBL Flip 6',
    mute: false,
    volume: { 'front-left': { value_percent: '50%' }, 'front-right': { value_percent: '52%' } },
    properties: { 'device.bus': 'bluetooth', 'device.description': 'JBL Flip 6' },
  },
];

async function drm(ports) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pidisplay-drm-'));
  for (const [port, connected] of Object.entries(ports)) {
    await fs.mkdir(path.join(dir, `card1-HDMI-A-${port}`));
    await fs.writeFile(path.join(dir, `card1-HDMI-A-${port}`, 'status'), connected ? 'connected\n' : 'disconnected\n');
  }
  return dir;
}

function fakePactl(defaultSink = 'alsa_output.platform-fef05700.hdmi.hdmi-stereo') {
  const calls = [];
  let current = defaultSink;
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args.join(' ') === '-f json list sinks') return JSON.stringify(SINKS);
    if (args.join(' ') === '-f json list sink-inputs') return JSON.stringify([{ index: 90 }, { index: 91 }]);
    if (args[0] === 'get-default-sink') return `${current}\n`;
    if (args[0] === 'set-default-sink') current = args[1];
    return '';
  };
  return { run, calls };
}

test('hdmiPort maps Pi 4 cards to kernel connectors', () => {
  assert.equal(hdmiPort('x', 'vc4-hdmi-0'), 1);
  assert.equal(hdmiPort('x', 'vc4-hdmi-1'), 2);
  assert.equal(hdmiPort('alsa_output.platform-fef05700.hdmi.hdmi-stereo'), 2);
  assert.equal(hdmiPort('something-else'), null);
});

test('labels outputs by what they are', () => {
  const ports = { 1: false, 2: true };
  assert.equal(describeSink(SINKS[1], ports).label, 'Display speakers');
  assert.equal(describeSink(SINKS[0], ports).label, 'HDMI 1 (no screen)');
  assert.deepEqual(describeSink(SINKS[2], ports), {
    name: SINKS[2].name, label: 'Headphone jack', kind: 'analog', volume: 40, muted: true,
  });
  const bt = describeSink(SINKS[3], ports);
  assert.equal(bt.kind, 'bluetooth');
  assert.equal(bt.label, 'JBL Flip 6');
  assert.equal(bt.volume, 51);
});

test('status lists outputs with the default marked, Bluetooth first', async () => {
  const { run } = fakePactl();
  const audio = createAudio({ run, platform: 'linux', drmDir: await drm({ 1: false, 2: true }) });
  const s = await audio.status();
  assert.equal(s.available, true);
  assert.deepEqual(s.outputs.map((o) => o.kind), ['bluetooth', 'hdmi', 'analog']);
  assert.equal(s.outputs.find((o) => o.active).label, 'Display speakers');
});

test('select switches the default and moves playing streams', async () => {
  const { run, calls } = fakePactl();
  const audio = createAudio({ run, platform: 'linux', drmDir: await drm({ 2: true }) });
  const s = await audio.select('bluez_output.11_22_33_44_55_66.1');
  assert.equal(s.outputs.find((o) => o.active).kind, 'bluetooth');
  const moves = calls.filter((c) => c[1] === 'move-sink-input').map((c) => c[2]);
  assert.deepEqual(moves, ['90', '91']);
  await assert.rejects(audio.select('bluez_output.gone'), /not connected/);
});

test('volume is validated and unmutes', async () => {
  const { run, calls } = fakePactl();
  const audio = createAudio({ run, platform: 'linux', drmDir: await drm({}) });
  await assert.rejects(audio.setVolume(SINKS[2].name, 140), /0 to 100/);
  await audio.setVolume(SINKS[2].name, 35);
  assert.deepEqual(calls.filter((c) => c[1].startsWith('set-sink')).map((c) => c.slice(1)), [
    ['set-sink-volume', SINKS[2].name, '35%'],
    ['set-sink-mute', SINKS[2].name, '0'],
  ]);
});

test('off the Pi it reports unavailable', async () => {
  const audio = createAudio({ platform: 'win32' });
  assert.deepEqual(await audio.status(), { available: false, outputs: [] });
  await assert.rejects(audio.select('x'), (err) => err.status === 501);
});

test('a missing pactl gives a redeploy hint', async () => {
  const run = async () => {
    throw Object.assign(new Error('spawn pactl ENOENT'), { code: 'ENOENT' });
  };
  const audio = createAudio({ run, platform: 'linux', drmDir: await drm({}) });
  await assert.rejects(audio.status(), /Redeploy/);
});
