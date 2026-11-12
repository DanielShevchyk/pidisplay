// Charts for the Strava widget, built for touch: bars and calendar cells are HTML,
// lines are SVG with a fixed viewBox; tapping (or dragging across) any of them shows
// the exact value in a readout line above the chart. One hue: Strava orange.
import { h } from '../../core/dom';

export interface Bar {
  label: string;
  value: number;
  /** What the readout says when this bar is tapped. */
  detail: string;
  current?: boolean;
}

/**
 * Vertical bars with labels under them. A goal draws a dashed line. Bars stay
 * tappable: the readout shows `detail`, and tapping again clears it.
 */
export function barChart(bars: Bar[], opts: { goal?: number; readout?: HTMLElement; labelEvery?: number; defaultText?: string; compact?: boolean } = {}): HTMLElement {
  const max = Math.max(opts.goal ?? 0, ...bars.map((b) => b.value)) || 1;
  const readout = opts.readout;
  const every = opts.labelEvery ?? 1;
  let picked: HTMLElement | null = null;
  const plot = h('div', { class: 'strava-bars-plot' });
  bars.forEach((b, i) => {
    const col = h(
      'button',
      {
        class: `strava-bar${b.current ? ' current' : ''}${b.value ? '' : ' zero'}`,
        'aria-label': b.detail,
        onclick: (e: Event) => {
          // Without a readout the bars are just a picture; the tap belongs to the tile.
          if (!readout) return;
          e.stopPropagation();
          picked?.classList.remove('picked');
          if (picked === col) {
            picked = null;
            readout.textContent = opts.defaultText ?? '';
            return;
          }
          picked = col;
          col.classList.add('picked');
          readout.textContent = b.detail;
        },
      },
      h('span', { class: 'strava-bar-fill', style: `height:${b.value ? Math.max(2, (b.value / max) * 100) : 0}%` }),
    );
    plot.append(col);
    void i;
  });
  if (opts.goal) plot.append(h('div', { class: 'strava-bars-goal', style: `bottom:${(opts.goal / max) * 100}%` }));
  const labels = h(
    'div',
    { class: 'strava-bars-labels' },
    ...bars.map((b, i) => h('span', {}, i % every === 0 || i === bars.length - 1 ? b.label : '')),
  );
  return h('div', { class: `strava-bars${opts.compact ? ' compact' : ''}` }, plot, labels);
}

export interface HeatCell {
  key: string;
  value: number;
  detail: string;
}

/**
 * GitHub-style calendar: one column per week, one row per weekday, darker = more.
 * Four steps of one hue, cut at quartiles of the active days so a big day doesn't
 * wash out the rest.
 */
export function calendarHeat(
  weeks: { start: Date; days: (HeatCell | null)[] }[],
  opts: { readout?: HTMLElement; dayLabels: string[]; defaultText?: string },
): HTMLElement {
  const active = weeks.flatMap((w) => w.days).filter((c): c is HeatCell => !!c && c.value > 0).map((c) => c.value).sort((a, b) => a - b);
  const q = (p: number) => active[Math.min(active.length - 1, Math.floor(p * active.length))] ?? 0;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const level = (v: number) => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4);
  let picked: HTMLElement | null = null;
  const grid = h('div', { class: 'strava-cal-grid', style: `grid-template-columns: repeat(${weeks.length}, 1fr)` });
  const months = h('div', { class: 'strava-cal-months', style: `grid-template-columns: repeat(${weeks.length}, 1fr)` });
  let lastMonth = -1;
  weeks.forEach((w, wi) => {
    const m = w.days.find(Boolean) ? new Date(w.start).getMonth() : -1;
    const first = w.start.getDate() <= 7 || wi === 0;
    months.append(h('span', {}, m !== lastMonth && first && m >= 0 ? w.start.toLocaleDateString([], { month: 'short' }) : ''));
    if (first) lastMonth = m;
    w.days.forEach((c, di) => {
      const cell = h('button', {
        class: `strava-cal-cell l${c ? level(c.value) : 0}${c ? '' : ' future'}`,
        style: `grid-column:${wi + 1};grid-row:${di + 1}`,
        'aria-label': c?.detail ?? '',
        onclick: (e: Event) => {
          if (!opts.readout) return;
          e.stopPropagation();
          if (!c) return;
          picked?.classList.remove('picked');
          if (picked === cell) {
            picked = null;
            opts.readout.textContent = opts.defaultText ?? '';
            return;
          }
          picked = cell;
          cell.classList.add('picked');
          opts.readout.textContent = c.detail;
        },
      });
      grid.append(cell);
    });
  });
  const days = h('div', { class: 'strava-cal-days' }, ...opts.dayLabels.map((d, i) => h('span', {}, i % 2 === 0 ? d : '')));
  const legend = h(
    'div',
    { class: 'strava-cal-legend' },
    h('span', {}, 'Less'),
    ...[0, 1, 2, 3, 4].map((l) => h('i', { class: `strava-cal-cell l${l}` })),
    h('span', {}, 'More'),
  );
  return h('div', { class: 'strava-cal' }, months, h('div', { class: 'strava-cal-body' }, days, grid), legend);
}

