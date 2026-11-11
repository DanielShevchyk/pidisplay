// The System detail sheet: opened by tapping the top-bar CPU readout or a
// System tile. Live rings, an hour of history kept by the server (CPU,
// temperature, memory, network), per-core load, network interfaces and the
// busiest processes. Refreshes every 3 s while open, nothing once closed.
import { h } from '../../core/dom';
import { openSheet } from '../../core/sheet';
import {
  bytes,
  duration,
  level,
  meter,
  metrics,
  powerStatus,
  rate,
  ring,
  svg,
  temp,
  TEMP_BAD,
  TEMP_WARN,
  type Level,
  type Stats,
  type SystemConfig,
} from './index';

/** Mirrors GET /api/system/details (server/system.js). */
interface Point {
  t: number;
  cpu: number | null;
  iowait: number | null;
  mem: number | null;
  temp: number | null;
  rx: number | null;
  tx: number | null;
  mhz: number | null;
}
interface Iface {
  name: string;
  rx: number;
  tx: number;
  rxErrors: number;
  txErrors: number;
  rxDrops: number;
  txDrops: number;
  rxRate: number | null;
  txRate: number | null;
}
interface Details {
  time: number;
  intervalMs: number;
  history: Point[];
  cpuSplit: { usage: number; user: number; system: number; iowait: number } | null;
  processes: { count: number; top: { name: string; count: number; cpu: number; mem: number }[] } | null;
  interfaces: Iface[];
}

const REFRESH_MS = 3000;
const RANGES = [
  { label: '5 min', ms: 5 * 60_000 },
  { label: '15 min', ms: 15 * 60_000 },
  { label: '1 hour', ms: 60 * 60_000 },
];
// Remembered between openings.
let rangeMs = RANGES[1].ms;

export function openDetails(config: SystemConfig) {
  const content = h('div', { class: 'sysd' }, h('div', { class: 'sys-message' }, 'Loading…'));
  let stats: Stats | null = null;
  let details: Details | null = null;
  let failed = '';
  let timer = 0;
  let alive = true;
  const controller = new AbortController();

  const sheet = openSheet('🖥️ System performance', [content], {
    onClose() {
      alive = false;
      clearTimeout(timer);
      controller.abort();
    },
  });
  sheet.body.parentElement?.classList.add('sysd-sheet');

  const paint = () => {
    if (!stats) {
      content.replaceChildren(h('div', { class: 'sys-message' }, failed ? `⚠️ ${failed}` : 'Loading…'));
      return;
    }
    content.replaceChildren(render(stats, details, config, Boolean(failed), paint));
  };

  const refresh = async () => {
    try {
      const get = async (url: string) => {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`Stats unavailable (${res.status})`);
        return res.json();
      };
      // Details are optional: an older server without them still shows the live part.
      const [s, d] = await Promise.all([get('/api/system'), get('/api/system/details').catch(() => null)]);
      stats = s as Stats;
      details = d as Details | null;
      failed = '';
    } catch (err) {
      if (!alive) return;
      failed = err instanceof Error ? err.message : String(err);
    }
    if (!alive) return;
    paint();
    timer = window.setTimeout(refresh, REFRESH_MS);
  };
  refresh();
}

// ---- Rendering ------------------------------------------------------------

