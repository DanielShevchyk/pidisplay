// Top bar layout: the pure moves behind the bar editor, and BarFit, which keeps
// the bar on one line by leaving off the items at the end of a side that don't fit.
import type { BarItemConfig, Layout } from './types';

export type BarSide = 'left' | 'right';
type TopBar = Layout['topBar'];

export function findBarItem(bar: TopBar, id: string): { side: BarSide; index: number; item: BarItemConfig } | null {
  for (const side of ['left', 'right'] as BarSide[]) {
    const index = bar[side].findIndex((i) => i.id === id);
    if (index >= 0) return { side, index, item: bar[side][index] };
  }
  return null;
}

/** Takes the item out of its side and puts it at `index` of `side` (index counted without the item). */
export function moveBarItem(bar: TopBar, id: string, side: BarSide, index: number) {
  const found = findBarItem(bar, id);
  if (!found) return;
  bar[found.side].splice(found.index, 1);
  const list = bar[side];
  list.splice(Math.max(0, Math.min(index, list.length)), 0, found.item);
}

/**
 * One step left (-1) or right (+1) along the whole bar: past the end of the left
 * side it becomes the first item on the right, and back again.
 */
export function stepBarItem(bar: TopBar, id: string, dir: -1 | 1) {
  const found = findBarItem(bar, id);
  if (!found) return;
  const { side, index } = found;
  if (dir < 0) {
    if (index > 0) moveBarItem(bar, id, side, index - 1);
    else if (side === 'right') moveBarItem(bar, id, 'left', bar.left.length);
  } else {
    if (index < bar[side].length - 1) moveBarItem(bar, id, side, index + 1);
    else if (side === 'left') moveBarItem(bar, id, 'right', 0);
  }
}

/** Whether the item can step that way at all (the very first and very last can't). */
export function canStep(bar: TopBar, id: string, dir: -1 | 1): boolean {
  const found = findBarItem(bar, id);
  if (!found) return false;
  if (dir < 0) return !(found.side === 'left' && found.index === 0);
  return !(found.side === 'right' && found.index === bar.right.length - 1);
}

const gapOf = (el: HTMLElement) => parseFloat(getComputedStyle(el).columnGap) || 0;

/**
 * Keeps each side of the bar within its room. Measures every item at its natural
 * width and hides (.bar-cut) items from the end of a side until the rest fit. Runs
 * when anything in the bar changes size, at most once a frame; nothing here touches the pages.
 */
export class BarFit {
  private ro = new ResizeObserver(() => this.schedule());
  private frame = 0;
  paused = false;
  /** Ids left off because they don't fit. */
  readonly cut = new Set<string>();
  /** How full each side is: natural width over the room it has (1 = exactly full). */
  readonly room = { left: 0, right: 0 };
  onFit?: () => void;

  constructor(
    private left: HTMLElement,
    private right: HTMLElement,
    private actions: HTMLElement,
    center: HTMLElement,
  ) {
    for (const el of [left, actions, center, ...actions.children]) this.ro.observe(el);
  }

  observe(el: Element) {
    this.ro.observe(el);
  }

  unobserve(el: Element) {
    this.ro.unobserve(el);
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.paused) this.fit();
    });
  }

  fit() {
    this.cut.clear();
    this.room.left = this.fitSlot(this.left, this.left.clientWidth);
    // The right side shares its cell with the status chips and the round buttons, which always win.
    const gap = gapOf(this.actions);
    let taken = 0;
    for (const child of this.actions.children) {
      if (child === this.right) continue;
      const w = (child as HTMLElement).offsetWidth;
      if (w) taken += w + gap;
    }
    this.room.right = this.fitSlot(this.right, this.actions.clientWidth - taken);
    this.onFit?.();
  }

  private fitSlot(slot: HTMLElement, room: number): number {
    const items = [...slot.children].filter((c) => c.classList.contains('bar-item')) as HTMLElement[];
    for (const item of items) item.classList.remove('bar-cut');
    if (!items.length) return 0;
    const gap = gapOf(slot);
    const widths = items.map((i) => i.offsetWidth);
    const total = widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1);
    let used = total;
    let n = items.length;
    while (n > 0 && used > room + 0.5) {
      n--;
      used -= widths[n] + (n > 0 ? gap : 0);
      items[n].classList.add('bar-cut');
      if (items[n].dataset.id) this.cut.add(items[n].dataset.id!);
    }
    return room > 0 ? total / room : Infinity;
  }
}
