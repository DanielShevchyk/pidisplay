// The dashboard shell: persistent top bar, rotating pages of tiles, and an edit
// mode for rearranging, resizing, adding and configuring widgets by touch.
import { api, createStorage, onServerEvent } from './api';
import { h, uid } from './dom';
import { icon } from './icons';
import { Alerts } from './alerts';
import { ReminderAlerts } from './reminder-alerts';
import { CheckinPrompt } from './checkin-prompt';
import { Notifications } from './notifications';
import { initStockAlertSounds } from './stocks';
import { allWidgets, getWidget } from './registry';
import { openSheet, settingsForm, type SheetHandle } from './sheet';
import { showBluetooth, showWifi } from './connections';
import { currentTheme, setTheme, type Theme } from './theme';
import { VoiceUI } from './voice';
import { SleepUI, showSleep } from './sleep';
import { cellsFor, emptyCells, ensurePlaced, placeWithPush, rectOf, renderSizeFor, spotForNew, type Rect } from './grid';
import {
  SIZE_LABELS,
  SIZE_SPANS,
  WIDE_RENDER_AS,
  type LayoutSize,
  type WideSize,
  type Layout,
  type PageConfig,
  type Placement,
  type SettingField,
  type TileSize,
  type TileConfig,
  type WidgetConfig,
  type WidgetContext,
  type WidgetDefinition,
  type WidgetInstance,
} from './types';

// A page swipe commits past this share of the screen width, or on a quick flick.
const SWIPE_SHARE = 0.15;
const FLICK_PX_PER_MS = 0.3;
const FLICK_MIN_PX = 40;
const SWIPE_START_PX = 12;
const EDGE_RESISTANCE = 0.3;
const DRAG_START_PX = 10;
// Holding a dragged tile this close to the screen's side for this long carries it to the next page.
const EDGE_ZONE_PX = 80;
const EDGE_HOLD_MS = 650;
// A little longer than the .track slide in styles.css.
const SLIDE_MS = 450;
const FLIP_MS = 180;
const UNDO_LIMIT = 50;
// Resize handles on the selected tile: four corners and four edges.
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Handle = (typeof HANDLES)[number];

/** A tile's grid-area for a rect in cells. */
const area = (r: Rect) => `${r.y + 1} / ${r.x + 1} / span ${r.h} / span ${r.w}`;

interface Mounted {
  el: HTMLElement;
  body: HTMLElement;
  key: string;
  instance?: WidgetInstance | void;
  cleanups: (() => void)[];
}

type BarSide = 'left' | 'right';

export class App {
  private page = 0;
  private editing = false;
  private tiles = new Map<string, Mounted>();
  private barItems = new Map<string, Mounted>();
  private lastInteraction = 0;
  private lastPageChange = Date.now();
  /** Voice "stay on this page": no rotating until then. */
  private holdUntil = 0;
  private voice: VoiceUI;
  private sleep: SleepUI;
  /** The wall display unmounts every widget while its screen sleeps, so nothing refreshes or animates. */
  private paused = false;
  private saveTimer = 0;
  /** The tile showing resize handles and actions in edit mode. */
  private selected: string | null = null;
  /** Layout snapshots (JSON) for Undo, newest last, and the state they were taken from. */
  private undoStack: string[] = [];
  private lastSnapshot = '';
  private undoBtn!: HTMLButtonElement;
  private editTitle = h('div', { class: 'page-title' });
  private ghost = h('div', { class: 'ghost' });

  private barLeft = h('div', { class: 'bar-slot bar-left' });
  private barRight = h('div', { class: 'bar-slot bar-right' });
  private pageTitle = h('div', { class: 'page-title' });
  private dots = h('div', { class: 'dots' });
  private track = h('div', { class: 'track' });
  private main = h('main', { class: 'main' }, this.track);
  private saveStatus = h('span', { class: 'save-status' });
  private notifications: Notifications;