function render(s: Stats, d: Details | null, config: SystemConfig, stale: boolean, repaint: () => void) {
  const unit = config.tempUnit;
  const power = powerStatus(s);
  const now = d?.time ?? s.time;
  const points = (d?.history ?? []).filter((p) => p.t >= now - rangeMs);

  const rangeChips = h(
    'div',
    { class: 'chips sysd-range' },
    ...RANGES.map((r) =>
      h(
        'button',
        {
          class: `chip${r.ms === rangeMs ? ' active' : ''}`,
          onclick: () => {
            rangeMs = r.ms;
            repaint();
          },
        },
        r.label,
      ),
    ),
  );

  const memTotal = s.memory?.total ?? 0;
  const charts = d
    ? [
        chartEl({
          title: 'CPU',
          current: s.cpu.usage === null ? '–' : `${Math.round(s.cpu.usage)}%`,
          sub: d.cpuSplit ? `user ${Math.round(d.cpuSplit.user)}% · system ${Math.round(d.cpuSplit.system)}% · I/O wait ${Math.round(d.cpuSplit.iowait)}%` : '',
          points,
          series: [
            { key: 'cpu', cls: 'sysd-cpu', area: true },
            { key: 'iowait', cls: 'sysd-iowait' },
          ],
          min: 0,
          max: 100,
          fmt: (v) => `${Math.round(v)}%`,
          statKey: 'cpu',
        }, now),
        (s.temperature !== null || points.some((p) => p.temp !== null)) &&
        chartEl({
          title: 'Temperature',
          current: temp(s.temperature, unit),
          sub: s.cpu.mhz ? `clock ${s.cpu.mhz}${s.cpu.maxMhz ? ` / ${s.cpu.maxMhz}` : ''} MHz` : '',
          points,
          series: [{ key: 'temp', cls: 'sysd-temp', area: true }],
          min: 20,
          max: 85,
          marks: [
            { at: TEMP_WARN, cls: 'sysd-mark-warn' },
            { at: TEMP_BAD, cls: 'sysd-mark-bad' },
          ],
          fmt: (v) => temp(v, unit),
          statKey: 'temp',
        }, now),
        chartEl({
          title: 'Memory',
          current: s.memory ? bytes(s.memory.used) : '–',
          sub: s.memory ? `of ${bytes(s.memory.total)}${s.memory.swapTotal ? ` · swap ${bytes(s.memory.swapUsed)} / ${bytes(s.memory.swapTotal)}` : ''}` : '',
          points,
          series: [{ key: 'mem', cls: 'sysd-mem', area: true }],
          min: 0,
          max: memTotal || Math.max(1, ...points.map((p) => p.mem ?? 0)),
          fmt: (v) => bytes(v),
          statKey: 'mem',
        }, now),
        networkChart(s, points, now),
      ]
    : [h('div', { class: 'sysd-note' }, 'History isn’t available yet. Redeploy to get the server’s rolling history.')];

  const left = h(
    'div',
    { class: 'sysd-col' },
    h('div', { class: 'sysd-head' }, h('span', { class: 'sysd-label' }, 'History'), rangeChips),
    ...charts,
    d && points.length < 2 && h('div', { class: 'sysd-note' }, 'Collecting… a point is added every 10 seconds.'),
  );

  const right = h(
    'div',
    { class: 'sysd-col' },
    s.cpu.cores.length > 1 &&
      section(
        'CPU cores',
        h(
          'div',
          { class: 'sysd-cores' },
          ...s.cpu.cores.map((pct, i) => meter({ label: `Core ${i + 1}`, pct, value: `${Math.round(pct)}%`, detail: '', level: level(pct) })),
        ),
      ),
    d && interfacesSection(d.interfaces),
    d?.processes && processesSection(d.processes),
    section('Health', facts(s, power, d)),
  );

  return h(
    'div',
    { class: `sysd-body${stale ? ' stale' : ''}` },
    h('div', { class: 'sys-rings sysd-rings' }, ...metrics(s, unit).map(ring)),
    stale && h('div', { class: 'sys-stale' }, '⚠ Not updating'),
    h('div', { class: 'sysd-grid' }, left, right),
  );
}

function section(title: string, ...children: (Node | false | null | undefined)[]) {
  return h('div', { class: 'sysd-section' }, h('div', { class: 'sysd-label' }, title), ...children);
}