export interface LineSeries {
  name: string;
  values: (number | null)[];
  /** 'main' is the orange line; 'ghost' is the gray comparison line. */
  kind: 'main' | 'ghost';
}

/**
 * Lines over a shared x range with a tap/drag crosshair. x positions are index-based
 * (series of equal length share the axis). `xLabel(i)` names a point for the readout.
 */
export function lineChart(
  series: LineSeries[],
  opts: {
    xLabel: (i: number) => string;
    yText: (v: number) => string;
    readout?: HTMLElement;
    defaultText?: string;
    area?: boolean;
    ticks?: { at: number; label: string }[];
    /** Lowest y; defaults to 0, or the data's min for profiles. */
    yMin?: 'zero' | 'data';
    height?: number;
  },
): HTMLElement {
  const W = 1000;
  const H = opts.height ?? 300;
  const n = Math.max(...series.map((s) => s.values.length), 2);
  const vals = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  let lo = opts.yMin === 'data' ? Math.min(...vals) : 0;
  let hi = Math.max(...vals, lo + 1);
  if (opts.yMin === 'data') {
    const padY = (hi - lo) * 0.1 || 1;
    lo -= padY;
    hi += padY;
  } else hi *= 1.08;
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('strava-line-svg');
  // Recessive grid: three lines.
  for (const f of [0.25, 0.5, 0.75, 1]) {
    const g = document.createElementNS(ns, 'line');
    const gy = H - f * H * (1 / (opts.yMin === 'data' ? 1 : 1.08));
    g.setAttribute('x1', '0');
    g.setAttribute('x2', String(W));
    g.setAttribute('y1', String(gy));
    g.setAttribute('y2', String(gy));
    g.setAttribute('class', 'strava-line-grid');
    svg.append(g);
  }
  for (const s of [...series].sort((a) => (a.kind === 'ghost' ? -1 : 1))) {
    let d = '';
    let started = false;
    s.values.forEach((v, i) => {
      if (v == null) {
        started = false;
        return;
      }
      d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      started = true;
    });
    if (opts.area && s.kind === 'main') {
      const first = s.values.findIndex((v) => v != null);
      const last = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v != null);
      const area = document.createElementNS(ns, 'path');
      area.setAttribute('d', `${d}L${x(last)},${H}L${x(first)},${H}Z`);
      area.setAttribute('class', 'strava-line-area');
      svg.append(area);
    }
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', `strava-line-path ${s.kind}`);
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(path);
  }
  const cross = h('div', { class: 'strava-line-cross' });
  const dots = series.map((s) => h('div', { class: `strava-line-dot ${s.kind}` }));
  const yLabels = h(
    'div',
    { class: 'strava-line-ylabels' },
    ...[1, 0.5].map((f) => h('span', { style: `top:${(1 - f / (opts.yMin === 'data' ? 1 : 1.08)) * 100}%` }, opts.yText(lo + (hi - lo) * (f / (opts.yMin === 'data' ? 1 : 1.08))))),
  );
  const plot = h('div', { class: 'strava-line-plot', style: `aspect-ratio:${W}/${H}` });
  plot.append(svg, yLabels, cross, ...dots);
  const ticks = h('div', { class: 'strava-line-ticks' }, ...(opts.ticks ?? []).map((t) => h('span', { style: `left:${(t.at / (n - 1)) * 100}%` }, t.label)));

  const show = (clientX: number) => {
    const r = plot.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round(((clientX - r.left) / r.width) * (n - 1))));
    cross.style.left = `${(i / (n - 1)) * 100}%`;
    cross.style.display = 'block';
    const parts: string[] = [];
    series.forEach((s, k) => {
      const v = s.values[i];
      const dot = dots[k];
      if (v == null) {
        dot.style.display = 'none';
        return;
      }
      dot.style.display = 'block';
      dot.style.left = `${(i / (n - 1)) * 100}%`;
      dot.style.top = `${(y(v) / H) * 100}%`;
      parts.push(series.length > 1 ? `${s.name} ${opts.yText(v)}` : opts.yText(v));
    });
    if (opts.readout) opts.readout.textContent = `${opts.xLabel(i)}: ${parts.join(' · ')}`;
  };
  plot.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    plot.setPointerCapture(e.pointerId);
    show(e.clientX);
  });
  plot.addEventListener('pointermove', (e) => {
    if (plot.hasPointerCapture(e.pointerId)) show(e.clientX);
  });
  plot.addEventListener('click', (e) => e.stopPropagation());
  const legend =
    series.length > 1
      ? h('div', { class: 'strava-line-legend' }, ...series.map((s) => h('span', { class: s.kind }, h('i'), s.name)))
      : null;
  return h('div', { class: 'strava-line' }, legend, plot, ticks);
}

/** A ring that fills toward a goal; the number sits in the middle. */
export function ring(fraction: number, center: Node[]): HTMLElement {
  const f = Math.max(0, Math.min(1, fraction));
  return h(
    'div',
    { class: 'strava-ring', style: `--f:${f}` },
    h('div', { class: 'strava-ring-inner' }, ...center),
  );
}
