// Wi-Fi and Bluetooth screens inside the gear menu. Each renders into the
// settings sheet's body and talks to /api/wifi and /api/bluetooth (server/network.js).
import { call } from './api';
import { h } from './dom';

interface WifiNetwork {
  ssid: string;
  signal: number;
  secure: boolean;
  saved: boolean;
  inUse: boolean;
}

interface WifiStatus {
  available: boolean;
  enabled?: boolean;
  current?: { ssid: string; uuid: string; ip: string | null; signal: number | null } | null;
  networks?: WifiNetwork[];
  saved?: { name: string; uuid: string; ssid: string }[];
}

interface BtDevice {
  mac: string;
  name: string | null;
  icon: string | null;
  paired: boolean;
  connected: boolean;
}

interface BtStatus {
  available: boolean;
  powered?: boolean;
  devices?: BtDevice[];
}

/** Common frame: back button, title, an optional action, then the screen's content. */
function frame(title: string, back: () => void, action?: HTMLElement) {
  const content = h('div', { class: 'conn' });
  const root = h(
    'div',
    {},
    h(
      'div',
      { class: 'conn-head' },
      h('button', { class: 'btn btn-ghost', onclick: back, 'aria-label': 'Back' }, '‹ Back'),
      h('h3', {}, title),
      action ?? h('span'),
    ),
    content,
  );
  return { root, content };
}

/** A button that needs a second tap, with a warning shown while armed. */
function twoTap(label: string, warning: string, action: () => void, cls = 'btn btn-danger'): HTMLElement {
  let armed = false;
  const btn = h(
    'button',
    {
      class: cls,
      onclick: () => {
        if (armed) return action();
        armed = true;
        btn.textContent = 'Tap again to confirm';
        note.hidden = false;
        setTimeout(() => {
          armed = false;
          btn.textContent = label;
          note.hidden = true;
        }, 4000);
      },
    },
    label,
  );
  const note = h('p', { class: 'conn-warn', hidden: true }, warning);
  return h('div', { class: 'conn-confirm' }, btn, note);
}

function bars(signal: number) {
  const level = Math.max(1, Math.ceil(signal / 25));
  return h('span', { class: 'conn-bars', 'aria-label': `Signal ${signal}%` }, ...[1, 2, 3, 4].map((i) => h('i', { class: i <= level ? 'on' : '' })));
}

// ---- Wi-Fi ------------------------------------------------------------------

