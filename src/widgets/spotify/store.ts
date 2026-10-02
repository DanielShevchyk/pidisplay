// One shared copy of the Spotify state for every Spotify tile and sheet on this
// screen. Polls /api/spotify/player (server/spotify.js) while anything is
// watching: every few seconds while music plays, less often otherwise.
import { call, onServerEvent } from '../../core/api';

export interface SpotifyStatus {
  configured: boolean;
  connected: boolean;
  redirectUri: string;
  receiver: { name: string; signedIn: boolean };
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
  /** Set when the player can't be loaded at all (offline, signed out). */
  loadError = '';
  private fetchedAt = 0;
  private listeners = new Set<() => void>();
  private timer = 0;
  private errorTimer = 0;
  private offEvent: (() => void) | null = null;
  /** Ignore poll results that started before an action, so the UI doesn't flicker back. */
  private generation = 0;

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

  async refresh(withStatus = false) {
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
    if (this.listeners.size) {
      const delay = this.player?.isPlaying ? PLAYING_POLL_MS : IDLE_POLL_MS;
      this.timer = window.setTimeout(() => void this.refresh(!this.status), document.hidden ? delay * 3 : delay);
    }
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

  /** Sends a playback command, updating the screen right away where the result is obvious. */
  async act(action: Action, body: Record<string, unknown> = {}): Promise<boolean> {
    this.generation++;
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
      await call('POST', `/api/spotify/player/${action}`, body);
    } catch (err) {
      ok = false;
      this.showError((err as Error).message);
    }
    // Spotify takes a moment to report the new state.
    this.generation++;
    window.setTimeout(() => void this.refresh(), 600);
    return ok;
  }
}

export const spotify = new SpotifyStore();

export function formatTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
