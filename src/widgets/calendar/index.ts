import { h } from '../../core/dom';
import { openSheet } from '../../core/sheet';
import { defineWidget, type Placement } from '../../core/types';
import './calendar.css';

type View = 'auto' | 'agenda' | 'week' | 'month';

interface CalendarConfig {
  view: View;
  /** Comma-separated calendar names to show; blank = all. */
  calendars: string;
  /** How far ahead the agenda looks. */
  days: number;
  weekStart: 'sunday' | 'monday';
  [key: string]: unknown;
}

/** Mirrors GET /api/calendar (server/calendar.js). */
interface CalendarInfo {
  id: string;
  name: string;
  color: string;
  updated: number | null;
  error: string | null;
}

interface CalEvent {
  id: string;
  calendar: string;
  title: string;
  location: string;
  description: string;
  allDay: boolean;
  /** 'YYYY-MM-DD' for all-day events (end exclusive), else epoch ms. */
  start: string | number;
  end: string | number;
}

interface Payload {
  configured: boolean;
  calendars: CalendarInfo[];
  events: CalEvent[];
}

interface TileState {
  hidden: string[];
}

interface Cached {
  key: string;
  data: Payload;
}

const REFRESH_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;
/** Week and month views snap back to the current period after this long untouched. */
const SNAP_BACK_MS = 2 * 60 * 1000;
const MONTH_CHIPS: Partial<Record<Placement, number>> = { full: 4, xlarge: 2, large: 1 };

function autoView(placement: Placement): 'next' | 'agenda' | 'week' | 'month' {
  if (placement === 'bar' || placement === 'small') return 'next';
  if (placement === 'xlarge') return 'week';
  if (placement === 'full') return 'month';
  return 'agenda';
}

