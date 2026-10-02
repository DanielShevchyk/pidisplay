// Stock charts drawn as plain SVG: a tiny sparkline for rows and tiles, and a
// full price chart with axes, the previous close, alert levels and touch scrubbing.
import { h } from '../../core/dom';
import { money, signedPct, type History, type Range, type StockAlert } from '../../core/stocks';

const SVG = 'http://www.w3.org/2000/svg';

function svg(tag: string, attrs: Record<string, string | number> = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Trend line scaled to its box; colored by whether the last value beats the first. */
export function sparkline(values: number[], baseline?: number | null): HTMLElement {
  const box = h('span', { class: 'stk-spark' });
  if (values.length < 2) return box;
  const w = 100;
  const hgt = 32;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const y = (v: number) => (hi === lo ? hgt / 2 : 2 + (1 - (v - lo) / (hi - lo)) * (hgt - 4));
  const x = (i: number) => (i / (values.length - 1)) * w;
  const ref = baseline ?? values[0];
  box.classList.add(values[values.length - 1] >= ref ? 'up' : 'down');
  const s = svg('svg', { viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'none' });
  s.append(svg('polyline', { points: values.map((v, i) => `${x(i)},${y(v)}`).join(' '), class: 'stk-spark-line' }));
  box.append(s);
  return box;
}

const fmtTime = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const fmtWeekday = new Intl.DateTimeFormat([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' });
const fmtMonth = new Intl.DateTimeFormat([], { month: 'short' });
const fmtFull = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', year: 'numeric' });

function axisLabel(t: number, range: Range): string {
  if (range === '1d') return fmtTime.format(t);
  if (range === '5d') return fmtWeekday.format(t).split(' ')[0].replace(',', '');
  if (range === '1m' || range === '6m') return fmtDay.format(t);
  return `${fmtMonth.format(t)} '${String(new Date(t).getFullYear()).slice(2)}`;
}

function scrubLabel(t: number, range: Range): string {
  if (range === '1d') return fmtTime.format(t);
  if (range === '5d') return fmtWeekday.format(t);
  return fmtFull.format(t);
}

/** Change over the range: against the previous close for one day, else the first point. */
export function rangeChange(hist: History): { abs: number; pct: number } | null {
  const pts = hist.points;
  if (pts.length < 2 && !(pts.length && hist.prevClose)) return null;
  const base = hist.range === '1d' && hist.prevClose ? hist.prevClose : pts[0][1];
  const last = pts[pts.length - 1][1];
  return { abs: last - base, pct: base ? ((last - base) / base) * 100 : 0 };
}

/**
 * Draws the chart into host, sized to it, and redraws when host resizes.
 * Returns a cleanup function.
 */
export function drawChart(host: HTMLElement, hist: History, alerts: StockAlert[]): () => void {
  const readout = h('div', { class: 'stk-readout', hidden: true });
  host.replaceChildren(readout);
  let drawn: SVGElement | null = null;

  const render = () => {
    const w = Math.round(host.clientWidth);
    const hgt = Math.round(host.clientHeight);
    if (w < 40 || hgt < 40) return;
    drawn?.remove();
    drawn = build(w, hgt);
    host.append(drawn);
  };

  function build(w: number, hgt: number): SVGElement {
    const pts = hist.points;
    const s = svg('svg', { viewBox: `0 0 ${w} ${hgt}`, class: 'stk-chart' });
    if (pts.length < 2) {
      const t = svg('text', { x: w / 2, y: hgt / 2, 'text-anchor': 'middle', class: 'stk-axis' });
      t.textContent = 'Not enough data for this range yet';
      s.append(t);
      return s;
    }
    const font = Math.max(13, Math.min(18, hgt / 14));
    const pad = { l: 6, r: font * 4.6, t: font * 0.8, b: font * 1.8 };
    const values = pts.map((p) => p[1]);
    const base = hist.range === '1d' ? hist.prevClose : null;
    const levels = alerts
      .filter((a) => a.enabled && (a.kind === 'above' || a.kind === 'below'))
      .map((a) => a.value);
    let lo = Math.min(...values, base ?? Infinity);
    let hi = Math.max(...values, base ?? -Infinity);
    // Bring nearby alert levels into view, but don't flatten the line for a far-off one.
    const span = hi - lo || hi * 0.01 || 1;
    for (const v of levels) if (v > lo - span * 0.5 && v < hi + span * 0.5) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
    const margin = (hi - lo || 1) * 0.06;
    lo -= margin;
    hi += margin;
    const x = (i: number) => pad.l + (i / (pts.length - 1)) * (w - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (hgt - pad.t - pad.b);

    // Grid and price labels.
    for (let i = 0; i <= 3; i++) {
      const v = lo + margin + ((hi - lo - 2 * margin) * i) / 3;
      s.append(svg('line', { x1: pad.l, x2: w - pad.r, y1: y(v), y2: y(v), class: 'stk-grid' }));
      const label = svg('text', { x: w - pad.r + 8, y: y(v) + font * 0.35, class: 'stk-axis', 'font-size': font });
      label.textContent = money(v, hist.currency);
      s.append(label);
    }

    const change = rangeChange(hist);
    const dir = change && change.abs < 0 ? 'down' : 'up';
    const id = `stk-fill-${Math.random().toString(36).slice(2, 8)}`;
    const grad = svg('linearGradient', { id, x1: 0, x2: 0, y1: 0, y2: 1 });
    grad.append(svg('stop', { offset: '0%', class: `stk-fill-top ${dir}` }), svg('stop', { offset: '100%', class: 'stk-fill-bottom' }));
    const defs = svg('defs');
    defs.append(grad);
    s.append(defs);

    const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const bottom = hgt - pad.b;
    s.append(svg('polygon', { points: `${x(0)},${bottom} ${line} ${x(values.length - 1)},${bottom}`, fill: `url(#${id})` }));

    if (base !== null) s.append(svg('line', { x1: pad.l, x2: w - pad.r, y1: y(base), y2: y(base), class: 'stk-base' }));
    for (const a of alerts) {
      if (!a.enabled || (a.kind !== 'above' && a.kind !== 'below') || a.value < lo || a.value > hi) continue;
      s.append(svg('line', { x1: pad.l, x2: w - pad.r, y1: y(a.value), y2: y(a.value), class: 'stk-alert-line' }));
      const bell = svg('text', { x: pad.l + 4, y: y(a.value) - 6, class: 'stk-alert-label', 'font-size': font });
      bell.textContent = `🔔 ${money(a.value, hist.currency)}`;
      s.append(bell);
    }

    s.append(svg('polyline', { points: line, class: `stk-line ${dir}` }));

    // Time labels: start, middle, end.
    const marks: [number, string][] = [[0, 'start'], [Math.floor((pts.length - 1) / 2), 'middle'], [pts.length - 1, 'end']];
    for (const [i, anchor] of marks) {
      const t = svg('text', { x: x(i), y: hgt - font * 0.4, 'text-anchor': anchor, class: 'stk-axis', 'font-size': font });
      t.textContent = axisLabel(pts[i][0], hist.range);
      s.append(t);
    }

    // Touch scrubbing: a cursor and a readout of the price at that moment.
    const cursor = svg('line', { y1: pad.t, y2: bottom, class: 'stk-cursor', visibility: 'hidden' });
    const dot = svg('circle', { r: 6, class: `stk-dot ${dir}`, visibility: 'hidden' });
    s.append(cursor, dot);
    const show = (e: PointerEvent) => {
      const rect = s.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * w;
      const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - pad.l) / (w - pad.l - pad.r)) * (pts.length - 1))));
      const [t, v] = pts[i];
      for (const el of [cursor, dot]) el.setAttribute('visibility', 'visible');
      cursor.setAttribute('x1', String(x(i)));
      cursor.setAttribute('x2', String(x(i)));
      dot.setAttribute('cx', String(x(i)));
      dot.setAttribute('cy', String(y(v)));
      const ref = hist.range === '1d' && hist.prevClose ? hist.prevClose : pts[0][1];
      readout.textContent = `${scrubLabel(t, hist.range)} · ${money(v, hist.currency)} · ${signedPct(ref ? ((v - ref) / ref) * 100 : null)}`;
      readout.hidden = false;
    };
    const hide = () => {
      for (const el of [cursor, dot]) el.setAttribute('visibility', 'hidden');
      readout.hidden = true;
    };
    s.addEventListener('pointerdown', (e) => {
      s.setPointerCapture(e.pointerId);
      show(e);
    });
    s.addEventListener('pointermove', (e) => e.buttons && show(e));
    s.addEventListener('pointerup', hide);
    s.addEventListener('pointercancel', hide);
    return s;
  }

  const observer = new ResizeObserver(() => render());
  observer.observe(host);
  render();
  return () => observer.disconnect();
}
