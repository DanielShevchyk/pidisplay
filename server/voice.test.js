import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVoice } from './voice.js';
import { createTimers } from './timers.js';
import { createReminders } from './reminders.js';
import { createServer } from './server.js';

const HOUR = 3600000;
// Saturday, October 3 2026, 10:00 local time.
const START = new Date(2026, 9, 3, 10, 0).getTime();
const day = (n) => Math.floor(new Date(2026, 9, 3 + n).getTime() / 1000);

function weatherFixture() {
  return {
    location: { name: 'Citrus Heights', region: 'California', country: 'United States', lat: 38.7, lon: -121.3 },
    units: 'imperial',
    current: { temp: 72, feelsLike: 70, humidity: 40, wind: 5, code: 2, isDay: true },
    hourly: [11, 12, 13, 14, 15].map((h) => ({
      time: Math.floor(new Date(2026, 9, 3, h).getTime() / 1000),
      temp: 70,
      code: h === 15 ? 61 : 2,
      precipChance: h === 15 ? 60 : 10,
    })),
    daily: [0, 1, 2, 3, 4, 5, 6].map((i) => ({
      date: day(i),
      high: 80 + i,
      low: 55,
      code: i === 1 ? 63 : 1,
      precipChance: i === 1 ? 80 : 5,
      sunrise: Math.floor(new Date(2026, 9, 3 + i, 7, 5).getTime() / 1000),
      sunset: Math.floor(new Date(2026, 9, 3 + i, 18, 40).getTime() / 1000),
    })),
    airQuality: { aqi: 35, category: 'Good', uv: 4.2 },
  };
}

const running = [];
afterEach(() => {
  for (const x of running.splice(0)) x.stop();
});

