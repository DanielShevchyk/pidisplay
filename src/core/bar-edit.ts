// Editing the top bar in place: the real bar stays up with its two sides outlined,
// items are dragged along it (or across to the other side), a tap gives an item a
// small pill of actions, and a tray under the bar adds widgets and switches the
// built-in buttons. The pages are dimmed and left alone.
import { h, uid } from './dom';
import { icon } from './icons';
import { allWidgets, getWidget } from './registry';
import { canStep, findBarItem, moveBarItem, stepBarItem, type BarFit, type BarSide } from './topbar';
import type { Layout, WidgetConfig } from './types';

const DRAG_START_PX = 10;
/** How far below the bar a widget dragged up from the tray still counts as dropped on it. */
const DROP_REACH_PX = 80;

type HideKey = 'page' | 'voice' | 'bell';

export interface BarEditHost {
  readonly layout: Layout;
  /** Sync, record for Undo, save. */
  changed(): void;
  back(): void;
  done(): void;
  undo(): void;
  openItemSettings(id: string): void;
  /** A live 'bar' view of the widget for the tray; torn down by clearPreviews(). */
  mountPreview(type: string, config: WidgetConfig): HTMLElement;
  clearPreviews(): void;
  readonly fit: BarFit;
}

export class BarEditor {
  readonly undoBtn: HTMLButtonElement;
  readonly tray: HTMLElement;
  readonly pill = h('div', { class: 'bar-pill', hidden: true });
  private adds = h('div', { class: 'bar-adds' });
  private builtins = h('div', { class: 'bar-builtins' });
  private roomEl = h('div', { class: 'bar-room' });
  private selected: string | null = null;
  private active = false;

  constructor(
    private host: BarEditHost,
    private topbar: HTMLElement,
    private slots: Record<BarSide, HTMLElement>,
    private center: HTMLElement,
  ) {
    this.undoBtn = h('button', { class: 'btn', disabled: true, onclick: () => host.undo() }, icon('undo-2'), ' Undo') as HTMLButtonElement;
    this.tray = h(
      'div',
      { class: 'bar-tray', hidden: true },
      h(
        'div',
        { class: 'bar-tray-head' },
        h('h2', {}, 'Top bar'),
        h('p', { class: 'bar-hint' }, 'Drag an item along the bar to reorder it or move it to the other side. Tap one for its options.'),
        this.undoBtn,
        h('button', { class: 'btn', onclick: () => host.back() }, 'Back to tiles'),
        h('button', { class: 'btn btn-primary', onclick: () => host.done() }, 'Done'),
      ),
      h('h3', {}, 'Add to the bar · tap, or drag up into place'),
      this.adds,
      h('h3', {}, 'Built in'),
      h('div', { class: 'bar-builtins-row' }, this.builtins, this.roomEl),
    );
    topbar.addEventListener('pointerdown', (e) => {
      if (this.active) this.pointerDown(e);
    });
    host.fit.onFit = () => {
      if (!this.active) return;
      this.renderRoom();
      this.placePill();
    };
    window.addEventListener('resize', () => this.active && this.placePill());
  }

  get isOpen() {
    return this.active;
  }

  open() {
    this.active = true;
    this.selected = null;
    this.tray.hidden = false;
    this.renderAdds();
    this.refresh();
  }

  close() {
    this.active = false;
    this.selected = null;
    this.tray.hidden = true;
    this.pill.hidden = true;
    for (const el of this.topbar.querySelectorAll('.bar-sel')) el.classList.remove('bar-sel');
    this.host.clearPreviews();
    this.adds.replaceChildren();
  }

  /** After the bar was rebuilt (a change, an undo): selection, labels and switches follow the layout. */
  refresh() {
    if (!this.active) return;
    const bar = this.host.layout.topBar;
    if (this.selected && !findBarItem(bar, this.selected)) this.selected = null;
    for (const el of this.topbar.querySelectorAll<HTMLElement>('.bar-item')) el.classList.toggle('bar-sel', el.dataset.id === this.selected);
    this.renderBuiltins();
    this.renderPill();
    this.host.fit.schedule();
  }

  // ---- Selecting -------------------------------------------------------

  private select(id: string | null) {
    this.selected = id;
    for (const el of this.topbar.querySelectorAll<HTMLElement>('.bar-item')) el.classList.toggle('bar-sel', el.dataset.id === id);
    this.renderPill();
  }

  private renderPill() {
    const id = this.selected;
    const bar = this.host.layout.topBar;
    if (!id || !findBarItem(bar, id)) return void (this.pill.hidden = true);
    const step = (dir: -1 | 1) => {
      stepBarItem(this.host.layout.topBar, id, dir);
      this.host.changed();
    };
    const btn = (label: string, ico: Parameters<typeof icon>[0], onclick: () => void, extra = '', disabled = false) =>
      h('button', { class: `sel-btn ${extra}`, 'aria-label': label, disabled, onclick }, icon(ico));
    this.pill.replaceChildren(
      btn('Move left', 'chevron-left', () => step(-1), '', !canStep(bar, id, -1)),
      btn('Settings', 'settings', () => this.host.openItemSettings(id)),
      btn('Remove', 'x', () => this.remove(id), 'sel-remove'),
      btn('Move right', 'chevron-right', () => step(1), '', !canStep(bar, id, 1)),
    );
    this.pill.hidden = false;
    this.placePill();
  }

