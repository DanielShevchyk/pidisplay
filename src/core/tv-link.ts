// Linking PiDisplay to an LG webOS TV (server/lgtv.js). One linked TV is shared by
// the Spotify widget (to play on it) and the TV remote widget.
import { call } from './api';
import { h } from './dom';

export interface TvStatus {
  linked: boolean;
  name: string | null;
  ip: string | null;
  canWake: boolean;
}

function row(iconText: string, label: string, tag: string | null, onclick: (() => void) | null) {
  return h(
    'li',
    {},
    h(
      'button',
      { class: 'conn-row', disabled: !onclick, onclick: onclick ?? undefined },
      h('span', { class: 'conn-icon' }, iconText),
      h('span', { class: 'conn-name' }, label),
      tag ? h('span', { class: 'conn-tag' }, tag) : null,
    ),
  );
}

/**
 * Draws the "Link my LG TV" steps into body (a sheet's body): search the network,
 * pick a TV or type its address, then accept the prompt on the TV. back gets the new
 * status, or null when the person backed out.
 */
export function showTvLink(body: HTMLElement, back: (status: TvStatus | null) => void) {
  let found: { ip: string; name: string; model: string }[] | null = null;
  let busy = 'Looking for LG TVs…';
  let error = '';

  const link = async (ip: string, name?: string) => {
    busy = 'Look at the TV and choose Accept (or Yes) with its remote…';
    error = '';
    render();
    try {
      back(await call<TvStatus>('POST', '/api/tv/link', { ip, name }));
    } catch (err) {
      busy = '';
      error = (err as Error).message;
      render();
    }
  };

  const input = h('input', { type: 'text', class: 'tv-link-input', placeholder: 'TV address, e.g. 192.168.1.50', inputmode: 'decimal', autocomplete: 'off' });
  const render = () => {
    if (!body.isConnected) return;
    body.replaceChildren(
      h(
        'div',
        // Not .spt-sheet: the Speakers sheet redraws itself whenever it finds that class.
        { class: 'tv-link' },
        h('div', { class: 'conn-head' }, h('button', { class: 'btn btn-ghost', onclick: () => back(null), 'aria-label': 'Back' }, '‹ Back'), h('h3', {}, 'Link my LG TV'), h('span')),
        busy ? h('p', { class: 'conn-status' }, busy) : null,
        error ? h('p', { class: 'conn-error' }, error) : null,
        found?.length
          ? h('ul', { class: 'conn-list' }, ...found.map((t) => row('📺', t.model && t.model !== t.name ? `${t.name} (${t.model})` : t.name, t.ip, busy ? null : () => void link(t.ip, t.name))))
          : null,
        found && !found.length && !busy ? h('p', { class: 'conn-hint' }, 'No LG TV answered. Make sure it is switched on and on the same network, then search again or type its address (TV Settings > General > Network).') : null,
        found && !busy ? h('button', { class: 'btn', onclick: () => void search() }, 'Search again') : null,
        found && !busy ? h('div', { class: 'tv-link-search' }, input, h('button', { class: 'btn btn-primary', onclick: () => void link(input.value.trim()) }, 'Link')) : null,
      ),
    );
  };

  const search = async () => {
    busy = 'Looking for LG TVs…';
    error = '';
    render();
    try {
      found = (await call<{ tvs: { ip: string; name: string; model: string }[] }>('POST', '/api/tv/find')).tvs;
    } catch (err) {
      found = [];
      error = (err as Error).message;
    }
    busy = '';
    render();
  };
  void search();
}
