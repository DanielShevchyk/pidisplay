// Dashboard: per-lift trend, weekly volume, PR feed, monthly report, dunk goal. Tap the nav to switch.
import { api, BASIS, feetInches, h, lb, longDate, nav, num, shortDate, today, toast } from './common.js';
import { legend, lineChart } from './charts.js';

const VIEWS = ['trend', 'volume', 'prs', 'report', 'dunk'];
/** How hard a set was, as logged: "RPE 8" or "2 left". */
const effort = (s) => (s?.rir != null ? ` · ${num(s.rir)} left` : s?.rpe != null ? ` · RPE ${num(s.rpe)}` : '');
const rough = (on) => (on ? '≈' : '');
const navEl = nav('trend');
let charts = [];
let reportMonth = null; // YYYY-MM shown on the Month view; null = this month
const state = { name: null };
try {
  Object.assign(state, JSON.parse(localStorage.getItem('lifting-trend') || '{}'));
} catch {}
const saveState = () => {
  try {
    localStorage.setItem('lifting-trend', JSON.stringify({ name: state.name }));
  } catch {}
};

function current() {
  const v = location.hash.slice(1).split('?')[0];
  return VIEWS.includes(v) ? v : 'trend';
}

async function show() {
  const view = current();
  for (const a of navEl.querySelectorAll('a')) a.classList.toggle('active', a.dataset.view === view);
  for (const v of VIEWS) document.getElementById(`view-${v}`).classList.toggle('active', v === view);
  charts.forEach((c) => c.destroy());
  charts = [];
  const el = document.getElementById(`view-${view}`);
  try {
    await { trend: renderTrend, volume: renderVolume, prs: renderPrs, report: renderReport, dunk: renderDunk }[view](el);
  } catch (e) {
    el.replaceChildren(h('p', { class: 'error' }, `Couldn't load: ${e.message}`));
  }
}
window.addEventListener('hashchange', show);
show();

// ---- 1. Per-lift trend -------------------------------------------------------------

