// The stocks UI pieces shared by tiles and sheets: the detail view (price,
// chart, alerts for one symbol), the watchlist editor, the alert editor and
// the sounds & data settings.
import { h } from '../../core/dom';
import { openSheet } from '../../core/sheet';
import { preview, stopPreview, toneName, TONES } from '../../core/tones';
import {
  describeAlert,
  money,
  signed,
  signedPct,
  stocks,
  trend,
  type AlertKind,
  type Range,
  type StockAlert,
} from '../../core/stocks';
import { drawChart, rangeChange } from './chart';

const fail = (err: unknown) => console.error(err);

export const RANGES: { id: Range; label: string; long: string }[] = [
  { id: '1d', label: '1D', long: 'today' },
  { id: '5d', label: '5D', long: 'past 5 days' },
  { id: '1m', label: '1M', long: 'past month' },
  { id: '6m', label: '6M', long: 'past 6 months' },
  { id: '1y', label: '1Y', long: 'past year' },
  { id: '5y', label: '5Y', long: 'past 5 years' },
];

const POPULAR = ['SPY', 'QQQ', 'DIA', 'VTI', 'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA'];

/** "Updated 2:41 PM · Market open" plus any problem the server reported. */
export function statusText(): string {
  const s = stocks.state;
  if (!s) return 'Loading…';
  const parts = [s.marketOpen ? 'Market open' : 'Market closed'];
  if (s.updated) parts.push(`updated ${new Date(s.updated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
  return parts.join(' · ');
}

// ---- Detail: one symbol ---------------------------------------------------

interface DetailOpts {
  range: Range;
  /** Reopens whatever sheet showed this detail, after an editor closes. */
  back?: () => void;
}

/** Renders the detail view for symbol into el. Returns a cleanup function. */
export function renderDetail(el: HTMLElement, symbol: string, opts: DetailOpts): () => void {
  let range = opts.range;
  let chartCleanup = () => {};
  let renderKey = '';
  let historyKey = '';
  let token = 0;
  const back = opts.back ?? (() => {});

  const title = h('div', { class: 'stk-d-title' });
  const priceEl = h('div', { class: 'stk-d-price' });
  const changeEl = h('div', { class: 'stk-d-change' });
  const rangeChangeEl = h('div', { class: 'stk-d-range-change' });
  const chips = h('div', { class: 'stk-ranges' });
  const chart = h('div', { class: 'stk-d-chart' });
  const alertsEl = h('div', { class: 'stk-d-alerts' });
  el.append(
    h(
      'div',
      { class: 'stk-detail' },
      h('div', { class: 'stk-d-head' }, h('div', { class: 'stk-d-left' }, title, priceEl), h('div', { class: 'stk-d-right' }, changeEl, rangeChangeEl)),
      chips,
      chart,
      alertsEl,
    ),
  );

  const renderChips = () =>
    chips.replaceChildren(
      ...RANGES.map((r) =>
        h('button', { class: `chip stk-range${r.id === range ? ' active' : ''}`, onclick: () => ((range = r.id), renderChips(), void loadChart()) }, r.label),
      ),
    );

  async function loadChart() {
    const my = ++token;
    const s = stocks.state;
    historyKey = `${range}|${s?.quotes[symbol]?.time ?? ''}|${JSON.stringify(alertsFor(symbol))}`;
    if (!chart.firstChild) chart.replaceChildren(h('p', { class: 'stk-chart-msg' }, 'Loading chart…'));
    try {
      const hist = await stocks.getHistory(symbol, range);
      if (my !== token) return;
      chartCleanup();
      chartCleanup = drawChart(chart, hist, alertsFor(symbol));
      const ch = rangeChange(hist);
      const long = RANGES.find((r) => r.id === range)!.long;
      rangeChangeEl.textContent = ch && range !== '1d' ? `${signedPct(ch.pct)} ${long}` : '';
      rangeChangeEl.dataset.trend = ch ? trend(ch.abs) : 'flat';
    } catch (err) {
      if (my !== token) return;
      chartCleanup();
      chartCleanup = () => {};
      chart.replaceChildren(h('p', { class: 'stk-chart-msg' }, `Couldn't load the chart: ${(err as Error).message}`));
    }
  }

  const render = () => {
    const s = stocks.state;
    if (!s) return;
    const q = s.quotes[symbol];
    const key = JSON.stringify([q, alertsFor(symbol)]);
    if (key === renderKey) return;
    renderKey = key;
    title.replaceChildren(h('strong', {}, symbol), q?.name && q.name !== symbol ? h('span', {}, q.name) : '');
    priceEl.textContent = q?.price != null ? money(q.price, q.currency) : '—';
    changeEl.textContent = q?.change != null ? `${signed(q.change)} (${signedPct(q.changePct)}) today` : q?.error ?? '';
    changeEl.dataset.trend = trend(q?.change ?? null);

    const list = alertsFor(symbol);
    alertsEl.replaceChildren(
      ...list.map((a) =>
        h(
          'button',
          { class: `chip stk-alert-chip${a.enabled ? '' : ' off'}`, onclick: () => openAlertEditor(a, symbol, back) },
          `🔔 ${describeAlert(a, q?.currency)}${a.repeat === 'daily' ? ' · daily' : ''}${a.enabled ? '' : ' · off'}`,
        ),
      ),
      h('button', { class: 'chip chip-accent', onclick: () => openAlertEditor(null, symbol, back) }, '＋ Alert'),
    );
    // New price or alert levels: refresh the chart too (history is cached briefly).
    if (historyKey !== `${range}|${q?.time ?? ''}|${JSON.stringify(list)}`) void loadChart();
  };

  renderChips();
  const off = stocks.subscribe(render);
  return () => {
    token++;
    off();
    chartCleanup();
  };
}

