// The remote itself: a d-pad, back/home/settings, volume and channel rockers, media
// keys and (on the bigger tiles) the TV's apps. Built from small parts so each tile
// size and the full-remote sheet can pick what fits.
import { h } from '../../core/dom';
import type { Placement } from '../../core/types';
import { icon, type IconName } from './icons';
import { openRemoteSheet, openLinkSheet, type SheetTab } from './sheets';
import { remote, type TvApp } from './store';

const stop = (e: Event) => e.stopPropagation();

/** Timers and listeners one mounted remote owns, cleared on destroy. */
export class Parts {
  private cleanups: (() => void)[] = [];

  onDestroy(fn: () => void) {
    this.cleanups.push(fn);
  }

  destroy() {
    this.cleanups.splice(0).forEach((fn) => fn());
  }

  /** A button that fires once on tap; caption adds a word under an icon. */
  tap(content: IconName | string, label: string, fire: () => void, cls = '', caption = ''): HTMLButtonElement {
    const isIcon = /^[a-z]+$/.test(content);
    return h(
      'button',
      {
        class: `tvr-btn ${cls}`,
        'aria-label': label,
        onclick: (e: Event) => {
          stop(e);
          fire();
        },
      },
      isIcon ? icon(content as IconName) : h('span', { class: 'tvr-btn-text' }, content),
      caption ? h('span', { class: 'tvr-caption' }, caption) : null,
    );
  }

