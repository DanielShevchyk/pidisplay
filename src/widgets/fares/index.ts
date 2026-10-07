import { h } from '../../core/dom';
import { openSheet } from '../../core/sheet';
import { defineWidget, type Placement } from '../../core/types';
import { legList, routeMap, type Airport, type Itinerary, type OpenJawRoute, type Route } from './map';
import { FARES_CHANGED, type SettingsSummary, openFaresSettings, openTargetEditor } from './settings';
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
  itinerary?: Itinerary | null;
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
  /** Aviasales affiliate link for booking, when Farewatcher has a partner ID set up. */
  bookLink?: string | null;
  alternates?: Alternate[];
  /** Outbound legs from a live Google check on these dates; added Oct 2026. */
  itinerary?: Itinerary | null;
}

/** Fly into one city and home from a nearby one; added Oct 2026. */
interface OpenJaw {
  returnFrom: string;
  returnFromName: string | null;
  /** SFO or SMF, not always the airport you left from. */
  returnTo: string;
  /** The two one-way fares the cached price adds up. */
  outPrice: number | null;
  backPrice: number | null;
  /** The round trip to the arrival city it's compared with. */
  roundTrip: number | null;
  saving: number | null;
  /** Google Flights searches for the two one-ways, for booking them separately. */
  outLink?: string | null;
  backLink?: string | null;
  /** Aviasales affiliate links for booking the two one-ways, when set up. */
  bookOutLink?: string | null;
  bookBackLink?: string | null;
}

/** A destination's cheapest open jaw: the trip plus where you fly home from. */
interface OpenJawOption extends OpenJaw {
  origin: string;
  departDate: string | null;
  returnDate: string | null;
  price: number;
  verified: boolean;
  livePrice: number | null;
  link: string | null;
  itinerary?: Itinerary | null;
}

interface OriginData {
  currentLow: Low | null;
  median30: number | null;
  history: { date: string; low: number }[];
  monthly: { month: string; low: number | null }[];
  openJaw?: OpenJawOption | null;
}

interface Destination extends OriginData {
  code: string;
  name: string | null;
  target: number | null;
  /** Per home airport, added Oct 2026; older summaries don't have it. */
  byOrigin?: Record<string, OriginData>;
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
  bookLink?: string | null;
  foundAt: string | null;
  event: string | null;
  alternates?: Alternate[];
  itinerary?: Itinerary | null;
  /** Set on open-jaw deals: code is the arrival city, the flight home leaves from returnFrom. */
  openJaw?: OpenJaw | null;
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
  /** Coordinates for every home airport, destination and itinerary airport; added Oct 2026. */
  airports?: Record<string, Airport>;
  /** For the settings wizard: places Farewatcher knows, and recent runs' API usage. */
  places?: SettingsSummary['places'];
  usage?: SettingsSummary['usage'];
}

type Response = Summary | { available: false };

/** Home airports the switch flips between. */
const ORIGINS = ['SFO', 'SMF'] as const;
type Origin = (typeof ORIGINS)[number];

/** Shared by every Fares tile, so one tap flips them all. */
interface Shared {
  summary: Response | null;
  origin: Origin;
}

const REFRESH_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;

/** Destination rows shown per tile size. */
const ROWS: Record<Placement, number> = { bar: 0, small: 0, medium: 3, tall: 6, large: 5, xlarge: 6, full: 10 };

/** Sizes that get the route map on the right. */
const MAP_SIZES: Placement[] = ['large', 'xlarge', 'full'];

/** The destination the map shows; tapping a row picks it, tapping it again opens its details. */
interface Pick {
  code: string | null;
  select: (code: string) => void;
}

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
    let origin: Origin = 'SFO';
    let selected: string | null = null;
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
      const flip = (o: Origin) => {
        origin = o;
        paint();
        saveShared();
      };
      const pick: Pick = {
        code: selected,
        select: (code) => {
          selected = code;
          paint();
        },
      };
      root.replaceChildren(render(forOrigin(data, origin), config, placement, failed, originSwitch(origin, flip), pick));
    };

    const saveShared = () => sharedStorage.save({ summary: data, origin } satisfies Shared).catch(() => {});

    // Older versions stored the bare summary here.
    const readShared = (v: Shared | Response | null): Shared =>
      v && 'origin' in v ? v : { summary: (v as Response | null) ?? null, origin: 'SFO' };

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
        saveShared();
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
      .load<Shared | Response | null>(null)
      .catch(() => null)
      .then((stored) => {
        if (!alive) return;
        const shared = readShared(stored);
        if (shared.summary && !data) data = shared.summary;
        origin = shared.origin;
        paint();
        refresh();
      });

    // Another tile flipped the switch.
    const offShared = sharedStorage.onChange(() => {
      sharedStorage
        .load<Shared | Response | null>(null)
        .then((stored) => {
          const next = readShared(stored).origin;
          if (alive && next !== origin) {
            origin = next;
            paint();
          }
        })
        .catch(() => {});
    });

    // Settings saved here or on another screen: the summary was rewritten for the new list.
    const onChanged = () => void refresh();
    window.addEventListener(FARES_CHANGED, onChanged);
    const offConfig = on('fares-config', onChanged);

    // Farewatcher posts a notification at the end of a run that found deals.
    on('notification', (n: { source?: string }) => {
      if (n?.source === 'Farewatcher') refresh();
    });

    return {
      destroy() {
        alive = false;
        clearTimeout(timer);
        offShared();
        offConfig();
        window.removeEventListener(FARES_CHANGED, onChanged);
      },
    };
  },
});

