// Voice control. The on-device voice service (voice/pidisplay_voice.py) listens for
// the wake word, turns speech into text and posts it to /api/voice/command; this
// module works out what the sentence means, does it through the same modules the
// widgets use (timers, reminders, lists, Spotify, weather...) and answers with
// the words to say back. Screens follow the `voice` SSE event to show what was
// heard and to do screen-only things (change page, close a sheet). The service
// follows `voice-control` (tap-to-talk, "is something ringing") and `voice-settings`.
import crypto from 'node:crypto';
import {
  bestMatch,
  capitalize,
  cut,
  hour24,
  normalize,
  parseClock,
  parseDay,
  parseDuration,
  parseRepeat,
  resolveClock,
  sayClock,
  sayDay,
  sayDuration,
  sayList,
  sayWhen,
  similarity,
  simplify,
  stripFiller,
  WEEKDAYS,
} from './voice-parse.js';

export class VoiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Wake words built into openWakeWord; the service may report custom ones too. */
export const WAKE_WORDS = {
  hey_jarvis: 'Hey Jarvis',
  alexa: 'Alexa',
  hey_mycroft: 'Hey Mycroft',
  okay_nabu: 'Okay Nabu',
  hey_rhasspy: 'Hey Rhasspy',
};

export const DEFAULT_SETTINGS = {
  /** The master switch. Off = the service closes the microphone and tap to talk is refused. */
  active: true,
  /** Listen for the wake word (tap to talk still works when this is off). */
  enabled: true,
  wakeWord: 'hey_jarvis',
  /** Wake word confidence needed, 0.1-0.95; lower hears it more easily but wakes by mistake more. */
  sensitivity: 0.5,
  /** Say replies out loud (Piper). Off = show them on screen only. */
  speak: true,
  speechVolume: 80,
  /** A short tone when it starts listening. */
  chime: true,
  /** Turn music and other sound down while listening. */
  duck: true,
};

/** How long a heartbeat from the voice service counts as "running". */
const SERVICE_TIMEOUT_MS = 75_000;
/** How long a question ("For how long?") waits for its answer. */
const PENDING_MS = 45_000;
const HISTORY = 20;

export const EXAMPLES = [
  {
    group: 'Timers & alarms',
    items: [
      'Set a timer for 10 minutes',
      'Set a pasta timer for 8 minutes',
      'How much time is left?',
      'Add 5 minutes to the timer',
      'Cancel the timer',
      'Wake me up at 6:30',
      'Set an alarm for 7 AM every weekday',
      'What alarms do I have?',
      'Turn off my 7 AM alarm',
      'Stop / Snooze',
    ],
  },
  {
    group: 'Reminders',
    items: [
      'Remind me to call Mom at 5 PM',
      'Remind me in 20 minutes to check the oven',
      'Remind me to take out the trash every Tuesday at 7 PM',
      'What are my reminders?',
      'Mark the reminder done',
    ],
  },
  {
    group: 'Lists',
    items: [
      'Add milk and eggs to the grocery list',
      'We are out of coffee',
      'What is on my grocery list?',
      'Cross bread off the grocery list',
      'Add call the dentist to my to-do list',
      'Clear checked items from groceries',
      'Create a list called Hardware store',
    ],
  },
  {
    group: 'Weather, time & calendar',
    items: [
      "What's the weather?",
      'Will it rain tomorrow?',
      "What's the weather this weekend?",
      'When is sunset?',
      'What time is it?',
      "What's on my calendar today?",
      "What's my next event?",
    ],
  },
  {
    group: 'Music & sound',
    items: [
      'Play Fleetwood Mac',
      'Play my Chill playlist',
      'Play Hotel California by the Eagles',
      'Pause / Resume / Next song',
      "What's playing?",
      'Turn shuffle on',
      'Volume up / Set volume to 40 / Mute',
      'Play music on the Bluetooth speaker',
    ],
  },
  {
    group: 'Stocks, news & more',
    items: [
      'How is Apple stock doing?',
      'How are my stocks?',
      'What are the headlines?',
      'Any fare deals?',
      'Read my notifications',
      "What's the Pi's temperature?",
    ],
  },
  {
    group: 'Screen',
    items: [
      'Show the weather',
      'Go to the Music page',
      'Next page / Previous page',
      'Stay on this page / Resume rotating',
      'Dark mode / Light mode',
      'Close',
      'Never mind',
    ],
  },
];

/** Widget types by the words people use for them, for "show the ..." and "go to ...". */
const WIDGET_WORDS = [
  ['weather', /\b(weather|forecast|temperature|radar|air quality)\b/],
  ['calendar', /\b(calendar|schedule|agenda|events?)\b/],
  ['timers', /\b(timers?|alarms?|stopwatch)\b/],
  ['reminders', /\b(reminders?)\b/],
  ['todo', /\b(lists?|to ?do|todos?|tasks?|grocer(y|ies)|shopping)\b/],
  ['spotify', /\b(music|spotify|player|songs?|now playing)\b/],
  ['stocks', /\b(stocks?|market|portfolio|shares)\b/],
  ['news', /\b(news|headlines)\b/],
  ['photos', /\b(photos?|pictures?|slideshow|gallery)\b/],
  ['system', /\b(system|stats|cpu|pi health)\b/],
  ['fares', /\b(fares?|flights?|deals?|farewatcher)\b/],
  ['clock', /\b(clock|time)\b/],
];
const WIDGET_NAMES = {
  weather: 'the weather',
  calendar: 'your calendar',
  timers: 'your timers',
  reminders: 'your reminders',
  todo: 'your lists',
  spotify: 'the music player',
  stocks: 'your stocks',
  news: 'the news',
  photos: 'your photos',
  system: 'system stats',
  fares: 'fare deals',
  clock: 'the clock',
};

const GROCERY_WORDS = /^(grocery|groceries|shopping|store|supermarket|food)$/;
const TODO_WORDS = /^(to ?do|todo|todos|tasks?|chores?)$/;

/** WMO weather codes (Open-Meteo), as words. */
function describeWeather(code) {
  if (code === 0) return 'clear';
  if (code === 1) return 'mostly clear';
  if (code === 2) return 'partly cloudy';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'foggy';
  if (code >= 51 && code <= 55) return 'drizzly';
  if (code === 56 || code === 57) return 'freezing drizzle';
  if (code === 61) return 'light rain';
  if (code === 63) return 'rain';
  if (code === 65) return 'heavy rain';
  if (code === 66 || code === 67) return 'freezing rain';
  if (code === 71) return 'light snow';
  if (code === 73) return 'snow';
  if (code === 75) return 'heavy snow';
  if (code === 77) return 'snow grains';
  if (code >= 80 && code <= 82) return code === 82 ? 'heavy showers' : 'showers';
  if (code === 85 || code === 86) return 'snow showers';
  if (code === 95) return 'thunderstorms';
  if (code === 96 || code === 99) return 'thunderstorms with hail';
  return 'unsettled';
}
const isSnow = (code) => (code >= 71 && code <= 77) || code === 85 || code === 86;
const isWet = (code) => code >= 51;

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const midnight = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
};
const has = (t, re) => re.test(t);
const money = (n, currency = 'USD') =>
  `${currency === 'USD' ? '$' : ''}${n >= 100 ? n.toFixed(0) : n.toFixed(2)}${currency === 'USD' ? '' : ` ${currency}`}`;

