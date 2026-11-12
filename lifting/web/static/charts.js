// Small SVG line chart: one y axis, date x axis, crosshair + tooltip on touch/hover,
// direct labels at the line ends, optional dashed reference lines.
import { h, shortDate } from './common.js';

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
}
const day = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;

function niceTicks(min, max, count = 5) {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= raw) ?? raw;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

/**
 * series: [{ name, color: 'var(--series-1)', dashed?, points: [{ x: 'YYYY-MM-DD', y, pr?, note? }] }]
 * opts: { unit: 'lb', format: (v) => string, refs: [{ y, label }], onTap(point, series) }
 */
export function lineChart(el, series, opts = {}) {
  const fmt = opts.format || ((v) => `${Math.round(v * 10) / 10}`);
  const draw = () => {
    el.replaceChildren();
    const W = el.clientWidth || 600;
    const H = el.clientHeight || 300;
    const all = series.flatMap((se) => se.points);
    if (!all.length) {
      el.append(h('div', { class: 'empty' }, opts.empty || 'Nothing logged yet'));
      return;
    }
    const pad = { l: 64, r: 120, t: 18, b: 36 };
    const ys = all.map((p) => p.y).concat((opts.refs || []).map((r) => r.y));
    let lo = Math.min(...ys);
    let hi = Math.max(...ys);
    // A minimum span keeps a flat line looking flat instead of zooming into noise.
    const minSpan = opts.minSpan ?? 0;
    if (hi - lo < minSpan) {
      const mid = (hi + lo) / 2;
      lo = mid - minSpan / 2;
      hi = mid + minSpan / 2;
    }
    const span = hi - lo || Math.max(1, Math.abs(hi) * 0.1);
    lo -= span * 0.08;
    hi += span * 0.08;
    if (opts.zero) lo = 0; // start the axis at zero
    else if (opts.floor !== undefined) lo = Math.max(opts.floor, lo); // never pad below this
    const ticks = niceTicks(lo, hi);
    lo = ticks[0];
    hi = ticks[ticks.length - 1];
    const xs = all.map((p) => day(p.x));
    let x0 = Math.min(...xs);
    let x1 = Math.max(...xs);
    if (x0 === x1) {
      x0 -= 3;
      x1 += 3;
    }
    const X = (iso) => pad.l + ((day(iso) - x0) / (x1 - x0)) * (W - pad.l - pad.r);
    const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label || 'chart' });
    const axis = s('g', { class: 'axis' });
    for (const t of ticks) {
      axis.append(s('line', { class: 'gridline', x1: pad.l, x2: W - pad.r, y1: Y(t), y2: Y(t) }));
      axis.append(s('text', { x: pad.l - 10, y: Y(t) + 5, 'text-anchor': 'end' }, fmt(t)));
    }
    // X labels: every distinct date, thinned to fit.
    const dates = [...new Set(all.map((p) => p.x))].sort();
    const every = Math.max(1, Math.ceil(dates.length / Math.max(1, Math.floor((W - pad.l - pad.r) / 80))));
    dates.forEach((d, i) => {
      if (i % every === 0 || i === dates.length - 1) axis.append(s('text', { x: X(d), y: H - 10, 'text-anchor': 'middle' }, shortDate(d)));
    });
    svg.append(axis);
    for (const r of opts.refs || []) {
      svg.append(s('line', { class: 'refline', x1: pad.l, x2: W - pad.r, y1: Y(r.y), y2: Y(r.y) }));
      svg.append(s('text', { class: 'reflabel', x: W - pad.r + 8, y: Y(r.y) + 5 }, r.label));
    }
    const endLabels = [];
    for (const se of series) {
      const pts = se.points.slice().sort((a, b) => day(a.x) - day(b.x));
      if (!pts.length) continue;
      if (pts.length > 1) {
        svg.append(s('path', {
          d: pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(''),
          fill: 'none', stroke: se.color, 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
          ...(se.dashed ? { 'stroke-dasharray': '7 6' } : {}),
        }));
      }
      for (const p of pts) {
        // A surface ring keeps overlapping markers apart.
        svg.append(s('circle', { cx: X(p.x), cy: Y(p.y), r: 6, fill: se.color, stroke: 'var(--surface)', 'stroke-width': 2 }));
        if (p.pr) {
          svg.append(s('circle', { cx: X(p.x), cy: Y(p.y), r: 11, fill: 'none', stroke: 'var(--pr)', 'stroke-width': 2 }));
          svg.append(s('text', { x: X(p.x), y: Y(p.y) - 17, 'text-anchor': 'middle', fill: 'var(--pr)', 'font-size': 13, 'font-weight': 700 }, 'PR'));
        }
      }
      const last = pts[pts.length - 1];
      endLabels.push({ y: Y(last.y), x: X(last.x), text: `${se.short || se.name} ${fmt(last.y)}` });
    }
    // End labels, nudged apart so they never overlap.
    endLabels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < endLabels.length; i++) endLabels[i].y = Math.max(endLabels[i].y, endLabels[i - 1].y + 20);
    for (const l of endLabels) svg.append(s('text', { x: l.x + 14, y: l.y + 5, fill: 'var(--text)', 'font-size': 15 }, l.text));

    // Crosshair + tooltip for the date nearest the finger.
    const cross = s('line', { class: 'crosshair', y1: pad.t, y2: H - pad.b, visibility: 'hidden' });
    svg.append(cross);
    const hit = s('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' });
    svg.append(hit);
    el.append(svg);
    const tip = h('div', { class: 'tip', hidden: true });
    el.append(tip);
    const nearest = (evt) => {
      const r = svg.getBoundingClientRect();
      const px = ((evt.clientX - r.left) / r.width) * W;
      let best = dates[0];
      for (const d of dates) if (Math.abs(X(d) - px) < Math.abs(X(best) - px)) best = d;
      return best;
    };
    const show = (evt) => {
      const d = nearest(evt);
      cross.setAttribute('x1', X(d));
      cross.setAttribute('x2', X(d));
      cross.setAttribute('visibility', 'visible');
      const rows = series
        .map((se) => [se, se.points.find((p) => p.x === d)])
        .filter(([, p]) => p);
      tip.replaceChildren(
        h('b', {}, shortDate(d) + (rows[0]?.[1].title ? ` · ${rows[0][1].title}` : '')),
        ...rows.map(([se, p]) => h('div', {}, h('span', { class: 'sw', style: `background:${se.color}` }), `${se.name}: ${p.label ?? fmt(p.y)}`, p.pr ? ' · PR' : '')),
        ...rows.filter(([, p]) => p.note).slice(0, 1).map(([, p]) => h('div', { class: 'dim' }, p.note)),
      );
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const left = (X(d) / W) * r.width;
      tip.style.left = `${Math.min(Math.max(8, left + 14), r.width - tip.offsetWidth - 8)}px`;
      tip.style.top = `${pad.t}px`;
      return d;
    };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', (e) => {
      const d = show(e);
      if (opts.onTap) {
        const se = series.find((x) => x.points.some((p) => p.x === d));
        opts.onTap(se?.points.find((p) => p.x === d), se);
      }
    });
    hit.addEventListener('pointerleave', () => {
      tip.hidden = true;
      cross.setAttribute('visibility', 'hidden');
    });
  };
  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(el);
  return { destroy: () => ro.disconnect(), redraw: draw };
}

export function legend(series) {
  return h('div', { class: 'legend' }, ...series.map((se) => h('span', {}, h('i', { class: se.dashed ? 'dash' : '', style: `background:${se.color};color:${se.color}` }), se.name)));
}