export default defineWidget<CalendarConfig>({
  type: 'calendar',
  name: 'Calendar',
  description: 'Google (or any iCal) calendars for everyone in the house',
  icon: '📅',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'large',
  supportsBar: true,
  defaultConfig: { view: 'auto', calendars: '', days: 14, weekStart: 'sunday' },
  settings: [
    {
      key: 'view',
      label: 'View',
      type: 'select',
      options: [
        { value: 'auto', label: 'Fit to tile size' },
        { value: 'agenda', label: 'Agenda (list)' },
        { value: 'week', label: 'Week' },
        { value: 'month', label: 'Month' },
      ],
    },
    { key: 'calendars', label: 'Only these calendars (blank = all)', type: 'text', placeholder: 'e.g. Dan, Family' },
    { key: 'days', label: 'Agenda days ahead', type: 'number', min: 1, max: 60, step: 1 },
    {
      key: 'weekStart',
      label: 'Week starts on',
      type: 'select',
      options: [
        { value: 'sunday', label: 'Sunday' },
        { value: 'monday', label: 'Monday' },
      ],
    },
  ],

  mount(el, { config, placement, storage }) {
    const view = placement === 'bar' || placement === 'small' || config.view === 'auto' ? autoView(placement) : config.view;
    const root = h('div', { class: `cal size-${placement} view-${view}` });
    el.append(root);

    const only = config.calendars
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const weekStart = config.weekStart === 'monday' ? 1 : 0;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    let state: TileState = { hidden: [] };
    let data: Payload | null = null;
    let failed = '';
    let offset = 0; // weeks or months away from the current one
    let today = startOfDay(new Date());
    let timer = 0;
    let snapTimer = 0;
    let tick = 0;
    let alive = true;
    let seq = 0;

    const range = () => {
      if (view === 'week') {
        const from = addDays(startOfWeek(today, weekStart), offset * 7);
        return { from, to: addDays(from, 7) };
      }
      if (view === 'month') {
        const first = new Date(today.getFullYear(), today.getMonth() + offset, 1);
        const from = startOfWeek(first, weekStart);
        return { from, to: addDays(from, 42), first };
      }
      if (view === 'next') return { from: today, to: addDays(today, 8) };
      return { from: today, to: addDays(today, Math.min(60, Math.max(1, Math.round(config.days) || 14))) };
    };
    const cacheKey = () => {
      const r = range();
      return `${view}|${r.from.getTime()}|${r.to.getTime()}`;
    };

    const visibleCalendars = () =>
      (data?.calendars ?? []).filter((c) => !only.length || only.includes(c.name.toLowerCase()));
    const shownEvents = () => {
      const ids = new Set(visibleCalendars().filter((c) => !state.hidden.includes(c.id)).map((c) => c.id));
      return (data?.events ?? []).filter((e) => ids.has(e.calendar));
    };
    const colorOf = (id: string) => data?.calendars.find((c) => c.id === id)?.color ?? 'var(--accent)';

    const toggle = (id: string) => {
      state = { hidden: state.hidden.includes(id) ? state.hidden.filter((x) => x !== id) : [...state.hidden, id] };
      storage.save(state).catch(() => {});
      paint();
    };

    const navigate = (delta: number) => {
      offset = delta === 0 ? 0 : offset + delta;
      clearTimeout(snapTimer);
      if (offset !== 0) snapTimer = window.setTimeout(() => navigate(0), SNAP_BACK_MS);
      data = null;
      paint();
      refresh();
    };

    const paint = () => {
      if (!data) {
        root.replaceChildren(
          placement === 'bar' ? h('span', { class: 'cal-bar' }, '📅') : message(failed ? '⚠️' : '', failed || 'Loading…'),
        );
        return;
      }
      if (!data.configured) {
        root.replaceChildren(
          placement === 'bar'
            ? h('span', { class: 'cal-bar' }, '📅')
            : message('📅', 'No calendars yet. Add each calendar’s secret iCal address on the Pi (docs/CALENDAR.md).'),
        );
        return;
      }
      const events = shownEvents();
      const ctx: RenderCtx = { today, events, colorOf, calendars: visibleCalendars(), placement };
      const errors = ctx.calendars.map((c) => c.error).filter(Boolean) as string[];
      const warning = failed || errors.join('\n');
      if (view === 'next') {
        root.replaceChildren(placement === 'bar' ? renderBar(ctx) : renderNext(ctx, warning));
        return;
      }
      const r = range();
      let title: string;
      let body: HTMLElement;
      if (view === 'week') {
        title = weekTitle(r.from);
        body = renderWeek(ctx, r.from);
      } else if (view === 'month') {
        title = r.first!.toLocaleDateString([], { month: 'long', year: 'numeric' });
        body = renderMonth(ctx, r.from, r.first!);
      } else {
        title = today.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
        body = renderAgenda(ctx, r.from, r.to);
      }
      const legend =
        ctx.calendars.length > 1 && placement !== 'medium'
          ? h(
              'div',
              { class: 'cal-legend' },
              ...ctx.calendars.map((c) =>
                h(
                  'button',
                  {
                    class: `cal-chip${state.hidden.includes(c.id) ? ' off' : ''}`,
                    style: `--c: ${c.color}`,
                    title: c.error ?? '',
                    onclick: () => toggle(c.id),
                  },
                  c.name,
                  c.error && h('span', { class: 'cal-warn' }, ' ⚠'),
                ),
              ),
            )
          : null;
      const nav =
        view === 'agenda'
          ? null
          : h(
              'div',
              { class: 'cal-nav' },
              h('button', { class: 'cal-navbtn', onclick: () => navigate(-1), 'aria-label': 'Previous' }, '‹'),
              offset !== 0 && h('button', { class: 'cal-navbtn cal-today', onclick: () => navigate(0) }, 'Today'),
              h('button', { class: 'cal-navbtn', onclick: () => navigate(1), 'aria-label': 'Next' }, '›'),
            );
      root.replaceChildren(
        h(
          'div',
          { class: 'cal-body' },
          h(
            'div',
            { class: 'cal-head' },
            h('div', { class: 'cal-title' }, title, warning && h('span', { class: 'cal-warn', title: warning }, ' ⚠')),
            legend,
            nav,
          ),
          body,
        ),
      );
    };

    const refresh = async () => {
      clearTimeout(timer);
      const mine = ++seq;
      const key = cacheKey();
      const r = range();
      let next = REFRESH_MS;
      try {
        const params = new URLSearchParams({ from: String(r.from.getTime()), to: String(r.to.getTime()), tz: zone });
        const res = await fetch(`/api/calendar?${params}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `Calendar failed (${res.status})`);
        if (!alive || mine !== seq) return;
        data = body as Payload;
        failed = '';
        if (offset === 0) storage.save({ ...state, cache: { key, data } }).catch(() => {});
      } catch (err) {
        if (!alive || mine !== seq) return;
        failed = err instanceof Error ? err.message : String(err);
        next = RETRY_MS;
      }
      paint();
      timer = window.setTimeout(refresh, next);
    };

    // Show the last copy right away (e.g. after a reboot), then refresh.
    storage
      .load<(TileState & { cache?: Cached }) | null>(null)
      .catch(() => null)
      .then((saved) => {
        if (!alive) return;
        if (saved?.hidden) state = { hidden: saved.hidden };
        if (saved?.cache?.key === cacheKey()) data = saved.cache.data;
        paint();
        refresh();
      });

    // Repaint every minute so finished events drop off; roll over at midnight.
    tick = window.setInterval(() => {
      const now = startOfDay(new Date());
      if (now.getTime() !== today.getTime()) {
        today = now;
        offset = 0;
        refresh();
      } else paint();
    }, 60 * 1000);

    return {
      destroy() {
        alive = false;
        clearTimeout(timer);
        clearTimeout(snapTimer);
        clearInterval(tick);
      },
    };
  },
});

// ---- Rendering ------------------------------------------------------------

interface RenderCtx {
  today: Date;
  events: CalEvent[];
  calendars: CalendarInfo[];
  colorOf(id: string): string;
  placement: Placement;
}

function message(icon: string, text: string) {
  return h('div', { class: 'cal-message' }, icon && h('div', { class: 'cal-message-icon' }, icon), text);
}

function renderBar(ctx: RenderCtx) {
  const now = Date.now();
  const soon = ctx.events.find((e) => !e.allDay && end(e).getTime() > now && start(e).getTime() < now + 12 * 3600_000);
  if (!soon) return h('span', { class: 'cal-bar' }, '📅');
  const live = start(soon).getTime() <= now;
  return h(
    'button',
    { class: 'cal-bar', onclick: () => showEvent(soon, ctx) },
    h('span', { class: 'cal-dot', style: `--c: ${ctx.colorOf(soon.calendar)}` }),
    h('span', { class: 'cal-bar-time' }, live ? 'Now' : clock(start(soon))),
    h('span', { class: 'cal-bar-title' }, soon.title),
  );
}

function renderNext(ctx: RenderCtx, warning: string) {
  const now = Date.now();
  const upcoming = ctx.events.filter((e) => end(e).getTime() > now || (e.allDay && sameDay(start(e), ctx.today)));
  const list = upcoming.slice(0, 3);
  return h(
    'div',
    { class: 'cal-next' },
    h(
      'div',
      { class: 'cal-next-date' },
      h('span', { class: 'cal-next-wd' }, ctx.today.toLocaleDateString([], { weekday: 'short' })),
      h('span', { class: 'cal-next-day' }, String(ctx.today.getDate())),
      warning && h('span', { class: 'cal-warn', title: warning }, '⚠'),
    ),
    list.length
      ? h(
          'div',
          { class: 'cal-next-list' },
          ...list.map((e) =>
            h(
              'button',
              { class: 'cal-next-item', style: `--c: ${ctx.colorOf(e.calendar)}`, onclick: () => showEvent(e, ctx) },
              h('span', { class: 'cal-next-when' }, whenShort(e, ctx.today)),
              h('span', { class: 'cal-next-title' }, e.title),
            ),
          ),
        )
      : h('div', { class: 'cal-empty' }, 'Nothing coming up'),
  );
}

function renderAgenda(ctx: RenderCtx, from: Date, to: Date) {
  const now = Date.now();
  const groups: HTMLElement[] = [];
  for (let day = from; day < to; day = addDays(day, 1)) {
    const items = onDay(ctx.events, day).filter((e) => e.allDay || !sameDay(day, ctx.today) || end(e).getTime() > now);
    if (!items.length) continue;
    groups.push(
      h(
        'div',
        { class: 'cal-day' },
        h('div', { class: 'cal-day-label' }, dayLabel(day, ctx.today)),
        ...items.map((e) => eventRow(e, day, ctx)),
      ),
    );
  }
  return h('div', { class: 'cal-agenda' }, ...(groups.length ? groups : [h('div', { class: 'cal-empty' }, 'Nothing scheduled')]));
}

function renderWeek(ctx: RenderCtx, from: Date) {
  const cols: HTMLElement[] = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(from, i);
    const items = onDay(ctx.events, day);
    cols.push(
      h(
        'button',
        { class: `cal-wcol${sameDay(day, ctx.today) ? ' today' : ''}`, onclick: () => showDay(day, ctx) },
        h(
          'div',
          { class: 'cal-wcol-head' },
          h('span', { class: 'cal-wd' }, day.toLocaleDateString([], { weekday: 'short' })),
          h('span', { class: 'cal-dn' }, String(day.getDate())),
        ),
        h('div', { class: 'cal-wcol-list' }, ...items.map((e) => chip(e, ctx, true))),
      ),
    );
  }
  return h('div', { class: 'cal-week' }, ...cols);
}

function renderMonth(ctx: RenderCtx, from: Date, first: Date) {
  const max = MONTH_CHIPS[ctx.placement] ?? 2;
  const heads = Array.from({ length: 7 }, (_, i) =>
    h('div', { class: 'cal-mhead' }, addDays(from, i).toLocaleDateString([], { weekday: 'short' })),
  );
  const cells: HTMLElement[] = [];
  for (let i = 0; i < 42; i++) {
    const day = addDays(from, i);
    const items = onDay(ctx.events, day);
    const cls = ['cal-mcell'];
    if (day.getMonth() !== first.getMonth()) cls.push('other');
    if (sameDay(day, ctx.today)) cls.push('today');
    cells.push(
      h(
        'button',
        { class: cls.join(' '), onclick: () => showDay(day, ctx) },
        h('span', { class: 'cal-dn' }, String(day.getDate())),
        ...items.slice(0, max).map((e) => chip(e, ctx, false)),
        items.length > max && h('span', { class: 'cal-more' }, `+${items.length - max} more`),
      ),
    );
  }
  return h('div', { class: 'cal-month' }, ...heads, ...cells);
}

function chip(e: CalEvent, ctx: RenderCtx, withTime: boolean) {
  const filled = e.allDay || spansDays(e);
  return h(
    'span',
    { class: `cal-ev${filled ? ' filled' : ''}`, style: `--c: ${ctx.colorOf(e.calendar)}` },
    !filled && withTime && h('span', { class: 'cal-ev-time' }, clock(start(e))),
    !filled && !withTime && h('span', { class: 'cal-dot' }),
    h('span', { class: 'cal-ev-title' }, e.title),
  );
}

function eventRow(e: CalEvent, day: Date, ctx: RenderCtx) {
  return h(
    'button',
    { class: 'cal-row', style: `--c: ${ctx.colorOf(e.calendar)}`, onclick: () => showEvent(e, ctx) },
    h('span', { class: 'cal-row-time' }, timeOnDay(e, day)),
    h(
      'span',
      { class: 'cal-row-text' },
      h('span', { class: 'cal-row-title' }, e.title),
      e.location && h('span', { class: 'cal-row-loc' }, e.location),
    ),
  );
}

function showDay(day: Date, ctx: RenderCtx) {
  const items = onDay(ctx.events, day);
  openSheet(
    `📅 ${day.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}`,
    [
      h(
        'div',
        { class: 'cal-sheet' },
        ...(items.length ? items.map((e) => eventRow(e, day, ctx)) : [h('p', { class: 'cal-empty' }, 'Nothing scheduled')]),
      ),
    ],
  );
}

function showEvent(e: CalEvent, ctx: RenderCtx) {
  const cal = ctx.calendars.find((c) => c.id === e.calendar);
  const s = start(e);
  let when: string;
  if (e.allDay) {
    const last = addDays(end(e), -1);
    when = sameDay(s, last) ? `${longDate(s)}, all day` : `${longDate(s)} – ${longDate(last)}`;
  } else {
    const en = end(e);
    when = sameDay(s, en)
      ? `${longDate(s)}, ${clock(s)} – ${clock(en)}`
      : `${longDate(s)} ${clock(s)} – ${longDate(en)} ${clock(en)}`;
  }
  openSheet(e.title, [
    h(
      'div',
      { class: 'cal-detail' },
      h('div', { class: 'cal-detail-cal', style: `--c: ${cal?.color ?? 'var(--accent)'}` }, cal?.name ?? ''),
      h('div', { class: 'cal-detail-when' }, when),
      e.location && h('div', { class: 'cal-detail-loc' }, `📍 ${e.location}`),
      e.description && h('div', { class: 'cal-detail-desc' }, e.description.replace(/<[^>]*>/g, ' ')),
    ),
  ]);
}

// ---- Dates ------------------------------------------------------------------

function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
const start = (e: CalEvent) => (e.allDay ? parseDate(e.start as string) : new Date(e.start as number));
const end = (e: CalEvent) => (e.allDay ? parseDate(e.end as string) : new Date(e.end as number));

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d: Date, n: number) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function startOfWeek(d: Date, weekStart: number) {
  return addDays(startOfDay(d), -((d.getDay() - weekStart + 7) % 7));
}
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function onDay(events: CalEvent[], day: Date) {
  const from = day.getTime();
  const to = addDays(day, 1).getTime();
  return events.filter((e) => {
    const s = start(e).getTime();
    const en = end(e).getTime();
    return s < to && (en > from || (en === s && s >= from));
  });
}

function spansDays(e: CalEvent) {
  return !e.allDay && !sameDay(start(e), new Date(end(e).getTime() - 1));
}

function clock(d: Date) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(/\s/g, '').toLowerCase();
}
function longDate(d: Date) {
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function dayLabel(day: Date, today: Date) {
  if (sameDay(day, today)) return 'Today';
  if (sameDay(day, addDays(today, 1))) return 'Tomorrow';
  return longDate(day);
}

function timeOnDay(e: CalEvent, day: Date) {
  if (e.allDay) return 'All day';
  const s = start(e);
  const en = end(e);
  const startsToday = sameDay(s, day);
  const endsToday = en.getTime() <= addDays(day, 1).getTime();
  if (startsToday && endsToday) return en.getTime() > s.getTime() ? `${clock(s)}–${clock(en)}` : clock(s);
  if (startsToday) return `From ${clock(s)}`;
  if (endsToday) return `Until ${clock(en)}`;
  return 'All day';
}

function whenShort(e: CalEvent, today: Date) {
  const s = start(e);
  const day = sameDay(s, today) || s < today ? '' : sameDay(s, addDays(today, 1)) ? 'Tmrw ' : `${s.toLocaleDateString([], { weekday: 'short' })} `;
  if (e.allDay) return day ? day.trim() : 'Today';
  if (s.getTime() <= Date.now()) return 'Now';
  return `${day}${clock(s)}`;
}

function weekTitle(from: Date) {
  const to = addDays(from, 6);
  const sameMonth = from.getMonth() === to.getMonth();
  const a = from.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const b = to.toLocaleDateString([], sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
  return `${a} – ${b}`;
}