/** "a, b or c". */
const sayOr = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}` : items.join(''));

function sayDays(days) {
  const set = [...days].sort().join(',');
  if (set === '0,1,2,3,4,5,6') return 'every day';
  if (set === '1,2,3,4,5') return 'every weekday';
  if (set === '0,6') return 'every weekend';
  return `every ${sayList(days.map((d) => capitalize(WEEKDAYS[d])))}`;
}

export function createVoice({
  timers,
  reminders,
  spotify,
  audio,
  stocks,
  weather,
  news,
  calendar,
  system,
  readStore,
  writeStore,
  loadLayout,
  notifications,
  readFares,
  loadSettings = async () => null,
  saveSettings = async () => {},
  broadcast = () => {},
  now = Date.now,
  zone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  watchMs = 1000,
}) {
  let settings = { ...DEFAULT_SETTINGS };
  let service = null; // last heartbeat from the voice service
  let pending = null; // a question waiting for its answer
  let ringing = false;
  let mutedVolume = null; // volume before "mute", for "unmute"
  const history = [];

  const ready = (async () => {
    const saved = await loadSettings().catch(() => null);
    if (saved && typeof saved === 'object') settings = { ...DEFAULT_SETTINGS, ...saved };
  })();

  // ---- Is something ringing? (lets the service hear "stop" without the wake word) ----

  async function ringingNow() {
    const [t, r] = await Promise.all([
      timers.handle('GET', ['timers'], null).catch(() => null),
      reminders.handle('GET', ['reminders'], null).catch(() => null),
    ]);
    return Boolean(
      t?.timers.some((x) => x.state === 'ringing') ||
        t?.alarms.some((x) => x.state === 'ringing') ||
        r?.reminders.some((x) => x.state === 'due'),
    );
  }

  let watching = false;
  const watch = setInterval(async () => {
    if (watching) return;
    watching = true;
    try {
      const next = await ringingNow();
      if (next !== ringing) {
        ringing = next;
        broadcast('voice-control', { ringing });
      }
    } finally {
      watching = false;
    }
  }, watchMs);
  watch.unref?.();

  const serviceAlive = () => Boolean(service && now() - service.at < SERVICE_TIMEOUT_MS);
  const serviceInfo = () => (service ? { ...service, running: serviceAlive() } : { running: false });

  function wakeWordOptions() {
    const options = Object.entries(WAKE_WORDS).map(([id, label]) => ({ id, label }));
    for (const id of service?.customWakeWords ?? []) {
      if (!WAKE_WORDS[id]) options.push({ id, label: capitalize(id.replace(/[_-]+/g, ' ')) });
    }
    return options;
  }

  function cleanSettings(body) {
    const s = { ...settings };
    const bool = (k) => {
      if (body[k] !== undefined) s[k] = Boolean(body[k]);
    };
    ['active', 'enabled', 'speak', 'chime', 'duck'].forEach(bool);
    if (body.wakeWord !== undefined) {
      if (typeof body.wakeWord !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(body.wakeWord)) throw new VoiceError(400, 'Unknown wake word');
      s.wakeWord = body.wakeWord;
    }
    if (body.sensitivity !== undefined) {
      const v = Number(body.sensitivity);
      if (!Number.isFinite(v) || v < 0.1 || v > 0.95) throw new VoiceError(400, 'sensitivity must be 0.1 to 0.95');
      s.sensitivity = Math.round(v * 100) / 100;
    }
    if (body.speechVolume !== undefined) {
      const v = Number(body.speechVolume);
      if (!Number.isInteger(v) || v < 0 || v > 100) throw new VoiceError(400, 'speechVolume must be 0-100');
      s.speechVolume = v;
    }
    return s;
  }

  function state() {
    return {
      settings,
      service: serviceInfo(),
      ringing,
      wakeWords: wakeWordOptions(),
      examples: EXAMPLES,
      history,
    };
  }

  /** Routes /api/voice[...]; parts is the path after /api. */
  async function handle(method, parts, body) {
    await ready;
    const [, action] = parts;
    body = body ?? {};
    if (method === 'GET' && !action) return state();
    if (method === 'GET' && action === 'config') return { settings, ringing };
    if (method === 'PUT' && action === 'settings') {
      settings = cleanSettings(body);
      await saveSettings(settings);
      broadcast('voice-settings', settings);
      broadcast('voice', { type: 'status', service: serviceInfo(), settings });
      return state();
    }
    if (method === 'POST' && action === 'status') {
      const wasAlive = serviceAlive();
      const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);
      service = {
        at: now(),
        mic: Boolean(body.mic),
        micName: str(body.micName),
        wakeWord: str(body.wakeWord, 60),
        stt: str(body.stt),
        tts: str(body.tts),
        error: str(body.error, 500),
        customWakeWords: Array.isArray(body.customWakeWords) ? body.customWakeWords.filter((x) => typeof x === 'string').slice(0, 20) : [],
      };
      if (!wasAlive || body.changed) broadcast('voice', { type: 'status', service: serviceInfo(), settings });
      return { settings, ringing };
    }
    if (method === 'POST' && action === 'event') {
      const type = String(body.type ?? '');
      if (!['wake', 'partial', 'thinking', 'speaking', 'idle', 'error'].includes(type)) throw new VoiceError(400, 'Unknown event');
      broadcast('voice', { type, text: typeof body.text === 'string' ? body.text.slice(0, 300) : '' });
      return { ok: true };
    }
    if (method === 'POST' && action === 'command') {
      if (typeof body.text !== 'string') throw new VoiceError(400, 'text is required');
      return command(body.text, body.source === 'typed' ? 'typed' : 'voice');
    }
    if (method === 'POST' && action === 'listen') {
      if (!settings.active) throw new VoiceError(409, 'Voice control is turned off. Turn it on in ⚙ Settings › Voice control.');
      if (!serviceAlive()) throw new VoiceError(409, "The voice service isn't running on the Pi. Check the microphone, or type a command instead.");
      broadcast('voice-control', { action: 'listen' });
      return { ok: true };
    }
    if (method === 'POST' && action === 'cancel') {
      pending = null;
      broadcast('voice-control', { action: 'cancel' });
      broadcast('voice', { type: 'idle', text: '' });
      return { ok: true };
    }
    throw new VoiceError(404, 'Not found');
  }

  // ---- Running a command ----------------------------------------------------

  /** Works out and does what `text` asks. Returns { ok, heard, reply, action?, expectReply? }. */
  async function command(text, source = 'voice') {
    await ready;
    const heard = String(text).trim().slice(0, 300);
    let result;
    try {
      result = await interpret(heard);
    } catch (err) {
      // The widget modules' errors are written for people; anything else is a bug.
      if (typeof err?.status === 'number' && err.status < 500) result = fail(err.message);
      else if (typeof err?.status === 'number') result = fail(err.message || 'That service is having trouble right now.');
      else {
        console.error('Voice command failed', err);
        result = fail('Sorry, something went wrong doing that.');
      }
    }
    result = { ok: true, ...result, heard, source, expectReply: Boolean(result.expectReply) };
    history.unshift({ at: now(), heard, reply: result.reply, ok: result.ok });
    history.length = Math.min(history.length, HISTORY);
    broadcast('voice', { type: 'result', ...result });
    return result;
  }

  const say = (reply, extra = {}) => ({ ok: true, reply, ...extra });
  const fail = (reply, extra = {}) => ({ ok: false, reply, ...extra });
  /** Asks a question; the next command is first offered to `answer`. */
  function ask(reply, answer, extra = {}) {
    pending = { answer, expires: now() + PENDING_MS };
    return { ok: true, reply, expectReply: true, ...extra };
  }

  async function interpret(heard) {
    const raw = normalize(heard);
    if (!raw) return fail("I didn't hear anything.");

    if (pending && now() < pending.expires) {
      const p = pending;
      pending = null;
      if (/^(cancel|never ?mind|nevermind|forget it|nothing|no thanks|stop)$/.test(stripFiller(raw))) return say('OK.');
      const r = await p.answer(stripFiller(raw), raw);
      if (r) return r;
    }
    pending = null;

    if (/^(thanks|thank you|thank you very much|thanks a lot|cheers|great|awesome|perfect|cool|nice|good job|well done)( jarvis)?$/.test(raw)) {
      return say("You're welcome.");
    }
    const t = stripFiller(raw);
    if (!t) return fail("I didn't catch that.");

    for (const intent of INTENTS) {
      const m = intent.match(t);
      if (!m) continue;
      // A phrase that looked right but didn't fit (run returns null) falls through.
      const r = await intent.run(m, t);
      if (r) return r;
    }
    // A bare list name ("groceries") reads that list.
    const lists = await loadLists().catch(() => null);
    if (lists && findList(lists.lists, t)) return readList(t);
    return fail(`Sorry, I don't know how to do that yet.`);
  }

  // ---- Shared look-ups ---------------------------------------------------

  const timerSnapshot = () => timers.handle('GET', ['timers'], null);
  const reminderSnapshot = () => reminders.handle('GET', ['reminders'], null);

  async function layout() {
    return (await loadLayout()) ?? { pages: [], topBar: { left: [], right: [] } };
  }

  /** The first tile config of a widget type (pages first, then the top bar). */
  async function widgetConfig(type) {
    const l = await layout();
    const tiles = [...l.pages.flatMap((p) => p.tiles), ...l.topBar.left, ...l.topBar.right];
    return tiles.filter((x) => x.widget === type).map((x) => x.config ?? {});
  }

  async function weatherPlace() {
    const configs = await widgetConfig('weather');
    const own = configs.map((c) => String(c.location ?? '').trim()).find(Boolean);
    const shared = await readStore('weather', null).catch(() => null);
    const home = await readStore('home', null).catch(() => null);
    const location = own || String(shared?.location ?? '').trim() || String(home?.location ?? '').trim();
    const units = configs.find((c) => c.units)?.units === 'metric' ? 'metric' : 'imperial';
    return { location, units };
  }

  // ---- Ringing things: stop, snooze -----------------------------------------

  async function ringingItems() {
    const s = await timerSnapshot();
    return [
      ...s.timers.filter((x) => x.state === 'ringing').map((item) => ({ kind: 'timers', item })),
      ...s.alarms.filter((x) => x.state === 'ringing').map((item) => ({ kind: 'alarms', item })),
    ];
  }
  const dueReminders = async () => (await reminderSnapshot()).reminders.filter((r) => r.state === 'due');

  async function stop(t) {
    const ring = await ringingItems();
    if (ring.length) {
      for (const r of ring) await timers.handle('POST', [r.kind, r.item.id, 'dismiss'], {});
      return say('OK.', { quiet: true });
    }
    const due = await dueReminders();
    if (due.length) {
      for (const r of due) await reminders.handle('POST', ['reminders', r.id, 'done'], {});
      return say(due.length === 1 ? `Marked ${due[0].title} done.` : `Marked ${due.length} reminders done.`);
    }
    if (/^(stop|stop it|stop that|pause|quiet|be quiet|silence|shut up|enough)$/.test(t)) {
      const paused = await pauseMusicIfPlaying();
      if (paused) return say('Paused.', { quiet: true });
    }
    if (/^(cancel|off)$/.test(t)) return say('OK.', { quiet: true });
    return say('Nothing is ringing.');
  }

  async function snooze(t) {
    const d = parseDuration(t);
    const ring = await ringingItems();
    const due = await dueReminders();
    if (!ring.length && !due.length) return say('Nothing is ringing.');
    const s = await timerSnapshot();
    for (const r of ring) {
      // A ringing timer can count down again for any length; alarms use the snooze setting.
      if (r.kind === 'timers' && d) await timers.handle('POST', ['timers', r.item.id, 'add'], { ms: d.ms });
      else await timers.handle('POST', [r.kind, r.item.id, 'snooze'], {});
    }
    const minutes = d ? Math.max(1, Math.round(d.ms / 60000)) : 10;
    for (const r of due) await reminders.handle('POST', ['reminders', r.id, 'snooze'], { minutes: Math.min(minutes, 1440) });
    // Alarms (and timers without a length) snooze for the Timers snooze setting.
    const usesSetting = ring.some((r) => r.kind === 'alarms' || !d);
    return say(`Snoozed for ${sayDuration((usesSetting ? s.settings.snoozeMinutes : minutes) * 60000)}.`);
  }

  // ---- Time and date ------------------------------------------------------

  function timeNow() {
    return say(`It's ${sayClock(now())}.`);
  }
  function dateNow(t) {
    const day = parseDay(t, now());
    const d = day?.date ?? new Date(now());
    const words = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    if (!day || sayDay(d, now()) === 'today') return say(`Today is ${words}.`);
    return say(`${capitalize(sayDay(d, now()))} is ${words}.`);
  }

  // ---- Weather ------------------------------------------------------------

  async function weatherReport(t) {
    const place = await weatherPlace();
    // "weather in Chicago", "will it snow in Denver tomorrow"
    const where = /\b(?:in|for|at) ((?!the morning|the afternoon|the evening|the weekend)[a-z][a-z ]*?)(?: (?:today|tonight|tomorrow|this weekend|this week|on [a-z]+|next [a-z]+|day after tomorrow))?$/.exec(t);
    const dayWords = /^(today|tonight|tomorrow|the weekend|this weekend|this week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|the morning|the afternoon|the evening)$/;
    let location = place.location;
    if (where && !dayWords.test(where[1]) && !/^(the )?(house|home|here|outside)$/.test(where[1])) location = where[1];

    if (!location) return fail('Set a location on a weather tile first, then ask me again.');
    let data;
    try {
      data = await weather.get(location, place.units);
    } catch (err) {
      if (err?.status === 404 || err?.status === 400) return fail(`I couldn't find ${location}.`);
      throw err;
    }
    const placeName = location === place.location ? '' : ` in ${data.location?.name ?? capitalize(location)}`;
    const deg = (n) => (n === null || n === undefined ? 'unknown' : `${n} degrees`);
    const speed = data.units === 'metric' ? 'kilometers per hour' : 'miles per hour';
    const today = midnight(now());
    const dayAt = (d) => {
      const i = Math.round((midnight(d.getTime()) - today) / 86400000);
      return { i, day: data.daily?.[i] ?? null };
    };

    if (has(t, /\b(sunrise|sun rise|sunset|sun set|sun come up|sun go down|get dark)\b/)) {
      const target = parseDay(t, now())?.date ?? new Date(now());
      const { day } = dayAt(target);
      if (!day) return fail('I only have the next week of sun times.');
      const rise = has(t, /\b(sunrise|sun rise|come up)\b/);
      const at = rise ? day.sunrise : day.sunset;
      if (!at) return fail("I don't have that right now.");
      return say(`${rise ? 'Sunrise' : 'Sunset'}${placeName} is at ${sayClock(at * 1000)} ${sayDay(target, now())}.`);
    }

    if (has(t, /\b(air quality|aqi|air pollution|smoke|smoky|pollen|uv|uv index)\b/)) {
      const aq = data.airQuality;
      if (!aq || aq.aqi === null || aq.aqi === undefined) return fail("I don't have air quality right now.");
      const uv = aq.uv !== null && aq.uv !== undefined ? ` The UV index is ${aq.uv}.` : '';
      return say(`Air quality${placeName} is ${aq.category ?? 'unknown'}, with an AQI of ${aq.aqi}.${uv}`);
    }

    if (has(t, /\b(humid|humidity|wind|windy|breezy)\b/) && !parseDay(t, now())) {
      const c = data.current;
      if (has(t, /\b(wind|windy|breezy)\b/)) return say(`The wind${placeName} is ${c.wind ?? 0} ${speed}, and humidity is ${c.humidity ?? 'unknown'} percent.`);
      return say(`Humidity${placeName} is ${c.humidity ?? 'unknown'} percent, and the wind is ${c.wind ?? 0} ${speed}.`);
    }

    // Which days: this weekend, a named day, or today.
    if (has(t, /\b(this |the )?weekend\b/)) {
      const days = [6, 0].map((wd) => {
        const d = new Date(today);
        d.setDate(d.getDate() + ((wd - d.getDay() + 7) % 7));
        return d;
      });
      if (today.getDay() === 0) days.splice(0, 1, today); // Sunday: "this weekend" is today
      const parts = days
        .map((d) => ({ d, ...dayAt(d) }))
        .filter((x) => x.day)
        .map((x) => `${capitalize(sayDay(x.d, now()))}, ${describeWeather(x.day.code)}, high ${x.day.high}, low ${x.day.low}`);
      if (!parts.length) return fail("I don't have the weekend forecast yet.");
      return say(`This weekend${placeName}: ${parts.join('. ')}.`);
    }
    if (has(t, /\b(this week|next few days|week)\b/)) {
      const days = (data.daily ?? []).slice(1, 6).map((day, i) => {
        const d = new Date(today);
        d.setDate(d.getDate() + i + 1);
        return `${capitalize(sayDay(d, now()))} ${describeWeather(day.code)}, high ${day.high}`;
      });
      return say(`This week${placeName}: ${days.join('. ')}.`);
    }

    const target = parseDay(t, now());
    const rainQ = has(t, /\b(rain|raining|rainy|umbrella|wet|showers?|storm|stormy|thunder)\b/);
    const snowQ = has(t, /\b(snow|snowing|snowy)\b/);
    if (target && sayDay(target.date, now()) !== 'today') {
      const { day } = dayAt(target.date);
      if (!day) return fail('I only have the forecast for the next week.');
      const when = sayDay(target.date, now());
      if (rainQ || snowQ) return say(precipAnswer(day, when, snowQ, placeName));
      const rain = day.precipChance >= 30 ? `, with a ${day.precipChance} percent chance of ${isSnow(day.code) ? 'snow' : 'rain'}` : '';
      return say(`${capitalize(when)}${placeName}: ${describeWeather(day.code)}, a high of ${deg(day.high)} and a low of ${day.low}${rain}.`);
    }

    const c = data.current;
    const day = data.daily?.[0];
    if (rainQ || snowQ) {
      // Today: say when in the next hours it's likely, if it is.
      const wet = (data.hourly ?? []).find((h) => h.precipChance >= 50 && midnight(h.time * 1000).getTime() === today.getTime());
      if (wet) return say(`${snowQ ? 'Snow' : 'Rain'} is likely${placeName} around ${sayClock(wet.time * 1000)}, with a ${wet.precipChance} percent chance.`);
      if (day) return say(precipAnswer(day, 'today', snowQ, placeName));
    }
    if (has(t, /\b(temperature|how (hot|cold|warm|chilly) is it|degrees|feel like|feels like)\b/)) {
      const feels = c.feelsLike !== null && c.feelsLike !== c.temp ? `, and it feels like ${c.feelsLike}` : '';
      return say(`It's ${deg(c.temp)}${placeName} right now${feels}.`);
    }
    if (has(t, /\b(high|low)\b/) && day) {
      return say(`Today's high${placeName} is ${deg(day.high)} and the low is ${deg(day.low)}.`);
    }
    let reply = `Right now${placeName} it's ${deg(c.temp)} and ${describeWeather(c.code)}.`;
    if (day) reply += ` Today's high is ${day.high} and the low is ${day.low}.`;
    if (day?.precipChance >= 30) reply += ` There's a ${day.precipChance} percent chance of ${isSnow(day.code) ? 'snow' : 'rain'}.`;
    return say(reply);
  }

  function precipAnswer(day, when, snow, placeName) {
    const chance = day.precipChance ?? 0;
    const kind = snow ? 'snow' : 'rain';
    const matches = snow ? isSnow(day.code) : isWet(day.code) && !isSnow(day.code);
    if (chance >= 50 || (matches && chance >= 30)) return `Yes, ${kind} is likely ${when}${placeName}, with a ${chance} percent chance.`;
    if (chance >= 20) return `Maybe. There's a ${chance} percent chance of ${kind} ${when}${placeName}.`;
    return `No ${kind} expected ${when}${placeName}. The chance is ${chance} percent.`;
  }

  // ---- Timers ----------------------------------------------------------

  const describeTimer = (x) => (x.label ? `the ${x.label.toLowerCase()} timer` : `the timer for ${sayDuration(x.durationMs)}`);
  const timerLeft = (x, t) =>
    x.state === 'running' ? x.endsAt - t : x.state === 'paused' ? x.remainingMs : x.state === 'snoozed' ? x.snoozeUntil - t : 0;

  function timerLabel(t, d) {
    let rest = cut(t, d);
    let m = /.*\b(?:called|named|labeled|labelled|label it|for (?:the |my )?)\s*([a-z0-9 ]+)$/.exec(rest);
    if (m && m[1].trim() && !/^(a|an|the|me|it|timer)$/.test(m[1].trim())) return m[1].replace(/\btimer\b/, '').trim();
    m = /\b(?:a|an|the|my|another)\s+([a-z][a-z ]*?)\s+timer\b/.exec(rest);
    if (m && !/^(new|quick|second|another|kitchen timer)$/.test(m[1])) return m[1].trim();
    return '';
  }

  async function setTimer(t) {
    const d = parseDuration(t);
    const label = timerLabel(t, d);
    if (!d) {
      return ask('For how long?', async (answer) => {
        const d2 = parseDuration(answer);
        return d2 ? startTimer(d2.ms, label) : null;
      });
    }
    return startTimer(d.ms, label);
  }

  async function startTimer(ms, label) {
    if (ms < 1000) return fail('That timer is too short.');
    if (ms > 100 * 3600000) return fail('Timers can be at most 100 hours. Try a reminder instead.');
    await timers.handle('POST', ['timers'], { durationMs: ms, label: capitalize(label) });
    return say(`${label ? `${capitalize(label)} timer` : 'Timer'} set for ${sayDuration(ms)}.`, { action: { type: 'widget', widget: 'timers', quiet: true } });
  }

  /** Picks the timer a sentence means: by label, else the only one, else asks. */
  async function withTimer(t, verb, states, fn) {
    const s = await timerSnapshot();
    const list = s.timers.filter((x) => states.includes(x.state));
    if (!list.length) return say(s.timers.length ? `No timer is ${verb === 'resume' ? 'paused' : 'running'}.` : "You don't have any timers.");
    if (/\b(all|every|both)\b|\btimers\b/.test(t)) {
      for (const x of list) await fn(x);
      return say(`${verbPast(verb)} ${list.length === 1 ? 'your timer' : `all ${list.length} timers`}.`);
    }
    const named = bestMatch(t.replace(/\btimer\b/, ''), list.filter((x) => x.label), (x) => x.label, 0.6);
    const byDuration = parseDuration(t) && list.find((x) => Math.abs(x.durationMs - parseDuration(t).ms) < 1000);
    const target = named ?? byDuration ?? (list.length === 1 ? list[0] : null);
    if (target) {
      await fn(target);
      return say(`${verbPast(verb)} ${describeTimer(target)}.`);
    }
    return ask(`Which one? ${capitalize(sayOr(list.map(describeTimer)))}?`, async (answer) => {
      if (/\b(all|both|every)\b/.test(answer)) {
        for (const x of list) await fn(x);
        return say(`${verbPast(verb)} all ${list.length} timers.`);
      }
      const pick =
        bestMatch(answer, list.filter((x) => x.label), (x) => x.label, 0.6) ??
        (parseDuration(answer) && list.find((x) => Math.abs(x.durationMs - parseDuration(answer).ms) < 1000)) ??
        (/\b(1st|first)\b/.test(answer) ? list[0] : /\b(2nd|second|last)\b/.test(answer) ? list[1] : null);
      if (!pick) return null;
      await fn(pick);
      return say(`${verbPast(verb)} ${describeTimer(pick)}.`);
    });
  }
  const verbPast = (v) => ({ cancel: 'Cancelled', pause: 'Paused', resume: 'Resumed', restart: 'Restarted' })[v] ?? 'Done with';

  async function timerStatus(text = '') {
    const s = await timerSnapshot();
    const t = s.now;
    const named = bestMatch(text.replace(/\btimers?\b/g, ''), s.timers.filter((x) => x.label), (x) => x.label, 0.6);
    const live = named ? [named] : s.timers;
    if (!live.length) return say("You don't have any timers running.");
    const parts = live.map((x) => {
      const name = describeTimer(x);
      if (x.state === 'ringing') return `${name} is done`;
      if (x.state === 'paused') return `${name} is paused with ${sayDuration(timerLeft(x, t))} left`;
      return `${name} has ${sayDuration(Math.ceil(timerLeft(x, t) / 1000) * 1000)} left`;
    });
    if (live.length === 1) return say(`${capitalize(parts[0])}.`);
    return say(`You have ${live.length} timers. ${capitalize(sayList(parts))}.`);
  }

  async function addToTimer(t) {
    const d = parseDuration(t);
    if (!d) return fail('How much time should I add? Say, add 5 minutes to the timer.');
    const rest = cut(t, d);
    return withTimer(rest, 'add', ['running', 'paused', 'ringing', 'snoozed'], (x) => timers.handle('POST', ['timers', x.id, 'add'], { ms: d.ms })).then((r) =>
      r.ok && !r.expectReply ? say(`Added ${sayDuration(d.ms)}.`) : r,
    );
  }

  // ---- Alarms -------------------------------------------------------------

  function alarmLabel(t) {
    const m = /\b(?:called|named|labeled|labelled)\s+([a-z0-9 ]+)$/.exec(t);
    return m ? capitalize(m[1].trim()) : '';
  }

  async function setAlarm(t) {
    const label = alarmLabel(t);
    const body = t.replace(/\b(?:called|named|labeled|labelled)\s+[a-z0-9 ]+$/, '');
    const repeat = parseRepeat(body);
    const days = repeat ? (repeat.repeat === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : repeat.repeat === 'weekly' && repeat.days.length ? repeat.days : null) : [];
    if (days === null) return fail('Alarms can repeat on days of the week. Try every weekday, or every Monday.');

    let clock = parseClock(body);
    // "wake me up at 7", "alarm for 6": a morning alarm unless said otherwise.
    if (clock && !clock.meridiem && clock.hour >= 4 && clock.hour <= 11 && (clock.hour <= 9 || /\b(wake|get me up|morning)\b/.test(body) || /\btomorrow\b/.test(body))) {
      clock = { ...clock, meridiem: 'am' };
    }
    const d = /\bin (an?|\d)/.test(body) || /\bfrom now\b/.test(body) ? parseDuration(body) : null;
    let when = null;
    if (d) when = new Date(now() + d.ms);
    else if (clock) when = days.length ? resolveClock(clock, now(), hour24(clock) === null ? midnight(now()) : null) : resolveClock(clock, now());
    if (!when) {
      return ask('For what time?', async (answer) => {
        const c = parseClock(/^\d/.test(answer) ? `at ${answer}` : answer);
        return c ? setAlarm(`${t} at ${c.hour}:${String(c.minute).padStart(2, '0')}${c.meridiem ? ` ${c.meridiem}` : ''}`) : null;
      });
    }
    const s = await timers.handle('POST', ['alarms'], { hour: when.getHours(), minute: when.getMinutes(), days, label });
    const alarm = s.alarms[s.alarms.length - 1];
    const next = alarm?.nextAt ? ` The next one is ${sayWhen(alarm.nextAt, now())}.` : '';
    if (days.length) return say(`Alarm set for ${sayClock(when)} ${sayDays(days)}.${next}`);
    return say(`Alarm set for ${alarm?.nextAt ? sayWhen(alarm.nextAt, now()) : sayClock(when)}.`);
  }

  async function alarmStatus() {
    const s = await timerSnapshot();
    const on = s.alarms.filter((a) => a.enabled && a.nextAt).sort((a, b) => a.nextAt - b.nextAt);
    if (!on.length) return say(s.alarms.length ? 'All your alarms are off.' : "You don't have any alarms.");
    const next = on[0];
    const describe = (a) => `${sayClock(new Date(2000, 0, 1, a.hour, a.minute))}${a.days.length ? ` ${sayDays(a.days)}` : ''}${a.label ? ` called ${a.label}` : ''}`;
    if (on.length === 1) return say(`You have one alarm on: ${describe(next)}. It goes off ${sayWhen(next.nextAt, now())}.`);
    return say(`You have ${on.length} alarms on: ${sayList(on.slice(0, 5).map(describe))}. The next one is ${sayWhen(next.nextAt, now())}.`);
  }

  /** Turn off / turn on / delete an alarm picked by time or label. */
  async function changeAlarm(t, mode) {
    const s = await timerSnapshot();
    const list = mode === 'on' ? s.alarms.filter((a) => !a.enabled) : s.alarms;
    if (!list.length) return say(mode === 'on' ? 'All your alarms are already on.' : "You don't have any alarms.");
    const apply = async (a) => {
      if (mode === 'delete' || (mode === 'off' && !a.days.length && /\b(cancel|delete|remove|clear)\b/.test(t))) {
        await timers.handle('DELETE', ['alarms', a.id], null);
        return 'Deleted';
      }
      await timers.handle('PUT', ['alarms', a.id], { enabled: mode === 'on' });
      return mode === 'on' ? 'Turned on' : 'Turned off';
    };
    const name = (a) => `the ${sayClock(new Date(2000, 0, 1, a.hour, a.minute))} alarm`;
    if (/\b(all|every)\b|\balarms\b/.test(t)) {
      let word = '';
      for (const a of list) word = await apply(a);
      return say(`${word} all ${list.length} alarms.`);
    }
    const clock = parseClock(t);
    const h = clock && hour24(clock);
    const byTime = clock && list.filter((a) => a.minute === clock.minute && (h === null ? a.hour % 12 === clock.hour % 12 : a.hour === h));
    const label = bestMatch(t.replace(/\balarm\b/, ''), list.filter((a) => a.label), (a) => a.label, 0.6);
    const enabled = list.filter((a) => a.enabled);
    const target = byTime?.length === 1 ? byTime[0] : label ?? (list.length === 1 ? list[0] : enabled.length === 1 && mode !== 'on' ? enabled[0] : null);
    if (target) return say(`${await apply(target)} ${name(target)}.`);
    return ask(`Which alarm? ${sayOr(list.slice(0, 4).map((a) => sayClock(new Date(2000, 0, 1, a.hour, a.minute))))}?`, async (answer) => {
      const c = parseClock(/^\d/.test(answer) ? `at ${answer}` : answer);
      if (!c) return null;
      const hh = hour24(c);
      const pick = list.find((a) => a.minute === c.minute && (hh === null ? a.hour % 12 === c.hour % 12 : a.hour === hh));
      return pick ? say(`${await apply(pick)} ${name(pick)}.`) : null;
    });
  }

  // ---- Reminders ----------------------------------------------------------

  /** Reads "remind me to X at/in/on/every ..." into a reminder body, or what's missing. */
  function readReminder(text) {
    let t = text
      .replace(/^(please )?(remind (me|us)|set (a |an )?reminder|create (a |an )?reminder|add (a |an )?reminder|make (a |an )?reminder|new reminder|reminder|do not let me forget|dont let me forget)\b/, '')
      .trim();
    const repeat = parseRepeat(t);
    t = cut(t, repeat);
    const dur = /\bin (an?|\d|half)/.test(t) || /\bfrom now\b/.test(t) ? parseDuration(t) : null;
    if (dur) {
      const lead = /\bin\s+$/.exec(t.slice(0, dur.start));
      t = cut(t, { start: lead ? lead.index : dur.start, end: dur.end }).replace(/\bfrom now\b/, '').trim();
    }
    const day = parseDay(t, now());
    t = cut(t, day);
    const clock = parseClock(t);
    t = cut(t, clock);
    let title = t.replace(/\b(at|on|in|for|by|every)$/, '').trim();
    let toForm = false;
    for (let prev = ''; prev !== title; ) {
      prev = title;
      if (/^to\b/.test(title)) toForm = true;
      title = title.replace(/^(to|that|about|of|for|i need to|i have to|we need to|i should|i must|me)\b\s*/, '').trim();
    }

    const part = day?.part ?? repeat?.part ?? null;
    const partHour = { morning: 9, afternoon: 14, evening: 18, night: 20 }[part] ?? 9;
    let when = null;
    if (dur) {
      when = new Date(Math.ceil((now() + dur.ms) / 60000) * 60000);
    } else if (clock) {
      const c = part && !clock.meridiem && clock.hour <= 12 ? { ...clock, meridiem: part === 'morning' ? 'am' : 'pm' } : clock;
      when = resolveClock(c, now(), day?.date ?? (repeat ? midnight(now()) : null));
      if (repeat && when.getTime() <= now() && !day) when = resolveClock(c, now());
    } else if (day || repeat) {
      const base = day?.date ?? midnight(now());
      when = new Date(base.getFullYear(), base.getMonth(), base.getDate(), partHour, 0);
      if (!day && repeat && when.getTime() <= now()) when = new Date(when.getTime() + 86400000);
    }
    return { title, toForm, when, repeat, hasTime: Boolean(dur || clock || part) };
  }

  async function setReminder(t) {
    const r = readReminder(t);
    if (!r.title) {
      return ask('What should I remind you about?', async (answer) => (r.when ? createReminder(answer, { ...r, toForm: false }) : setReminder(`remind me to ${answer}`)));
    }
    if (!r.when) {
      return ask('When should I remind you?', async (answer) => {
        const again = readReminder(`remind me to ${r.title} ${/^\d/.test(answer) ? `at ${answer}` : answer}`);
        return again.when ? createReminder(r.title, again) : null;
      });
    }
    if (r.when.getTime() <= now() && !r.repeat) {
      return ask(`${sayClock(r.when)} has already passed today. When should I remind you?`, async (answer) => {
        const again = readReminder(`remind me to ${r.title} ${/^\d/.test(answer) ? `at ${answer}` : answer}`);
        return again.when && again.when.getTime() > now() ? createReminder(r.title, again) : null;
      });
    }
    return createReminder(r.title, r);
  }

  async function createReminder(title, r) {
    const rep = r.repeat;
    const body = {
      title: capitalize(title.trim()).slice(0, 120),
      date: ymd(r.when),
      hour: r.when.getHours(),
      minute: r.when.getMinutes(),
      repeat: rep?.repeat ?? 'none',
      interval: rep?.interval ?? 1,
      days: rep?.repeat === 'weekly' ? rep.days : [],
    };
    const s = await reminders.handle('POST', ['reminders'], body);
    const made = s.reminders[s.reminders.length - 1];
    const what = r.toForm ? `to ${title.replace(/\bmy\b/g, 'your')}` : `about ${title.replace(/\bmy\b/g, 'your')}`;
    let when;
    if (rep) {
      const time = sayClock(r.when);
      const every =
        rep.repeat === 'weekly' && rep.days.length
          ? sayDays(rep.days)
          : rep.interval > 1
            ? `every ${rep.interval} ${{ hourly: 'hours', daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' }[rep.repeat]}`
            : { hourly: 'every hour', daily: 'every day', weekly: 'every week', monthly: 'every month', yearly: 'every year' }[rep.repeat];
      when = `${every} at ${time}${made?.nextAt ? `, starting ${sayDay(made.nextAt, now())}` : ''}`;
    } else {
      when = sayWhen(r.when.getTime(), now());
    }
    const guessed = r.hasTime ? '' : ' Say a time next time if you want a different one.';
    return say(`OK, I'll remind you ${what} ${when}.${guessed}`);
  }

  async function listReminders(t) {
    const s = await reminderSnapshot();
    const day = parseDay(t, now());
    let list = s.reminders.filter((r) => !r.completedAt && (r.state === 'due' || r.state === 'snoozed' || (r.enabled && r.nextAt)));
    list.sort((a, b) => (a.state === 'due' ? 0 : a.nextAt ?? Infinity) - (b.state === 'due' ? 0 : b.nextAt ?? Infinity));
    if (day) {
      const start = day.date.getTime();
      list = list.filter((r) => r.state === 'due' || (r.nextAt >= start && r.nextAt < start + 86400000));
    }
    if (!list.length) return say(day ? `You don't have any reminders ${sayDay(day.date, now())}.` : "You don't have any reminders.");
    const items = list.slice(0, 5).map((r) => (r.state === 'due' ? `${r.title}, due now` : `${r.title} ${sayWhen(r.state === 'snoozed' ? r.snoozeUntil : r.nextAt, now())}`));
    const more = list.length > 5 ? `, and ${list.length - 5} more` : '';
    return say(`You have ${list.length} reminder${list.length === 1 ? '' : 's'}${day ? ` ${sayDay(day.date, now())}` : ''}: ${sayList(items)}${more}.`);
  }

  async function reminderDone(t) {
    const s = await reminderSnapshot();
    const due = s.reminders.filter((r) => r.state === 'due' || r.state === 'snoozed');
    const words = t.replace(/\b(mark|the|reminder|reminders|as|done|complete|completed|finished|i|did|it|to|about)\b/g, '').trim();
    const target = words ? bestMatch(words, s.reminders.filter((r) => !r.completedAt), (r) => r.title, 0.6) : null;
    const list = target ? [target] : due;
    if (!list.length) return say('No reminders are due.');
    for (const r of list) await reminders.handle('POST', ['reminders', r.id, 'done'], {});
    return say(list.length === 1 ? `Marked ${list[0].title} done.` : `Marked ${list.length} reminders done.`);
  }

  async function deleteReminder(t) {
    const s = await reminderSnapshot();
    const open = s.reminders.filter((r) => !r.completedAt);
    if (!open.length) return say("You don't have any reminders.");
    if (/\b(all|every)\b/.test(t)) {
      return ask(`Delete all ${open.length} reminders?`, async (answer) => {
        if (/^(no|nope|nah|dont|do not|keep|stop)\b/.test(answer)) return say('OK, I kept them.');
        if (!/^(yes|yeah|yep|sure|ok|okay|do it|delete them|confirm|go ahead)\b/.test(answer)) return null;
        for (const r of open) await reminders.handle('DELETE', ['reminders', r.id], null);
        return say(`Deleted ${open.length} reminders.`);
      });
    }
    const words = t.replace(/\b(cancel|delete|remove|clear|forget|my|the|reminder|reminders|to|about|for)\b/g, '').trim();
    const target = words ? bestMatch(words, open, (r) => r.title, 0.55) : open.length === 1 ? open[0] : null;
    if (!target) return fail(words ? `I couldn't find a reminder about ${words}.` : 'Which reminder? Say, delete the reminder to call Mom.');
    await reminders.handle('DELETE', ['reminders', target.id], null);
    return say(`Deleted the reminder ${target.title}.`);
  }

  // ---- Lists ----------------------------------------------------------------

  const TODO_DEFAULT = {
    lists: [
      { id: 'todo', name: 'To-do', items: [] },
      { id: 'groceries', name: 'Groceries', items: [] },
    ],
  };
  async function loadLists() {
    const s = await readStore('todo', null);
    return Array.isArray(s?.lists) && s.lists.length ? s : structuredClone(TODO_DEFAULT);
  }
  const saveLists = (s) => writeStore('todo', s);
  const newId = () => crypto.randomBytes(6).toString('hex');

  /** A list name as said, or null for "the list" / "my list". */
  const listArg = (name) => (name && simplify(String(name).replace(/\blists?\b/g, '')) ? String(name).replace(/\blists?\b/g, '').trim() : null);

  /** The list a name refers to ("grocery", "my to do", "hardware store"). */
  function findList(lists, name) {
    const n = simplify(String(name ?? '').replace(/\blists?\b/g, ''));
    if (!n) return null;
    if (GROCERY_WORDS.test(n)) {
      return lists.find((l) => /grocer|shopping/i.test(l.name)) ?? bestMatch('groceries', lists, (l) => l.name, 0.7);
    }
    if (TODO_WORDS.test(n)) return lists.find((l) => /^to-?\s?do/i.test(l.name)) ?? bestMatch('to do', lists, (l) => l.name, 0.7);
    return bestMatch(n, lists, (l) => l.name, 0.75);
  }

  function splitItems(text) {
    return text
      .split(/\s+and\s+|\s*,\s*/)
      .map((s) => s.replace(/^(some|more|the|a few|another|extra)\s+/, '').trim())
      .filter((s) => s && !/^(and|or)$/.test(s))
      .map(capitalize);
  }

  async function addToList(itemsText, listName) {
    listName = listArg(listName);
    const s = await loadLists();
    const items = splitItems(itemsText);
    if (!items.length) return fail('What should I add?');
    let list = listName ? findList(s.lists, listName) : null;
    if (listName && !list) {
      return fail(`There's no ${capitalize(listName)} list. Your lists are ${sayList(s.lists.map((l) => l.name))}. Say, create a list called ${listName}, to make one.`);
    }
    if (!list) {
      if (s.lists.length === 1) list = s.lists[0];
      else {
        return ask(`Which list, ${sayOr(s.lists.map((l) => l.name))}?`, async (answer) => {
          const pick = findList(s.lists, answer);
          return pick ? addToList(itemsText, pick.name) : null;
        });
      }
    }
    const added = [];
    const already = [];
    for (const text of items) {
      const existing = list.items.find((i) => simplify(i.text) === simplify(text));
      if (existing && !existing.done) already.push(existing.text);
      else if (existing) {
        existing.done = false;
        delete existing.doneAt;
        added.push(text);
      } else {
        list.items.unshift({ id: newId(), text, done: false });
        added.push(text);
      }
    }
    if (added.length) await saveLists(s);
    const parts = [];
    if (added.length) parts.push(`Added ${sayList(added.map((x) => x.toLowerCase()))} to ${list.name}.`);
    if (already.length) parts.push(`${capitalize(sayList(already.map((x) => x.toLowerCase())))} ${already.length === 1 ? 'is' : 'are'} already on it.`);
    return say(parts.join(' '), { action: { type: 'widget', widget: 'todo', quiet: true } });
  }

  async function removeFromList(itemsText, listName, mode) {
    listName = listArg(listName);
    const s = await loadLists();
    const lists = listName ? [findList(s.lists, listName)].filter(Boolean) : s.lists;
    if (listName && !lists.length) return fail(`There's no ${listName} list.`);
    const done = [];
    const missing = [];
    for (const text of splitItems(itemsText)) {
      let hit = null;
      for (const l of lists) {
        const item = bestMatch(text, l.items.filter((i) => mode === 'remove' || !i.done), (i) => i.text, 0.7);
        if (item) {
          hit = { l, item };
          break;
        }
      }
      if (!hit) {
        missing.push(text.toLowerCase());
        continue;
      }
      if (mode === 'remove') hit.l.items = hit.l.items.filter((i) => i !== hit.item);
      else Object.assign(hit.item, { done: true, doneAt: now() });
      done.push({ text: hit.item.text.toLowerCase(), list: hit.l.name });
    }
    if (done.length) await saveLists(s);
    const parts = [];
    if (done.length) {
      const where = [...new Set(done.map((d) => d.list))];
      parts.push(`${mode === 'remove' ? 'Removed' : 'Checked off'} ${sayList(done.map((d) => d.text))}${where.length === 1 ? ` ${mode === 'remove' ? 'from' : 'on'} ${where[0]}` : ''}.`);
    }
    if (missing.length) parts.push(`I couldn't find ${sayList(missing)}${listName ? ` on ${lists[0].name}` : ''}.`);
    return done.length ? say(parts.join(' ')) : fail(parts.join(' '));
  }

  async function readList(listName) {
    listName = listArg(listName);
    const s = await loadLists();
    let list = listName ? findList(s.lists, listName) : null;
    if (!list && listName) return fail(`There's no ${listName} list. Your lists are ${sayList(s.lists.map((l) => l.name))}.`);
    if (!list) {
      if (s.lists.length === 1) list = s.lists[0];
      else {
        const counts = s.lists.map((l) => {
          const n = l.items.filter((i) => !i.done).length;
          return `${l.name} with ${n ? `${n} item${n === 1 ? '' : 's'}` : 'nothing on it'}`;
        });
        return say(`You have ${s.lists.length} lists: ${sayList(counts)}.`);
      }
    }
    const open = list.items.filter((i) => !i.done);
    if (!open.length) return say(`Your ${list.name} list is empty.`);
    const shown = open.slice(0, 12).map((i) => i.text.toLowerCase());
    const more = open.length > 12 ? `, and ${open.length - 12} more` : '';
    return say(`${list.name} has ${open.length} item${open.length === 1 ? '' : 's'}: ${sayList(shown)}${more}.`);
  }

  async function clearList(t, listName) {
    listName = listArg(listName);
    const s = await loadLists();
    const list = listName ? findList(s.lists, listName) : s.lists.length === 1 ? s.lists[0] : null;
    if (!list) return fail(listName ? `There's no ${listName} list.` : `Which list? Say, clear the grocery list.`);
    if (/\b(checked|done|completed|crossed off|finished|bought|ticked)\b/.test(t)) {
      const n = list.items.filter((i) => i.done).length;
      list.items = list.items.filter((i) => !i.done);
      if (n) await saveLists(s);
      return say(n ? `Cleared ${n} checked item${n === 1 ? '' : 's'} from ${list.name}.` : `Nothing is checked on ${list.name}.`);
    }
    if (!list.items.length) return say(`${list.name} is already empty.`);
    return ask(`Clear all ${list.items.length} items from ${list.name}?`, async (answer) => {
      if (/^(no|nope|nah|dont|do not|keep|stop)\b/.test(answer)) return say(`OK, I left ${list.name} alone.`);
      if (!/^(yes|yeah|yep|sure|ok|okay|do it|clear it|go ahead|confirm)\b/.test(answer)) return null;
      const fresh = await loadLists();
      const l = fresh.lists.find((x) => x.id === list.id);
      if (l) l.items = [];
      await saveLists(fresh);
      return say(`Cleared ${list.name}.`);
    });
  }

  async function createList(name) {
    const s = await loadLists();
    const clean = capitalize(name.replace(/\blist\b/, '').trim()).slice(0, 40);
    if (!clean) return fail('What should the list be called?');
    if (findList(s.lists, clean)) return say(`You already have a ${clean} list.`);
    s.lists.push({ id: newId(), name: clean, items: [] });
    await saveLists(s);
    return say(`Created the ${clean} list.`);
  }

  // ---- Calendar -----------------------------------------------------------

  async function calendarReport(t) {
    if (/\b(add|create|schedule|make|put|new)\b.*\b(event|appointment|meeting|calendar)\b/.test(t)) {
      return fail("I can't add calendar events. Add them in Google Calendar and they'll show up here.");
    }
    const today = midnight(now());
    let from;
    let to;
    let label;
    const day = parseDay(t, now());
    const nextOnly = /\b(next|upcoming|coming up)\b/.test(t) && !day;
    if (nextOnly) {
      from = now();
      to = today.getTime() + 14 * 86400000;
    } else if (/\b(this week|the week|next 7 days|this weekend|weekend)\b/.test(t)) {
      const weekend = /weekend/.test(t);
      const start = weekend ? new Date(today.getFullYear(), today.getMonth(), today.getDate() + ((6 - today.getDay() + 7) % 7)) : today;
      from = weekend && today.getDay() === 0 ? today.getTime() : start.getTime();
      to = weekend ? (today.getDay() === 0 ? today.getTime() + 86400000 : start.getTime() + 2 * 86400000) : today.getTime() + 7 * 86400000;
      label = weekend ? 'this weekend' : 'this week';
    } else {
      const d = day?.date ?? today;
      from = d.getTime();
      to = d.getTime() + 86400000;
      label = sayDay(d, now());
    }
    const data = await calendar.get({ from: String(Math.floor(from)), to: String(Math.floor(to)), tz: zone });
    if (!data.configured) return fail("No calendars are connected yet. They're set up with deploy/calendars.ps1.");
    const events = data.events;
    const startOf = (e) => (e.allDay ? new Date(`${e.start}T00:00:00`).getTime() : e.start);
    const describe = (e, withDay) =>
      e.allDay
        ? `${e.title}${withDay ? ` ${sayDay(startOf(e), now())}` : ''}, all day`
        : `${e.title} ${withDay ? sayWhen(e.start, now()) : `at ${sayClock(e.start)}`}`;
    if (nextOnly) {
      const next = events.find((e) => !e.allDay && e.start >= now()) ?? events[0];
      if (!next) return say('Nothing is on your calendar for the next two weeks.');
      return say(`Your next event is ${describe(next, true)}.`);
    }
    if (!events.length) return say(`Nothing is on your calendar ${label}.`);
    const multiDay = to - from > 86400000;
    const items = events.slice(0, 6).map((e) => describe(e, multiDay));
    const more = events.length > 6 ? `, and ${events.length - 6} more` : '';
    return say(`You have ${events.length} event${events.length === 1 ? '' : 's'} ${label}: ${sayList(items)}${more}.`);
  }

  // ---- Music ----------------------------------------------------------------

  async function spotifyReady() {
    const st = await spotify.status();
    if (!st.connected) return fail("Spotify isn't connected yet. Sign in from the Spotify tile.");
    return null;
  }

  async function pauseMusicIfPlaying() {
    try {
      const st = await spotify.status();
      if (!st.connected) return false;
      const p = await spotify.player();
      if (!p.player?.isPlaying) return false;
      await spotify.control('pause');
      return true;
    } catch {
      return false;
    }
  }

  async function nowPlaying() {
    const notReady = await spotifyReady();
    if (notReady) return notReady;
    const p = (await spotify.player()).player;
    if (!p?.item) return say('Nothing is playing right now.');
    const by = p.item.artists?.length ? ` by ${sayList(p.item.artists.slice(0, 2))}` : '';
    return say(`${p.isPlaying ? 'This is' : 'Paused on'} ${p.item.name}${by}${p.device?.name && p.device.name !== 'PiDisplay' ? `, on ${p.device.name}` : ''}.`);
  }

  async function musicControl(action, body = {}, reply = 'OK.') {
    const notReady = await spotifyReady();
    if (notReady) return notReady;
    await spotify.control(action, body);
    return say(reply, { quiet: true });
  }

  async function playMusic(query, shuffle = false) {
    const notReady = await spotifyReady();
    if (notReady) return notReady;
    const target = {};
    let q = query
      .replace(/\b(on spotify|from spotify|please)\b/g, '')
      .replace(/^(me )?(some|a little|a bit of|any)\s+/, '')
      .trim();
    // "play jazz on the kitchen speaker": start it there.
    const on = / (?:on|in|through) (?:the |my )?([a-z ]+?)$/.exec(q);
    if (on) {
      const sp = await findSpeaker(on[1]);
      if (sp.device) {
        target.deviceId = sp.device.id;
        q = q.slice(0, on.index).trim();
      } else if (sp.output) {
        await audio.select(sp.output.name);
        if (sp.piDevice) target.deviceId = sp.piDevice.id;
        q = q.slice(0, on.index).trim();
      }
    }

    if (!q || /^(music|some music|something|songs|tunes|anything|it|again|the music|my music|spotify)$/.test(q)) {
      await spotify.control('play', target);
      if (shuffle) await spotify.control('shuffle', { on: true });
      return say('OK.', { quiet: true });
    }
    let kind = null;
    let m;
    if ((m = /^(?:the )?(album|record)\s+(.+)$/.exec(q)) || (m = /^(.+?)\s+(album|record)$/.exec(q))) {
      kind = 'album';
      q = m[1] === 'album' || m[1] === 'record' ? m[2] : m[1];
    } else if ((m = /^(?:my |the )?(?:playlist|play list)\s+(?:called\s+)?(.+)$/.exec(q)) || (m = /^(?:my |the )?(.+?)\s+(?:playlist|play list)$/.exec(q))) {
      kind = 'playlist';
      q = m[1];
    } else if ((m = /^(?:the )?(?:artist|band|music by|songs by|something by|stuff by)\s+(.+)$/.exec(q))) {
      kind = 'artist';
      q = m[1];
    } else if ((m = /^(?:the )?(?:song|track)\s+(.+)$/.exec(q))) {
      kind = 'track';
      q = m[1];
    } else if (/^(?:music|songs|something)\s+by\s+/.test(q)) {
      kind = 'artist';
      q = q.replace(/^(?:music|songs|something)\s+by\s+/, '');
    }
    q = q.trim();

    // Your own playlists first: "play my chill playlist", or a plain name that matches one.
    if (kind === 'playlist' || !kind) {
      const mine = await spotify.playlists().catch(() => []);
      const pl = bestMatch(q, mine, (p) => p.name, kind === 'playlist' ? 0.7 : 0.9);
      if (pl) return startPlaying({ contextUri: pl.uri }, `your ${pl.name} playlist`, shuffle, target);
    }
    const byMatch = /^(.+?)\s+by\s+(.+)$/.exec(q);
    const found = await spotify.search(byMatch && kind !== 'album' ? `track:${byMatch[1]} artist:${byMatch[2]}` : q);
    if (byMatch && kind !== 'album' && !found.tracks.length) Object.assign(found, await spotify.search(`${byMatch[1]} ${byMatch[2]}`));

    const artist = found.artists[0];
    if (kind === 'artist' || (!kind && !byMatch && artist && similarity(q, artist.name) >= 0.85)) {
      if (!artist) return fail(`I couldn't find ${q} on Spotify.`);
      return startPlaying({ contextUri: artist.uri }, artist.name, shuffle, target);
    }
    if (kind === 'album') {
      const album = found.albums[0];
      if (!album) return fail(`I couldn't find the album ${q}.`);
      return startPlaying({ contextUri: album.uri }, `${album.name} by ${album.artists?.[0] ?? 'unknown'}`, shuffle, target);
    }
    if (kind === 'playlist') {
      const pl = found.playlists[0];
      if (!pl) return fail(`I couldn't find a playlist called ${q}.`);
      return startPlaying({ contextUri: pl.uri }, `the ${pl.name} playlist`, shuffle, target);
    }
    // Best fit by name: a song, an album, then a playlist (genres and moods like "jazz"
    // usually match a playlist); otherwise Spotify's top song.
    const track = found.tracks[0];
    const bare = q.replace(/\b(music|songs)\b/, '').trim() || q;
    const album = found.albums[0];
    const list = found.playlists[0];
    if (!byMatch && !(track && similarity(q, track.name) >= 0.85)) {
      if (album && similarity(bare, album.name) >= 0.9) return startPlaying({ contextUri: album.uri }, `${album.name} by ${album.artists?.[0] ?? 'unknown'}`, shuffle, target);
      if (list && similarity(bare, list.name) >= 0.9) return startPlaying({ contextUri: list.uri }, `the ${list.name} playlist`, shuffle, target);
    }
    if (track) {
      // Play from its album so music keeps going after the song.
      const body = track.albumUri ? { contextUri: track.albumUri, offsetUri: track.uri } : { uris: [track.uri] };
      return startPlaying(body, `${track.name} by ${track.artists?.[0] ?? 'unknown'}`, shuffle, target);
    }
    const fallback = found.playlists[0] ?? found.albums[0];
    if (fallback) return startPlaying({ contextUri: fallback.uri }, fallback.name, shuffle, target);
    return fail(`I couldn't find ${q} on Spotify.`);
  }

  async function startPlaying(body, what, shuffle, target = {}) {
    await spotify.control('play', { ...body, ...target });
    if (shuffle) await spotify.control('shuffle', { on: true }).catch(() => {});
    return say(`Playing ${what}${shuffle ? ' on shuffle' : ''}.`, { action: { type: 'widget', widget: 'spotify', quiet: true } });
  }

  /**
   * The speaker a name means: a Spotify Connect device ("kitchen speaker", "phone")
   * or one of the Pi's outputs ("display", "bluetooth", "headphones"). Null if none.
   */
  async function findSpeaker(target) {
    const name = target.replace(/\b(the|my|speakers?|device|please)\b/g, ' ').replace(/\s+/g, ' ').trim() || target;
    const here = /^(here|this|display|screen|pi|pi display|piboy|tv|monitor|hdmi|wall)$/.test(name);
    const st = await spotify.status().catch(() => ({ connected: false }));
    const devices = st.connected ? (await spotify.player().catch(() => ({ devices: [] }))).devices : [];
    if (!here) {
      const dev = bestMatch(name, devices, (d) => d.name, 0.7);
      if (dev) return { name, device: dev };
    }
    const outputs = audio.supported ? (await audio.status().catch(() => ({ outputs: [] }))).outputs : [];
    const kind = /\b(bluetooth|bt)\b/.test(name) ? 'bluetooth' : here ? 'hdmi' : /\b(headphones?|jack|aux)\b/.test(name) ? 'analog' : null;
    const out = (kind && outputs.find((o) => o.kind === kind)) ?? bestMatch(name, outputs, (o) => o.label, 0.6);
    if (out) return { name, output: out, piDevice: devices.find((d) => d.name === 'PiDisplay') ?? null };
    return { name, missing: true, outputs };
  }

  /** "play music on the kitchen speaker", "switch to the display speakers". */
  async function moveAudio(target, sure = true) {
    const sp = await findSpeaker(target);
    // "switch to the weather page" isn't about speakers; let the other phrases try.
    if (!sp.device && !sp.output && !sure && !/\b(speakers?|bluetooth|headphones?)\b/.test(target)) return null;
    if (sp.device) {
      await spotify.control('transfer', { deviceId: sp.device.id, play: true });
      return say(`Playing on ${sp.device.name}.`);
    }
    if (sp.output) {
      await audio.select(sp.output.name);
      // Music playing on a phone comes over to the Pi too.
      if (sp.piDevice && !sp.piDevice.active) await spotify.control('transfer', { deviceId: sp.piDevice.id, play: true }).catch(() => {});
      return say(`Sound is now on ${sp.output.label}.`);
    }
    if (!audio.supported) return fail('Switching speakers only works on the Pi.');
    const names = sp.outputs.map((o) => o.label);
    return fail(`I couldn't find a speaker called ${sp.name}.${names.length ? ` You have ${sayList(names)}.` : ''}`);
  }

  // ---- Volume -------------------------------------------------------------

  async function volume(t) {
    if (!audio.supported) return fail('Volume control only works on the Pi.');
    const { outputs } = await audio.status();
    const out = outputs.find((o) => o.active) ?? outputs[0];
    if (!out) return fail("I can't find a speaker.");
    const current = out.muted ? 0 : out.volume ?? 50;
    let next = null;
    if (/\bunmute\b|\bturn (the )?(sound|volume) back on\b/.test(t)) next = mutedVolume ?? 50;
    else if (/\bmute\b/.test(t)) {
      if (current > 0) mutedVolume = current;
      await audio.setVolume(out.name, 0);
      return say('', { quiet: true });
    } else {
      const set = /\b(?:volume|it|sound)\s+(?:to\s+|at\s+)?(\d{1,3})(\s*percent)?\b|\bset (?:the )?volume (?:to |at )?(\d{1,3})(\s*percent)?\b|\bvolume (\d{1,3})\b/.exec(t);
      if (set) {
        const n = Number(set[1] ?? set[3] ?? set[5]);
        const pct = Boolean(set[2] ?? set[4]);
        next = !pct && n <= 10 ? n * 10 : n;
      } else if (/\b(max|maximum|full|all the way up)\b/.test(t)) next = 100;
      else if (/\bhalf\b/.test(t)) next = 50;
      else {
        const step = /\b(a (little|bit|touch)|slightly)\b/.test(t) ? 5 : /\b(a lot|way|much)\b/.test(t) ? 20 : 10;
        const up = /\b(up|louder|raise|increase|higher|cant hear|can not hear|more)\b/.test(t);
        const down = /\b(down|quieter|softer|lower|decrease|too loud|less)\b/.test(t);
        if (!up && !down) return say(`The volume is ${current}.`);
        next = current + (up ? step : -step);
      }
    }
    next = Math.max(0, Math.min(100, Math.round(next)));
    if (next === 0 && current > 0) mutedVolume = current;
    await audio.setVolume(out.name, next);
    return say(`Volume ${next}.`, { quiet: true });
  }

  // ---- Stocks ---------------------------------------------------------------

  async function stockReport(t) {
    const s = await stocks.handle('GET', ['stocks'], null);
    const quotes = s.symbols.map((sym) => ({ sym, q: s.quotes[sym] })).filter((x) => x.q && x.q.price !== undefined && x.q.price !== null);
    if (!s.symbols.length) return say('Your watchlist is empty. Add stocks on the Stocks tile.');
    const plainName = (x) => String(x.q.name ?? x.sym).replace(/,?\s+(inc|incorporated|corp|corporation|company|co|class [a-c]|holdings|platforms|group|ltd|plc|n\.?v\.?|s\.?a\.?)\b.*$/i, '').trim();
    const describe = (x) => {
      const pct = x.q.changePct;
      const move = pct === null || pct === undefined ? '' : Math.abs(pct) < 0.05 ? ', flat today' : `, ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(1)} percent`;
      return `${plainName(x)} is at ${money(x.q.price, x.q.currency)}${move}`;
    };
    // Spelled tickers: "a a p l" -> aapl.
    const letters = /\b((?:[a-z] ){1,4}[a-z])\b/.exec(t)?.[1]?.replace(/ /g, '') ?? null;
    const words = t.replace(/\b(how|is|are|what|whats|the|stock|stocks|share|shares|price|of|doing|today|at|trading|my|for|how is|tell me|about)\b/g, ' ').replace(/\s+/g, ' ').trim();
    const one =
      (letters && quotes.find((x) => x.sym.toLowerCase() === letters)) ||
      quotes.find((x) => new RegExp(`\\b${x.sym.toLowerCase()}\\b`).test(t)) ||
      (words ? bestMatch(words, quotes, plainName, 0.7) : null);
    if (one) return say(`${describe(one)}.`);
    if (words && !/^(market|portfolio|watchlist|stock market|the market|my stocks|stocks)?$/.test(words) && !/\b(market|portfolio|watchlist)\b/.test(t)) {
      return fail(`${capitalize(words)} isn't on your watchlist. Add it on the Stocks tile.`);
    }
    if (!quotes.length) return fail("I don't have stock prices right now.");
    const open = s.marketOpen ? 'The market is open.' : 'The market is closed.';
    return say(`${open} ${quotes.slice(0, 5).map(describe).join('. ')}.`);
  }

  // ---- News -----------------------------------------------------------------

  async function newsReport(t) {
    const configs = await widgetConfig('news');
    const home = await readStore('home', null).catch(() => null);
    const location =
      configs.map((c) => String(c.location ?? '').trim()).find(Boolean) ||
      String(home?.newsLocation || home?.location || '').trim();
    const section = /\b(local|around here|nearby|my area|city)\b/.test(t)
      ? 'local'
      : /\b(state|california)\b/.test(t)
        ? 'state'
        : /\b(us|u s|national|america|american|united states|country)\b/.test(t)
          ? 'us'
          : 'world';
    const data = await news.get({ sections: section, location });
    const sec = data.sections[0];
    const items = (sec?.items ?? []).slice(0, 3);
    if (!items.length) return fail(sec?.error ? `I couldn't get the news: ${sec.error}` : 'There are no headlines right now.');
    const clean = (i) => (i.source ? i.title.replace(new RegExp(`\\s+[-–|]\\s+${i.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '') : i.title);
    return say(`Here are the top ${sec.label ?? section} headlines. ${items.map((i) => `${clean(i)}${i.source ? `, from ${i.source}` : ''}.`).join(' ')}`);
  }

  // ---- Notifications, fares, system --------------------------------------------

  async function readNotifications() {
    const list = await notifications.list();
    const recent = list.filter((n) => now() - Date.parse(n.time) < 24 * 3600000);
    if (!recent.length) return say('No new notifications today.');
    const items = recent.slice(0, 3).map((n) => `${n.title.replace(/^\W+\s*/, '')}${n.body ? `. ${n.body}` : ''}`);
    return say(`You have ${recent.length} notification${recent.length === 1 ? '' : 's'} from today. ${items.join('. ')}.`);
  }

  async function clearNotifications() {
    await notifications.clear();
    return say('Cleared your notifications.');
  }

  async function faresReport() {
    const f = await readFares().catch(() => null);
    if (!f) return fail("Farewatcher hasn't sent any fares yet.");
    const deals = [...(f.deals ?? [])].sort((a, b) => a.price - b.price);
    const currency = f.currency || 'USD';
    if (deals.length) {
      const d = deals[0];
      const when = d.departDate ? `, leaving ${new Date(`${d.departDate}T12:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}` : '';
      const others = deals.length > 1 ? ` There are ${deals.length - 1} other deals on the Fares tile.` : '';
      return say(`The best deal is ${d.origin ? `${d.origin} to ` : ''}${d.name ?? d.code} for ${money(d.price, currency)}${when}.${others}`);
    }
    const lows = (f.destinations ?? []).filter((d) => d.low?.price).sort((a, b) => a.low.price - b.low.price);
    if (!lows.length) return say('No fare deals right now.');
    return say(`No deals below your targets yet. The cheapest fare is ${lows[0].name ?? lows[0].code} for ${money(lows[0].low.price, currency)}.`);
  }

  async function systemReport(t) {
    const s = await system.get();
    if (/\bip( address)?\b/.test(t)) return s.ip ? say(`My IP address is ${s.ip}.`) : fail("I don't have a network address right now.");
    if (/\b(uptime|been (on|running|up))\b/.test(t)) return say(`I've been running for ${sayDuration(Math.floor(s.uptime / 60) * 60000)}.`);
    const parts = [];
    if (s.temperature !== null && s.temperature !== undefined) parts.push(`the Pi is at ${Math.round(s.temperature)} degrees Celsius`);
    if (s.cpu?.usage !== null && s.cpu?.usage !== undefined) parts.push(`the CPU is ${Math.round(s.cpu.usage)} percent busy`);
    if (s.memory?.total) parts.push(`memory is ${Math.round((s.memory.used / s.memory.total) * 100)} percent used`);
    if (s.disk?.total) parts.push(`the disk is ${Math.round((s.disk.used / s.disk.total) * 100)} percent full`);
    const warn = s.power?.undervoltageNow || s.power?.underVoltage ? ' The power supply is too weak right now.' : '';
    if (!parts.length) return fail("I can't read the Pi's stats here.");
    return say(`${capitalize(sayList(parts))}.${warn}`);
  }

  // ---- Screen ---------------------------------------------------------------

  async function setTheme(theme) {
    const saved = (await readStore('app.settings', {}).catch(() => ({}))) ?? {};
    await writeStore('app.settings', { ...saved, theme });
    return say(`${theme === 'dark' ? 'Dark' : 'Light'} mode.`, { quiet: true });
  }

  /** "show the weather", "go to music", "open my grocery list", "go home". */
  async function navigate(target) {
    const l = await layout();
    const name = target.replace(/\b(page|screen|tile|tab|widget|please)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (/^(home|start|beginning|main|1st|first)$/.test(name)) {
      const i = Math.max(0, l.pages.findIndex((p) => /^home$/i.test(p.name)));
      return say('', { action: { type: 'page', index: i, name: l.pages[i]?.name ?? '' } });
    }
    const nth = /^(\d+)(?:st|nd|rd|th)?$/.exec(name) ?? /^(?:number )(\d+)$/.exec(name);
    if (nth) {
      const i = Number(nth[1]) - 1;
      if (i >= 0 && i < l.pages.length) return say('', { action: { type: 'page', index: i, name: l.pages[i].name } });
      return fail(`There are only ${l.pages.length} pages.`);
    }
    if (/^last$/.test(name)) return say('', { action: { type: 'page', index: l.pages.length - 1, name: l.pages.at(-1)?.name ?? '' } });
    const page = bestMatch(name, l.pages, (p) => p.name, 0.8);
    if (page) return say('', { action: { type: 'page', index: l.pages.indexOf(page), name: page.name } });
    const widget = WIDGET_WORDS.find(([, re]) => re.test(name))?.[0];
    if (widget) {
      const i = l.pages.findIndex((p) => p.tiles.some((x) => x.widget === widget));
      // A grocery list request lands on the page whose to-do tile shows that list when we can tell.
      if (i >= 0) return say('', { action: { type: 'page', index: i, name: l.pages[i].name } });
      return fail(`There's no tile for ${WIDGET_NAMES[widget]} on any page. Add one in edit mode.`);
    }
    if (page === null && l.pages.length) return fail(`I couldn't find a ${name} page. Your pages are ${sayList(l.pages.map((p) => p.name))}.`);
    return fail(`I couldn't find ${name}.`);
  }

  function help() {
    return say(
      'You can ask about the weather, the time, your calendar and the news; set timers, alarms and reminders; add things to your lists; play music and change the volume; or move between pages. Here are some things to try.',
      { action: { type: 'help' } },
    );
  }

  // ---- The phrase book: first match wins ------------------------------------

  const re = (pattern) => (t) => pattern.exec(t);
  const LIST_WORD = '(?:the |my |our |a )?([a-z][a-z ]*?)(?: list)?';

  const INTENTS = [
    { match: re(/^(help|what can (i|you) (say|do|ask)( you)?|what can you do|what (are|are the) commands|how do (i|you) (use|work) (this|you)|list (the )?commands|show (me )?(the )?commands|what do you do)$/), run: () => help() },
    { match: re(/^(never ?mind|nevermind|forget it|nothing|no thanks|stop listening|go away|ignore (that|me)|sorry|wrong|not you|i was not talking to you)$/), run: () => say('OK.', { quiet: true }) },

    // Ringing alarms and timers first: "stop" must always work.
    { match: re(/^snooze\b|^(remind me|ask me) again\b(?! to)/), run: (m, t) => snooze(t) },
    {
      match: re(/^(stop|stop it|stop that|cancel|dismiss|dismiss (it|that|the alarm|the timer|the reminder)|silence|shut up|quiet|be quiet|enough|off|i am (up|awake)|im (up|awake)|stop (the )?(alarm|alarms|timer|ringing|beeping|sound|noise)|turn (it|that) off|turn off (the )?(alarm|timer|ringing|beeping)|okay stop)$/),
      run: async (m, t) => {
        // "turn off the alarm" with nothing ringing means the alarm setting.
        if (/\b(alarm|timer)\b/.test(t) && !(await ringingItems()).length && !(await dueReminders()).length) {
          return /\btimer\b/.test(t) ? withTimer(t, 'cancel', ['running', 'paused', 'snoozed'], (x) => timers.handle('DELETE', ['timers', x.id], null)) : changeAlarm(t, 'off');
        }
        return stop(t);
      },
    },

    // Reminders before timers/alarms/lists: "remind me to set the alarm".
    { match: re(/^(remind (me|us)|set (a |an )?reminder|create (a |an )?reminder|add (a |an )?reminder|make (a |an )?reminder|new reminder|reminder (to|for|at|in|on)|do not let me forget|dont let me forget)\b/), run: (m, t) => setReminder(t) },
    { match: re(/^(cancel|delete|remove|clear|forget)\b.*\breminders?\b/), run: (m, t) => deleteReminder(t) },
    { match: re(/\b(what|which|any|list|read|check|show me)\b.*\breminders?\b|\bdo i have (any )?reminders\b|\bmy reminders\b/), run: (m, t) => (/^(show|open|go to)\b/.test(t) ? readListOrNavigate('reminders') : listReminders(t)) },
    { match: re(/^(done|i did it|i did that|it is done|its done|finished|completed|mark (it|that) (as )?(done|complete))$|^mark\b.*\breminder\b.*\b(done|complete|completed)$|\breminder\b.*\b(is )?(done|complete)$/), run: (m, t) => reminderDone(t) },

    // Timers.
    { match: re(/^add (.+) (?:to|on) (?:the |my )?(?:[a-z]+ )?timer$/), run: (m, t) => addToTimer(t) },
    { match: re(/\b(how (much|long)( time)?( is)? (left|remaining)|time (left|remaining)|how long (until|till|before|is left)|check (the |my )?timers?|what timers|any timers|timer status|how is (the |my )?timer|when (will|does) (the |my )?timer)\b/), run: (m, t) => timerStatus(t) },
    { match: re(/^(cancel|stop|delete|remove|clear|end|kill|turn off|reset)\b.*\btimers?\b/), run: (m, t) => withTimer(t, 'cancel', ['running', 'paused', 'snoozed', 'ringing'], (x) => timers.handle('DELETE', ['timers', x.id], null)) },
    { match: re(/^(pause|hold|freeze)\b.*\btimers?\b/), run: (m, t) => withTimer(t, 'pause', ['running'], (x) => timers.handle('POST', ['timers', x.id, 'pause'], {})) },
    { match: re(/^(resume|continue|unpause)\b.*\btimers?\b/), run: (m, t) => withTimer(t, 'resume', ['paused'], (x) => timers.handle('POST', ['timers', x.id, 'resume'], {})) },
    { match: re(/^restart\b.*\btimers?\b/), run: (m, t) => withTimer(t, 'restart', ['running', 'paused', 'ringing', 'snoozed'], (x) => timers.handle('POST', ['timers', x.id, 'restart'], {})) },
    { match: re(/\btimer\b|^(count ?down|countdown)\b/), run: (m, t) => setTimer(t) },

    // Alarms.
    { match: re(/^(turn on|enable|switch on|activate|restore)\b.*\balarms?\b/), run: (m, t) => changeAlarm(t, 'on') },
    { match: re(/^(delete|remove)\b.*\balarms?\b/), run: (m, t) => changeAlarm(t, 'delete') },
    { match: re(/^(cancel|clear|turn off|disable|switch off|stop|skip|deactivate)\b.*\balarms?\b/), run: (m, t) => changeAlarm(t, 'off') },
    { match: re(/\b(what|which|any|list|check|when)\b.*\balarms?\b|\bis (my |the |an )?alarm (set|on)\b|\bdo i have (an |any )?alarms?\b/), run: () => alarmStatus() },
    { match: re(/\balarm\b|\bwake (me|us)( up)?\b|\bget me up\b/), run: (m, t) => setAlarm(t) },

    // Lists.
    { match: re(/^(create|make|start|add|new)( a| an)?( new)? list (called |named )?(.+)$/), run: (m) => createList(m[5]) },
    { match: re(/^(create|make|start)( a| an)?( new)? (.+) list$/), run: (m) => createList(m[4]) },
    {
      match: re(/^(?:clear|empty|wipe|reset)\b(.*)$/),
      run: (m, t) => {
        if (!/\blist\b|grocer|shopping|to ?do|\b(checked|done|completed|crossed off|bought)\b/.test(t)) return null;
        const name = m[1].replace(/\b(all|the|my|our|checked|done|completed|crossed off|finished|bought|ticked|items?|things|everything|from|on|off|out|of|list)\b/g, ' ').trim();
        return clearList(t, name || null);
      },
    },
    { match: re(new RegExp(`^(?:add|put|stick|throw|write|include|append) (.+?) (?:to|on|onto|in|into) ${LIST_WORD}$`)), run: (m) => addToList(m[1], m[2]) },
    { match: re(/^(?:add|put) (.+?) (?:to|on) (?:the |my )?list$/), run: (m) => addToList(m[1], null) },
    { match: re(/^(?:we are|we re|were|i am|im) (?:all )?(?:out of|running low on|low on|almost out of) (.+)$|^(?:we|i) ran out of (.+)$|^(?:we|i) need (?:to buy|to get|more|some) (.+)$/), run: (m) => addToList(m[1] ?? m[2] ?? m[3], 'groceries') },
    { match: re(new RegExp(`^(?:remove|delete|take|erase|drop) (.+?) (?:off|from|out of) ${LIST_WORD}$`)), run: (m) => removeFromList(m[1], m[2], 'remove') },
    {
      match: re(/^(?:cross|check|tick|mark|scratch) (.+)$/),
      run: (m, t) => {
        if (!/\b(off|done|bought|complete|completed)\b/.test(t)) return null;
        let rest = m[1];
        const where = / (?:on|from|off|in) (?:the |my |our )?([a-z ]+?)(?: list)?$/.exec(rest);
        let listName = null;
        if (where && (/ list$/.test(rest) || GROCERY_WORDS.test(where[1]) || TODO_WORDS.test(where[1]))) {
          listName = where[1];
          rest = rest.slice(0, where.index);
        }
        rest = rest.replace(/^off /, '').replace(/ (off|done|as done|bought|as bought|complete|as complete|completed)$/, '').trim();
        return rest ? removeFromList(rest, listName, 'check') : null;
      },
    },
    { match: re(/^(?:i|we) (?:bought|got|picked up|grabbed) (.+)$/), run: (m) => removeFromList(m[1], null, 'check') },
    { match: re(new RegExp(`^(?:what is|what are|whats|read(?: me)?|tell me|what do i have|what have i got|show me|check)\\b(?: (?:on|in))? ${LIST_WORD.replace('(?: list)?', ' list')}$`)), run: (m, t) => readListOrShow(t, m[1]) },
    { match: re(/^what (?:do|should) (?:i|we) (?:need|have to)\b(.*)$/), run: (m) => (/^\s*(to )?(buy|get|pick up)?\s*((at|from) )?(the )?(store|grocery store|supermarket|shops?|groceries)?\s*$/.test(m[1]) ? readList('groceries') : null) },
    {
      match: re(/^add (.+)$/),
      run: async (m) => {
        const d = parseDuration(m[1]);
        if (d && d.start === 0 && d.end === m[1].length && (await timerSnapshot()).timers.length) return addToTimer(`add ${m[1]} to the timer`);
        return d ? null : addToList(m[1], null);
      },
    },
    { match: re(/^what lists do i have$|^(?:what are )?my lists$/), run: () => readList(null) },

    // Music (before weather: "play purple rain"). Theme first: "switch to dark mode".
    { match: re(/\b(dark|night) (mode|theme)\b|\b(switch|change|go) to dark\b|\bturn on dark\b|\bturn off light\b/), run: () => setTheme('dark') },
    { match: re(/\b(light|day) (mode|theme)\b|\b(switch|change|go) to light\b|\bturn off dark\b|\bturn on light\b/), run: () => setTheme('light') },
    { match: re(/^(?:play|move|switch|transfer|send|put) (?:the )?(?:music|audio|sound|spotify|it|this|everything)? ?(?:to|on|onto|through|over) (?:the )?(.+?)$/), run: (m, t) => moveAudio(m[1], /^(play|move|transfer|send)\b|\b(music|audio|sound|spotify)\b/.test(t)) },
    { match: re(/^switch (?:the )?(?:sound|audio|output|speakers?) (?:to|over to) (?:the )?(.+)$/), run: (m) => moveAudio(m[1], true) },
    { match: re(/^(pause|stop|stop playing|halt)( the)?( music| song| playback| spotify| track| playing| it| this)?$/), run: (m, t) => (/^stop$/.test(t) ? stop(t) : musicControl('pause', {}, 'Paused.')) },
    { match: re(/^(resume|unpause|continue|keep playing|start (the )?music|play)( (the )?(music|song|playback|spotify|playing))?$/), run: () => musicControl('play', {}) },
    { match: re(/^(next|skip)( this| the| that)?( song| track| one| tune)?$|^(play )?(the )?next (song|track)$/), run: () => musicControl('next', {}, 'Skipping.') },
    { match: re(/^(previous|last)( song| track)?$|^go back a (song|track)$|^(play )?(the )?(previous|last) (song|track)$/), run: () => musicControl('previous', {}, 'OK.') },
    { match: re(/^(go )?back$/), run: () => say('', { action: { type: 'back' } }) },
    { match: re(/^(replay|restart|start over|play again)( this| the)?( song| track)?$/), run: () => musicControl('seek', { positionMs: 0 }, 'OK.') },
    { match: re(/\b(what|which) (song|track|music|artist|album) is (this|playing|on)\b|\bwhat is (playing|this song)\b|\bwhat is on (spotify|the radio)\b|\bwho (is this|sings this|is singing|is playing)\b|\bname (of )?(this|that) song\b|\bwhat song is this\b|^now playing$/), run: () => nowPlaying() },
    { match: re(/\b(turn|switch) (on|off) shuffle\b|\bshuffle (on|off)\b|\b(stop|disable|un) ?shuffl(e|ing)\b|^shuffle$/), run: (m, t) => musicControl('shuffle', { on: !/\b(off|stop|disable|un ?shuffl)/.test(t) }, /\b(off|stop|disable|un ?shuffl)/.test(t) ? 'Shuffle off.' : 'Shuffle on.') },
    { match: re(/\brepeat (this|the) (song|track)\b|\b(turn|switch) (on|off) repeat\b|\brepeat (on|off|all)\b|\bstop repeating\b|\bloop (this|the) (song|track)\b/), run: (m, t) => {
      const mode = /\b(off|stop)\b/.test(t) ? 'off' : /\b(song|track)\b/.test(t) ? 'track' : 'context';
      return musicControl('repeat', { mode }, { off: 'Repeat off.', track: 'Repeating this song.', context: 'Repeat on.' }[mode]);
    } },
    { match: re(/^(?:play|put on|listen to|start playing|i want to (?:hear|listen to)|shuffle)\b ?(.*)$/), run: (m, t) => playMusic(m[1] ?? '', /^shuffle\b/.test(t) || /\bon shuffle$/.test(t)) },

    // Volume.
    { match: re(/\b(volume|louder|quieter|softer|mute|unmute|too loud|cant hear|can not hear)\b|^turn (it|the sound|the music|this) (up|down)\b|^turn (up|down)\b/), run: (m, t) => volume(t) },

    // Screen.
    { match: re(/^(next|forward)( page| screen)$|^(go to the )?next (page|screen)$|^(swipe|go) (left|forward)$/), run: () => say('', { action: { type: 'nextPage' } }) },
    { match: re(/^(previous|back)( page| screen)$|^(go to the )?(previous|last) (page|screen)$|^(swipe|go) right$|^go back a (page|screen)$/), run: () => say('', { action: { type: 'prevPage' } }) },
    { match: re(/\b(stop|pause|freeze|hold) (rotating|rotation|the rotation|changing pages|switching pages|the pages|scrolling)\b|\bstay (here|on this page|on this screen)\b|\b(keep|hold) (this|the) (page|screen)\b|\bdo not (change|switch) (the )?(page|screen)\b/), run: () => say('Staying on this page.', { action: { type: 'hold', minutes: 60 } }) },
    { match: re(/\b(resume|start|restart|continue) (rotating|rotation|the rotation|changing pages|switching pages)\b|\bkeep rotating\b/), run: () => say('OK.', { action: { type: 'resume' } }) },
    { match: re(/^(close|close (it|that|this|the (window|sheet|popup|pop up|panel|menu|settings))|hide (it|that|this)|exit|dismiss (this|the window))$/), run: () => say('', { action: { type: 'close' } }) },
    { match: re(/^(reload|refresh)( the)?( screen| page| display| dashboard)?$/), run: () => say('Reloading.', { action: { type: 'reload' } }) },

    // Questions about the world.
    { match: re(/\bwhat time is it\b|\bwhat is the time\b|^(the |current )?time( now| please)?$|\bdo you have the time\b|\btell me the time\b/), run: () => timeNow() },
    { match: re(/\bwhat is (the date|todays date|the day)\b|\bwhat (day|date) is (it|today|tomorrow)\b|\bwhat is today\b|\bwhat day of the (week|month) is it\b|^(todays )?date$/), run: (m, t) => dateNow(t) },
    { match: re(/^(?:show|open|go to|switch to|display|bring up|take me to|go|pull up)(?: me)? (?:the |my )?(.+)$/), run: (m) => readListOrNavigate(m[1]) },
    { match: re(/\b(news|headlines|top stories|whats happening in the world|what is happening in the world|what is going on in the world)\b/), run: (m, t) => newsReport(t) },
    { match: re(/\b(calendar|schedule|agenda|appointments?|meetings?|events?)\b|\bwhat is (next|coming up|on today|on tomorrow)\b|\bdo i have (anything|any plans|something|plans)\b|\bam i (busy|free)\b|\bmy plans\b/), run: (m, t) => calendarReport(t) },
    { match: re(/\b(cpu|processor|pis? temperature|pis? temp|temperature of the pi|how hot is the pi|pi is hot|system status|memory usage|disk space|storage space|ip address|my ip|uptime|how long have you been (on|running|up))\b|\bhow hot (are you|is the (pi|system|processor))\b/), run: (m, t) => systemReport(t) },
    { match: re(/\b(weather|forecast|temperature|how (hot|cold|warm|chilly) is it|rain|raining|rainy|snow|snowing|umbrella|jacket|coat|sunny|cloudy|windy|humid|humidity|sunrise|sunset|sun (rise|set|come up|go down)|air quality|aqi|uv index|degrees outside|storm|thunder)\b/), run: (m, t) => weatherReport(t) },
    { match: re(/\b(stocks?|shares|stock market|the market|market today|portfolio|watchlist|dow|nasdaq|s and p)\b|\bprice of\b|\bhow is (.+) (doing|trading)\b/), run: (m, t) => stockReport(t) },
    { match: re(/^(clear|dismiss|delete|remove)\b.*\bnotifications?\b/), run: () => clearNotifications() },
    { match: re(/\b(notifications?|what did i miss|any (messages|updates|alerts))\b/), run: () => readNotifications() },
    { match: re(/\b(fares?|flights?|flight deals?|plane tickets?|airfare|travel deals?|deals)\b/), run: () => faresReport() },
    { match: re(/^(hello|hi|hey|good (morning|afternoon|evening))$/), run: (m, t) => say(`${/morning/.test(t) ? 'Good morning' : /afternoon/.test(t) ? 'Good afternoon' : /evening/.test(t) ? 'Good evening' : 'Hi'}! It's ${sayClock(now())}.`) },
  ];

  async function readListOrShow(t, listName) {
    if (/^show\b/.test(t)) return readListOrNavigate(`${listName} list`);
    return readList(listName);
  }

  /** "show my grocery list" opens the lists page and reads it; "show the weather" just goes there. */
  async function readListOrNavigate(target) {
    const nav = await navigate(target);
    if (/\b(list|grocer|shopping|to ?do)\b/.test(target) && nav.ok) {
      const name = target.replace(/\blists?\b/, '').trim();
      const read = await readList(name || null);
      return { ...read, action: nav.action };
    }
    const widget = WIDGET_WORDS.find(([, re]) => re.test(target))?.[0];
    if (nav.ok && !nav.reply) {
      nav.reply = nav.action?.name ? `Showing ${widget ? WIDGET_NAMES[widget] : `the ${nav.action.name} page`}.` : '';
      nav.quiet = true;
    }
    // No tile to show: answer out loud instead where we can.
    if (!nav.ok && widget) {
      const spoken = { calendar: calendarReport, weather: weatherReport, stocks: stockReport, news: newsReport, timers: timerStatus, reminders: listReminders, fares: faresReport };
      if (spoken[widget]) return spoken[widget](target);
    }
    return nav;
  }

  return {
    ready,
    handle,
    command,
    state,
    stop: () => clearInterval(watch),
  };
}
