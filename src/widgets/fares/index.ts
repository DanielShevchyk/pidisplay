import { h } from '../../core/dom';
import { openSheet } from '../../core/sheet';
import { defineWidget, type Placement } from '../../core/types';
import './fares.css';

interface FaresConfig {
  /** Destination code to feature on small tiles; blank = best current deal. */
  featured: string;
  showUnverified: boolean;
  [key: string]: unknown;
}

/** Mirrors farewatcher.json, written by fare_watch.py and served by GET /api/fares. */
/** The same trip from another home airport (e.g. SMF for an SFO deal). */
interface Alternate {
  origin: string;
  price: number;
  departDate: string | null;
  returnDate: string | null;
  stops: number | null;
  airline: string | null;
  /** False when no fare matched the exact dates and a nearby one (±3 days) was used. */
  sameDates: boolean;
  verified?: boolean;
  livePrice?: number | null;
}

interface Low {
  price: number;
  origin: string | null;
  departDate: string | null;
  returnDate: string | null;
  stops: number | null;
  airline: string | null;
  verified: boolean;
  livePrice: number | null;
  link: string | null;
  alternates?: Alternate[];
}

interface Destination {
  code: string;
  name: string | null;
  target: number | null;
  median30: number | null;
  currentLow: Low | null;
  history: { date: string; low: number }[];
  monthly: { month: string; low: number | null }[];
}

interface Deal {
  id: string | number;
  code: string;
  name: string | null;
  origin: string | null;
  price: number;
  target: number | null;
  median30: number | null;
  departDate: string | null;
  returnDate: string | null;
  verified: boolean;
  livePrice: number | null;
  stops: number | null;
  bags: string | null;
  weather: { summary: string | null; highF: number | null; lowF: number | null } | null;
  link: string | null;
  foundAt: string | null;
  event: string | null;
  alternates?: Alternate[];
}

interface Summary {
  available: true;
  generatedAt: string;
  currency: string;
  lastRun: {
    startedAt: string | null;
    finishedAt: string | null;
    /** Null until the first run of the version that records runs. */
    ok: boolean | null;
    error: string | null;
    faresFetched: number | null;
    dealsFound: number | null;
    serpapiUsedThisMonth: number | null;
    serpapiBudget: number | null;
  } | null;
  destinations: Destination[];
  deals: Deal[];
  recentAlerts: { sentAt: string; title: string; body: string }[];
}

type Response = Summary | { available: false };

const REFRESH_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;

/** Destination rows shown per tile size. */
const ROWS: Record<Placement, number> = { bar: 0, small: 0, medium: 3, tall: 6, large: 5, xlarge: 6, full: 10 };

export default defineWidget<FaresConfig>({
  type: 'fares',
  name: 'Fares',
  description: 'Flight deals from Farewatcher',
  icon: '✈️',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'medium',
  defaultConfig: { featured: '', showUnverified: true },
  settings: [
    { key: 'featured', label: 'Featured destination code (blank = best deal)', type: 'text', placeholder: 'e.g. LIS' },
    { key: 'showUnverified', label: 'Show deals not confirmed on Google Flights', type: 'boolean' },
  ],

  mount(el, { config, placement, sharedStorage, on }) {
    const root = h('div', { class: `fares size-${placement}` });
    el.append(root);
    let data: Response | null = null;
    let failed = '';
    let timer = 0;
    let alive = true;

    const paint = () => {
      if (!data) {
        root.replaceChildren(message(failed ? '⚠️' : '✈️', failed || 'Loading…'));
        return;
      }
      if (!data.available) {
        root.replaceChildren(message('✈️', 'Waiting for the first Farewatcher run'));
        return;
      }
      root.replaceChildren(render(data, config, placement, failed));
    };

    const refresh = async () => {
      clearTimeout(timer);
      let next = REFRESH_MS;
      try {
        const res = await fetch('/api/fares');
        if (!res.ok) throw new Error(`Fares failed (${res.status})`);
        const body = (await res.json()) as Response;
        if (!alive) return;
        data = body;
        failed = '';
        sharedStorage.save(body).catch(() => {});
      } catch (err) {
        if (!alive) return;
        failed = err instanceof Error ? err.message : String(err);
        next = RETRY_MS;
      }
      paint();
      timer = window.setTimeout(refresh, next);
    };

    // Show the last summary right away (e.g. after a reboot), then refresh.
    sharedStorage
      .load<Response | null>(null)
      .catch(() => null)
      .then((cached) => {
        if (!alive) return;
        if (cached && !data) data = cached;
        paint();
        refresh();
      });

    // Farewatcher posts a notification at the end of a run that found deals.
    on('notification', (n: { source?: string }) => {
      if (n?.source === 'Farewatcher') refresh();
    });

    return {
      destroy() {
        alive = false;
        clearTimeout(timer);
      },
    };
  },
});

