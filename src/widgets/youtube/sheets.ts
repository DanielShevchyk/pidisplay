// Sheets for the YouTube widget: the video browser for small tiles, and linking a
// TV (found on the network, or with the code from the TV's YouTube app).
import { call } from '../../core/api';
import { h } from '../../core/dom';
import { openSheet } from '../../core/sheet';
import { youtube, type Status } from './store';
import { mountBrowser, mountRemote } from './view';

export function openBrowseSheet() {
  const cleanups: (() => void)[] = [];
  const browser = h('div', { class: 'yt-sheet-browse' });
  const remote = h('div', { class: 'yt-sheet-remote' });
  openSheet('YouTube', [h('div', { class: 'yt-sheet' }, browser, remote)], { onClose: () => cleanups.forEach((fn) => fn()) });
  cleanups.push(mountBrowser(browser), mountRemote(remote, { placement: 'strip' }));
}

interface Found {
  udn: string;
  name: string;
  model: string;
  running: boolean;
  linked: boolean;
}

export function openSetupSheet() {
  const sheet = openSheet('TV for YouTube', [], { onClose: () => off() });
  let found: Found[] | null = null;
  let scanning = false;
  let busy = '';
  let error = '';
  let info = '';

  const code = h('input', {
    type: 'tel',
    inputmode: 'numeric',
    class: 'yt-search-input yt-code-input',
    placeholder: '123 456 789 012',
    autocomplete: 'off',
    maxlength: 20,
    onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && void pair(),
  });

  const act = async (label: string, fn: () => Promise<void>) => {
    busy = label;
    error = '';
    info = '';
    render();
    try {
      await fn();
    } catch (err) {
      error = (err as Error).message;
    }
    busy = '';
    render();
  };

  const pair = () =>
    act('Linking…', async () => {
      code.blur();
      await call<Status>('POST', '/api/youtube/pair', { code: code.value });
      code.value = '';
      info = `✅ Linked. Pick a video and it plays on ${youtube.screenName()}.`;
      void youtube.refresh();
    });

  const scan = async () => {
    scanning = true;
    error = '';
    render();
    try {
      found = (await call<{ devices: Found[] }>('GET', '/api/youtube/discover')).devices;
    } catch (err) {
      error = (err as Error).message;
    }
    scanning = false;
    render();
  };

  const link = (d: Found) =>
    act(`Opening YouTube on ${d.name}…`, async () => {
      await call<Status>('POST', '/api/youtube/link', { udn: d.udn });
      info = `✅ Linked to ${d.name}.`;
      found = found?.map((x) => (x.udn === d.udn ? { ...x, linked: true } : x)) ?? null;
      void youtube.refresh();
    });

  const row = (iconText: string, label: string, sub: string, tag: string | null, onclick: (() => void) | null, active = false, extra: HTMLElement | null = null) =>
    h(
      'li',
      { class: active ? 'active' : '' },
      h(
        'div',
        { class: 'yt-row' },
        h(
          'button',
          { class: 'conn-row', disabled: !onclick || Boolean(busy), onclick: onclick ?? undefined },
          h('span', { class: 'conn-icon' }, iconText),
          h('span', { class: 'conn-name' }, label, sub ? h('span', { class: 'yt-row-sub' }, sub) : null),
          tag ? h('span', { class: `conn-tag${active ? ' on' : ''}` }, tag) : null,
        ),
        extra,
      ),
    );

  function render() {
    const s = youtube.status;
    const screens = s?.screens ?? [];
    const parts: (HTMLElement | null)[] = [];
    if (busy) parts.push(h('p', { class: 'conn-status' }, busy));
    if (error) parts.push(h('p', { class: 'conn-error' }, error));
    if (info) parts.push(h('p', { class: 'conn-status' }, info));

    if (screens.length) {
      parts.push(
        h('h3', {}, 'Linked TVs'),
        h(
          'ul',
          { class: 'conn-list' },
          ...screens.map((x) =>
            row(
              '📺',
              x.name,
              x.id === s?.current && s.connected ? 'Connected' : '',
              x.id === s?.current ? 'In use' : 'Use',
              x.id === s?.current
                ? null
                : () =>
                    void act('Switching…', async () => {
                      await call('POST', '/api/youtube/select', { id: x.id });
                      await youtube.refresh();
                    }),
              x.id === s?.current,
              h(
                'button',
                {
                  class: 'btn btn-ghost yt-forget',
                  disabled: Boolean(busy),
                  onclick: () =>
                    void act('Forgetting…', async () => {
                      await call('DELETE', `/api/youtube/screens/${encodeURIComponent(x.id)}`);
                      await youtube.refresh();
                    }),
                },
                'Forget',
              ),
            ),
          ),
        ),
      );
    }

    parts.push(
      h('h3', {}, screens.length ? 'Link another TV' : 'Link your TV'),
      h('p', { class: 'conn-hint' }, 'Easiest: on the TV, open YouTube, go to Settings, then "Link with TV code", and type the code here. Works with any brand.'),
      h('div', { class: 'yt-search' }, code, h('button', { class: 'btn btn-primary', disabled: Boolean(busy), onclick: () => void pair() }, 'Link')),
      h('p', { class: 'conn-hint' }, 'Or find TVs on the Wi-Fi. This can also open YouTube on the TV when it is closed.'),
      h('button', { class: 'btn', disabled: scanning || Boolean(busy), onclick: () => void scan() }, scanning ? 'Looking…' : found ? 'Look again' : 'Find TVs on the network'),
    );
    if (found) {
      parts.push(
        found.length
          ? h(
              'ul',
              { class: 'conn-list' },
              ...found.map((d) => row('📺', d.name, d.model, d.linked ? 'Linked' : 'Link', d.linked ? null : () => void link(d), d.linked)),
            )
          : h('p', { class: 'empty' }, 'No TVs answered. Make sure the TV is on, or use the code instead.'),
      );
    }
    if (sheet.body.isConnected) sheet.body.replaceChildren(h('div', { class: 'yt-setup' }, ...parts.filter((p): p is HTMLElement => Boolean(p))));
  }

  // Only the TV list matters here; playback updates would steal focus from the code field.
  let lastKey: string | null = null;
  const off = youtube.subscribe(() => {
    const s = youtube.status;
    const key = JSON.stringify([s?.screens, s?.current, s?.connected]);
    if (key === lastKey) return;
    lastKey = key;
    render();
  });
}