async function renderTrend(el) {
  const exercises = (await api('api/exercises')).filter((e) => e.session_count > 0);
  // #trend?ex=<id> (from the dashboard tile) opens that exercise.
  const wanted = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('ex'));
  const hit = wanted && exercises.find((e) => e.id === wanted);
  if (hit) {
    state.name = hit.name;
    saveState();
    history.replaceState(null, '', '#trend');
  }
  if (!exercises.length) {
    el.replaceChildren(h('div', { class: 'empty' }, 'No lifts yet. ', h('a', { href: 'import' }, 'Import some sessions'), '.'));
    return;
  }
  // One entry per exercise name: its variations (stance, grip, machine) are one lift.
  const names = new Map();
  for (const e of exercises) {
    const n = names.get(e.name) || { name: e.name, variations: [], stalled: false, has: false, last: '' };
    n.variations.push(e);
    n.stalled ||= e.stalled;
    n.has ||= e.has_e1rm;
    n.last = n.last > e.last_date ? n.last : e.last_date;
    names.set(e.name, n);
  }
  const list = [...names.values()].sort((a, b) => Number(b.has) - Number(a.has) || a.name.localeCompare(b.name));
  if (!names.has(state.name)) state.name = list[0].name;

  const side = h('div', { class: 'ex-list' },
    ...list.map((n) => h('button', {
      class: `ex-item${n.name === state.name ? ' active' : ''}`,
      onclick: () => {
        state.name = n.name;
        saveState();
        show();
      },
    }, h('span', {}, n.name),
    n.stalled ? h('span', { class: 'badge stall' }, 'stall') : null)),
  );

  const t = await api(`api/trend?name=${encodeURIComponent(state.name)}`);

  const ses = t.sessions;
  const withE = ses.filter((x) => x.e1rm !== null);
  const latest = withE.at(-1);
  const best = withE.reduce((m, x) => (!m || x.e1rm > m.e1rm ? x : m), null);
  const first = withE[0];
  const isWeighted = ses.some((x) => x.top_weight !== null);
  const isHeight = !isWeighted && ses.some((x) => x.max_height_in !== null);
  const isTime = !isWeighted && !isHeight && ses.some((x) => x.max_duration_s !== null);
  const titleOf = (x) => `Day ${x.day_label}`;

  let series;
  let fmt = (v) => num(Math.round(v * 10) / 10);
  if (isWeighted) {
    series = [
      { name: 'Estimated 1RM', short: 'e1RM', color: 'var(--series-1)', points: withE.map((x) => ({ x: x.date, y: x.e1rm, pr: !!x.pr, title: titleOf(x), label: `${rough(x.e1rm_rough)}${num(x.e1rm)} lb (${num(x.e1rm_set.weight_lb)} × ${x.e1rm_set.reps}${effort(x.e1rm_set)})${x.e1rm_rough ? ' rough' : ''}` })) },
      { name: 'Top-set weight', short: 'Top', color: 'var(--series-2)', dashed: true, points: ses.filter((x) => x.top_weight !== null).map((x) => ({ x: x.date, y: x.top_weight, title: titleOf(x), label: `${lb(x.top_weight)}${x.top_reps ? ` × ${x.top_reps}` : ''}` })) },
    ];
  } else if (isHeight) {
    series = [{ name: 'Box height', short: 'Box', color: 'var(--series-1)', points: ses.map((x) => ({ x: x.date, y: x.max_height_in, title: titleOf(x), label: `${num(x.max_height_in)} in` })) }];
  } else if (isTime) {
    series = [{ name: 'Longest hold', short: 'Hold', color: 'var(--series-1)', points: ses.map((x) => ({ x: x.date, y: x.max_duration_s, title: titleOf(x), label: `${num(x.max_duration_s)} s` })) }];
  } else {
    series = [];
  }

  const stats = isWeighted
    ? h('div', { class: 'stats' },
      stat('Latest e1RM', latest ? num(latest.e1rm) : '–', 'lb'),
      stat('Best e1RM', best ? num(best.e1rm) : '–', 'lb', best ? shortDate(best.date) : ''),
      stat('Since first', latest && first && latest !== first ? `${latest.e1rm >= first.e1rm ? '+' : ''}${num(Math.round((latest.e1rm - first.e1rm) * 10) / 10)}` : '–', 'lb'),
      stat('Sessions', String(ses.length)),
      t.stalled ? h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Status'), h('div', { class: 'v' }, h('span', { class: 'badge stall', style: 'font-size:20px' }, 'Stalled')), h('div', { class: 'k' }, 'no e1RM gain in 3 sessions')) : null)
    : null;

  const chartEl = h('div', { class: 'chart' });
  const table = h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Day'), h('th', { class: 'num' }, 'Top set'), h('th', { class: 'num' }, 'e1RM'), h('th', { class: 'num' }, 'Sets'), h('th', {}, ''))),
    h('tbody', {}, ...ses.slice().reverse().map((x) => h('tr', {},
      h('td', {}, longDate(x.date)), h('td', {}, x.day_label),
      h('td', { class: 'num' }, x.top_weight !== null ? `${lb(x.top_weight)}${x.top_reps ? ` × ${x.top_reps}` : ''}` : x.max_height_in !== null ? `${num(x.max_height_in)} in` : x.max_duration_s !== null ? `${num(x.max_duration_s)} s` : '–'),
      h('td', { class: 'num' }, x.e1rm !== null ? `${rough(x.e1rm_rough)}${num(x.e1rm)}` : '–'),
      h('td', { class: 'num' }, String(x.sets)),
      h('td', {}, x.pr ? h('span', { class: 'badge pr' }, x.pr.kinds.includes('e1rm') ? 'e1RM PR' : 'Rep PR') : null)))),
  );

  el.replaceChildren(h('div', { class: 'trend-layout' }, side,
    h('div', {},
      h('h2', { style: 'margin:0 0 6px' }, t.label || state.name),
      stats,
      h('div', { class: 'chart-card' },
        series.length > 1 ? legend(series) : h('h3', {}, series[0]?.name || ''),
        chartEl,
        ses.some((x) => x.e1rm_rough) ? h('div', { class: 'dim', style: 'font-size:15px;margin:4px 0 6px' }, '≈ rough estimate: it comes from a set of more than 10 reps (counting reps left in the tank).') : null),
      h('div', { class: 'table-wrap', style: 'margin-top:16px' }, table))));
  if (series.length) charts.push(lineChart(chartEl, series, { format: fmt, minSpan: 20, floor: 0, label: `${state.name} trend`, empty: 'No weighted sets yet' }));
  else chartEl.append(h('div', { class: 'empty' }, 'Nothing to chart for this exercise (no weights, heights or times logged).'));
}

