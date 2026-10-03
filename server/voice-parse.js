// Text helpers for voice commands: cleaning up what the speech recognizer heard
// (it writes numbers as words and has no punctuation), and reading durations,
// clock times, days and repeats out of a sentence. Pure functions, so they're
// easy to test; server/voice.js decides what a sentence means.

const SMALL = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORDINAL_SMALL = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15,
  sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19,
};
const ORDINAL_TENS = { twentieth: 20, thirtieth: 30 };

export const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_ALIASES = { jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const MONTH_RE = `(${[...MONTHS, ...Object.keys(MONTH_ALIASES)].join('|')})`;
const WEEKDAY_RE = `(${WEEKDAYS.join('|')})`;

function monthIndex(word) {
  const i = MONTHS.indexOf(word);
  return i >= 0 ? i : MONTH_ALIASES[word] ?? -1;
}

const ordinalSuffix = (n) => {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th';
  return { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
};

/**
 * Reads one spoken number starting at words[i]: "seven", "twenty five",
 * "one hundred and five", "twenty first". Returns null when words[i] isn't one.
 * "seven thirty" is two numbers (a clock time), not 37.
 */
function readNumber(words, i, prev) {
  const w = words[i];
  const next = words[i + 1];
  let value;
  let j = i + 1;
  let ordinal = false;

  if (w === 'a' && next === 'hundred') {
    value = 100;
    j = i + 2;
  } else if (w in SMALL) {
    value = SMALL[w];
    if (next === 'hundred') {
      value *= 100;
      j = i + 2;
    } else {
      return { value, end: j, ordinal };
    }
  } else if (w in TENS) {
    value = TENS[w];
    if (SMALL[next] >= 1 && SMALL[next] <= 9) {
      value += SMALL[next];
      j = i + 2;
    } else if (ORDINAL_SMALL[next] >= 1 && ORDINAL_SMALL[next] <= 9 && (next !== 'second' || prev === 'the' || monthIndex(prev) >= 0)) {
      value += ORDINAL_SMALL[next];
      ordinal = true;
      j = i + 2;
    }
    return { value, end: j, ordinal };
  } else if (w in ORDINAL_TENS) {
    return { value: ORDINAL_TENS[w], end: j, ordinal: true };
  } else if (w in ORDINAL_SMALL) {
    // "second" is usually the unit of time; it's a date only after a month or "the".
    if (w === 'second' && !(prev === 'the' || monthIndex(prev) >= 0)) return null;
    return { value: ORDINAL_SMALL[w], end: j, ordinal: true };
  } else {
    return null;
  }

  // After "hundred": optional "and", then tens/units.
  if (words[j] === 'and' && (words[j + 1] in TENS || words[j + 1] in SMALL)) j++;
  const rest = readNumber(words, j, words[j - 1]);
  if (rest && rest.value < 100) return { value: value + rest.value, end: rest.end, ordinal: rest.ordinal };
  return { value, end: j, ordinal };
}

/** "set a timer for twenty five minutes" -> "set a timer for 25 minutes". */
export function wordsToNumbers(text) {
  const words = text.split(' ').filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; ) {
    // "a couple of" / "a few": what people say for 2 and 3.
    if (words[i] === 'a' && words[i + 1] === 'couple') {
      out.push('2');
      i += words[i + 2] === 'of' ? 3 : 2;
      continue;
    }
    const n = readNumber(words, i, words[i - 1]);
    if (n) {
      out.push(n.ordinal ? `${n.value}${ordinalSuffix(n.value)}` : String(n.value));
      i = n.end;
    } else {
      out.push(words[i]);
      i++;
    }
  }
  return out.join(' ');
}

const CONTRACTIONS = [
  [/\bwhat's\b/g, 'what is'],
  [/\bwhats\b/g, 'what is'],
  [/\bhow's\b/g, 'how is'],
  [/\bwhen's\b/g, 'when is'],
  [/\bwhere's\b/g, 'where is'],
  [/\bwho's\b/g, 'who is'],
  [/\bit's\b/g, 'it is'],
  [/\bthat's\b/g, 'that is'],
  [/\bthere's\b/g, 'there is'],
  [/\bi'm\b/g, 'i am'],
  [/\bdon't\b/g, 'do not'],
  [/\bdoesn't\b/g, 'does not'],
  [/\bisn't\b/g, 'is not'],
  [/\blet's\b/g, 'let us'],
  [/\bwhat're\b/g, 'what are'],
  [/\bi'd\b/g, 'i would'],
  [/\bo'? ?clock\b/g, 'oclock'],
];

/** Lowercase, plain words and digits: what the command matchers work on. */
export function normalize(text) {
  let t = String(text ?? '').toLowerCase().replace(/[’‘`]/g, "'");
  t = t.replace(/\b([ap])\.\s?m\b\.?/g, '$1m');
  for (const [re, to] of CONTRACTIONS) t = t.replace(re, to);
  t = t.replace(/(\d)\s*%/g, '$1 percent');
  t = t.replace(/&/g, ' and ').replace(/\+/g, ' plus ');
  // Typed lists: "milk, eggs, and bread" reads like "milk and eggs and bread".
  t = t.replace(/,(?=\s|[a-z])/g, ' and ').replace(/\band(\s+and)+\b/g, 'and');
  // Keep "7:30" and "1.5"; everything else that isn't a letter or digit is a space.
  t = t.replace(/(\d):(\d)/g, '$1\u0001$2').replace(/(\d)\.(\d)/g, '$1\u0002$2');
  t = t.replace(/'/g, '').replace(/[^a-z0-9\u0001\u0002]+/g, ' ');
  t = t.replace(/\u0001/g, ':').replace(/\u0002/g, '.');
  t = t.replace(/\b([ap]) m\b/g, '$1m');
  t = t.replace(/(\d)(am|pm)\b/g, '$1 $2');
  t = t.replace(/\b(\d+) (st|nd|rd|th)\b/g, '$1$2');
  t = wordsToNumbers(t.replace(/\s+/g, ' ').trim());
  return t;
}

const LEADING_FILLER = [
  /^(hey|hi|ok|okay|yo) (jarvis|mycroft|rhasspy|nabu|computer|pi display|display)\b/,
  /^(jarvis|alexa|mycroft|rhasspy|computer)\b/,
  /^(okay|ok|hey|um|uh|so|and|well|oh|now)\b/,
  /^please\b/,
  /^(can|could|would|will) you( please)?\b/,
  /^i (want|need|would like) (you )?to (please )?(?=(set|start|add|put|play|turn|show|open|go|cancel|stop|pause|remind|tell|read|create|make|check|remove|delete|clear|switch|mark|snooze))/,
  /^(tell me|let me know)\b(?= (what|how|when|if|whether|the|my|about))/,
];
const TRAILING_FILLER = /\b(please|thanks|thank you|for me|right now)$/;

/** Drops a wake word left in the text and polite padding around the command. */
export function stripFiller(t) {
  let prev;
  do {
    prev = t;
    for (const re of LEADING_FILLER) t = t.replace(re, '').trim();
    t = t.replace(TRAILING_FILLER, '').trim();
  } while (t !== prev);
  return t;
}

// ---- Durations ----------------------------------------------------------

const UNIT_MS = {
  second: 1000, sec: 1000,
  minute: 60000, min: 60000,
  hour: 3600000, hr: 3600000,
  day: 86400000,
  week: 604800000,
};
const UNIT_RE = '(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)';
const unitMs = (u) => UNIT_MS[u.replace(/s$/, '')] ?? UNIT_MS[u];

const DURATION_PART = new RegExp(
  [
    `\\b(?:(\\d+(?:\\.\\d+)?|an?|one)\\s+(and\\s+an?\\s+half\\s+)?${UNIT_RE}(\\s+and\\s+an?\\s+half)?`,
    `half\\s+(?:an?\\s+)?${UNIT_RE}`,
    `(?:an?\\s+)?quarter\\s+(?:of\\s+an?\\s+)?hour)\\b`,
  ].join('|'),
  'g',
);

/**
 * Finds a length of time: "10 minutes", "an hour and a half", "1 hour 30 minutes",
 * "half an hour", "90 seconds". Parts next to each other (joined by spaces or "and")
 * add up. Returns { ms, start, end } (where it is in t) or null.
 */
export function parseDuration(t) {
  let found = null;
  for (const m of t.matchAll(DURATION_PART)) {
    let ms;
    if (m[3]) {
      const n = /^\d/.test(m[1]) ? Number(m[1]) : 1;
      ms = (n + (m[2] || m[4] ? 0.5 : 0)) * unitMs(m[3]);
    } else if (m[5]) {
      ms = 0.5 * unitMs(m[5]);
    } else {
      ms = 15 * 60000;
    }
    if (!found) {
      found = { ms, start: m.index, end: m.index + m[0].length };
    } else if (/^\s*(and\s+)?$/.test(t.slice(found.end, m.index))) {
      found.ms += ms;
      found.end = m.index + m[0].length;
    } else {
      break;
    }
  }
  if (found) found.ms = Math.round(found.ms);
  return found;
}

// ---- Clock times --------------------------------------------------------

const PERIOD_RE = '(am|pm|oclock|in the morning|in the afternoon|in the evening|at night|this morning|this afternoon|this evening|tonight)';
const periodMeridiem = (p) => {
  if (!p || p === 'oclock') return null;
  if (p === 'am' || p.endsWith('morning')) return 'am';
  return 'pm';
};

/**
 * Finds a clock time: "7 am", "7:30 pm", "at 6 45", "7 oh 5", "noon", "half past 7",
 * "quarter to 8", "10 minutes past 9", "at 7 in the evening". A bare number only
 * counts after "at"/"for"/"by"/"until" or before am/pm/oclock, so "set volume to 5"
 * isn't a time. Returns { hour, minute, meridiem: 'am'|'pm'|null, start, end } or null.
 * hour is as said (1-12 when a meridiem may be missing, or 0-23).
 */
export function parseClock(t) {
  let m = /\b(at |for |by )?(noon|midday|midnight)\b/.exec(t);
  if (m) {
    const noon = m[2] !== 'midnight';
    return { hour: noon ? 12 : 0, minute: 0, meridiem: noon ? 'pm' : 'am', start: m.index, end: m.index + m[0].length };
  }

  m = new RegExp(`\\b(?:at |for |by )?(half|quarter|(\\d{1,2})(?: minutes?)?) (past|after|to|before|till|til) (\\d{1,2}|noon|midnight)(?: ${PERIOD_RE})?\\b`).exec(t);
  if (m) {
    const mins = m[1] === 'half' ? 30 : m[1] === 'quarter' ? 15 : Number(m[2]);
    let hour = m[4] === 'noon' ? 12 : m[4] === 'midnight' ? 0 : Number(m[4]);
    let meridiem = m[4] === 'noon' ? 'pm' : m[4] === 'midnight' ? 'am' : periodMeridiem(m[5]);
    let minute = mins;
    if (/^(to|before|till|til)$/.test(m[3])) {
      hour = (hour + 23) % 24;
      minute = 60 - mins;
      if (hour === 11 && meridiem === 'pm' && m[4] === 'noon') meridiem = 'am';
    }
    if (mins < 60 && hour <= 23) return { hour, minute, meridiem, start: m.index, end: m.index + m[0].length };
  }

  const re = new RegExp(
    `\\b(at |for |by |until |till |til )?(\\d{1,2})(?::(\\d{2})| (\\d{2})\\b| oh? (\\d))?(?: ${PERIOD_RE})?(?![\\d.]| ?(percent|minutes?|mins?|hours?|hrs?|seconds?|secs?|days?|weeks?|times|degrees|st|nd|rd|th)\\b)`,
    'g',
  );
  for (const x of t.matchAll(re)) {
    const prefix = x[1];
    const period = x[6];
    if (!prefix && !period && !x[3]) continue;
    const hour = Number(x[2]);
    const minute = x[3] ? Number(x[3]) : x[4] ? Number(x[4]) : x[5] ? Number(x[5]) : 0;
    if (hour > 23 || minute > 59) continue;
    let meridiem = periodMeridiem(period);
    if (meridiem && hour > 12) meridiem = null;
    // "at night" / "tonight" with 12 means midnight-ish; keep it simple as pm.
    return { hour, minute, meridiem, start: x.index, end: x.index + x[0].length };
  }
  return null;
}

/** The 24-hour hour for a parsed clock, or null if am/pm is unknown and both are possible. */
export function hour24({ hour, meridiem }) {
  if (hour > 12 || hour === 0) return hour;
  if (meridiem === 'am') return hour % 12;
  if (meridiem === 'pm') return (hour % 12) + 12;
  return null;
}

/**
 * When a clock time next happens after `now` (ms). With a day (a Date at local
 * midnight), on that day. Without am/pm, the sooner of the two (no day), or a
 * daytime guess (on a day: 7-11 morning, 12-6 afternoon/evening).
 */
export function resolveClock(clock, now, day = null) {
  const h = hour24(clock);
  const at = (base, hour) => {
    const d = new Date(base);
    d.setHours(hour, clock.minute, 0, 0);
    return d;
  };
  if (day) {
    const hour = h ?? (clock.hour >= 7 && clock.hour <= 11 ? clock.hour : (clock.hour % 12) + 12);
    return at(day, hour);
  }
  const candidates = h !== null ? [h] : [clock.hour % 12, (clock.hour % 12) + 12];
  let best = null;
  for (const hour of candidates) {
    let d = at(now, hour);
    if (d.getTime() <= now) d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, hour, clock.minute);
    if (!best || d < best) best = d;
  }
  return best;
}

// ---- Days ---------------------------------------------------------------

const midnight = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * Finds a day: today, tonight, tomorrow, the day after tomorrow, (on|next|this) friday,
 * october 5th, the 5th of october, 10/5. Returns { date (local midnight), start, end,
 * part: 'morning'|'afternoon'|'evening'|'night'|null } or null.
 */
export function parseDay(t, now) {
  const today = midnight(now);
  let m = /\b(the )?day after tomorrow\b/.exec(t);
  if (m) return { date: addDays(today, 2), start: m.index, end: m.index + m[0].length, part: null };
  m = /\b(tomorrow|tmrw)( (morning|afternoon|evening|night))?\b/.exec(t);
  if (m) return { date: addDays(today, 1), start: m.index, end: m.index + m[0].length, part: m[3] ?? null };
  m = /\b(today|tonight|this (morning|afternoon|evening))\b/.exec(t);
  if (m) return { date: today, start: m.index, end: m.index + m[0].length, part: m[1] === 'tonight' ? 'night' : m[2] ?? null };

  m = new RegExp(`\\b(?:(on|next|this|coming) )?(?:this coming )?${WEEKDAY_RE}( (morning|afternoon|evening|night))?\\b`).exec(t);
  if (m && !new RegExp(`\\bevery ${m[2]}`).test(t) && !new RegExp(`\\b${m[2]}s\\b`).test(t)) {
    const want = WEEKDAYS.indexOf(m[2]);
    let diff = (want - today.getDay() + 7) % 7;
    if (m[1] === 'next' && diff === 0) diff = 7;
    return { date: addDays(today, diff), start: m.index, end: m.index + m[0].length, part: m[4] ?? null };
  }

  m = new RegExp(`\\b(?:on )?(?:the )?(\\d{1,2})(?:st|nd|rd|th)? (?:of )?${MONTH_RE}\\b`).exec(t) ?? null;
  let month;
  let date;
  if (m) {
    date = Number(m[1]);
    month = monthIndex(m[2]);
  } else {
    m = new RegExp(`\\b(?:on )?${MONTH_RE} (?:the )?(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(t);
    if (m) {
      month = monthIndex(m[1]);
      date = Number(m[2]);
    }
  }
  if (!m) {
    m = /\b(?:on )?(\d{1,2})\/(\d{1,2})\b/.exec(t);
    if (m) {
      month = Number(m[1]) - 1;
      date = Number(m[2]);
    }
  }
  if (!m) {
    m = /\bon the (\d{1,2})(?:st|nd|rd|th)\b/.exec(t);
    if (m) {
      date = Number(m[1]);
      month = today.getMonth();
      if (date < today.getDate()) month += 1;
    }
  }
  if (m && month >= 0 && date >= 1 && date <= 31) {
    let d = new Date(today.getFullYear(), month, date);
    if (d < today) d = new Date(today.getFullYear() + 1, month, date);
    // February 30th and the like roll into the next month; that's not a real date.
    if (d.getDate() !== date) return null;
    return { date: d, start: m.index, end: m.index + m[0].length, part: null };
  }
  return null;
}

// ---- Repeats ------------------------------------------------------------

/**
 * Finds a repeat: every day, daily, every weekday, on weekends, every monday and
 * thursday, on tuesdays, every 2 weeks, every other day, monthly, every year.
 * Returns { repeat: 'hourly'|'daily'|'weekly'|'monthly'|'yearly', interval, days, part, start, end } or null.
 * days are weekday numbers for weekly repeats (0 = Sunday), empty for "every week".
 */
export function parseRepeat(t) {
  const span = (m) => ({ start: m.index, end: m.index + m[0].length });
  let m = /\b(every|each|on) (weekday|weekdays|work day|workday|work days|workdays)\b|\bweekdays\b/.exec(t);
  if (m) return { repeat: 'weekly', interval: 1, days: [1, 2, 3, 4, 5], part: null, ...span(m) };
  m = /\b(every|each|on) (weekend|weekends)\b|\bweekends\b/.exec(t);
  if (m) return { repeat: 'weekly', interval: 1, days: [0, 6], part: null, ...span(m) };

  const dayList = new RegExp(`\\b(?:every|each|on) ${WEEKDAY_RE}s?((?:,? (?:and )?${WEEKDAY_RE}s?)*)\\b`);
  m = dayList.exec(t);
  if (m && (/^(every|each)/.test(m[0]) || /s\b/.test(m[0].split(' ')[1]))) {
    const days = [...m[0].matchAll(new RegExp(WEEKDAY_RE, 'g'))].map((x) => WEEKDAYS.indexOf(x[1]));
    return { repeat: 'weekly', interval: 1, days: [...new Set(days)].sort(), part: null, ...span(m) };
  }
  m = new RegExp(`\\b${WEEKDAY_RE}s((?:,? (?:and )?${WEEKDAY_RE}s)*)\\b`).exec(t);
  if (m) {
    const days = [...m[0].matchAll(new RegExp(WEEKDAY_RE, 'g'))].map((x) => WEEKDAYS.indexOf(x[1]));
    return { repeat: 'weekly', interval: 1, days: [...new Set(days)].sort(), part: null, ...span(m) };
  }

  m = /\b(every|each) (other )?(?:(\d+) )?(hour|hours|day|days|week|weeks|month|months|year|years)\b/.exec(t);
  if (m) {
    const unit = m[4].replace(/s$/, '');
    const repeat = { hour: 'hourly', day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[unit];
    const interval = m[2] ? 2 : m[3] ? Math.max(1, Number(m[3])) : 1;
    return { repeat, interval, days: [], part: null, ...span(m) };
  }
  m = /\b(every|each) (morning|afternoon|evening|night)\b|\b(nightly)\b/.exec(t);
  if (m) return { repeat: 'daily', interval: 1, days: [], part: m[2] ?? 'night', ...span(m) };
  m = /\b(hourly|daily|weekly|monthly|yearly|annually)\b/.exec(t);
  if (m) {
    const repeat = m[1] === 'annually' ? 'yearly' : m[1];
    return { repeat, interval: 1, days: [], part: null, ...span(m) };
  }
  return null;
}

// ---- Matching names -----------------------------------------------------

function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** A name reduced for comparing: no articles, no plural s, single spaces. */
export function simplify(s) {
  return normalize(s)
    .split(' ')
    .filter((w) => !['the', 'my', 'a', 'an', 'our'].includes(w))
    .map((w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
}

/** 0..1: how alike two names are. Containing the other whole word(s) scores high. */
export function similarity(a, b) {
  const x = simplify(a);
  const y = simplify(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `)) return 0.9;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/** The item whose name best matches query, if it's at least `min` alike. */
export function bestMatch(query, items, name = (x) => x, min = 0.75) {
  let best = null;
  let score = min;
  for (const item of items) {
    const s = similarity(query, name(item));
    if (s >= score) {
      best = item;
      score = s;
    }
  }
  return best;
}

/** Removes [start, end) from t and tidies the spaces. */
export function cut(t, span) {
  if (!span) return t;
  return `${t.slice(0, span.start)} ${t.slice(span.end)}`.replace(/\s+/g, ' ').trim();
}

// ---- Saying things ------------------------------------------------------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "1 hour and 5 minutes", "45 seconds". */
export function sayDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (d) parts.push(plural(d, 'day'));
  if (h) parts.push(plural(h, 'hour'));
  if (m) parts.push(plural(m, 'minute'));
  if (s && !d && !h) parts.push(plural(s, 'second'));
  if (!parts.length) return '0 seconds';
  return sayList(parts);
}

/** "a, b and c". */
export function sayList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "7 AM", "7:30 PM". */
export function sayClock(msOrDate) {
  const d = new Date(msOrDate);
  const h = d.getHours() % 12 || 12;
  const mm = d.getMinutes();
  return `${h}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}

/** "today", "tomorrow", "Friday", or "Saturday, October 11". */
export function sayDay(msOrDate, now) {
  const day = midnight(new Date(msOrDate).getTime());
  const diff = Math.round((day - midnight(now)) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  const weekday = day.toLocaleDateString('en-US', { weekday: 'long' });
  if (diff > 1 && diff < 7) return weekday;
  return day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

/** "7 AM today", "9:30 AM on Friday". */
export function sayWhen(ms, now) {
  const day = sayDay(ms, now);
  return `${sayClock(ms)} ${/^(today|tomorrow|yesterday)$/.test(day) ? day : `on ${day}`}`;
}

/** Capitalizes the first letter, for labels and list items said back. */
export const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
