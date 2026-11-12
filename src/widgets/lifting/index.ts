// Lifting: last session, recent PRs and a trend line from the lifting tracker
// (lifting/, a Python service the server proxies at /lifting/). Tap the tile to open
// the full tracker (trends, volume, PRs, dunk goal, log, import) over the dashboard.
import { h } from '../../core/dom';
import { attachKeyboard } from '../../core/keyboard';
import { currentTheme } from '../../core/theme';
import { defineWidget, type Placement } from '../../core/types';
import './lifting.css';

interface LiftingConfig {
  /** Whose numbers: a person's name in the tracker; '' = the first person. */
  person: string;
  /** Exercise name for the trend line; '' picks the most-logged weighted lift. */
  lift: string;
  [key: string]: unknown;
}

interface Pr {
  date: string;
  label: string;
  name: string;
  weight_lb: number;
  reps: number;
  kinds: string[];
}
interface Summary {
  person: { id: number; name: string } | null;
  people_count: number;
  last_session: { date: string; day_label: string; exercises: { label: string; name: string; top_weight: number | null; sets: number }[] } | null;
  next_day: string;
  this_week: { working_sets: number; sessions: number };
  recent_prs: Pr[];
  stalled: string[];
}
interface Exercise {
  name: string;
  session_count: number;
  has_e1rm: boolean;
}
interface Trend {
  label: string;
  sessions: { date: string; e1rm: number | null }[];
}

const BASE = '/lifting/';
const REFRESH_MS = 5 * 60_000;

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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}
function ago(iso: string): string {
  const days = Math.round((Date.now() - new Date(`${iso}T12:00:00`).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, ''));

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

function sparkline(values: number[]): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 40');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('lift-spark');
  if (values.length < 1) return svg;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = Math.max(hi - lo, hi * 0.05, 1);
  const pts = values.map((v, i) => [values.length === 1 ? 50 : (i / (values.length - 1)) * 96 + 2, 36 - ((v - lo) / span) * 32]);
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(line);
  return svg;
}

function render(root: HTMLElement, placement: Placement, s: Summary, trend: Trend | null, showName: boolean) {
  const last = s.last_session;
  const big = placement === 'large' || placement === 'xlarge' || placement === 'full' || placement === 'tall';
  const head = h(
    'div',
    { class: 'lift-head' },
    h('span', { class: 'lift-title' }, (showName || s.people_count > 1) && s.person ? `🏋️ ${s.person.name}` : '🏋️ Lifting'),
    h('span', { class: 'lift-next' }, `Day ${s.next_day} next`),
  );
  const lastLine = last
    ? h('div', { class: 'lift-last' }, `Day ${last.day_label} · ${ago(last.date)}`)
    : h('div', { class: 'lift-last' }, 'No sessions yet. Tap to import.');
  const week = h('div', { class: 'lift-week' }, h('b', {}, String(s.this_week.working_sets)), s.this_week.working_sets === 1 ? ' set this week' : ' sets this week', s.this_week.sessions ? ` · ${s.this_week.sessions} session${s.this_week.sessions === 1 ? '' : 's'}` : '');

  if (placement === 'small' || placement === 'bar') {
    root.replaceChildren(head, lastLine, week);
    return;
  }
  const pr = s.recent_prs[0];
  const prLine = pr ? h('div', { class: 'lift-pr' }, h('span', { class: 'lift-badge' }, 'PR'), `${pr.name} ${num(pr.weight_lb)} × ${pr.reps}`, h('span', { class: 'lift-dim' }, ` · ${shortDate(pr.date)}`)) : null;
  if (placement === 'medium') {
    root.replaceChildren(head, lastLine, prLine ?? week);
    return;
  }

  const values = trend?.sessions.filter((x) => x.e1rm !== null).map((x) => x.e1rm as number) ?? [];
  const chart = trend && values.length
    ? h('div', { class: 'lift-trend' },
      h('div', { class: 'lift-trend-head' }, h('span', {}, trend.label), h('b', {}, `e1RM ${num(values[values.length - 1])} lb`)),
      sparkline(values))
    : null;
  const parts: (HTMLElement | null)[] = [head, lastLine, week, chart];
  if (big && last) {
    const max = placement === 'tall' ? 4 : 6;
    parts.push(h('ul', { class: 'lift-list' }, ...last.exercises.slice(0, max).map((e) =>
      h('li', {}, h('span', {}, e.name), h('span', { class: 'lift-dim' }, e.top_weight !== null ? `${num(e.top_weight)} lb · ${e.sets}×` : `${e.sets}×`)))));
  }
  if (s.recent_prs.length) {
    parts.push(h('div', { class: 'lift-prs' }, ...s.recent_prs.slice(0, big ? 3 : 1).map((p) =>
      h('div', { class: 'lift-pr' }, h('span', { class: 'lift-badge' }, 'PR'), `${p.name} ${num(p.weight_lb)} × ${p.reps}`, h('span', { class: 'lift-dim' }, ` · ${shortDate(p.date)}`)))));
  }
  if (s.stalled.length && big) parts.push(h('div', { class: 'lift-stall' }, `Stalled: ${s.stalled.slice(0, 2).join(', ')}`));
  root.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
}

