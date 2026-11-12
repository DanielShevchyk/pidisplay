// Strava: this week's training at a glance, the latest activity with its route, and a
// dashboard sheet (trends, calendar, personal heatmap, records). Data comes from the
// server (server/strava.js), which syncs with Strava itself; see docs/STRAVA.md.
import { h } from '../../core/dom';
import { defineWidget, type Placement } from '../../core/types';
import { barChart, calendarHeat, ring } from './charts';
import { decodePolyline, routeMap } from './map';
import { activityRow, openActivity, openDashboard, type View } from './sheets';
import {
  addDays,
  byDay,
  distUnit,
  distance,
  duration,
  elevUnit,
  elevation,
  GROUP_LABELS,
  keyOf,
  matches,
  metricText,
  paceOrSpeed,
  sportIcon,
  streak,
  totals,
  weekDays,
  weekStart,
  weeks,
  when,
  type Activity,
  type Metric,
  type Snapshot,
  type SportGroup,
  type Units,
} from './stats';
import { subscribe } from './store';
import './strava.css';

interface StravaConfig {
  sport: SportGroup;
  metric: Metric;
  units: 'auto' | Units;
  /** Weekly goal in the metric's unit (mi/km, hours or ft/m); 0 = none. */
  goal: number;
  weekStart: 'mon' | 'sun';
  [key: string]: unknown;
}

export default defineWidget<StravaConfig>({
  type: 'strava',
  name: 'Strava',
  description: 'Your Strava activities: this week, latest route, trends, calendar and heatmap',
  icon: '🏃',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'large',
  supportsBar: true,
  defaultConfig: { sport: 'all', metric: 'distance', units: 'auto', goal: 0, weekStart: 'mon' },
  settings: [
    {
      key: 'sport',
      label: 'Sport',
      type: 'select',
      options: (['all', 'run', 'ride', 'walk', 'swim'] as SportGroup[]).map((g) => ({ value: g, label: GROUP_LABELS[g] })),
    },
    {
      key: 'metric',
      label: 'Count',
      type: 'select',
      options: [
        { value: 'distance', label: 'Distance' },
        { value: 'time', label: 'Moving time' },
        { value: 'elevation', label: 'Elevation gain' },
      ],
    },
    { key: 'goal', label: 'Weekly goal (miles/km, hours or feet/m; 0 = none)', type: 'number', min: 0, max: 100000, step: 1 },
    {
      key: 'units',
      label: 'Units',
      type: 'select',
      options: [
        { value: 'auto', label: 'Same as my Strava account' },
        { value: 'imperial', label: 'Miles and feet' },
        { value: 'metric', label: 'Kilometers and meters' },
      ],
    },
    {
      key: 'weekStart',
      label: 'Weeks start on',
      type: 'select',
      options: [
        { value: 'mon', label: 'Monday' },
        { value: 'sun', label: 'Sunday' },
      ],
    },
  ],

  mount(el, { config, placement }) {
    const root = h('div', { class: `strava size-${placement}` });
    el.append(root);
    let cleanups: (() => void)[] = [];
    let lastKey = '';

    const viewOf = (s: Snapshot): View => ({
      sport: config.sport,
      metric: config.metric,
      units: config.units === 'auto' ? s.athlete?.units ?? 'imperial' : config.units,
      goal: Number(config.goal) || 0,
      startsMonday: config.weekStart !== 'sun',
    });

    let latest: [Snapshot | null, string] = [null, ''];
    const paint = (s: Snapshot | null, error: string) => {
      latest = [s, error];
      // Skip repaints that change nothing (each sync sends an event).
      const key = s ? `${s.connected}|${s.error}|${s.count}|${s.activities[0]?.id}|${s.activities[0]?.name}|${s.lastSync && new Date(s.lastSync).toDateString()}|${keyOf(new Date())}` : error;
      if (key === lastKey) return;
      lastKey = key;
      cleanups.forEach((f) => f());
      cleanups = [];
      if (!s) return root.replaceChildren(placement === 'bar' ? '' : message('🏃', error || 'Loading Strava…'));
      if (!s.connected) return root.replaceChildren(placement === 'bar' ? '' : setup(s));
      if (!s.activities.length) {
        return root.replaceChildren(placement === 'bar' ? '' : message('⏳', s.error || 'Downloading your activities from Strava…'));
      }
      const view = viewOf(s);
      const list = s.activities.filter((a) => matches(a, view.sport));
      const ctx: Ctx = { s, view, list, placement, onCleanup: (f) => cleanups.push(f) };
      root.replaceChildren(render(ctx));
    };

    const unsub = subscribe(paint);
    // Roll over to a new day (new week) without waiting for a sync.
    const tick = window.setInterval(() => {
      lastKey = '';
      paint(...latest);
    }, 30 * 60 * 1000);

    return {
      destroy() {
        unsub();
        clearInterval(tick);
        cleanups.forEach((f) => f());
      },
    };
  },
});