export function showWifi(body: HTMLElement, back: () => void) {
  let data: WifiStatus | null = null;
  let selected: string | null = null;
  let busy = '';
  let error = '';

  const scanBtn = h('button', { class: 'btn', onclick: () => load(true) }, 'Scan');
  const { root, content } = frame('Wi-Fi', back, scanBtn);
  body.replaceChildren(root);

  const run = async (label: string, fn: () => Promise<WifiStatus>) => {
    busy = label;
    error = '';
    render();
    try {
      data = await fn();
      selected = null;
    } catch (err) {
      error = (err as Error).message;
    }
    busy = '';
    if (root.isConnected) render();
  };

  const load = (rescan = false) => run(rescan ? 'Scanning…' : 'Loading…', () => call('GET', `/api/wifi${rescan ? '?rescan' : ''}`));
  const post = (label: string, action: string, payload: object = {}) =>
    run(label, () => call('POST', `/api/wifi/${action}`, payload));

  const detail = (n: WifiNetwork) => {
    const cur = data?.current;
    const savedId = data?.saved?.find((s) => s.ssid === n.ssid)?.uuid;
    const forget = savedId
      ? twoTap(
          'Forget',
          n.inUse
            ? 'This is the network the Pi is using. Forgetting it drops remote access (SSH) until you join a network again.'
            : 'The Pi will stop joining this network automatically.',
          () => post('Forgetting…', 'forget', { uuid: savedId }),
        )
      : null;

    if (n.inUse) {
      return h(
        'div',
        { class: 'conn-detail' },
        h('p', {}, `Connected${cur?.ip ? ` · ${cur.ip}` : ''}`),
        h(
          'div',
          { class: 'conn-actions' },
          twoTap(
            'Disconnect',
            'Disconnecting drops remote access (SSH) to the Pi until you reconnect from this screen.',
            () => post('Disconnecting…', 'disconnect'),
          ),
          forget,
        ),
      );
    }

    const switching = cur ? h('p', { class: 'conn-hint' }, `The Pi will leave ${cur.ssid}. If joining fails, it goes back to ${cur.ssid}.`) : null;
    if (n.saved || !n.secure) {
      return h(
        'div',
        { class: 'conn-detail' },
        switching,
        h(
          'div',
          { class: 'conn-actions' },
          h('button', { class: 'btn btn-primary', onclick: () => post(`Joining ${n.ssid}…`, 'connect', { ssid: n.ssid }) }, 'Connect'),
          forget,
        ),
      );
    }

    const input = h('input', {
      type: 'password',
      placeholder: 'Password',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: false,
      oninput: () => (join.disabled = input.value.length < 8),
      onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && !join.disabled && join.click(),
    });
    const show = h('button', {
      class: 'btn btn-ghost',
      onclick: () => {
        input.type = input.type === 'password' ? 'text' : 'password';
        show.textContent = input.type === 'password' ? 'Show' : 'Hide';
      },
    }, 'Show');
    const join = h(
      'button',
      { class: 'btn btn-primary', disabled: true, onclick: () => post(`Joining ${n.ssid}…`, 'connect', { ssid: n.ssid, password: input.value }) },
      'Connect',
    );
    setTimeout(() => input.focus(), 50);
    return h('div', { class: 'conn-detail' }, switching, h('div', { class: 'conn-password' }, input, show), h('div', { class: 'conn-actions' }, join));
  };

  const render = () => {
    scanBtn.disabled = Boolean(busy);
    const parts: (HTMLElement | null)[] = [];
    if (busy) parts.push(h('p', { class: 'conn-status' }, busy));
    if (error) parts.push(h('p', { class: 'conn-error' }, error));

    if (data && !data.available) parts.push(h('p', { class: 'empty' }, 'No Wi-Fi adapter here. Wi-Fi settings work on the Pi itself.'));
    else if (data && !data.enabled) {
      parts.push(
        h('p', { class: 'empty' }, 'Wi-Fi is off.'),
        h('button', { class: 'btn btn-primary btn-wide', onclick: () => post('Turning Wi-Fi on…', 'power', { on: true }) }, 'Turn Wi-Fi on'),
      );
    } else if (data) {
      const inRange = new Set(data.networks!.map((n) => n.ssid));
      parts.push(
        h(
          'ul',
          { class: 'conn-list' },
          ...data.networks!.map((n) =>
            h(
              'li',
              { class: `${n.inUse ? 'active' : ''}${selected === n.ssid ? ' open' : ''}` },
              h(
                'button',
                { class: 'conn-row', disabled: Boolean(busy), onclick: () => ((selected = selected === n.ssid ? null : n.ssid), render()) },
                bars(n.signal),
                h('span', { class: 'conn-name' }, n.ssid),
                n.inUse ? h('span', { class: 'conn-tag on' }, 'Connected') : n.saved ? h('span', { class: 'conn-tag' }, 'Saved') : null,
                n.secure ? h('span', { class: 'conn-lock', 'aria-label': 'Secured' }, '🔒') : null,
              ),
              selected === n.ssid && !busy ? detail(n) : null,
            ),
          ),
        ),
      );
      if (!data.networks!.length) parts.push(h('p', { class: 'empty' }, 'No networks found. Tap Scan.'));
      const away = data.saved!.filter((s) => !inRange.has(s.ssid));
      if (away.length) {
        parts.push(
          h('h3', {}, 'Saved, not in range'),
          h(
            'ul',
            { class: 'conn-list' },
            ...away.map((s) =>
              h(
                'li',
                { class: 'conn-away' },
                h('span', { class: 'conn-name' }, s.ssid),
                twoTap('Forget', 'The Pi will stop joining this network automatically.', () => post('Forgetting…', 'forget', { uuid: s.uuid })),
              ),
            ),
          ),
        );
      }
    }
    content.replaceChildren(...parts.filter((p): p is HTMLElement => Boolean(p)));
  };

  load();
}

// ---- Bluetooth --------------------------------------------------------------

const BT_ICONS: [RegExp, string][] = [
  [/audio|headset|headphone/, '🎧'],
  [/keyboard/, '⌨️'],
  [/mouse|tablet/, '🖱️'],
  [/gaming/, '🎮'],
  [/phone/, '📱'],
  [/computer/, '💻'],
];
const btIcon = (icon: string | null) => BT_ICONS.find(([re]) => icon && re.test(icon))?.[1] ?? '🔵';

