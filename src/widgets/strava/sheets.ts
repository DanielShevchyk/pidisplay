// Full-screen sheets for the Strava widget: the dashboard (overview, activity list,
// calendar, personal heatmap, records) and one activity in detail.
import { h } from '../../core/dom';
import { openSheet, type SheetHandle } from '../../core/sheet';
import { barChart, calendarHeat, lineChart, type HeatCell } from './charts';
import { decodePolyline, homeArea, routeMap, type LatLng } from './map';
import {
  addDays,
  byDay,
  cumulative,
  distUnit,
  distance,
  duration,
  elevUnit,
  elevation,
  GROUP_LABELS,
  keyOf,
  matches,
  METRIC_LABELS,
  metricText,
  months,
  paceOrSpeed,
  records,
  sportIcon,
  sportLabel,
  totals,
  weekStart,
  weeks,
  when,
  type Activity,
  type Metric,
  type Snapshot,
  type SportGroup,
  type Units,
} from './stats';
import { activityDetail, allRoutes, current, syncNow, type ActivityDetail, type Split } from './store';

export interface View {
  sport: SportGroup;
  metric: Metric;
  units: Units;
  goal: number;
  startsMonday: boolean;
}

type Tab = 'overview' | 'activities' | 'calendar' | 'heatmap' | 'records';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'],
  ['activities', 'Activities'],
  ['calendar', 'Calendar'],
  ['heatmap', 'Heatmap'],
  ['records', 'Records'],
];

const wide = (s: SheetHandle) => s.body.closest('.sheet')?.classList.add('strava-sheet');

function chips<T extends string>(options: [T, string][], value: T, onPick: (v: T) => void): HTMLElement {
  return h(
    'div',
    { class: 'chips strava-chips' },
    ...options.map(([v, label]) => h('button', { class: `chip${v === value ? ' active' : ''}`, onclick: () => onPick(v) }, label)),
  );
}

/** The dashboard sheet. Sport and metric start from the tile's settings and can be changed here. */
export function openDashboard(start: View, tab: Tab = 'overview') {
  const snap = current();
  if (!snap) return;
  const view = { ...start };
  let cleanups: (() => void)[] = [];
  const content = h('div', { class: 'strava-dash' });
  const sheet = openSheet(snap.athlete?.firstname ? `${snap.athlete.firstname}'s Strava` : 'Strava', [content], { onClose: () => cleanups.forEach((f) => f()) });
  wide(sheet);

  const sports = (): [SportGroup, string][] => {
    const s = current();
    const have = new Set(s?.activities.map((a) => matchesGroup(a)) ?? []);
    return (['all', 'run', 'ride', 'walk', 'swim', 'other'] as SportGroup[]).filter((g) => g === 'all' || have.has(g)).map((g) => [g, GROUP_LABELS[g]]);
  };

  const paint = () => {
    cleanups.forEach((f) => f());
    cleanups = [];
    const s = current();
    if (!s) return;
    const list = s.activities.filter((a) => matches(a, view.sport));
    const body = (() => {
      switch (tab) {
        case 'activities':
          return activitiesTab(list, view);
        case 'calendar':
          return calendarTab(list, view, () => paint());
        case 'heatmap':
          return heatmapTab(view, (f) => cleanups.push(f));
        case 'records':
          return recordsTab(list, view);
        default:
          return overviewTab(list, view, () => paint());
      }
    })();
    content.replaceChildren(
      h('div', { class: 'strava-tabs' }, ...TABS.map(([t, label]) => h('button', { class: `strava-tab${t === tab ? ' active' : ''}`, onclick: () => ((tab = t), paint()) }, label))),
      chips(sports(), view.sport, (g) => ((view.sport = g), paint())),
      body,
      footer(s),
    );
  };
  paint();
}

const matchesGroup = (a: Activity): SportGroup => (['run', 'ride', 'walk', 'swim'] as SportGroup[]).find((g) => matches(a, g)) ?? 'other';