function stat(k, v, unit = '', sub = '') {
  return h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v, unit ? h('small', {}, ` ${unit}`) : null), sub ? h('div', { class: 'k' }, sub) : null);
}

// ---- 2. Weekly volume ---------------------------------------------------------------

let volumeWeek = null;
async function renderVolume(el) {
  const v = await api('api/volume?weeks=8');
  // Skip the empty weeks before the first logged one.
  const first = v.weeks.findIndex((w) => w.total);
  const weeks = first > 0 ? v.weeks.slice(first) : v.weeks;
  if (!weeks.some((w) => w.total)) {
    el.replaceChildren(h('div', { class: 'empty' }, 'No working sets in the last 8 weeks.'));
    return;
  }
  if (!weeks.some((w) => w.week_start === volumeWeek)) volumeWeek = [...weeks].reverse().find((w) => w.total)?.week_start ?? weeks.at(-1).week_start;
  const idx = weeks.findIndex((w) => w.week_start === volumeWeek);
  const week = weeks[idx];
  const prev = weeks[idx - 1];
  const groups = v.groups.filter((g) => weeks.some((w) => w.groups[g]));
  const max = Math.max(1, ...weeks.flatMap((w) => Object.values(w.groups)));
  const rows = groups
    .map((g) => ({ g, n: week.groups[g] || 0, p: prev ? prev.groups[g] || 0 : null }))
    .sort((a, b) => b.n - a.n || a.g.localeCompare(b.g));

  el.replaceChildren(
    h('h2', { style: 'margin:0 0 6px' }, 'Weekly working sets per muscle group'),
    h('p', { class: 'dim', style: 'margin:0 0 8px' }, 'Warmups excluded; a mechanical drop set counts once. Muscles an exercise also works get half a set (set them on Log, Exercises). Weeks start Monday.'),
    h('div', { class: 'chips' }, ...weeks.map((w) => h('button', {
      class: `chip${w.week_start === volumeWeek ? ' active' : ''}`,
      onclick: () => { volumeWeek = w.week_start; show(); },
    }, `${shortDate(w.week_start)} · ${w.total}`))),
    h('div', { class: 'stats' }, stat('Working sets', String(week.total)), prev ? stat('Week before', String(prev.total)) : null),
    h('div', { class: 'card' },
      prev ? h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'background:var(--series-1)' }), `Week of ${shortDate(week.week_start)}`), h('span', {}, h('i', { style: 'background:var(--text-dim);width:3px;height:16px' }), 'Week before')) : null,
      h('div', { class: 'bars' }, ...rows.map((r) => h('div', { class: 'bar-row', title: `${r.g}: ${num(r.n)} sets${r.p !== null ? ` (week before: ${num(r.p)})` : ''}` },
        h('div', {}, r.g),
        h('div', { class: 'bar-track' },
          h('div', { class: 'bar-fill', style: `width:${(r.n / max) * 100}%` }),
          r.p ? h('div', { class: 'bar-prev', style: `left:calc(${(r.p / max) * 100}% - 1.5px)` }) : null),
        h('div', { class: 'bar-val' }, num(r.n)))))),
  );
}

// ---- 3. PR feed ---------------------------------------------------------------------