  constructor(
    private root: HTMLElement,
    private layout: Layout,
  ) {
    this.notifications = new Notifications(root);
    const alerts = new Alerts(document.body);
    initStockAlertSounds();
    const reminderAlerts = new ReminderAlerts(document.body);
    const checkinPrompt = new CheckinPrompt(document.body);
    this.voice = new VoiceUI(document.body, {
      goTo: (i) => this.goTo(i),
      step: (delta) => this.goTo(this.page + delta),
      hold: (ms) => {
        this.holdUntil = ms ? Date.now() + ms : 0;
        if (!ms) this.lastInteraction = 0;
      },
    });
    const kiosk = document.body.classList.contains('kiosk');
    this.sleep = new SleepUI(document.body, kiosk, {
      onSleep: () => {
        if (!kiosk || this.editing) return;
        this.paused = true;
        this.prune(this.tiles, new Set());
        this.prune(this.barItems, new Set());
      },
      onWake: () => {
        // Coming back from sleep counts as a touch, so the page doesn't flip away at once.
        this.lastInteraction = Date.now();
        if (!this.paused) return;
        this.paused = false;
        this.sync();
      },
    });
    const editBtn = h(
      'button',
      { class: 'btn btn-ghost bar-btn', 'aria-label': 'Edit dashboard', onclick: () => this.setEditing(!this.editing) },
      icon('pencil'),
    );
    const menuBtn = h(
      'button',
      { class: 'btn btn-ghost bar-btn', 'aria-label': 'Settings', onclick: () => this.openMenu() },
      icon('settings'),
    );
    this.undoBtn = h('button', { class: 'btn', disabled: true, onclick: () => this.undo() }, icon('undo-2'), ' Undo') as HTMLButtonElement;
    // While editing, this bar takes the top bar's place, so nothing floats over the tiles.
    const editBar = h(
      'header',
      { class: 'editbar' },
      h(
        'div',
        { class: 'editbar-page' },
        h('button', { class: 'btn btn-ghost bar-btn', 'aria-label': 'Previous page', onclick: () => this.goTo(this.page - 1) }, icon('chevron-left')),
        this.editTitle,
        h('button', { class: 'btn btn-ghost bar-btn', 'aria-label': 'Next page', onclick: () => this.goTo(this.page + 1) }, icon('chevron-right')),
      ),
      h('button', { class: 'btn', onclick: () => this.openAddTile() }, icon('plus'), ' Tile'),
      h('button', { class: 'btn', onclick: () => this.addPage() }, icon('plus'), ' Page'),
      h('button', { class: 'btn', onclick: () => this.openPageSettings() }, 'Page'),
      h('button', { class: 'btn', onclick: () => this.openTopBarSettings() }, 'Top bar'),
      h('button', { class: 'btn', onclick: () => this.openDisplaySettings() }, 'Display'),
      h('span', { class: 'editbar-gap' }),
      this.saveStatus,
      this.undoBtn,
      h('button', { class: 'btn btn-primary', onclick: () => this.setEditing(false) }, 'Done'),
    );
    root.classList.add('app');
    root.append(
      h(
        'header',
        { class: 'topbar' },
        this.barLeft,
        h('div', { class: 'bar-center' }, this.pageTitle, this.dots),
        h('div', { class: 'bar-slot bar-actions' }, this.barRight, alerts.chip, reminderAlerts.chip, checkinPrompt.chip, this.voice.button, this.notifications.button, editBtn, menuBtn),
      ),
      editBar,
      this.main,
    );

    this.bindGestures();
    this.sync();
    setInterval(() => this.tick(), 1000);
    onServerEvent('layout', async () => {
      // Another screen (e.g. a phone) changed the layout. Don't clobber local edits.
      if (this.editing) return;
      this.layout = await api.getLayout();
      if (!this.paused) this.sync();
    });
  }

  // ---- Rendering -------------------------------------------------------

  /** Reconcile the DOM with this.layout, reusing widget instances that didn't change. */
  private sync() {
    const { settings, pages, topBar } = this.layout;
    const { columns, rows } = settings;
    this.main.style.setProperty('--cols', String(columns));
    this.main.style.setProperty('--rows', String(rows));

    const seenBar = new Set<string>();
    for (const side of ['left', 'right'] as BarSide[]) {
      const slot = side === 'left' ? this.barLeft : this.barRight;
      slot.replaceChildren(
        ...topBar[side].map((item) => {
          seenBar.add(item.id);
          const m = this.mountInto(this.barItems, item.id, item.widget, 'bar', item.config);
          return m.el;
        }),
      );
    }
    this.prune(this.barItems, seenBar);

    const seenTiles = new Set<string>();
    this.track.replaceChildren(
      ...pages.map((page) => {
        ensurePlaced(page.tiles, columns, rows);
        const grid = h('div', { class: 'grid', 'data-page': page.id });
        // Edit mode: every empty cell is a "+" that adds a tile right there.
        if (this.editing) {
          for (const cell of emptyCells(page.tiles, columns, rows)) {
            grid.append(
              h('button', { class: 'slot', 'aria-label': 'Add a tile here', style: `grid-area: ${area(cell)}`, onclick: () => this.openAddTile(cell) }, icon('plus')),
            );
          }
        }
        for (const tile of page.tiles) {
          seenTiles.add(tile.id);
          const size = this.renderSizeOf(tile);
          tile.size = size;
          const m = this.mountInto(this.tiles, tile.id, tile.widget, size, tile.config);
          const r = rectOf(tile);
          m.el.style.gridArea = area(r);
          m.el.dataset.size = size;
          m.el.classList.toggle('overflow', r.y + r.h > rows);
          m.el.classList.remove('lifted');
          grid.append(m.el);
        }
        return h('section', { class: 'page' }, grid);
      }),
    );
    this.prune(this.tiles, seenTiles);

    this.goTo(Math.min(this.page, pages.length - 1), false);
    this.renderSelection();
  }

  private renderSizeOf(tile: TileConfig): TileSize {
    const { columns, rows } = this.layout.settings;
    const r = rectOf(tile);
    return renderSizeFor(r.w, r.h, columns, rows, getWidget(tile.widget)?.sizes);
  }

  private mountInto(
    registry: Map<string, Mounted>,
    id: string,
    type: string,
    placement: Placement,
    config: WidgetConfig = {},
  ): Mounted {
    const key = JSON.stringify([type, placement, config]);
    let m = registry.get(id);
    if (m?.key === key) return m;

    if (m) this.teardown(m);
    else {
      const body = h('div', { class: 'widget-body' });
      const el =
        placement === 'bar'
          ? h('div', { class: 'bar-item', 'data-id': id, onclick: () => this.editing && this.openBarItemSettings(id) }, body)
          : h('div', { class: 'tile', 'data-id': id }, body);
      m = { el, body, key, cleanups: [] };
      registry.set(id, m);
    }
    m.key = key;
    m.body.replaceChildren();
    m.el.dataset.widget = type;

    const def = getWidget(type);
    if (!def) {
      m.body.append(h('div', { class: 'widget-error' }, `Unknown widget "${type}"`));
      return m;
    }
    try {
      m.instance = def.mount(m.body, this.context(def, id, placement, config, m.cleanups));
    } catch (err) {
      console.error(`Widget ${type} failed to mount`, err);
      m.body.replaceChildren(h('div', { class: 'widget-error' }, `${def.name} failed to load`));
    }
    return m;
  }