function footer(s: Snapshot): HTMLElement {
  const sync = h('button', { class: 'btn strava-sync' }, '⟳ Sync now');
  sync.addEventListener('click', async () => {
    sync.textContent = 'Syncing…';
    (sync as HTMLButtonElement).disabled = true;
    await syncNow().catch(() => {});
    sync.textContent = '⟳ Sync now';
    (sync as HTMLButtonElement).disabled = false;
  });
  const last = s.lastSync ? new Date(s.lastSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'never';
  return h(
    'div',
    { class: 'strava-foot' },
    h(
      'div',
      {},
      h('div', {}, `${s.count.toLocaleString()} activities${s.backfilled ? '' : ' so far (still downloading older ones)'} · synced ${last}`),
      h('div', { class: 'strava-dim' }, `Strava requests: ${s.usage.short} of ${s.usage.limits.short} this 15 min, ${s.usage.daily} of ${s.usage.limits.daily} today · Powered by Strava`),
      s.error ? h('div', { class: 'strava-warn' }, s.error) : null,
    ),
    sync,
  );
}

// ---- Overview ----

function statCard(label: string, value: string, sub: string, extra?: Node | null): HTMLElement {
  return h('div', { class: 'strava-stat' }, h('div', { class: 'strava-label' }, label), h('div', { class: 'strava-stat-value' }, value), h('div', { class: 'strava-dim' }, sub), extra ?? null);
}

function totalsLine(t: ReturnType<typeof totals>, u: Units): string {
  return `${t.count} · ${duration(t.move)} · ${elevation(t.elev, u)} ${elevUnit(u)}`;
}

function overviewTab(list: Activity[], view: View, repaint: () => void): HTMLElement {
  const u = view.units;
  const now = new Date();
  const wk = keyOf(weekStart(now, view.startsMonday));
  const mo = keyOf(new Date(now.getFullYear(), now.getMonth(), 1));
  const yr = `${now.getFullYear()}-01-01`;
  const lastYrSameDay = keyOf(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate() + 1));
  const tomorrow = keyOf(addDays(now, 1));
  const inRange = (from: string, to = tomorrow) => list.filter((a) => a.local.slice(0, 10) >= from && a.local.slice(0, 10) < to);
  const week = totals(inRange(wk), view.metric, u);
  const month = totals(inRange(mo), view.metric, u);
  const year = totals(inRange(yr), view.metric, u);
  const lastYear = totals(inRange(`${now.getFullYear() - 1}-01-01`, lastYrSameDay), view.metric, u);
  const all = totals(list, view.metric, u);
  const vsLast = lastYear.value ? Math.round(((year.value - lastYear.value) / lastYear.value) * 100) : null;
  const goalBar = view.goal
    ? h('div', { class: 'strava-goal' }, h('span', { style: `width:${Math.min(100, (week.value / view.goal) * 100)}%` }), h('em', {}, `${Math.round((week.value / view.goal) * 100)}% of ${metricText(view.goal, view.metric, u)} goal`))
    : null;

  const cards = h(
    'div',
    { class: 'strava-stats' },
    statCard('This week', metricText(week.value, view.metric, u), totalsLine(week, u), goalBar),
    statCard(now.toLocaleDateString([], { month: 'long' }), metricText(month.value, view.metric, u), totalsLine(month, u)),
    statCard(
      String(now.getFullYear()),
      metricText(year.value, view.metric, u),
      totalsLine(year, u),
      vsLast == null ? null : h('div', { class: vsLast >= 0 ? 'strava-up' : 'strava-down' }, `${vsLast >= 0 ? '▲' : '▼'} ${Math.abs(vsLast)}% vs this point last year`),
    ),
    statCard('All time', metricText(all.value, view.metric, u), totalsLine(all, u)),
  );

  let span = 16;
  const weekBox = h('div');
  const weekRead = h('div', { class: 'strava-readout' });
  const drawWeeks = () => {
    const buckets = weeks(list, span, view.metric, u, view.startsMonday);
    const avg = buckets.slice(0, -1).reduce((s, b) => s + b.value, 0) / Math.max(1, buckets.length - 1);
    const text = `Average ${metricText(avg, view.metric, u)} a week (not counting this one). Tap a bar for that week.`;
    weekRead.textContent = text;
    weekBox.replaceChildren(
      barChart(
        buckets.map((b, i) => ({
          label: b.label,
          value: b.value,
          current: i === buckets.length - 1,
          detail: `Week of ${b.start.toLocaleDateString([], { month: 'short', day: 'numeric' })}: ${metricText(b.value, view.metric, u)} · ${b.count} ${b.count === 1 ? 'activity' : 'activities'}${b.count ? ` · ${duration(b.list.reduce((s, a) => s + a.move, 0))}` : ''}`,
        })),
        { goal: view.goal || undefined, readout: weekRead, labelEvery: span > 20 ? 8 : 4, defaultText: text },
      ),
    );
  };
  drawWeeks();
  const spanChips = chips<'16' | '52'>([['16', '16 weeks'], ['52', '1 year']], '16', (v) => {
    span = Number(v);
    spanChips.querySelectorAll('.chip').forEach((c, i) => c.classList.toggle('active', (i === 0) === (v === '16')));
    drawWeeks();
  });

  // This year's running total against last year's.
  const thisYear = cumulative(list, now.getFullYear(), view.metric, u, true);
  const prevYear = cumulative(list, now.getFullYear() - 1, view.metric, u);
  const len = Math.max(thisYear.length, prevYear.length);
  const yearRead = h('div', { class: 'strava-readout' }, 'Drag across the chart to compare any day.');
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const yearChart = lineChart(
    [
      { name: String(now.getFullYear() - 1), values: prevYear.concat(Array(Math.max(0, len - prevYear.length)).fill(null)), kind: 'ghost' },
      { name: String(now.getFullYear()), values: thisYear.concat(Array(len - thisYear.length).fill(null)), kind: 'main' },
    ],
    {
      xLabel: (i) => addDays(jan1, i).toLocaleDateString([], { month: 'short', day: 'numeric' }),
      yText: (v) => metricText(v, view.metric, u),
      readout: yearRead,
      ticks: Array.from({ length: 12 }, (_, m) => ({
        at: Math.round((new Date(now.getFullYear(), m, 1).getTime() - jan1.getTime()) / 86400000),
        label: new Date(2000, m, 1).toLocaleDateString([], { month: 'short' }),
      })),
    },
  );

  const monthRead = h('div', { class: 'strava-readout' }, 'Tap a month.');
  const monthChart = barChart(
    months(list, 12, view.metric, u).map((b, i, arr) => ({
      label: b.label,
      value: b.value,
      current: i === arr.length - 1,
      detail: `${b.start.toLocaleDateString([], { month: 'long', year: 'numeric' })}: ${metricText(b.value, view.metric, u)} · ${b.count} ${b.count === 1 ? 'activity' : 'activities'}`,
    })),
    { readout: monthRead, defaultText: 'Tap a month.' },
  );

  return h(
    'div',
    {},
    chips<Metric>(Object.entries(METRIC_LABELS) as [Metric, string][], view.metric, (m) => ((view.metric = m), repaint())),
    cards,
    h('div', { class: 'strava-section-head' }, h('h3', {}, 'Weekly'), spanChips),
    weekRead,
    weekBox,
    h('h3', {}, `${now.getFullYear()} so far vs ${now.getFullYear() - 1}`),
    yearRead,
    yearChart,
    h('h3', {}, 'Last 12 months'),
    monthRead,
    monthChart,
  );
}