// ---- Home airport switch ----------------------------------------------

function originSwitch(current: Origin, flip: (o: Origin) => void) {
  return h(
    'div',
    { class: 'fares-origin', role: 'group', 'aria-label': 'Home airport' },
    ...ORIGINS.map((o) =>
      h(
        'button',
        {
          class: o === current ? 'active' : '',
          'aria-pressed': String(o === current),
          onclick: (e: Event) => {
            e.stopPropagation();
            if (o !== current) flip(o);
          },
        },
        o,
      ),
    ),
  );
}

/**
 * The summary as seen from one home airport: every destination's low, history and months
 * come from that airport, and deals are that airport's own plus other-airport deals whose
 * same trip from here is also under target.
 */
function forOrigin(d: Summary, origin: Origin): Summary {
  const destinations = d.destinations.map((dest): Destination => {
    const own = dest.byOrigin?.[origin];
    const openJaw = own?.openJaw !== undefined ? own.openJaw : dest.openJaw?.origin === origin ? dest.openJaw : null;
    if (own) return { ...dest, ...own, openJaw };
    // Older summary: use the overall low when it's from here, else its same-trip alternate.
    const low = dest.currentLow;
    const alt = low?.alternates?.find((a) => a.origin === origin);
    return {
      ...dest,
      currentLow: low?.origin === origin ? low : alt ? lowFromAlternate(alt, dest.code) : null,
      openJaw,
    };
  });

  const deals: Deal[] = [];
  for (const deal of d.deals) {
    if (deal.origin === origin) {
      deals.push(deal);
      continue;
    }
    const alt = deal.alternates?.find((a) => a.origin === origin);
    if (!alt || (deal.target && best(alt) > deal.target)) continue;
    const { alternates: _, ...rest } = deal;
    deals.push({
      ...rest,
      ...lowFromAlternate(alt, deal.code),
      // The original deal becomes this one's "other airport" line.
      alternates: deal.origin
        ? [
            {
              origin: deal.origin,
              price: deal.price,
              departDate: deal.departDate,
              returnDate: deal.returnDate,
              stops: deal.stops,
              airline: null,
              sameDates: alt.sameDates,
              verified: deal.verified,
              livePrice: deal.livePrice,
              itinerary: deal.itinerary ?? null,
            },
          ]
        : [],
    });
  }
  deals.sort((a, b) => dealRatio(a) - dealRatio(b));
  return { ...d, destinations, deals };
}

function lowFromAlternate(a: Alternate, code: string): Low {
  return {
    price: a.price,
    origin: a.origin,
    departDate: a.departDate,
    returnDate: a.returnDate,
    stops: a.stops,
    airline: a.airline,
    verified: Boolean(a.verified),
    livePrice: a.livePrice ?? null,
    link: flightsLink(a.origin, code, a.departDate, a.returnDate),
    itinerary: a.itinerary ?? null,
  };
}