const alertsFor = (symbol: string): StockAlert[] => stocks.state?.alerts.filter((a) => a.symbol === symbol) ?? [];

/** Price, chart and alerts for one symbol in a bottom sheet. */
export function openDetailSheet(symbol: string, range: Range = '1d') {
  const body = h('div', { class: 'stk-sheet-detail' });
  let cleanup = () => {};
  openSheet(symbol, [body], { onClose: () => cleanup() });
  cleanup = renderDetail(body, symbol, { range, back: () => openDetailSheet(symbol, range) });
}

// ---- Watchlist editor -------------------------------------------------------

export function openWatchlist(back: () => void = () => {}) {
  const list = h('div', { class: 'stk-wl' });
  const input = h('input', {
    type: 'text',
    class: 'stk-input',
    placeholder: 'Ticker, e.g. AAPL',
    maxlength: 15,
    autocapitalize: 'characters',
    onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && add(input.value),
  });
  const status = h('p', { class: 'menu-status' });
  const quick = h('div', { class: 'chips' });

  const symbols = () => stocks.state?.symbols ?? [];
  const save = (next: string[]) => {
    status.textContent = '';
    stocks.setSymbols(next).catch((err) => (status.textContent = (err as Error).message));
  };
  function add(raw: string) {
    const items = raw.split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (!items.length) return;
    input.value = '';
    save([...symbols(), ...items.filter((x) => !symbols().includes(x))]);
  }
  const move = (i: number, d: number) => {
    const next = [...symbols()];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    save(next);
  };

  const render = () => {
    const s = stocks.state;
    if (!s) return;
    list.replaceChildren(
      ...(s.symbols.length
        ? s.symbols.map((sym, i) => {
            const q = s.quotes[sym];
            return h(
              'div',
              { class: 'stk-wl-row' },
              h('div', { class: 'stk-wl-name' }, h('strong', {}, sym), h('small', {}, q?.error ? `⚠️ ${q.error}` : q?.name ?? 'Waiting for a price…')),
              h('button', { class: 'btn btn-ghost', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(i, -1) }, '▲'),
              h('button', { class: 'btn btn-ghost', 'aria-label': 'Move down', disabled: i === s.symbols.length - 1, onclick: () => move(i, 1) }, '▼'),
              h('button', { class: 'btn btn-ghost', 'aria-label': `Remove ${sym}`, onclick: () => save(s.symbols.filter((x) => x !== sym)) }, '✕'),
            );
          })
        : [h('p', { class: 'empty' }, 'No tickers yet')]),
    );
    quick.replaceChildren(
      ...POPULAR.filter((p) => !s.symbols.includes(p)).map((p) => h('button', { class: 'chip', onclick: () => add(p) }, `＋ ${p}`)),
    );
  };

  let off = () => {};
  openSheet('Watchlist', [
    list,
    h('div', { class: 'stk-wl-add' }, input, h('button', { class: 'btn btn-primary', onclick: () => add(input.value) }, 'Add')),
    status,
    h('h3', {}, 'Quick add'),
    quick,
    h('p', { class: 'menu-text dim' }, 'Stocks and ETFs on US exchanges by ticker. Indexes start with ^ on the no-key data source (^GSPC); Twelve Data lists other markets as e.g. SHOP:TSX.'),
  ], {
    onClose: () => {
      off();
      back();
    },
  });
  off = stocks.subscribe(render);
}

// ---- Alert editor -----------------------------------------------------------

const KIND_LABELS: Record<AlertKind, string> = {
  above: '📈 Price above',
  below: '📉 Price below',
  up: '🚀 Up % in a day',
  down: '🔻 Down % in a day',
};