// ---- Rendering ----------------------------------------------------------

function render(d: Summary, config: FaresConfig, placement: Placement, failed: string) {
  const money = moneyFormat(d.currency);
  const deals = d.deals.filter((x) => config.showUnverified || x.verified);
  const featured = config.featured.trim().toUpperCase();
  const footer = status(d, failed);

  if (placement === 'small') {
    const deal = (featured && deals.find((x) => x.code.toUpperCase() === featured)) || (!featured && deals[0]);
    if (deal) return h('div', { class: 'fares-body' }, dealHero(deal, money, d, true), footer);
    const dest = (featured && d.destinations.find((x) => x.code.toUpperCase() === featured)) || cheapestVsTarget(d.destinations);
    return h(
      'div',
      { class: 'fares-body' },
      dest ? destHero(dest, money, d) : message('✈️', 'No destinations yet'),
      footer,
    );
  }

  const sections: (HTMLElement | null)[] = [];
  const showHero = placement !== 'medium' && placement !== 'tall';
  if (showHero) {
    sections.push(
      deals[0]
        ? dealHero(deals[0], money, d, false)
        : h('div', { class: 'fares-none' }, 'No deals right now. Watching ', String(d.destinations.length), ' destinations.'),
    );
  }

  const dealCodes = new Set(deals.map((x) => x.code));
  const rows = [...d.destinations]
    .sort((a, b) => Number(dealCodes.has(b.code)) - Number(dealCodes.has(a.code)) || ratio(a) - ratio(b))
    .slice(0, ROWS[placement]);
  sections.push(
    h(
      'div',
      { class: 'fares-list' },
      ...rows.map((dest) => destRow(dest, money, dealCodes.has(dest.code), () => openDetail(dest, d))),
    ),
  );
  sections.push(footer);
  return h('div', { class: 'fares-body' }, ...sections);
}

function dealHero(deal: Deal, money: (n: number) => string, d: Summary, compact: boolean) {
  const dest = d.destinations.find((x) => x.code === deal.code);
  const under = deal.target ? deal.target - best(deal) : null;
  return h(
    'button',
    { class: 'fares-hero', onclick: () => dest && openDetail(dest, d) },
    h('div', { class: 'fares-hero-top' }, h('span', { class: 'fares-place' }, place(deal.name, deal.code)), checkedAt(d)),
    h('div', { class: 'fares-price' }, money(best(deal))),
    h(
      'div',
      { class: 'fares-meta' },
      [deal.origin, dateRange(deal.departDate, deal.returnDate)].filter(Boolean).join(' · '),
    ),
    !compact && deal.event && h('div', { class: 'fares-meta' }, `🎟 ${deal.event}`),
    under !== null && under > 0 && h('div', { class: 'fares-under' }, `${money(under)} under target`),
    ...alternates(deal, money, compact),
  );
}

function destHero(dest: Destination, money: (n: number) => string, d: Summary) {
  const low = dest.currentLow;
  return h(
    'button',
    { class: 'fares-hero', onclick: () => openDetail(dest, d) },
    h('div', { class: 'fares-hero-top' }, h('span', { class: 'fares-place' }, place(dest.name, dest.code))),
    h('div', { class: 'fares-price dim' }, low ? money(best(low)) : '–'),
    h('div', { class: 'fares-meta' }, dest.target ? `Target ${money(dest.target)}` : 'No deals right now'),
  );
}

function destRow(dest: Destination, money: (n: number) => string, isDeal: boolean, open: () => void) {
  const low = dest.currentLow ? best(dest.currentLow) : null;
  return h(
    'button',
    { class: `fares-row${isDeal ? ' deal' : ''}`, onclick: open },
    h('span', { class: 'fares-row-name' }, place(dest.name, dest.code)),
    sparkline(dest.history.slice(-30).map((x) => x.low), dest.target),
    h(
      'span',
      { class: 'fares-row-price' },
      low === null ? '–' : money(low),
      dest.target && h('span', { class: 'fares-row-target' }, ` / ${money(dest.target)}`),
    ),
  );
}

