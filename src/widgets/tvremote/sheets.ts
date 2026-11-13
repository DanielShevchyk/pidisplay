// The full remote (a sheet with every page: buttons, apps and inputs, number pad,
// touchpad and typing) and the link step, which reuses the shared LG TV link flow.
import { h } from '../../core/dom';
import { openSheet } from '../../core/sheet';
import { showTvLink } from '../../core/tv-link';
import { icon } from './icons';
import { remote } from './store';
import { appButton, mountRemote, Parts } from './view';

export type SheetTab = 'remote' | 'apps' | 'numbers' | 'touchpad' | 'type';

const TABS: [SheetTab, string][] = [
  ['remote', 'Remote'],
  ['apps', 'Apps & inputs'],
  ['numbers', 'Numbers'],
  ['touchpad', 'Touchpad'],
  ['type', 'Type'],
];

export function openLinkSheet() {
  const sheet = openSheet('Link my LG TV', []);
  showTvLink(sheet.body, (status) => {
    sheet.close();
    if (status) {
      remote.forgetApps();
      void remote.refresh();
    }
  });
}

export function openRemoteSheet(start: SheetTab = 'remote') {
  if (!remote.state?.linked) return openLinkSheet();
  let tab = start;
  let cleanup: (() => void) | null = null;
  let off: (() => void) | null = null;
  const sheet = openSheet(remote.state?.name ?? 'TV remote', [], { onClose: () => (cleanup?.(), off?.()) });
  const chips = h('div', { class: 'chips tvr-tabs' });
  const page = h('div', { class: 'tvr-sheet-page' });
  const error = h('div', { class: 'tvr-error tvr-sheet-error', role: 'status' });
  off = remote.subscribeQuiet(() => {
    error.textContent = remote.error;
    error.classList.toggle('show', Boolean(remote.error));
  });

  const show = () => {
    cleanup?.();
    chips.replaceChildren(
      ...TABS.map(([t, label]) =>
        h('button', { class: `chip${t === tab ? ' active' : ''}`, onclick: () => ((tab = t), show()) }, label),
      ),
    );
    page.replaceChildren();
    const parts = new Parts();
    let extra: (() => void) | null = null;
    if (tab === 'remote') {
      const box = h('div', { class: 'tvr-sheet-remote' });
      page.append(box);
      extra = mountRemote(box, 'sheet');
    } else if (tab === 'apps') page.append(appsPage(parts));
    else if (tab === 'numbers') page.append(numbersPage(parts));
    else if (tab === 'touchpad') page.append(touchpadPage(parts));
    else page.append(typePage());
    cleanup = () => {
      extra?.();
      parts.destroy();
    };
  };

  sheet.body.append(h('div', { class: 'tvr-sheet' }, chips, page, error));
  show();
}

function appsPage(parts: Parts): HTMLElement {
  const box = h('div', { class: 'tvr-apps-page' });
  let shown = '';
  const paint = () => {
    const key = `${JSON.stringify(remote.apps)}|${remote.state?.appId}|${remote.appsError}`;
    if (key === shown) return;
    shown = key;
    if (!remote.apps) {
      box.replaceChildren(h('p', { class: 'tvr-hint' }, remote.appsError || 'Asking the TV for its apps…'));
      return;
    }
    const { apps, inputs } = remote.apps;
    box.replaceChildren(
      h(
        'div',
        {},
        inputs.length ? h('h3', { class: 'tvr-section' }, 'Inputs') : null,
        inputs.length
          ? h(
            'div',
            { class: 'chips' },
            ...inputs.map((i) =>
              h(
                'button',
                { class: `chip tvr-input${i.connected ? '' : ' dim'}`, onclick: () => void remote.send({ action: 'input', id: i.id }).then((ok) => ok && void remote.refresh()) },
                icon('input'),
                i.label,
              ),
            ),
          )
          : null,
      ),
      h('div', { class: 'tvr-section-row' }, h('h3', { class: 'tvr-section' }, 'Apps'), h('button', { class: 'btn btn-ghost', onclick: () => void remote.loadApps(true) }, icon('refresh'), ' Refresh')),
      h('div', { class: 'tvr-apps tvr-apps-all' }, ...apps.map((a) => appButton(a, a.id === remote.state?.appId))),
    );
  };
  parts.onDestroy(remote.subscribeQuiet(paint));
  void remote.loadApps();
  paint();
  return box;
}

