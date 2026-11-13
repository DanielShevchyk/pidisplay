// One shared copy of the Spotify state for every Spotify tile and sheet on this
// screen. Polls /api/spotify/player (server/spotify.js) while anything is
// watching: every few seconds while music plays, less often otherwise.
import { call, onServerEvent } from '../../core/api';

export interface SpotifyStatus {
  configured: boolean;
  connected: boolean;
  redirectUri: string;
  receiver: { name: string; signedIn: boolean };
  /** The speaker new music starts on when nothing is playing; null = this display. */
  preferred: { id: string | null; name: string; type: string } | null;
  /** The linked LG TV; with no preferred speaker it is where new music starts. */
  tv?: { name: string } | null;
}

export interface Device {
  id: string;
  name: string;
  type: string;
  active: boolean;
  restricted: boolean;
  volume: number | null;
  supportsVolume: boolean;
}

export interface Item {
  uri: string;
  type: string;
  name: string;
  artists: string[];
  album: string;
  image: string | null;
  thumb: string | null;
  durationMs: number;
}

export interface PlayerState {
  isPlaying: boolean;
  progressMs: number;
  shuffle: boolean;
  repeat: 'off' | 'context' | 'track';
  device: Device;
  item: Item | null;
  context: { uri: string; type: string } | null;
  disallows: string[];
}

export type Action = 'play' | 'pause' | 'next' | 'previous' | 'seek' | 'volume' | 'shuffle' | 'repeat' | 'transfer';

const PLAYING_POLL_MS = 3000;
const IDLE_POLL_MS = 10000;
const ERROR_SHOW_MS = 6000;

class SpotifyStore {
  status: SpotifyStatus | null = null;
  player: PlayerState | null = null;
  devices: Device[] = [];
  /** A failed action or refresh, shown briefly on the tiles. */
  error = '';
  /** True when error is just news (the TV is being switched on), not a failure. */
  errorIsInfo = false;
  /** Set when the player can't be loaded at all (offline, signed out). */
  loadError = '';
  private fetchedAt = 0;
  private listeners = new Set<() => void>();
  private timer = 0;
  private errorTimer = 0;
  private offEvent: (() => void) | null = null;
  /** Ignore poll results that started before an action, so the UI doesn't flicker back. */
  private generation = 0;
  /** The refresh in flight, so overlapping callers share it instead of each starting a poll loop. */
  private refreshing: Promise<void> | null = null;
  private again: { withStatus: boolean } | null = null;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.start();
    fn();
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) this.stop();
    };
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  private start() {
    this.offEvent = onServerEvent('spotify', () => void this.refresh(true));
    void this.refresh(true);
  }

  private stop() {
    clearTimeout(this.timer);
    this.offEvent?.();
    this.offEvent = null;
  }

  /** Playback position now, counting time since the last poll. */
  progress(): number {
    const p = this.player;
    if (!p) return 0;
    const ms = p.isPlaying ? p.progressMs + (Date.now() - this.fetchedAt) : p.progressMs;
    return Math.min(ms, p.item?.durationMs ?? ms);
  }

  /** Reloads now; a call that arrives mid-reload runs once more afterwards instead of in parallel. */
  refresh(withStatus = false): Promise<void> {
    if (this.refreshing) {
      this.again = { withStatus: withStatus || Boolean(this.again?.withStatus) };
      return this.refreshing;
    }
    this.refreshing = this.load(withStatus).finally(() => {
      this.refreshing = null;
      const again = this.again;
      this.again = null;
      if (again) void this.refresh(again.withStatus);
    });
    return this.refreshing;
  }

  private async load(withStatus: boolean) {
    clearTimeout(this.timer);
    const gen = this.generation;
    try {
      if (withStatus || !this.status) this.status = await call<SpotifyStatus>('GET', '/api/spotify');
      if (this.status.connected) {
        const data = await call<{ player: PlayerState | null; devices: Device[] }>('GET', '/api/spotify/player');
        if (gen === this.generation) {
          this.player = data.player;
          this.devices = data.devices;
          this.fetchedAt = Date.now();
        }
      } else {
        this.player = null;
        this.devices = [];
      }
      this.loadError = '';
    } catch (err) {
      this.loadError = (err as Error).message;
      // Signed out on the server side (revoked or expired): show the setup view.
      if (/log in again|not connected/i.test(this.loadError)) this.status = null;
    }
    this.emit();
    clearTimeout(this.timer);
    if (this.listeners.size) {
      const delay = this.player?.isPlaying ? PLAYING_POLL_MS : IDLE_POLL_MS;
      this.timer = window.setTimeout(() => void this.refresh(!this.status), document.hidden ? delay * 3 : delay);
    }
  }

  showError(message: string, info = false, showMs = ERROR_SHOW_MS) {
    this.error = message;
    this.errorIsInfo = info;
    clearTimeout(this.errorTimer);
    this.errorTimer = window.setTimeout(() => {
      this.error = '';
      this.emit();
    }, showMs);
    this.emit();
  }

  /**
   * The TV that pressing Play will have to switch on and open Spotify on first, if any:
   * the default speaker is a TV that Spotify can't see right now.
   */
  tvToWake(): string | null {
    if (this.player?.isPlaying) return null;
    const want = this.status?.preferred;
    if (want?.type === 'display') return null;
    if (want) return want.type === 'tv' && !this.devices.some((d) => d.id === want.id || d.name === want.name) ? want.name : null;
    const tv = this.status?.tv;
    return tv && !this.devices.some((d) => d.type === 'tv') ? tv.name : null;
  }

  /** Sends a playback command, updating the screen right away where the result is obvious. */
  async act(action: Action, body: Record<string, unknown> = {}): Promise<boolean> {
    this.generation++;
    const waking = action === 'play' && !body.deviceId ? this.tvToWake() : null;
    if (waking) this.showError(`Opening Spotify on ${waking}… This can take up to a minute.`, true, 90000);
    const p = this.player;
    if (p) {
      if (action === 'pause' || action === 'play') {
        p.progressMs = this.progress();
        this.fetchedAt = Date.now();
        p.isPlaying = action === 'play';
      }
      if (action === 'shuffle') p.shuffle = Boolean(body.on);
      if (action === 'repeat') p.repeat = body.mode as PlayerState['repeat'];
      if (action === 'volume') p.device.volume = Number(body.percent);
      if (action === 'seek') {
        p.progressMs = Number(body.positionMs);
        this.fetchedAt = Date.now();
      }
      this.emit();
    }
    let ok = true;
    try {
      const res = await call<{ note?: string }>('POST', `/api/spotify/player/${action}`, body);
      if (res?.note) this.showError(res.note, /Liked Songs/.test(res.note));
      else if (waking) this.showError('', true);
    } catch (err) {
      ok = false;
      this.showError((err as Error).message);
    }
    // Spotify takes a moment to report the new state.
    this.generation++;
    window.setTimeout(() => void this.refresh(), 600);
    return ok;
  }

  async setPreferred(device: { id: string; name: string; type: string } | null) {
    try {
      this.status = await call<SpotifyStatus>('PUT', '/api/spotify/preferred', device ? { deviceId: device.id, name: device.name, type: device.type } : {});
    } catch (err) {
      this.showError((err as Error).message);
    }
    this.emit();
  }
}

export const spotify = new SpotifyStore();

export function formatTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