// ---- Activities ----

export function activityRow(a: Activity, u: Units, onOpen: () => void): HTMLElement {
  const ps = paceOrSpeed(a, u);
  return h(
    'button',
    { class: 'strava-row', onclick: (e: Event) => (e.stopPropagation(), onOpen()) },
    h('span', { class: 'strava-row-icon' }, sportIcon(a.sport)),
    h(
      'span',
      { class: 'strava-row-main' },
      h('span', { class: 'strava-row-name' }, a.name),
      h('span', { class: 'strava-dim' }, `${when(a)} · ${sportLabel(a.sport)}${a.prs ? ` · 🏆 ${a.prs} PR${a.prs > 1 ? 's' : ''}` : ''}${a.kudos ? ` · 👍 ${a.kudos}` : ''}`),
    ),
    h(
      'span',
      { class: 'strava-row-nums' },
      a.dist ? h('span', {}, h('b', {}, distance(a.dist, u)), ` ${distUnit(u)}`) : null,
      h('span', {}, h('b', {}, duration(a.move, a.move < 3600 * 10 ? 'clock' : 'words'))),
      ps ? h('span', { class: 'strava-wide-only' }, h('b', {}, ps.value), ` ${ps.unit}`) : null,
      a.elev ? h('span', { class: 'strava-wide-only' }, h('b', {}, elevation(a.elev, u)), ` ${elevUnit(u)}`) : null,
    ),
  );
}

