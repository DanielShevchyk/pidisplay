// Trend chart and stats for the check-in history. The chart is plain SVG drawn at
// the element's real pixel size, so text and dots stay crisp at every tile size.
import { h } from '../../core/dom';
import {
  average,
  daysBack,
  goodness,
  goodnessColor,
  parseKey,
  valuesFor,
  type Book,
  type Question,
} from '../../core/checkin';

export type Range = '7d' | '30d' | '90d' | '1y';
export const RANGES: [Range, string, number][] = [
  ['7d', '7 days', 7],
  ['30d', '30 days', 30],
  ['90d', '90 days', 90],
  ['1y', 'Year', 365],
];
export const rangeDays = (r: Range) => RANGES.find((x) => x[0] === r)?.[2] ?? 30;

/** Series colors, also used by the metric chips. */
export const SERIES = ['#4da3ff', '#3ccf8e', '#ffb443', '#c77dff', '#ff7aa8', '#2ec4c4', '#ff8a4d', '#a3b1c6'];

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag: string, attrs: Record<string, string | number> = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const fmtDay = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' });
const fmtWeekday = new Intl.DateTimeFormat([], { weekday: 'short' });
const fmtMonth = new Intl.DateTimeFormat([], { month: 'short' });

/** Mean of the values in the 7 days ending on each day (null when there are none). */
function rolling(values: (number | null)[], span = 7): (number | null)[] {
  return values.map((_, i) => average(values.slice(Math.max(0, i - span + 1), i + 1).filter((v): v is number => v !== null)));
}

export interface ChartSeries {
  q: Question;
  color: string;
}

/**
 * Draws the selected questions over the range into `box`. Scales share a 1-5
 * axis; hours slept gets its own 0-12 axis (it is shown on its own).
 */