async function renderPrs(el) {
  const prs = await api('api/prs?limit=60');
  if (!prs.length) {
    el.replaceChildren(h('div', { class: 'empty' }, 'No PRs yet. The first session of each lift sets the baseline.'));
    return;
  }
  el.replaceChildren(
    h('h2', { style: 'margin:0 0 12px' }, 'Recent PRs'),
    h('div', { class: 'pr-feed' }, ...prs.map((p) => h('button', {
      class: 'pr-card',
      onclick: () => {
        state.name = p.name;
        saveState();
        location.hash = 'trend';
      },
    },
    h('div', { class: 'meta' }, `${longDate(p.date)} · Day ${p.day_label}`),
    h('div', { class: 'ex' }, p.label),
    h('div', { class: 'what' }, `${num(p.weight_lb)} lb × ${p.reps}`),
    h('div', { class: 'chips', style: 'margin:4px 0' },
      p.kinds.includes('e1rm') ? h('span', { class: 'badge pr' }, `e1RM ${rough(p.rough)}${num(p.e1rm)}${p.previous_e1rm !== null ? ` (was ${num(p.previous_e1rm)})` : ''}`) : null,
      p.kinds.includes('reps') ? h('span', { class: 'badge pr' }, p.previous_weight_at_reps !== null ? `Best for ${p.reps}+ reps (was ${num(p.previous_weight_at_reps)} lb)` : `Most reps at this weight`) : null)))),
  );
}

// ---- 4. Monthly report --------------------------------------------------------------

const monthName = (ym, long = true) => new Date(`${ym}-15T12:00:00`).toLocaleDateString(undefined, long ? { month: 'long', year: 'numeric' } : { month: 'long' });

async function renderReport(el) {
  const r = await api(`api/report${reportMonth ? `?month=${reportMonth}` : ''}`);
  const a = r.this;
  const b = r.previous;
  const hasPrev = b.sessions > 0;
  const go = (m) => { reportMonth = m; show(); };
  // "+3 vs October", or how far along when the month isn't over yet.
  const versus = (now, was) => {
    if (!hasPrev) return '';
    const d = Math.round((now - was) * 10) / 10;
    return `${d > 0 ? '+' : ''}${num(d)} vs ${monthName(b.month, false)}`;
  };
  const big = (v) => (v >= 10000 ? `${num(Math.round(v / 100) / 10)}k` : num(v));
  const groups = [...new Set([...Object.keys(a.groups), ...Object.keys(b.groups)])]
    .map((g) => ({ g, n: a.groups[g] || 0, p: hasPrev ? b.groups[g] || 0 : null }))
    .sort((x, y) => y.n - x.n || x.g.localeCompare(y.g));
  const max = Math.max(1, ...groups.flatMap((x) => [x.n, x.p || 0]));

  // Calendar of training days.
  const [y, m] = a.month.split('-').map(Number);
  const daysIn = new Date(y, m, 0).getDate();
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday first
  const trained = new Set(a.days.map((d) => Number(d.slice(8))));
  const cells = [...'MTWTFSS'].map((d) => h('div', { class: 'cal-head' }, d));
  for (let i = 0; i < lead; i++) cells.push(h('div', {}));
  for (let d = 1; d <= daysIn; d++) {
    const iso = `${a.month}-${String(d).padStart(2, '0')}`;
    cells.push(trained.has(d)
      ? h('button', { class: 'cal-day on', 'aria-label': `Show ${longDate(iso)}`, onclick: () => openDay(iso, a.pr_list) }, String(d))
      : h('div', { class: 'cal-day' }, String(d)));
  }

  el.replaceChildren(
    h('div', { class: 'row', style: 'align-items:center;margin:0 0 10px' },
      h('button', { class: 'btn', disabled: !r.previous_month, onclick: () => go(r.previous_month) }, '‹'),
      h('h2', { style: 'margin:0;min-width:260px;text-align:center' }, monthName(a.month)),
      h('button', { class: 'btn', disabled: !r.next_month, onclick: () => go(r.next_month) }, '›'),
      r.in_progress ? h('span', { class: 'dim' }, 'month so far') : null),
    a.sessions || hasPrev ? '' : h('div', { class: 'empty' }, 'Nothing logged this month yet.'),
    h('div', { class: 'stats stats-fill' },
      stat('Sessions', String(a.sessions), '', versus(a.sessions, b.sessions)),
      stat('Working sets', String(a.working_sets), '', versus(a.working_sets, b.working_sets)),
      stat('Weight moved', big(a.volume_lb), 'lb', hasPrev ? `${big(b.volume_lb)} in ${monthName(b.month, false)}` : 'weight × reps'),
      stat('PRs', String(a.prs), '', versus(a.prs, b.prs)),
      a.avg_rpe !== null ? stat('Average effort', num(a.avg_rpe), 'RPE', hasPrev && b.avg_rpe !== null ? versus(a.avg_rpe, b.avg_rpe) : '') : null),
    h('div', { class: 'report-grid' },
      h('div', { class: 'card' },
        h('h3', { style: 'margin:0 0 10px' }, 'Sets per muscle group'),
        hasPrev ? h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'background:var(--series-1)' }), monthName(a.month, false)), h('span', {}, h('i', { style: 'background:var(--text-dim);width:3px;height:16px' }), monthName(b.month, false))) : null,
        groups.length
          ? h('div', { class: 'bars' }, ...groups.map((x) => h('div', { class: 'bar-row' },
            h('div', {}, x.g),
            h('div', { class: 'bar-track' },
              h('div', { class: 'bar-fill', style: `width:${(x.n / max) * 100}%` }),
              x.p ? h('div', { class: 'bar-prev', style: `left:calc(${(x.p / max) * 100}% - 1.5px)` }) : null),
            h('div', { class: 'bar-val' }, num(x.n)))))
          : h('div', { class: 'empty' }, 'No working sets.')),
      h('div', { class: 'report-side' },
        h('div', { class: 'card' },
          h('h3', { style: 'margin:0 0 10px' }, `Training days · ${a.days.length}`),
          h('div', { class: 'cal' }, ...cells),
          a.days.length ? h('div', { class: 'dim', style: 'font-size:15px;margin-top:10px' }, 'Tap a highlighted day to see that workout.') : null),
        h('div', { class: 'card grow' },
          h('h3', { style: 'margin:0 0 10px' }, 'PRs this month'),
          a.pr_list.length
            ? h('div', {}, ...a.pr_list.map((p) => h('div', { class: 'report-pr' }, h('span', {}, p.label), h('span', { class: 'dim' }, `${num(p.weight_lb)} lb × ${p.reps} · ${shortDate(p.date)}`))))
            : h('div', { class: 'dim' }, 'None yet.')))),
    h('p', { class: 'dim', style: 'font-size:15px' }, 'Weight moved is weight × reps over working sets; loads logged per hand, arm or side count double.'),
  );
}