function numbersPage(parts: Parts): HTMLElement {
  const n = (k: string) => parts.key(k, k, k, 'tvr-num');
  const colour = (k: string) => parts.key(k, '', `${k.toLowerCase()} button`, `tvr-colour tvr-${k.toLowerCase()}`);
  return h(
    'div',
    { class: 'tvr-numbers' },
    h(
      'div',
      { class: 'tvr-numpad' },
      ...'123456789'.split('').map(n),
      parts.key('DASH', '–', 'Dash', 'tvr-num'),
      n('0'),
      parts.key('ENTER', 'OK', 'OK', 'tvr-num tvr-num-ok'),
    ),
    h(
      'div',
      { class: 'tvr-num-side' },
      h('div', { class: 'tvr-row' }, colour('RED'), colour('GREEN'), colour('YELLOW'), colour('BLUE')),
      h('div', { class: 'tvr-row' }, parts.key('GUIDE', 'Guide', 'Guide'), parts.key('LIST', 'List', 'Channel list')),
      h('div', { class: 'tvr-row' }, parts.key('INFO', 'Info', 'Info'), parts.key('EXIT', 'Exit', 'Exit')),
      h('div', { class: 'tvr-row' }, parts.key('BACK', 'back', 'Back'), parts.key('HOME', 'home', 'Home')),
    ),
  );
}

/** A trackpad for the TV's pointer: drag to move, tap to click, the strip on the right scrolls. */
function touchpadPage(parts: Parts): HTMLElement {
  const pad = h('div', { class: 'tvr-pad' }, h('span', { class: 'tvr-pad-hint' }, 'Drag to move the pointer, tap to click'));
  const strip = h('div', { class: 'tvr-pad-strip' }, icon('up'), icon('down'));
  // Moves are summed and sent at most every 40 ms, one request at a time.
  let dx = 0;
  let dy = 0;
  let scroll = 0;
  let sending = false;
  const flush = async () => {
    if (sending) return;
    sending = true;
    while (dx || dy || scroll) {
      const [x, y, sc] = [dx, dy, scroll];
      dx = dy = scroll = 0;
      if (x || y) await remote.send({ action: 'move', dx: x, dy: y });
      if (sc) await remote.send({ action: 'scroll', dy: sc });
      await new Promise((r) => setTimeout(r, 40));
    }
    sending = false;
  };
  const SPEED = 1.6;

  const track = (el: HTMLElement, onMove: (mx: number, my: number) => void, onTap?: () => void) => {
    let last: { x: number; y: number } | null = null;
    let travelled = 0;
    let downAt = 0;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      last = { x: e.clientX, y: e.clientY };
      travelled = 0;
      downAt = Date.now();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // fine without
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!last) return;
      const mx = e.clientX - last.x;
      const my = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      travelled += Math.abs(mx) + Math.abs(my);
      onMove(mx, my);
      void flush();
    });
    const end = () => {
      if (last && onTap && travelled < 12 && Date.now() - downAt < 350) onTap();
      last = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', () => (last = null));
  };
  track(pad, (mx, my) => {
    dx += Math.round(mx * SPEED);
    dy += Math.round(my * SPEED);
  }, () => void remote.send({ action: 'click' }));
  track(strip, (_mx, my) => {
    scroll += Math.round(my);
  });

  return h(
    'div',
    { class: 'tvr-touch' },
    h('div', { class: 'tvr-pad-wrap' }, pad, strip),
    h(
      'div',
      { class: 'tvr-row' },
      parts.tap('Click', 'Click', () => void remote.send({ action: 'click' })),
      parts.key('BACK', 'back', 'Back'),
      parts.key('HOME', 'home', 'Home'),
    ),
  );
}

function typePage(): HTMLElement {
  const input = h('input', { type: 'text', class: 'tv-link-input', placeholder: 'Text to type on the TV', autocomplete: 'off', spellcheck: false, enterkeyhint: 'send' });
  const status = h('p', { class: 'tvr-hint' }, 'First open a search box or text field on the TV, then type here.');
  const send = async (enter: boolean) => {
    const text = input.value;
    if (!text) return;
    if (await remote.send({ action: 'text', text, enter })) {
      input.value = '';
      status.textContent = enter ? 'Sent, and pressed Enter on the TV.' : 'Sent. Type more, or press Enter when done.';
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void send(true);
  });
  return h(
    'div',
    { class: 'tvr-type' },
    status,
    h('div', { class: 'tv-link-search' }, input, h('button', { class: 'btn', onclick: () => void send(false) }, 'Send'), h('button', { class: 'btn btn-primary', onclick: () => void send(true) }, 'Send + Enter')),
    h('button', { class: 'btn', onclick: () => void remote.send({ action: 'enter' }) }, 'Press Enter on the TV'),
  );
}
