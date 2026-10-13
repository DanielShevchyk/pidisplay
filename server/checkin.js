// Morning check-in: a short daily survey (sleep, energy, mood, stress...) whose
// answers are kept per day so they can be trended over months. Each person in the
// household has a profile with their own questions and answers; one JSON file holds
// the profiles and the shared morning-popup settings. Days are the Pi's local
// dates; the server says what "today" is so every screen agrees. Screens follow
// the `checkin` SSE event.

export class CheckinError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new CheckinError(400, message);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

export const TYPES = ['scale', 'hours', 'yesno'];
const MAX_QUESTIONS = 30;
const MAX_NOTE = 500;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ID_RE = /^[a-z0-9-]{1,40}$/;

/**
 * Built-in questions. Ids are stored with every answer, so never rename one.
 * "low"/"high" label the ends of a 1-5 scale; lowerIsBetter flips its colors and trend arrows.
 */
export const DEFAULT_QUESTIONS = [
  { id: 'sleep', label: 'How well did you sleep?', short: 'Sleep', type: 'scale', low: 'Terrible', high: 'Great', enabled: true },
  { id: 'hours', label: 'About how many hours did you sleep?', short: 'Hours slept', type: 'hours', enabled: true },
  { id: 'energy', label: "How's your energy?", short: 'Energy', type: 'scale', low: 'Drained', high: 'Full', enabled: true },
  { id: 'mood', label: 'How are you feeling overall?', short: 'Mood', type: 'scale', low: 'Awful', high: 'Great', enabled: true },
  { id: 'stress', label: 'How stressed do you feel?', short: 'Stress', type: 'scale', low: 'Calm', high: 'Very', lowerIsBetter: true, enabled: true },
  { id: 'body', label: 'How does your body feel?', short: 'Body', type: 'scale', low: 'Sore / unwell', high: 'Great', enabled: true },
  { id: 'alcohol', label: 'Alcohol last night?', short: 'Alcohol', type: 'yesno', enabled: false },
  { id: 'caffeine', label: 'Caffeine after 2 PM yesterday?', short: 'Late caffeine', type: 'yesno', enabled: false },
  { id: 'exercise', label: 'Did you exercise yesterday?', short: 'Exercise', type: 'yesno', enabled: false },
  { id: 'screens', label: 'Screens in bed last night?', short: 'Screens in bed', type: 'yesno', enabled: false },
];
const BUILT_IN = new Set(DEFAULT_QUESTIONS.map((q) => q.id));

export const DEFAULT_SETTINGS = {
  /** Pop the survey up in the morning when today's isn't done. */
  prompt: true,
  /** Minutes after midnight: the window the popup and top-bar chip show in. */
  promptAt: 7 * 60,
  promptUntil: 12 * 60,
  /** Offer a one-line note under the questions. */
  note: true,
};

export const dateKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function parseDate(v) {
  const m = typeof v === 'string' && DATE_RE.exec(v);
  if (!m) throw bad('date must look like 2026-10-13');
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const check = new Date(y, mo, d);
  if (check.getFullYear() !== y || check.getMonth() !== mo || check.getDate() !== d) throw bad('date is not a real date');
  return v;
}

function text(v, name, max, required = true) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} is required`);
    return '';
  }
  if (typeof v !== 'string') throw bad(`${name} must be text`);
  const t = v.trim().slice(0, max);
  if (required && !t) throw bad(`${name} is required`);
  return t;
}

/** Checks one answer against its question; returns the value to store. */
export function validAnswer(q, v) {
  if (q.type === 'scale' && isInt(v, 1, 5)) return v;
  if (q.type === 'hours' && typeof v === 'number' && v >= 0 && v <= 16 && Math.round(v * 2) === v * 2) return v;
  if (q.type === 'yesno' && typeof v === 'boolean') return v;
  throw bad(`"${q.short}" got an answer it can't take`);
}

export function validateQuestions(list) {
  if (!Array.isArray(list) || !list.length) throw bad('Expected a list of questions');
  if (list.length > MAX_QUESTIONS) throw bad(`At most ${MAX_QUESTIONS} questions`);
  const seen = new Set();
  const out = list.map((q) => {
    if (!q || typeof q !== 'object') throw bad('Each question must be an object');
    if (!ID_RE.test(q.id ?? '')) throw bad('Each question needs an id');
    if (seen.has(q.id)) throw bad(`Question id ${q.id} is used twice`);
    seen.add(q.id);
    if (!TYPES.includes(q.type)) throw bad('type must be scale, hours or yesno');
    const label = text(q.label, 'Question', 120);
    const next = {
      id: q.id,
      label,
      short: text(q.short, 'Short name', 24, false) || label.slice(0, 24),
      type: q.type,
      enabled: q.enabled !== false,
    };
    if (q.type === 'scale') {
      next.low = text(q.low, 'Low label', 24, false);
      next.high = text(q.high, 'High label', 24, false);
      if (q.lowerIsBetter) next.lowerIsBetter = true;
    }
    if (!BUILT_IN.has(q.id)) next.custom = true;
    return next;
  });
  if (!out.some((q) => q.enabled)) throw bad('Keep at least one question turned on');
  return out;
}

