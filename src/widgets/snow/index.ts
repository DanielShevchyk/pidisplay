import { call } from '../../core/api';
import { h } from '../../core/dom';
import { placePicker, type Places } from '../../core/place-picker';
import { openSheet } from '../../core/sheet';
import { defineWidget, type Placement, type WidgetStorage } from '../../core/types';
import './snow.css';

interface SnowConfig {
  units: 'imperial' | 'metric';
  /** One resort id for this tile; blank = the shared resort list. */
  resort: string;
  [key: string]: unknown;
}

/** Mirrors GET /api/snow (server/snow.js). Snow in inches or cm, elevations in ft or m. */
interface Day {
  date: string;
  snowTop: number | null;
  snowBase: number | null;
  rainBase: number | null;
  hi: number | null;
  lo: number | null;
  code: number | null;
  pop: number | null;
  wind: number | null;
}

interface Resort {
  id: string;
  name: string;
  area: string;
  base: number;
  summit: number;
  now?: { temp: number | null; baseTemp: number | null; code: number | null; wind: number | null; gust: number | null; snowing: boolean };
  past24?: number | null;
  past72?: number | null;
  past7d?: number | null;
  next24?: number | null;
  next72?: number | null;
  next24Base?: number | null;
  next72Base?: number | null;
  next7d?: number | null;
  next7dBase?: number | null;
  days?: Day[];
  pastDays?: { date: string; snowTop: number | null }[];
  forecastError?: string;
  stale?: boolean;
  station: { name: string; elevation: number; distance: number; depth: number | null; change24: number | null; change7: number | null; swe: number | null; date: string | null } | null;
  lifts: { open: number; hold: number; scheduled: number; closed: number; total: number } | null;
  alerts: { event: string; headline: string; severity: string; ends: string | null; description: string }[];
}

interface Report {
  units: 'imperial' | 'metric';
  updated: number;
  resorts: Resort[];
}

interface Shared {
  resorts: string[];
}

const DEFAULT_RESORTS = ['heavenly', 'northstar', 'kirkwood'];
const REFRESH_MS = 15 * 60 * 1000;
const RETRY_MS = 60 * 1000;

let catalogCache: Promise<Places> | null = null;
/** Resort picker suggestions from GET /api/snow/resorts. */
function catalog(): Promise<Places> {
  catalogCache ??= call<{ id: string; name: string; area: string }[]>('GET', '/api/snow/resorts')
    .then((list) => Object.fromEntries(list.map((r) => [r.id, { name: `${r.name} · ${r.area}`, tag: '🏔️' }])))
    .catch((err) => {
      catalogCache = null;
      throw err;
    });
  return catalogCache;
}