interface Ctx {
  s: Snapshot;
  view: View;
  list: Activity[];
  placement: Placement;
  onCleanup: (f: () => void) => void;
}

function message(icon: string, text: string, ...extra: Node[]): HTMLElement {
  return h('div', { class: 'strava-message' }, h('div', { class: 'strava-message-icon' }, icon), h('div', {}, text), ...extra);
}

function setup(s: Snapshot): HTMLElement {
  if (!s.configured) {
    return message('🔑', 'Strava isn\'t set up yet. On the laptop run .\\deploy\\strava.ps1 -ClientId <id> (see docs/STRAVA.md).');
  }
  const login = () => {
    location.href = `/api/strava/login?return=${encodeURIComponent(location.pathname + location.search)}`;
  };
  return message(
    '🔗',
    s.error || 'Connect your Strava account. Easiest from the laptop: .\\deploy\\strava.ps1',
    h('button', { class: 'btn', onclick: (e: Event) => (e.stopPropagation(), login()) }, 'Connect on this screen'),
  );
}

// ---- Pieces ----

function weekNumbers(c: Ctx) {
  const u = c.view.units;
  const from = keyOf(weekStart(new Date(), c.view.startsMonday));
  const thisWeek = c.list.filter((a) => a.local.slice(0, 10) >= from);
  const t = totals(thisWeek, c.view.metric, u);
  // Last week up to the same weekday and hour, so the comparison is fair mid-week.
  const lastFrom = keyOf(addDays(weekStart(new Date(), c.view.startsMonday), -7));
  const cutoff = Date.now() - 7 * 86400000;
  const last = totals(c.list.filter((a) => a.local.slice(0, 10) >= lastFrom && a.local.slice(0, 10) < from && Date.parse(a.start) <= cutoff), c.view.metric, u);
  return { t, last };
}

function weekBars(c: Ctx, compact = true): HTMLElement {
  const u = c.view.units;
  const days = weekDays(c.list, c.view.metric, u, c.view.startsMonday);
  const today = keyOf(new Date());
  return barChart(
    days.map((d) => ({
      label: d.label,
      value: d.value,
      current: d.key === today,
      detail: d.list.length ? `${d.start.toLocaleDateString([], { weekday: 'long' })}: ${d.list.map((a) => a.name).join(', ')}` : '',
    })),
    { compact },
  );
}

function bigWeek(c: Ctx, label = 'This week'): HTMLElement {
  const { t, last } = weekNumbers(c);
  const u = c.view.units;
  const diff = t.value - last.value;
  const vs = last.value || t.value ? `${diff >= 0 ? '▲' : '▼'} ${metricText(Math.abs(diff), c.view.metric, u)} vs last week` : '';
  return h(
    'div',
    { class: 'strava-week' },
    h('div', { class: 'strava-label' }, c.view.sport === 'all' ? label : `${label} · ${GROUP_LABELS[c.view.sport]}`),
    h('div', { class: 'strava-big' }, metricText(t.value, c.view.metric, u)),
    h('div', { class: 'strava-dim' }, `${t.count} ${t.count === 1 ? 'activity' : 'activities'} · ${duration(t.move)}${c.view.metric !== 'elevation' && t.elev ? ` · ${elevation(t.elev, u)} ${elevUnit(u)}` : ''}`),
    vs ? h('div', { class: diff >= 0 ? 'strava-up' : 'strava-down' }, vs) : null,
    c.view.goal ? goalLine(t.value, c) : null,
  );
}