function setup({ layout, spotifyConnected = true } = {}) {
  let t = START;
  const now = () => t;
  const store = new Map();
  const events = [];
  const timers = createTimers({ load: async () => null, save: async () => {}, notify() {}, broadcast() {}, now, tickMs: HOUR });
  const reminders = createReminders({ load: async () => null, save: async () => {}, notify() {}, broadcast() {}, sound() {}, now, tickMs: HOUR });
  running.push(timers, reminders);

  const calls = [];
  const spotify = {
    status: async () => ({ connected: spotifyConnected }),
    player: async () => ({
      player: { isPlaying: true, item: { name: 'Dreams', artists: ['Fleetwood Mac'] }, device: { name: 'PiDisplay' } },
      devices: [
        { id: 'pi', name: 'PiDisplay', active: true },
        { id: 'kitchen', name: 'Kitchen Speaker', active: false },
      ],
    }),
    control: async (action, body = {}) => calls.push(['spotify', action, body]),
    playlists: async () => [{ uri: 'spotify:playlist:chill', name: 'Chill Vibes' }],
    search: async (q) => ({
      tracks: [{ uri: 'spotify:track:hc', name: 'Hotel California', artists: ['Eagles'], albumUri: 'spotify:album:hc' }],
      artists: [{ uri: 'spotify:artist:fm', name: 'Fleetwood Mac' }],
      albums: [{ uri: 'spotify:album:rumours', name: 'Rumours', artists: ['Fleetwood Mac'] }],
      playlists: [{ uri: 'spotify:playlist:x', name: q }],
    }),
  };
  const outputs = [
    { name: 'hdmi', label: 'Display speakers', kind: 'hdmi', volume: 50, muted: false, active: true },
    { name: 'bt', label: 'JBL Flip', kind: 'bluetooth', volume: 40, muted: false, active: false },
  ];
  const audio = {
    supported: true,
    status: async () => ({ available: true, outputs: structuredClone(outputs) }),
    select: async (name) => {
      calls.push(['audio', 'select', name]);
      outputs.forEach((o) => (o.active = o.name === name));
    },
    setVolume: async (name, volume) => {
      calls.push(['audio', 'volume', name, volume]);
      outputs.find((o) => o.name === name).volume = volume;
    },
  };
  const voice = createVoice({
    timers,
    reminders,
    spotify,
    audio,
    stocks: {
      handle: async () => ({
        symbols: ['AAPL', 'MSFT'],
        marketOpen: true,
        quotes: {
          AAPL: { name: 'Apple Inc.', price: 231.5, changePct: 1.24, currency: 'USD' },
          MSFT: { name: 'Microsoft Corporation', price: 410.2, changePct: -0.5, currency: 'USD' },
        },
      }),
    },
    weather: { get: async (location) => (/atlantis/i.test(location) ? Promise.reject(Object.assign(new Error('nope'), { status: 404 })) : weatherFixture()) },
    news: {
      get: async ({ sections }) => ({
        sections: [{ id: sections, label: 'World', items: [{ title: 'Big news - Example Times', source: 'Example Times' }, { title: 'Other news', source: 'Wire' }] }],
      }),
    },
    calendar: {
      get: async ({ from }) => ({
        configured: true,
        calendars: [],
        events:
          Number(from) >= new Date(2026, 9, 4).getTime()
            ? []
            : [
                { title: 'Dentist', allDay: false, start: new Date(2026, 9, 3, 14, 0).getTime() },
                { title: 'Soccer', allDay: false, start: new Date(2026, 9, 3, 17, 30).getTime() },
              ],
      }),
    },
    system: { get: async () => ({ ip: '192.168.1.20', uptime: 7200, temperature: 51.6, cpu: { usage: 12 }, memory: { total: 4, used: 1 }, disk: { total: 10, used: 3 }, power: {} }) },
    readStore: async (key, fallback) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
    writeStore: async (key, value) => {
      store.set(key, structuredClone(value));
      events.push(['store', key]);
    },
    loadLayout: async () =>
      layout ?? {
        pages: [
          { id: 'home', name: 'Home', tiles: [{ widget: 'clock' }, { widget: 'weather', config: {} }] },
          { id: 'music', name: 'Music', tiles: [{ widget: 'spotify' }] },
          { id: 'lists', name: 'Lists', tiles: [{ widget: 'todo' }] },
        ],
        topBar: { left: [], right: [] },
      },
    notifications: { list: async () => [{ title: '⏱️ Tea is done', body: '', time: new Date(START - 60000).toISOString() }], clear: async () => events.push(['cleared']) },
    readFares: async () => ({ currency: 'USD', deals: [{ code: 'LAX', name: 'Los Angeles', origin: 'SMF', price: 148, departDate: '2026-11-12' }] }),
    broadcast: (event, data) => events.push([event, data]),
    now,
    watchMs: HOUR,
  });
  running.push(voice);
  const say = async (text) => (await voice.command(text)).reply;
  return {
    voice,
    say,
    run: (text) => voice.command(text),
    timers,
    reminders,
    store,
    calls,
    events,
    outputs,
    advance: (ms) => (t += ms),
  };
}

test('timers: set, ask, check, add, pause and cancel', async () => {
  const v = setup();
  assert.equal(await v.say('set a timer for ten minutes'), 'Timer set for 10 minutes.');
  assert.equal(await v.say('set a pasta timer for 8 minutes'), 'Pasta timer set for 8 minutes.');
  let s = await v.timers.handle('GET', ['timers'], null);
  assert.deepEqual(s.timers.map((x) => [x.label, x.durationMs]), [['', 600000], ['Pasta', 480000]]);

  v.advance(60000);
  assert.equal(await v.say('how much time is left'), 'You have 2 timers. The timer for 10 minutes has 9 minutes left and the pasta timer has 7 minutes left.');
  assert.equal(await v.say('add 5 minutes to the pasta timer'), 'Added 5 minutes.');
  assert.equal(await v.say('pause the pasta timer'), 'Paused the pasta timer.');

  // Two timers and no name: it asks which, and takes the answer.
  const r = await v.run('cancel the timer');
  assert.equal(r.expectReply, true);
  assert.match(r.reply, /^Which one\?/);
  assert.equal(await v.say('pasta'), 'Cancelled the pasta timer.');
  s = await v.timers.handle('GET', ['timers'], null);
  assert.equal(s.timers.length, 1);

  // No length: it asks for one.
  assert.equal((await v.run('start a timer')).reply, 'For how long?');
  assert.equal(await v.say('ninety seconds'), 'Timer set for 1 minute and 30 seconds.');
  assert.equal(await v.say('cancel all timers'), 'Cancelled all 2 timers.');
});