  private context(
    def: WidgetDefinition,
    id: string,
    placement: Placement,
    config: WidgetConfig,
    cleanups: (() => void)[],
  ): WidgetContext {
    const app = this;
    // Track subscriptions so a widget that forgets to unsubscribe can't leak.
    const tracked = (storageKey: string) => {
      const s = createStorage(storageKey);
      return { ...s, onChange: (fn: () => void) => track(s.onChange(fn)) };
    };
    const track = (off: () => void) => (cleanups.push(off), off);
    return {
      instanceId: id,
      placement,
      config: { ...def.defaultConfig, ...config },
      storage: tracked(`${def.type}.${id}`),
      sharedStorage: tracked(def.type),
      notify: (n) => void api.notify({ ...n, source: def.name }),
      on: (event, handler) => track(onServerEvent(event, handler)),
      get editing() {
        return app.editing;
      },
      saveConfig: (patch) => app.saveConfig(id, patch),
    };
  }

  private teardown(m: Mounted) {
    try {
      m.instance?.destroy?.();
    } catch (err) {
      console.error('Widget destroy failed', err);
    }
    m.cleanups.splice(0).forEach((off) => off());
    m.instance = undefined;
  }

  private prune(registry: Map<string, Mounted>, keep: Set<string>) {
    for (const [id, m] of registry) {
      if (keep.has(id)) continue;
      this.teardown(m);
      m.el.remove();
      registry.delete(id);
    }
  }

  // ---- Pages and rotation ---------------------------------------------

