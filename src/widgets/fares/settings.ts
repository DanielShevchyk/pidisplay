// Farewatcher settings wizard: edits ~/fare_watch/config.json through /api/fares/config,
// with a meter of the API usage the settings will cause (server/fares-usage.js).
import { call } from '../../core/api';
import { h } from '../../core/dom';
import { openSheet, type SheetHandle } from '../../core/sheet';
import { estimateUsage, openJawReturns, type UsageEstimate } from '../../../server/fares-usage.js';
import './settings.css';

// ---- What the server sends (the editable part of config.json) -----------

interface FwEvent {
  name: string;
  dest: string;
  depart: string;
  return: string | null;
  target: number;
  tag?: string;
}

export interface FwConfig {
  origins: string[];
  compare_origins: string[];
  origin_allowance: Record<string, number>;
  destinations: Record<string, number>;
  place_names: Record<string, string>;
  months_ahead: number;
  events: FwEvent[];
  event_settings: { check_every_days: number; horizon_days: number };
  open_jaw: {
    enabled: boolean;
    max_km: number;
    extra_return_from: string[];
    home: string[];
    nights: [number, number];
    min_saving: number;
    live_check: boolean;
  };
  live_check: {
    enabled: boolean;
    origins: string[];
    max_searches_per_run: number;
    reserve_searches: number;
    require_live_confirmation: boolean;
    confirm_leeway: number;
    recheck_after_days: number;
  };
  alerting: {
    drop_vs_median: number;
    history_window_days: number;
    min_history_days: number;
    realert_drop: number;
    realert_cooldown_days: number;
    max_alerts_per_run: number;
  };
  notify: { urgent_below_target: number; high_below_target: number };
}

interface ConfigResponse {
  config: FwConfig;
  versions: number;
}

/** What the wizard needs from the Fares summary (farewatcher.json). */
export interface SettingsSummary {
  currency: string;
  lastRun: { startedAt: string | null; serpapiUsedThisMonth: number | null; serpapiBudget: number | null } | null;
  destinations: { code: string; name: string | null; target: number | null; median30: number | null; currentLow: { price: number } | null }[];
  airports?: Record<string, { name: string | null; lat: number; lon: number }>;
  places?: Record<string, { name: string; lat: number | null; lon: number | null }>;
  usage?: {
    runs: { startedAt: string; seconds: number | null; travelpayouts: number | null; serpapi: number | null; eventSearches: number | null }[];
    faresByOrigin: Record<string, number>;
    serpapiUsedThisMonth: number | null;
    serpapiPlan: number | null;
  };
}

interface Ctx {
  summary: SettingsSummary | null;
}

/** Fired on window after a save, undo or Check now, so every Fares tile refreshes. */
export const FARES_CHANGED = 'pidisplay:fares-changed';
const changed = () => window.dispatchEvent(new Event(FARES_CHANGED));

/** Airports offered as home airports even when not watched yet. */
const HOME_CANDIDATES = ['SFO', 'SMF', 'OAK', 'SJC'];

const STEPS = ['Airports', 'Destinations', 'Live checks', 'Events', 'Open jaws', 'Alerts', 'Review'] as const;
type Step = (typeof STEPS)[number];

/** Step content; null/false entries are skipped. */
type Parts = (Node | null | false)[];

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- Usage helpers ------------------------------------------------------

function usageContext(summary: SettingsSummary | null) {
  const places = summary?.places;
  const airports = summary?.airports ?? {};
  return {
    // Same coordinates fare_watch.py pairs open jaws with; older summaries only have airports.
    coords: (code: string): [number, number] | null => {
      if (places) {
        const p = places[code];
        return p && p.lat != null && p.lon != null ? [p.lat, p.lon] : null;
      }
      const a = airports[code];
      return a ? [a.lat, a.lon] : null;
    },
    history: summary?.usage ?? null,
    plan: summary?.usage?.serpapiPlan ?? summary?.lastRun?.serpapiBudget ?? null,
  };
}

function signed(n: number, unit: string) {
  if (n === 0) return `no change`;
  return `${n > 0 ? '+' : '−'}${Math.abs(n)} ${unit}`;
}

function duration(seconds: number) {
  if (seconds < 90) return `${seconds} s`;
  return `${Math.round(seconds / 60)} min`;
}

