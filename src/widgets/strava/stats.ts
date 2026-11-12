// Numbers for the Strava widget: sport groups, unit formatting and the totals the
// tiles and sheets show, all worked out from the activity list the server caches.

/** One activity as GET /api/strava sends it (server/strava.js compactActivity). */
export interface Activity {
  id: number;
  name: string;
  sport: string;
  /** UTC ISO time. */
  start: string;
  /** Wall-clock time where it happened, no zone ("2026-11-12T07:05:00"). */
  local: string;
  /** Meters, seconds. */
  dist: number;
  move: number;
  elapsed: number;
  elev: number;
  /** m/s */
  speed: number | null;
  maxSpeed: number | null;
  hr: number | null;
  maxHr: number | null;
  watts: number | null;
  kj: number | null;
  effort: number | null;
  kudos: number;
  achievements: number;
  prs: number;
  photos: number;
  trainer: boolean;
  commute: boolean;
  private: boolean;
  workout: number | null;
  /** Encoded route line; only on the newest activities, see hasRoute. */
  poly?: string | null;
  hasRoute?: boolean;
}

export interface Athlete {
  id: number;
  name: string;
  firstname: string;
  city: string;
  photo: string | null;
  units: Units;
}

export interface Snapshot {
  configured: boolean;
  connected: boolean;
  scopeOk: boolean | null;
  error: string | null;
  syncing: boolean;
  athlete: Athlete | null;
  lastSync: number | null;
  backfilled: boolean;
  count: number;
  activities: Activity[];
  usage: { short: number; daily: number; limits: { short: number; daily: number }; waitUntil: number | null };
}

export type Units = 'imperial' | 'metric';
export type SportGroup = 'all' | 'run' | 'ride' | 'walk' | 'swim' | 'other';
export type Metric = 'distance' | 'time' | 'elevation';

const GROUPS: Record<string, SportGroup> = {
  Run: 'run',
  TrailRun: 'run',
  VirtualRun: 'run',
  Ride: 'ride',
  MountainBikeRide: 'ride',
  GravelRide: 'ride',
  EBikeRide: 'ride',
  EMountainBikeRide: 'ride',
  VirtualRide: 'ride',
  Velomobile: 'ride',
  Handcycle: 'ride',
  Walk: 'walk',
  Hike: 'walk',
  Swim: 'swim',
};

export const groupOf = (sport: string): SportGroup => GROUPS[sport] ?? 'other';

export const GROUP_LABELS: Record<SportGroup, string> = {
  all: 'All sports',
  run: 'Runs',
  ride: 'Rides',
  walk: 'Walks & hikes',
  swim: 'Swims',
  other: 'Other',
};

const ICONS: Record<string, string> = {
  run: '🏃',
  ride: '🚴',
  walk: '🥾',
  swim: '🏊',
  WeightTraining: '🏋️',
  Yoga: '🧘',
  Workout: '💪',
  AlpineSki: '⛷️',
  BackcountrySki: '⛷️',
  NordicSki: '⛷️',
  Snowboard: '🏂',
  Rowing: '🚣',
  Kayaking: '🛶',
  Canoeing: '🛶',
  Surfing: '🏄',
  RockClimbing: '🧗',
  Golf: '⛳',
  Tennis: '🎾',
  Soccer: '⚽',
  IceSkate: '⛸️',
  Elliptical: '🏃',
  StairStepper: '🪜',
};

export function sportIcon(sport: string): string {
  const g = groupOf(sport);
  if (sport === 'Walk') return '🚶';
  return ICONS[sport] ?? ICONS[g] ?? '🏅';
}

export function sportLabel(sport: string): string {
  const special: Record<string, string> = { EBikeRide: 'E-bike ride', EMountainBikeRide: 'E-mountain bike ride', VirtualRide: 'Virtual ride', VirtualRun: 'Virtual run' };
  return special[sport] ?? sport.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^(.)(.*)$/, (_, a, b) => a + b.toLowerCase());
}

