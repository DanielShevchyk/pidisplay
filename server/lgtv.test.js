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
  const pointer = [];
  let port = 0;
  const server = net.createServer((socket) => {
    let open = false;
    let head = '';
    let isPointer = false;
    const read = frameReader((opcode, payload) => {
      if (opcode !== 0x1) return;
      // The pointer socket takes plain "type:button\nname:UP\n\n" messages.
      if (isPointer) return void pointer.push(payload.toString());
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
      } else if (msg.uri === 'ssap://com.webos.service.networkinput/getPointerInputSocket') {
        // A host name that doesn't resolve: the client must use the TV's own address.
        reply({ type: 'response', id: msg.id, payload: { returnValue: true, socketPath: `ws://tv.invalid:${port}/resources/abc123/netinput.pointer.sock` } });
      } else if (msg.uri === 'ssap://audio/getVolume') {
        reply({ type: 'response', id: msg.id, payload: { returnValue: true, volumeStatus: { volume: 12, muteStatus: false } } });
      } else if (msg.uri === 'ssap://bad/call') {
        reply({ type: 'error', id: msg.id, error: '404 no such service' });
      } else reply({ type: 'response', id: msg.id, payload: { returnValue: true } });
    });
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (open) return read(chunk);
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      isPointer = /^GET \/resources\/abc123\/netinput\.pointer\.sock /.test(head);
      const wsKey = /sec-websocket-key:\s*(\S+)/i.exec(head)[1];
      const acceptKey = crypto.createHash('sha1').update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n\r\n`);
      open = true;
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const sockets = new Set();
  server.on('connection', (c) => (sockets.add(c), c.on('close', () => sockets.delete(c))));
  // Nothing listens on the "wss" port, as on an old set; the client must fall back.
  return {
    seen,
    pointer,
    ports: { wss: 1, ws: port },
    /** How many connections are open right now (SSAP plus pointer). */
    openCount: () => sockets.size,
    close: () => (sockets.forEach((c) => c.destroy()), server.close()),
  };
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
async function service({ refuseSet = false, output = 'tv_speaker', states = ['Active'], apps = [{ id: 'spotify-beehive', title: 'Spotify' }], mac = 'aa:bb:cc:01:02:03', deny = [], stale = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pidisplay-lgtv-'));
  const log = [];
  let attempt = 0;
  let level = 10;
  const tv = createLgTv({
    configFile: path.join(dir, 'lgtv.json'),
    wait: async () => {},
    bootMs: 200,
    openPointer: async (host, port, opts) => {
      log.push(['pointer-open', host, port, opts.path]);
      return { closed: false, send: (text) => log.push(['pointer', text]), close: () => {} };
    },
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
      let calls = 0;
      const session = {
        key: 'KEY-1',
        secure: true,
        closed: false,
        close: () => {},
        request: async (uri, payload) => {
          log.push(['request', uri, payload]);
          // A session the TV dropped quietly: its second request finds it gone.
          if (stale && ++calls > 1 && attempt === 2) {
            session.closed = true;
            throw new TvError(503, 'The TV closed the connection.');
          }
          if (deny.includes(uri)) throw new TvError(502, 'The TV answered: 401 insufficient permissions');
          if (uri.endsWith('getPointerInputSocket')) return { socketPath: 'wss://192.168.1.50:3001/resources/abc/netinput.pointer.sock' };
          if (uri.endsWith('getForegroundAppInfo')) return { appId: 'netflix' };
          if (uri.endsWith('getExternalInputList')) return { devices: [{ id: 'HDMI_1', label: 'PlayStation', icon: 'http://192.168.1.50:3000/hdmi.png', connected: true }] };
          if (uri.endsWith('getPowerState')) return { state };
          if (uri.endsWith('getSystemInfo')) return { modelName: '55UA7700AUA' };
          if (uri.endsWith('listLaunchPoints')) return { launchPoints: apps };
          if (uri === 'audio/getVolume') return { volumeStatus: { volume: level, soundOutput: output } };
          if (uri === 'audio/setVolume') {
            if (refuseSet) throw new TvError(500, 'volume is not adjustable');
            if (output === 'tv_speaker') level = payload.volume;
          }
          if (uri === 'audio/volumeUp') level++;
          if (uri === 'audio/volumeDown') level--;
          return {};
        },
      };
      return session;
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

test('sets the TV volume, or presses volume up when the sound output ignores a set level', async () => {
  const plain = await service();
  await assert.rejects(plain.tv.setVolume(20), /No TV is linked/);
  await plain.tv.link({ ip: '192.168.1.50' });
  assert.deepEqual(await plain.tv.getVolume(), { volume: 10, output: 'tv_speaker' });
  plain.log.length = 0;
  assert.equal((await plain.tv.setVolume(20)).volume, 20);
  assert.ok(plain.log.some((l) => l[1] === 'audio/setVolume'));
  assert.ok(!plain.log.some((l) => l[1] === 'audio/volumeUp'));

  const refused = await service({ refuseSet: true });
  await refused.tv.link({ ip: '192.168.1.50' });
  refused.log.length = 0;
  assert.equal((await refused.tv.setVolume(13)).volume, 13);
  assert.equal(refused.log.filter((l) => l[1] === 'audio/volumeUp').length, 3);

  // A soundbar on HDMI ARC: a set level is accepted and ignored, so it goes straight to presses.
  const arc = await service({ output: 'external_arc' });
  await arc.tv.link({ ip: '192.168.1.50' });
  arc.log.length = 0;
  assert.equal((await arc.tv.setVolume(6)).volume, 6);
  assert.ok(!arc.log.some((l) => l[1] === 'audio/setVolume'));
  assert.equal(arc.log.filter((l) => l[1] === 'audio/volumeDown').length, 4);
});

test('the remote keeps one session for a run of presses, sends keys over the pointer socket and closes when idle', async () => {
  const fake = await fakeTv();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pidisplay-lgtv-'));
  const tv = createLgTv({
    configFile: path.join(dir, 'lgtv.json'),
    connect: (ip, opts) => defaultConnect(ip, { ...opts, ports: fake.ports }),
    macOf: async () => null,
    idleMs: 150,
  });
  try {
    await tv.link({ ip: '127.0.0.1' });
    const registers = () => fake.seen.filter((m) => m.type === 'register').length;
    const before = registers();
    await tv.press({ action: 'key', key: 'up' });
    await tv.press({ action: 'key', key: 'ENTER' });
    await tv.press({ action: 'move', dx: 12.4, dy: -3 });
    await tv.press({ action: 'click' });
    assert.deepEqual(await tv.press({ action: 'volumeUp' }), { ok: true, volume: 12, muted: false, output: '', external: false });
    assert.equal(registers(), before + 1, 'one register for the whole run');
    // Arrive asynchronously; give the fake TV a moment.
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(fake.pointer, ['type:button\nname:UP\n\n', 'type:button\nname:ENTER\n\n', 'type:move\ndx:12\ndy:-3\ndown:0\n\n', 'type:click\n\n']);
    assert.ok(fake.seen.some((m) => m.uri === 'ssap://audio/volumeUp'));
    assert.equal(fake.openCount(), 2);

    // Idle: both sockets close; the next press opens them again.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fake.openCount(), 0);
    await tv.press({ action: 'key', key: 'BACK' });
    assert.equal(registers(), before + 2);
    const state = await tv.getState();
    assert.equal(state.on, true);
    assert.equal(state.volume, 12);
  } finally {
    tv.close();
    fake.close();
  }
});

test('remote state says off without waking the TV, and the power button wakes it', async () => {
  const { tv, log } = await service({ states: ['Active', 'down', 'down', 'down', 'Active'] });
  assert.deepEqual(await tv.getState(), { linked: false, name: null, canWake: false, on: false });
  await tv.link({ ip: '192.168.1.50', name: 'Living Room TV' });
  log.length = 0;
  const off = await tv.getState();
  assert.equal(off.on, false);
  assert.equal(log.filter((l) => l[0] === 'connect').length, 1, 'no retry for a TV that is simply off');
  assert.equal(log.filter((l) => l[0] === 'wake').length, 0);
  await assert.rejects(tv.press({ action: 'key', key: 'UP' }), /off or not answering/);

  await tv.press({ action: 'power', on: true });
  assert.ok(log.some((l) => l[0] === 'wake'));
  log.length = 0;
  const on = await tv.getState();
  assert.deepEqual({ on: on.on, appId: on.appId, volume: on.volume }, { on: true, appId: 'netflix', volume: 10 });
  assert.equal(log.filter((l) => l[0] === 'connect').length, 0, 'reuses the session the power button opened');

  await tv.press({ action: 'power', on: false });
  assert.ok(log.some((l) => l[1] === 'system/turnOff'));
  assert.equal((await tv.getState()).on, false);
  tv.close();
});

test('remote actions map to the TV calls, with checks on what comes in', async () => {
  const { tv, log } = await service({ apps: [{ id: 'netflix', title: 'Netflix', icon: 'http://192.168.1.50:3000/n.png' }, { id: 'x', title: 'Bad', icon: 'javascript:alert(1)' }, { title: 'no id' }] });
  await tv.link({ ip: '192.168.1.50' });
  log.length = 0;
  const call = async (body) => (await tv.press(body), log.filter((l) => l[0] === 'request').at(-1).slice(1));
  assert.deepEqual(await call({ action: 'channelUp' }), ['tv/channelUp', undefined]);
  assert.deepEqual(await call({ action: 'pause' }), ['media.controls/pause', undefined]);
  assert.deepEqual(await call({ action: 'launch', id: 'netflix' }), ['system.launcher/launch', { id: 'netflix' }]);
  assert.deepEqual(await call({ action: 'input', id: 'HDMI_1' }), ['tv/switchInput', { inputId: 'HDMI_1' }]);
  assert.deepEqual(await call({ action: 'mute', mute: true }), ['audio/setMute', { mute: true }]);
  assert.deepEqual(await call({ action: 'volume', percent: 30 }), ['audio/getVolume', undefined]);
  assert.ok(log.some((l) => l[1] === 'audio/setVolume' && l[2].volume === 30));
  assert.deepEqual(await call({ action: 'text', text: 'news', enter: true }), ['com.webos.ime/sendEnterKey', undefined]);
  await tv.press({ action: 'key', key: '7' });
  assert.deepEqual(log.find((l) => l[0] === 'pointer-open'), ['pointer-open', '192.168.1.50', 3001, '/resources/abc/netinput.pointer.sock']);
  assert.deepEqual(log.at(-1), ['pointer', 'type:button\nname:7\n\n']);
  await assert.rejects(tv.press({ action: 'key', key: 'POWER; rm' }), (err) => err.status === 400);
  await assert.rejects(tv.press({ action: 'warp' }), (err) => err.status === 400);
  await assert.rejects(tv.press({ action: 'volume', percent: 101 }), (err) => err.status === 400);
  assert.equal(log.filter((l) => l[0] === 'connect').length, 1, 'all on one session');

  const { apps, inputs } = await tv.getApps();
  assert.deepEqual(apps, [{ id: 'netflix', title: 'Netflix', icon: 'http://192.168.1.50:3000/n.png' }, { id: 'x', title: 'Bad', icon: null }]);
  assert.deepEqual(inputs, [{ id: 'HDMI_1', label: 'PlayStation', icon: 'http://192.168.1.50:3000/hdmi.png', connected: true }]);
  tv.close();
});

test('a stale session is replaced once, and missing permissions get a plain answer', async () => {
  const stale = await service({ stale: true, states: ['Active'] });
  await stale.tv.link({ ip: '192.168.1.50' });
  await stale.tv.press({ action: 'channelUp' });
  await stale.tv.press({ action: 'channelDown' });
  assert.equal(stale.log.filter((l) => l[0] === 'connect').length, 3, 'link, the remote session, then one fresh one');
  assert.equal(stale.log.filter((l) => l[1] === 'tv/channelDown').length, 2);
  stale.tv.close();

  const denied = await service({ deny: ['tv/channelUp'] });
  await denied.tv.link({ ip: '192.168.1.50' });
  await assert.rejects(denied.tv.press({ action: 'channelUp' }), (err) => err.status === 403 && /link it again/.test(err.message));
  denied.tv.close();
});

test('the remote steps the volume through an HDMI ARC soundbar instead of setting it', async () => {
  const { tv, log } = await service({ output: 'external_arc' });
  await tv.link({ ip: '192.168.1.50' });
  log.length = 0;
  const set = await tv.press({ action: 'volume', percent: 14 });
  assert.equal(log.filter((l) => l[1] === 'audio/setVolume').length, 0);
  assert.equal(log.filter((l) => l[1] === 'audio/volumeUp').length, 4);
  assert.deepEqual({ volume: set.volume, external: set.external }, { volume: 14, external: true });
  assert.equal((await tv.press({ action: 'volumeDown' })).volume, 13);
  assert.equal(log.filter((l) => l[0] === 'connect').length, 1);
  tv.close();
});