function activitiesTab(list: Activity[], view: View): HTMLElement {
  const box = h('div', { class: 'strava-list' });
  let shown = 0;
  const more = h('button', { class: 'btn btn-wide' }, 'Show more');
  const add = () => {
    const next = list.slice(shown, shown + 40);
    shown += next.length;
    box.append(...next.map((a) => activityRow(a, view.units, () => openActivity(a, view))));
    more.style.display = shown < list.length ? '' : 'none';
  };
  more.addEventListener('click', add);
  add();
  if (!list.length) box.append(h('div', { class: 'strava-empty' }, 'No activities for this sport yet.'));
  return h('div', {}, box, more);
}

// ---- Calendar ----

function calendarTab(list: Activity[], view: View, repaint: () => void): HTMLElement {
  const u = view.units;
  const days = byDay(list, view.metric, u);
  const nWeeks = 53;
  const first = addDays(weekStart(new Date(), view.startsMonday), -7 * (nWeeks - 1));
  const today = keyOf(new Date());
  const cols = Array.from({ length: nWeeks }, (_, w) => {
    const start = addDays(first, w * 7);
    return {
      start,
      days: Array.from({ length: 7 }, (_, d): HeatCell | null => {
        const date = addDays(start, d);
        const k = keyOf(date);
        if (k > today) return null;
        const e = days.get(k);
        const label = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        return {
          key: k,
          value: e?.value ?? 0,
          detail: e ? `${label}: ${e.list.map((a) => `${sportIcon(a.sport)} ${a.name}`).join(', ')} · ${metricText(e.value, view.metric, u)}` : `${label}: rest day`,
        };
      }),
    };
  });
  const active = cols.flatMap((c) => c.days).filter((c) => c && c.value > 0).length;
  const text = `${active} active days in the last year. Tap a day.`;
  const read = h('div', { class: 'strava-readout' }, text);
  const dayLabels = Array.from({ length: 7 }, (_, i) => addDays(first, i).toLocaleDateString([], { weekday: 'short' }));

  // When in the day and week you usually go.
  const hours = Array(24).fill(0);
  const wdays = Array(7).fill(0);
  for (const a of list) {
    const d = new Date(a.local);
    hours[d.getHours()]++;
    wdays[d.getDay()]++;
  }
  const hourRead = h('div', { class: 'strava-readout' }, 'When you start, by hour. Tap a bar.');
  const hourChart = barChart(
    hours.map((n, i) => ({
      label: i % 6 === 0 ? new Date(2000, 0, 1, i).toLocaleTimeString([], { hour: 'numeric' }) : '',
      value: n,
      detail: `${new Date(2000, 0, 1, i).toLocaleTimeString([], { hour: 'numeric' })}: ${n} ${n === 1 ? 'activity' : 'activities'}`,
    })),
    { readout: hourRead, defaultText: 'When you start, by hour. Tap a bar.' },
  );
  const order = view.startsMonday ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
  const dayRead = h('div', { class: 'strava-readout' }, 'By day of the week.');
  const dayChart = barChart(
    order.map((d) => ({
      label: new Date(2000, 0, 2 + d).toLocaleDateString([], { weekday: 'short' }),
      value: wdays[d],
      detail: `${new Date(2000, 0, 2 + d).toLocaleDateString([], { weekday: 'long' })}s: ${wdays[d]} activities`,
    })),
    { readout: dayRead, defaultText: 'By day of the week.' },
  );

  return h(
    'div',
    {},
    chips<Metric>(Object.entries(METRIC_LABELS) as [Metric, string][], view.metric, (m) => ((view.metric = m), repaint())),
    read,
    calendarHeat(cols, { readout: read, dayLabels, defaultText: text }),
    h('div', { class: 'strava-two' }, h('div', {}, h('h3', {}, 'Time of day'), hourRead, hourChart), h('div', {}, h('h3', {}, 'Day of week'), dayRead, dayChart)),
  );
}