/** One day's workout in a sheet over the Month page: every lift with its sets. */
async function openDay(iso, monthPrs) {
  document.querySelector('.day-sheet')?.remove();
  const body = h('div', { class: 'day-body' }, h('div', { class: 'dim' }, 'Loading…'));
  const close = () => {
    sheet.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const openLog = () => {
    try {
      sessionStorage.setItem('lifting-log-filters', JSON.stringify({ from: iso, to: iso, exercise: '', warmups: true }));
    } catch {}
    location.href = 'log#sets';
  };
  const sheet = h('div', { class: 'day-sheet', onclick: (e) => e.target === sheet && close() },
    h('div', { class: 'day-card', role: 'dialog', 'aria-label': `Workout on ${longDate(iso)}` },
      h('div', { class: 'day-head' },
        h('h2', { style: 'margin:0' }, longDate(iso)),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: openLog }, 'Edit in Log'),
        h('button', { class: 'btn', onclick: close, 'aria-label': 'Close' }, '✕')),
      body));
  document.addEventListener('keydown', onKey);
  document.body.append(sheet);

  let rows;
  try {
    rows = await api(`api/sets?from=${iso}&to=${iso}&include_warmups=false`);
  } catch (e) {
    body.replaceChildren(h('p', { class: 'error' }, `Couldn't load: ${e.message}`));
    return;
  }
  if (!rows.length) {
    body.replaceChildren(h('div', { class: 'empty' }, 'No working sets logged that day.'));
    return;
  }
  const prNames = new Set(monthPrs.filter((p) => p.date === iso).map((p) => p.name));
  // Sessions in order, then lifts in the order done (variations together), then sets.
  rows.sort((x, y) => x.session_id - y.session_id || x.id - y.id);
  const sessions = new Map();
  for (const r of rows) {
    const s = sessions.get(r.session_id) || { label: r.day_label, lifts: new Map() };
    const lift = s.lifts.get(r.name) || { name: r.name, sets: new Map(), basis: new Set() };
    const key = `${r.exercise_id}:${r.set_number}`;
    (lift.sets.get(key) || lift.sets.set(key, []).get(key)).push(r);
    if (r.load_basis && r.load_basis !== 'total') lift.basis.add(BASIS[r.load_basis]);
    s.lifts.set(r.name, lift);
    sessions.set(r.session_id, s);
  }
  let load = 0;
  for (const r of rows) if (r.weight_lb && r.reps) load += r.weight_lb * r.reps * (r.load_basis && r.load_basis !== 'total' ? 2 : 1);
  const setCount = [...sessions.values()].reduce((n, s) => n + [...s.lifts.values()].reduce((m, l) => m + l.sets.size, 0), 0);

  const setText = (segs) => segs.map((r, i) => {
    const what = r.weight_lb !== null && r.reps ? `${num(r.weight_lb)} × ${r.reps}`
      : r.height_in !== null ? `${num(r.height_in)} in${r.reps ? ` × ${r.reps}` : ''}`
        : r.duration_s !== null ? `${num(r.duration_s)} s`
          : r.reps ? `${r.reps} reps` : '–';
    return i ? `+ ${r.reps ?? ''}` : what;
  }).join(' ');
  const effortOf = (r) => (r.rir !== null ? `${num(r.rir)} left` : r.rpe !== null ? `RPE ${num(r.rpe)}` : '');

  body.replaceChildren(
    h('div', { class: 'stats stats-fill', style: 'margin-top:0' },
      stat('Lifts', String([...sessions.values()].reduce((n, s) => n + s.lifts.size, 0))),
      stat('Working sets', String(setCount)),
      stat('Weight moved', load >= 10000 ? `${num(Math.round(load / 100) / 10)}k` : num(Math.round(load)), 'lb'),
      stat('PRs', String(prNames.size))),
    ...[...sessions.values()].map((s) => h('div', {},
      sessions.size > 1 || s.label ? h('h3', { class: 'day-session' }, s.label ? `Day ${s.label}` : 'Session') : null,
      h('div', { class: 'day-lifts' }, ...[...s.lifts.values()].map((l) => h('div', { class: 'day-lift' },
        h('div', { class: 'day-lift-name' }, l.name,
          l.basis.size ? h('span', { class: 'dim', style: 'font-size:15px;font-weight:400' }, ` · ${[...l.basis].join(', ')}`) : null,
          prNames.has(l.name) ? h('span', { class: 'badge pr', style: 'margin-left:10px' }, 'PR') : null),
        h('div', { class: 'day-sets' }, ...[...l.sets.values()].map((segs) => h('span', { class: `day-set${segs[0].inferred ? ' assumed' : ''}` },
          setText(segs),
          effortOf(segs[0]) ? h('small', {}, ` ${effortOf(segs[0])}`) : null,
          segs.length > 1 ? h('small', {}, ' drop') : null)))))))),
  );
}