export default defineWidget<SnowConfig>({
  type: 'snow',
  name: 'Snow report',
  description: 'New and forecast snow at your Sierra ski resorts',
  icon: '❄️',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'large',
  supportsBar: true,
  defaultConfig: { units: 'imperial', resort: '' },
  settings: [
    {
      key: 'units',
      label: 'Units',
      type: 'select',
      options: [
        { value: 'imperial', label: 'Inches, feet, °F' },
        { value: 'metric', label: 'Centimeters, meters, °C' },
      ],
    },
    {
      key: 'resort',
      label: 'Only this resort (blank = your resort list)',
      type: 'place',
      placeholder: 'Resort name',
      places: catalog,
    },
  ],

  mount(el, { config, placement, storage, sharedStorage }) {
    const root = h('div', { class: `snow size-${placement}` });
    el.append(root);
    let list: string[] = DEFAULT_RESORTS;
    let report: Report | null = null;
    let failed = '';
    let alive = true;
    let timer = 0;
    const ids = () => (config.resort ? [config.resort] : list);
    const query = () => `${ids().join(',')}|${config.units}`;

    const paint = () => {
      if (!ids().length) {
        root.replaceChildren(
          placement === 'bar' ? '' : message('🏔️', 'No resorts yet', h('button', { class: 'btn', onclick: edit }, 'Add resorts')),
        );
        return;
      }
      if (!report) {
        root.replaceChildren(placement === 'bar' ? '' : message(failed ? '⚠️' : '❄️', failed || 'Loading snow report…'));
        return;
      }
      const u = unitsOf(report);
      const resorts = report.resorts;
      const editor = config.resort ? null : edit;
      switch (placement) {
        case 'bar':
          return root.replaceChildren(renderBar(resorts, u));
        case 'small':
          return root.replaceChildren(renderSmall(resorts, u));
        case 'medium':
          return root.replaceChildren(renderRows(resorts, u, report, editor));
        default:
          return root.replaceChildren(renderCards(resorts, u, report, placement, editor));
      }
    };

    const refresh = async () => {
      clearTimeout(timer);
      if (!ids().length) return paint();
      const q = query();
      let next = REFRESH_MS;
      try {
        const params = new URLSearchParams({ resorts: ids().join(','), units: config.units });
        const data = await call<Report>('GET', `/api/snow?${params}`);
        if (!alive || q !== query()) return;
        report = data;
        failed = '';
        if (data.resorts.every((r) => r.forecastError)) next = RETRY_MS;
        storage.save({ query: q, report: data }).catch(() => {});
      } catch (err) {
        if (!alive || q !== query()) return;
        failed = err instanceof Error ? err.message : String(err);
        next = RETRY_MS;
      }
      paint();
      timer = window.setTimeout(refresh, next);
    };

    const loadList = async () => {
      const shared = await sharedStorage.load<Shared | null>(null).catch(() => null);
      list = Array.isArray(shared?.resorts) ? shared.resorts : DEFAULT_RESORTS;
    };

    const listChanged = async () => {
      await loadList();
      if (!alive || config.resort) return;
      report = null;
      paint();
      refresh();
    };
    sharedStorage.onChange(listChanged);
    const edit = () => editResorts(sharedStorage, list, listChanged);

    // Show the last report right away (e.g. after a reboot), then refresh.
    Promise.all([loadList(), storage.load<{ query: string; report: Report } | null>(null).catch(() => null)]).then(([, cached]) => {
      if (!alive) return;
      if (cached?.query === query()) report = cached.report;
      paint();
      refresh();
    });

    return {
      destroy() {
        alive = false;
        clearTimeout(timer);
      },
    };
  },
});

// ---- Formatting ----

interface Units {
  snow: (v: number | null | undefined) => string;
  temp: (v: number | null | undefined) => string;
  elev: (v: number) => string;
  dist: string;
  speed: string;
  /** Snow that counts as a powder day: 6 in / 15 cm. */
  powder: number;
  /** Smallest top of the bar chart scale. */
  scale: number;
}

function unitsOf(report: Report): Units {
  const metric = report.units === 'metric';
  const snow = (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return '–';
    const n = v > 0 && v < 1 ? v.toFixed(1).replace(/^0/, '') : String(Math.round(v));
    return metric ? `${n} cm` : `${n}″`;
  };
  return {
    snow,
    temp: (v) => (v == null ? '–' : `${Math.round(v)}°`),
    elev: (v) => (metric ? `${v.toLocaleString()} m` : `${v.toLocaleString()} ft`),
    dist: metric ? 'km' : 'mi',
    speed: metric ? 'km/h' : 'mph',
    powder: metric ? 15 : 6,
    scale: metric ? 15 : 6,
  };
}

function icon(code: number | null | undefined): string {
  if (code == null) return '';
  if (code === 0 || code === 1) return '☀️';
  if (code === 2) return '⛅';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '🌨️';
  if (code >= 95) return '⛈️';
  if (code >= 51) return '🌧️';
  return '☁️';
}

function weekday(date: string, i: number): string {
  if (i === 0) return 'Today';
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' });
}

