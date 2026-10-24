// Things worked out from the forecast: weather alerts, rain in the next two hours,
// highlights worth a glance ("12° colder tomorrow") and the moon's phase.
import { h } from '../../core/dom';
import { openSheet } from '../../core/sheet';

/** An active National Weather Service alert, as GET /api/weather returns it. */
export interface Alert {
  id: string;
  event: string;
  /** NWS severity: Extreme, Severe, Moderate, Minor or Unknown. */
  severity: string;
  headline: string;
  description: string;
  instruction: string;
  ends: number | null;
  sender: string;
}

/** The parts of the forecast these need (the full type lives in index.ts). */
interface Day {
  date: number;
  high: number | null;
  low: number | null;
  code: number;
  precipChance: number | null;
  gustMax?: number | null;
}
interface Data {
  units: 'imperial' | 'metric';
  timezone: string;
  current: { temp: number | null };
  daily: Day[];
  soon?: { time: number; precip: number | null }[];
  yesterday?: { high: number | null; low: number | null } | null;
  alerts?: Alert[];
}

const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

/** Alerts that haven't ended yet (a cached forecast can hold expired ones). */
export function activeAlerts(d: Data): Alert[] {
  const now = Date.now() / 1000;
  return (d.alerts ?? []).filter((a) => !a.ends || a.ends > now);
}

export function alertClass(a: Alert): string {
  return a.severity === 'Extreme' || a.severity === 'Severe' ? 'wx-alert-severe' : a.severity === 'Moderate' ? 'wx-alert-moderate' : 'wx-alert-minor';
}

/** Every alert in full: what, until when, the details and what to do. */
export function alertView(alerts: Alert[], timeZone: string | undefined): HTMLElement {
  const until = new Intl.DateTimeFormat([], { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone });
  return h(
    'div',
    { class: 'wx-alerts' },
    ...(alerts.length
      ? alerts.map((a) =>
          h(
            'section',
            { class: `wx-alert-card ${alertClass(a)}` },
            h('h3', {}, `⚠️ ${a.event}`),
            h('div', { class: 'wx-alert-meta' }, [a.ends ? `Until ${until.format(a.ends * 1000)}` : '', a.sender].filter(Boolean).join(' · ')),
            a.headline && h('p', { class: 'wx-alert-headline' }, a.headline),
            a.description && h('p', { class: 'wx-alert-text' }, a.description),
            a.instruction && h('p', { class: 'wx-alert-text wx-alert-do' }, a.instruction),
          ),
        )
      : [h('div', { class: 'wx-airmap-status' }, 'No weather alerts right now')]),
  );
}

export function openAlerts(place: string, alerts: Alert[], timeZone: string | undefined) {
  const sheet = openSheet(`⚠️ Weather alerts for ${place}`, [alertView(alerts, timeZone)]);
  sheet.body.closest('.sheet')?.classList.add('wx-alert-sheet');
}

/** "Rain starting in 25 min", "Rain ending around 4:15 PM"; null when the next two hours stay dry. */
export function rainSoon(d: Data): string | null {
  const now = Date.now() / 1000;
  const steps = (d.soon ?? []).filter((x) => x.time > now && x.precip !== null);
  if (steps.length < 2) return null;
  // 0.1 mm (0.004 in) in 15 minutes is the lightest rain worth mentioning.
  const wet = (x: { precip: number | null }) => (x.precip ?? 0) >= (d.units === 'imperial' ? 0.004 : 0.1);
  const freezing = d.current.temp !== null && d.current.temp <= (d.units === 'imperial' ? 33 : 0.5);
  const kind = freezing ? 'Snow' : 'Rain';
  const clock = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', timeZone: validZone(d.timezone) });
  // Each step is the 15 minutes ending at its time.
  const when = (t: number) => {
    const mins = Math.round((t - now) / 60 / 5) * 5;
    if (mins <= 5) return 'in a few minutes';
    return mins < 60 ? `in ${mins} min` : `around ${clock.format(t * 1000)}`;
  };
  if (wet(steps[0])) {
    const dry = steps.findIndex((x) => !wet(x));
    return dry < 0 ? `${kind} for the next 2 hours` : `${kind} ending ${when(steps[dry].time - 900)}`;
  }
  const start = steps.findIndex(wet);
  return start < 0 ? null : `${kind} starting ${when(steps[start].time - 900)}`;
}

