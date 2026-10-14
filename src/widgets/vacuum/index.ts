import { call, onServerEvent } from '../../core/api';
import { h } from '../../core/dom';
import { openSheet, type SheetHandle } from '../../core/sheet';
import { defineWidget, type Placement, type WidgetContext } from '../../core/types';
import './vacuum.css';

/** Mirrors GET /api/vacuum (server/vacuum.js). */
type Phase = 'cleaning' | 'paused' | 'returning' | 'docked' | 'idle' | 'error';

interface RobotState {
  phase: Phase;
  label: string;
  error: { code: number; text: string } | null;
  battery: number | null;
  charging: boolean;
  cleaningMinutes: number | null;
  cleanedArea: number | null;
  progress: number | null;
  suction: number | null;
  mode: number | null;
  tanks: { clean: string | null; dirty: string | null; dustBag: string | null };
  parts: { mainBrush: number | null; sideBrush: number | null; filter: number | null; mopPads: number | null; sensors: number | null };
}

interface Room {
  id: number;
  name: string;
}

interface Snapshot {
  configured: boolean;
  status: 'unconfigured' | 'connecting' | 'ok' | 'signin' | 'offline' | 'error';
  problem: string | null;
  device: { name: string; model: string } | null;
  state: RobotState | null;
  rooms: Room[];
  mapName: string | null;
  hasMap: boolean;
  updatedAt: string | null;
  labels: { suction: string[]; modes: Record<string, string> };
}

interface MapPicture {
  width: number;
  height: number;
  rotation: number;
  pixels: string;
  rooms: Room[];
}

const WALL = 255;
const MODE_ORDER = [2, 0, 1, 3];

/** One shared copy of the robot state for every tile on this screen. */
let latest: Snapshot | null = null;
const listeners = new Set<() => void>();
let started = false;

function startFeed() {
  if (started) return;
  started = true;
  onServerEvent<Snapshot>('vacuum', (s) => {
    latest = s;
    listeners.forEach((fn) => fn());
  });
}

async function load(refresh = false): Promise<Snapshot> {
  latest = await call<Snapshot>(refresh ? 'POST' : 'GET', refresh ? '/api/vacuum/refresh' : '/api/vacuum');
  listeners.forEach((fn) => fn());
  return latest;
}

let mapCache: { key: string; picture: Promise<MapPicture> } | null = null;
function loadMap(s: Snapshot): Promise<MapPicture> {
  const key = `${s.device?.name}|${s.rooms.map((r) => `${r.id}:${r.name}`).join(',')}`;
  if (mapCache?.key !== key) {
    const picture = call<MapPicture>('GET', '/api/vacuum/map');
    picture.catch(() => {
      if (mapCache?.picture === picture) mapCache = null;
    });
    mapCache = { key, picture };
  }
  return mapCache.picture;
}

export default defineWidget({
  type: 'vacuum',
  name: 'Robot vacuum',
  description: 'Start, pause and dock your Dreame robot, or send it to clean rooms',
  icon: '🤖',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'large',
  supportsBar: true,
  defaultConfig: {},

  mount(el, ctx) {
    const root = h('div', { class: `vac size-${ctx.placement}` });
    el.append(root);
    const view = createView(ctx, () => paint());
    let sheet: SheetHandle | null = null;

    const paint = () => {
      root.replaceChildren(view.tile(ctx.placement, openControls));
      if (sheet) sheet.body.replaceChildren(view.controls());
    };
    const openControls = () => {
      sheet = openSheet(latest?.device?.name ?? 'Robot vacuum', [view.controls()], {
        onClose: () => {
          sheet = null;
        },
      });
    };

    startFeed();
    listeners.add(paint);
    paint();
    load(true).catch((err) => {
      view.error = err.message;
      paint();
    });
    return {
      destroy() {
        listeners.delete(paint);
        sheet?.close();
      },
    };
  },
});