export default defineWidget<LiftingConfig>({
  type: 'lifting',
  name: 'Lifting',
  description: 'Weightlifting tracker: last session, PRs and trends; tap for the full tracker',
  icon: '🏋️',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'large',
  defaultConfig: { person: '', lift: '' },
  settings: [
    { key: 'person', label: 'Person (name in the tracker; blank = the first person)', type: 'text', placeholder: 'Dan' },
    { key: 'lift', label: 'Trend line for (exercise name; blank = most logged)', type: 'text', placeholder: 'Belt squat' },
  ],

  mount(el, { config, placement, storage }) {
    let alive = true;
    const person = String(config.person || '').trim();
    // With a person set, the tile shows their name instead of "Lifting".
    const showName = Boolean(person);
    // The tracker opens on the tile's person (the first person when the setting is blank).
    let shownId: number | undefined;
    const root = h('button', {
      class: `lift size-${placement}`,
      onclick: () => openTracker('trend', person || (shownId ? String(shownId) : ''), () => void refresh()),
    });
    el.append(root);

    async function refresh() {
      try {
        const s = await get<Summary>('api/summary', person);
        let trend: Trend | null = null;
        if (placement !== 'small' && placement !== 'medium' && placement !== 'bar') {
          let name = String(config.lift || '').trim();
          if (!name) {
            const ex = await get<Exercise[]>('api/exercises', person);
            const counts = new Map<string, number>();
            for (const e of ex) if (e.has_e1rm) counts.set(e.name, (counts.get(e.name) ?? 0) + e.session_count);
            name = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
          }
          if (name) trend = await get<Trend>(`api/trend?name=${encodeURIComponent(name)}`, person).catch(() => null);
        }
        if (!alive) return;
        shownId = s.person?.id;
        render(root, placement, s, trend, showName);
        // Per tile: two tiles can follow two people.
        storage.save({ s, trend }).catch(() => {});
      } catch (err) {
        if (!alive) return;
        if (!root.childElementCount) {
          root.replaceChildren(h('div', { class: 'lift-head' }, h('span', { class: 'lift-title' }, `🏋️ ${person || 'Lifting'}`)), h('div', { class: 'lift-dim' }, (err as Error).message));
        }
      }
    }

    // Show the last numbers right away (e.g. after a reboot), then fetch fresh ones.
    storage
      .load<{ s: Summary; trend: Trend | null } | null>(null)
      .then((cached) => {
        if (alive && cached?.s && !root.childElementCount) render(root, placement, cached.s, cached.trend, showName);
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
