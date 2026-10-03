// Client side of server/reminders.js: one shared copy of the reminders, kept
// current from the `reminders` SSE event (plus a slow poll in case an event is
// missed while reconnecting). The server decides when a reminder is due.
import { call, onServerEvent } from './api';
import { formatAlarmTime } from './timers';
import type { ToneId } from './timers';

export type Repeat = 'none' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface Reminder {
  id: string;
  title: string;
  notes: string;
  /** First (or only) date, YYYY-MM-DD in the Pi's time zone. */
  date: string;
  hour: number;
  minute: number;
  repeat: Repeat;
  /** Every N hours/days/weeks/months/years. */
  interval: number;
  /** Weekdays for weekly reminders, 0 = Sunday. Empty means the start date's weekday. */
  days: number[];
  /** Last date it repeats on, or null. */
  until: string | null;
  sound: ToneId | null;
  enabled: boolean;
  nextAt: number | null;
  state: 'idle' | 'due' | 'snoozed';
  dueAt: number | null;
  snoozeUntil: number | null;
  completedAt: number | null;
  test?: boolean;
}

export type ReminderInput = Pick<Reminder, 'title' | 'notes' | 'date' | 'hour' | 'minute' | 'repeat' | 'interval' | 'days' | 'until' | 'sound'> & {
  enabled?: boolean;
};

export interface ReminderSettings {
  sound: ToneId;
  /** 0-100. */
  volume: number;
  /** How many times the sound plays when one comes due. */
  repeats: number;
  /** Chime again every this many minutes until Done (0 = off; stops after an hour). */
  nagMinutes: number;
}

export interface RemindersState {
  now: number;
  settings: ReminderSettings;
  reminders: Reminder[];
}

const POLL_MS = 30000;

class RemindersStore {
  state: RemindersState | null = null;
  /** Server clock minus this screen's clock. */
  private offset = 0;
  private listeners = new Set<() => void>();
  private started = false;

  private start() {
    if (this.started) return;
    this.started = true;
    onServerEvent<RemindersState>('reminders', (s) => this.apply(s));
    const refresh = () => void this.refresh();
    refresh();
    setInterval(refresh, POLL_MS);
  }

  async refresh() {
    try {
      this.apply(await call<RemindersState>('GET', '/api/reminders'));
    } catch (err) {
      console.error('Loading reminders failed', err);
    }
  }

  private apply(s: RemindersState) {
    this.offset = s.now - Date.now();
    this.state = s;
    this.listeners.forEach((fn) => fn());
  }

  /** Current time on the Pi's clock. */
  now(): number {
    return Date.now() + this.offset;
  }

  subscribe(fn: () => void): () => void {
    this.start();
    this.listeners.add(fn);
    if (this.state) fn();
    return () => this.listeners.delete(fn);
  }

  due(): Reminder[] {
    return (this.state?.reminders ?? []).filter((r) => r.state === 'due').sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
  }

  private async act(method: string, url: string, body?: unknown) {
    this.apply(await call<RemindersState>(method, url, body));
  }

  create(r: ReminderInput) {
    return this.act('POST', '/api/reminders', r);
  }
  update(id: string, patch: Partial<ReminderInput>) {
    return this.act('PUT', `/api/reminders/${encodeURIComponent(id)}`, patch);
  }
  remove(id: string) {
    return this.act('DELETE', `/api/reminders/${encodeURIComponent(id)}`);
  }
  done(id: string) {
    return this.act('POST', `/api/reminders/${encodeURIComponent(id)}/done`);
  }
  snooze(id: string, minutes: number) {
    return this.act('POST', `/api/reminders/${encodeURIComponent(id)}/snooze`, { minutes });
  }
  clearCompleted() {
    return this.act('DELETE', '/api/reminders');
  }
  test() {
    return this.act('POST', '/api/reminders/test');
  }
  saveSettings(patch: Partial<ReminderSettings>) {
    return this.act('PUT', '/api/reminders/settings', patch);
  }
}

export const reminders = new RemindersStore();

// ---- Formatting shared by the widget and the due popup ---------------------

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const UNITS: Record<Exclude<Repeat, 'none'>, string> = { hourly: 'hour', daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' };

export const repeatUnit = (r: Exclude<Repeat, 'none'>, n: number) => `${UNITS[r]}${n === 1 ? '' : 's'}`;

export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fromDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** "Today", "Tomorrow", "Yesterday", or "Mon, Oct 5" (with the year when it isn't this year). */
export function dayLabel(d: Date, now = new Date()): string {
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/** "Today 9:00 AM", "Mon, Oct 5 9:00 AM". */
export function formatWhen(t: number, now = new Date()): string {
  const d = new Date(t);
  return `${dayLabel(d, now)} ${formatAlarmTime(d.getHours(), d.getMinutes())}`;
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
}

/** "Once", "Every day", "Every 2 weeks on Tue, Thu", "Weekdays", "Every month on the 3rd", "… until Oct 30". */
export function formatRepeat(r: Pick<Reminder, 'repeat' | 'interval' | 'days' | 'date' | 'until'>): string {
  if (r.repeat === 'none') return 'Once';
  const n = r.interval || 1;
  const start = fromDateKey(r.date);
  let text = n === 1 ? `Every ${UNITS[r.repeat]}` : `Every ${n} ${repeatUnit(r.repeat, n)}`;
  if (r.repeat === 'weekly') {
    const days = r.days.length ? [...r.days].sort() : [start.getDay()];
    const key = days.join('');
    if (n === 1 && key === '12345') text = 'Weekdays';
    else if (n === 1 && key === '06') text = 'Weekends';
    else if (n === 1 && key === '0123456') text = 'Every day';
    else text += ` on ${days.map((d) => DAY_SHORT[d]).join(', ')}`;
  } else if (r.repeat === 'monthly') {
    text += ` on the ${ordinal(start.getDate())}`;
  } else if (r.repeat === 'yearly') {
    text += ` on ${start.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  }
  if (r.until) text += ` until ${fromDateKey(r.until).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  return text;
}
