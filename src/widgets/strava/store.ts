// One copy of the Strava snapshot for every Strava tile on this screen. The server
// syncs on its own clock and sends a 'strava' event when something changed.
import { call, onServerEvent } from '../../core/api';
import type { Snapshot } from './stats';

type Listener = (s: Snapshot | null, error: string) => void;

let snap: Snapshot | null = null;
let error = '';
let loading: Promise<void> | null = null;
let offEvent: (() => void) | null = null;
const listeners = new Set<Listener>();

async function load() {
  try {
    snap = await call<Snapshot>('GET', '/api/strava');
    error = '';
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  listeners.forEach((l) => l(snap, error));
}

export function refresh(): Promise<void> {
  loading ??= load().finally(() => {
    loading = null;
  });
  return loading;
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  offEvent ??= onServerEvent('strava', () => void refresh());
  if (snap || error) fn(snap, error);
  if (!snap) void refresh();
  return () => {
    listeners.delete(fn);
    if (!listeners.size) {
      offEvent?.();
      offEvent = null;
    }
  };
}

export const current = () => snap;

export async function syncNow(): Promise<void> {
  snap = await call<Snapshot>('POST', '/api/strava/sync');
  listeners.forEach((l) => l(snap, ''));
}

/** Everything about one activity; the server fetches it from Strava once and keeps it. */
export interface ActivityDetail {
  detail: {
    description: string;
    calories: number | null;
    device: string | null;
    gear: string | null;
    poly: string | null;
    photo: string | null;
    splitsMetric: Split[];
    splitsStandard: Split[];
    laps: (Split & { name: string })[];
    bestEfforts: { name: string; time: number; dist: number; pr: number | null }[];
    segments: { name: string; time: number; dist: number; pr: number | null; kom: number | null }[];
  } | null;
  streams: {
    distance: number[] | null;
    time: number[] | null;
    altitude: number[] | null;
    heartrate: number[] | null;
    speed: number[] | null;
    watts: number[] | null;
    cadence: number[] | null;
  } | null;
  note?: string;
}

export interface Split {
  dist: number;
  move: number;
  elev: number | null;
  speed: number | null;
  hr: number | null;
}

export const activityDetail = (id: number) => call<ActivityDetail>('GET', `/api/strava/activities/${id}`);
export const allRoutes = () => call<{ id: number; sport: string; start: string; poly: string }[]>('GET', '/api/strava/routes');