function openDetail(dest: Destination, d: Summary) {
  const money = moneyFormat(d.currency);
  const low = dest.currentLow;
  const deals = d.deals.filter((x) => x.code === dest.code);
  const item = (label: string, value: string | null) =>
    value && h('div', { class: 'fares-detail' }, h('span', { class: 'fares-detail-label' }, label), value);

  const content: (HTMLElement | false | null)[] = [
    h(
      'div',
      { class: 'fares-sheet-summary' },
      item('Cheapest now', low ? money(low.price) : null),
      item('Live on Google', low?.livePrice != null ? money(low.livePrice) : null),
      item('Target', dest.target ? money(dest.target) : null),
      item('30-day median', dest.median30 ? money(dest.median30) : null),
    ),
    low &&
      h(
        'div',
        { class: 'fares-meta' },
        [low.origin, dateRange(low.departDate, low.returnDate), stops(low.stops), low.airline].filter(Boolean).join(' · '),
      ),
  ];

  if (dest.history.length > 1) {
    content.push(h('h3', {}, 'Price history'), historyChart(dest.history, dest.target, money));
  }
  const months = dest.monthly.filter((m): m is { month: string; low: number } => m.low !== null);
  if (months.length) {
    const max = Math.max(...months.map((m) => m.low));
    content.push(
      h('h3', {}, 'Cheapest by month'),
      h(
        'div',
        { class: 'fares-months' },
        ...months.map((m) =>
          h(
            'div',
            { class: `fares-month${dest.target && m.low <= dest.target ? ' deal' : ''}` },
            h('div', { class: 'fares-month-bar', style: `height:${Math.max(8, (m.low / max) * 100)}%` }),
            h('div', { class: 'fares-month-price' }, money(m.low)),
            h('div', { class: 'fares-month-label' }, monthLabel(m.month)),
          ),
        ),
      ),
    );
  }
  if (deals.length) {
    content.push(
      h('h3', {}, 'Deals'),
      ...deals.map((x) =>
        h(
          'div',
          { class: 'fares-deal' },
          h('div', { class: 'fares-deal-top' }, h('strong', {}, money(best(x))), badge(x.verified)),
          h(
            'div',
            { class: 'fares-meta' },
            [x.origin, dateRange(x.departDate, x.returnDate), stops(x.stops), x.bags].filter(Boolean).join(' · '),
          ),
          ...alternates(x, money),
          x.event && h('div', { class: 'fares-meta' }, `🎟 ${x.event}`),
          x.weather &&
            h(
              'div',
              { class: 'fares-meta' },
              `Typical weather: ${[x.weather.summary, temps(x.weather.highF, x.weather.lowF)].filter(Boolean).join(', ')}`,
            ),
        ),
      ),
    );
  }
  content.push(status(d, ''));
  openSheet(`✈️ ${place(dest.name, dest.code)}`, content.filter(Boolean) as HTMLElement[]);
}

function status(d: Summary, failed: string) {
  const run = d.lastRun;
  const when = run?.finishedAt ?? d.generatedAt;
  const bad = failed || (run?.ok === false ? `Last run failed${run.error ? `: ${run.error}` : ''}` : '');
  return h('div', { class: `fares-status${bad ? ' bad' : ''}` }, bad || `Checked ${ago(when)}`);
}

/** When Farewatcher last pulled fares, e.g. "Oct 2, 8:01 AM". */
function checkedAt(d: Summary) {
  const iso = d.lastRun?.finishedAt ?? d.generatedAt;
  const when = iso ? new Date(iso) : null;
  const text =
    when && !Number.isNaN(when.getTime())
      ? when.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : '–';
  return h('span', { class: 'fares-checked', title: 'Last fare check' }, text);
}

/** The other home airport's price: "SMF $612 (+$45) · same dates"; dates dropped when compact. */
function alternates(
  x: { price: number; livePrice: number | null; alternates?: Alternate[] },
  money: (n: number) => string,
  compact = false,
) {
  // Dan's two home airports: an SFO deal shows SMF, an SMF deal shows SFO (OAK/SJC are skipped).
  const alt = ['SMF', 'SFO'].map((o) => x.alternates?.find((a) => a.origin === o)).find(Boolean);
  return (alt ? [alt] : []).map((a) => {
    const diff = best(a) - best(x);
    const sign = diff > 0 ? `+${money(diff)}` : diff < 0 ? `−${money(-diff)}` : 'same price';
    return h(
      'div',
      { class: `fares-alt${diff < 0 ? ' cheaper' : ''}` },
      h('span', { class: 'fares-alt-origin' }, a.origin),
      ` ${money(best(a))} (${sign})`,
      !compact && ` · ${a.sameDates ? 'same dates' : dateRange(a.departDate, a.returnDate)}`,
    );
  });
}

function badge(verified: boolean) {
  return h('span', { class: `fares-badge${verified ? ' live' : ''}` }, verified ? 'Live ✓' : 'Unverified');
}

function message(icon: string, text: string) {
  return h('div', { class: 'fares-message' }, h('div', { class: 'fares-message-icon' }, icon), text);
}

// ---- Charts ---------------------------------------------------------------

const SVG = 'http://www.w3.org/2000/svg';

