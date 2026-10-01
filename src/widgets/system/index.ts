import { h } from '../../core/dom';
import { defineWidget, type Placement } from '../../core/types';
import './system.css';

interface SystemConfig {
  refreshSeconds: number;
  tempUnit: 'c' | 'f';
  [key: string]: unknown;
}

/** Mirrors the payload from GET /api/system (server/system.js). Null = not available. */
interface Stats {
  time: number;
  hostname: string;
  ip: string | null;
  uptime: number;
  load: number[];
  cpu: { usage: number | null; cores: number[]; mhz: number | null; maxMhz: number | null };
  temperature: number | null;
  memory: { total: number; used: number; swapTotal: number; swapUsed: number } | null;
  disk: { path: string; total: number; used: number; free: number } | null;
  power: {
    /** Raw get_throttled bitmask. */
    raw: number;
    underVoltage: boolean;
    freqCapped: boolean;
    throttled: boolean;
    softTempLimit: boolean;
    underVoltageOccurred: boolean;
    freqCappedOccurred: boolean;
    throttledOccurred: boolean;
    softTempLimitOccurred: boolean;
    coreVolts: number | null;
  } | null;
  network: { rxRate: number | null; txRate: number | null } | null;
}

type Level = 'ok' | 'warn' | 'bad';

interface Metric {
  label: string;
  /** 0–100, drives the ring or bar. */
  pct: number | null;
  value: string;
  detail: string;
  level: Level;
}

/** What each placement shows. */
const LAYOUT: Record<Placement, { style: 'bar' | 'meters' | 'rings'; history: boolean; cores: boolean; facts: number }> = {
  bar: { style: 'bar', history: false, cores: false, facts: 0 },
  small: { style: 'meters', history: false, cores: false, facts: 0 },
  medium: { style: 'rings', history: false, cores: false, facts: 0 },
  tall: { style: 'meters', history: false, cores: false, facts: 4 },
  large: { style: 'rings', history: true, cores: false, facts: 4 },
  xlarge: { style: 'rings', history: true, cores: true, facts: 6 },
  full: { style: 'rings', history: true, cores: true, facts: 8 },
};

const HISTORY_LEN = 60;
const RETRY_MS = 10_000;
/** The Pi 4 firmware starts throttling at 80 °C (soft limit from 60 °C on some boards). */
const TEMP_WARN = 70;
const TEMP_BAD = 80;

// Shared by every tile so a remount (resize, settings) keeps the graph.
const history: { time: number; cpu: number | null; temp: number | null }[] = [];

function record(s: Stats) {
  if (history.at(-1)?.time === s.time) return;
  history.push({ time: s.time, cpu: s.cpu.usage, temp: s.temperature });
  if (history.length > HISTORY_LEN) history.shift();
}

export default defineWidget<SystemConfig>({
  type: 'system',
  name: 'System',
  description: 'CPU, memory, disk, temperature and power health of the Pi',
  icon: '🖥️',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'large',
  supportsBar: true,
  defaultConfig: { refreshSeconds: 3, tempUnit: 'c' },
  settings: [
    { key: 'refreshSeconds', label: 'Refresh every (seconds)', type: 'number', min: 1, max: 60, step: 1 },
    {
      key: 'tempUnit',
      label: 'Temperature',
      type: 'select',
      options: [
        { value: 'c', label: '°C' },
        { value: 'f', label: '°F' },
      ],
    },
  ],

  mount(el, { config, placement }) {
    const root = h('div', { class: `sys size-${placement}` });
    el.append(root);
    const every = Math.min(60, Math.max(1, Number(config.refreshSeconds) || 3)) * 1000;
    let data: Stats | null = null;
    let failed = '';
    let timer = 0;
    let alive = true;
    const controller = new AbortController();

    const paint = () => {
      if (data) root.replaceChildren(render(data, config, placement, Boolean(failed)));
      else root.replaceChildren(h('div', { class: 'sys-message' }, failed ? `⚠️ ${failed}` : 'Loading…'));
    };

    const refresh = async () => {
      let next = every;
      try {
        const res = await fetch('/api/system', { signal: controller.signal });
        if (!res.ok) throw new Error(`Stats unavailable (${res.status})`);
        data = (await res.json()) as Stats;
        record(data);
        failed = '';
      } catch (err) {
        if (!alive) return;
        failed = err instanceof Error ? err.message : String(err);
        next = Math.max(every, RETRY_MS);
      }
      if (!alive) return;
      paint();
      timer = window.setTimeout(refresh, next);
    };

    paint();
    refresh();

    return {
      destroy() {
        alive = false;
        clearTimeout(timer);
        controller.abort();
      },
    };
  },
});

// ---- Formatting -----------------------------------------------------------