  /** A button that fires on touch and keeps firing while held, like a real remote. */
  hold(content: IconName | string, label: string, fire: () => void, cls = ''): HTMLButtonElement {
    const isIcon = /^[a-z]+$/.test(content);
    const b = h('button', { class: `tvr-btn ${cls}`, 'aria-label': label }, isIcon ? icon(content as IconName) : h('span', { class: 'tvr-btn-text' }, content));
    let delay = 0;
    let repeat = 0;
    const release = () => {
      clearTimeout(delay);
      clearInterval(repeat);
      b.classList.remove('down');
    };
    b.addEventListener('pointerdown', (e) => {
      stop(e);
      if (b.disabled || e.button > 0) return;
      release();
      b.classList.add('down');
      try {
        b.setPointerCapture(e.pointerId);
      } catch {
        // fine without
      }
      fire();
      delay = window.setTimeout(() => {
        repeat = window.setInterval(fire, 170);
      }, 450);
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, release);
    // Taps are handled on pointerdown; the click must not reach the tile.
    b.addEventListener('click', stop);
    this.onDestroy(release);
    return b;
  }

  key(name: string, content: IconName | string, label: string, cls = '', repeat = false) {
    const fire = () => void remote.send({ action: 'key', key: name });
    return repeat ? this.hold(content, label, fire, cls) : this.tap(content, label, fire, cls);
  }

  dpad(): HTMLElement {
    return h(
      'div',
      { class: 'tvr-dpad' },
      this.key('UP', 'up', 'Up', 'tvr-d-up', true),
      this.key('LEFT', 'left', 'Left', 'tvr-d-left', true),
      this.key('ENTER', 'OK', 'OK', 'tvr-d-ok'),
      this.key('RIGHT', 'right', 'Right', 'tvr-d-right', true),
      this.key('DOWN', 'down', 'Down', 'tvr-d-down', true),
    );
  }

  nav(): HTMLElement {
    return h('div', { class: 'tvr-row' }, this.key('BACK', 'back', 'Back'), this.key('HOME', 'home', 'Home'), this.key('MENU', 'menu', 'TV settings'));
  }

  /**
   * The mute button: says Mute, or Muted (in red) while the sound is off, with the
   * volume number beside it when the TV can tell it (not through a soundbar).
   */
  muteButton(cls = ''): HTMLButtonElement {
    const glyph = h('span', { class: 'tvr-vol-glyph' });
    const word = h('span', { class: 'tvr-mute-word' });
    const level = h('span', { class: 'tvr-vol-value' });
    const b = h(
      'button',
      { class: `tvr-btn tvr-mute ${cls}`, 'aria-label': 'Mute', onclick: (e: Event) => (stop(e), void remote.send({ action: 'mute', mute: !remote.state?.muted })) },
      h('span', { class: 'tvr-vol-label' }, glyph, h('span', { class: 'tvr-mute-text' }, word, level)),
    );
    let shown = '';
    const paint = () => {
      const s = remote.state;
      const muted = Boolean(s?.muted);
      // Through a soundbar the TV's number isn't the real level, so don't show one.
      const text = s?.external || s?.volume == null ? '' : String(s.volume);
      const key = `${muted}|${text}`;
      if (key === shown) return;
      shown = key;
      glyph.replaceChildren(icon(muted ? 'muted' : 'speaker'));
      word.textContent = muted ? 'Muted' : 'Mute';
      level.textContent = text;
      b.classList.toggle('on', muted);
      b.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
      b.setAttribute('aria-pressed', String(muted));
    };
    this.onDestroy(remote.subscribeQuiet(paint));
    paint();
    return b;
  }

  /** − mute + in a row. */
  volumeRow(): HTMLElement {
    return h(
      'div',
      { class: 'tvr-row tvr-rocker-h' },
      this.hold('minus', 'Volume down', () => void remote.send({ action: 'volumeDown' })),
      this.muteButton(),
      this.hold('plus', 'Volume up', () => void remote.send({ action: 'volumeUp' })),
    );
  }

  channelRow(): HTMLElement {
    return h(
      'div',
      { class: 'tvr-row tvr-rocker-h' },
      this.hold('minus', 'Channel down', () => void remote.send({ action: 'channelDown' })),
      h('span', { class: 'tvr-rocker-label' }, 'CH'),
      this.hold('plus', 'Channel up', () => void remote.send({ action: 'channelUp' })),
    );
  }

  /** Volume and channel as two upright rockers, side by side. */
  rockers(): HTMLElement {
    const vol = h(
      'div',
      { class: 'tvr-rocker' },
      this.hold('plus', 'Volume up', () => void remote.send({ action: 'volumeUp' })),
      this.muteButton('tvr-rocker-mid'),
      this.hold('minus', 'Volume down', () => void remote.send({ action: 'volumeDown' })),
    );
    const ch = h(
      'div',
      { class: 'tvr-rocker' },
      this.hold('up', 'Channel up', () => void remote.send({ action: 'channelUp' })),
      h('span', { class: 'tvr-rocker-label tvr-rocker-mid' }, 'CH'),
      this.hold('down', 'Channel down', () => void remote.send({ action: 'channelDown' })),
    );
    return h('div', { class: 'tvr-rockers' }, vol, ch);
  }

  media(): HTMLElement {
    const m = (name: IconName, label: string, action: 'rewind' | 'play' | 'pause' | 'stop' | 'fastForward') => this.tap(name, label, () => void remote.send({ action }), 'tvr-media');
    return h('div', { class: 'tvr-row' }, m('rewind', 'Rewind', 'rewind'), m('play', 'Play', 'play'), m('pause', 'Pause', 'pause'), m('forward', 'Fast forward', 'fastForward'));
  }

  /** Buttons that open the full remote on one of its pages. */
  extras(tabs: SheetTab[] = ['apps', 'numbers', 'touchpad', 'type']): HTMLElement {
    const ICON: Record<SheetTab, IconName> = { remote: 'more', apps: 'apps', numbers: 'keypad', touchpad: 'touchpad', type: 'keyboard' };
    const LABEL: Record<SheetTab, string> = { remote: 'Full remote', apps: 'Apps and inputs', numbers: 'Number pad', touchpad: 'Touchpad', type: 'Type on the TV' };
    const CAPTION: Record<SheetTab, string> = { remote: 'More', apps: 'Apps', numbers: '123', touchpad: 'Pointer', type: 'Type' };
    return h('div', { class: 'tvr-row' }, ...tabs.map((t) => this.tap(ICON[t], LABEL[t], () => openRemoteSheet(t), 'tvr-extra', CAPTION[t])));
  }

  power(): HTMLButtonElement {
    const b = this.tap('power', 'Power', () => void remote.power(), 'tvr-power');
    const paint = () => {
      b.disabled = remote.waking;
      b.classList.toggle('on', Boolean(remote.state?.on));
    };
    this.onDestroy(remote.subscribeQuiet(paint));
    paint();
    return b;
  }

  /** TV name and what it's showing, with the power button. */
  head(withMore = false): HTMLElement {
    const name = h('div', { class: 'tvr-name' });
    const sub = h('div', { class: 'tvr-sub' });
    const paint = () => {
      const s = remote.state;
      name.textContent = s?.name ?? 'TV';
      sub.textContent = remote.waking ? 'Switching on…' : !s?.on ? 'Off' : appTitle(s.appId) ?? (s.external ? 'Sound on the soundbar' : '');
    };
    this.onDestroy(remote.subscribeQuiet(paint));
    paint();
    return h('div', { class: 'tvr-head' }, h('div', { class: 'tvr-title' }, name, sub), withMore ? this.tap('more', 'Full remote', () => openRemoteSheet('remote'), 'tvr-more') : null, this.power());
  }

  /** The TV's apps as big buttons; limit trims the list for a tile. */
  apps(limit = 0): HTMLElement {
    const box = h('div', { class: 'tvr-apps' });
    let shown = '';
    const paint = () => {
      const list = remote.apps?.apps ?? [];
      const current = remote.state?.appId ?? '';
      const key = `${list.map((a) => a.id).join()}|${current}|${remote.appsError}`;
      if (key === shown) return;
      shown = key;
      if (!remote.apps) {
        box.replaceChildren(h('p', { class: 'tvr-hint' }, remote.appsError || 'Loading apps…'));
        return;
      }
      const items = limit ? list.slice(0, limit) : list;
      box.replaceChildren(...items.map((a) => appButton(a, a.id === current)));
    };
    this.onDestroy(remote.subscribeQuiet(paint));
    void remote.loadApps();
    paint();
    return box;
  }
}

export function appTitle(appId: string | null | undefined): string | null {
  if (!appId) return null;
  const app = remote.apps?.apps.find((a) => a.id === appId);
  if (app) return app.title;
  const input = remote.apps?.inputs.find((i) => appId.includes(i.id.replace(/_/g, '')) || appId.endsWith(i.id));
  if (input) return input.label;
  if (/livetv|tvhub/i.test(appId)) return 'Live TV';
  return null;
}

/** An app tile: its icon from the TV when it loads, otherwise its first letter. */
export function appButton(a: TvApp, active: boolean): HTMLElement {
  const letter = h('span', { class: 'tvr-app-letter' }, a.title.slice(0, 1).toUpperCase());
  const art = h('span', { class: 'tvr-app-art' }, letter);
  if (a.icon) {
    // Shown over the letter once it loads; the TV may serve icons on a port the screen can't reach.
    const img = h('img', { src: a.icon, alt: '', draggable: false });
    img.addEventListener('load', () => art.classList.add('has-img'));
    img.addEventListener('error', () => img.remove());
    art.append(img);
  }
  return h(
    'button',
    {
      class: `tvr-app${active ? ' active' : ''}`,
      onclick: (e: Event) => {
        stop(e);
        void remote.send({ action: 'launch', id: a.id }).then((ok) => ok && void remote.refresh());
      },
    },
    art,
    h('span', { class: 'tvr-app-name' }, a.title),
  );
}

/** Mounts a remote sized for placement into el. Returns the destroy function. */
export function mountRemote(el: HTMLElement, placement: Placement | 'sheet'): () => void {
  const root = h('div', { class: `tvr size-${placement}` });
  const error = h('div', { class: 'tvr-error', role: 'status' });
  el.append(root);
  let parts = new Parts();
  let mode = '';

  const controls = (): Node[] => {
    switch (placement) {
      case 'bar':
      case 'small':
        return [parts.head(), parts.volumeRow(), h('div', { class: 'tvr-tap-hint' }, 'Tap for the full remote')];
      case 'medium':
        return [h('div', { class: 'tvr-cols' }, parts.dpad(), h('div', { class: 'tvr-stack' }, parts.head(true), parts.nav(), parts.volumeRow()))];
      case 'tall':
        return [parts.head(true), parts.dpad(), parts.nav(), parts.volumeRow(), parts.channelRow()];
      case 'large':
      case 'sheet':
        return [
          h(
            'div',
            { class: 'tvr-cols' },
            h('div', { class: 'tvr-stack tvr-left' }, parts.dpad(), parts.nav()),
            h('div', { class: 'tvr-stack' }, placement === 'sheet' ? null : parts.head(), parts.rockers(), parts.media(), placement === 'sheet' ? null : parts.extras()),
          ),
        ];
      default:
        // Extra large and full page: the large remote with the TV's apps beside it.
        return [
          h(
            'div',
            { class: 'tvr-cols' },
            h('div', { class: 'tvr-stack tvr-left' }, parts.dpad(), parts.nav()),
            h('div', { class: 'tvr-stack' }, parts.head(), parts.rockers(), parts.media(), parts.extras(['numbers', 'touchpad', 'type'])),
            h('div', { class: 'tvr-stack tvr-side' }, h('div', { class: 'tvr-side-head' }, 'Apps', parts.tap('input', 'Inputs', () => openRemoteSheet('apps'), 'tvr-extra tvr-small', 'Inputs')), parts.apps(placement === 'full' ? 0 : 12)),
          ),
        ];
    }
  };

  const message = (title: string, text: string, ...actions: (HTMLElement | null)[]) =>
    h('div', { class: 'tvr-message' }, icon('tv', 'tvr-message-icon'), h('div', { class: 'tvr-message-title' }, title), text ? h('div', { class: 'tvr-hint' }, text) : null, ...actions);

  const paint = () => {
    const s = remote.state;
    const next = !s ? (remote.loadError ? 'error' : 'loading') : !s.linked ? 'setup' : s.on ? 'on' : remote.waking ? 'waking' : 'off';
    const key = `${next}|${s?.name}|${remote.loadError}`;
    if (key !== mode) {
      mode = key;
      parts.destroy();
      parts = new Parts();
      root.dataset.mode = next;
      const compact = placement === 'small' || placement === 'bar' || placement === 'medium';
      if (next === 'on') root.replaceChildren(...controls(), error);
      else if (next === 'setup')
        root.replaceChildren(
          message('Link your LG TV', compact ? '' : 'Pair once and this works as its remote. The Spotify widget uses the same TV.', h('button', { class: 'btn btn-primary', onclick: (e: Event) => (stop(e), openLinkSheet()) }, 'Link my LG TV')),
          error,
        );
      else if (next === 'off' || next === 'waking')
        root.replaceChildren(
          message(
            s?.name ?? 'TV',
            next === 'waking' ? 'Switching on… this can take up to half a minute.' : compact ? 'Off' : s?.canWake ? 'The TV is off.' : "The TV is off. Turn it on with its own remote once so PiDisplay learns how to wake it.",
            h(
              'button',
              { class: 'btn btn-primary tvr-turn-on', disabled: next === 'waking', onclick: (e: Event) => (stop(e), void remote.power()) },
              icon('power'),
              next === 'waking' ? 'Starting…' : 'Turn on',
            ),
          ),
          error,
        );
      else root.replaceChildren(message('TV remote', next === 'error' ? remote.loadError : 'Connecting…'), error);
    }
    error.textContent = remote.error;
    error.classList.toggle('show', Boolean(remote.error));
  };

  // Poll only while this remote is on screen; pages that aren't shown stay quiet.
  let off: (() => void) | null = null;
  const seen = new IntersectionObserver((entries) => {
    const visible = entries.some((e) => e.isIntersecting);
    if (visible && !off) off = remote.subscribe(paint);
    else if (!visible && off) (off(), (off = null));
  });
  seen.observe(root);
  const onVisibility = () => document.visibilityState === 'visible' && off && void remote.refresh();
  document.addEventListener('visibilitychange', onVisibility);
  paint();

  return () => {
    seen.disconnect();
    off?.();
    document.removeEventListener('visibilitychange', onVisibility);
    parts.destroy();
  };
}