// ---- 5. Dunk goal -------------------------------------------------------------------

const MTYPES = [
  ['standing_touch_height', 'Standing touch', 'in'],
  ['approach_touch_height', 'Approach touch', 'in'],
  ['box_jump_height', 'Box jump', 'in'],
  ['bodyweight', 'Bodyweight', 'lb'],
];

async function renderDunk(el) {
  const d = await api('api/dunk');
  const S = d.series;
  const rim = d.rim_in;
  const best = (arr) => arr.reduce((m, p) => (!m || p.value > m.value ? p : m), null);
  const bestTouch = best([...S.standing_touch_height, ...S.approach_touch_height]);
  const touchSeries = [
    { name: 'Standing touch', short: 'Standing', color: 'var(--series-1)', points: S.standing_touch_height.map(pt) },
    { name: 'Approach touch', short: 'Approach', color: 'var(--series-2)', dashed: true, points: S.approach_touch_height.map(pt) },
  ].filter((se) => se.points.length);
  const touchEl = h('div', { class: 'chart' });
  const boxEl = h('div', { class: 'chart short' });
  const bwEl = h('div', { class: 'chart short' });

  el.replaceChildren(
    h('h2', { style: 'margin:0 0 6px' }, 'Dunk goal'),
    h('div', { class: 'stats' },
      stat('Best touch', bestTouch ? num(bestTouch.value) : '–', 'in', bestTouch ? `${feetInches(bestTouch.value)}${bestTouch.approx ? ' (approx.)' : ''}` : ''),
      stat('To the rim', bestTouch ? num(Math.max(0, rim - bestTouch.value)) : '–', 'in', 'rim is 10′ (120 in)'),
      stat('To dunk', bestTouch ? num(Math.max(0, rim + 6 - bestTouch.value)) : '–', 'in', 'touch ~6 in above the rim'),
      stat('Best box jump', S.box_jump_height.length ? num(best(S.box_jump_height).value) : '–', 'in')),
    h('div', { class: 'dunk-grid' },
      h('div', { class: 'chart-card wide' }, touchSeries.length > 1 ? legend(touchSeries) : h('h3', {}, touchSeries[0]?.name || 'Touch height'), touchEl),
      h('div', { class: 'chart-card' }, h('h3', {}, 'Box jump height'), boxEl),
      h('div', { class: 'chart-card' }, h('h3', {}, 'Bodyweight'), bwEl),
      addForm()),
  );
  charts.push(lineChart(touchEl, touchSeries, { format: (v) => num(v), refs: [{ y: rim, label: 'Rim 10′' }, { y: rim + 6, label: 'Dunk (rim + 6″)' }], empty: 'No touch heights yet. Add one below.' }));
  charts.push(lineChart(boxEl, [{ name: 'Box jump', short: 'Box', color: 'var(--series-1)', points: S.box_jump_height.map(pt) }], { format: (v) => num(v), zero: true, empty: 'No box jumps yet' }));
  charts.push(lineChart(bwEl, [{ name: 'Bodyweight', short: 'BW', color: 'var(--series-1)', points: S.bodyweight.map(pt) }], { format: (v) => num(v), minSpan: 10, empty: 'No bodyweight logged yet' }));
}