/** Rendering and actions shared by the tile and the controls sheet. */
function createView(ctx: WidgetContext, repaint: () => void) {
  const selected = new Set<number>();
  let pending = '';
  const view = {
    error: '',

    tile(placement: Placement, openControls: () => void): Node | string {
      const s = latest;
      if (!s) return message(view.error ? '⚠️' : '🤖', view.error || 'Connecting to the robot…');
      if (!s.configured) {
        return placement === 'bar'
          ? ''
          : message('🤖', 'Add your Dreame account to control the robot', h('div', { class: 'vac-hint' }, 'On the laptop run .\\deploy\\vacuum.ps1'));
      }
      if (!s.state) {
        if (placement === 'bar') return '';
        const icon = s.status === 'signin' ? '🔑' : s.status === 'connecting' ? '🤖' : '⚠️';
        return message(icon, s.problem ?? 'Connecting to the robot…', s.status === 'signin' ? h('div', { class: 'vac-hint' }, 'Fix it with .\\deploy\\vacuum.ps1 on the laptop') : undefined);
      }
      const st = s.state;
      if (placement === 'bar') {
        return h('button', { class: 'vac-bar', onclick: openControls }, h('span', { class: `vac-dot ${st.phase}` }), `${st.label}`, battery(st));
      }
      if (placement === 'small') {
        return h(
          'div',
          { class: 'vac-small', onclick: (e: Event) => (e.target as HTMLElement).closest('button') || openControls() },
          h('div', { class: 'vac-small-top' }, robotIcon(st.phase), battery(st)),
          h('div', { class: 'vac-label' }, st.label),
          primaryButton(st),
        );
      }
      const head = h(
        'div',
        { class: 'vac-head', onclick: openControls },
        robotIcon(st.phase),
        h('div', { class: 'vac-head-text' }, h('div', { class: 'vac-name' }, s.device?.name ?? 'Robot vacuum'), h('div', { class: 'vac-label' }, st.label)),
        battery(st),
      );
      const parts: (Node | null)[] = [head, statusLine(s)];
      if (placement === 'medium') {
        return h('div', { class: 'vac-wide' }, h('div', { class: 'vac-wide-main' }, ...parts), h('div', { class: 'vac-wide-buttons' }, primaryButton(st), dockButton(st)));
      }
      parts.push(h('div', { class: 'vac-buttons' }, primaryButton(st), dockButton(st), h('button', { class: 'btn', onclick: openControls }, 'More')));
      if (placement === 'tall') parts.push(roomsPicker(s, false));
      else if (placement === 'large') parts.push(roomsPicker(s, false), settings(s));
      else {
        parts.push(h('div', { class: 'vac-split' }, s.hasMap ? mapView(s) : null, h('div', { class: 'vac-split-side' }, roomsPicker(s, false), settings(s))));
      }
      return h('div', { class: 'vac-full' }, ...parts);
    },

    /** Everything, for the sheet. */
    controls(): Node {
      const s = latest;
      if (!s?.state) return message('🤖', s?.problem ?? 'Waiting for the robot…');
      const st = s.state;
      const extra = [
        st.phase === 'paused' ? cmdButton('Stop', 'stop') : null,
        cmdButton('Find robot', 'locate'),
        cmdButton('Empty dust bin', 'empty'),
        cmdButton('Wash mops', 'wash'),
        cmdButton('Dry mops', 'dry'),
      ];
      return h(
        'div',
        { class: 'vac-sheet' },
        h('div', { class: 'vac-head' }, robotIcon(st.phase), h('div', { class: 'vac-head-text' }, h('div', { class: 'vac-label big' }, st.label)), battery(st)),
        statusLine(s),
        h('div', { class: 'vac-buttons' }, primaryButton(st), dockButton(st)),
        s.hasMap ? mapView(s) : null,
        roomsPicker(s, true),
        settings(s),
        h('div', { class: 'vac-section' }, h('div', { class: 'vac-section-title' }, 'Station'), h('div', { class: 'vac-buttons wrap' }, ...extra)),
        partsView(st),
        s.problem ? h('div', { class: 'vac-problem' }, s.problem) : null,
      );
    },
  };

  async function send(command: string, extra: Record<string, unknown> = {}) {
    if (pending) return;
    pending = command;
    repaint();
    try {
      latest = await call<Snapshot>('POST', '/api/vacuum/command', { command, ...extra });
      if (command === 'rooms') selected.clear();
    } catch (err) {
      ctx.notify({ title: "The robot didn't take that", body: (err as Error).message, level: 'warning' });
    } finally {
      pending = '';
      listeners.forEach((fn) => fn());
    }
  }

  function cmdButton(label: string, command: string, cls = 'btn', extra?: Record<string, unknown>) {
    return h('button', { class: cls, disabled: Boolean(pending), onclick: () => send(command, extra) }, pending === command ? '…' : label);
  }

  function primaryButton(st: RobotState) {
    if (st.phase === 'cleaning' || st.phase === 'returning') return cmdButton('Pause', 'pause', 'btn btn-primary');
    if (st.phase === 'paused') return cmdButton('Resume', 'resume', 'btn btn-primary');
    if (selected.size) return cmdButton(`Clean ${selected.size === 1 ? '1 room' : `${selected.size} rooms`}`, 'rooms', 'btn btn-primary', { rooms: [...selected] });
    return cmdButton('Clean all', 'start', 'btn btn-primary');
  }

  function dockButton(st: RobotState) {
    if (st.phase === 'docked') return cmdButton('Find', 'locate');
    return cmdButton('Dock', 'dock');
  }

  function roomsPicker(s: Snapshot, inSheet: boolean) {
    if (!s.rooms.length) return inSheet ? h('div', { class: 'vac-dim' }, 'Rooms show up here once the robot has a saved map.') : null;
    const busy = s.state?.phase === 'cleaning' || s.state?.phase === 'paused';
    return h(
      'div',
      { class: 'vac-section' },
      h('div', { class: 'vac-section-title' }, s.mapName ? `Rooms · ${s.mapName}` : 'Rooms'),
      h(
        'div',
        { class: 'chips vac-rooms' },
        ...s.rooms.map((r) =>
          h(
            'button',
            {
              class: `chip${selected.has(r.id) ? ' active' : ''}`,
              disabled: busy,
              onclick: () => {
                if (selected.has(r.id)) selected.delete(r.id);
                else selected.add(r.id);
                repaint();
              },
            },
            r.name,
          ),
        ),
      ),
      inSheet && selected.size && !busy
        ? h('button', { class: 'btn btn-primary btn-wide', disabled: Boolean(pending), onclick: () => send('rooms', { rooms: [...selected] }) }, `Clean ${selected.size === 1 ? '1 room' : `${selected.size} rooms`}`)
        : null,
    );
  }

  function settings(s: Snapshot) {
    const st = s.state!;
    const rows: Node[] = [];
    if (st.suction !== null) {
      rows.push(
        h('div', { class: 'vac-section-title' }, 'Suction'),
        h('div', { class: 'chips' }, ...s.labels.suction.map((label, level) => choice(label, st.suction === level, () => send('suction', { level })))),
      );
    }
    if (st.mode !== null) {
      rows.push(
        h('div', { class: 'vac-section-title' }, 'Mode'),
        h('div', { class: 'chips' }, ...MODE_ORDER.map((mode) => choice(s.labels.modes[mode], st.mode === mode, () => send('mode', { mode })))),
      );
    }
    return rows.length ? h('div', { class: 'vac-section' }, ...rows) : null;
  }

  function choice(label: string, active: boolean, onclick: () => void) {
    return h('button', { class: `chip${active ? ' active' : ''}`, disabled: Boolean(pending), onclick }, label);
  }

  function mapView(s: Snapshot) {
    const canvas = h('canvas', { class: 'vac-map-canvas' });
    const wrap = h('div', { class: 'vac-map' }, canvas);
    loadMap(s)
      .then((pic) => drawMap(canvas, wrap, pic, selected, s.state?.phase !== 'cleaning' && s.state?.phase !== 'paused', (id) => {
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        repaint();
      }))
      .catch(() => wrap.remove());
    return wrap;
  }

  return view;
}

