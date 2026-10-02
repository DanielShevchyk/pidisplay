// Client side of server/timers.js: one shared copy of the timers and alarms
// state, kept current from the `timers` SSE event (plus a slow poll in case an
// event is missed while reconnecting). The server decides when things ring.
import { call, onServerEvent } from './api';

export type ToneId = 'chime' | 'beep' | 'bells' | 'marimba' | 'rise' | 'pulse';

export interface TimerItem {
  id: string;
  label: string;
  sound: ToneId | null;
  durationMs: number;
  state: 'running' | 'paused' | 'ringing' | 'snoozed';
  endsAt: number | null;
  remainingMs: number | null;
  ringingSince: number | null;
  snoozeUntil: number | null;
}

export interface AlarmItem {
  id: string;
  label: string;
  sound: ToneId | null;
  hour: number;
  minute: number;
  /** Weekdays, 0 = Sunday. Empty means one time. */
  days: number[];
  enabled: boolean;
  nextAt: number | null;
  state: 'idle' | 'ringing' | 'snoozed';
  ringingSince: number | null;
  snoozeUntil: number | null;
}

export interface TimerSettings {
  snoozeMinutes: number;
  sound: ToneId;
  /** 0-100. */
  volume: number;
  /** Stop ringing on its own after this long. */
  ringMinutes: number;
  /** Start quiet and get louder over the first half minute. */
  fadeIn: boolean;
}

export interface TimersState {
  now: number;
  settings: TimerSettings;
  timers: TimerItem[];
  alarms: AlarmItem[];
}

export type Ringable = { kind: 'timer'; item: TimerItem } | { kind: 'alarm'; item: AlarmItem };

const POLL_MS = 15000;

class TimersStore {
  state: TimersState | null = null;
  /** Server clock minus this screen's clock, so a phone with a skewed clock counts down right. */
  private offset = 0;
  private listeners = new Set<() => void>();
  private started = false;

  private start() {
    if (this.started) return;
    this.started = true;
    onServerEvent<TimersState>('timers', (s) => this.apply(s));
    const refresh = () => void this.refresh();
    refresh();
    setInterval(refresh, POLL_MS);
  }

  async refresh() {
    try {
      this.apply(await call<TimersState>('GET', '/api/timers'));
    } catch (err) {
      console.error('Loading timers failed', err);
    }
  }

  private apply(s: TimersState) {
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

  ringing(): Ringable[] {
    const s = this.state;
    if (!s) return [];
    return [
      ...s.alarms.filter((a) => a.state === 'ringing').map((item) => ({ kind: 'alarm' as const, item })),
      ...s.timers.filter((t) => t.state === 'ringing').map((item) => ({ kind: 'timer' as const, item })),
    ].sort((a, b) => (a.item.ringingSince ?? 0) - (b.item.ringingSince ?? 0));
  }

  private async act(method: string, url: string, body?: unknown) {
    this.apply(await call<TimersState>(method, url, body));
  }

  startTimer(durationMs: number, label = '') {
    return this.act('POST', '/api/timers', { durationMs, label });
  }
  timerAction(id: string, action: 'pause' | 'resume' | 'restart' | 'snooze' | 'dismiss') {
    return this.act('POST', `/api/timers/${encodeURIComponent(id)}/${action}`);
  }
  addTime(id: string, ms: number) {
    return this.act('POST', `/api/timers/${encodeURIComponent(id)}/add`, { ms });
  }
  cancelTimer(id: string) {
    return this.act('DELETE', `/api/timers/${encodeURIComponent(id)}`);
  }
  createAlarm(a: Pick<AlarmItem, 'hour' | 'minute' | 'days' | 'label' | 'sound'>) {
    return this.act('POST', '/api/alarms', a);
  }
  updateAlarm(id: string, patch: Partial<Pick<AlarmItem, 'hour' | 'minute' | 'days' | 'label' | 'sound' | 'enabled'>>) {
    return this.act('PUT', `/api/alarms/${encodeURIComponent(id)}`, patch);
  }
  deleteAlarm(id: string) {
    return this.act('DELETE', `/api/alarms/${encodeURIComponent(id)}`);
  }
  alarmAction(id: string, action: 'snooze' | 'dismiss') {
    return this.act('POST', `/api/alarms/${encodeURIComponent(id)}/${action}`);
  }
  snooze(r: Ringable) {
    return r.kind === 'alarm' ? this.alarmAction(r.item.id, 'snooze') : this.timerAction(r.item.id, 'snooze');
  }
  dismiss(r: Ringable) {
    return r.kind === 'alarm' ? this.alarmAction(r.item.id, 'dismiss') : this.timerAction(r.item.id, 'dismiss');
  }
  saveSettings(patch: Partial<TimerSettings>) {
    return this.act('PUT', '/api/timers/settings', patch);
  }
}

export const timers = new TimersStore();

// ---- Formatting shared by the widget and the ringing screen ----------------

/** Time left on a running or paused timer, in ms. */
export function timeLeft(t: TimerItem, now: number): number {
  if (t.state === 'running' && t.endsAt !== null) return Math.max(0, t.endsAt - now);
  if (t.state === 'paused' && t.remainingMs !== null) return t.remainingMs;
  return 0;
}

/** 1:05:09, 5:09, 0:09. Rounds up so a timer never shows 0:00 while still running. */
export function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "5 min", "1 hr 30 min", "45 sec". */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} hr`);
  if (m) parts.push(`${m} min`);
  if (s || parts.length === 0) parts.push(`${s} sec`);
  return parts.join(' ');
}

export const uses12h = new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions().hour12 !== false;

/** "7:30 AM" or "07:30", following the screen's locale. */
export function formatAlarmTime(hour: number, minute: number): string {
  if (!uses12h) return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatDays(days: number[]): string {
  const key = [...days].sort().join('');
  if (key === '') return 'Once';
  if (key === '0123456') return 'Every day';
  if (key === '12345') return 'Weekdays';
  if (key === '06') return 'Weekends';
  return [...days].sort().map((d) => DAY_SHORT[d]).join(', ');
}

/** "in 8 hr 12 min" (rounded to the minute), or "in 40 sec". */
export function formatIn(ms: number): string {
  if (ms < 60000) return `in ${Math.max(1, Math.ceil(ms / 1000))} sec`;
  const mins = Math.ceil(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d) return `in ${d} day${d > 1 ? 's' : ''}${h ? ` ${h} hr` : ''}`;
  return `in ${[h && `${h} hr`, m && `${m} min`].filter(Boolean).join(' ')}`;
}

export function ringTitle(r: Ringable): string {
  return r.item.label || (r.kind === 'alarm' ? 'Alarm' : 'Timer');
}
