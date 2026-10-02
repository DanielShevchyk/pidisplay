import { h } from '../../core/dom';
import { defineWidget, type Placement } from '../../core/types';
import { price, signedPct, stocks, trend, type Quote, type Range } from '../../core/stocks';
import { sparkline } from './chart';
import { openAlertsList, openDetailSheet, openStockSettings, openWatchlist, RANGES, renderDetail, statusText } from './panel';
import './stocks.css';

interface StocksConfig {
  /** Comma-separated tickers for this tile; blank shows the whole watchlist. */
  symbols: string;
  range: Range;
  [key: string]: unknown;
}

const BAR_ROTATE_MS = 6000;

function tileSymbols(config: StocksConfig): string[] {
  const picked = String(config.symbols ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return picked.length ? picked : stocks.state?.symbols ?? [];
}

/** Today's sparkline: recent daily closes plus the live price. */
function sparkValues(q: Quote | undefined): number[] {
  if (!q) return [];
  return [...(q.spark ?? []), q.price];
}

export default defineWidget<StocksConfig>({
  type: 'stocks',
  name: 'Stocks',
  description: 'Watchlist with price charts and price alerts',
  icon: '📈',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'large',
  supportsBar: true,
  defaultConfig: { symbols: '', range: '1d' },
  settings: [
    { key: 'symbols', label: 'Tickers on this tile (blank = whole watchlist)', type: 'text', placeholder: 'AAPL, MSFT' },
    { key: 'range', label: 'Chart range', type: 'select', options: RANGES.map((r) => ({ value: r.id, label: r.label })) },
  ],

  mount(el, { config, placement }) {
    if (placement === 'bar') return mountBar(el, config);
    if (placement === 'small') return mountSmall(el, config);
    return mountList(el, config, placement);
  },
});

function mountBar(el: HTMLElement, config: StocksConfig) {
  let i = 0;
  const root = h('button', { class: 'stk-bar', onclick: () => current() && openDetailSheet(current()!, config.range) });
  el.append(root);
  const current = () => {
    const list = tileSymbols(config);
    return list.length ? list[i % list.length] : null;
  };
  const render = () => {
    const sym = current();
    const q = sym ? stocks.state?.quotes[sym] : undefined;
    if (!sym || !q) {
      root.textContent = '📈';
      return;
    }
    root.dataset.trend = trend(q.change);
    root.replaceChildren(h('strong', {}, sym), ` ${price(q.price)} `, h('span', { class: 'stk-chg' }, `${arrow(q.change)}${signedPct(q.changePct).replace(/^[+−]/, '')}`));
  };
  const off = stocks.subscribe(render);
  const timer = window.setInterval(() => {
    i++;
    render();
  }, BAR_ROTATE_MS);
  return {
    destroy() {
      off();
      clearInterval(timer);
    },
  };
}

const arrow = (n: number | null) => (n === null || n === 0 ? '' : n > 0 ? '▲' : '▼');

function mountSmall(el: HTMLElement, config: StocksConfig) {
  const root = h('button', { class: 'stk-small', onclick: () => sym() && openDetailSheet(sym()!, config.range) });
  el.append(root);
  const sym = () => tileSymbols(config)[0] ?? null;
  const render = () => {
    const s = sym();
    if (!stocks.state) return root.replaceChildren(h('div', { class: 'stk-msg' }, 'Loading…'));
    if (!s) return root.replaceChildren(h('div', { class: 'stk-msg' }, '📈 Add tickers in ⚙'));
    const q = stocks.state.quotes[s];
    root.dataset.trend = trend(q?.change ?? null);
    root.replaceChildren(
      h('div', { class: 'stk-small-sym' }, s),
      h('div', { class: 'stk-small-price' }, q ? price(q.price) : '—'),
      h('div', { class: 'stk-small-chg' }, q ? `${arrow(q.change)} ${signedPct(q.changePct)}` : notWatched(s) ? 'Not on the watchlist' : 'Waiting…'),
      sparkline(sparkValues(q), q?.prevClose ?? null),
    );
  };
  const off = stocks.subscribe(render);
  render();
  return { destroy: off };
}

const notWatched = (sym: string) => Boolean(stocks.state && !stocks.state.symbols.includes(sym));

function mountList(el: HTMLElement, config: StocksConfig, placement: Placement) {
  const split = placement === 'large' || placement === 'xlarge' || placement === 'full';
  const status = h('span', { class: 'stk-status' });
  const rows = h('div', { class: 'stk-rows' });
  const detail = h('div', { class: 'stk-split-detail' });
  let selected: string | null = null;
  let detailCleanup = () => {};
  let rowsKey = '';

  const head = h(
    'div',
    { class: 'stk-head' },
    status,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn btn-ghost stk-head-btn', 'aria-label': 'Watchlist', onclick: () => openWatchlist() }, '✎'),
    h('button', { class: 'btn btn-ghost stk-head-btn', 'aria-label': 'Price alerts', onclick: () => openAlertsList() }, '🔔'),
    h('button', { class: 'btn btn-ghost stk-head-btn', 'aria-label': 'Stocks settings', onclick: () => openStockSettings() }, '⚙'),
  );
  el.append(
    h('div', { class: `stk size-${placement}${split ? ' stk-split' : ''}` }, h('div', { class: 'stk-side' }, head, rows), split && detail),
  );

  const select = (sym: string) => {
    if (!split) return openDetailSheet(sym, config.range);
    if (sym === selected) return;
    selected = sym;
    detailCleanup();
    detail.replaceChildren();
    detailCleanup = renderDetail(detail, sym, { range: config.range });
    rowsKey = '';
    render();
  };

  const render = () => {
    const s = stocks.state;
    status.textContent = statusText();
    status.classList.toggle('warn', Boolean(s?.error));
    if (s?.error) status.textContent = `⚠️ ${s.error}`;
    if (!s) return;
    const list = tileSymbols(config);
    const key = JSON.stringify([list, list.map((x) => s.quotes[x]), selected, s.symbols]);
    if (key === rowsKey) return;
    rowsKey = key;
    if (!list.length) {
      rows.replaceChildren(h('button', { class: 'stk-empty', onclick: () => openWatchlist() }, '📈 No tickers yet. Tap to add some.'));
      return;
    }
    rows.replaceChildren(...list.map((sym) => row(sym, s.quotes[sym])));
    if (split && (!selected || !list.includes(selected))) select(list[0]);
  };

  function row(sym: string, q: Quote | undefined): HTMLElement {
    const missing = notWatched(sym);
    return h(
      'button',
      {
        class: `stk-row${sym === selected ? ' active' : ''}`,
        'data-trend': trend(q?.change ?? null),
        onclick: () => (missing ? void stocks.setSymbols([...(stocks.state?.symbols ?? []), sym]).catch(console.error) : select(sym)),
      },
      h('span', { class: 'stk-row-sym' }, h('strong', {}, sym), h('small', {}, missing ? 'Tap to add to the watchlist' : q?.error && !q.price ? `⚠️ ${q.error}` : q?.name ?? '')),
      sparkline(sparkValues(q), q?.prevClose ?? null),
      h(
        'span',
        { class: 'stk-row-px' },
        h('strong', {}, q?.price != null ? price(q.price) : '—'),
        h('small', { class: 'stk-chg' }, q?.changePct != null ? signedPct(q.changePct) : ''),
      ),
    );
  }

  const off = stocks.subscribe(render);
  // Keeps "updated" fresh between polls.
  const timer = window.setInterval(render, 30000);
  render();
  return {
    destroy() {
      off();
      clearInterval(timer);
      detailCleanup();
    },
  };
}