function level(pct: number | null, warn = 75, bad = 90): Level {
  if (pct === null) return 'ok';
  return pct >= bad ? 'bad' : pct >= warn ? 'warn' : 'ok';
}

function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function rate(n: number | null): string {
  return n === null ? '–' : `${bytes(n)}/s`;
}

function duration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const hrs = Math.floor((sec % 86400) / 3600);
  const min = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${hrs}h` : hrs ? `${hrs}h ${min}m` : `${min}m`;
}

function temp(c: number | null, unit: 'c' | 'f'): string {
  if (c === null) return '–';
  return unit === 'f' ? `${Math.round(c * 1.8 + 32)}°F` : `${Math.round(c)}°C`;
}

function metrics(s: Stats, unit: 'c' | 'f'): Metric[] {
  const pctOf = (used: number, total: number) => (total > 0 ? (used / total) * 100 : null);
  const mem = s.memory ? pctOf(s.memory.used, s.memory.total) : null;
  // Same as df's Use%: reserved root blocks count as neither used nor free.
  const disk = s.disk ? pctOf(s.disk.used, s.disk.used + s.disk.free) : null;
  const t = s.temperature;
  const show = (p: number | null) => (p === null ? '–' : `${Math.round(p)}%`);
  return [
    {
      label: 'CPU',
      pct: s.cpu.usage,
      value: show(s.cpu.usage),
      detail: s.cpu.mhz ? `${(s.cpu.mhz / 1000).toFixed(1)} GHz` : `${s.cpu.cores.length || '?'} cores`,
      level: level(s.cpu.usage),
    },
    {
      label: 'Memory',
      pct: mem,
      value: show(mem),
      detail: s.memory ? `${bytes(s.memory.used)} / ${bytes(s.memory.total)}` : 'n/a',
      level: level(mem),
    },
    {
      label: 'Disk',
      pct: disk,
      value: show(disk),
      detail: s.disk ? `${bytes(s.disk.free)} free` : 'n/a',
      level: level(disk, 80, 95),
    },
    {
      label: 'Temp',
      // Ring fills toward the 85 °C hard limit.
      pct: t === null ? null : Math.min(100, (t / 85) * 100),
      value: temp(t, unit),
      detail: t === null ? 'n/a' : t >= TEMP_BAD ? 'Throttling' : t >= TEMP_WARN ? 'Hot' : 'Normal',
      level: t === null ? 'ok' : t >= TEMP_BAD ? 'bad' : t >= TEMP_WARN ? 'warn' : 'ok',
    },
  ];
}

/** The one-line power/throttle verdict. A Pi 4 can't measure watts, only report trouble. */
function powerStatus(s: Stats): { text: string; level: Level } {
  const p = s.power;
  if (!p) return { text: 'Power n/a', level: 'ok' };
  if (p.underVoltage) return { text: 'Undervoltage now', level: 'bad' };
  if (p.throttled || p.freqCapped) return { text: 'Throttled now', level: 'warn' };
  if (p.softTempLimit) return { text: 'Temp limited', level: 'warn' };
  if (p.underVoltageOccurred) return { text: 'Undervolted since boot', level: 'warn' };
  if (p.throttledOccurred || p.freqCappedOccurred) return { text: 'Throttled since boot', level: 'warn' };
  return { text: 'Power OK', level: 'ok' };
}

// ---- Rendering ------------------------------------------------------------

function render(s: Stats, config: SystemConfig, placement: Placement, stale: boolean) {
  const spec = LAYOUT[placement];
  const list = metrics(s, config.tempUnit);
  const power = powerStatus(s);

  if (spec.style === 'bar') {
    const [cpu, , , t] = list;
    return h(
      'div',
      { class: `sys-bar${stale ? ' stale' : ''}` },
      h('span', { class: `sys-bar-dot lvl-${worst([power.level, t.level, cpu.level])}` }),
      h('span', {}, `CPU ${cpu.value}`),
      s.temperature !== null && h('span', { class: 'sys-dim' }, t.value),
    );
  }

  const body = h('div', { class: `sys-body${stale ? ' stale' : ''}` });

  if (spec.style === 'rings') body.append(h('div', { class: 'sys-rings' }, ...list.map(ring)));
  else body.append(h('div', { class: 'sys-meters' }, ...list.map(meter)));

  if (spec.history) body.append(historyChart(config.tempUnit));
  if (spec.cores && s.cpu.cores.length > 1) body.append(cores(s.cpu.cores));

  if (spec.facts) {
    const p = s.power;
    const facts: [string, string, Level?][] = [
      ['Power', power.text, power.level],
      ['Uptime', duration(s.uptime)],
      ['Clock', s.cpu.mhz ? `${s.cpu.mhz}${s.cpu.maxMhz ? ` / ${s.cpu.maxMhz}` : ''} MHz` : '–'],
      ['Load', s.load.map((n) => n.toFixed(2)).join('  ')],
      ['Network', s.network ? `↓ ${rate(s.network.rxRate)}  ↑ ${rate(s.network.txRate)}` : '–'],
      ['Swap', s.memory?.swapTotal ? `${bytes(s.memory.swapUsed)} / ${bytes(s.memory.swapTotal)}` : 'none'],
      ['Core volts', p?.coreVolts ? `${p.coreVolts.toFixed(2)} V` : '–'],
      ['Host', s.ip ? `${s.hostname} · ${s.ip}` : s.hostname],
    ];
    body.append(
      h(
        'div',
        { class: 'sys-facts' },
        ...facts.slice(0, spec.facts).map(([label, value, lvl]) =>
          h(
            'div',
            { class: 'sys-fact' },
            h('span', { class: 'sys-fact-label' }, label),
            h('span', { class: lvl ? `lvl-text-${lvl}` : '' }, value),
          ),
        ),
      ),
    );
  } else if (power.level !== 'ok') {
    // Small tiles have no facts row, but a power problem should still show.
    body.append(h('div', { class: `sys-alert lvl-text-${power.level}` }, `⚡ ${power.text}`));
  }

  if (stale) body.append(h('div', { class: 'sys-stale' }, '⚠ Not updating'));
  return body;
}

function worst(levels: Level[]): Level {
  return levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : 'ok';
}

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function ring(m: Metric) {
  const chart = svg('svg', { viewBox: '0 0 100 100', class: 'sys-ring-svg' });
  chart.append(
    svg('circle', { cx: 50, cy: 50, r: 42, class: 'sys-ring-track', pathLength: 100 }),
    svg('circle', {
      cx: 50,
      cy: 50,
      r: 42,
      class: `sys-ring-fill lvl-${m.level}`,
      pathLength: 100,
      'stroke-dasharray': `${Math.max(0, Math.min(100, m.pct ?? 0))} 100`,
    }),
  );
  return h(
    'div',
    { class: 'sys-ring' },
    h('div', { class: 'sys-ring-chart' }, chart, h('div', { class: 'sys-ring-value' }, m.value)),
    h('div', { class: 'sys-ring-label' }, m.label),
    h('div', { class: 'sys-ring-detail' }, m.detail),
  );
}

function meter(m: Metric) {
  return h(
    'div',
    { class: 'sys-meter' },
    h('span', { class: 'sys-meter-label' }, m.label),
    h('span', { class: 'sys-meter-value' }, m.value),
    h(
      'div',
      { class: 'sys-meter-track' },
      h('div', { class: `sys-meter-fill lvl-${m.level}`, style: `width:${Math.max(0, Math.min(100, m.pct ?? 0))}%` }),
    ),
    h('span', { class: 'sys-meter-detail' }, m.detail),
  );
}

function historyChart(unit: 'c' | 'f') {
  const chart = svg('svg', { viewBox: `0 0 ${HISTORY_LEN - 1} 100`, preserveAspectRatio: 'none', class: 'sys-history-svg' });
  const offset = HISTORY_LEN - history.length;
  const line = (key: 'cpu' | 'temp', scale: number) =>
    history
      .map((p, i) => (p[key] === null ? null : `${i + offset},${100 - Math.min(100, (p[key]! / scale) * 100)}`))
      .filter(Boolean)
      .join(' ');
  const cpu = line('cpu', 100);
  if (cpu) {
    const first = cpu.split(' ')[0].split(',')[0];
    chart.append(
      svg('polygon', { points: `${first},100 ${cpu} ${HISTORY_LEN - 1},100`, class: 'sys-history-area' }),
      svg('polyline', { points: cpu, class: 'sys-history-cpu' }),
    );
  }
  const t = line('temp', 85);
  if (t) chart.append(svg('polyline', { points: t, class: 'sys-history-temp' }));
  const lastTemp = history.at(-1)?.temp ?? null;
  return h(
    'div',
    { class: 'sys-history' },
    h(
      'div',
      { class: 'sys-history-legend' },
      h('span', { class: 'sys-key-cpu' }, 'CPU'),
      lastTemp !== null && h('span', { class: 'sys-key-temp' }, `Temp ${temp(lastTemp, unit)}`),
      h('span', { class: 'sys-dim' }, 'last few minutes'),
    ),
    chart,
  );
}

function cores(list: number[]) {
  return h(
    'div',
    { class: 'sys-cores' },
    ...list.map((pct, i) =>
      meter({ label: `Core ${i + 1}`, pct, value: `${Math.round(pct)}%`, detail: '', level: level(pct) }),
    ),
  );
}