function goalLine(value: number, c: Ctx): HTMLElement {
  const f = value / c.view.goal;
  return h(
    'div',
    { class: 'strava-goal' },
    h('span', { style: `width:${Math.min(100, f * 100)}%` }),
    h('em', {}, f >= 1 ? '🎉 Goal reached' : `${metricText(Math.max(0, c.view.goal - value), c.view.metric, c.view.units)} to go`),
  );
}

function latestCard(c: Ctx, a: Activity, withMap: boolean): HTMLElement {
  const u = c.view.units;
  const ps = paceOrSpeed(a, u);
  const mapBox = withMap ? h('div', { class: 'strava-latest-map' }) : null;
  const pts = a.poly ? decodePolyline(a.poly) : [];
  if (mapBox) {
    if (pts.length > 1) c.onCleanup(routeMap(mapBox, [{ points: pts, main: true }], { credit: false, padding: 18 }));
    else mapBox.append(h('div', { class: 'strava-map-empty' }, h('span', { class: 'strava-map-icon' }, sportIcon(a.sport)), a.trainer ? 'Indoor' : ''));
  }
  const nums: [string, string][] = [];
  if (a.dist) nums.push([`${distance(a.dist, u, 2)}`, distUnit(u)]);
  nums.push([duration(a.move, 'clock'), 'time']);
  if (ps) nums.push([ps.value, ps.unit]);
  if (a.elev) nums.push([elevation(a.elev, u), elevUnit(u)]);
  if (a.hr) nums.push([String(a.hr), 'bpm']);
  return h(
    'button',
    { class: 'strava-latest', onclick: (e: Event) => (e.stopPropagation(), openActivity(a, c.view)) },
    mapBox,
    h(
      'div',
      { class: 'strava-latest-info' },
      h('div', { class: 'strava-latest-name' }, `${sportIcon(a.sport)} ${a.name}`),
      h('div', { class: 'strava-dim' }, `${when(a)}${a.prs ? ` · 🏆 ${a.prs}` : ''}${a.kudos ? ` · 👍 ${a.kudos}` : ''}`),
      h('div', { class: 'strava-nums' }, ...nums.map(([v, unit]) => h('span', {}, h('b', {}, v), ` ${unit}`))),
    ),
  );
}

function trend(c: Ctx, n: number): HTMLElement {
  const u = c.view.units;
  const bs = weeks(c.list, n, c.view.metric, u, c.view.startsMonday);
  return barChart(
    bs.map((b, i) => ({ label: i % 4 === 0 || i === bs.length - 1 ? b.label : '', value: b.value, current: i === bs.length - 1, detail: '' })),
    { goal: c.view.goal || undefined, compact: true },
  );
}

function miniCalendar(c: Ctx, nWeeks: number): HTMLElement {
  const days = byDay(c.list, c.view.metric, c.view.units);
  const first = addDays(weekStart(new Date(), c.view.startsMonday), -7 * (nWeeks - 1));
  const today = keyOf(new Date());
  const cols = Array.from({ length: nWeeks }, (_, w) => {
    const start = addDays(first, w * 7);
    return {
      start,
      days: Array.from({ length: 7 }, (_, d) => {
        const k = keyOf(addDays(start, d));
        return k > today ? null : { key: k, value: days.get(k)?.value ?? 0, detail: '' };
      }),
    };
  });
  const s = streak(c.list);
  return h(
    'div',
    { class: 'strava-mini-cal' },
    h('div', { class: 'strava-label' }, `Last ${nWeeks} weeks · ${s.weeks}-week streak`),
    calendarHeat(cols, { dayLabels: Array.from({ length: 7 }, (_, i) => addDays(first, i).toLocaleDateString([], { weekday: 'narrow' })) }),
  );
}