export function openAlertEditor(existing: StockAlert | null, symbol: string, back: () => void = () => {}) {
  const q = stocks.state?.quotes[symbol];
  const a = {
    kind: existing?.kind ?? ('above' as AlertKind),
    value: existing?.value ?? null as number | null,
    repeat: existing?.repeat ?? ('once' as 'once' | 'daily'),
  };
  const isPct = () => a.kind === 'up' || a.kind === 'down';
  const kinds = h('div', { class: 'chips' });
  const repeat = h('div', { class: 'chips' });
  const quick = h('div', { class: 'chips' });
  const valueLabel = h('span', {});
  const value = h('input', {
    type: 'text',
    inputmode: 'decimal',
    class: 'stk-value',
    value: a.value !== null ? String(a.value) : '',
    oninput: () => {
      const n = Number(value.value.replace(/[$,%\s]/g, ''));
      a.value = value.value.trim() && Number.isFinite(n) && n > 0 ? n : null;
      saveBtn.disabled = a.value === null;
    },
  });
  const note = h('input', { type: 'text', class: 'stk-input', placeholder: 'Note (optional)', maxlength: 80, value: existing?.note ?? '' });
  const status = h('p', { class: 'menu-status' });
  const saveBtn = h('button', { class: 'btn btn-primary' }, 'Save');

  const setValue = (n: number) => {
    a.value = Number(n.toFixed(isPct() ? 1 : n < 1 ? 4 : 2));
    value.value = String(a.value);
    saveBtn.disabled = false;
  };

  const show = () => {
    kinds.replaceChildren(
      ...(Object.keys(KIND_LABELS) as AlertKind[]).map((k) =>
        h(
          'button',
          {
            class: `chip${k === a.kind ? ' active' : ''}`,
            onclick: () => {
              const wasPct = isPct();
              a.kind = k;
              if (wasPct !== isPct()) ((a.value = null), (value.value = ''), (saveBtn.disabled = true));
              show();
            },
          },
          KIND_LABELS[k],
        ),
      ),
    );
    valueLabel.textContent = isPct() ? 'Percent move (vs. yesterday’s close)' : `Price${q ? ` (now ${money(q.price, q.currency)})` : ''}`;
    if (isPct()) {
      quick.replaceChildren(...[2, 3, 5, 10].map((p) => h('button', { class: 'chip', onclick: () => setValue(p) }, `${p}%`)));
    } else if (q?.price) {
      const steps = a.kind === 'above' ? [1, 2, 5, 10] : [-1, -2, -5, -10];
      quick.replaceChildren(
        ...steps.map((p) => h('button', { class: 'chip', onclick: () => setValue(q.price * (1 + p / 100)) }, `${p > 0 ? '+' : ''}${p}% · ${money(q.price * (1 + p / 100), q.currency)}`)),
      );
    } else quick.replaceChildren();
    repeat.replaceChildren(
      ...([
        ['once', 'Once, then turn off'],
        ['daily', 'Once every trading day'],
      ] as const).map(([id, label]) => h('button', { class: `chip${a.repeat === id ? ' active' : ''}`, onclick: () => ((a.repeat = id), show()) }, label)),
    );
  };

  let done = false;
  saveBtn.disabled = a.value === null;
  saveBtn.onclick = () => {
    if (a.value === null) return;
    const body = { kind: a.kind, value: a.value, repeat: a.repeat, note: note.value };
    const req = existing ? stocks.updateAlert(existing.id, { ...body, enabled: true }) : stocks.createAlert({ symbol, ...body });
    saveBtn.disabled = true;
    req.then(
      () => {
        done = true;
        sheet.close();
        back();
      },
      (err) => {
        status.textContent = (err as Error).message;
        saveBtn.disabled = false;
      },
    );
  };

  let armed = false;
  const del = h(
    'button',
    {
      class: 'btn btn-danger',
      onclick: () => {
        if (!existing) return;
        if (!armed) {
          armed = true;
          del.textContent = 'Tap again to delete';
          return;
        }
        done = true;
        stocks.deleteAlert(existing.id).then(back, fail);
        sheet.close();
      },
    },
    'Delete',
  );

  const fired = existing?.firedAt
    ? h('p', { class: 'menu-text dim' }, `Last went off ${new Date(existing.firedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${existing.firedPrice ? ` at ${money(existing.firedPrice, q?.currency)}` : ''}.`)
    : null;

  const sheet = openSheet(`${existing ? 'Edit' : 'New'} alert · ${symbol}`, [
    h('h3', {}, 'When'),
    kinds,
    h('label', { class: 'field' }, valueLabel, value),
    quick,
    h('h3', {}, 'Repeat'),
    repeat,
    note,
    ...(fired ? [fired] : []),
    status,
    h(
      'div',
      { class: 'menu-actions' },
      existing && del,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => sheet.close() }, 'Cancel'),
      saveBtn,
    ),
  ], { onClose: () => !done && back() });
  show();
}