/** The usage meter pinned under every step. */
function meter(est: UsageEstimate, saved: UsageEstimate, summary: SettingsSummary | null) {
  const s = est.serpapi;
  const tp = est.travelpayouts;
  const used = s.worst + s.reserve;
  const pct = (n: number) => `${Math.min(100, (n / s.plan) * 100)}%`;
  const message =
    s.level === 'over'
      ? `Would run out about ${s.runsOutDay} days into each month. Deals after that arrive unverified.`
      : s.level === 'warn'
        ? 'Close to the limit. Late-month deals may go unverified.'
        : 'Plenty of room in the monthly plan.';
  const thisMonth = summary?.usage?.serpapiUsedThisMonth ?? summary?.lastRun?.serpapiUsedThisMonth ?? null;
  const delta = s.worst + s.reserve - (saved.serpapi.worst + saved.serpapi.reserve);
  const tpDelta = tp.perRun - saved.travelpayouts.perRun;

  return h(
    'div',
    { class: `fw-meter level-${s.level}` },
    h(
      'div',
      { class: 'fw-meter-head' },
      h('strong', {}, 'Live Google checks (SerpApi)'),
      h('span', { class: 'fw-meter-total' }, `up to ${used} of ${s.plan} a month`),
    ),
    h(
      'div',
      { class: 'fw-bar', role: 'img', 'aria-label': `${used} of ${s.plan} searches a month` },
      h('div', { class: 'fw-bar-fill', style: `width:${pct(s.worst)}` }),
      h('div', { class: 'fw-bar-reserve', style: `left:${pct(s.worst)};width:${pct(s.reserve)}` }),
      s.likely != null && h('div', { class: 'fw-bar-likely', style: `left:${pct(s.likely)}`, title: 'Typical lately' }),
      h('div', { class: 'fw-bar-warn', style: `left:70%` }),
    ),
    h(
      'div',
      { class: 'fw-meter-lines' },
      h('span', { class: 'fw-meter-msg' }, message),
      h(
        'span',
        { class: 'fw-dim' },
        [
          `${s.dealChecks} deal checks + ${s.eventChecks} event checks + ${s.reserve} reserve`,
          s.likely != null ? `about ${s.likely} lately` : null,
          thisMonth != null ? `${thisMonth} used so far this month` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
      h(
        'span',
        { class: `fw-tp level-${tp.level}` },
        `Cached fares (Travelpayouts): ${tp.perRun} lookups a run, about ${duration(tp.seconds)}`,
        tp.level !== 'ok' ? '. That makes for a long run.' : '',
      ),
      (delta !== 0 || tpDelta !== 0) &&
        h('span', { class: 'fw-delta' }, `Compared with saved: ${signed(delta, 'searches/mo')}, ${signed(tpDelta, 'lookups/run')}`),
    ),
  );
}

// ---- Small controls -----------------------------------------------------

function stepper(
  value: number,
  opts: { min: number; max: number; step: number; scale?: number; suffix?: string; prefix?: string },
  set: (v: number) => void,
) {
  const scale = opts.scale ?? 1;
  const clamp = (v: number) => Math.min(opts.max, Math.max(opts.min, Math.round(v / opts.step) * opts.step));
  const shown = (v: number) => String(Math.round(v * scale * 100) / 100);
  const input = h('input', {
    type: 'number',
    inputmode: 'numeric',
    class: 'fw-num',
    value: shown(value),
    onchange: (e: Event) => {
      const n = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(n)) set(clamp(n / scale));
    },
  });
  return h(
    'div',
    { class: 'fw-stepper' },
    h('button', { class: 'btn', type: 'button', 'aria-label': 'Less', onclick: () => set(clamp(value - opts.step)) }, '−'),
    opts.prefix ? h('span', { class: 'fw-unit' }, opts.prefix) : null,
    input,
    opts.suffix ? h('span', { class: 'fw-unit' }, opts.suffix) : null,
    h('button', { class: 'btn', type: 'button', 'aria-label': 'More', onclick: () => set(clamp(value + opts.step)) }, '+'),
  );
}

function toggle(checked: boolean, set: (v: boolean) => void, label: string) {
  return h('input', {
    type: 'checkbox',
    class: 'toggle',
    checked,
    'aria-label': label,
    onchange: (e: Event) => set((e.target as HTMLInputElement).checked),
  });
}

function row(label: string, hint: string | null, control: Node, cost?: Node | string | null) {
  return h(
    'div',
    { class: 'fw-row' },
    h('div', { class: 'fw-row-text' }, h('span', {}, label), hint ? h('small', { class: 'fw-dim' }, hint) : null),
    cost ? h('span', { class: 'fw-cost' }, cost) : null,
    control,
  );
}

function intro(text: string) {
  return h('p', { class: 'fw-intro' }, text);
}

// ---- The wizard ---------------------------------------------------------

export async function openFaresSettings(ctx: Ctx, startAt: Step = 'Airports'): Promise<void> {
  const loading = openSheet('✈️ Farewatcher settings', [h('div', { class: 'fw-loading' }, 'Loading settings…')]);
  let res: ConfigResponse;
  try {
    res = await call<ConfigResponse>('GET', '/api/fares/config');
  } catch (err) {
    loading.body.replaceChildren(h('div', { class: 'fw-error' }, err instanceof Error ? err.message : String(err)));
    return;
  }
  if (!loading.body.isConnected) return;
  wizard(loading, res, ctx, startAt);
}

function wizard(sheet: SheetHandle, res: ConfigResponse, ctx: Ctx, startAt: Step) {
  let saved = res.config;
  let versions = res.versions;
  let draft = clone(saved);
  let step: Step = startAt;
  let note = '';
  let busy = false;
  let confirmOver = false;
  const usageCtx = usageContext(ctx.summary);
  const estimate = (cfg: FwConfig) => estimateUsage(cfg, usageCtx);
  const places = ctx.summary?.places ?? {};
  const placeName = (code: string) =>
    draft.place_names[code] ?? places[code]?.name ?? ctx.summary?.destinations.find((d) => d.code === code)?.name ?? code;
  const money = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: ctx.summary?.currency || 'USD',
    maximumFractionDigits: 0,
  });

  const tabs = h('div', { class: 'fw-tabs', role: 'tablist' });
  const content = h('div', { class: 'fw-content' });
  const footer = h('div', { class: 'fw-footer' });
  sheet.body.replaceChildren(h('div', { class: 'fw fw-wizard' }, tabs, content, footer));

  /** Re-render after any change to the draft. */
  const update = () => {
    confirmOver = false;
    render();
  };
  const edit = (fn: (d: FwConfig) => void) => {
    fn(draft);
    note = '';
    update();
  };

  function render() {
    const est = estimate(draft);
    const savedEst = estimate(saved);
    tabs.replaceChildren(
      ...STEPS.map((s, i) =>
        h(
          'button',
          {
            class: `fw-tab${s === step ? ' active' : ''}`,
            role: 'tab',
            'aria-selected': String(s === step),
            onclick: () => {
              step = s;
              render();
              content.scrollTop = 0;
            },
          },
          `${i + 1}. ${s}`,
        ),
      ),
    );
    const top = sheet.body.scrollTop;
    content.replaceChildren(...(renderStep(est).filter(Boolean) as Node[]));
    sheet.body.scrollTop = top;
    const i = STEPS.indexOf(step);
    const dirty = !same(draft, saved);
    footer.replaceChildren(
      meter(est, savedEst, ctx.summary),
      h(
        'div',
        { class: 'fw-nav' },
        h('button', { class: 'btn', disabled: i === 0, onclick: () => go(i - 1) }, '‹ Back'),
        h('span', { class: 'fw-dim fw-nav-state' }, dirty ? 'Unsaved changes' : 'No changes'),
        i < STEPS.length - 1
          ? h('button', { class: 'btn btn-primary', onclick: () => go(i + 1) }, 'Next ›')
          : saveButton(est, dirty),
      ),
    );
  }

  function go(i: number) {
    step = STEPS[Math.max(0, Math.min(STEPS.length - 1, i))];
    render();
    sheet.body.scrollTop = 0;
  }

  function renderStep(est: UsageEstimate): Parts {
    switch (step) {
      case 'Airports':
        return airportsStep();
      case 'Destinations':
        return destinationsStep();
      case 'Live checks':
        return liveStep(est);
      case 'Events':
        return eventsStep(est);
      case 'Open jaws':
        return openJawStep(est);
      case 'Alerts':
        return alertsStep();
      case 'Review':
        return reviewStep();
    }
  }

  // ---- 1. Home airports
  function airportsStep(): Parts {
    const base = estimate(draft).travelpayouts.perRun;
    const fares = ctx.summary?.usage?.faresByOrigin ?? {};
    const all = [...new Set([...HOME_CANDIDATES, ...draft.origins])];
    const chip = (code: string) => {
      const on = draft.origins.includes(code);
      const without = clone(draft);
      without.origins = on ? draft.origins.filter((o) => o !== code) : [...draft.origins, code];
      const diff = estimate(without).travelpayouts.perRun - base;
      return h(
        'button',
        {
          class: `chip fw-chip${on ? ' active' : ''}`,
          'aria-pressed': String(on),
          onclick: () =>
            edit((d) => {
              if (on && d.origins.length === 1) return;
              d.origins = on ? d.origins.filter((o) => o !== code) : [...d.origins, code];
              if (on) {
                d.compare_origins = d.compare_origins.filter((o) => o !== code);
                if (d.live_check.origins.length > 1) d.live_check.origins = d.live_check.origins.filter((o) => o !== code);
                delete d.origin_allowance[code];
              }
            }),
        },
        h('strong', {}, code),
        h('small', {}, `${on ? '−' : '+'}${Math.abs(diff)} lookups`),
        fares[code] != null ? h('small', {}, `${fares[code]} fares in 30 days`) : null,
      );
    };
    const addInput = h('input', { type: 'text', class: 'fw-code-input fw-add-airport', placeholder: 'Airport code, e.g. LAX', maxlength: 3 });
    const add = () => {
      const code = addInput.value.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) return;
      edit((d) => {
        if (!d.origins.includes(code)) d.origins.push(code);
      });
    };
    addInput.addEventListener('keydown', (e) => e.key === 'Enter' && add());

    return [
      intro(
        'Airports Farewatcher searches from. Each one adds a cached-fare lookup for every destination on every run. An airport that returns few fares costs lookups for little.',
      ),
      h('div', { class: 'chips fw-chips' }, ...all.map(chip)),
      h('div', { class: 'fw-inline' }, addInput, h('button', { class: 'btn', onclick: add }, 'Add')),
      h('h3', {}, 'Per airport'),
      ...draft.origins.map((o) =>
        h(
          'div',
          { class: 'fw-card' },
          h('div', { class: 'fw-card-title' }, `${o} · ${placeName(o)}`),
          row(
            'Compare in alerts',
            'Shown side by side in every alert',
            toggle(
              draft.compare_origins.includes(o),
              (v) => edit((d) => (d.compare_origins = v ? [...d.compare_origins, o] : d.compare_origins.filter((x) => x !== o))),
              `Compare ${o}`,
            ),
          ),
          row(
            'Live-check from here',
            'Each deal check from here costs 1 search',
            toggle(draft.live_check.origins.includes(o), (v) =>
              edit((d) => {
                const next = v ? [...d.live_check.origins, o] : d.live_check.origins.filter((x) => x !== o);
                if (next.length) d.live_check.origins = next;
              }),
              `Live-check ${o}`),
          ),
          row(
            'Extra you would pay to fly from here',
            'Alerts from this airport at target plus this much',
            stepper(draft.origin_allowance[o] ?? 0, { min: 0, max: 1000, step: 25, prefix: '$' }, (v) =>
              edit((d) => {
                if (v) d.origin_allowance[o] = v;
                else delete d.origin_allowance[o];
              }),
            ),
          ),
        ),
      ),
    ];
  }

  // ---- 2. Destinations
  function destinationsStep(): Parts {
    const base = estimate(draft).travelpayouts.perRun;
    const known = new Map((ctx.summary?.destinations ?? []).map((d) => [d.code, d]));
    const codes = Object.keys(draft.destinations);
    const results = h('div', { class: 'fw-results' });
    const search = h('input', { type: 'text', class: 'fw-search', placeholder: 'Add a city: name or code' });
    const addDest = (code: string) => {
      const low = known.get(code)?.median30 ?? known.get(code)?.currentLow?.price ?? null;
      edit((d) => {
        d.destinations[code] = low ? Math.max(50, Math.round((low * 0.85) / 25) * 25) : 700;
      });
    };
    const showResults = () => {
      const q = search.value.trim().toLowerCase();
      if (!q) return results.replaceChildren();
      const matches = Object.entries(places)
        .filter(([code, p]) => !draft.destinations[code] && (code.toLowerCase().startsWith(q) || p.name.toLowerCase().includes(q)))
        .slice(0, 8);
      const raw = q.toUpperCase();
      const offerRaw = /^[A-Z]{3}$/.test(raw) && !draft.destinations[raw] && !places[raw];
      const found: Node[] = matches.map(([code, p]) => h('button', { class: 'chip', onclick: () => addDest(code) }, `+ ${p.name} (${code})`));
      if (offerRaw) found.push(h('button', { class: 'chip', onclick: () => addDest(raw) }, `+ ${raw}`));
      if (!found.length) found.push(h('span', { class: 'fw-dim' }, 'No match. Type a 3-letter airport or city code.'));
      results.replaceChildren(...found);
    };
    search.addEventListener('input', showResults);

    const one = estimate({ ...draft, destinations: { ...draft.destinations, ZZZ: 1 } }).travelpayouts.perRun - base;
    return [
      intro(
        `Cities to watch and the round-trip price that counts as a deal. Each city adds ${one} lookups a run (one per home airport). The low and median are from recent runs, to help pick a target.`,
      ),
      h('div', { class: 'fw-inline' }, search),
      results,
      h(
        'div',
        { class: 'fw-dests' },
        ...codes.map((code) => {
          const d = known.get(code);
          const facts = [
            d?.currentLow ? `low ${money.format(d.currentLow.price)}` : null,
            d?.median30 ? `median ${money.format(d.median30)}` : null,
          ].filter(Boolean);
          const without = clone(draft);
          delete without.destinations[code];
          const saves = base - estimate(without).travelpayouts.perRun;
          return h(
            'div',
            { class: 'fw-dest' },
            h(
              'div',
              { class: 'fw-row-text' },
              h('span', {}, `${placeName(code)} (${code})`),
              h('small', { class: 'fw-dim' }, [...facts, `${saves} lookups`].join(' · ') || 'No fares yet'),
            ),
            stepper(draft.destinations[code], { min: 50, max: 20000, step: 25, prefix: '$' }, (v) => edit((x) => (x.destinations[code] = v))),
            h(
              'button',
              {
                class: 'btn btn-ghost fw-remove',
                'aria-label': `Stop watching ${code}`,
                disabled: codes.length === 1,
                onclick: () => edit((x) => delete x.destinations[code]),
              },
              '✕',
            ),
          );
        }),
      ),
      row(
        'Months ahead',
        'How far out to look for fares',
        stepper(draft.months_ahead, { min: 1, max: 12, step: 1 }, (v) => edit((d) => (d.months_ahead = v))),
      ),
    ];
  }

  // ---- 3. Live checks
  function liveStep(est: UsageEstimate): Parts {
    const lc = draft.live_check;
    return [
      intro(
        'Before a deal alerts, Farewatcher can check the real price on Google Flights. That uses SerpApi searches, which are capped each month. This is the setting that moves the meter most.',
      ),
      row('Live Google checks', 'Off means every alert is from cached prices only', toggle(lc.enabled, (v) => edit((d) => (d.live_check.enabled = v)), 'Live checks')),
      lc.enabled &&
        row(
          'Searches per run',
          'Most a daily run may spend on deals (each deal costs 1 per live-check airport)',
          stepper(lc.max_searches_per_run, { min: 0, max: 20, step: 1 }, (v) => edit((d) => (d.live_check.max_searches_per_run = v))),
          `≈ ${est.serpapi.dealChecks}/month`,
        ),
      lc.enabled &&
        row(
          'Keep in reserve',
          'Runs stop spending when only this many are left',
          stepper(lc.reserve_searches, { min: 0, max: 100, step: 5 }, (v) => edit((d) => (d.live_check.reserve_searches = v))),
        ),
      lc.enabled &&
        row(
          'Only alert when Google confirms',
          'Skip a deal whose live price is over target',
          toggle(lc.require_live_confirmation, (v) => edit((d) => (d.live_check.require_live_confirmation = v)), 'Require confirmation'),
        ),
      lc.enabled &&
        row(
          'Allowed over target',
          'Still alert when the live price is this much over',
          stepper(lc.confirm_leeway, { min: 0, max: 0.5, step: 0.01, scale: 100, suffix: '%' }, (v) => edit((d) => (d.live_check.confirm_leeway = v))),
        ),
      lc.enabled &&
        row(
          'Wait before re-checking',
          'Skip dates that were over target this recently, saving searches',
          stepper(lc.recheck_after_days, { min: 0, max: 30, step: 1, suffix: 'days' }, (v) => edit((d) => (d.live_check.recheck_after_days = v))),
        ),
    ];
  }

  // ---- 4. Events
  function eventsStep(est: UsageEstimate): Parts {
    const es = draft.event_settings;
    const today = new Date();
    const plusDays = (n: number) => new Date(today.getTime() + n * 86400000).toISOString().slice(0, 10);
    return [
      intro(
        'Fixed-date trips checked straight on Google Flights, on their own schedule. Each check costs one search per live-check airport, from when Google opens the dates until you fly, so they quietly add up.',
      ),
      ...draft.events.map((ev, i) => {
        const use = est.serpapi.events[i];
        const set = (fn: (e: FwEvent) => void) => edit((d) => fn(d.events[i]));
        const status =
          use?.state === 'past'
            ? 'Trip is over. Remove it.'
            : use?.state === 'waiting'
              ? `Checks start around ${use.opensOn}, then about ${use.perMonth} searches a month`
              : `Checking now: about ${use?.perMonth ?? 0} searches a month`;
        return h(
          'div',
          { class: 'fw-card' },
          h(
            'div',
            { class: 'fw-card-title' },
            h('input', {
              type: 'text',
              class: 'fw-event-name',
              value: ev.name,
              'aria-label': 'Event name',
              onchange: (e: Event) => set((x) => (x.name = (e.target as HTMLInputElement).value.trim() || x.name)),
            }),
            h('button', { class: 'btn btn-ghost fw-remove', 'aria-label': `Remove ${ev.name}`, onclick: () => edit((d) => d.events.splice(i, 1)) }, '✕'),
          ),
          h('small', { class: `fw-dim${use?.state === 'past' ? ' fw-warn' : ''}` }, status),
          h(
            'div',
            { class: 'fw-event-grid' },
            h('label', {}, 'To', h('input', {
              type: 'text',
              class: 'fw-code-input',
              value: ev.dest,
              maxlength: 3,
              onchange: (e: Event) => {
                const v = (e.target as HTMLInputElement).value.trim().toUpperCase();
                if (/^[A-Z]{3}$/.test(v)) set((x) => (x.dest = v));
                else render();
              },
            })),
            h('label', {}, 'Leave', h('input', {
              type: 'date',
              value: ev.depart,
              onchange: (e: Event) => set((x) => (x.depart = (e.target as HTMLInputElement).value || x.depart)),
            })),
            h('label', {}, 'Return', h('input', {
              type: 'date',
              value: ev.return ?? '',
              onchange: (e: Event) => set((x) => (x.return = (e.target as HTMLInputElement).value || null)),
            })),
            h('label', {}, 'Target', stepper(ev.target, { min: 50, max: 20000, step: 25, prefix: '$' }, (v) => set((x) => (x.target = v)))),
          ),
        );
      }),
      h(
        'button',
        {
          class: 'btn',
          disabled: draft.events.length >= 10,
          onclick: () =>
            edit((d) =>
              d.events.push({ name: 'New trip', dest: Object.keys(d.destinations)[0] ?? 'MUC', depart: plusDays(180), return: plusDays(189), target: 900 }),
            ),
        },
        '+ Add a trip',
      ),
      h('h3', {}, 'How often'),
      row(
        'Check every',
        'Fewer checks, fewer searches',
        stepper(es.check_every_days, { min: 1, max: 30, step: 0.5, suffix: 'days' }, (v) => edit((d) => (d.event_settings.check_every_days = v))),
        `≈ ${est.serpapi.eventChecks}/month in all`,
      ),
      row(
        'Start checking',
        'Days before the trip (Google sells about 330 days out)',
        stepper(es.horizon_days, { min: 30, max: 365, step: 10, suffix: 'days' }, (v) => edit((d) => (d.event_settings.horizon_days = v))),
      ),
    ];
  }

  // ---- 5. Open jaws
  function openJawStep(est: UsageEstimate): Parts {
    const oj = draft.open_jaw;
    const returns = openJawReturns(draft, usageCtx.coords);
    const set = (fn: (o: FwConfig['open_jaw']) => void) => edit((d) => fn(d.open_jaw));
    const extra = h('input', { type: 'text', class: 'fw-code-input', placeholder: 'Code', maxlength: 3 });
    const addExtra = () => {
      const code = extra.value.trim().toUpperCase();
      if (/^[A-Z]{3}$/.test(code) && !oj.extra_return_from.includes(code)) set((o) => o.extra_return_from.push(code));
    };
    extra.addEventListener('keydown', (e) => e.key === 'Enter' && addExtra());
    return [
      intro(
        'Fly into one city and home from a nearby one. Priced from one-way cached fares (more lookups, no monthly cap); the best one gets one live search per run, taken out of the deal-check budget.',
      ),
      row('Look for open jaws', null, toggle(oj.enabled, (v) => set((o) => (o.enabled = v)), 'Open jaws'), oj.enabled ? `${est.travelpayouts.openJaw} lookups/run` : null),
      ...(oj.enabled
        ? [
            row('Nearby means within', null, stepper(oj.max_km, { min: 100, max: 3000, step: 100, suffix: 'km' }, (v) => set((o) => (o.max_km = v)))),
            h(
              'div',
              { class: 'fw-pairs' },
              ...(Object.keys(returns).length
                ? Object.entries(returns).map(([a, bs]) => h('div', {}, h('strong', {}, `Into ${a}`), `, home from ${bs.join(', ')}`))
                : [h('span', { class: 'fw-dim' }, 'No watched cities are this close to each other.')]),
            ),
            row('Trip length', 'Nights away', h(
              'div',
              { class: 'fw-inline' },
              stepper(oj.nights[0], { min: 1, max: 60, step: 1 }, (v) => set((o) => (o.nights = [v, Math.max(v, o.nights[1])]))),
              h('span', { class: 'fw-unit' }, 'to'),
              stepper(oj.nights[1], { min: 1, max: 60, step: 1 }, (v) => set((o) => (o.nights = [Math.min(v, o.nights[0]), v]))),
            )),
            row('Must save at least', 'Compared with the round trip', stepper(oj.min_saving, { min: 0, max: 1000, step: 25, prefix: '$' }, (v) => set((o) => (o.min_saving = v)))),
            row('Live-check the best one', '1 search a run when there is one', toggle(oj.live_check, (v) => set((o) => (o.live_check = v)), 'Open jaw live check')),
            h('h3', {}, 'Fly out of'),
            h(
              'div',
              { class: 'chips' },
              ...draft.origins.map((o) => {
                const on = oj.home.includes(o);
                return h(
                  'button',
                  {
                    class: `chip${on ? ' active' : ''}`,
                    onclick: () => set((x) => {
                      const next = on ? x.home.filter((c) => c !== o) : [...x.home, o];
                      if (next.length) x.home = next;
                    }),
                  },
                  o,
                );
              }),
            ),
            h('h3', {}, 'Also fly home from'),
            h(
              'div',
              { class: 'chips' },
              ...oj.extra_return_from.map((c) =>
                h('button', { class: 'chip active', onclick: () => set((o) => (o.extra_return_from = o.extra_return_from.filter((x) => x !== c))) }, `${c} ✕`),
              ),
              extra,
              h('button', { class: 'btn', onclick: addExtra }, 'Add'),
            ),
          ]
        : []),
    ];
  }

  // ---- 6. Alerts
  function alertsStep(): Parts {
    const a = draft.alerting;
    const n = draft.notify;
    const set = (fn: (x: FwConfig) => void) => edit(fn);
    return [
      intro('When a price counts as a deal and how loudly it alerts. None of this uses API searches.'),
      row('Deal when under the 30-day median by', 'Even if it is above your target', stepper(a.drop_vs_median, { min: 0.05, max: 0.9, step: 0.05, scale: 100, suffix: '%' }, (v) => set((d) => (d.alerting.drop_vs_median = v)))),
      row('Median covers', null, stepper(a.history_window_days, { min: 7, max: 120, step: 1, suffix: 'days' }, (v) => set((d) => (d.alerting.history_window_days = v)))),
      row('Needs at least', 'Days of history before the median counts', stepper(a.min_history_days, { min: 1, max: 60, step: 1, suffix: 'days' }, (v) => set((d) => (d.alerting.min_history_days = v)))),
      row('Alert again after', 'For the same city and month', stepper(a.realert_cooldown_days, { min: 0, max: 90, step: 1, suffix: 'days' }, (v) => set((d) => (d.alerting.realert_cooldown_days = v)))),
      row('…or sooner if it drops another', null, stepper(a.realert_drop, { min: 0, max: 0.5, step: 0.01, scale: 100, suffix: '%' }, (v) => set((d) => (d.alerting.realert_drop = v)))),
      row('Most alerts per run', null, stepper(a.max_alerts_per_run, { min: 1, max: 20, step: 1 }, (v) => set((d) => (d.alerting.max_alerts_per_run = v)))),
      h('h3', {}, 'Phone priority'),
      row('Urgent when under target by', null, stepper(n.urgent_below_target, { min: 0, max: 0.9, step: 0.05, scale: 100, suffix: '%' }, (v) => set((d) => (d.notify.urgent_below_target = v)))),
      row('High when under target by', null, stepper(n.high_below_target, { min: 0, max: 0.9, step: 0.05, scale: 100, suffix: '%' }, (v) => set((d) => (d.notify.high_below_target = v)))),
    ];
  }

  // ---- 7. Review
  function reviewStep(): Parts {
    const changes = describeChanges(saved, draft, placeName, money.format);
    // Check now runs the saved settings, whatever the draft says.
    const run = estimate(saved);
    return [
      changes.length
        ? h('ul', { class: 'fw-changes' }, ...changes.map((c) => h('li', {}, c)))
        : h('p', { class: 'fw-dim' }, 'Nothing changed yet.'),
      note ? h('p', { class: 'fw-note' }, note) : null,
      h('p', { class: 'fw-dim' }, 'Saved settings take effect at the next daily run (8:00 AM), or right away with Check now.'),
      h(
        'div',
        { class: 'fw-actions' },
        h(
          'button',
          { class: 'btn', disabled: busy, onclick: () => checkNow() },
          `Check now${!same(draft, saved) ? ' (saved settings)' : ''}`,
        ),
        versions > 0 && h('button', { class: 'btn btn-ghost', disabled: busy, onclick: () => undo() }, 'Undo last saved change'),
      ),
      h('small', { class: 'fw-dim' }, `Check now runs Farewatcher once: about ${run.travelpayouts.perRun} lookups and up to ${run.serpapi.perRun} searches, plus any event checks due. At most once an hour.`),
    ];
  }

  function saveButton(est: UsageEstimate, dirty: boolean) {
    const over = est.serpapi.level === 'over';
    return h(
      'button',
      {
        class: `btn ${over && confirmOver ? 'btn-danger' : 'btn-primary'}`,
        disabled: !dirty || busy,
        onclick: () => {
          if (over && !confirmOver) {
            confirmOver = true;
            note = `These settings could use ${est.serpapi.worst + est.serpapi.reserve} of ${est.serpapi.plan} searches a month. Tap again to save anyway.`;
            render();
            return;
          }
          void save();
        },
      },
      over && confirmOver ? 'Save anyway' : 'Save',
    );
  }

  async function save() {
    const changes: Partial<FwConfig> = {};
    for (const key of Object.keys(draft) as (keyof FwConfig)[]) {
      if (!same(draft[key], saved[key])) (changes as Record<string, unknown>)[key] = draft[key];
    }
    busy = true;
    note = 'Saving…';
    render();
    try {
      const r = await call<ConfigResponse>('PUT', '/api/fares/config', changes);
      saved = r.config;
      versions = r.versions;
      draft = clone(saved);
      note = 'Saved. Farewatcher uses these settings from its next run.';
      changed();
    } catch (err) {
      note = `Couldn't save: ${err instanceof Error ? err.message : String(err)}`;
    }
    busy = false;
    confirmOver = false;
    render();
  }

  async function undo() {
    busy = true;
    render();
    try {
      const r = await call<ConfigResponse>('POST', '/api/fares/config/undo');
      saved = r.config;
      versions = r.versions;
      draft = clone(saved);
      note = 'Went back to the settings from before the last save.';
      changed();
    } catch (err) {
      note = `Couldn't undo: ${err instanceof Error ? err.message : String(err)}`;
    }
    busy = false;
    render();
  }

  async function checkNow() {
    busy = true;
    note = 'Starting…';
    render();
    try {
      await call('POST', '/api/fares/check');
      note = 'Farewatcher is checking fares now. The tile updates when it finishes, in a minute or two.';
      changed();
    } catch (err) {
      note = err instanceof Error ? err.message : String(err);
    }
    busy = false;
    render();
  }

  render();
}