  private goTo(index: number, animate = true) {
    const count = this.layout.pages.length;
    const from = this.page;
    this.page = ((index % count) + count) % count;
    this.lastPageChange = Date.now();
    // Sliding across several pages (wrapping around, or a far dot) would drag
    // every page in between across the screen; a quick fade is cheaper and calmer.
    const jump = animate && Math.abs(this.page - from) > 1;
    this.track.style.transition = animate && !jump ? '' : 'none';
    this.track.style.transform = `translate3d(${-100 * this.page}%, 0, 0)`;
    if (jump) this.main.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, easing: 'ease-out' });
    this.pageTitle.textContent = this.layout.pages[this.page].name;
    this.editTitle.textContent = this.layout.pages[this.page].name;
    this.dots.replaceChildren(
      ...this.layout.pages.map((p, i) =>
        h('button', {
          class: `dot${i === this.page ? ' active' : ''}`,
          'aria-label': p.name,
          onclick: () => this.goTo(i),
        }),
      ),
    );
    this.dots.hidden = count < 2;
  }

  private tick() {
    const { rotateSeconds, resumeAfterSeconds } = this.layout.settings;
    if (this.editing || this.sleep.asleep || rotateSeconds <= 0 || this.layout.pages.length < 2) return;
    if (document.querySelector('.sheet-backdrop, [data-hold-rotation]')) return;
    const now = Date.now();
    if (now < this.holdUntil) return;
    if (now - this.lastInteraction < resumeAfterSeconds * 1000) return;
    if (now - this.lastPageChange >= rotateSeconds * 1000) this.goTo(this.page + 1);
  }

  private bindGestures() {
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerdown', () => (this.lastInteraction = Date.now()), true);

    // The pages follow the finger and settle on release, rather than waiting
    // for the finger to lift before moving at all.
    let drag: { x: number; y: number; id: number; width: number; dx: number; t: number; v: number; following: boolean } | null = null;
    let frame = 0;
    const paint = () => {
      frame = 0;
      if (!drag?.following) return;
      const count = this.layout.pages.length;
      const atEdge = (this.page === 0 && drag.dx > 0) || (this.page === count - 1 && drag.dx < 0);
      const dx = atEdge ? drag.dx * EDGE_RESISTANCE : drag.dx;
      this.track.style.transform = `translate3d(calc(${-100 * this.page}% + ${dx}px), 0, 0)`;
    };

    this.main.addEventListener('pointerdown', (e) => {
      if (this.editing) {
        const target = e.target as HTMLElement;
        if (target.closest('.sel-frame, .slot')) return;
        const tile = target.closest<HTMLElement>('.tile');
        if (tile) this.startDrag(e, tile);
        else this.select(null);
        return;
      }
      if (!e.isPrimary || ownsSideways(e.target as HTMLElement)) return;
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId, width: this.main.clientWidth, dx: 0, t: e.timeStamp, v: 0, following: false };
    });

    this.main.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      if (!drag.following) {
        const dy = e.clientY - drag.y;
        if (Math.hypot(dx, dy) < SWIPE_START_PX) return;
        // A mostly vertical drag is a list scroll, not a page swipe.
        if (Math.abs(dx) < Math.abs(dy) * 1.2) return void (drag = null);
        drag.following = true;
        this.track.style.transition = 'none';
        // Keep getting the moves even when the finger passes over a map or other frame.
        this.main.setPointerCapture(e.pointerId);
      }
      const dt = Math.max(1, e.timeStamp - drag.t);
      drag.v = (dx - drag.dx) / dt;
      drag.dx = dx;
      drag.t = e.timeStamp;
      frame ||= requestAnimationFrame(paint);
    });

    const end = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { dx, v, width, following, t } = drag;
      drag = null;
      if (!following) return;
      cancelAnimationFrame(frame);
      frame = 0;
      // The lift shouldn't also count as a tap on whatever is under the finger.
      const swallow = (c: Event) => (c.preventDefault(), c.stopPropagation());
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, true), 50);

      const fresh = e.timeStamp - t < 100;
      const flick = fresh && Math.abs(v) > FLICK_PX_PER_MS && Math.abs(dx) > FLICK_MIN_PX && Math.sign(v) === Math.sign(dx);
      const step = e.type === 'pointercancel' ? 0 : Math.abs(dx) > width * SWIPE_SHARE || flick ? (dx < 0 ? 1 : -1) : 0;
      this.goTo(this.page + step);
    };
    this.main.addEventListener('pointerup', end);
    this.main.addEventListener('pointercancel', end);
  }

  // ---- Edit mode ------------------------------------------------------

  private setEditing(on: boolean) {
    this.editing = on;
    this.root.classList.toggle('editing', on);
    this.saveStatus.textContent = '';
    this.selected = null;
    this.undoStack = [];
    this.lastSnapshot = on ? JSON.stringify(this.layout) : '';
    this.undoBtn.disabled = true;
    if (!on) this.flushSave();
    // Adds or removes the "+" slots in empty cells.
    this.sync();
  }

  // ---- Edit mode: selecting --------------------------------------------

  private select(id: string | null) {
    if (this.selected === id) return;
    this.selected = id;
    this.renderSelection();
  }

  /**
   * The selected tile gets a frame with resize handles and its actions. The frame
   * is a sibling of the tile in the page grid, on the same grid area, so the
   * tile's own clipping doesn't cut the handles off and nothing sits outside the page.
   */
  private renderSelection() {
    this.track.querySelector('.sel-frame')?.remove();
    for (const el of this.track.querySelectorAll('.tile.selected')) el.classList.remove('selected');
    if (!this.editing || !this.selected) return;
    const found = this.findTile(this.selected);
    const m = this.tiles.get(this.selected);
    if (!found || !m?.el.parentElement) return void (this.selected = null);
    const id = this.selected;
    const def = getWidget(found.tile.widget);
    m.el.classList.add('selected');
    const frame = h(
      'div',
      { class: 'sel-frame', style: `grid-area: ${area(rectOf(found.tile))}` },
      ...HANDLES.map((edge) =>
        h('div', { class: `hd hd-${edge}`, 'data-edge': edge, onpointerdown: (e: PointerEvent) => this.startResize(e, id, edge) }, h('i')),
      ),
      h(
        'div',
        { class: 'sel-actions' },
        h('button', { class: 'sel-btn', 'aria-label': 'Settings', onclick: () => this.openTileSettings(id) }, icon('settings'), h('span', {}, 'Settings')),
        this.layout.pages.length > 1
          ? h('button', { class: 'sel-btn', 'aria-label': 'Move to page', onclick: () => this.openMoveToPage(id) }, icon('move-right'), h('span', {}, 'Move to page'))
          : null,
        h('button', { class: 'sel-btn sel-remove', 'aria-label': 'Remove', onclick: () => this.removeTile(id) }, icon('x'), h('span', {}, 'Remove')),
      ),
      h('div', { class: 'sel-size' }, `${def?.name ?? found.tile.widget} · ${found.tile.w} × ${found.tile.h}`),
    );
    m.el.after(frame);
  }

  // ---- Edit mode: moving and resizing ------------------------------------

  /** Cell metrics of a page grid on screen, for turning finger positions into cells. */
  private gridMetrics(grid: HTMLElement) {
    const { columns, rows } = this.layout.settings;
    const g = grid.getBoundingClientRect();
    const style = getComputedStyle(grid);
    const colGap = parseFloat(style.columnGap) || 0;
    const rowGap = parseFloat(style.rowGap) || 0;
    const cellW = (g.width - (columns - 1) * colGap) / columns;
    const cellH = (g.height - (rows - 1) * rowGap) / rows;
    return { left: g.left, top: g.top, pitchX: cellW + colGap, pitchY: cellH + rowGap };
  }

  private gridOf(pageIndex: number): HTMLElement {
    return this.track.children[pageIndex].querySelector<HTMLElement>('.grid')!;
  }

  /**
   * Show a candidate arrangement: tiles slide (FLIP) to their new spots without
   * remounting. `rects` holds new spots by tile id; tiles not in it go back to
   * their saved spot.
   */
  private showArrangement(pages: number[], rects: Map<string, Rect>) {
    const els: { el: HTMLElement; to: string }[] = [];
    for (const i of new Set(pages)) {
      for (const t of this.layout.pages[i].tiles) {
        const el = this.tiles.get(t.id)?.el;
        if (!el) continue;
        const to = area(rects.get(t.id) ?? rectOf(t));
        if (el.style.gridArea !== to) els.push({ el, to });
      }
    }
    const before = els.map(({ el }) => el.getBoundingClientRect());
    for (const { el, to } of els) el.style.gridArea = to;
    els.forEach(({ el }, i) => {
      if (el.classList.contains('lifted')) return;
      const a = before[i];
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) return;
      el.animate(
        [
          { transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${a.width / b.width}, ${a.height / b.height})`, transformOrigin: '0 0' },
          { transform: 'none', transformOrigin: '0 0' },
        ],
        { duration: FLIP_MS, easing: 'ease-out' },
      );
    });
  }

  private showGhost(grid: HTMLElement, r: Rect, ok: boolean) {
    if (this.ghost.parentElement !== grid) grid.append(this.ghost);
    this.ghost.style.gridArea = area(r);
    this.ghost.classList.toggle('bad', !ok);
  }

  /**
   * Dragging a tile. A light card follows the finger and the tile itself waits,
   * dimmed, at the spot it will land on; tiles in the way slide aside. If they
   * have nowhere to go the outline turns red and the tile stays at its last good
   * spot. Holding the card at the side of the screen goes to the next page.
   */
  private startDrag(e: PointerEvent, tileEl: HTMLElement) {
    const id = tileEl.dataset.id!;
    const found = this.findTile(id);
    if (!found) return;
    const { tile } = found;
    const { columns, rows } = this.layout.settings;
    const startX = e.clientX;
    const startY = e.clientY;
    const r0 = tileEl.getBoundingClientRect();
    const grabX = startX - r0.left;
    const grabY = startY - r0.top;
    const src = this.layout.pages.indexOf(found.page);
    const orig = rectOf(tile);
    let pageIndex = src;
    let valid = { page: src, rect: orig, moves: new Map<string, Rect>() };
    let lastKey = '';
    let dragging = false;
    let proxy: HTMLElement | null = null;
    let edgeTimer = 0;
    let edgeDir = 0;
    let fingerX = startX;
    let fingerY = startY;

    const preview = () => {
      const grid = this.gridOf(pageIndex);
      const g = this.gridMetrics(grid);
      const x = Math.max(0, Math.min(columns - orig.w, Math.round((fingerX - grabX - g.left) / g.pitchX)));
      const y = Math.max(0, Math.min(rows - orig.h, Math.round((fingerY - grabY - g.top) / g.pitchY)));
      const key = `${pageIndex}:${x}:${y}`;
      if (key === lastKey) return;
      lastKey = key;
      const rect = { x, y, w: orig.w, h: orig.h };
      const others = this.layout.pages[pageIndex].tiles.filter((t) => t.id !== id);
      const moves = placeWithPush(others, rect, columns, rows);
      this.showGhost(grid, rect, Boolean(moves));
      if (!moves) return;
      const prevPage = valid.page;
      valid = { page: pageIndex, rect, moves };
      if (tileEl.parentElement !== grid) grid.append(tileEl);
      moves.set(id, rect);
      this.showArrangement([prevPage, pageIndex, src], moves);
    };

    const toEdge = () => {
      edgeTimer = 0;
      const next = pageIndex + edgeDir;
      if (next < 0 || next >= this.layout.pages.length) return;
      pageIndex = next;
      this.goTo(next);
      lastKey = '';
      // Measure the new page once it has slid into place.
      setTimeout(() => dragging && preview(), SLIDE_MS);
      edgeTimer = window.setTimeout(toEdge, EDGE_HOLD_MS + SLIDE_MS);
    };

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      fingerX = ev.clientX;
      fingerY = ev.clientY;
      if (!dragging) {
        if (Math.hypot(fingerX - startX, fingerY - startY) < DRAG_START_PX) return;
        dragging = true;
        const def = getWidget(tile.widget);
        proxy = h(
          'div',
          { class: 'drag-proxy', style: `width: ${r0.width}px; height: ${r0.height}px` },
          h('span', { class: 'drag-proxy-icon' }, def?.icon ?? ''),
          h('strong', {}, def?.name ?? tile.widget),
        );
        document.body.append(proxy);
        tileEl.classList.add('lifted');
        this.root.classList.add('arranging');
        this.select(null);
      }
      proxy!.style.transform = `translate3d(${fingerX - grabX}px, ${fingerY - grabY}px, 0) rotate(-1.2deg)`;
      const dir = fingerX < EDGE_ZONE_PX ? -1 : fingerX > window.innerWidth - EDGE_ZONE_PX ? 1 : 0;
      if (dir !== edgeDir) {
        clearTimeout(edgeTimer);
        edgeTimer = 0;
        edgeDir = dir;
        if (dir) edgeTimer = window.setTimeout(toEdge, EDGE_HOLD_MS);
      }
      preview();
    };

    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      clearTimeout(edgeTimer);
      this.root.classList.remove('arranging');
      proxy?.remove();
      this.ghost.remove();
      tileEl.classList.remove('lifted');
      if (!dragging) return void (ev.type === 'pointerup' && this.select(id));
      if (ev.type === 'pointercancel') return void this.sync();
      const same = valid.page === src && valid.rect.x === orig.x && valid.rect.y === orig.y;
      if (same) return void this.sync();
      const target = this.layout.pages[valid.page];
      if (valid.page !== src) {
        const at = found.page.tiles.indexOf(tile);
        found.page.tiles.splice(at, 1);
        target.tiles.push(tile);
      }
      for (const t of target.tiles) {
        const r = valid.moves.get(t.id);
        if (r) Object.assign(t, r);
      }
      Object.assign(tile, valid.rect);
      this.selected = id;
      this.changed();
      if (valid.page !== this.page) this.goTo(valid.page);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /**
   * Resizing from any corner or edge of the selected tile, in whole cells. The
   * opposite side stays put, the tile stretches live, and tiles in the way slide
   * aside. The widget redraws for its new size when the finger lifts.
   */
  private startResize(e: PointerEvent, id: string, edge: Handle) {
    const found = this.findTile(id);
    const tileEl = this.tiles.get(id)?.el;
    const grid = tileEl?.parentElement;
    const frame = this.track.querySelector<HTMLElement>('.sel-frame');
    if (!found || !tileEl || !grid || !frame) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);

    const { tile, page } = found;
    const { columns, rows } = this.layout.settings;
    const orig = rectOf(tile);
    const g = this.gridMetrics(grid);
    const others = page.tiles.filter((t) => t.id !== id);
    const label = frame.querySelector<HTMLElement>('.sel-size')!;
    const name = getWidget(tile.widget)?.name ?? tile.widget;
    let valid = { rect: orig, moves: new Map<string, Rect>() };
    let lastKey = '';
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const dx = Math.round((ev.clientX - e.clientX) / g.pitchX);
      const dy = Math.round((ev.clientY - e.clientY) / g.pitchY);
      let { x, y, w, h: ht } = orig;
      if (edge.includes('e')) w = clamp(orig.w + dx, 1, columns - orig.x);
      if (edge.includes('w')) {
        x = clamp(orig.x + dx, 0, orig.x + orig.w - 1);
        w = orig.x + orig.w - x;
      }
      if (edge.includes('s')) ht = clamp(orig.h + dy, 1, Math.max(1, rows - orig.y));
      if (edge.includes('n')) {
        y = clamp(orig.y + dy, 0, orig.y + orig.h - 1);
        ht = orig.y + orig.h - y;
      }
      const rect = { x, y, w, h: ht };
      const key = `${x}:${y}:${w}:${ht}`;
      if (key === lastKey) return;
      lastKey = key;
      const moves = placeWithPush(others, rect, columns, rows);
      this.showGhost(grid, rect, Boolean(moves));
      label.textContent = `${name} · ${w} × ${ht}`;
      if (!moves) return;
      valid = { rect, moves };
      frame.style.gridArea = area(rect);
      moves.set(id, rect);
      this.showArrangement([this.layout.pages.indexOf(page)], moves);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      frame.classList.remove('resizing');
      this.root.classList.remove('arranging');
      this.ghost.remove();
      const r = valid.rect;
      if (ev.type === 'pointercancel' || (r.x === orig.x && r.y === orig.y && r.w === orig.w && r.h === orig.h)) return void this.sync();
      for (const t of others) {
        const m = valid.moves.get(t.id);
        if (m) Object.assign(t, m);
      }
      Object.assign(tile, r);
      this.changed();
    };
    frame.classList.add('resizing');
    this.root.classList.add('arranging');
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  private findTile(id: string): { page: PageConfig; index: number; tile: TileConfig } | null {
    for (const page of this.layout.pages) {
      const index = page.tiles.findIndex((t) => t.id === id);
      if (index >= 0) return { page, index, tile: page.tiles[index] };
    }
    return null;
  }

  /** Settings changed from inside a widget, e.g. the weather tile's location picker. */
  private saveConfig(id: string, patch: WidgetConfig) {
    const item =
      this.findTile(id)?.tile ?? [...this.layout.topBar.left, ...this.layout.topBar.right].find((i) => i.id === id);
    if (!item) return;
    item.config = { ...item.config, ...patch };
    this.changed();
  }

  private changed() {
    this.sync();
    if (this.editing) {
      const now = JSON.stringify(this.layout);
      if (now !== this.lastSnapshot) {
        this.undoStack.push(this.lastSnapshot);
        if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
        this.lastSnapshot = now;
      }
      this.undoBtn.disabled = !this.undoStack.length;
    }
    this.scheduleSave();
  }

  private scheduleSave() {
    this.saveStatus.textContent = 'Saving…';
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flushSave(), 500);
  }

  private undo() {
    const prev = this.undoStack.pop();
    this.undoBtn.disabled = !this.undoStack.length;
    if (!prev) return;
    this.layout = JSON.parse(prev);
    this.lastSnapshot = prev;
    if (this.selected && !this.findTile(this.selected)) this.selected = null;
    this.sync();
    this.scheduleSave();
  }

  private async flushSave() {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    try {
      await api.saveLayout(this.layout);
      this.saveStatus.textContent = 'Saved';
    } catch (err) {
      console.error(err);
      this.saveStatus.textContent = 'Save failed';
    }
  }

  /** The widget's own sizes plus the full-width ones it can stretch into, before 'full'. */
  private allowedSizes(type: string): LayoutSize[] {
    const own: LayoutSize[] = getWidget(type)?.sizes ?? (Object.keys(SIZE_SPANS) as LayoutSize[]);
    const wide = (Object.keys(WIDE_RENDER_AS) as WideSize[]).filter(
      (w) => own.includes(WIDE_RENDER_AS[w]) && !own.includes(w),
    );
    const at = own.includes('full') ? own.indexOf('full') : own.length;
    return [...own.slice(0, at), ...wide, ...own.slice(at)];
  }

  /** Resize a tile to w x h from the settings sheet: in place if possible, pushing neighbours, else somewhere it fits. */
  private resizeTo(id: string, w: number, h: number) {
    const found = this.findTile(id);
    if (!found) return;
    const { columns, rows } = this.layout.settings;
    const { tile, page } = found;
    const others = page.tiles.filter((t) => t.id !== id);
    const cur = rectOf(tile);
    const rect = { x: Math.max(0, Math.min(cur.x, columns - w)), y: Math.max(0, Math.min(cur.y, rows - h)), w, h };
    const moves = placeWithPush(others, rect, columns, rows);
    if (moves) {
      for (const t of others) Object.assign(t, moves.get(t.id) ?? {});
      Object.assign(tile, rect);
    } else {
      Object.assign(tile, spotForNew(others, w, h, columns, rows, cur));
    }
    this.changed();
  }

  private removeTile(id: string) {
    const found = this.findTile(id);
    if (!found) return;
    found.page.tiles.splice(found.index, 1);
    if (this.selected === id) this.selected = null;
    this.changed();
  }

  private moveTileToPage(id: string, pageIndex: number) {
    const current = this.findTile(id);
    const target = this.layout.pages[pageIndex];
    if (!current || !target || target === current.page) return;
    const { columns, rows } = this.layout.settings;
    const { tile } = current;
    current.page.tiles.splice(current.index, 1);
    Object.assign(tile, spotForNew(target.tiles, tile.w ?? 1, tile.h ?? 1, columns, rows, rectOf(tile)));
    target.tiles.push(tile);
    this.changed();
    this.goTo(pageIndex);
  }

  private openMoveToPage(id: string) {
    const sheet = openSheet('Move to page', [
      h(
        'div',
        { class: 'chips' },
        ...this.layout.pages.map((p, i) =>
          h(
            'button',
            { class: `chip${i === this.page ? ' active' : ''}`, onclick: () => (sheet.close(), this.moveTileToPage(id, i)) },
            p.name,
          ),
        ),
      ),
    ]);
  }

  private openAddTile(at?: Rect) {
    const sheet = openSheet(
      'Add a tile',
      [
        h(
          'div',
          { class: 'picker' },
          ...allWidgets().map((def) =>
            h(
              'button',
              {
                class: 'picker-item',
                onclick: () => {
                  const { columns, rows } = this.layout.settings;
                  const page = this.layout.pages[this.page];
                  const [w, ht] = cellsFor(def.defaultSize, columns, rows);
                  const id = uid(def.type);
                  page.tiles.push({ id, widget: def.type, size: def.defaultSize, config: {}, ...spotForNew(page.tiles, w, ht, columns, rows, at) });
                  sheet.close();
                  this.selected = id;
                  this.changed();
                },
              },
              def.logo
                ? Object.assign(h('span', { class: 'picker-icon picker-logo' }), { innerHTML: def.logo })
                : h('span', { class: 'picker-icon' }, def.icon),
              h('strong', {}, def.name),
              h('small', {}, def.description),
            ),
          ),
        ),
      ],
    );
  }

  private openTileSettings(id: string) {
    const found = this.findTile(id);
    const def = found && getWidget(found.tile.widget);
    if (!found || !def) return;
    const { tile } = found;
    const { columns, rows } = this.layout.settings;

    // Quick sizes; the handles on the tile do any other shape.
    const sizeRow = () =>
      h(
        'div',
        { class: 'chips' },
        ...this.allowedSizes(tile.widget).map((size) => {
          const [w, ht] = cellsFor(size, columns, rows);
          return h(
            'button',
            {
              class: `chip${tile.w === w && tile.h === ht ? ' active' : ''}`,
              onclick: () => {
                this.resizeTo(id, w, ht);
                sizes.replaceWith((sizes = sizeRow()));
              },
            },
            `${SIZE_LABELS[size]} · ${w}×${ht}`,
          );
        }),
      );
    let sizes = sizeRow();

    const pageSelect = h(
      'select',
      {
        onchange: (e: Event) => {
          const i = this.layout.pages.findIndex((p) => p.id === (e.target as HTMLSelectElement).value);
          this.moveTileToPage(id, i);
        },
      },
      ...this.layout.pages.map((p) => h('option', { value: p.id, selected: p.tiles.includes(tile) }, p.name)),
    );

    const sheet = openSheet(`${def.icon} ${def.name}`, [
      h('h3', {}, 'Size'),
      sizes,
      ...(def.settings?.length
        ? [
            h('h3', {}, 'Settings'),
            settingsForm(def.settings, { ...def.defaultConfig, ...tile.config }, (next) => {
              tile.config = next;
              this.changed();
            }),
          ]
        : []),
      h('label', { class: 'field' }, h('span', {}, 'Page'), pageSelect),
      h(
        'button',
        { class: 'btn btn-danger btn-wide', onclick: () => (sheet.close(), this.removeTile(id)) },
        'Remove tile',
      ),
    ]);
  }

  private addPage() {
    this.layout.pages.splice(this.page + 1, 0, { id: uid('page'), name: `Page ${this.layout.pages.length + 1}`, tiles: [] });
    this.changed();
    this.goTo(this.page + 1);
  }

  private openPageSettings() {
    const page = this.layout.pages[this.page];
    const movePage = (delta: number) => {
      const to = this.page + delta;
      if (to < 0 || to >= this.layout.pages.length) return;
      const [p] = this.layout.pages.splice(this.page, 1);
      this.layout.pages.splice(to, 0, p);
      this.page = to;
      this.changed();
    };
    let sheet: SheetHandle;
    const content: Node[] = [
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'Name'),
        h('input', {
          type: 'text',
          value: page.name,
          onchange: (e: Event) => {
            page.name = (e.target as HTMLInputElement).value.trim() || page.name;
            this.changed();
          },
        }),
      ),
      h(
        'div',
        { class: 'chips' },
        h('button', { class: 'chip', onclick: () => movePage(-1) }, '◀ Move left'),
        h('button', { class: 'chip', onclick: () => movePage(1) }, 'Move right ▶'),
      ),
    ];
    if (this.layout.pages.length > 1) {
      content.push(
        confirmButton(`Delete "${page.name}" and its ${page.tiles.length} tiles`, () => {
          this.layout.pages.splice(this.page, 1);
          sheet.close();
          this.changed();
        }),
      );
    }
    sheet = openSheet('Page', content);
  }

  private openDisplaySettings() {
    const fields: SettingField[] = [
      { key: 'rotateSeconds', label: 'Seconds per page (0 = no rotation)', type: 'number', min: 0, max: 3600 },
      { key: 'resumeAfterSeconds', label: 'Resume rotating after a touch (seconds)', type: 'number', min: 0, max: 3600 },
      { key: 'columns', label: 'Grid columns', type: 'number', min: 2, max: 12 },
      { key: 'rows', label: 'Grid rows', type: 'number', min: 1, max: 8 },
    ];
    const s = this.layout.settings;
    openSheet('Display', [
      settingsForm(fields, { ...s }, (next) => {
        const clamp = (v: unknown, min: number, max: number, fallback: number) =>
          Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v as number))) : fallback;
        s.rotateSeconds = clamp(next.rotateSeconds, 0, 3600, s.rotateSeconds);
        s.resumeAfterSeconds = clamp(next.resumeAfterSeconds, 0, 3600, s.resumeAfterSeconds);
        s.columns = clamp(next.columns, 2, 12, s.columns);
        s.rows = clamp(next.rows, 1, 8, s.rows);
        this.changed();
      }),
      confirmButton('Reset dashboard to the default layout', async () => {
        clearTimeout(this.saveTimer);
        this.saveTimer = 0;
        await api.resetLayout();
        location.reload();
      }),
    ]);
  }

  private openTopBarSettings() {
    const sheet = openSheet('Top bar', []);
    const render = () => {
      const barWidgets = allWidgets().filter((d) => d.supportsBar);
      sheet.body.replaceChildren(
        ...(['left', 'right'] as BarSide[]).flatMap((side) => [
          h('h3', {}, side === 'left' ? 'Left side' : 'Right side'),
          h(
            'ul',
            { class: 'bar-list' },
            ...this.layout.topBar[side].map((item, i) =>
              h(
                'li',
                {},
                h('span', {}, `${getWidget(item.widget)?.icon ?? '?'} ${getWidget(item.widget)?.name ?? item.widget}`),
                h('button', { class: 'btn btn-ghost', onclick: () => this.openBarItemSettings(item.id) }, icon('settings')),
                h(
                  'button',
                  {
                    class: 'btn btn-ghost',
                    onclick: () => {
                      this.layout.topBar[side].splice(i, 1);
                      this.changed();
                      render();
                    },
                  },
                  icon('x'),
                ),
              ),
            ),
          ),
          h(
            'div',
            { class: 'chips' },
            ...barWidgets.map((def) =>
              h(
                'button',
                {
                  class: 'chip',
                  onclick: () => {
                    this.layout.topBar[side].push({ id: uid(`bar-${def.type}`), widget: def.type, config: {} });
                    this.changed();
                    render();
                  },
                },
                `${def.icon} ${def.name}`,
              ),
            ),
          ),
        ]),
      );
    };
    render();
  }

  private openBarItemSettings(id: string) {
    const item = [...this.layout.topBar.left, ...this.layout.topBar.right].find((i) => i.id === id);
    const def = item && getWidget(item.widget);
    if (!item || !def) return;
    openSheet(`${def.icon} ${def.name} (top bar)`, [
      def.settings?.length
        ? settingsForm(def.settings, { ...def.defaultConfig, ...item.config }, (next) => {
            item.config = next;
            this.changed();
          })
        : h('p', { class: 'empty' }, 'No settings'),
    ]);
  }

  // ---- Gear menu --------------------------------------------------------

  private openMenu() {
    const sheet = openSheet('Settings', []);
    const themeChip = (theme: Theme, label: string) =>
      h(
        'button',
        {
          class: `chip${currentTheme() === theme ? ' active' : ''}`,
          onclick: () => {
            void setTheme(theme).catch((err) => console.error(err));
            showMain();
          },
        },
        label,
      );

    const showMain = () =>
      sheet.body.replaceChildren(
        h('h3', {}, 'Appearance'),
        h('div', { class: 'chips' }, themeChip('dark', '🌙 Dark'), themeChip('light', '☀️ Light')),
        h('h3', {}, 'Screen'),
        h('button', { class: 'btn btn-wide menu-row', onclick: () => showSleep(sheet.body, showMain, () => sheet.close()) }, '🌙 Sleep', h('span', { class: 'menu-chevron' }, '›')),
        h('h3', {}, 'Voice'),
        h('button', { class: 'btn btn-wide menu-row', onclick: () => (sheet.close(), this.voice.openSheet()) }, '🎙️ Voice control', h('span', { class: 'menu-chevron' }, '›')),
        h('h3', {}, 'Connections'),
        h('button', { class: 'btn btn-wide menu-row', onclick: () => showWifi(sheet.body, showMain) }, '📶 Wi-Fi', h('span', { class: 'menu-chevron' }, '›')),
        h('button', { class: 'btn btn-wide menu-row', onclick: () => showBluetooth(sheet.body, showMain) }, '🔵 Bluetooth', h('span', { class: 'menu-chevron' }, '›')),
        h('h3', {}, 'System'),
        h('button', { class: 'btn btn-wide menu-row', onclick: showConfirmExit }, '🖥️ Exit to desktop'),
      );

    const showConfirmExit = () => {
      const status = h('p', { class: 'menu-status' });
      const exitBtn = h(
        'button',
        {
          class: 'btn btn-danger',
          onclick: async () => {
            exitBtn.disabled = true;
            status.textContent = 'Closing…';
            try {
              await api.exitToDesktop();
              status.textContent = 'Closed. The desktop should appear in a moment.';
            } catch (err) {
              console.error(err);
              exitBtn.disabled = false;
              status.textContent = "Couldn't close the dashboard. Exit only works on the Pi itself.";
            }
          },
        },
        'Exit to desktop',
      );
      sheet.body.replaceChildren(
        h('p', { class: 'menu-text' }, 'Close PiDisplay and show the Raspberry Pi desktop?'),
        h(
          'p',
          { class: 'menu-text dim' },
          'To come back, tap the PiDisplay icon on the desktop or open it from the menu (Accessories ▸ PiDisplay). It also comes back on the next reboot.',
        ),
        h('div', { class: 'menu-actions' }, h('button', { class: 'btn', onclick: showMain }, 'Cancel'), exitBtn),
        status,
      );
    };

    showMain();
  }
}

/**
 * True when a sideways drag starting here belongs to the control under the
 * finger (a slider, a text field, a sideways-scrolling row, the stock chart)
 * rather than to page swiping.
 */
function ownsSideways(target: HTMLElement): boolean {
  if (target.closest('input, textarea, select, [contenteditable]')) return true;
  for (let el: HTMLElement | null = target; el && !el.classList.contains('page'); el = el.parentElement) {
    const s = getComputedStyle(el);
    if (s.touchAction === 'none') return true;
    if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) return true;
  }
  return false;
}

/** A destructive button that needs a second tap to confirm. */
function confirmButton(label: string, action: () => void): HTMLElement {
  let armed = false;
  const btn = h(
    'button',
    {
      class: 'btn btn-danger btn-wide',
      onclick: () => {
        if (armed) return action();
        armed = true;
        btn.textContent = 'Tap again to confirm';
        setTimeout(() => {
          armed = false;
          btn.textContent = label;
        }, 3000);
      },
    },
    label,
  );
  return btn;
}