function ago(ms: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function message(iconText: string, text: string, action?: Node) {
  return h('div', { class: 'snow-message' }, h('div', { class: 'snow-message-icon' }, iconText), h('div', {}, text), action);
}

/** The resort with the most snow coming in the next three days, then the most recent. */
function best(resorts: Resort[]): Resort {
  return [...resorts].sort((a, b) => (b.next72 ?? -1) - (a.next72 ?? -1) || (b.past24 ?? -1) - (a.past24 ?? -1))[0];
}

function isPowder(r: Resort, u: Units) {
  return (r.next24 ?? 0) >= u.powder || (r.past24 ?? 0) >= u.powder || (r.station?.change24 ?? 0) >= u.powder;
}

/** Measured new snow (station depth change) when it's positive, else the model's last 24 hours. */
function newSnow(r: Resort): number | null | undefined {
  const measured = r.station?.change24;
  return measured != null && measured > 0 ? Math.max(measured, r.past24 ?? 0) : r.past24;
}

// ---- Views ----

function renderBar(resorts: Resort[], u: Units) {
  const r = best(resorts);
  const coming = (r.next72 ?? 0) > 0;
  return h(
    'button',
    { class: 'snow-bar', onclick: () => openResort(r, u) },
    h('span', {}, '❄️'),
    coming
      ? h('span', {}, h('strong', {}, u.snow(r.next72)), ` ${r.name} next 3 days`)
      : h('span', { class: 'snow-dim' }, 'No snow next 3 days'),
  );
}

function renderSmall(resorts: Resort[], u: Units) {
  if (resorts.length === 1) {
    const r = resorts[0];
    return h(
      'button',
      { class: 'snow-small-one', onclick: () => openResort(r, u) },
      h('div', { class: 'snow-label' }, `❄️ ${r.name}`),
      h('div', { class: 'snow-big' }, u.snow(r.next72)),
      h('div', { class: 'snow-dim' }, 'next 3 days'),
      h('div', { class: 'snow-dim' }, `${u.snow(newSnow(r))} last 24h`),
    );
  }
  return h(
    'div',
    { class: 'snow-small' },
    h('div', { class: 'snow-label' }, '❄️ Next 3 days'),
    ...resorts.slice(0, 5).map((r) =>
      h(
        'button',
        { class: 'snow-small-row', onclick: () => openResort(r, u) },
        h('span', { class: 'snow-name' }, r.name),
        h('strong', { class: (r.next72 ?? 0) > 0 ? 'snow-has' : 'snow-dim' }, u.snow(r.next72)),
      ),
    ),
  );
}

function footer(report: Report, edit: (() => void) | null) {
  const stale = report.resorts.some((r) => r.stale || r.forecastError);
  return h(
    'div',
    { class: 'snow-foot' },
    h('span', {}, `${stale ? '⚠ Some data offline · ' : ''}Updated ${ago(report.updated)}`),
    edit && h('button', { class: 'snow-edit', onclick: edit }, '✎ Resorts'),
  );
}

function renderRows(resorts: Resort[], u: Units, report: Report, edit: (() => void) | null) {
  return h(
    'div',
    { class: 'snow-rows-wrap' },
    h(
      'div',
      { class: 'snow-rows' },
      h('div', { class: 'snow-row snow-row-head' }, h('span', {}, '❄️ Snow'), h('span', {}, 'Last 24h'), h('span', {}, 'Next 3d'), h('span', {}, 'Depth')),
      ...resorts.map((r) =>
        h(
          'button',
          { class: 'snow-row', onclick: () => openResort(r, u) },
          h('span', { class: 'snow-name' }, isPowder(r, u) ? `${r.name} 🎉` : r.name),
          h('span', {}, u.snow(newSnow(r))),
          h('strong', { class: (r.next72 ?? 0) > 0 ? 'snow-has' : '' }, u.snow(r.next72)),
          h('span', {}, u.snow(r.station?.depth)),
        ),
      ),
    ),
    footer(report, edit),
  );
}

function renderCards(resorts: Resort[], u: Units, report: Report, placement: Placement, edit: (() => void) | null) {
  const days = placement === 'tall' ? 5 : 7;
  return h(
    'div',
    { class: 'snow-cards-wrap' },
    h('div', { class: `snow-cards n${Math.min(resorts.length, 4)}` }, ...resorts.map((r) => card(r, u, days, placement))),
    footer(report, edit),
  );
}

function card(r: Resort, u: Units, days: number, placement: Placement) {
  const alert = r.alerts[0];
  return h(
    'button',
    { class: `snow-card${isPowder(r, u) ? ' powder' : ''}`, onclick: () => openResort(r, u) },
    h(
      'div',
      { class: 'snow-card-head' },
      h('div', { class: 'snow-card-name' }, r.name, placement !== 'tall' && h('span', { class: 'snow-dim snow-area' }, r.area)),
      r.now && h('div', { class: 'snow-now' }, `${icon(r.now.code)} ${u.temp(r.now.temp)}`),
    ),
    alert && h('div', { class: 'snow-alert' }, `⚠ ${alert.event}`),
    h(
      'div',
      { class: 'snow-stats' },
      stat('New 24h', u.snow(newSnow(r))),
      stat('Next 3 days', u.snow(r.next72), (r.next72 ?? 0) > 0),
      placement !== 'tall' && stat('Next 7 days', u.snow(r.next7d)),
      stat('Base depth', u.snow(r.station?.depth)),
    ),
    r.days?.length ? bars(r.days.slice(0, days), u) : h('div', { class: 'snow-dim' }, r.forecastError ?? 'No forecast'),
    h('div', { class: 'snow-card-foot snow-dim' }, liftsText(r, u)),
  );
}

function stat(label: string, value: string, hot = false) {
  return h('div', { class: 'snow-stat' }, h('div', { class: `snow-stat-value${hot ? ' snow-has' : ''}` }, value), h('div', { class: 'snow-stat-label' }, label));
}

function liftsText(r: Resort, u: Units): string {
  if (!r.lifts) return `⛰️ ${u.elev(r.base)} to ${u.elev(r.summit)}`;
  if (!r.lifts.open && !r.lifts.hold) return `🚡 Lifts closed`;
  return `🚡 ${r.lifts.open} of ${r.lifts.total} lifts open${r.lifts.hold ? ` · ${r.lifts.hold} on hold` : ''}`;
}

/** Daily summit snowfall as bars, base snowfall as the darker inner part. */
function bars(days: Day[], u: Units) {
  const max = Math.max(u.scale, ...days.map((d) => d.snowTop ?? 0));
  return h(
    'div',
    { class: 'snow-bars' },
    ...days.map((d, i) => {
      const top = d.snowTop ?? 0;
      const base = Math.min(top, d.snowBase ?? 0);
      return h(
        'div',
        { class: 'snow-bar-col' },
        h('div', { class: 'snow-bar-val' }, top > 0 ? u.snow(top).replace(' cm', '') : ''),
        h(
          'div',
          { class: 'snow-bar-track' },
          h(
            'div',
            { class: 'snow-bar-fill', style: `height:${(top / max) * 100}%` },
            base > 0 && h('div', { class: 'snow-bar-base', style: `height:${(base / top) * 100}%` }),
          ),
        ),
        h('div', { class: 'snow-bar-day' }, weekday(d.date, i)),
      );
    }),
  );
}

// ---- Sheets ----

function openResort(r: Resort, u: Units) {
  const st = r.station;
  openSheet(`❄️ ${r.name}`, [
    h(
      'div',
      { class: 'snow-detail' },
      h('div', { class: 'snow-dim' }, `${r.area} · base ${u.elev(r.base)}, summit ${u.elev(r.summit)}`),
      ...r.alerts.map((a) =>
        h(
          'details',
          { class: 'snow-alert-detail' },
          h('summary', {}, `⚠ ${a.event}${a.ends ? ` until ${new Date(a.ends).toLocaleString(undefined, { weekday: 'short', hour: 'numeric' })}` : ''}`),
          h('div', { class: 'snow-alert-text' }, a.description || a.headline),
        ),
      ),
      h(
        'div',
        { class: 'snow-stats' },
        stat('Last 24h', u.snow(r.past24)),
        stat('Last 3 days', u.snow(r.past72)),
        stat('Next 24h', u.snow(r.next24), (r.next24 ?? 0) > 0),
        stat('Next 3 days', u.snow(r.next72), (r.next72 ?? 0) > 0),
        stat('Next 7 days', u.snow(r.next7d)),
      ),
      r.now &&
        h(
          'div',
          { class: 'snow-dim' },
          `Now: ${icon(r.now.code)} ${u.temp(r.now.temp)} at the summit, ${u.temp(r.now.baseTemp)} at the base` +
            (r.now.gust != null ? `, gusts ${Math.round(r.now.gust)} ${u.speed}` : ''),
        ),
      h('h3', {}, 'Snow by day (summit / base)'),
      r.days?.length
        ? h(
            'div',
            { class: 'snow-days' },
            ...r.days.map((d, i) =>
              h(
                'div',
                { class: 'snow-day' },
                h('span', { class: 'snow-day-name' }, weekday(d.date, i)),
                h('span', {}, icon(d.code)),
                h('strong', { class: (d.snowTop ?? 0) > 0 ? 'snow-has' : 'snow-dim' }, u.snow(d.snowTop)),
                h('span', { class: 'snow-dim' }, (d.rainBase ?? 0) > 0.05 && (d.snowBase ?? 0) < (d.snowTop ?? 0) / 2 ? `${u.snow(d.snowBase)} · rain` : u.snow(d.snowBase)),
                h('span', {}, `${u.temp(d.hi)} / ${u.temp(d.lo)}`),
                h('span', { class: 'snow-dim' }, d.pop != null ? `${d.pop}%` : ''),
              ),
            ),
          )
        : h('div', { class: 'empty' }, r.forecastError ?? 'No forecast'),
      h('h3', {}, 'Measured snow'),
      st
        ? h(
            'div',
            { class: 'snow-dim' },
            h('div', {}, `${u.snow(st.depth)} on the ground` + (st.change24 != null ? ` (${st.change24 >= 0 ? '+' : ''}${u.snow(st.change24)} in a day)` : '') + (st.swe != null ? `, ${u.snow(st.swe)} of water` : '')),
            h('div', {}, `SNOTEL ${st.name}, ${u.elev(st.elevation)}, ${st.distance} ${u.dist} away${st.date ? `, reading of ${st.date}` : ''}`),
          )
        : h('div', { class: 'snow-dim' }, 'No snow station near this resort; numbers above are the forecast model.'),
      h('h3', {}, 'Lifts'),
      h('div', { class: 'snow-dim' }, r.lifts ? liftsText(r, u) : 'Lift status not available'),
      h('div', { class: 'snow-source' }, 'Forecast Open-Meteo · snow depth NRCS SNOTEL · lifts Liftie · alerts National Weather Service'),
    ),
  ]);
}

/** The shared resort list: reorder, remove, and add with suggestions while typing. */
function editResorts(shared: WidgetStorage, initial: string[], onSaved: () => void) {
  let list = [...initial];
  // save() tells other tiles; this one is told through onSaved.
  const save = () => shared.save({ resorts: list } satisfies Shared).then(onSaved, () => {});
  const body = h('div', { class: 'snow-edit-sheet' });
  const sheet = openSheet('Ski resorts', [body]);
  const draw = async () => {
    const places = await catalog().catch(() => ({}) as Places);
    const name = (id: string) => places[id]?.name ?? id;
    const picker = placePicker({
      placeholder: 'Type a name, like Sugar Bowl or Tahoe',
      places,
      rawCode: false,
      exclude: (id) => list.includes(id),
      emptyText: 'No match. Try a resort name or area, like Tahoe or Mammoth.',
      onPick: (id) => {
        list = [...list, id];
        save();
        draw().then(() => (body.querySelector('.picker-input') as HTMLInputElement | null)?.focus());
      },
    });
    body.replaceChildren(
      h('label', { class: 'field field-place' }, h('span', {}, 'Add a resort'), picker),
      list.length
        ? h(
            'div',
            { class: 'snow-edit-list' },
            ...list.map((id, i) =>
              h(
                'div',
                { class: 'snow-edit-row' },
                h('span', { class: 'snow-name' }, name(id)),
                h('button', {
                  class: 'btn btn-ghost',
                  'aria-label': 'Move up',
                  disabled: i === 0,
                  onclick: () => {
                    list.splice(i - 1, 0, list.splice(i, 1)[0]);
                    save();
                    draw();
                  },
                }, '↑'),
                h('button', {
                  class: 'btn btn-ghost',
                  'aria-label': 'Remove',
                  onclick: () => {
                    list = list.filter((x) => x !== id);
                    save();
                    draw();
                  },
                }, '✕'),
              ),
            ),
          )
        : h('div', { class: 'empty' }, 'No resorts. Add one above.'),
      h('button', { class: 'btn btn-wide', onclick: () => sheet.close() }, 'Done'),
    );
  };
  draw();
}
