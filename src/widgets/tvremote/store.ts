// One shared copy of the TV's state for every remote tile and sheet on this screen,
// plus the queue that sends presses to the server (server/lgtv.js, /api/tv/...).
// It only polls while some remote is actually on screen.
import { call } from '../../core/api';

export interface TvState {
  linked: boolean;
  name: string | null;
  canWake: boolean;
  on: boolean;
  appId?: string | null;
  volume?: number | null;
  muted?: boolean;
  /** Where the sound goes, e.g. tv_speaker or external_arc. */
  output?: string;
  /** True for a soundbar or receiver: the volume number is then only PiDisplay's guess. */
  external?: boolean;
}

export interface TvApp {
  id: string;
  title: string;
  icon: string | null;
}

export interface TvInput {
  id: string;
  label: string;
  icon: string | null;
  connected: boolean;
}

export type RemoteAction =
  | { action: 'key'; key: string }
  | { action: 'move'; dx: number; dy: number }
  | { action: 'click' }
  | { action: 'scroll'; dy: number }
  | { action: 'power'; on: boolean }
  | { action: 'volume'; percent: number }
  | { action: 'mute'; mute?: boolean }
  | { action: 'launch'; id: string }
  | { action: 'input'; id: string }
  | { action: 'text'; text: string; enter?: boolean }
  | {
      action: 'volumeUp' | 'volumeDown' | 'channelUp' | 'channelDown' | 'play' | 'pause' | 'stop' | 'rewind' | 'fastForward' | 'enter';
    };

const POLL_ON_MS = 4000;
const POLL_OFF_MS = 12000;
const ERROR_SHOW_MS = 6000;
// Presses that pile up behind a slow TV are dropped rather than replayed late.
const MAX_QUEUED = 6;

class RemoteStore {
  state: TvState | null = null;
  loadError = '';
  /** A failed press, shown briefly. */
  error = '';
  /** Set while the power button is switching the TV on (up to half a minute). */
  waking = false;
  apps: { apps: TvApp[]; inputs: TvInput[] } | null = null;
  appsError = '';
  private listeners = new Set<() => void>();
  private quiet = new Set<() => void>();
  private timer = 0;
  private errorTimer = 0;
  private loading: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private appsLoading: Promise<void> | null = null;

  /** Call while a remote is visible; returns the stop function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    if (this.listeners.size === 1) void this.refresh();
    fn();
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) clearTimeout(this.timer);
    };
  }

  /** Repaints on every change without keeping the poll going (parts inside a visible remote). */
  subscribeQuiet(fn: () => void): () => void {
    this.quiet.add(fn);
    return () => this.quiet.delete(fn);
  }

  emit() {
    this.listeners.forEach((fn) => fn());
    this.quiet.forEach((fn) => fn());
  }

  refresh(): Promise<void> {
    this.loading ??= (async () => {
      clearTimeout(this.timer);
      try {
        this.state = await call<TvState>('GET', '/api/tv/state');
        this.loadError = '';
        // App names turn the foreground app's id into "Netflix" in the header.
        if (this.state.on && !this.apps && !this.appsError) void this.loadApps();
      } catch (err) {
        this.loadError = (err as Error).message;
      }
      this.loading = null;
      this.emit();
      if (this.listeners.size) this.timer = window.setTimeout(() => void this.refresh(), this.state?.on ? POLL_ON_MS : POLL_OFF_MS);
    })();
    return this.loading;
  }

  showError(message: string) {
    this.error = message;
    clearTimeout(this.errorTimer);
    this.errorTimer = window.setTimeout(() => {
      this.error = '';
      this.emit();
    }, ERROR_SHOW_MS);
    this.emit();
  }

  /** Sends one press, in order after the ones before it. Resolves true when the TV took it. */
  send(body: RemoteAction): Promise<boolean> {
    if (this.queued >= MAX_QUEUED && (body.action === 'key' || body.action === 'move' || body.action.startsWith('volume'))) return Promise.resolve(false);
    this.queued++;
    const run = this.queue.then(async () => {
      try {
        const res = await call<{ ok: boolean; volume?: number | null; muted?: boolean; on?: boolean; external?: boolean; output?: string }>('POST', '/api/tv/remote', body);
        if (this.state) {
          if ('volume' in res) this.state.volume = res.volume;
          if ('muted' in res) this.state.muted = res.muted;
          if ('external' in res) this.state.external = res.external;
          if ('output' in res) this.state.output = res.output;
          if (typeof res.on === 'boolean') this.state.on = res.on;
        }
        if (this.error) this.error = '';
        this.emit();
        return true;
      } catch (err) {
        this.showError((err as Error).message);
        // A TV that went off (or was switched on with its own remote) shows up sooner.
        void this.refresh();
        return false;
      } finally {
        this.queued--;
      }
    });
    this.queue = run;
    return run;
  }

  async power() {
    if (this.waking) return;
    const on = !this.state?.on;
    if (on) {
      this.waking = true;
      this.emit();
    }
    await this.send({ action: 'power', on });
    this.waking = false;
    await this.refresh();
    if (on) void this.loadApps(true);
  }

  loadApps(fresh = false): Promise<void> {
    if (this.apps && !fresh) return Promise.resolve();
    this.appsLoading ??= (async () => {
      try {
        this.apps = await call<{ apps: TvApp[]; inputs: TvInput[] }>(fresh ? 'POST' : 'GET', '/api/tv/apps');
        this.appsError = '';
      } catch (err) {
        this.appsError = (err as Error).message;
      }
      this.appsLoading = null;
      this.emit();
    })();
    return this.appsLoading;
  }

  forgetApps() {
    this.apps = null;
  }
}

export const remote = new RemoteStore();
