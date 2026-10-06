// One shared copy of the TV state for every YouTube tile and sheet on this screen.
// The server (server/youtube.js) listens to the TV and pushes each change as a
// 'youtube' event, so there's no polling here; positions are counted forward locally.
import { call, createStorage, onServerEvent } from '../../core/api';

export interface Video {
  id: string;
  title: string;
  channel: string;
  duration?: string;
  views?: string;
  published?: string;
  live?: boolean;
  thumb: string;
}

export interface Screen {
  id: string;
  name: string;
  dial: boolean;
}

export type TvState = 'playing' | 'paused' | 'buffering' | 'stopped' | 'ended' | 'cued' | 'ad';

export interface Status {
  screens: Screen[];
  current: string | null;
  connected: boolean;
  tv: {
    videoId: string | null;
    title: string;
    channel: string;
    state: TvState;
    currentTime: number;
    duration: number;
    volume: number | null;
    muted: boolean;
    online: boolean | null;
    thumb: string | null;
  };
  history: (Video & { at: number })[];
}

export type Control = 'play' | 'pause' | 'next' | 'previous' | 'seek' | 'volume';

const ERROR_SHOW_MS = 6000;
const NOTE_SHOW_MS = 4000;
// The TV's events can be lost while the Pi's network blips; re-read now and then.
const RESYNC_MS = 60_000;

class YouTubeStore {
  status: Status | null = null;
  loadError = '';
  /** A failed action, shown briefly. */
  error = '';
  /** A short confirmation such as "Playing on Living room TV". */
  note = '';
  saved: Video[] = [];
  private receivedAt = 0;
  private listeners = new Set<() => void>();
  private offEvent: (() => void) | null = null;
  private offSaved: (() => void) | null = null;
  private resync = 0;
  private errorTimer = 0;
  private noteTimer = 0;
  private savedStore = createStorage('youtube');

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.start();
    fn();
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) this.stop();
    };
  }

  emit() {
    this.listeners.forEach((fn) => fn());
  }

  private start() {
    this.offEvent = onServerEvent<Status>('youtube', (s) => this.apply(s));
    this.offSaved = this.savedStore.onChange(() => void this.loadSaved());
    void this.refresh();
    void this.loadSaved();
    this.resync = window.setInterval(() => void this.refresh(), RESYNC_MS);
  }

  private stop() {
    this.offEvent?.();
    this.offSaved?.();
    clearInterval(this.resync);
  }

  private apply(s: Status) {
    this.status = s;
    this.receivedAt = Date.now();
    this.loadError = '';
    this.emit();
  }

  async refresh() {
    try {
      // connect=1 asks the server to open the TV session so the tile can show what's on.
      this.apply(await call<Status>('GET', '/api/youtube?connect=1'));
    } catch (err) {
      this.loadError = (err as Error).message;
      this.emit();
    }
  }

  private async loadSaved() {
    const data = await this.savedStore.load<{ saved?: Video[] }>({}).catch(() => ({ saved: [] }));
    this.saved = Array.isArray(data.saved) ? data.saved : [];
    this.emit();
  }

  isSaved(id: string): boolean {
    return this.saved.some((v) => v.id === id);
  }

  async toggleSaved(video: Video) {
    const { id, title, channel, duration, thumb } = video;
    this.saved = this.isSaved(id) ? this.saved.filter((v) => v.id !== id) : [{ id, title, channel, duration, thumb }, ...this.saved].slice(0, 100);
    this.emit();
    await this.savedStore.save({ saved: this.saved }).catch((err) => this.showError((err as Error).message));
  }

  /** Seconds into the video now, counting time since the last update. */
  position(): number {
    const tv = this.status?.tv;
    if (!tv) return 0;
    const t = tv.state === 'playing' ? tv.currentTime + (Date.now() - this.receivedAt) / 1000 : tv.currentTime;
    return tv.duration ? Math.min(t, tv.duration) : t;
  }

  screenName(): string {
    const s = this.status;
    return s?.screens.find((x) => x.id === s.current)?.name ?? 'the TV';
  }

  showError(message: string) {
    this.error = message;
    clearTimeout(this.errorTimer);
    this.errorTimer = window.setTimeout(() => ((this.error = ''), this.emit()), ERROR_SHOW_MS);
    this.emit();
  }

  showNote(message: string) {
    this.note = message;
    clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => ((this.note = ''), this.emit()), NOTE_SHOW_MS);
    this.emit();
  }

  async play(video: Video): Promise<boolean> {
    this.showNote(`Starting on ${this.screenName()}…`);
    try {
      const s = await call<Status & { tvOnline: boolean | null }>('POST', '/api/youtube/play', { videoId: video.id, title: video.title, channel: video.channel });
      this.apply(s);
      this.showNote(s.tvOnline === false ? `Sent. If ${this.screenName()} shows nothing, turn it on and open YouTube.` : `Playing on ${this.screenName()}`);
      return true;
    } catch (err) {
      this.note = '';
      this.showError((err as Error).message);
      return false;
    }
  }

  async queue(video: Video) {
    try {
      this.apply(await call<Status>('POST', '/api/youtube/queue', { videoId: video.id, title: video.title, channel: video.channel }));
      this.showNote(`Added to the queue on ${this.screenName()}`);
    } catch (err) {
      this.showError((err as Error).message);
    }
  }

  async control(action: Control, value?: number) {
    try {
      this.apply(await call<Status>('POST', '/api/youtube/control', { action, value }));
    } catch (err) {
      this.showError((err as Error).message);
    }
  }
}

export const youtube = new YouTubeStore();

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// ---- Search, kept across tiles and sheets so a result list survives reopening ----

export const searchState = { query: '', results: [] as Video[], error: '' };

export async function runSearch(query: string): Promise<void> {
  searchState.query = query.trim();
  searchState.error = '';
  if (!searchState.query) {
    searchState.results = [];
    return;
  }
  try {
    const r = await call<{ results: Video[] }>('GET', `/api/youtube/search?q=${encodeURIComponent(searchState.query)}`);
    searchState.results = r.results;
  } catch (err) {
    searchState.results = [];
    searchState.error = (err as Error).message;
  }
}
