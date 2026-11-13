// Lifting: the week's training volume, overall strength progress, projections and what
// needs work, from the lifting tracker (lifting/, a Python service the server proxies at
// /lifting/). Tap the tile, or one of its sections, to open the full tracker there.
import { h } from '../../core/dom';
import { attachKeyboard } from '../../core/keyboard';
import { currentTheme } from '../../core/theme';
import { defineWidget, type Placement } from '../../core/types';
import './lifting.css';

interface LiftingConfig {
  /** Whose numbers: a person's name in the tracker; '' = the first person. */
  person: string;
  /** Working sets per muscle group per week to aim for. */
  target: number;
  [key: string]: unknown;
}

interface Summary {
  person: { id: number; name: string } | null;
  people_count: number;
  next_day: string | null;
  last_session: { date: string; day_label: string; exercises: { label: string; top_weight: number | null; sets: number }[] } | null;
  this_week: { sessions: number };
  recent_prs: { label: string; date: string; weight_lb: number; reps: number; kinds: string[] }[];
}
interface Lift {
  exercise_id: number;
  name: string;
  sessions: number;
  latest_e1rm: number;
  best_e1rm: number;
  change_pct: number | null;
  projected_4wk: number | null;
  stalled: boolean;
  points?: number[];
}
interface Shortcoming {
  kind: 'low_volume' | 'idle' | 'stalled' | 'declining' | 'balance';
  text: string;
  group?: string;
  sets?: number;
}
interface Insights {
  target: number;
  weeks: { week_start: string; total: number }[];
  this_week: number;
  last_week: number | null;
  groups_7d: Record<string, number>;
  overall_change_pct: number | null;
  lifts: Lift[];
  prs_30d: number;
  shortcomings: Shortcoming[];
  dunk: { best_in: number; goal_in: number; to_go_in: number; weeks_to_goal: number | null } | null;
}
interface Data {
  s: Summary;
  i: Insights;
}

const BASE = '/lifting/';
const REFRESH_MS = 5 * 60_000;
const NO_TARGET = new Set(['Plyometrics', 'Core', 'Other']);

async function get<T>(path: string, person: string): Promise<T> {
  const url = BASE + path + (person ? `${path.includes('?') ? '&' : '?'}person=${encodeURIComponent(person)}` : '');
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    if (res.status === 502) throw new Error('Lifting service is not running');
    if (res.status === 404 && person) throw new Error(`No one called "${person}" in the tracker. Check the tile's settings.`);
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, ''));
const pct = (v: number) => `${v > 0 ? '+' : ''}${num(v)}%`;

/** Opens the tracker full screen. Rotation holds while it is open. */
export function openTracker(view = 'trend', person = '', onClose?: () => void) {
  document.querySelector('.lift-overlay')?.remove();
  const q = new URLSearchParams({ theme: currentTheme() });
  if (person) q.set('person', person);
  const frame = h('iframe', { class: 'lift-frame', src: `${BASE}?${q}#${view}`, title: 'Lifting tracker' });
  const close = () => {
    overlay.remove();
    onClose?.();
  };
  const overlay = h(
    'div',
    { class: 'lift-overlay', 'data-hold-rotation': '' },
    frame,
    h('button', { class: 'btn lift-close', onclick: close, 'aria-label': 'Close' }, '✕'),
  );
  // Same origin, so the dashboard's on-screen keyboard can type into the tracker.
  frame.addEventListener('load', () => {
    try {
      if (frame.contentDocument) attachKeyboard(frame.contentDocument);
    } catch {
      /* not same-origin: the tracker opened directly; no keyboard bridge */
    }
  });
  document.body.append(overlay);
  return close;
}

/** Last week's total, for comparison (plain: this week is usually still under way). */
function lastWeek(now: number, before: number | null) {
  if (before === null) return null;
  return h('span', { class: `lift-delta${now > before ? ' up' : ''}` }, `${now > before ? '▲ ' : ''}last week ${before}`);
}