function statusLine(s: Snapshot) {
  const st = s.state!;
  const bits: Node[] = [];
  if (st.error) bits.push(h('span', { class: 'vac-error' }, `⚠ ${st.error.text}`));
  if (st.cleanedArea !== null && (st.phase === 'cleaning' || st.phase === 'paused')) bits.push(h('span', {}, `${st.cleanedArea} m²`));
  if (st.cleaningMinutes !== null && (st.phase === 'cleaning' || st.phase === 'paused')) bits.push(h('span', {}, `${st.cleaningMinutes} min`));
  if (st.progress !== null && st.phase === 'cleaning') bits.push(h('span', {}, `${st.progress}% done`));
  const tanks = st.tanks;
  if (tanks.clean === 'low' || tanks.clean === 'missing') bits.push(h('span', { class: 'vac-warn' }, 'Fill the clean water tank'));
  if (tanks.dirty === 'full') bits.push(h('span', { class: 'vac-warn' }, 'Empty the dirty water tank'));
  if (tanks.dustBag === 'missing' || tanks.dustBag === 'check') bits.push(h('span', { class: 'vac-warn' }, 'Check the dust bag'));
  if (s.status === 'offline') bits.push(h('span', { class: 'vac-warn' }, 'Not updating'));
  return h('div', { class: 'vac-status' }, ...bits);
}