export function drawChart(box: HTMLElement, state: Book, series: ChartSeries[], range: Range) {
  const w = box.clientWidth;
  const hgt = box.clientHeight;
  box.replaceChildren();
  if (w < 40 || hgt < 40) return;
  const days = daysBack(state.today, rangeDays(range));
  const hours = series.length === 1 && series[0].q.type === 'hours';
  const [lo, hi] = hours ? [Math.min(4, ...valuesFor(state, series[0].q, days)), Math.max(10, ...valuesFor(state, series[0].q, days))] : [1, 5];
  const pad = { l: 34, r: 10, t: 10, b: 26 };
  const x = (i: number) => pad.l + (days.length === 1 ? 0 : (i / (days.length - 1)) * (w - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (hgt - pad.t - pad.b);
  const s = svg('svg', { width: w, height: hgt, class: 'ci-chart-svg' });

  // Grid and y labels.
  const ticks = hours ? [lo, Math.round((lo + hi) / 2), hi] : [1, 2, 3, 4, 5];
  for (const t of ticks) {
    s.append(svg('line', { x1: pad.l, x2: w - pad.r, y1: y(t), y2: y(t), class: 'ci-grid' }));
    const label = svg('text', { x: pad.l - 8, y: y(t) + 5, class: 'ci-axis', 'text-anchor': 'end' });
    label.textContent = hours ? `${t}h` : String(t);
    s.append(label);
  }

  // X labels: a handful of evenly spaced days.
  const nLabels = Math.max(2, Math.min(days.length, Math.floor((w - pad.l) / 90)));
  for (let k = 0; k < nLabels; k++) {
    const i = Math.round((k / (nLabels - 1)) * (days.length - 1));
    const d = parseKey(days[i]);
    const text = range === '7d' ? fmtWeekday.format(d) : range === '1y' ? fmtMonth.format(d) : fmtDay.format(d);
    const label = svg('text', { x: x(i), y: hgt - 6, class: 'ci-axis', 'text-anchor': k === 0 ? 'start' : k === nLabels - 1 ? 'end' : 'middle' });
    label.textContent = text;
    s.append(label);
  }

  // Past a week, a 7-day average line over faint daily dots keeps several series readable.
  const smooth = range !== '7d';
  const dotR = days.length > 120 ? 2 : days.length > 10 ? 4 : 6;
  for (const { q, color } of series) {
    const raw = days.map((d) => {
      const v = state.entries[d]?.answers[q.id];
      return typeof v === 'number' ? v : null;
    });
    const line = smooth ? rolling(raw) : raw;
    // One polyline per run of days with a value, so gaps show as gaps in smoothed
    // lines; daily lines join across a skipped day or two.
    let run: string[] = [];
    let gap = 0;
    const flush = () => {
      if (run.length > 1) s.append(svg('polyline', { points: run.join(' '), class: 'ci-line', stroke: color }));
      run = [];
    };
    line.forEach((v, i) => {
      if (v === null) {
        if (++gap > (smooth ? 0 : 3)) flush();
        return;
      }
      gap = 0;
      run.push(`${x(i)},${y(v)}`);
    });
    flush();
    raw.forEach((v, i) => {
      if (v !== null) s.append(svg('circle', { cx: x(i), cy: y(v), r: dotR, fill: color, class: smooth ? 'ci-dot faint' : 'ci-dot' }));
    });
  }
  box.append(s);
}

export interface Stat {
  q: Question;
  avg: number | null;
  /** Change against the range before this one; positive is better. */
  better: number | null;
  count: number;
}

export function stats(state: Book, questions: Question[], range: Range): Stat[] {
  const n = rangeDays(range);
  const all = daysBack(state.today, n * 2);
  const prev = all.slice(0, n);
  const cur = all.slice(n);
  return questions
    .filter((q) => q.type !== 'yesno')
    .map((q) => {
      const values = valuesFor(state, q, cur);
      const avg = average(values);
      const before = average(valuesFor(state, q, prev));
      let better: number | null = null;
      if (avg !== null && before !== null) {
        if (q.type === 'hours') better = (goodness(q, avg) ?? 0) - (goodness(q, before) ?? 0);
        else better = (avg - before) * (q.lowerIsBetter ? -1 : 1);
      }
      return { q, avg, better, count: values.length };
    });
}

export function statCard(st: Stat): HTMLElement {
  const fmt = (v: number) => (st.q.type === 'hours' ? `${v.toFixed(1)} h` : v.toFixed(1));
  const arrow =
    st.better === null || Math.abs(st.better) < 0.05
      ? null
      : h('span', { class: `ci-delta ${st.better > 0 ? 'up' : 'down'}` }, st.better > 0 ? '▲ better' : '▼ worse');
  return h(
    'div',
    { class: 'ci-stat' },
    h('div', { class: 'ci-stat-name' }, st.q.short),
    h('div', { class: 'ci-stat-val', style: st.avg === null ? '' : `color:${goodnessColor(goodness(st.q, st.avg))}` }, st.avg === null ? '–' : fmt(st.avg)),
    arrow,
  );
}

export interface Factor {
  factor: Question;
  metric: Question;
  yes: number;
  no: number;
  /** Positive when "yes" days are better. */
  better: number;
}

/**
 * For each yes/no question with enough of both answers in the range, the 1-5 score
 * that differs most between yes and no days. Needs 3 of each to say anything.
 */
export function factors(state: Book, questions: Question[], range: Range): Factor[] {
  const days = daysBack(state.today, rangeDays(range));
  const metrics = questions.filter((q) => q.type === 'scale' || q.type === 'hours');
  const out: Factor[] = [];
  for (const f of questions.filter((q) => q.type === 'yesno')) {
    const yesDays = days.filter((d) => state.entries[d]?.answers[f.id] === true);
    const noDays = days.filter((d) => state.entries[d]?.answers[f.id] === false);
    if (yesDays.length < 3 || noDays.length < 3) continue;
    let best: Factor | null = null;
    for (const m of metrics) {
      const y = average(valuesFor(state, m, yesDays));
      const n = average(valuesFor(state, m, noDays));
      if (y === null || n === null) continue;
      const scale = m.type === 'hours' ? 1 / 2 : 1; // an hour of sleep ~ half a point
      const better = (y - n) * scale * (m.lowerIsBetter ? -1 : 1);
      if (!best || Math.abs(better) > Math.abs(best.better)) best = { factor: f, metric: m, yes: y, no: n, better };
    }
    if (best && Math.abs(best.better) >= 0.2) out.push(best);
  }
  return out.sort((a, b) => Math.abs(b.better) - Math.abs(a.better));
}

export function factorCard(f: Factor): HTMLElement {
  const fmt = (v: number) => (f.metric.type === 'hours' ? `${v.toFixed(1)} h` : v.toFixed(1));
  return h(
    'div',
    { class: `ci-factor ${f.better > 0 ? 'up' : 'down'}` },
    h('span', { class: 'ci-factor-name' }, `${f.factor.short}: yes`),
    h('span', {}, `${f.metric.short} ${fmt(f.yes)} vs ${fmt(f.no)} on "no" days`),
  );
}
