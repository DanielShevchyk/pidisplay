// Client side of server/stocks.js: one shared copy of the watchlist, quotes and
// alerts, kept current from the `stocks` SSE event. The server polls prices and
// decides when an alert fires; screens show it and play the alert sound.
import { call, onServerEvent } from './api';
import { play } from './tones';
import type { ToneId } from './timers';

export type AlertKind = 'above' | 'below' | 'up' | 'down';
export type Range = '1d' | '5d' | '1m' | '6m' | '1y' | '5y';

export interface Quote {
  name: string;
  currency: string;
  price: number;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  /** When the price was set, ms. */
  time: number;
  marketOpen: boolean | null;
  /** Last ~30 daily closes, not counting today. */
  spark: number[] | null;
  error: string | null;
}

export interface StockAlert {
  id: string;
  symbol: string;
  kind: AlertKind;
  value: number;
  repeat: 'once' | 'daily';
  note: string;
  enabled: boolean;
  firedAt: number | null;
  firedPrice: number | null;
}

export interface StockSettings {
  refreshMinutes: number;
  sound: ToneId;
  volume: number;
  /** How many times the alert sound plays. */
  repeats: number;
}

export interface StocksState {
  now: number;
  provider: 'twelvedata' | 'yahoo';
  providerName: string;
  marketOpen: boolean;
  symbols: string[];
  quotes: Record<string, Quote>;
  alerts: StockAlert[];
  settings: StockSettings;
  updated: number | null;
  nextPollAt: number | null;
  error: string | null;
  credits: { used: number; limit: number } | null;
}

export interface History {
  symbol: string;
  range: Range;
  points: [number, number][];
  prevClose: number | null;
  currency: string;
}

const POLL_MS = 60000;
const HISTORY_TTL = 60000;

class StocksStore {
  state: StocksState | null = null;
  private listeners = new Set<() => void>();
  private started = false;
  private history = new Map<string, { at: number; data: Promise<History> }>();

  private start() {
    if (this.started) return;
    this.started = true;
    onServerEvent<StocksState>('stocks', (s) => this.apply(s));
    const refresh = () => void this.load();
    refresh();
    setInterval(refresh, POLL_MS);
  }

  private async load() {
    try {
      this.apply(await call<StocksState>('GET', '/api/stocks'));
    } catch (err) {
      console.error('Loading stocks failed', err);
    }
  }

  private apply(s: StocksState) {
    this.state = s;
    this.listeners.forEach((fn) => fn());
  }

  subscribe(fn: () => void): () => void {
    this.start();
    this.listeners.add(fn);
    if (this.state) fn();
    return () => this.listeners.delete(fn);
  }

  private async act(method: string, url: string, body?: unknown) {
    this.apply(await call<StocksState>(method, url, body));
  }

  refresh() {
    return this.act('POST', '/api/stocks/refresh');
  }
  setSymbols(symbols: string[]) {
    return this.act('PUT', '/api/stocks/symbols', { symbols });
  }
  createAlert(a: Pick<StockAlert, 'symbol' | 'kind' | 'value' | 'repeat' | 'note'>) {
    return this.act('POST', '/api/stocks/alerts', a);
  }
  updateAlert(id: string, patch: Partial<Pick<StockAlert, 'kind' | 'value' | 'repeat' | 'note' | 'enabled'>>) {
    return this.act('PUT', `/api/stocks/alerts/${encodeURIComponent(id)}`, patch);
  }
  deleteAlert(id: string) {
    return this.act('DELETE', `/api/stocks/alerts/${encodeURIComponent(id)}`);
  }
  saveSettings(patch: Partial<StockSettings>) {
    return this.act('PUT', '/api/stocks/settings', patch);
  }
  testAlert() {
    return this.act('POST', '/api/stocks/test');
  }

  /** Price history, shared by every tile and briefly cached. */
  getHistory(symbol: string, range: Range): Promise<History> {
    const key = `${symbol}|${range}`;
    const hit = this.history.get(key);
    if (hit && Date.now() - hit.at < HISTORY_TTL) return hit.data;
    const data = call<History>('GET', `/api/stocks/history?${new URLSearchParams({ symbol, range })}`);
    this.history.set(key, { at: Date.now(), data });
    data.catch(() => this.history.delete(key));
    return data;
  }
}

export const stocks = new StocksStore();

/** Plays the alert sound on this screen whenever the server fires a stock alert. Called once by the shell. */
export function initStockAlertSounds() {
  onServerEvent<{ sound: ToneId; volume: number; repeats: number }>('stocks-alert', (s) => {
    try {
      play(s.sound, { volume: s.volume, cycles: s.repeats });
    } catch (err) {
      console.error('Could not play the stock alert sound', err);
    }
  });
}

// ---- Formatting -------------------------------------------------------------

const moneyFormats = new Map<string, Intl.NumberFormat>();

export function money(n: number, currency = 'USD'): string {
  const digits = Math.abs(n) < 1 ? 4 : 2;
  const key = `${currency}|${digits}`;
  if (!moneyFormats.has(key)) {
    let fmt: Intl.NumberFormat;
    try {
      fmt = new Intl.NumberFormat([], { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
    } catch {
      fmt = new Intl.NumberFormat([], { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }
    moneyFormats.set(key, fmt);
  }
  return moneyFormats.get(key)!.format(n);
}

/** Plain number with 2 decimals (4 under 1), for dense rows. */
export const price = (n: number) => n.toLocaleString([], { minimumFractionDigits: Math.abs(n) < 1 ? 4 : 2, maximumFractionDigits: Math.abs(n) < 1 ? 4 : 2 });

export const signedPct = (n: number | null) => (n === null ? '' : `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%`);
export const signed = (n: number | null) => (n === null ? '' : `${n >= 0 ? '+' : '−'}${price(Math.abs(n))}`);
export const trend = (n: number | null) => (n === null || n === 0 ? 'flat' : n > 0 ? 'up' : 'down');

export function describeAlert(a: Pick<StockAlert, 'kind' | 'value'>, currency = 'USD'): string {
  if (a.kind === 'above') return `Above ${money(a.value, currency)}`;
  if (a.kind === 'below') return `Below ${money(a.value, currency)}`;
  return `${a.kind === 'up' ? 'Up' : 'Down'} ${a.value}% in a day`;
}