// ---- All alerts -------------------------------------------------------------

export function openAlertsList(back: () => void = () => {}) {
  const body = h('div', {});
  const reopen = () => openAlertsList(back);
  const render = () => {
    const s = stocks.state;
    if (!s) return;
    const alerts = [...s.alerts].sort((x, y) => x.symbol.localeCompare(y.symbol));
    body.replaceChildren(
      ...(alerts.length
        ? alerts.map((a) =>
            h(
              'div',
              { class: `stk-al-row${a.enabled ? '' : ' off'}` },
              h(
                'button',
                { class: 'stk-al-main', onclick: () => openAlertEditor(a, a.symbol, reopen) },
                h('span', { class: 'stk-al-sym' }, a.symbol),
                h('span', { class: 'stk-al-meta' }, [describeAlert(a, s.quotes[a.symbol]?.currency), a.repeat === 'daily' ? 'every trading day' : 'once', a.note].filter(Boolean).join(' · ')),
              ),
              h('input', {
                type: 'checkbox',
                class: 'toggle',
                checked: a.enabled,
                'aria-label': 'On',
                onchange: (e: Event) => void stocks.updateAlert(a.id, { enabled: (e.target as HTMLInputElement).checked }).catch(fail),
              }),
            ),
          )
        : [h('p', { class: 'empty' }, 'No alerts yet. Open a ticker and tap ＋ Alert.')]),
    );
  };
  let off = () => {};
  openSheet('Price alerts', [body], {
    onClose: () => {
      off();
      back();
    },
  });
  off = stocks.subscribe(render);
}

// ---- Sounds & data ----------------------------------------------------------

export function openStockSettings(back: () => void = () => {}) {
  const body = h('div', {});
  const save = (patch: Parameters<typeof stocks.saveSettings>[0]) => void stocks.saveSettings(patch).catch(fail);
  const chips = <T extends number | string>(values: T[], current: T, text: (v: T) => string, pick: (v: T) => void) =>
    h('div', { class: 'chips' }, ...values.map((v) => h('button', { class: `chip${v === current ? ' active' : ''}`, onclick: () => pick(v) }, text(v))));

  let dragging = false;
  const render = () => {
    const s = stocks.state;
    if (!s || dragging) return;
    const st = s.settings;
    const volumeLabel = h('span', { class: 'snd-volume-value' }, `${st.volume}%`);
    const volume = h('input', {
      type: 'range',
      class: 'snd-volume',
      min: 0,
      max: 100,
      step: 5,
      value: String(st.volume),
      oninput: () => ((dragging = true), (volumeLabel.textContent = `${volume.value}%`)),
      onchange: () => {
        dragging = false;
        save({ volume: Number(volume.value) });
        preview(st.sound, Number(volume.value));
      },
    });
    const source =
      s.provider === 'twelvedata'
        ? `Prices from Twelve Data (free plan): ${s.credits?.used ?? 0} of ${s.credits?.limit ?? 800} credits used today. Refresh slows down on its own to stay in the free limit.`
        : 'Prices from Yahoo Finance (no key; unofficial, so it can break or throttle). For a sturdier feed, add a free Twelve Data key with deploy\\stocks.ps1; see docs/STOCKS.md.';
    body.replaceChildren(
      h('h3', {}, 'Alert sound'),
      chips(TONES.map((t) => t.id), st.sound, (id) => `${id === st.sound ? '♪ ' : ''}${toneName(id)}`, (id) => {
        save({ sound: id });
        preview(id, st.volume);
      }),
      h('h3', {}, 'Volume'),
      h('div', { class: 'snd-volume-row' }, h('span', {}, '🔈'), volume, h('span', {}, '🔊'), volumeLabel),
      h('h3', {}, 'Play the sound'),
      chips([1, 2, 3, 5, 10], st.repeats, (n) => (n === 1 ? 'Once' : `${n} times`), (n) => save({ repeats: n })),
      h('h3', {}, 'Refresh prices every'),
      chips([1, 2, 5, 10, 15], st.refreshMinutes, (m) => `${m} min`, (m) => save({ refreshMinutes: m })),
      h('p', { class: 'menu-text dim' }, source),
      s.error ? h('p', { class: 'menu-text stk-error' }, `⚠️ ${s.error}`) : '',
      h('button', { class: 'btn btn-wide', onclick: () => void stocks.testAlert().catch(fail) }, '▶ Test alert'),
      h('button', { class: 'btn btn-wide', onclick: () => void stocks.refresh().catch(fail) }, '↻ Refresh prices now'),
    );
  };
  let off = () => {};
  openSheet('Stocks settings', [body], {
    onClose: () => {
      stopPreview();
      off();
      back();
    },
  });
  off = stocks.subscribe(render);
}
