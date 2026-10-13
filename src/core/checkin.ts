// Client side of server/checkin.js: one shared copy of the morning check-in
// (questions, settings, every day's answers), kept current from the `checkin`
// SSE event plus a slow poll, so the morning popup notices a new day.
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

export interface CheckinState {
  now: number;
  /** The Pi's local date, YYYY-MM-DD. */
  today: string;
  questions: Question[];
  settings: CheckinSettings;
  entries: Record<string, Entry>;
  /** The day "Later" was tapped on. */
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

  saveEntry(date: string, answers: Record<string, Answer | null>, note: string) {
    return this.send('PUT', `/api/checkin/entries/${date}`, { answers, note });
  }
  deleteEntry(date: string) {
    return this.send('DELETE', `/api/checkin/entries/${date}`);
  }
  skipToday() {
    return this.send('POST', '/api/checkin/skip');
  }
  saveSettings(patch: Partial<CheckinSettings>) {
    return this.send('PUT', '/api/checkin/settings', patch);
  }
  saveQuestions(questions: Question[]) {
    return this.send('PUT', '/api/checkin/questions', questions);
  }
  resetQuestions() {
    return this.send('DELETE', '/api/checkin/questions');
  }

  active(): Question[] {
    return this.state?.questions.filter((q) => q.enabled) ?? [];
  }
  todayEntry(): Entry | undefined {
    return this.state ? this.state.entries[this.state.today] : undefined;
  }
}

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
export function valuesFor(state: CheckinState, q: Question, days: string[]): number[] {
  return days.map((d) => state.entries[d]?.answers[q.id]).filter((v): v is number => typeof v === 'number');
}