function svg(tag: string, attrs: Record<string, string | number>) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function sparkline(values: number[], target: number | null) {
  const box = h('span', { class: 'fares-spark' });
  if (values.length < 2) return box;
  const w = 100;
  const hgt = 30;
  const lo = Math.min(...values, target ?? Infinity);
  const hi = Math.max(...values);
  const y = (v: number) => (hi === lo ? hgt / 2 : 2 + (1 - (v - lo) / (hi - lo)) * (hgt - 4));
  const x = (i: number) => (i / (values.length - 1)) * w;
  const s = svg('svg', { viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'none' });
  if (target && target >= lo && target <= hi) {
    s.append(svg('line', { x1: 0, x2: w, y1: y(target), y2: y(target), class: 'fares-target-line' }));
  }
  s.append(svg('polyline', { points: values.map((v, i) => `${x(i)},${y(v)}`).join(' '), class: 'fares-spark-line' }));
  box.append(s);
  return box;
}

function historyChart(history: { date: string; low: number }[], target: number | null, money: (n: number) => string) {
  const w = 600;
  const hgt = 200;
  const pad = { l: 64, r: 8, t: 10, b: 24 };
  const values = history.map((x) => x.low);
  const lo = Math.min(...values, target ?? Infinity) * 0.95;
  const hi = Math.max(...values, target ?? -Infinity) * 1.05;
  const x = (i: number) => pad.l + (i / (history.length - 1)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (hgt - pad.t - pad.b);
  const s = svg('svg', { viewBox: `0 0 ${w} ${hgt}`, class: 'fares-chart' });
  for (const v of [hi / 1.05, (hi / 1.05 + lo / 0.95) / 2, lo / 0.95]) {
    s.append(svg('line', { x1: pad.l, x2: w - pad.r, y1: y(v), y2: y(v), class: 'fares-grid' }));
    const label = svg('text', { x: pad.l - 8, y: y(v) + 5, 'text-anchor': 'end', class: 'fares-axis' });
    label.textContent = money(v);
    s.append(label);
  }
  if (target) {
    s.append(svg('line', { x1: pad.l, x2: w - pad.r, y1: y(target), y2: y(target), class: 'fares-target-line' }));
  }
  s.append(svg('polyline', { points: values.map((v, i) => `${x(i)},${y(v)}`).join(' '), class: 'fares-chart-line' }));
  for (const [i, anchor] of [[0, 'start'], [history.length - 1, 'end']] as const) {
    const label = svg('text', { x: x(i), y: hgt - 4, 'text-anchor': anchor, class: 'fares-axis' });
    label.textContent = shortDate(history[i].date);
    s.append(label);
  }
  return s as unknown as HTMLElement;
}

// ---- Formatting -----------------------------------------------------------

function moneyFormat(currency: string) {
  let fmt: Intl.NumberFormat;
  try {
    fmt = new Intl.NumberFormat([], { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 });
  } catch {
    fmt = new Intl.NumberFormat([], { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  }
  return (n: number) => fmt.format(n);
}

/** The price to show: Google's live price when it was checked, else the cached fare. */
function best(x: { price: number; livePrice?: number | null }) {
  return x.livePrice ?? x.price;
}

/** "Tokyo, Japan" + "TYO" -> "Tokyo (TYO)". */
function place(name: string | null, code: string) {
  const city = name?.split(',')[0].trim();
  return city ? `${city} (${code})` : code;
}

/** Lower is better: how the current low compares with the target. */
function ratio(d: Destination) {
  if (!d.currentLow) return Infinity;
  return d.target ? best(d.currentLow) / d.target : 10 + best(d.currentLow);
}

function cheapestVsTarget(list: Destination[]) {
  return [...list].sort((a, b) => ratio(a) - ratio(b))[0];
}

/** Parses YYYY-MM-DD as a local date so it doesn't shift a day in US timezones. */
function parseDay(s: string) {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function shortDate(s: string) {
  return parseDay(s).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function dateRange(depart: string | null, ret: string | null) {
  if (!depart) return '';
  return ret ? `${shortDate(depart)} – ${shortDate(ret)}` : `${shortDate(depart)}, one way`;
}

function monthLabel(s: string) {
  return parseDay(`${s}-01`).toLocaleDateString([], { month: 'short' });
}

function stops(n: number | null) {
  if (n === null || n === undefined) return '';
  return n === 0 ? 'Nonstop' : `${n} stop${n > 1 ? 's' : ''}`;
}

function temps(hi: number | null, lo: number | null) {
  if (hi === null && lo === null) return '';
  return `${hi ?? '–'}° / ${lo ?? '–'}°F`;
}

function ago(iso: string | null) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (Number.isNaN(mins)) return 'unknown';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