function partsView(st: RobotState) {
  const items: [string, number | null][] = [
    ['Main brush', st.parts.mainBrush],
    ['Side brush', st.parts.sideBrush],
    ['Filter', st.parts.filter],
    ['Mop pads', st.parts.mopPads],
    ['Sensors', st.parts.sensors],
  ];
  const known = items.filter(([, v]) => v !== null);
  if (!known.length) return null;
  return h(
    'div',
    { class: 'vac-section' },
    h('div', { class: 'vac-section-title' }, 'Parts left'),
    h('div', { class: 'vac-parts' }, ...known.map(([name, v]) => h('div', { class: `vac-part${v! <= 10 ? ' low' : ''}` }, h('span', {}, name), h('b', {}, `${v}%`)))),
  );
}

function battery(st: RobotState) {
  if (st.battery === null) return h('span', {});
  const cls = st.battery <= 15 ? 'low' : st.battery <= 30 ? 'mid' : '';
  return h('span', { class: `vac-battery ${cls}` }, `${st.charging ? '⚡' : ''}${st.battery}%`);
}

function robotIcon(phase: Phase) {
  return h('span', { class: `vac-icon ${phase}`, 'aria-hidden': 'true' }, phase === 'error' ? '⚠️' : '🤖');
}

function message(icon: string, text: string, extra?: Node) {
  return h('div', { class: 'vac-message' }, h('div', { class: 'vac-message-icon' }, icon), h('div', {}, text), extra);
}

// ---- Room map -----------------------------------------------------------

const ROOM_HUES = [210, 150, 35, 280, 0, 180, 95, 320, 55, 250, 125, 15];

function drawMap(canvas: HTMLCanvasElement, wrap: HTMLElement, pic: MapPicture, selected: Set<number>, tappable: boolean, onTap: (id: number) => void) {
  const raw = Uint8Array.from(atob(pic.pixels), (c) => c.charCodeAt(0));
  const rot = pic.rotation;
  const sideways = rot === 90 || rot === 270;
  const w = sideways ? pic.height : pic.width;
  const hgt = sideways ? pic.width : pic.height;
  // Map (x, y) in the picture as shown to the source pixel.
  const src = (x: number, y: number) => {
    if (rot === 90) return raw[(pic.height - 1 - x) * pic.width + y];
    if (rot === 180) return raw[(pic.height - 1 - y) * pic.width + (pic.width - 1 - x)];
    if (rot === 270) return raw[x * pic.width + (pic.width - 1 - y)];
    return raw[y * pic.width + x];
  };
  const light = document.documentElement.dataset.theme === 'light';
  const css = getComputedStyle(wrap);
  const accent = css.getPropertyValue('--accent').trim() || '#4da3ff';
  canvas.width = w;
  canvas.height = hgt;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(w, hgt);
  const ids = pic.rooms.map((r) => r.id);
  const color = (id: number) => {
    const hue = ROOM_HUES[ids.indexOf(id) % ROOM_HUES.length] ?? 210;
    return hslToRgb(hue, selected.size && !selected.has(id) ? 15 : 55, light ? 72 : selected.has(id) ? 52 : 34);
  };
  const acc = hexToRgb(accent);
  const sums = new Map<number, [number, number, number]>();
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const v = src(x, y);
      if (!v) continue;
      const i = (y * w + x) * 4;
      let rgb: [number, number, number];
      if (v === WALL) rgb = light ? [70, 80, 95] : [150, 160, 175];
      else {
        rgb = selected.has(v) ? acc : color(v);
        const s = sums.get(v) ?? [0, 0, 0];
        s[0] += x;
        s[1] += y;
        s[2]++;
        sums.set(v, s);
      }
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // Labels, drawn on an overlay at screen resolution so text stays sharp.
  const labels = h('div', { class: 'vac-map-labels' });
  for (const r of pic.rooms) {
    const s = sums.get(r.id);
    if (!s || s[2] < 30) continue;
    labels.append(h('span', { class: `vac-map-label${selected.has(r.id) ? ' on' : ''}`, style: `left:${((s[0] / s[2]) / w) * 100}%;top:${((s[1] / s[2]) / hgt) * 100}%` }, r.name));
  }
  wrap.append(labels);
  wrap.style.aspectRatio = `${w} / ${hgt}`;
  if (!tappable) return;
  wrap.onclick = (e) => {
    const box = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - box.left) / box.width) * w);
    const y = Math.floor(((e.clientY - box.top) / box.height) * hgt);
    // Nearest room within a few pixels, so tapping on a wall or doorway still works.
    for (let r = 0; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const px = x + dx;
          const py = y + dy;
          if (px < 0 || py < 0 || px >= w || py >= hgt) continue;
          const v = src(px, py);
          if (v && v !== WALL && ids.includes(v)) return onTap(v);
        }
      }
    }
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [77, 163, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hslToRgb(hue: number, sat: number, lig: number): [number, number, number] {
  const s = sat / 100;
  const l = lig / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