function kpi(label: string, value: string, sub: Node | string | null, view: string, tone = '') {
  return h('div', { class: `lift-kpi ${tone}`, 'data-view': view }, h('div', { class: 'lift-kpi-v' }, value), h('div', { class: 'lift-kpi-k' }, label), sub);
}

/** Working sets per week: one bar per week since the first logged one. */
function weekBars(i: Insights) {
  const first = i.weeks.findIndex((w) => w.total > 0);
  const weeks = i.weeks.slice(Math.max(0, Math.min(first < 0 ? i.weeks.length : first, i.weeks.length - 1)));
  const max = Math.max(1, ...weeks.map((w) => w.total));
  return h(
    'div',
    { class: 'lift-weeks', 'data-view': 'volume' },
    h('div', { class: 'lift-sec' }, 'Sets per week'),
    h(
      'div',
      { class: 'lift-bars' },
      ...weeks.map((w, n) =>
        h(
          'div',
          { class: `lift-bar${n === weeks.length - 1 ? ' now' : ''}`, title: `${w.week_start}: ${w.total} sets` },
          h('span', { class: 'lift-bar-n' }, w.total ? String(w.total) : ''),
          h('i', { style: `height:${(w.total / max) * 100}%` }),
        ),
      ),
    ),
  );
}

/** This week's (last 7 days) sets per muscle group against the target. */
function groupBars(i: Insights, max: number) {
  const rows = Object.entries(i.groups_7d)
    .filter(([g]) => !NO_TARGET.has(g))
    .sort((a, b) => a[1] - b[1]);
  const scale = Math.max(i.target * 1.25, ...rows.map(([, n]) => n));
  return h(
    'div',
    { class: 'lift-groups', 'data-view': 'volume' },
    h('div', { class: 'lift-sec' }, `Last 7 days · target ${i.target} sets`),
    ...rows.slice(0, max).map(([g, n]) =>
      h(
        'div',
        { class: 'lift-grow' },
        h('span', { class: 'lift-gname' }, g),
        h('span', { class: 'lift-gtrack' }, h('i', { class: n >= i.target ? 'met' : '', style: `width:${(n / scale) * 100}%` }), h('b', { style: `left:${(i.target / scale) * 100}%` })),
        h('span', { class: 'lift-gn' }, num(n)),
      ),
    ),
  );
}