function pt(p) {
  return { x: p.date, y: p.value, label: `${num(p.value)} ${p.unit}${p.approx ? ' (approx.)' : ''}`, note: p.notes || '' };
}

function addForm() {
  const type = h('select', {}, ...MTYPES.map(([v, label]) => h('option', { value: v }, label)));
  const value = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'inches', size: 8 });
  const date = h('input', { type: 'date', value: today() });
  const approx = h('input', { type: 'checkbox' });
  const notes = h('input', { type: 'text', placeholder: 'Notes (optional)' });
  type.addEventListener('change', () => (value.placeholder = MTYPES.find((m) => m[0] === type.value)[2] === 'lb' ? 'lb' : 'inches'));
  const save = async () => {
    const v = Number(value.value.replace(',', '.'));
    if (!value.value || !Number.isFinite(v) || v <= 0) return toast('Enter a number', true);
    try {
      await api('api/measurements', { method: 'POST', json: { date: date.value || today(), type: type.value, value: v, unit: MTYPES.find((m) => m[0] === type.value)[2], approx: approx.checked, notes: notes.value || null } });
      toast('Saved');
      show();
    } catch (e) {
      toast(e.message, true);
    }
  };
  value.addEventListener('keydown', (e) => e.key === 'Enter' && save());
  return h('div', { class: 'card wide' },
    h('h3', { style: 'margin:0 0 10px' }, 'Add a measurement'),
    h('div', { class: 'row' },
      h('label', { class: 'field' }, 'What', type),
      h('label', { class: 'field' }, 'Value', value),
      h('label', { class: 'field' }, 'Date', date),
      h('label', { class: 'check' }, approx, 'Approximate'),
      h('label', { class: 'field', style: 'flex:1;min-width:200px' }, 'Notes', notes),
      h('button', { class: 'btn btn-primary', onclick: save }, 'Save')),
    h('p', { class: 'dim', style: 'font-size:15px;margin:10px 0 0' }, 'Same date and type replaces the earlier entry. Edit or delete entries on the Log page.'));
}