// ---- Heatmap ----

function heatmapTab(view: View, onCleanup: (f: () => void) => void): HTMLElement {
  const box = h('div', { class: 'strava-heat' }, h('div', { class: 'strava-map-empty' }, 'Loading your routes…'));
  let everywhere = false;
  let routes: LatLng[][] = [];
  const draw = () => {
    const fit = everywhere ? undefined : homeArea(routes);
    onCleanup(routeMap(box, routes.map((points) => ({ points })), { heat: true, fit: fit?.length ? fit : undefined, padding: 16 }));
  };
  const toggle = chips<'home' | 'all'>([['home', 'Around home'], ['all', 'Everywhere']], 'home', (v) => {
    everywhere = v === 'all';
    toggle.querySelectorAll('.chip').forEach((c, i) => c.classList.toggle('active', (i === 1) === everywhere));
    box.replaceChildren();
    draw();
  });
  const count = h('div', { class: 'strava-readout' }, '');
  allRoutes()
    .then((list) => {
      const mine = list.filter((r) => view.sport === 'all' || matches({ sport: r.sport } as Activity, view.sport));
      routes = mine.map((r) => decodePolyline(r.poly)).filter((p) => p.length > 1);
      count.textContent = `${routes.length} routes. Brighter lines are where you go most.`;
      box.replaceChildren();
      draw();
    })
    .catch(() => box.replaceChildren(h('div', { class: 'strava-map-empty' }, "Couldn't load routes")));
  return h('div', {}, toggle, count, box);
}

// ---- Records ----

function recordsTab(list: Activity[], view: View): HTMLElement {
  const rows = records(list, view.sport, view.units, view.startsMonday);
  return h(
    'div',
    { class: 'strava-records' },
    view.sport === 'all' ? h('p', { class: 'strava-dim' }, 'Pick a sport above for pace and speed records.') : null,
    ...rows.map((r) =>
      h(
        r.activity ? 'button' : 'div',
        { class: 'strava-record', onclick: r.activity ? () => openActivity(r.activity!, view) : undefined },
        h('span', { class: 'strava-label' }, r.label),
        h('span', { class: 'strava-record-value' }, r.value),
        r.activity ? h('span', { class: 'strava-dim' }, `${sportIcon(r.activity.sport)} ${r.activity.name} · ${when(r.activity)}`) : null,
      ),
    ),
    h('p', { class: 'strava-dim' }, 'Best efforts (fastest mile, 5K and so on) are in each run\'s details.'),
  );
}

// ---- One activity ----