test('stop and snooze answer whatever is ringing', async () => {
  const v = setup();
  await v.say('set a timer for 1 minute');
  v.advance(61000);
  v.timers.tick();
  assert.equal(await v.say('stop'), 'OK.');
  assert.equal((await v.timers.handle('GET', ['timers'], null)).timers.length, 0);

  await v.say('set a tea timer for 1 minute');
  v.advance(61000);
  v.timers.tick();
  assert.equal(await v.say('snooze'), 'Snoozed for 9 minutes.');
  assert.equal((await v.timers.handle('GET', ['timers'], null)).timers[0].state, 'snoozed');
  assert.equal(await v.say('cancel'), 'OK.');
});

test('alarms: set with repeats, list, turn off', async () => {
  const v = setup();
  assert.equal(await v.say('wake me up at 6:30 tomorrow'), 'Alarm set for 6:30 AM tomorrow.');
  assert.equal(await v.say('set an alarm for seven a m every weekday called gym'), 'Alarm set for 7 AM every weekday. The next one is 7 AM on Monday.');
  const s = await v.timers.handle('GET', ['timers'], null);
  assert.deepEqual(s.alarms.map((a) => [a.hour, a.minute, a.days, a.label]), [[6, 30, [], ''], [7, 0, [1, 2, 3, 4, 5], 'Gym']]);
  assert.equal(await v.say('what alarms do I have'), 'You have 2 alarms on: 6:30 AM and 7 AM every weekday called Gym. The next one is 6:30 AM tomorrow.');
  assert.equal(await v.say('turn off my 7 am alarm'), 'Turned off the 7 AM alarm.');
  assert.equal(await v.say('cancel my 6:30 alarm'), 'Deleted the 6:30 AM alarm.');
  assert.equal((await v.run('set an alarm')).reply, 'For what time?');
  assert.equal(await v.say('8 pm'), 'Alarm set for 8 PM today.');
});