/** A few short lines on what's changing or extreme in the coming days, most useful first. */
export function highlights(d: Data): string[] {
  const out: string[] = [];
  const imperial = d.units === 'imperial';
  const tz = validZone(d.timezone);
  const weekday = new Intl.DateTimeFormat([], { weekday: 'long', timeZone: tz });
  const dayName = (i: number) => (i === 0 ? 'today' : i === 1 ? 'tomorrow' : weekday.format(d.daily[i].date * 1000));
  const days = d.daily;
  const today = days[0];
  if (!today) return out;

  if (d.yesterday?.high != null && today.high != null) {
    const diff = today.high - d.yesterday.high;
    if (Math.abs(diff) >= (imperial ? 3 : 2)) out.push(`${Math.abs(diff)}° ${diff > 0 ? 'warmer' : 'cooler'} than yesterday`);
  }
  if (days[1]?.high != null && today.high != null) {
    const diff = days[1].high - today.high;
    if (Math.abs(diff) >= (imperial ? 8 : 4)) out.push(`Tomorrow ${Math.abs(diff)}° ${diff > 0 ? 'warmer' : 'colder'}`);
  }
  const heat = days.slice(0, 4).findIndex((x) => x.high !== null && x.high >= (imperial ? 100 : 38));
  if (heat >= 0) out.push(`Very hot: ${days[heat].high}° ${dayName(heat)}`);
  const freeze = days.slice(0, 4).findIndex((x) => x.low !== null && x.low <= (imperial ? 32 : 0));
  if (freeze >= 0) out.push(`Freezing low of ${days[freeze].low}° ${freeze === 0 ? 'tonight' : `${dayName(freeze)} night`}`);
  const gusts = days.slice(0, 3).map((x) => x.gustMax ?? 0);
  const gustDay = gusts.indexOf(Math.max(...gusts));
  if (gusts[gustDay] >= (imperial ? 35 : 55)) out.push(`Gusts to ${gusts[gustDay]} ${imperial ? 'mph' : 'km/h'} ${dayName(gustDay)}`);
  if ((today.precipChance ?? 0) < 40) {
    const wet = days.findIndex((x, i) => i > 0 && i < 7 && (x.precipChance ?? 0) >= 60);
    if (wet > 0) out.push(`${SNOW_CODES.has(days[wet].code) ? 'Snow' : 'Rain'} likely ${dayName(wet)} (${days[wet].precipChance}%)`);
  }
  return out.slice(0, 4);
}

const SYNODIC_DAYS = 29.530588853;
/** A new moon: 2000-01-06 18:14 UTC. */
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);
const PHASES: [number, string, string][] = [
  [0.0339, '🌑', 'New moon'],
  [0.216, '🌒', 'Waxing crescent'],
  [0.284, '🌓', 'First quarter'],
  [0.466, '🌔', 'Waxing gibbous'],
  [0.534, '🌕', 'Full moon'],
  [0.716, '🌖', 'Waning gibbous'],
  [0.784, '🌗', 'Last quarter'],
  [0.966, '🌘', 'Waning crescent'],
  [1, '🌑', 'New moon'],
];

/** The moon's phase at a time (ms): emoji, name, percent lit and days until the next full moon. */
export function moonPhase(ms: number) {
  const age = ((((ms - KNOWN_NEW_MOON) / 86400000) % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS;
  const p = age / SYNODIC_DAYS;
  const [, icon, name] = PHASES.find(([max]) => p < max)!;
  const lit = Math.round(((1 - Math.cos(2 * Math.PI * p)) / 2) * 100);
  const toFull = (((0.5 - p + 1) % 1) * SYNODIC_DAYS);
  return { icon, name, lit, fullAt: ms + toFull * 86400000 };
}

/** "🌔 Waxing gibbous, 78% · full moon Mon" */
export function moonText(ms: number, timeZone: string | undefined): string {
  const m = moonPhase(ms);
  const full = new Intl.DateTimeFormat([], { weekday: 'short', month: 'short', day: 'numeric', timeZone }).format(m.fullAt);
  return m.name === 'Full moon' ? `${m.icon} Full moon` : `${m.icon} ${m.name}, ${m.lit}% · full moon ${full}`;
}

function validZone(zone: string): string | undefined {
  try {
    new Intl.DateTimeFormat([], { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}