/** Plain sentences for what changed between two configs, for the review step. */
export function describeChanges(
  a: FwConfig,
  b: FwConfig,
  name: (code: string) => string,
  money: (n: number) => string,
): string[] {
  const out: string[] = [];
  const list = (xs: string[]) => xs.join(', ');
  const added = (x: string[], y: string[]) => y.filter((c) => !x.includes(c));
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  if (added(a.origins, b.origins).length) out.push(`Search from ${list(added(a.origins, b.origins))} too.`);
  if (added(b.origins, a.origins).length) out.push(`Stop searching from ${list(added(b.origins, a.origins))}.`);
  if (!same(a.compare_origins, b.compare_origins)) out.push(`Compare ${list(b.compare_origins) || 'no airports'} in alerts.`);
  if (!same(a.origin_allowance, b.origin_allowance)) {
    out.push(`Extra allowed: ${Object.entries(b.origin_allowance).map(([k, v]) => `${k} ${money(v)}`).join(', ') || 'none'}.`);
  }
  for (const [code, target] of Object.entries(b.destinations)) {
    if (!(code in a.destinations)) out.push(`Watch ${name(code)} at ${money(target)}.`);
    else if (a.destinations[code] !== target) out.push(`${name(code)} target ${money(a.destinations[code])} → ${money(target)}.`);
  }
  for (const code of Object.keys(a.destinations)) if (!(code in b.destinations)) out.push(`Stop watching ${name(code)}.`);
  if (a.months_ahead !== b.months_ahead) out.push(`Look ${b.months_ahead} months ahead (was ${a.months_ahead}).`);

  const lc = [a.live_check, b.live_check];
  if (lc[0].enabled !== lc[1].enabled) out.push(`Live Google checks ${lc[1].enabled ? 'on' : 'off'}.`);
  if (lc[0].max_searches_per_run !== lc[1].max_searches_per_run) out.push(`Live searches per run ${lc[0].max_searches_per_run} → ${lc[1].max_searches_per_run}.`);
  if (lc[0].reserve_searches !== lc[1].reserve_searches) out.push(`Reserve ${lc[0].reserve_searches} → ${lc[1].reserve_searches} searches.`);
  if (!same(lc[0].origins, lc[1].origins)) out.push(`Live-check from ${list(lc[1].origins)}.`);
  if (lc[0].require_live_confirmation !== lc[1].require_live_confirmation) {
    out.push(lc[1].require_live_confirmation ? 'Only alert when Google confirms.' : 'Alert even when Google does not confirm.');
  }
  if (lc[0].confirm_leeway !== lc[1].confirm_leeway) out.push(`Allowed over target ${pct(lc[0].confirm_leeway)} → ${pct(lc[1].confirm_leeway)}.`);
  if (lc[0].recheck_after_days !== lc[1].recheck_after_days) out.push(`Re-check after ${lc[1].recheck_after_days} days (was ${lc[0].recheck_after_days}).`);

  const evNames = (x: FwConfig) => x.events.map((e) => e.name);
  for (const e of b.events) {
    const old = a.events.find((x) => x.name === e.name);
    if (!old) out.push(`Add trip ${e.name}: ${e.dest} ${e.depart}${e.return ? ` to ${e.return}` : ''}, target ${money(e.target)}.`);
    else if (!same(old, e)) out.push(`Change trip ${e.name}.`);
  }
  for (const n of evNames(a)) if (!evNames(b).includes(n)) out.push(`Remove trip ${n}.`);
  if (!same(a.event_settings, b.event_settings)) {
    out.push(`Check trips every ${b.event_settings.check_every_days} days, starting ${b.event_settings.horizon_days} days out.`);
  }

  if (!same(a.open_jaw, b.open_jaw)) {
    out.push(
      b.open_jaw.enabled
        ? `Open jaws on: within ${b.open_jaw.max_km} km, ${b.open_jaw.nights[0]}–${b.open_jaw.nights[1]} nights, save ${money(b.open_jaw.min_saving)}+.`
        : 'Open jaws off.',
    );
  }
  if (!same(a.alerting, b.alerting)) out.push('Change when deals alert.');
  if (!same(a.notify, b.notify)) out.push(`Phone priority: urgent at ${pct(b.notify.urgent_below_target)} under, high at ${pct(b.notify.high_below_target)}.`);
  return out;
}