/** A lift's e1RM over its sessions as a small line. */
function spark(points: number[] | undefined) {
  if (!points || points.length < 2) return h('span', { class: 'lift-spark' });
  const lo = Math.min(...points);
  const span = Math.max(...points) - lo || 1;
  const xy = points.map((v, n) => `${((n / (points.length - 1)) * 96 + 2).toFixed(1)},${(26 - ((v - lo) / span) * 22).toFixed(1)}`);
  const tone = points[points.length - 1] > points[0] ? 'up' : points[points.length - 1] < points[0] ? 'down' : '';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 30');
  svg.setAttribute('class', `lift-spark ${tone}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', xy.join(' '));
  svg.append(line);
  return svg;
}

const DAY = 86_400_000;
function ago(iso: string) {
  const days = Math.round((new Date().setHours(12, 0, 0, 0) - new Date(`${iso}T12:00:00`).getTime()) / DAY);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}
const shortDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function panel(title: string, view: string, cls: string, ...children: (Node | string | null)[]) {
  return h('div', { class: `lift-panel ${cls}`, 'data-view': view }, h('div', { class: 'lift-sec' }, title), ...children);
}

/** Full page: every lift with an estimate, its sparkline, change and projection. */
function progressFull(i: Insights) {
  const rows = i.lifts.map((l) =>
    h(
      'div',
      { class: 'lift-prow', 'data-view': `trend?ex=${l.exercise_id}` },
      h('span', { class: 'lift-pname' }, l.name),
      spark(l.points),
      h('span', { class: 'lift-pval' }, `${num(l.latest_e1rm)} lb`),
      h('span', { class: `lift-pchg ${l.change_pct === null ? '' : l.change_pct > 0 ? 'up' : l.change_pct < 0 ? 'down' : ''}` }, l.change_pct === null ? 'new' : `${l.change_pct > 0 ? '▲' : l.change_pct < 0 ? '▼' : ''} ${pct(l.change_pct)}`),
      h('span', { class: 'lift-proj' }, l.projected_4wk ? `→ ${num(l.projected_4wk)}` : l.stalled ? 'stalled' : ''),
    ),
  );
  const projected = i.lifts.some((l) => l.projected_4wk || l.stalled);
  return panel(`Progress · estimated 1RM · change since first${projected ? ' · in 4 weeks' : ''}`, 'trend', `grow${projected ? '' : ' no-proj'}`, rows.length ? h('div', { class: 'lift-clip' }, ...rows) : h('div', { class: 'lift-dim' }, 'No weighted lifts yet.'));
}

function lastSession(s: Summary) {
  const l = s.last_session;
  if (!l) return null;
  return panel(
    `Last session · ${ago(l.date)}${l.day_label ? ` · Day ${l.day_label}` : ''}`,
    'log',
    'grow',
    h(
      'div',
      { class: 'lift-clip' },
      ...l.exercises.map((e) =>
        h('div', { class: 'lift-srow' }, h('span', { class: 'lift-pname' }, e.label), h('span', { class: 'lift-pval' }, e.top_weight !== null ? `${num(e.top_weight)} lb` : ''), h('span', { class: 'lift-proj' }, `${e.sets} ${e.sets === 1 ? 'set' : 'sets'}`)),
      ),
    ),
  );
}

function recentPrs(s: Summary, max: number) {
  return panel(
    'Recent PRs',
    'prs',
    '',
    s.recent_prs.length
      ? h('div', {}, ...s.recent_prs.slice(0, max).map((p) => h('div', { class: 'lift-srow' }, h('span', { class: 'lift-pname' }, `🏆 ${p.label}`), h('span', { class: 'lift-pval' }, `${num(p.weight_lb)} × ${p.reps}`), h('span', { class: 'lift-proj' }, shortDate(p.date)))))
      : h('div', { class: 'lift-dim' }, 'None yet. The first session of a lift sets the baseline.'),
  );
}

function renderFull(root: HTMLElement, head: HTMLElement, { s, i }: Data, kpis: HTMLElement[]) {
  const d = i.dunk;
  const l = s.last_session!;
  const under = i.shortcomings.filter((x) => x.kind === 'low_volume').length;
  const other = i.shortcomings.filter((x) => x.kind !== 'low_volume');
  root.replaceChildren(
    head,
    h(
      'div',
      { class: 'lift-kpis' },
      ...kpis,
      kpi('sessions this week', String(s.this_week.sessions), h('span', { class: 'lift-delta' }, `last one ${ago(l.date)}`), 'log'),
      d ? kpi('inches to dunk', num(d.to_go_in), h('span', { class: 'lift-delta' }, d.weeks_to_goal ? `about ${d.weeks_to_goal} wk at this rate` : `best touch ${num(d.best_in)} in`), 'dunk') : null,
    ),
    h(
      'div',
      { class: 'lift-grid' },
      h('div', { class: 'lift-col' }, h('div', { class: 'lift-panel weeks', 'data-view': 'volume' }, weekBars(i)), h('div', { class: 'lift-panel grow', 'data-view': 'volume' }, groupBars(i, 14))),
      h('div', { class: 'lift-col' }, progressFull(i)),
      h(
        'div',
        { class: 'lift-col' },
        lastSession(s),
        recentPrs(s, 4),
        panel(
          'Needs work',
          'volume',
          '',
          under || other.length
            ? h('ul', { class: 'lift-list' }, under ? h('li', { class: 'low_volume' }, `${under} muscle ${under === 1 ? 'group' : 'groups'} under ${i.target} sets in the last 7 days`) : null, ...other.slice(0, 4).map((x) => h('li', { class: x.kind }, x.text)))
            : h('div', { class: 'lift-ok' }, '✓ Every muscle group on target, nothing stalled'),
        ),
      ),
    ),
  );
}

function progress(i: Insights, max: number, explain = false) {
  const lifts = i.lifts.filter((l) => l.change_pct !== null || l.projected_4wk !== null).slice(0, max);
  if (!lifts.length) {
    return h('div', { class: 'lift-progress', 'data-view': 'trend' }, h('div', { class: 'lift-sec' }, 'Progress'), h('div', { class: 'lift-dim' }, 'Log a lift twice to see progress.'));
  }
  return h(
    'div',
    { class: 'lift-progress' },
    h('div', { class: 'lift-sec' }, 'Progress · estimated 1RM'),
    ...lifts.map((l) =>
      h(
        'div',
        { class: 'lift-prow', 'data-view': `trend?ex=${l.exercise_id}` },
        h('span', { class: 'lift-pname' }, l.name),
        h('span', { class: 'lift-pval' }, `${num(l.latest_e1rm)} lb`),
        h('span', { class: `lift-pchg ${l.change_pct === null ? '' : l.change_pct > 0 ? 'up' : l.change_pct < 0 ? 'down' : ''}` }, l.change_pct === null ? '' : `${l.change_pct > 0 ? '▲' : l.change_pct < 0 ? '▼' : ''} ${pct(l.change_pct)}`),
        h('span', { class: 'lift-proj' }, l.projected_4wk ? `→ ${num(l.projected_4wk)} in 4 wk` : l.stalled ? 'stalled' : ''),
      ),
    ),
    explain && !lifts.some((l) => l.projected_4wk)
      ? h('div', { class: 'lift-note' }, '4-week projections show once a lift has 3 sessions over 2+ weeks.')
      : null,
  );
}

function needsWork(i: Insights, max: number, groupsPerLine = 4) {
  const low = i.shortcomings.filter((x) => x.kind === 'low_volume');
  const other = i.shortcomings.filter((x) => x.kind !== 'low_volume');
  const lines: HTMLElement[] = other.map((x) => h('li', { class: x.kind }, x.text));
  if (low.length) {
    // One line for every under-target group, lowest first.
    lines.splice(
      other.filter((x) => x.kind === 'stalled' || x.kind === 'declining').length,
      0,
      h('li', { class: 'low_volume' }, `Under ${i.target} sets in 7 days: `, low.slice(0, groupsPerLine).map((x) => `${x.group} ${num(x.sets ?? 0)}`).join(' · '), low.length > groupsPerLine ? ` +${low.length - groupsPerLine} more` : ''),
    );
  }
  return h(
    'div',
    { class: 'lift-needs', 'data-view': 'volume' },
    h('div', { class: 'lift-sec' }, 'Needs work'),
    lines.length ? h('ul', {}, ...lines.slice(0, max)) : h('div', { class: 'lift-ok' }, '✓ Every muscle group on target, nothing stalled'),
  );
}

function dunkLine(i: Insights) {
  const d = i.dunk;
  if (!d) return null;
  return h(
    'div',
    { class: 'lift-dunk', 'data-view': 'dunk' },
    h('span', { class: 'lift-sec' }, 'Dunk'),
    ` ${num(d.to_go_in)} in to go`,
    h('span', { class: 'lift-dim' }, d.weeks_to_goal ? ` · about ${d.weeks_to_goal} wk at this rate` : ` · best touch ${num(d.best_in)} in`),
  );
}

function render(root: HTMLElement, placement: Placement, { s, i }: Data, showName: boolean) {
  const name = (showName || s.people_count > 1) && s.person ? s.person.name : 'Lifting';
  const head = h('div', { class: 'lift-head' }, h('span', { class: 'lift-title' }, `🏋️ ${name}`), s.next_day ? h('span', { class: 'lift-next' }, `Day ${s.next_day} next`) : null);
  const sets = kpi('sets this week', String(i.this_week), lastWeek(i.this_week, i.last_week), 'volume');
  const strength = kpi('strength since start', i.overall_change_pct === null ? '–' : pct(i.overall_change_pct), h('span', { class: 'lift-delta' }, 'avg e1RM change'), 'trend', i.overall_change_pct === null ? '' : i.overall_change_pct >= 0 ? 'up' : 'down');
  const prs = kpi('PRs, 30 days', String(i.prs_30d), null, 'prs');

  if (!s.last_session) {
    root.replaceChildren(head, h('div', { class: 'lift-dim', 'data-view': 'import' }, 'No sessions yet. Tap to import.'));
    return;
  }
  switch (placement) {
    case 'bar':
    case 'small':
      root.replaceChildren(head, sets, weekBars(i), h('div', { class: 'lift-mini' }, [i.overall_change_pct === null ? '' : `Strength ${pct(i.overall_change_pct)}`, i.prs_30d ? `${i.prs_30d} ${i.prs_30d === 1 ? 'PR' : 'PRs'}` : ''].filter(Boolean).join(' · ')));
      return;
    case 'full':
      renderFull(root, head, { s, i }, [sets, strength, prs]);
      return;
    case 'medium':
      root.replaceChildren(head, h('div', { class: 'lift-row' }, h('div', { class: 'lift-kpis' }, sets, strength), weekBars(i)));
      return;
    case 'tall':
      root.replaceChildren(head, h('div', { class: 'lift-kpis' }, sets, strength), weekBars(i), needsWork(i, 3));
      return;
    case 'large':
      root.replaceChildren(head, h('div', { class: 'lift-kpis' }, sets, strength, prs), weekBars(i), progress(i, 3), needsWork(i, 2));
      return;
    default:
      // xlarge: everything, in two columns.
      root.replaceChildren(
        head,
        h(
          'div',
          { class: 'lift-cols' },
          h('div', { class: 'lift-col' }, h('div', { class: 'lift-kpis' }, sets, strength, prs), weekBars(i), groupBars(i, 5)),
          h('div', { class: 'lift-col' }, progress(i, 5, true), needsWork(i, 4, 4), dunkLine(i)),
        ),
      );
  }
}

export default defineWidget<LiftingConfig>({
  type: 'lifting',
  name: 'Lifting',
  description: 'Weightlifting: weekly volume, strength progress, projections and what needs work',
  icon: '🏋️',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'large',
  defaultConfig: { person: '', target: 10 },
  settings: [
    { key: 'person', label: 'Person (name in the tracker; blank = the first person)', type: 'text', placeholder: 'Dan' },
    { key: 'target', label: 'Weekly sets per muscle group to aim for', type: 'number', min: 1, max: 40 },
  ],

  mount(el, { config, placement, storage }) {
    let alive = true;
    const person = String(config.person || '').trim();
    const target = Math.min(40, Math.max(1, Math.round(Number(config.target) || 10)));
    const showName = Boolean(person);
    let shownId: number | undefined;
    // Tap a section to open the tracker on that view (a lift opens its trend).
    const root = h('div', { class: `lift size-${placement}`, role: 'button', tabindex: 0 });
    root.addEventListener('click', (e) => {
      const view = (e.target as HTMLElement).closest<HTMLElement>('[data-view]')?.dataset.view ?? 'trend';
      openTracker(view, person || (shownId ? String(shownId) : ''), () => void refresh());
    });
    el.append(root);

    async function refresh() {
      try {
        const [s, i] = await Promise.all([get<Summary>('api/summary', person), get<Insights>(`api/insights?target=${target}`, person)]);
        if (!alive) return;
        shownId = s.person?.id;
        render(root, placement, { s, i }, showName);
        storage.save({ s, i }).catch(() => {});
      } catch (err) {
        if (!alive) return;
        if (!root.childElementCount) {
          root.replaceChildren(h('div', { class: 'lift-head' }, h('span', { class: 'lift-title' }, `🏋️ ${person || 'Lifting'}`)), h('div', { class: 'lift-dim' }, (err as Error).message));
        }
      }
    }

    // Show the last numbers right away (e.g. after a reboot), then fetch fresh ones.
    storage
      .load<Data | null>(null)
      .then((cached) => {
        if (alive && cached?.s && cached.i && !root.childElementCount) render(root, placement, cached, showName);
      })
      .catch(() => {});
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return {
      destroy() {
        alive = false;
        clearInterval(timer);
      },
    };
  },
});
