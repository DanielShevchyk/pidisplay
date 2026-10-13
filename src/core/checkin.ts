// Client side of server/checkin.js: one shared copy of the morning check-in
// (everyone's profiles with their questions and answers, plus the popup settings),
// kept current from the `checkin` SSE event plus a slow poll, so the morning popup
// notices a new day.
import { call, onServerEvent } from './api';

export type QuestionType = 'scale' | 'hours' | 'yesno';
export type Answer = number | boolean;

export interface Question {
  id: string;
  label: string;
  /** Name in charts and lists. */
  short: string;
  type: QuestionType;
  enabled: boolean;
  /** Words under 1 and 5 on a scale. */
  low?: string;
  high?: string;
  lowerIsBetter?: boolean;
  custom?: boolean;
}

export interface Entry {
  answers: Record<string, Answer>;
  note?: string;
  at: number;
}

export interface CheckinSettings {
  prompt: boolean;
  /** Minutes after midnight. */
  promptAt: number;
  promptUntil: number;
  note: boolean;
}

/** One person: their own questions and every day's answers. */
export interface Profile {
  id: string;
  name: string;
  emoji: string;
  /** Included in the morning popup. */
  prompt: boolean;
  questions: Question[];
  entries: Record<string, Entry>;
}

/** A profile plus today's date: what the form, charts and stats work from. */
export type Book = Profile & { today: string };

export interface CheckinState {
  now: number;
  /** The Pi's local date, YYYY-MM-DD. */
  today: string;
  settings: CheckinSettings;
  profiles: Profile[];
  /** The day "Later" was tapped on (for everyone). */
  skipped: string | null;
}

const POLL_MS = 60000;

class CheckinStore {
  state: CheckinState | null = null;
  private listeners = new Set<() => void>();
  private started = false;

  private start() {
    if (this.started) return;
    this.started = true;
    onServerEvent<CheckinState>('checkin', (s) => this.apply(s));
    const refresh = () => void this.refresh();
    refresh();
    setInterval(refresh, POLL_MS);
  }

  async refresh() {
    try {
      this.apply(await call<CheckinState>('GET', '/api/checkin'));
    } catch (err) {
      console.error('Loading the check-in failed', err);
    }
  }

  private apply(s: CheckinState) {
    this.state = s;
    this.listeners.forEach((fn) => fn());
  }

  /** Calls fn now (if loaded) and on every change. Returns an unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.start();
    this.listeners.add(fn);
    if (this.state) fn();
    return () => this.listeners.delete(fn);
  }

  private async send(method: string, url: string, body?: unknown) {
    this.apply(await call<CheckinState>(method, url, body));
  }

  private person(id: string) {
    return `/api/checkin/profiles/${encodeURIComponent(id)}`;
  }

  saveEntry(profile: string, date: string, answers: Record<string, Answer | null>, note: string) {
    return this.send('PUT', `${this.person(profile)}/entries/${date}`, { answers, note });
  }
  deleteEntry(profile: string, date: string) {
    return this.send('DELETE', `${this.person(profile)}/entries/${date}`);
  }
  saveQuestions(profile: string, questions: Question[]) {
    return this.send('PUT', `${this.person(profile)}/questions`, questions);
  }
  resetQuestions(profile: string) {
    return this.send('DELETE', `${this.person(profile)}/questions`);
  }
  addProfile(fields: { name: string; emoji?: string; copyFrom?: string }) {
    return this.send('POST', '/api/checkin/profiles', fields);
  }
  updateProfile(profile: string, fields: Partial<Pick<Profile, 'name' | 'emoji' | 'prompt'>>) {
    return this.send('PUT', this.person(profile), fields);
  }
  deleteProfile(profile: string) {
    return this.send('DELETE', this.person(profile));
  }
  skipToday() {
    return this.send('POST', '/api/checkin/skip');
  }
  saveSettings(patch: Partial<CheckinSettings>) {
    return this.send('PUT', '/api/checkin/settings', patch);
  }

  /** That person's book, or the first person's when the id is gone (e.g. deleted). */
  book(id?: string): Book | null {
    const s = this.state;
    if (!s) return null;
    const p = s.profiles.find((x) => x.id === id) ?? s.profiles[0];
    return p ? { ...p, today: s.today } : null;
  }

  /** People in the morning popup who haven't checked in today. */
  waiting(): Profile[] {
    const s = this.state;
    return s ? s.profiles.filter((p) => p.prompt && !p.entries[s.today]) : [];
  }
}

export const active = (b: Book) => b.questions.filter((q) => q.enabled);

export const checkin = new CheckinStore();

// ---- Dates ----------------------------------------------------------------

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** The n days ending on `last` (inclusive), oldest first. */
export function daysBack(last: string, n: number): string[] {
  const end = parseKey(last);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(dateKey(new Date(end.getFullYear(), end.getMonth(), end.getDate() - i)));
  return out;
}

const fmtDay = new Intl.DateTimeFormat([], { weekday: 'short', month: 'short', day: 'numeric' });

/** "Today", "Yesterday" or "Mon, Oct 12". */
export function dayLabel(key: string, today: string): string {
  if (key === today) return 'Today';
  if (key === daysBack(today, 2)[0]) return 'Yesterday';
  return fmtDay.format(parseKey(key));
}

export function formatMinutes(m: number): string {
  const d = new Date(2000, 0, 1, Math.floor(m / 60), m % 60);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ---- Answers ----------------------------------------------------------------

export function formatAnswer(q: Question, v: Answer | undefined): string {
  if (v === undefined) return '–';
  if (q.type === 'yesno') return v ? 'Yes' : 'No';
  if (q.type === 'hours') return `${v} h`;
  return String(v);
}

/** 0 (bad) to 1 (good) for coloring, honoring lowerIsBetter. Hours peak at 7.5-9. */
export function goodness(q: Question, v: Answer): number | null {
  if (q.type === 'scale' && typeof v === 'number') {
    const g = (v - 1) / 4;
    return q.lowerIsBetter ? 1 - g : g;
  }
  if (q.type === 'hours' && typeof v === 'number') {
    if (v >= 7.5 && v <= 9) return 1;
    return Math.max(0, 1 - (v < 7.5 ? 7.5 - v : v - 9) / 3.5);
  }
  return null;
}

/** A color from red through amber to green for a goodness value. */
export function goodnessColor(g: number | null): string {
  if (g === null) return 'var(--text-dim)';
  if (g < 0.5) return `color-mix(in srgb, var(--danger) ${Math.round((1 - g * 2) * 100)}%, var(--warning))`;
  return `color-mix(in srgb, var(--success) ${Math.round((g - 0.5) * 200)}%, var(--warning))`;
}

export function average(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Numbers answered for q on the given days. */
export function valuesFor(book: Book, q: Question, days: string[]): number[] {
  return days.map((d) => book.entries[d]?.answers[q.id]).filter((v): v is number => typeof v === 'number');
}