/** Quick edit from a destination's detail sheet: its target, or stop watching it. */
export async function openTargetEditor(code: string, label: string, ctx: Ctx): Promise<void> {
  const sheet = openSheet(`✏️ ${label}`, [h('div', { class: 'fw-loading' }, 'Loading…')]);
  let res: ConfigResponse;
  try {
    res = await call<ConfigResponse>('GET', '/api/fares/config');
  } catch (err) {
    sheet.body.replaceChildren(h('div', { class: 'fw-error' }, err instanceof Error ? err.message : String(err)));
    return;
  }
  const cfg = res.config;
  let target = cfg.destinations[code] ?? 700;
  let msg = '';
  const watched = code in cfg.destinations;
  const draw = () => {
    sheet.body.replaceChildren(
      h(
        'div',
        { class: 'fw' },
        row('Deal when a round trip is under', null, stepper(target, { min: 50, max: 20000, step: 25, prefix: '$' }, (v) => {
          target = v;
          draw();
        })),
        msg ? h('p', { class: 'fw-note' }, msg) : null,
        h(
          'div',
          { class: 'fw-actions' },
          watched && Object.keys(cfg.destinations).length > 1
            ? h('button', { class: 'btn btn-danger', onclick: () => void put(false) }, 'Stop watching')
            : null,
          h('button', { class: 'btn', onclick: () => sheet.close() }, 'Cancel'),
          h('button', { class: 'btn btn-primary', onclick: () => void put(true) }, 'Save'),
        ),
        h(
          'button',
          {
            class: 'btn btn-ghost fw-more',
            onclick: () => void openFaresSettings(ctx, 'Destinations'),
          },
          'All Farewatcher settings ›',
        ),
      ),
    );
  };
  const put = async (keep: boolean) => {
    const destinations = { ...cfg.destinations };
    if (keep) destinations[code] = target;
    else delete destinations[code];
    try {
      await call('PUT', '/api/fares/config', { destinations });
      changed();
      sheet.close();
    } catch (err) {
      msg = `Couldn't save: ${err instanceof Error ? err.message : String(err)}`;
      draw();
    }
  };
  draw();
}