export function validateSettings(body, current) {
  if (!body || typeof body !== 'object') throw bad('Expected an object');
  const next = { ...current };
  for (const key of ['prompt', 'note']) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') throw bad(`${key} must be true or false`);
    next[key] = body[key];
  }
  for (const key of ['promptAt', 'promptUntil']) {
    if (body[key] === undefined) continue;
    if (!isInt(body[key], 0, 24 * 60)) throw bad(`${key} must be minutes after midnight`);
    next[key] = body[key];
  }
  if (next.promptUntil <= next.promptAt) throw bad('The popup has to stop after it starts');
  return next;
}

export const EMOJIS = ['🙂', '🌞', '🌙', '⭐', '🌸', '🍀', '🦊', '🐻', '🐱', '🐶', '🚀', '🎨'];
const MAX_PROFILES = 12;

/** A saved question list brought up to date: new built-in questions appear (off). */
function normalizeQuestions(list) {
  try {
    const questions = validateQuestions(list);
    for (const d of DEFAULT_QUESTIONS) if (!questions.some((q) => q.id === d.id)) questions.push({ ...d, enabled: false });
    return questions;
  } catch {
    return structuredClone(DEFAULT_QUESTIONS);
  }
}

function newProfile(id, name, emoji) {
  return { id, name, emoji, prompt: true, questions: structuredClone(DEFAULT_QUESTIONS), entries: {} };
}

/**
 * Brings a saved file up to date. Files from before profiles (questions and entries
 * at the top level) become a single profile named "Me".
 */
function normalize(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  let settings;
  try {
    settings = validateSettings(s.settings ?? {}, DEFAULT_SETTINGS);
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  let profiles = Array.isArray(s.profiles) ? s.profiles : [];
  if (!profiles.length && (s.questions || s.entries)) profiles = [{ id: 'me', name: 'Me', emoji: '🙂', questions: s.questions, entries: s.entries }];
  profiles = profiles
    .filter((p) => p && ID_RE.test(p.id ?? ''))
    .map((p) => ({
      id: p.id,
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 30) : 'Me',
      emoji: typeof p.emoji === 'string' && p.emoji ? p.emoji.slice(0, 8) : '🙂',
      prompt: p.prompt !== false,
      questions: normalizeQuestions(p.questions),
      entries: p.entries && typeof p.entries === 'object' ? p.entries : {},
    }));
  if (!profiles.length) profiles = [newProfile('me', 'Me', '🙂')];
  return { settings, profiles, skipped: typeof s.skipped === 'string' ? s.skipped : null };
}

/** CSV of every person's days, oldest first, one column per question (by short name). */
export function toCsv(state) {
  const columns = [];
  for (const p of state.profiles) for (const q of p.questions) if (!columns.includes(q.short)) columns.push(q.short);
  const cell = (v) => {
    if (v === undefined || v === null) return '';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['person', 'date', ...columns, 'note', 'answered at'].map(cell).join(',')];
  for (const p of state.profiles) {
    for (const date of Object.keys(p.entries).sort()) {
      const e = p.entries[date];
      const values = columns.map((c) => {
        const q = p.questions.find((x) => x.short === c);
        return q ? e.answers?.[q.id] : undefined;
      });
      rows.push([p.name, date, ...values, e.note, e.at ? new Date(e.at).toISOString() : ''].map(cell).join(','));
    }
  }
  return rows.join('\n') + '\n';
}