function periodCards(c: Ctx): HTMLElement {
  const u = c.view.units;
  const now = new Date();
  const mo = keyOf(new Date(now.getFullYear(), now.getMonth(), 1));
  const yr = `${now.getFullYear()}-01-01`;
  const m = totals(c.list.filter((a) => a.local.slice(0, 10) >= mo), c.view.metric, u);
  const y = totals(c.list.filter((a) => a.local.slice(0, 10) >= yr), c.view.metric, u);
  const card = (label: string, t: typeof m) =>
    h('div', { class: 'strava-period' }, h('div', { class: 'strava-label' }, label), h('div', { class: 'strava-period-value' }, metricText(t.value, c.view.metric, u)), h('div', { class: 'strava-dim' }, `${t.count} · ${duration(t.move)}`));
  return h('div', { class: 'strava-periods' }, card(now.toLocaleDateString([], { month: 'long' }), m), card(String(now.getFullYear()), y));
}

// ---- Layouts ----

function render(c: Ctx): HTMLElement {
  const latest = c.list[0] ?? null;
  const open = () => openDashboard(c.view);
  const u = c.view.units;
  switch (c.placement) {
    case 'bar': {
      const { t } = weekNumbers(c);
      return h('button', { class: 'strava-bar-item', onclick: open }, h('span', {}, c.view.sport === 'all' ? '🏃' : sportIcon(latest?.sport ?? 'Run')), h('b', {}, metricText(t.value, c.view.metric, u)), h('span', { class: 'strava-dim' }, 'this week'));
    }
    case 'small': {
      const { t } = weekNumbers(c);
      if (c.view.goal) {
        return h(
          'button',
          { class: 'strava-tile strava-small', onclick: open },
          ring(t.value / c.view.goal, [h('div', { class: 'strava-ring-value' }, metricText(t.value, c.view.metric, u)), h('div', { class: 'strava-dim' }, `of ${metricText(c.view.goal, c.view.metric, u)}`)]),
        );
      }
      return h(
        'button',
        { class: 'strava-tile strava-small', onclick: open },
        h('div', { class: 'strava-label' }, 'This week'),
        h('div', { class: 'strava-big' }, metricText(t.value, c.view.metric, u)),
        h('div', { class: 'strava-dim' }, `${t.count} ${t.count === 1 ? 'activity' : 'activities'}`),
        weekBars(c),
      );
    }
    case 'medium':
      return h('button', { class: 'strava-tile strava-medium', onclick: open }, bigWeek(c), h('div', { class: 'strava-medium-bars' }, weekBars(c)));
    case 'tall':
      return h('div', { class: 'strava-tile strava-tall', onclick: open }, bigWeek(c), h('div', { class: 'strava-tall-bars' }, weekBars(c)), latest ? latestCard(c, latest, false) : null);
    case 'large':
      return h(
        'div',
        { class: 'strava-tile strava-large', onclick: open },
        latest ? latestCard(c, latest, true) : message('🏃', 'No activities yet'),
        h('div', { class: 'strava-large-foot' }, bigWeek(c), h('div', { class: 'strava-large-bars' }, weekBars(c))),
      );
    default: {
      // xlarge and full: latest route on the left, the numbers on the right.
      const full = c.placement === 'full';
      const recent = c.list.slice(1, full ? 6 : 1);
      return h(
        'div',
        { class: `strava-tile strava-dash-tile${full ? ' full' : ''}`, onclick: open },
        h('div', { class: 'strava-dash-left' }, latest ? latestCard(c, latest, true) : message('🏃', 'No activities yet'), full && recent.length ? h('div', { class: 'strava-recent' }, ...recent.map((a) => activityRow(a, u, () => openActivity(a, c.view)))) : null),
        h(
          'div',
          { class: 'strava-dash-right' },
          h('div', { class: 'strava-dash-week' }, bigWeek(c), h('div', { class: 'strava-dash-weekbars' }, weekBars(c))),
          periodCards(c),
          h('div', { class: 'strava-dash-trend' }, h('div', { class: 'strava-label' }, `Last ${full ? 16 : 12} weeks`), trend(c, full ? 16 : 12)),
          full ? miniCalendar(c, 26) : null,
        ),
      );
    }
  }
}