export const matches = (a: Activity, g: SportGroup) => g === 'all' || groupOf(a.sport) === g;

// ---- Units ----

const MI = 1609.344;
const FT = 0.3048;

export function distance(m: number, u: Units, digits?: number): string {
  const v = u === 'metric' ? m / 1000 : m / MI;
  const d = digits ?? (v >= 100 ? 0 : 1);
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
export const distUnit = (u: Units) => (u === 'metric' ? 'km' : 'mi');
export const distValue = (m: number, u: Units) => (u === 'metric' ? m / 1000 : m / MI);

export const elevation = (m: number, u: Units) => Math.round(u === 'metric' ? m : m / FT).toLocaleString();
export const elevUnit = (u: Units) => (u === 'metric' ? 'm' : 'ft');
export const elevValue = (m: number, u: Units) => (u === 'metric' ? m : m / FT);

/** "1:05:12" or "25:40"; long totals as "12h 5m". */
export function duration(s: number, style: 'clock' | 'words' = 'words'): string {
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (style === 'clock') {
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }
  if (h >= 100) return `${h.toLocaleString()}h`;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Pace for foot sports and swims, speed for everything else. */
export function paceOrSpeed(a: { sport: string; speed: number | null; dist: number; move: number }, u: Units): { value: string; unit: string; label: string } | null {
  const speed = a.speed ?? (a.move ? a.dist / a.move : 0);
  if (!speed || !a.dist) return null;
  const g = groupOf(a.sport);
  if (g === 'swim') {
    const per = u === 'metric' ? 100 : 91.44;
    return { value: duration(per / speed, 'clock'), unit: u === 'metric' ? '/100m' : '/100yd', label: 'Pace' };
  }
  if (g === 'run' || g === 'walk') {
    const per = u === 'metric' ? 1000 : MI;
    return { value: duration(per / speed, 'clock'), unit: `/${distUnit(u)}`, label: 'Pace' };
  }
  const v = u === 'metric' ? speed * 3.6 : speed * 2.236936;
  return { value: v.toFixed(1), unit: u === 'metric' ? 'km/h' : 'mph', label: 'Speed' };
}

export function metricValue(a: Activity, metric: Metric, u: Units): number {
  if (metric === 'time') return a.move / 3600;
  if (metric === 'elevation') return elevValue(a.elev, u);
  return distValue(a.dist, u);
}

export function metricText(v: number, metric: Metric, u: Units): string {
  if (metric === 'time') return duration(v * 3600);
  if (metric === 'elevation') return `${Math.round(v).toLocaleString()} ${elevUnit(u)}`;
  return `${v.toLocaleString(undefined, { maximumFractionDigits: v >= 100 ? 0 : 1, minimumFractionDigits: v >= 100 ? 0 : 1 })} ${distUnit(u)}`;
}
export const METRIC_LABELS: Record<Metric, string> = { distance: 'Distance', time: 'Time', elevation: 'Elevation' };

// ---- Dates (all by the activity's own wall-clock day) ----

/** "YYYY-MM-DD" of the activity's local start. */
export const dayKey = (a: Activity) => a.local.slice(0, 10);
export function keyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function parseKey(k: string): Date {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
/** Midnight at the start of the week containing d. */
export function weekStart(d: Date, startsMonday: boolean): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const back = (x.getDay() - (startsMonday ? 1 : 0) + 7) % 7;
  return addDays(x, -back);
}

export const localDate = (a: Activity) => new Date(a.local);

export function when(a: Activity): string {
  const d = localDate(a);
  const today = keyOf(new Date());
  const k = dayKey(a);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (k === today) return `Today ${time}`;
  if (k === keyOf(addDays(new Date(), -1))) return `Yesterday ${time}`;
  const days = (Date.now() - d.getTime()) / 86400000;
  if (days < 6) return `${d.toLocaleDateString([], { weekday: 'long' })} ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

// ---- Totals ----

export interface Totals {
  count: number;
  dist: number;
  move: number;
  elev: number;
  /** Total in the chosen metric's display unit. */
  value: number;
}

export function totals(list: Activity[], metric: Metric = 'distance', u: Units = 'imperial'): Totals {
  const t = { count: 0, dist: 0, move: 0, elev: 0, value: 0 };
  for (const a of list) {
    t.count++;
    t.dist += a.dist;
    t.move += a.move;
    t.elev += a.elev;
    t.value += metricValue(a, metric, u);
  }
  return t;
}

/** Activities from day key `from` (inclusive) to `to` (exclusive). */
export const between = (list: Activity[], from: string, to: string) => list.filter((a) => dayKey(a) >= from && dayKey(a) < to);

export interface Bucket {
  key: string;
  label: string;
  start: Date;
  value: number;
  count: number;
  list: Activity[];
}

/** Totals per day of the current week, oldest first. */
export function weekDays(list: Activity[], metric: Metric, u: Units, startsMonday: boolean, offsetWeeks = 0): Bucket[] {
  const start = addDays(weekStart(new Date(), startsMonday), offsetWeeks * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(start, i);
    const k = keyOf(d);
    const hits = list.filter((a) => dayKey(a) === k);
    return { key: k, label: d.toLocaleDateString([], { weekday: 'narrow' }), start: d, value: hits.reduce((s, a) => s + metricValue(a, metric, u), 0), count: hits.length, list: hits };
  });
}

/** Totals for the last n weeks (current week last). */
export function weeks(list: Activity[], n: number, metric: Metric, u: Units, startsMonday: boolean): Bucket[] {
  const cur = weekStart(new Date(), startsMonday);
  const out: Bucket[] = [];
  const byWeek = new Map<string, Activity[]>();
  for (const a of list) {
    const k = keyOf(weekStart(localDate(a), startsMonday));
    byWeek.get(k)?.push(a) ?? byWeek.set(k, [a]);
  }
  for (let i = n - 1; i >= 0; i--) {
    const s = addDays(cur, -7 * i);
    const k = keyOf(s);
    const hits = byWeek.get(k) ?? [];
    out.push({ key: k, label: s.toLocaleDateString([], { month: 'short', day: 'numeric' }), start: s, value: hits.reduce((x, a) => x + metricValue(a, metric, u), 0), count: hits.length, list: hits });
  }
  return out;
}

/** Totals per month for the last n months (current month last). */
export function months(list: Activity[], n: number, metric: Metric, u: Units): Bucket[] {
  const now = new Date();
  const out: Bucket[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const s = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const e = new Date(s.getFullYear(), s.getMonth() + 1, 1);
    const hits = between(list, keyOf(s), keyOf(e));
    out.push({ key: keyOf(s), label: s.toLocaleDateString([], { month: 'short' }), start: s, value: hits.reduce((x, a) => x + metricValue(a, metric, u), 0), count: hits.length, list: hits });
  }
  return out;
}

/** Day totals keyed "YYYY-MM-DD", for the calendar heatmap. */
export function byDay(list: Activity[], metric: Metric, u: Units): Map<string, { value: number; list: Activity[] }> {
  const m = new Map<string, { value: number; list: Activity[] }>();
  for (const a of list) {
    const k = dayKey(a);
    const e = m.get(k) ?? { value: 0, list: [] };
    e.value += metricValue(a, metric, u);
    e.list.push(a);
    m.set(k, e);
  }
  return m;
}

/** Running total through the year, one point per day of year (index 0 = Jan 1). */
export function cumulative(list: Activity[], year: number, metric: Metric, u: Units, upToToday = false): number[] {
  const days = new Map<number, number>();
  const jan1 = new Date(year, 0, 1);
  for (const a of list) {
    const d = localDate(a);
    if (d.getFullYear() !== year) continue;
    const i = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - jan1.getTime()) / 86400000 + 0.5);
    days.set(i, (days.get(i) ?? 0) + metricValue(a, metric, u));
  }
  const len = upToToday ? Math.floor((Date.now() - jan1.getTime()) / 86400000) + 1 : new Date(year, 1, 29).getMonth() === 1 ? 366 : 365;
  const out: number[] = [];
  let run = 0;
  for (let i = 0; i < len; i++) {
    run += days.get(i) ?? 0;
    out.push(run);
  }
  return out;
}

/** Days in a row with an activity, ending today (or yesterday, if today is still open). */
export function streak(list: Activity[]): { days: number; weeks: number } {
  const set = new Set(list.map(dayKey));
  let d = new Date();
  if (!set.has(keyOf(d))) d = addDays(d, -1);
  let days = 0;
  while (set.has(keyOf(d))) {
    days++;
    d = addDays(d, -1);
  }
  // Weeks in a row with at least one activity, counting this week only once it has one.
  const wk = new Set(list.map((a) => keyOf(weekStart(localDate(a), true))));
  let w = weekStart(new Date(), true);
  if (!wk.has(keyOf(w))) w = addDays(w, -7);
  let weeksRun = 0;
  while (wk.has(keyOf(w))) {
    weeksRun++;
    w = addDays(w, -7);
  }
  return { days, weeks: weeksRun };
}

export interface Record_ {
  label: string;
  value: string;
  activity: Activity | null;
}

/** Biggest days from the summaries (no extra Strava requests). */
export function records(list: Activity[], g: SportGroup, u: Units, startsMonday: boolean): Record_[] {
  const pick = (score: (a: Activity) => number) => list.reduce<Activity | null>((best, a) => (score(a) > (best ? score(best) : 0) ? a : best), null);
  const longest = pick((a) => a.dist);
  const longestTime = pick((a) => a.move);
  const climb = pick((a) => a.elev);
  const out: Record_[] = [];
  if (longest) out.push({ label: 'Longest', value: `${distance(longest.dist, u)} ${distUnit(u)}`, activity: longest });
  if (longestTime) out.push({ label: 'Longest time', value: duration(longestTime.move), activity: longestTime });
  if (climb && climb.elev > 0) out.push({ label: 'Most climbing', value: `${elevation(climb.elev, u)} ${elevUnit(u)}`, activity: climb });
  if (g === 'run' || g === 'ride' || g === 'swim') {
    // Fastest average over a real distance (5 km runs, 20 km rides, 400 m swims).
    const min = g === 'run' ? 5000 : g === 'ride' ? 20000 : 400;
    const fast = pick((a) => (a.dist >= min && !a.trainer ? a.speed ?? 0 : 0));
    const ps = fast && paceOrSpeed(fast, u);
    const minLabel = g === 'run' ? (u === 'metric' ? '5 km' : '3.1 mi') : g === 'ride' ? (u === 'metric' ? '20 km' : '12 mi') : '400 m';
    if (fast && ps) out.push({ label: `Fastest ${g === 'ride' ? 'avg speed' : 'avg pace'} (${minLabel}+)`, value: `${ps.value} ${ps.unit}`, activity: fast });
  }
  const wk = weeks(list, 520, 'distance', u, startsMonday).reduce<Bucket | null>((b, x) => (x.value > (b?.value ?? 0) ? x : b), null);
  if (wk) out.push({ label: 'Biggest week', value: `${wk.value.toFixed(1)} ${distUnit(u)} · week of ${wk.start.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`, activity: null });
  const mo = new Map<string, number>();
  for (const a of list) mo.set(a.local.slice(0, 7), (mo.get(a.local.slice(0, 7)) ?? 0) + a.dist);
  const best = [...mo.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best) {
    const [y, m] = best[0].split('-').map(Number);
    out.push({ label: 'Biggest month', value: `${distance(best[1], u)} ${distUnit(u)} · ${new Date(y, m - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' })}`, activity: null });
  }
  const s = streak(list);
  out.push({ label: 'Current streak', value: `${s.days} day${s.days === 1 ? '' : 's'} · ${s.weeks} week${s.weeks === 1 ? '' : 's'} in a row`, activity: null });
  return out;
}