  private placePill() {
    if (this.pill.hidden || !this.selected) return;
    const el = this.itemEl(this.selected);
    if (!el || el.classList.contains('bar-cut')) return void (this.pill.style.visibility = 'hidden');
    this.pill.style.visibility = '';
    const r = el.getBoundingClientRect();
    const w = this.pill.offsetWidth;
    const x = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2));
    this.pill.style.transform = `translate(${Math.round(x)}px, ${Math.round(this.topbar.getBoundingClientRect().bottom + 6)}px)`;
  }

  private remove(id: string) {
    const found = findBarItem(this.host.layout.topBar, id);
    if (!found) return;
    this.host.layout.topBar[found.side].splice(found.index, 1);
    if (this.selected === id) this.selected = null;
    this.host.changed();
  }

  private itemEl(id: string) {
    return this.topbar.querySelector<HTMLElement>(`.bar-item[data-id="${CSS.escape(id)}"]`);
  }

  // ---- Dragging ----------------------------------------------------------

  private pointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement;
    const item = target.closest<HTMLElement>('.bar-item');
    if (!item?.dataset.id || !item.closest('.bar-left, .bar-right')) {
      if (!target.closest('.bar-pill')) this.select(null);
      return;
    }
    this.drag(e, this.topbar, item, item.dataset.id, null);
  }

  /**
   * Drags a bar item (id) or a new widget from the tray (addType). The dragged
   * item itself (or a dashed slot for a new one) moves through the bar to show where
   * it lands; a copy follows the finger. A tap without movement selects or adds.
   */
  private drag(e: PointerEvent, captureEl: HTMLElement, source: HTMLElement, id: string | null, addType: string | null) {
    if (!e.isPrimary) return;
    e.preventDefault();
    captureEl.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY };
    let moving = false;
    let proxy: HTMLElement | null = null;
    let marker: HTMLElement | null = null;
    let target: { side: BarSide; index: number } | null = null;
    let half = { w: 0, h: 0 };

    const begin = () => {
      moving = true;
      this.host.fit.paused = true;
      this.pill.hidden = true;
      const r = source.getBoundingClientRect();
      half = { w: r.width / 2, h: r.height / 2 };
      proxy = source.cloneNode(true) as HTMLElement;
      proxy.className = 'bar-proxy';
      proxy.style.width = `${r.width}px`;
      document.body.append(proxy);
      if (id) {
        marker = source;
        marker.classList.add('bar-moving');
      } else {
        marker = h('div', { class: 'bar-item bar-drop', style: `width: ${Math.max(96, Math.round(r.width))}px` });
      }
    };

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!moving) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_START_PX) return;
        begin();
      }
      proxy!.style.transform = `translate(${ev.clientX - half.w}px, ${ev.clientY - half.h}px)`;
      const bottom = this.topbar.getBoundingClientRect().bottom;
      if (!id && ev.clientY > bottom + DROP_REACH_PX) {
        target = null;
        marker!.remove();
        return;
      }
      target = this.dropTarget(ev.clientX, marker!);
    };

    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      captureEl.removeEventListener('pointermove', move);
      captureEl.removeEventListener('pointerup', up);
      captureEl.removeEventListener('pointercancel', up);
      if (!moving) {
        if (ev.type === 'pointercancel') return;
        if (id) this.select(this.selected === id ? null : id);
        else if (addType) this.add(addType, 'right', this.host.layout.topBar.right.length);
        return;
      }
      proxy?.remove();
      marker?.classList.remove('bar-moving');
      this.host.fit.paused = false;
      const drop = ev.type === 'pointercancel' ? null : target;
      if (id) {
        if (drop) moveBarItem(this.host.layout.topBar, id, drop.side, drop.index);
        this.selected = id;
        this.host.changed();
      } else {
        marker?.remove();
        if (drop && addType) this.add(addType, drop.side, drop.index);
        else this.host.fit.schedule();
      }
    };
    captureEl.addEventListener('pointermove', move);
    captureEl.addEventListener('pointerup', up);
    captureEl.addEventListener('pointercancel', up);
  }

  /** Which side and slot a finger at x points to; moves the marker there. */
  private dropTarget(x: number, marker: HTMLElement): { side: BarSide; index: number } {
    const c = this.center.getBoundingClientRect();
    const b = this.topbar.getBoundingClientRect();
    const mid = c.width ? c.left + c.width / 2 : b.left + b.width / 2;
    const side: BarSide = x < mid ? 'left' : 'right';
    const slot = this.slots[side];
    const others = [...slot.children].filter((el) => el !== marker && el.classList.contains('bar-item')) as HTMLElement[];
    const shown = others.filter((el) => !el.classList.contains('bar-cut'));
    let index = 0;
    for (const el of shown) {
      const r = el.getBoundingClientRect();
      if (x > r.left + r.width / 2) index++;
    }
    const before = shown[index] ?? others.find((el) => el.classList.contains('bar-cut')) ?? null;
    if (marker.parentElement !== slot || marker.nextElementSibling !== before) slot.insertBefore(marker, before);
    return { side, index };
  }

  // ---- Adding --------------------------------------------------------------

  private add(type: string, side: BarSide, index: number) {
    const layout = this.host.layout;
    const id = uid(`bar-${type}`);
    layout.topBar[side].splice(index, 0, { id, widget: type, config: { ...configFor(layout, type) } });
    this.selected = id;
    this.host.changed();
  }

  private renderAdds() {
    this.host.clearPreviews();
    const layout = this.host.layout;
    this.adds.replaceChildren(
      ...allWidgets()
        .filter((d) => d.supportsBar)
        .map((def) => {
          const pv = h('div', { class: 'bar-add-pv' }, this.host.mountPreview(def.type, configFor(layout, def.type)));
          // Some widgets show nothing in the bar until they're set up; name them instead.
          const fallback = () => {
            if (!pv.isConnected || pv.textContent!.trim() || pv.querySelector('img, svg, canvas')) return;
            pv.querySelector('.bar-add-fallback') ?? pv.append(h('span', { class: 'bar-add-fallback' }, def.name));
          };
          setTimeout(fallback, 1500);
          setTimeout(fallback, 5000);
          const btn: HTMLElement = h(
            'button',
            { class: 'bar-add', 'data-type': def.type, onpointerdown: (e: PointerEvent) => this.drag(e, btn, pv, null, def.type) },
            pv,
            h('span', { class: 'bar-add-name' }, icon('plus'), def.name),
          );
          return btn;
        }),
    );
  }

  // ---- Built-in buttons and room ---------------------------------------------

  private renderBuiltins() {
    const bar = this.host.layout.topBar;
    const toggle = (key: HideKey, label: string) =>
      h(
        'label',
        { class: 'bar-tog' },
        h('span', {}, label),
        h('input', {
          type: 'checkbox',
          class: 'toggle',
          checked: !bar.hide?.[key],
          onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            const hide = { ...this.host.layout.topBar.hide };
            if (on) delete hide[key];
            else hide[key] = true;
            this.host.layout.topBar.hide = Object.keys(hide).length ? hide : undefined;
            this.host.changed();
          },
        }),
      );
    this.builtins.replaceChildren(
      toggle('page', 'Page name and dots'),
      toggle('voice', 'Voice button'),
      toggle('bell', 'Notifications bell'),
      h('span', { class: 'bar-tog bar-tog-locked' }, icon('lock'), 'Edit and Settings always stay'),
    );
  }

  private renderRoom() {
    const { room, cut } = this.host.fit;
    const meter = (label: string, share: number) => {
      const pct = Math.round(Math.min(share, 9.99) * 100);
      const level = share > 1 ? 'over' : share > 0.85 ? 'tight' : 'ok';
      return h(
        'div',
        { class: `bar-meter bar-meter-${level}` },
        h('span', {}, label),
        h('span', { class: 'bar-meter-track' }, h('i', { style: `width: ${Math.min(100, pct)}%` })),
        h('b', {}, `${pct}%`),
      );
    };
    const bar = this.host.layout.topBar;
    const cutItems = [...bar.left, ...bar.right].filter((i) => cut.has(i.id));
    this.roomEl.replaceChildren(
      h('div', { class: 'bar-meters' }, meter('Left', room.left), meter('Right', room.right)),
      ...(cutItems.length
        ? [h(
            'div',
            { class: 'bar-cutlist' },
            h('span', {}, "Doesn't fit, so it's hidden:"),
            ...cutItems.map((i) =>
              h(
                'button',
                { class: 'chip', 'aria-label': `Remove ${getWidget(i.widget)?.name ?? i.widget}`, onclick: () => this.remove(i.id) },
                getWidget(i.widget)?.name ?? i.widget,
                ' ',
                icon('x'),
              ),
            ),
          )]
        : []),
    );
  }
}

/** A new bar widget starts from the settings of the same widget already on the dashboard, if any. */
function configFor(layout: Layout, type: string): WidgetConfig {
  const bar = [...layout.topBar.left, ...layout.topBar.right].find((i) => i.widget === type);
  if (bar) return bar.config ?? {};
  for (const page of layout.pages) {
    const tile = page.tiles.find((t) => t.widget === type);
    if (tile) return tile.config ?? {};
  }
  return {};
}