/** Google Flights search for a route and dates, the same form fare_watch.py links to. */
function flightsLink(origin: string, code: string, depart: string | null, ret: string | null) {
  if (!depart) return null;
  const q = `Flights from ${origin} to ${code} on ${depart.slice(0, 10)}${ret ? ` through ${ret.slice(0, 10)}` : ''}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

function dealRatio(x: Deal) {
  return x.target ? best(x) / x.target : 10 + best(x);
}

// ---- Rendering ----------------------------------------------------------

function render(
  d: Summary,
  config: FaresConfig,
  placement: Placement,
  failed: string,
  toggle: HTMLElement,
  pick: Pick,
) {
  const money = moneyFormat(d.currency);
  const deals = d.deals.filter((x) => config.showUnverified || x.verified);
  const featured = config.featured.trim().toUpperCase();
  const footer = h(
    'div',
    { class: 'fares-footer' },
    status(d, failed),
    toggle,
    placement !== 'small' &&
      h(
        'button',
        {
          class: 'fares-settings-btn',
          'aria-label': 'Farewatcher settings',
          onclick: (e: Event) => {
            e.stopPropagation();
            void openFaresSettings({ summary: d });
          },
        },
        '⚙',
      ),
  );

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

  const dealCodes = new Set(deals.map((x) => x.code));
  const rows = [...d.destinations]
    .sort((a, b) => Number(dealCodes.has(b.code)) - Number(dealCodes.has(a.code)) || ratio(a) - ratio(b))
    .slice(0, ROWS[placement]);

  // With the map, a tap shows that destination on it; tapping the one shown opens its details.
  const withMap = MAP_SIZES.includes(placement);
  const onTile = new Set([...deals.slice(0, 1), ...rows].map((x) => x.code));
  const shown = withMap
    ? pick.code && onTile.has(pick.code)
      ? pick.code
      : (deals[0]?.code ?? rows[0]?.code ?? null)
    : null;
  const tap = (code: string) => () => {
    const dest = d.destinations.find((x) => x.code === code);
    if (withMap && code !== shown) pick.select(code);
    else if (dest) openDetail(dest, d);
  };

  const sections: (HTMLElement | null)[] = [];
  const showHero = placement !== 'medium' && placement !== 'tall';
  if (showHero) {
    sections.push(
      deals[0]
        ? dealHero(deals[0], money, d, false, tap(deals[0].code))
        : h('div', { class: 'fares-none' }, 'No deals right now. Watching ', String(d.destinations.length), ' destinations.'),
    );
  }
  sections.push(
    h(
      'div',
      { class: 'fares-list', style: `--fares-price-w: ${priceWidth(rows, money)}ch` },
      ...rows.map((dest) => destRow(dest, money, dealCodes.has(dest.code), tap(dest.code), shown === dest.code)),
    ),
  );
  sections.push(footer);
  const body = h('div', { class: 'fares-body' }, ...sections);
  if (!withMap) return body;
  return h('div', { class: 'fares-split' }, body, mapPanel(d, deals, shown, money, tap));
}

/** The right half of the big tiles: the shown fare's route, legs and layovers. */
function mapPanel(
  d: Summary,
  deals: Deal[],
  code: string | null,
  money: (n: number) => string,
  tap: (code: string) => () => void,
) {
  const dest = d.destinations.find((x) => x.code === code);
  // A deal for this destination is the fare the list highlights; otherwise the same fare as its row.
  const deal = deals.find((x) => x.code === code);
  const own = dest ? rowFare(dest) : null;
  const fare: Fare | null = deal ?? own;
  const jaw: OpenJaw | null = deal ? (deal.openJaw ?? null) : own && 'returnFrom' in own ? own : null;
  const route: Route | null =
    code && fare
      ? {
          origin: fare.origin,
          code,
          stops: fare.stops ?? null,
          airline: fare.airline ?? null,
          itinerary: fare.itinerary ?? null,
          openJaw: jaw && openJawRoute(jaw, fare.livePrice != null),
        }
      : null;
  return h(
    'div',
    { class: 'fares-map' },
    code &&
      h(
        'button',
        { class: 'fares-map-head', onclick: tap(code) },
        h('span', { class: 'fares-map-title' }, place(deal?.name ?? dest?.name ?? null, code)),
        jaw && h('span', { class: 'fares-map-jaw' }, `↩ ${jaw.returnFrom}`),
        fare && h('span', { class: 'fares-map-price' }, money(best(fare))),
        h('span', { class: 'fares-map-more' }, 'Details ›'),
      ),
    routeMap(route, d.airports),
    legList(route, d.airports, money),
  );
}

/** What the map needs from any of the fare shapes: a deal, a round-trip low or an open jaw. */
interface Fare {
  origin: string | null;
  price: number;
  livePrice?: number | null;
  stops?: number | null;
  airline?: string | null;
  itinerary?: Itinerary | null;
}

/** The fare a destination row shows: its round-trip low, or its open jaw when that's cheaper. */
function rowFare(dest: Destination): Low | OpenJawOption | null {
  const low = dest.currentLow;
  const jaw = dest.openJaw;
  return jaw && (!low || best(jaw) < best(low)) ? jaw : low;
}

function openJawRoute(jaw: OpenJaw, priced: boolean): OpenJawRoute {
  // Once Google priced the whole ticket, the one-way fares it replaced would only confuse.
  return {
    returnFrom: jaw.returnFrom,
    returnTo: jaw.returnTo,
    outPrice: priced ? null : jaw.outPrice,
    backPrice: priced ? null : jaw.backPrice,
  };
}

/** "↩ Back from Paris (PAR) · $90 less than the round trip"; compact drops the saving. */
function openJawLine(jaw: OpenJaw, origin: string | null, money: (n: number) => string, compact = false) {
  return h(
    'div',
    { class: 'fares-jaw' },
    '↩ Back from ',
    h('span', { class: 'fares-jaw-city' }, place(jaw.returnFromName, jaw.returnFrom)),
    jaw.returnTo !== origin ? ` to ${jaw.returnTo}` : '',
    !compact &&
      jaw.saving &&
      jaw.saving > 0 &&
      h('span', { class: 'fares-jaw-saving' }, ` · ${money(jaw.saving)} less than the round trip`),
  );
}

function dealHero(
  deal: Deal,
  money: (n: number) => string,
  d: Summary,
  compact: boolean,
  onTap?: () => void,
) {
  const dest = d.destinations.find((x) => x.code === deal.code);
  const under = deal.target ? deal.target - best(deal) : null;
  return h(
    'button',
    { class: 'fares-hero', onclick: onTap ?? (() => dest && openDetail(dest, d)) },
    h('div', { class: 'fares-hero-top' }, h('span', { class: 'fares-place' }, place(deal.name, deal.code)), checkedAt(d)),
    h('div', { class: 'fares-price' }, money(best(deal))),
    h(
      'div',
      { class: 'fares-meta' },
      [deal.origin, dateRange(deal.departDate, deal.returnDate)].filter(Boolean).join(' · '),
    ),
    deal.openJaw && openJawLine(deal.openJaw, deal.origin, money, compact),
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

/** Width of the widest row price, in ch, so every row's sparkline sits in the same column. */
function priceWidth(rows: Destination[], money: (n: number) => string) {
  let widest = 1;
  for (const dest of rows) {
    const fare = rowFare(dest);
    const price = fare ? money(best(fare)) : '–';
    // The target is drawn at 0.8em.
    const target = dest.target ? ` / ${money(dest.target)}`.length * 0.8 : 0;
    widest = Math.max(widest, price.length + target);
  }
  return Math.ceil(widest * 10) / 10;
}

function destRow(dest: Destination, money: (n: number) => string, isDeal: boolean, open: () => void, shown = false) {
  const fare = rowFare(dest);
  const low = fare ? best(fare) : null;
  return h(
    'button',
    { class: `fares-row${isDeal ? ' deal' : ''}${shown ? ' shown' : ''}`, onclick: open },
    h(
      'span',
      { class: 'fares-row-name' },
      place(dest.name, dest.code),
      fare && 'returnFrom' in fare && h('span', { class: 'fares-row-jaw' }, ` ↩ ${fare.returnFrom}`),
    ),
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
    low?.link
      ? tickets(low.link, `${place(dest.name, dest.code)} ${money(best(low))} from ${low.origin ?? '?'}, ${dateRange(low.departDate, low.returnDate)}`)
      : null,
    low?.bookLink
      ? book(low.bookLink, `${place(dest.name, dest.code)} from ${low.origin ?? '?'}, ${dateRange(low.departDate, low.returnDate)}`)
      : null,
  ];

  const jaw = dest.openJaw;
  if (jaw) {
    content.push(
      h('h3', {}, 'Home from a nearby city'),
      h(
        'div',
        { class: 'fares-deal' },
        h('div', { class: 'fares-deal-top' }, h('strong', {}, money(best(jaw))), badge(jaw.verified)),
        h('div', { class: 'fares-meta' }, [jaw.origin, dateRange(jaw.departDate, jaw.returnDate)].filter(Boolean).join(' · ')),
        openJawLine(jaw, jaw.origin, money),
        jaw.outPrice && jaw.backPrice && jaw.livePrice == null
          ? h('div', { class: 'fares-meta' }, `One-way fares: ${money(jaw.outPrice)} out + ${money(jaw.backPrice)} home`)
          : null,
        ...jawTickets(jaw, jaw.link, `${place(dest.name, dest.code)} from ${jaw.origin}, ${dateRange(jaw.departDate, jaw.returnDate)}`),
      ),
    );
  }

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
          x.openJaw && openJawLine(x.openJaw, x.origin, money),
          ...alternates(x, money),
          x.event && h('div', { class: 'fares-meta' }, `🎟 ${x.event}`),
          ...(x.openJaw
            ? jawTickets(x.openJaw, null, `${place(x.name, x.code)} from ${x.origin ?? '?'}, ${dateRange(x.departDate, x.returnDate)}`, x.link)
            : [
                x.link &&
                  tickets(x.link, `${place(x.name, x.code)} ${money(best(x))} from ${x.origin ?? '?'}, ${dateRange(x.departDate, x.returnDate)}`),
                x.bookLink &&
                  book(x.bookLink, `${place(x.name, x.code)} from ${x.origin ?? '?'}, ${dateRange(x.departDate, x.returnDate)}`),
              ]),
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
  content.push(
    h(
      'div',
      { class: 'fw-actions' },
      h(
        'button',
        { class: 'btn', onclick: () => void openTargetEditor(dest.code, place(dest.name, dest.code), { summary: d }) },
        '✏️ Change target',
      ),
      h('button', { class: 'btn btn-ghost', onclick: () => void openFaresSettings({ summary: d }) }, '⚙ Farewatcher settings'),
    ),
    status(d, ''),
  );
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
      !compact && h('span', { class: 'fares-alt-dates' }, ` · ${a.sameDates ? 'same dates' : dateRange(a.departDate, a.returnDate)}`),
    );
  });
}

/**
 * "Tickets" button for a fare. The kiosk browser has no address bar or back button, so the
 * link isn't opened on the screen: it expands a QR code to scan and a "Send to my phone"
 * button that pushes the link through Farewatcher's ntfy topic.
 */
function tickets(link: string, title: string, label = '🎫 Tickets') {
  const status = h('div', { class: 'fares-tickets-status' });
  const sendBtn = h('button', { class: 'btn btn-primary' }, '📲 Send to my phone') as HTMLButtonElement;
  sendBtn.onclick = async () => {
    sendBtn.disabled = true;
    status.textContent = 'Sending…';
    try {
      const res = await fetch('/api/fares/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: link, title }),
      });
      const body = await res.json().catch(() => ({}));
      status.textContent = res.ok ? 'Sent. Check your phone.' : `Couldn't send: ${body.error ?? res.status}`;
    } catch {
      status.textContent = "Couldn't send: no connection";
    }
    sendBtn.disabled = false;
  };
  const qr = `https://quickchart.io/qr?size=220&margin=1&text=${encodeURIComponent(link)}`;
  const panel = h(
    'div',
    { class: 'fares-tickets-panel', hidden: true },
    h('img', { class: 'fares-qr', alt: 'QR code for the tickets link', width: 220, height: 220 }),
    h(
      'div',
      { class: 'fares-tickets-side' },
      // A normal browser (dashboard opened from a phone or laptop) can just open it.
      !document.body.classList.contains('kiosk') &&
        h('a', { class: 'btn', href: link, target: '_blank', rel: 'noopener' }, '↗ Open tickets'),
      h('div', { class: 'fares-meta' }, 'Scan with your phone, or:'),
      sendBtn,
      status,
    ),
  );
  const toggle = h('button', { class: 'btn fares-tickets-btn' }, label) as HTMLButtonElement;
  toggle.onclick = () => {
    panel.hidden = !panel.hidden;
    const img = panel.querySelector('img');
    if (!panel.hidden && img && !img.getAttribute('src')) img.setAttribute('src', qr); // load on first open
  };
  return h('div', { class: 'fares-tickets' }, toggle, panel);
}

/**
 * Tickets for an open jaw: one button when there's a link for the whole trip, else the two
 * one-ways it adds up, booked separately ("Flight out", "Flight home").
 */
function jawTickets(jaw: OpenJaw, link: string | null, title: string, outLink = jaw.outLink) {
  const booking = [
    jaw.bookOutLink && book(jaw.bookOutLink, `${title}: flight out`, '🛒 Book flight out'),
    jaw.bookBackLink && book(jaw.bookBackLink, `${title}: flight home from ${jaw.returnFrom}`, '🛒 Book flight home'),
  ];
  if (link) return [tickets(link, `${title}, home from ${jaw.returnFrom}`), ...booking];
  return [
    outLink && tickets(outLink, `${title}: flight out`, '🎫 Flight out'),
    jaw.backLink && tickets(jaw.backLink, `${title}: flight home from ${jaw.returnFrom}`, '🎫 Flight home'),
    ...booking,
  ];
}

/** Book on Aviasales through Farewatcher's Travelpayouts affiliate link; same QR/send panel as Tickets. */
function book(link: string, title: string, label = '🛒 Book on Aviasales') {
  return tickets(link, `Book ${title}`, label);
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
