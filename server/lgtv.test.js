import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLgTv, defaultConnect, encodeFrame, frameReader, magicPacket, TvError } from './lgtv.js';

/** An unmasked frame, as a server sends it. */
function serverFrame(text, opcode = 0x1) {
  const data = Buffer.from(text);
  const head = data.length < 126 ? Buffer.from([0x80 | opcode, data.length]) : Buffer.from([0x80 | opcode, 126, data.length >> 8, data.length & 0xff]);
  return Buffer.concat([head, data]);
}

/** A stand-in LG TV speaking SSAP over plain ws on a random local port. */
async function fakeTv({ accept = true, key = 'KEY-1' } = {}) {
  const seen = [];
  const server = net.createServer((socket) => {
    let open = false;
    let head = '';
    const read = frameReader((opcode, payload) => {
      if (opcode !== 0x1) return;
      const msg = JSON.parse(payload.toString());
      seen.push(msg);
      const reply = (m) => socket.write(serverFrame(JSON.stringify(m)));
      if (msg.type === 'register') {
        if (msg.payload['client-key'] === key) return reply({ type: 'registered', id: msg.id, payload: { 'client-key': key } });
        reply({ type: 'response', id: msg.id, payload: { pairingType: 'PROMPT', returnValue: true } });
        if (accept) reply({ type: 'registered', id: msg.id, payload: { 'client-key': key } });
        else reply({ type: 'error', id: msg.id, error: '403 User denied access' });
      } else if (msg.uri === 'ssap://system/getSystemInfo') {
        // Long enough to need the 16-bit length form, split across two writes.
        const frame = serverFrame(JSON.stringify({ type: 'response', id: msg.id, payload: { returnValue: true, modelName: '55UA7700AUA', pad: 'x'.repeat(300) } }));
        socket.write(frame.subarray(0, 50));
        setTimeout(() => socket.write(frame.subarray(50)), 5);
      } else if (msg.uri === 'ssap://bad/call') {
        reply({ type: 'error', id: msg.id, error: '404 no such service' });
      } else reply({ type: 'response', id: msg.id, payload: { returnValue: true } });
    });
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (open) return read(chunk);
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      const wsKey = /sec-websocket-key:\s*(\S+)/i.exec(head)[1];
      const acceptKey = crypto.createHash('sha1').update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n\r\n`);
      open = true;
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // Nothing listens on the "wss" port, as on an old set; the client must fall back.
  return { seen, ports: { wss: 1, ws: port }, close: () => server.close() };
}

test('frames survive a round trip, including fragmented and masked ones', () => {
  const got = [];
  const read = frameReader((opcode, payload) => got.push([opcode, payload.toString()]));
  const long = 'é'.repeat(40000);
  const bytes = Buffer.concat([encodeFrame('hello'), encodeFrame(long), Buffer.from([0x01, 2]), Buffer.from('ab'), Buffer.from([0x80, 2]), Buffer.from('cd')]);
  for (let i = 0; i < bytes.length; i += 7001) read(bytes.subarray(i, i + 7001));
  assert.deepEqual(got.map(([o, p]) => [o, p.length]), [[1, 5], [1, 40000], [1, 4]]);
  assert.equal(got[1][1], long);
  assert.equal(got[2][1], 'abcd');
});

test('pairs with a TV over a real socket, then reconnects silently with the key', async () => {
  const tv = await fakeTv();
  try {
    const first = await defaultConnect('127.0.0.1', { ports: tv.ports });
    assert.equal(first.key, 'KEY-1');
    assert.equal(first.secure, false);
    assert.equal(tv.seen[0].payload.pairingType, 'PROMPT');
    assert.equal(tv.seen[0].payload['client-key'], undefined);
    assert.equal((await first.request('system/getSystemInfo')).modelName, '55UA7700AUA');
    await assert.rejects(first.request('bad/call'), /no such service/);
    first.close();

    const again = await defaultConnect('127.0.0.1', { key: 'KEY-1', secure: false, ports: tv.ports });
    assert.equal(tv.seen.at(-1).payload['client-key'], 'KEY-1');
    await again.request('system.launcher/launch', { id: 'spotify-beehive' });
    assert.deepEqual(tv.seen.at(-1).payload, { id: 'spotify-beehive' });
    again.close();
  } finally {
    tv.close();
  }
});

test('a refused prompt and an unreachable TV give plain errors', async () => {
  const tv = await fakeTv({ accept: false });
  try {
    await assert.rejects(defaultConnect('127.0.0.1', { ports: tv.ports }), /The TV said no/);
  } finally {
    tv.close();
  }
  await assert.rejects(defaultConnect('127.0.0.1', { ports: { wss: 1, ws: 1 } }), (err) => err instanceof TvError && err.status === 503);
});

test('magic packet is six FF bytes then the address sixteen times', () => {
  const p = magicPacket('AA:bb:cc:01:02:03');
  assert.equal(p.length, 102);
  assert.equal(p.subarray(0, 6).toString('hex'), 'ffffffffffff');
  assert.equal(p.subarray(96).toString('hex'), 'aabbcc010203');
});

/** createLgTv with a scripted TV: states is what each connect attempt finds. */
async function service({ refuseSet = false, states = ['Active'], apps = [{ id: 'spotify-beehive', title: 'Spotify' }], mac = 'aa:bb:cc:01:02:03' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pidisplay-lgtv-'));
  const log = [];
  let attempt = 0;
  const tv = createLgTv({
    configFile: path.join(dir, 'lgtv.json'),
    wait: async () => {},
    bootMs: 200,
    macOf: async () => mac,
    wake: async (m, ip) => void log.push(['wake', m, ip]),
    search: async ({ st }) => (st.includes('lge') ? ['http://192.168.1.50:1754/'] : ['http://192.168.1.50:1900/dd.xml', 'http://192.168.1.60:8008/dd.xml']),
    fetchImpl: async (url) =>
      new Response(
        url.includes('.60')
          ? '<root><friendlyName>Chromecast</friendlyName><manufacturer>Google</manufacturer></root>'
          : url.includes('1900')
            ? '<root><friendlyName>Living Room TV</friendlyName><manufacturer>LG Electronics</manufacturer><modelName>55UA7700AUA</modelName></root>'
            : '',
      ),
    connect: async (ip, opts) => {
      const state = states[Math.min(attempt++, states.length - 1)];
      log.push(['connect', ip, opts.key ?? null, state]);
      if (state === 'down') throw new TvError(503, "Can't reach the TV.");
      return {
        key: 'KEY-1',
        secure: true,
        close: () => {},
        request: async (uri, payload) => {
          log.push(['request', uri, payload]);
          if (uri.endsWith('getPowerState')) return { state };
          if (uri.endsWith('getSystemInfo')) return { modelName: '55UA7700AUA' };
          if (uri.endsWith('listLaunchPoints')) return { launchPoints: apps };
          if (uri === 'audio/getVolume') return { volumeStatus: { volume: 10 } };
          if (uri === 'audio/setVolume' && refuseSet) throw new TvError(500, 'volume is not adjustable');
          return {};
        },
      };
    },
  });
  return { tv, log, dir };
}

test('finds LG TVs only, with their names', async () => {
  const { tv } = await service();
  assert.deepEqual(await tv.find(), [{ ip: '192.168.1.50', name: 'Living Room TV', model: '55UA7700AUA' }]);
});

test('link saves the key privately and learns the address for waking', async () => {
  const { tv, dir } = await service();
  await assert.rejects(tv.link({ ip: 'tv.local' }), /address/);
  assert.deepEqual(await tv.link({ ip: '192.168.1.50', name: 'Living Room TV' }), { linked: true, name: 'Living Room TV', ip: '192.168.1.50', canWake: true });
  const file = path.join(dir, 'lgtv.json');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).key, 'KEY-1');
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await tv.unlink()).linked, false);
});

test('opens Spotify straight away when the TV is on', async () => {
  const { tv, log } = await service({ apps: [{ id: 'youtube.leanback.v4', title: 'YouTube' }, { id: 'spotify-beehive', title: 'Spotify - Music and Podcasts' }] });
  await assert.rejects(tv.openSpotify(), /No TV is linked/);
  await tv.link({ ip: '192.168.1.50' });
  log.length = 0;
  assert.equal((await tv.openSpotify()).ok, true);
  assert.equal(log.filter((l) => l[0] === 'wake').length, 0);
  assert.deepEqual(log.at(-1), ['request', 'system.launcher/launch', { id: 'spotify-beehive' }]);
});

test('wakes a TV that is off or in standby before opening Spotify', async () => {
  // Linked while on; then unreachable, then answering but still dark, then on.
  const { tv, log } = await service({ states: ['Active', 'down', 'down', 'Active Standby', 'Active'] });
  await tv.link({ ip: '192.168.1.50' });
  log.length = 0;
  await tv.openSpotify();
  assert.deepEqual(log.find((l) => l[0] === 'wake'), ['wake', 'aa:bb:cc:01:02:03', '192.168.1.50']);
  assert.equal(log.at(-1)[1], 'system.launcher/launch');
});

test('says how to enable waking when the TV never comes on, and when Spotify is missing', async () => {
  const off = await service({ states: ['Active', 'down'] });
  await off.tv.link({ ip: '192.168.1.50' });
  await assert.rejects(off.tv.openSpotify(), /Turn on via Wi-Fi/);

  const none = await service({ apps: [{ id: 'netflix', title: 'Netflix' }] });
  await none.tv.link({ ip: '192.168.1.50' });
  await assert.rejects(none.tv.openSpotify(), /no Spotify app/);
});

test('sets the TV volume, or presses volume up when the sound output refuses a set value', async () => {
  const plain = await service();
  await assert.rejects(plain.tv.setVolume(20), /No TV is linked/);
  await plain.tv.link({ ip: '192.168.1.50' });
  assert.deepEqual(await plain.tv.getVolume(), { volume: 10 });
  plain.log.length = 0;
  await plain.tv.setVolume(20);
  assert.deepEqual(plain.log.at(-1), ['request', 'audio/setVolume', { volume: 20 }]);

  const arc = await service({ refuseSet: true });
  await arc.tv.link({ ip: '192.168.1.50' });
  arc.log.length = 0;
  await arc.tv.setVolume(13);
  assert.equal(arc.log.filter((l) => l[1] === 'audio/volumeUp').length, 3);
});