export function createCheckin({ load, save, broadcast, now = Date.now }) {
  let state = null;
  let ready = null;
  let lastDay = null;
  let timer = null;

  const today = () => dateKey(new Date(now()));
  const ensure = () => (ready ??= Promise.resolve(load()).then((s) => (state = normalize(s))));
  const snapshot = () => ({ now: now(), today: today(), ...state });

  async function commit() {
    await save(state);
    broadcast(snapshot());
    return snapshot();
  }

  function profile(id) {
    const p = state.profiles.find((x) => x.id === id);
    if (!p) throw new CheckinError(404, 'No such person');
    return p;
  }

  function find(p, id) {
    const q = p.questions.find((x) => x.id === id);
    if (!q) throw bad(`Unknown question ${id}`);
    return q;
  }

  function profileFields(body, p) {
    if (!body || typeof body !== 'object') throw bad('Expected an object');
    if (body.name !== undefined) {
      const name = text(body.name, 'Name', 30);
      if (state.profiles.some((x) => x !== p && x.name.toLowerCase() === name.toLowerCase())) throw bad(`There is already a ${name}`);
      p.name = name;
    }
    if (body.emoji !== undefined) {
      if (typeof body.emoji !== 'string' || !body.emoji || body.emoji.length > 8) throw bad('Pick an icon');
      p.emoji = body.emoji;
    }
    if (body.prompt !== undefined) {
      if (typeof body.prompt !== 'boolean') throw bad('prompt must be true or false');
      p.prompt = body.prompt;
    }
  }

  async function handleProfile(method, p, rest, body) {
    const [what, key] = rest;

    if (!what && method === 'PUT') {
      profileFields(body, p);
      return commit();
    }
    if (!what && method === 'DELETE') {
      if (state.profiles.length === 1) throw bad('Keep at least one person');
      state.profiles = state.profiles.filter((x) => x !== p);
      return commit();
    }

    if (what === 'entries' && key) {
      const date = parseDate(key);
      if (date > today()) throw bad("Can't fill in a day that hasn't happened yet");
      if (method === 'DELETE') {
        delete p.entries[date];
        return commit();
      }
      if (method === 'PUT') {
        if (!body || typeof body !== 'object' || !body.answers || typeof body.answers !== 'object') throw bad('Expected answers');
        const answers = {};
        for (const [id, v] of Object.entries(body.answers)) {
          if (v === null || v === undefined) continue;
          answers[id] = validAnswer(find(p, id), v);
        }
        const note = text(body.note, 'Note', MAX_NOTE, false);
        if (!Object.keys(answers).length && !note) throw bad('Answer at least one question');
        p.entries[date] = { answers, ...(note ? { note } : {}), at: now() };
        return commit();
      }
    }

    if (what === 'questions' && !key && method === 'PUT') {
      const next = validateQuestions(body);
      // Built-in questions can be turned off but not deleted, so their history keeps its labels.
      for (const d of DEFAULT_QUESTIONS) if (!next.some((q) => q.id === d.id)) throw bad(`${d.short} can be turned off but not removed`);
      p.questions = next;
      return commit();
    }
    if (what === 'questions' && !key && method === 'DELETE') {
      // Back to the built-in set; custom questions and all answers stay.
      p.questions = [...structuredClone(DEFAULT_QUESTIONS), ...p.questions.filter((q) => q.custom)];
      return commit();
    }

    throw new CheckinError(404, 'Not found');
  }

  async function handle(method, parts, body) {
    await ensure();
    const [, what, key, ...rest] = parts; // parts[0] is "checkin"

    if (!what && method === 'GET') return snapshot();

    if (what === 'profiles' && !key && method === 'POST') {
      if (state.profiles.length >= MAX_PROFILES) throw bad(`At most ${MAX_PROFILES} people`);
      const p = newProfile('', '', EMOJIS[state.profiles.length % EMOJIS.length]);
      profileFields({ emoji: p.emoji, ...body }, p);
      if (!p.name) throw bad('Name is required');
      let id = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'person';
      while (state.profiles.some((x) => x.id === id)) id += '-2';
      p.id = id;
      // Start from someone else's questions, e.g. a family sharing one set.
      if (body?.copyFrom) p.questions = structuredClone(profile(body.copyFrom).questions);
      state.profiles.push(p);
      return commit();
    }
    if (what === 'profiles' && key) return handleProfile(method, profile(key), rest, body);

    if (what === 'skip' && method === 'POST') {
      state.skipped = today();
      return commit();
    }

    if (what === 'settings' && method === 'PUT') {
      state.settings = validateSettings(body, state.settings);
      return commit();
    }

    throw new CheckinError(404, 'Not found');
  }

  async function exportCsv() {
    await ensure();
    return toCsv(state);
  }

  /** Re-broadcasts when the date rolls over, so screens offer the new day's check-in. */
  function tick() {
    if (!state) return;
    const d = today();
    if (lastDay && d !== lastDay) broadcast(snapshot());
    lastDay = d;
  }

  return {
    handle,
    exportCsv,
    tick,
    start() {
      void ensure().then(tick).catch((err) => console.error('Loading check-in data failed', err));
      timer ??= setInterval(tick, 60000);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