test('reminders: times, repeats, asking for what is missing', async () => {
  const v = setup();
  assert.equal(await v.say('remind me to call mom at 5 pm'), "OK, I'll remind you to call mom 5 PM today.");
  assert.equal(await v.say('remind me in 20 minutes to check the oven'), "OK, I'll remind you to check the oven 10:20 AM today.");
  assert.equal(
    await v.say('remind me to take out the trash every tuesday at 7 pm'),
    "OK, I'll remind you to take out the trash every Tuesday at 7 PM, starting Tuesday.",
  );
  assert.equal(await v.say('remind me tomorrow about the dentist'), "OK, I'll remind you about the dentist 9 AM tomorrow. Say a time next time if you want a different one.");
  const r = (await v.reminders.handle('GET', ['reminders'], null)).reminders;
  assert.deepEqual(
    r.map((x) => [x.title, x.date, x.hour, x.minute, x.repeat, x.days]),
    [
      ['Call mom', '2026-10-03', 17, 0, 'none', []],
      ['Check the oven', '2026-10-03', 10, 20, 'none', []],
      ['Take out the trash', '2026-10-03', 19, 0, 'weekly', [2]],
      ['The dentist', '2026-10-04', 9, 0, 'none', []],
    ],
  );

  assert.equal((await v.run('remind me to water the plants')).reply, 'When should I remind you?');
  assert.equal(await v.say('at 6 pm'), "OK, I'll remind you to water the plants 6 PM today.");
  assert.equal((await v.run('remind me at 9 am')).reply, 'What should I remind you about?');
  assert.match(await v.say('stretch'), /^OK, I'll remind you about stretch 9 AM tomorrow/);

  assert.match(await v.say('what are my reminders'), /^You have 6 reminders: Check the oven 10:20 AM today, Call mom 5 PM today/);
  assert.equal(await v.say('delete the reminder to call mom'), 'Deleted the reminder Call mom.');
  v.advance(21 * 60000);
  v.reminders.tick();
  assert.equal(await v.say("I'm done"), "Sorry, I don't know how to do that yet.");
  assert.equal(await v.say('mark the reminder done'), 'Marked Check the oven done.');
});

test('lists: add, read, check off, remove, clear', async () => {
  const v = setup();
  assert.equal(await v.say('add milk, eggs, and bread to my grocery list'), 'Added milk, eggs and bread to Groceries.');
  assert.equal(await v.say("we're out of coffee"), 'Added coffee to Groceries.');
  assert.equal(await v.say('put milk on the shopping list'), 'Milk is already on it.');
  assert.equal(await v.say("what's on my grocery list"), 'Groceries has 4 items: coffee, bread, eggs and milk.');
  assert.equal(await v.say('cross bread off the grocery list'), 'Checked off bread on Groceries.');
  assert.equal(await v.say('remove eggs from groceries'), 'Removed eggs from Groceries.');
  assert.equal(await v.say('add call the dentist to my to do list'), 'Added call the dentist to To-do.');
  assert.equal(await v.say('add milk to the hardware list'), "There's no Hardware list. Your lists are To-do and Groceries. Say, create a list called hardware, to make one.");
  assert.equal(await v.say('create a list called hardware store'), 'Created the Hardware store list.');
  assert.equal(await v.say('add nails to the hardware store list'), 'Added nails to Hardware store.');

  // No list named: it asks which.
  assert.equal((await v.run('add batteries to my list')).reply, 'Which list, To-do, Groceries or Hardware store?');
  assert.equal(await v.say('groceries'), 'Added batteries to Groceries.');

  assert.equal(await v.say('clear checked items from groceries'), 'Cleared 1 checked item from Groceries.');
  assert.equal((await v.run('clear the grocery list')).reply, 'Clear all 3 items from Groceries?');
  assert.equal(await v.say('yes'), 'Cleared Groceries.');
  const lists = v.store.get('todo').lists;
  assert.deepEqual(lists.map((l) => [l.name, l.items.map((i) => i.text)]), [['To-do', ['Call the dentist']], ['Groceries', []], ['Hardware store', ['Nails']]]);
  assert.ok(v.events.some(([e, k]) => e === 'store' && k === 'todo'));
});

test('weather: now, tomorrow, rain, sunset, other places', async () => {
  const v = setup();
  assert.equal(await v.say("what's the weather"), "Right now it's 72 degrees and partly cloudy. Today's high is 80 and the low is 55.");
  assert.equal(await v.say('will it rain tomorrow'), 'Yes, rain is likely tomorrow, with a 80 percent chance.');
  assert.equal(await v.say('is it going to rain today'), 'Rain is likely around 3 PM, with a 60 percent chance.');
  assert.equal(await v.say("what's the weather on tuesday"), 'Tuesday: mostly clear, a high of 83 degrees and a low of 55.');
  assert.equal(await v.say('when is sunset'), 'Sunset is at 6:40 PM today.');
  assert.equal(await v.say('how is the air quality'), 'Air quality is Good, with an AQI of 35. The UV index is 4.2.');
  assert.equal(await v.say("what's the temperature"), "It's 72 degrees right now, and it feels like 70.");
  assert.match(await v.say('what is the weather in chicago'), /^Right now in Citrus Heights it's 72/);
  assert.equal(await v.say('weather in atlantis'), "I couldn't find atlantis.");
  assert.match(await v.say('what is the weather this weekend'), /^This weekend: Today, mostly clear, high 80, low 55\. Tomorrow, rain, high 81/);
});

test('music: play things, control playback, speakers', async () => {
  const v = setup();
  assert.equal(await v.say('play fleetwood mac'), 'Playing Fleetwood Mac.');
  assert.deepEqual(v.calls.at(-1), ['spotify', 'play', { contextUri: 'spotify:artist:fm' }]);
  assert.equal(await v.say('play my chill vibes playlist'), 'Playing your Chill Vibes playlist.');
  assert.equal(await v.say('play hotel california by the eagles'), 'Playing Hotel California by Eagles.');
  assert.deepEqual(v.calls.at(-1), ['spotify', 'play', { contextUri: 'spotify:album:hc', offsetUri: 'spotify:track:hc' }]);
  assert.equal(await v.say('play the album rumours'), 'Playing Rumours by Fleetwood Mac.');
  assert.equal(await v.say('pause'), 'Paused.');
  assert.equal(await v.say('resume'), 'OK.');
  assert.equal(await v.say('next song'), 'Skipping.');
  assert.equal(await v.say("what's playing"), 'This is Dreams by Fleetwood Mac.');
  assert.equal(await v.say('turn shuffle on'), 'Shuffle on.');
  assert.equal(await v.say('play music on the kitchen speaker'), 'Playing on Kitchen Speaker.');
  assert.deepEqual(v.calls.at(-1), ['spotify', 'transfer', { deviceId: 'kitchen', play: true }]);
  assert.equal(await v.say('switch the sound to bluetooth'), 'Sound is now on JBL Flip.');
  assert.equal(await v.say('play rumours on the kitchen speaker'), 'Playing Rumours by Fleetwood Mac.');
  assert.equal(v.calls.at(-1)[2].deviceId, 'kitchen');
  assert.equal(await v.say('play some jazz'), 'Playing the jazz playlist.');
});

test('music explains when Spotify is not set up', async () => {
  const v = setup({ spotifyConnected: false });
  assert.equal(await v.say('play jazz'), "Spotify isn't connected yet. Sign in from the Spotify tile.");
});

test('volume: up, down, set, mute and unmute', async () => {
  const v = setup();
  assert.equal(await v.say('volume up'), 'Volume 60.');
  assert.equal(await v.say('turn it down a little'), 'Volume 55.');
  assert.equal(await v.say('set the volume to 30 percent'), 'Volume 30.');
  assert.equal(await v.say('volume 7'), 'Volume 70.');
  assert.equal(await v.say('mute'), '');
  assert.equal(v.outputs[0].volume, 0);
  assert.equal(await v.say('unmute'), 'Volume 70.');
});

test('calendar, stocks, news, fares, notifications, system, time', async () => {
  const v = setup();
  assert.equal(await v.say("what's on my calendar today"), 'You have 2 events today: Dentist at 2 PM and Soccer at 5:30 PM.');
  assert.equal(await v.say("what's my next event"), 'Your next event is Dentist 2 PM today.');
  assert.equal(await v.say('do I have anything tomorrow'), 'Nothing is on your calendar tomorrow.');
  assert.equal(await v.say('how is apple stock doing'), 'Apple is at $232, up 1.2 percent.');
  assert.equal(await v.say('how is tesla stock doing'), "Tesla isn't on your watchlist. Add it on the Stocks tile.");
  assert.equal(await v.say('how are my stocks'), 'The market is open. Apple is at $232, up 1.2 percent. Microsoft is at $410, down 0.5 percent.');
  assert.equal(await v.say('what are the headlines'), 'Here are the top World headlines. Big news, from Example Times. Other news, from Wire.');
  assert.equal(await v.say('any fare deals'), 'The best deal is SMF to Los Angeles for $148, leaving November 12.');
  assert.equal(await v.say('read my notifications'), 'You have 1 notification from today. Tea is done.');
  assert.equal(await v.say("what's the pi's temperature"), 'The Pi is at 52 degrees Celsius, the CPU is 12 percent busy, memory is 25 percent used and the disk is 30 percent full.');
  assert.equal(await v.say("what's your ip address"), 'My IP address is 192.168.1.20.');
  assert.equal(await v.say('what time is it'), "It's 10 AM.");
  assert.equal(await v.say("what's the date"), 'Today is Saturday, October 3.');
});

test('screen: pages, theme, hold rotation, help, unknown', async () => {
  const v = setup();
  let r = await v.run('go to the music page');
  assert.deepEqual(r.action, { type: 'page', index: 1, name: 'Music' });
  r = await v.run('show the weather');
  assert.equal(r.action.index, 0);
  assert.equal(r.reply, 'Showing the weather.');
  r = await v.run('show my grocery list');
  assert.equal(r.action.index, 2);
  assert.equal(r.reply, 'Your Groceries list is empty.');
  // No tile to show: it says the answer instead.
  r = await v.run('show the stocks');
  assert.match(r.reply, /^The market is open\. Apple/);
  r = await v.run('show the photos');
  assert.equal(r.ok, false);
  assert.match(r.reply, /no tile for your photos/);
  assert.equal((await v.run('next page')).action.type, 'nextPage');
  assert.equal((await v.run('stay on this page')).action.type, 'hold');
  assert.equal(await v.say('dark mode'), 'Dark mode.');
  assert.deepEqual(v.store.get('app.settings'), { theme: 'dark' });
  assert.equal((await v.run('what can you do')).action.type, 'help');
  r = await v.run('order a pizza');
  assert.equal(r.ok, false);
  assert.equal(r.heard, 'order a pizza');
  assert.equal(await v.say('thank you'), "You're welcome.");
  assert.equal(await v.say('never mind'), 'OK.');
});

test('every result is broadcast to the screens and kept in history', async () => {
  const v = setup();
  await v.say('what time is it');
  const ev = v.events.find(([e, d]) => e === 'voice' && d.type === 'result');
  assert.equal(ev[1].heard, 'what time is it');
  assert.equal(v.voice.state().history[0].reply, "It's 10 AM.");
});

test('the /api/voice routes: settings, heartbeat, commands, tap to talk', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pidisplay-voice-'));
  const server = createServer({
    dataDir,
    distDir: path.join(dataDir, 'dist'),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    stocksAutoStart: false,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/voice`;
  const post = (p, body, method = 'POST') => fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let state = await (await fetch(base)).json();
    assert.equal(state.service.running, false);
    assert.equal(state.settings.wakeWord, 'hey_jarvis');
    assert.ok(state.wakeWords.some((w) => w.id === 'alexa'));

    assert.equal((await post('/listen', {})).status, 409);
    assert.equal((await post('/status', { mic: true, micName: 'USB mic', customWakeWords: ['hey_pi'] })).status, 200);
    state = await (await fetch(base)).json();
    assert.equal(state.service.running, true);
    assert.ok(state.wakeWords.some((w) => w.id === 'hey_pi'));
    assert.equal((await post('/listen', {})).status, 200);

    assert.equal((await post('/settings', { wakeWord: 'alexa', sensitivity: 0.6 }, 'PUT')).status, 200);
    assert.equal((await post('/settings', { sensitivity: 3 }, 'PUT')).status, 400);
    // The master switch: off refuses tap to talk, on allows it again.
    assert.equal((await (await post('/settings', { active: false }, 'PUT')).json()).settings.active, false);
    assert.equal((await post('/listen', {})).status, 409);
    assert.equal((await (await post('/settings', { active: true }, 'PUT')).json()).settings.active, true);
    assert.equal((await post('/listen', {})).status, 200);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'voice.json'), 'utf8')).wakeWord, 'alexa');

    const r = await (await post('/command', { text: 'add milk to the grocery list', source: 'typed' })).json();
    assert.equal(r.reply, 'Added milk to Groceries.');
    const todo = JSON.parse(await fs.readFile(path.join(dataDir, 'store', 'todo.json'), 'utf8'));
    assert.equal(todo.lists[1].items[0].text, 'Milk');
    assert.equal((await post('/command', {})).status, 400);
    assert.equal((await post('/event', { type: 'wake' })).status, 200);
    assert.equal((await post('/event', { type: 'bogus' })).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