function facts(s: Stats, power: { text: string; level: Level }, d: Details | null) {
  const list: [string, string, Level?][] = [
    ['Power', power.text, power.level],
    ['Core volts', s.power?.coreVolts ? `${s.power.coreVolts.toFixed(2)} V` : '–'],
    ['Load (1/5/15 min)', s.load.map((n) => n.toFixed(2)).join('  ')],
    ['Uptime', duration(s.uptime)],
    ['Disk', s.disk ? `${bytes(s.disk.used)} used · ${bytes(s.disk.free)} free` : '–'],
    ['Processes', d?.processes ? String(d.processes.count) : '–'],
    ['Host', s.hostname],
    ['IP address', s.ip ?? '–'],
  ];
  return h(
    'div',
    { class: 'sysd-facts' },
    ...list.map(([label, value, lvl]) =>
      h('div', { class: 'sys-fact' }, h('span', { class: 'sys-fact-label' }, label), h('span', { class: lvl ? `lvl-text-${lvl}` : '' }, value)),
    ),
  );
}

function interfacesSection(list: Iface[]) {
  // Hide idle virtual interfaces (docker, ifb, ...) that never carried traffic.
  const shown = list.filter((i) => i.rx + i.tx > 0);
  if (!shown.length) return section('Network', h('div', { class: 'sysd-note' }, 'No network traffic yet.'));
  return section(
    'Network',
    h(
      'div',
      { class: 'sysd-table sysd-net' },
      h('span', { class: 'sysd-th' }, 'Interface'),
      h('span', { class: 'sysd-th' }, '↓ Down'),
      h('span', { class: 'sysd-th' }, '↑ Up'),
      h('span', { class: 'sysd-th' }, 'Since boot'),
      ...shown.flatMap((i) => {
        const errs = i.rxErrors + i.txErrors + i.rxDrops + i.txDrops;
        return [
          h('span', {}, ifaceName(i.name), errs > 0 && h('span', { class: 'sysd-errs' }, ` ${errs} err/drop`)),
          h('span', { class: 'sysd-rx' }, rate(i.rxRate)),
          h('span', { class: 'sysd-tx' }, rate(i.txRate)),
          h('span', { class: 'sys-dim' }, `↓ ${bytes(i.rx)}  ↑ ${bytes(i.tx)}`),
        ];
      }),
    ),
  );
}

function ifaceName(name: string) {
  if (/^wl/.test(name)) return `Wi-Fi (${name})`;
  if (/^(eth|en)/.test(name)) return `Ethernet (${name})`;
  return name;
}

function processesSection(p: NonNullable<Details['processes']>) {
  return section(
    'Top processes',
    h(
      'div',
      { class: 'sysd-table sysd-procs' },
      h('span', { class: 'sysd-th' }, 'Name'),
      h('span', { class: 'sysd-th' }, 'CPU'),
      h('span', { class: 'sysd-th' }, 'Memory'),
      ...p.top.flatMap((g) => [
        h('span', { class: 'sysd-pname' }, g.name, g.count > 1 && h('span', { class: 'sys-dim' }, ` ×${g.count}`)),
        h('span', { class: `lvl-text-${g.cpu >= 50 ? 'bad' : g.cpu >= 25 ? 'warn' : 'none'}` }, `${g.cpu.toFixed(1)}%`),
        h('span', {}, bytes(g.mem)),
      ]),
    ),
  );
}

// ---- Charts -----------------------------------------------------------------

type Key = 'cpu' | 'iowait' | 'mem' | 'temp' | 'rx' | 'tx';
interface ChartSpec {
  title: string;
  current: string;
  sub: string;
  points: Point[];
  series: { key: Key; cls: string; area?: boolean }[];
  min: number;
  max: number;
  marks?: { at: number; cls: string }[];
  fmt: (v: number) => string;
  statKey: Key;
  /** Prefix for the avg/peak line, e.g. "↓". */
  statLabel?: string;
  legend?: Node;
}

const W = 1000;
const H = 100;