export function showBluetooth(body: HTMLElement, back: () => void) {
  let data: BtStatus | null = null;
  let selected: string | null = null;
  let busy = '';
  let error = '';
  let searched = false;

  const { root, content } = frame('Bluetooth', back);
  body.replaceChildren(root);

  const run = async (label: string, fn: () => Promise<BtStatus>) => {
    busy = label;
    error = '';
    render();
    try {
      data = await fn();
      selected = null;
    } catch (err) {
      error = (err as Error).message;
    }
    busy = '';
    if (root.isConnected) render();
  };
  const post = (label: string, action: string, payload: object = {}) =>
    run(label, () => call('POST', `/api/bluetooth/${action}`, payload));

  const detail = (d: BtDevice) => {
    const name = d.name ?? d.mac;
    if (!d.paired) {
      return h(
        'div',
        { class: 'conn-detail' },
        h('p', { class: 'conn-hint' }, 'Put the device in pairing mode first.'),
        h('div', { class: 'conn-actions' }, h('button', { class: 'btn btn-primary', onclick: () => post(`Pairing with ${name}…`, 'pair', { mac: d.mac }) }, 'Pair')),
      );
    }
    return h(
      'div',
      { class: 'conn-detail' },
      h(
        'div',
        { class: 'conn-actions' },
        d.connected
          ? h('button', { class: 'btn', onclick: () => post('Disconnecting…', 'disconnect', { mac: d.mac }) }, 'Disconnect')
          : h('button', { class: 'btn btn-primary', onclick: () => post(`Connecting to ${name}…`, 'connect', { mac: d.mac }) }, 'Connect'),
        twoTap('Forget', 'You will need to pair it again to use it.', () => post('Forgetting…', 'forget', { mac: d.mac })),
      ),
    );
  };

  const list = (devices: BtDevice[]) =>
    h(
      'ul',
      { class: 'conn-list' },
      ...devices.map((d) =>
        h(
          'li',
          { class: `${d.connected ? 'active' : ''}${selected === d.mac ? ' open' : ''}` },
          h(
            'button',
            { class: 'conn-row', disabled: Boolean(busy), onclick: () => ((selected = selected === d.mac ? null : d.mac), render()) },
            h('span', { class: 'conn-icon' }, btIcon(d.icon)),
            h('span', { class: 'conn-name' }, d.name ?? d.mac),
            d.connected ? h('span', { class: 'conn-tag on' }, 'Connected') : null,
          ),
          selected === d.mac && !busy ? detail(d) : null,
        ),
      ),
    );

  const render = () => {
    const parts: (HTMLElement | null)[] = [];
    if (data && !data.available) {
      parts.push(h('p', { class: 'empty' }, 'No Bluetooth adapter here. Bluetooth settings work on the Pi itself.'));
    } else if (data) {
      const toggle = h('input', {
        type: 'checkbox',
        class: 'toggle',
        checked: Boolean(data.powered),
        disabled: Boolean(busy),
        onchange: () => post(toggle.checked ? 'Turning Bluetooth on…' : 'Turning Bluetooth off…', 'power', { on: toggle.checked }),
      });
      parts.push(h('label', { class: 'field' }, h('span', {}, 'Bluetooth'), toggle));
    }
    if (busy) parts.push(h('p', { class: 'conn-status' }, busy));
    if (error) parts.push(h('p', { class: 'conn-error' }, error));

    if (data?.available && data.powered) {
      const paired = data.devices!.filter((d) => d.paired);
      const nearby = data.devices!.filter((d) => !d.paired);
      parts.push(h('h3', {}, 'My devices'), paired.length ? list(paired) : h('p', { class: 'conn-hint' }, 'No paired devices yet.'));
      parts.push(
        h('h3', {}, 'Nearby'),
        nearby.length ? list(nearby) : h('p', { class: 'conn-hint' }, searched ? 'Nothing found. Make sure the device is in pairing mode.' : 'Search to find devices to pair.'),
        h(
          'button',
          {
            class: 'btn btn-wide',
            disabled: Boolean(busy),
            onclick: () => {
              searched = true;
              run('Searching for devices…', () => call('POST', '/api/bluetooth/scan'));
            },
          },
          'Search for devices',
        ),
      );
    }
    content.replaceChildren(...parts.filter((p): p is HTMLElement => Boolean(p)));
  };

  run('Loading…', () => call('GET', '/api/bluetooth'));
}