export function openActivity(a: Activity, view: View) {
  const u = view.units;
  const mapBox = h('div', { class: 'strava-act-map' });
  const ps = paceOrSpeed(a, u);
  const facts: [string, string][] = [];
  if (a.dist) facts.push(['Distance', `${distance(a.dist, u, 2)} ${distUnit(u)}`]);
  facts.push(['Moving time', duration(a.move, 'clock')]);
  if (ps) facts.push([ps.label, `${ps.value} ${ps.unit}`]);
  if (a.elev) facts.push(['Elevation gain', `${elevation(a.elev, u)} ${elevUnit(u)}`]);
  if (a.hr) facts.push(['Avg heart rate', `${a.hr} bpm`]);
  if (a.maxHr) facts.push(['Max heart rate', `${a.maxHr} bpm`]);
  if (a.watts) facts.push(['Avg power', `${a.watts} W`]);
  if (a.effort) facts.push(['Relative effort', String(a.effort)]);
  if (a.elapsed > a.move + 60) facts.push(['Elapsed', duration(a.elapsed, 'clock')]);
  const factsBox = h('div', { class: 'strava-facts' }, ...facts.map(([k, v]) => h('div', {}, h('div', { class: 'strava-label' }, k), h('div', { class: 'strava-fact' }, v))));
  const more = h('div', { class: 'strava-act-more' }, h('div', { class: 'strava-dim' }, 'Loading details…'));
  let stop: (() => void) | null = null;
  const sheet = openSheet(a.name, [
    h(
      'div',
      { class: 'strava-act' },
      h(
        'div',
        { class: 'strava-act-head' },
        h('button', { class: 'btn', onclick: () => openDashboard(view, 'activities') }, '‹ All activities'),
        h('span', { class: 'strava-dim' }, `${sportIcon(a.sport)} ${sportLabel(a.sport)} · ${new Date(a.local).toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}`),
      ),
      h('div', { class: 'strava-act-top' }, mapBox, factsBox),
      more,
    ),
  ], { onClose: () => stop?.() });
  wide(sheet);
  const drawMap = (poly: string | null | undefined) => {
    stop?.();
    const pts = poly ? decodePolyline(poly) : [];
    if (pts.length < 2) {
      mapBox.replaceChildren(h('div', { class: 'strava-map-empty' }, a.trainer ? 'Indoor activity' : 'No GPS route'));
      return;
    }
    stop = routeMap(mapBox, [{ points: pts, main: true }]);
  };
  drawMap(a.poly);
  activityDetail(a.id)
    .then((d) => {
      if (d.detail?.poly) drawMap(d.detail.poly);
      more.replaceChildren(...detailParts(a, d, u));
    })
    .catch((err) => more.replaceChildren(h('div', { class: 'strava-warn' }, err instanceof Error ? err.message : String(err))));
}