function chartEl(spec: ChartSpec, nowMsArg?: number) {
  const { points } = spec;
  const nowMs = nowMsArg ?? points.at(-1)?.t ?? Date.now();
  const start = nowMs - rangeMs;
  const x = (t: number) => ((t - start) / rangeMs) * W;
  const y = (v: number) => H - Math.max(0, Math.min(1, (v - spec.min) / (spec.max - spec.min || 1))) * H;
  const el = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'sysd-svg' });
  for (const g of [0.25, 0.5, 0.75]) el.append(svg('line', { x1: 0, x2: W, y1: H * g, y2: H * g, class: 'sysd-grid-line' }));
  for (const m of spec.marks ?? []) el.append(svg('line', { x1: 0, x2: W, y1: y(m.at), y2: y(m.at), class: m.cls }));

  // A gap of more than 3 samples (server restart) breaks the line.
  const gap = 35_000;
  for (const s of spec.series) {
    const runs: string[][] = [];
    let run: string[] = [];
    let lastT = -Infinity;
    for (const p of points) {
      const v = p[s.key];
      if (v === null || p.t - lastT > gap) {
        if (run.length) runs.push(run);
        run = [];
      }
      if (v !== null) run.push(`${x(p.t).toFixed(1)},${y(v).toFixed(1)}`);
      lastT = p.t;
    }
    if (run.length) runs.push(run);
    for (const r of runs) {
      if (s.area && r.length > 1) {
        const x0 = r[0].split(',')[0];
        const x1 = r.at(-1)!.split(',')[0];
        el.append(svg('polygon', { points: `${x0},${H} ${r.join(' ')} ${x1},${H}`, class: `${s.cls} sysd-area` }));
      }
      el.append(svg('polyline', { points: r.length === 1 ? `${r[0]} ${r[0]}` : r.join(' '), class: `${s.cls} sysd-line` }));
    }
  }

  const vals = points.map((p) => p[spec.statKey]).filter((v): v is number => v !== null);
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const peak = vals.length ? Math.max(...vals) : null;
  const range = RANGES.find((r) => r.ms === rangeMs)?.label ?? '';

  return h(
    'div',
    { class: 'sysd-chart' },
    h(
      'div',
      { class: 'sysd-chart-head' },
      h('span', { class: 'sysd-chart-title' }, spec.title),
      h('span', { class: 'sysd-chart-now' }, spec.current),
      spec.legend ?? null,
      h(
        'span',
        { class: 'sysd-chart-stats' },
        avg !== null ? `${spec.statLabel ?? ''}avg ${spec.fmt(avg)} · peak ${spec.fmt(peak!)}` : '',
      ),
    ),
    spec.sub && h('div', { class: 'sysd-chart-sub' }, spec.sub),
    h('div', { class: 'sysd-plot' }, el, h('span', { class: 'sysd-axis-max' }, spec.fmt(spec.max))),
    h('div', { class: 'sysd-axis' }, h('span', {}, `−${range}`), h('span', {}, 'now')),
  );
}

function networkChart(s: Stats, points: Point[], nowMs: number) {
  const peak = Math.max(0, ...points.map((p) => Math.max(p.rx ?? 0, p.tx ?? 0)));
  const max = niceMax(Math.max(peak, 10 * 1024));
  return chartEl(
    {
      title: 'Network',
      current: s.network ? `↓ ${rate(s.network.rxRate)}  ↑ ${rate(s.network.txRate)}` : '–',
      sub: '',
      points,
      series: [
        { key: 'rx', cls: 'sysd-rx', area: true },
        { key: 'tx', cls: 'sysd-tx' },
      ],
      min: 0,
      max,
      fmt: (v) => rate(v),
      statKey: 'rx',
      statLabel: '↓ ',
      legend: h('span', { class: 'sysd-legend' }, h('span', { class: 'sysd-rx' }, '■ down'), h('span', { class: 'sysd-tx' }, '■ up')),
    },
    nowMs,
  );
}

/** Rounds up to 1, 2 or 5 × a power of ten so the axis label reads cleanly. */
function niceMax(v: number) {
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 5, 10]) if (m * exp >= v) return m * exp;
  return v;
}
