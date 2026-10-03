// The dashboard shell: persistent top bar, rotating pages of tiles, and an edit
// mode for rearranging, resizing, adding and configuring widgets by touch.
import { api, createStorage, onServerEvent } from './api';
import { h, uid } from './dom';
import { Alerts } from './alerts';
import { ReminderAlerts } from './reminder-alerts';
import { Notifications } from './notifications';
import { initStockAlertSounds } from './stocks';
import { allWidgets, getWidget } from './registry';
import { openSheet, settingsForm, type SheetHandle } from './sheet';
import { showBluetooth, showWifi } from './connections';
import { currentTheme, setTheme, type Theme } from './theme';
import {
  SIZE_LABELS,
  SIZE_SPANS,
  WIDE_RENDER_AS,
  renderSize,
  tileSpan,
  TRACKS_PER_CELL,
  type LayoutSize,
  type WideSize,
  type Layout,
  type PageConfig,
  type Placement,
  type SettingField,
  type TileConfig,
  type WidgetConfig,
  type WidgetContext,
  type WidgetDefinition,
  type WidgetInstance,
} from './types';

const SWIPE_PX = 80;
const DRAG_START_PX = 10;
const REORDER_COOLDOWN_MS = 220;

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
  private saveTimer = 0;

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
    const editBtn = h(
      'button',
      { class: 'btn btn-ghost bar-btn', 'aria-label': 'Edit dashboard', onclick: () => this.setEditing(!this.editing) },
      '✎',
    );
    const menuBtn = h(
      'button',
      { class: 'btn btn-ghost bar-btn', 'aria-label': 'Settings', onclick: () => this.openMenu() },
      '⚙',
    );
    const toolbar = h(
      'div',
      { class: 'edit-toolbar' },
      h('button', { class: 'btn', onclick: () => this.openAddTile() }, '＋ Tile'),
      h('button', { class: 'btn', onclick: () => this.addPage() }, '＋ Page'),
      h('button', { class: 'btn', onclick: () => this.openPageSettings() }, 'Page'),
      h('button', { class: 'btn', onclick: () => this.openTopBarSettings() }, 'Top bar'),
      h('button', { class: 'btn', onclick: () => this.openDisplaySettings() }, 'Display'),
      this.saveStatus,
      h('button', { class: 'btn btn-primary', onclick: () => this.setEditing(false) }, 'Done'),
    );
    root.classList.add('app');
    root.append(
      h(
        'header',
        { class: 'topbar' },
        this.barLeft,
        h('div', { class: 'bar-center' }, this.pageTitle, this.dots),
        h('div', { class: 'bar-slot bar-actions' }, this.barRight, alerts.chip, reminderAlerts.chip, this.notifications.button, editBtn, menuBtn),
      ),
      this.main,
      toolbar,
    );

    this.bindGestures();
    this.sync();
    setInterval(() => this.tick(), 1000);
    window.addEventListener('resize', () => this.checkOverflow());
    onServerEvent('layout', async () => {
      // Another screen (e.g. a phone) changed the layout. Don't clobber local edits.
      if (this.editing) return;
      this.layout = await api.getLayout();
      this.sync();
    });
  }

  // ---- Rendering -------------------------------------------------------

  /** Reconcile the DOM with this.layout, reusing widget instances that didn't change. */
  private sync() {
    const { settings, pages, topBar } = this.layout;
    this.main.style.setProperty('--cols', String(settings.columns * TRACKS_PER_CELL));
    this.main.style.setProperty('--rows', String(settings.rows * TRACKS_PER_CELL));

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
        const grid = h('div', { class: 'grid', 'data-page': page.id });
        for (const tile of page.tiles) {
          seenTiles.add(tile.id);
          const m = this.mountInto(this.tiles, tile.id, tile.widget, renderSize(tile.size), tile.config);
          const [cols, rows] = tileSpan(tile.size, settings.columns, settings.rows);
          m.el.style.gridColumn = `span ${cols}`;
          m.el.style.gridRow = `span ${rows}`;
          m.el.dataset.size = tile.size;
          grid.append(m.el);
        }
        return h('section', { class: 'page' }, grid);
      }),
    );
    this.prune(this.tiles, seenTiles);

    this.goTo(Math.min(this.page, pages.length - 1), false);
    this.checkOverflow();
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
          : h('div', { class: 'tile', 'data-id': id }, body, this.tileControls(id));
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

  private tileControls(id: string): HTMLElement {
    return h(
      'div',
      { class: 'tile-edit' },
      h('button', { class: 'tile-btn tile-remove', 'aria-label': 'Remove', onclick: () => this.removeTile(id) }, '✕'),
      h('button', { class: 'tile-btn tile-resize', 'aria-label': 'Resize', onclick: () => this.cycleSize(id) }, '⤢'),
      h('button', { class: 'tile-btn tile-settings', 'aria-label': 'Settings', onclick: () => this.openTileSettings(id) }, '⚙'),
    );
  }

  /** In edit mode, outline tiles that don't fit on their page so the user can fix them. */
  private checkOverflow() {
    requestAnimationFrame(() => {
      for (const grid of this.track.querySelectorAll<HTMLElement>('.grid')) {
        const bottom = grid.getBoundingClientRect().bottom + 1;
        for (const tile of grid.querySelectorAll<HTMLElement>('.tile')) {
          tile.classList.toggle('overflow', tile.getBoundingClientRect().bottom > bottom);
        }
      }
    });
  }

  // ---- Pages and rotation ---------------------------------------------

  private goTo(index: number, animate = true) {
    const count = this.layout.pages.length;
    this.page = ((index % count) + count) % count;
    this.lastPageChange = Date.now();
    this.track.style.transition = animate ? '' : 'none';
    this.track.style.transform = `translateX(${-100 * this.page}%)`;
    this.pageTitle.textContent = this.layout.pages[this.page].name;
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
    if (this.editing || rotateSeconds <= 0 || this.layout.pages.length < 2) return;
    if (document.querySelector('.sheet-backdrop')) return;
    const now = Date.now();
    if (now - this.lastInteraction < resumeAfterSeconds * 1000) return;
    if (now - this.lastPageChange >= rotateSeconds * 1000) this.goTo(this.page + 1);
  }

  private bindGestures() {
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerdown', () => (this.lastInteraction = Date.now()), true);

    let start: { x: number; y: number; id: number } | null = null;
    this.main.addEventListener('pointerdown', (e) => {
      if (this.editing) {
        const tile = (e.target as HTMLElement).closest<HTMLElement>('.tile');
        if (tile && !(e.target as HTMLElement).closest('button')) this.startDrag(e, tile);
        return;
      }
      if (e.isPrimary) start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    });
    const end = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      start = null;
      if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) this.goTo(this.page + (dx < 0 ? 1 : -1));
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', () => (start = null));
  }

  // ---- Edit mode ------------------------------------------------------

  private setEditing(on: boolean) {
    this.editing = on;
    this.root.classList.toggle('editing', on);
    this.saveStatus.textContent = '';
    if (!on) this.flushSave();
    this.checkOverflow();
  }

  private startDrag(e: PointerEvent, tileEl: HTMLElement) {
    const id = tileEl.dataset.id!;
    const startX = e.clientX;
    const startY = e.clientY;
    let base = tileEl.getBoundingClientRect();
    const grabX = startX - base.left;
    const grabY = startY - base.top;
    let dragging = false;
    let lastReorder = 0;

    const place = (x: number, y: number) => {
      tileEl.style.transform = `translate(${x - grabX - base.left}px, ${y - grabY - base.top}px)`;
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_START_PX) return;
        dragging = true;
        tileEl.classList.add('dragging');
      }
      place(ev.clientX, ev.clientY);

      if (Date.now() - lastReorder < REORDER_COOLDOWN_MS) return;
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('.tile');
      if (!under || under === tileEl || under.parentElement !== tileEl.parentElement) return;
      const from = this.findTile(id);
      const to = this.findTile(under.dataset.id!);
      if (!from || !to) return;
      const [moved] = from.page.tiles.splice(from.index, 1);
      from.page.tiles.splice(to.index, 0, moved);
      if (from.index < to.index) under.after(tileEl);
      else under.before(tileEl);
      lastReorder = Date.now();
      // The tile's resting grid slot moved; re-measure so it stays under the finger.
      tileEl.style.transform = '';
      base = tileEl.getBoundingClientRect();
      place(ev.clientX, ev.clientY);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      tileEl.classList.remove('dragging');
      tileEl.style.transform = '';
      if (dragging) this.changed();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  private findTile(id: string): { page: PageConfig; index: number; tile: TileConfig } | null {
    for (const page of this.layout.pages) {
      const index = page.tiles.findIndex((t) => t.id === id);
      if (index >= 0) return { page, index, tile: page.tiles[index] };
    }
    return null;
  }

  private changed() {
    this.sync();
    this.saveStatus.textContent = 'Saving…';
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flushSave(), 500);
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

  private cycleSize(id: string) {
    const found = this.findTile(id);
    if (!found) return;
    const sizes = this.allowedSizes(found.tile.widget);
    found.tile.size = sizes[(sizes.indexOf(found.tile.size) + 1) % sizes.length];
    this.changed();
  }

  private removeTile(id: string) {
    const found = this.findTile(id);
    if (!found) return;
    found.page.tiles.splice(found.index, 1);
    this.changed();
  }

  private openAddTile() {
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
                  this.layout.pages[this.page].tiles.push({
                    id: uid(def.type),
                    widget: def.type,
                    size: def.defaultSize,
                    config: {},
                  });
                  sheet.close();
                  this.changed();
                },
              },
              h('span', { class: 'picker-icon' }, def.icon),
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

    const sizeRow = () =>
      h(
        'div',
        { class: 'chips' },
        ...this.allowedSizes(tile.widget).map((size) =>
          h(
            'button',
            {
              class: `chip${tile.size === size ? ' active' : ''}`,
              onclick: () => {
                tile.size = size;
                sizes.replaceWith((sizes = sizeRow()));
                this.changed();
              },
            },
            SIZE_LABELS[size],
          ),
        ),
      );
    let sizes = sizeRow();

    const pageSelect = h(
      'select',
      {
        onchange: (e: Event) => {
          const target = this.layout.pages.find((p) => p.id === (e.target as HTMLSelectElement).value);
          const current = this.findTile(id);
          if (!target || !current || target === current.page) return;
          current.page.tiles.splice(current.index, 1);
          target.tiles.push(tile);
          this.changed();
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
                h('button', { class: 'btn btn-ghost', onclick: () => this.openBarItemSettings(item.id) }, '⚙'),
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
                  '✕',
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
                `＋ ${def.icon} ${def.name}`,
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