function detailParts(a: Activity, d: ActivityDetail, u: Units): Node[] {
  const out: Node[] = [];
  const det = d.detail;
  if (d.note) out.push(h('div', { class: 'strava-warn' }, d.note));
  if (det?.description) out.push(h('p', { class: 'strava-desc' }, det.description));
  const extra: string[] = [];
  if (det?.calories) extra.push(`${det.calories} Cal`);
  if (det?.gear) extra.push(`Gear: ${det.gear}`);
  if (det?.device) extra.push(det.device);
  if (a.kudos) extra.push(`👍 ${a.kudos} kudos`);
  if (a.achievements) extra.push(`🏅 ${a.achievements} achievements`);
  if (extra.length) out.push(h('div', { class: 'strava-dim strava-extra' }, extra.join(' · ')));

  const s = d.streams;
  const xs = s?.distance ?? null;
  if (s && xs && xs.length > 2) {
    const xLabel = (i: number) => `${distance(xs[i] ?? 0, u, 2)} ${distUnit(u)}`;
    const ticks = [0.25, 0.5, 0.75, 1].map((f) => ({ at: Math.round(f * (xs.length - 1)), label: `${distance((xs[xs.length - 1] ?? 0) * f, u, 1)}` }));
    const chart = (title: string, values: number[] | null, yText: (v: number) => string, yMin: 'zero' | 'data') => {
      if (!values || values.every((v) => v == null)) return;
      const read = h('div', { class: 'strava-readout' }, 'Drag across the chart.');
      out.push(h('h3', {}, title), read, lineChart([{ name: title, values, kind: 'main' }], { xLabel, yText, readout: read, area: true, ticks, yMin, height: 220 }));
    };
    chart('Elevation', s.altitude ? s.altitude.map((v) => (u === 'metric' ? v : v / 0.3048)) : null, (v) => `${Math.round(v)} ${elevUnit(u)}`, 'data');
    chart('Heart rate', s.heartrate, (v) => `${Math.round(v)} bpm`, 'data');
    const g = paceOrSpeed({ ...a, speed: 1 }, u);
    if (s.speed && g) {
      const isPace = g.label === 'Pace';
      // Pace charts read better as speed (up = faster); the readout still says pace.
      chart(
        isPace ? 'Pace' : 'Speed',
        s.speed,
        (v) => {
          const p = paceOrSpeed({ ...a, speed: v, dist: 1 }, u);
          return p ? `${p.value} ${p.unit}` : '';
        },
        'data',
      );
    }
    chart('Power', s.watts, (v) => `${Math.round(v)} W`, 'zero');
  }

  const splits = u === 'metric' ? det?.splitsMetric : det?.splitsStandard;
  if (splits && splits.length > 1) out.push(h('h3', {}, `Splits (per ${distUnit(u)})`), splitTable(a, splits, u, (i) => String(i + 1)));
  if (det?.laps && det.laps.length > 1) out.push(h('h3', {}, 'Laps'), splitTable(a, det.laps, u, (i) => det.laps[i].name || String(i + 1)));

  if (det?.bestEfforts.length) {
    out.push(
      h('h3', {}, 'Best efforts'),
      h(
        'div',
        { class: 'strava-efforts' },
        ...det.bestEfforts.map((b) => h('div', { class: 'strava-effort' }, h('span', {}, b.name), h('b', {}, duration(b.time, 'clock')), h('span', {}, medal(b.pr)))),
      ),
    );
  }
  if (det?.segments.length) {
    out.push(
      h('h3', {}, 'Segment highlights'),
      h(
        'div',
        { class: 'strava-efforts' },
        ...det.segments.map((x) => h('div', { class: 'strava-effort' }, h('span', {}, x.name), h('b', {}, duration(x.time, 'clock')), h('span', {}, x.kom ? `👑 #${x.kom}` : medal(x.pr)))),
      ),
    );
  }
  out.push(h('div', { class: 'strava-dim strava-link' }, `strava.com/activities/${a.id} · Powered by Strava`));
  return out;
}

const medal = (pr: number | null) => (pr === 1 ? '🥇 PR' : pr === 2 ? '🥈 2nd' : pr === 3 ? '🥉 3rd' : '');

function splitTable(a: Activity, rows: Split[], u: Units, name: (i: number) => string): HTMLElement {
  const speeds = rows.map((r) => r.speed ?? 0).filter((v) => v > 0);
  const max = Math.max(...speeds, 0.1);
  return h(
    'div',
    { class: 'strava-splits' },
    ...rows.map((r, i) => {
      const p = r.speed ? paceOrSpeed({ sport: a.sport, speed: r.speed, dist: 1, move: 1 }, u) : null;
      return h(
        'div',
        { class: 'strava-split' },
        h('span', { class: 'strava-dim' }, name(i)),
        h('span', { class: 'strava-split-bar' }, h('i', { style: `width:${((r.speed ?? 0) / max) * 100}%` })),
        h('b', {}, p ? `${p.value}` : '–'),
        h('span', { class: 'strava-dim' }, r.elev != null ? `${r.elev >= 0 ? '+' : ''}${elevation(r.elev, u)} ${elevUnit(u)}` : ''),
        h('span', { class: 'strava-dim' }, r.hr ? `${r.hr} bpm` : ''),
      );
    }),
  );
}
