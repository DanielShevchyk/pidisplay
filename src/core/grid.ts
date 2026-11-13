// Tile placement on a page: every tile has a position and a size in whole grid
// cells (x, y, w, h). Pure functions only, so the edit-mode gestures can try a
// placement, show it, and throw it away without touching the saved layout.
import { SIZE_SPANS, type LayoutSize, type TileConfig, type TileSize } from './types';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const rectOf = (t: TileConfig): Rect => ({ x: t.x ?? 0, y: t.y ?? 0, w: t.w ?? 1, h: t.h ?? 1 });

export const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const placed = (t: TileConfig) =>
  Number.isInteger(t.x) && Number.isInteger(t.y) && Number.isInteger(t.w) && Number.isInteger(t.h) && t.w! > 0 && t.h! > 0;

/** Width and height in cells for one of the named sizes (old layouts, new tiles, the size presets). */
export function cellsFor(size: LayoutSize, columns: number, rows: number): [number, number] {
  const [c, r] = SIZE_SPANS[size] ?? SIZE_SPANS.small;
  // 0 means "half the grid"; an odd grid rounds the half up.
  const fit = (n: number, max: number) => (n === 0 ? Math.ceil(max / 2) : Math.min(n, max));
  return [fit(c, columns), fit(r, rows)];
}

/**
 * The size a widget is asked to render at for a tile of w x h cells. Widgets keep
 * the six named looks; any rectangle picks the closest one it supports. Tall
 * shapes like a 3 x 4 half page get the large look, as the old "column" did.
 */
export function renderSizeFor(w: number, h: number, columns: number, rows: number, supported?: TileSize[]): TileSize {
  const want: TileSize =
    w >= columns && h >= rows ? 'full' : w >= 3 && h >= 2 && w >= h ? 'xlarge' : w >= 2 && h >= 2 ? 'large' : h >= 2 ? 'tall' : w >= 2 ? 'medium' : 'small';
  if (!supported?.length || supported.includes(want)) return want;
  // Fall back to the supported look whose shape is nearest to the tile's.
  let best = supported[0];
  let bestD = Infinity;
  for (const s of supported) {
    const [c, r] = cellsFor(s, columns, rows);
    const d = (c - w) ** 2 + (r - h) ** 2;
    if (d < bestD) [best, bestD] = [s, d];
  }
  return best;
}

class Occupancy {
  private cells: Uint8Array;
  constructor(
    private columns: number,
    private rows: number,
  ) {
    this.cells = new Uint8Array(columns * rows);
  }
  fill(r: Rect, v = 1) {
    for (let y = Math.max(0, r.y); y < Math.min(this.rows, r.y + r.h); y++)
      for (let x = Math.max(0, r.x); x < Math.min(this.columns, r.x + r.w); x++) this.cells[y * this.columns + x] = v;
  }
  free(r: Rect) {
    if (r.x < 0 || r.y < 0 || r.x + r.w > this.columns || r.y + r.h > this.rows) return false;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (this.cells[y * this.columns + x]) return false;
    return true;
  }
  /** The free spot for a w x h tile closest to (nx, ny), or null when the page is too full. */
  nearest(w: number, h: number, nx: number, ny: number): Rect | null {
    let best: Rect | null = null;
    let bestD = Infinity;
    for (let y = 0; y + h <= this.rows; y++)
      for (let x = 0; x + w <= this.columns; x++) {
        const r = { x, y, w, h };
        if (!this.free(r)) continue;
        // Moving up/down costs a bit more than sideways, so rows stay together.
        const d = (x - nx) ** 2 + 1.5 * (y - ny) ** 2;
        if (d < bestD) [best, bestD] = [r, d];
      }
    return best;
  }
}

/**
 * Give every tile on a page a valid position, keeping the ones that already have
 * one. Tiles without a position (old layouts, the default layout, tiles added
 * elsewhere) go in order to the first free spot from the top left, which is how
 * the old automatic layout packed them, so an upgraded screen looks the same.
 * Tiles that don't fit go below the last row, where edit mode flags them.
 * Returns true when something changed.
 */
export function ensurePlaced(tiles: TileConfig[], columns: number, rows: number): boolean {
  let changed = false;
  const occ = new Occupancy(columns, rows);
  let below = rows;
  const keep = (t: TileConfig, r: Rect) => {
    if (t.x !== r.x || t.y !== r.y || t.w !== r.w || t.h !== r.h) changed = true;
    Object.assign(t, r);
    occ.fill(r);
    below = Math.max(below, r.y + r.h);
  };
  const pending: TileConfig[] = [];
  for (const t of tiles) {
    if (!placed(t)) {
      pending.push(t);
      continue;
    }
    // Clamp to the grid (the grid may have shrunk in Display settings).
    const w = Math.min(t.w!, columns);
    const h = Math.min(t.h!, rows);
    const r = { x: Math.max(0, Math.min(t.x!, columns - w)), y: Math.max(0, t.y!), w, h };
    if (r.y + r.h <= rows && !occ.free(r)) {
      pending.push(Object.assign(t, { w, h, x: undefined, y: undefined }));
      continue;
    }
    keep(t, r);
  }
  for (const t of pending) {
    const [w, h] = t.w && t.h ? [Math.min(t.w, columns), Math.min(t.h, rows)] : cellsFor(t.size, columns, rows);
    let spot: Rect | null = null;
    // First fit in reading order, like the old dense grid.
    for (let y = 0; y + h <= rows && !spot; y++)
      for (let x = 0; x + w <= columns && !spot; x++) if (occ.free({ x, y, w, h })) spot = { x, y, w, h };
    keep(t, spot ?? { x: 0, y: below, w, h });
    changed = true;
  }
  return changed;
}

/**
 * Put one tile at `rect` and move whatever it lands on out of the way: each tile
 * it covers goes to the nearest free spot to where it was. Returns the new rect
 * of every tile on the page by id, or null when the displaced tiles don't fit.
 * `others` must not include the moving tile.
 */
export function placeWithPush(others: TileConfig[], rect: Rect, columns: number, rows: number): Map<string, Rect> | null {
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > columns || rect.y + rect.h > rows) return null;
  const out = new Map<string, Rect>();
  const occ = new Occupancy(columns, rows);
  occ.fill(rect);
  const displaced: TileConfig[] = [];
  for (const t of others) {
    const r = rectOf(t);
    if (overlaps(r, rect)) displaced.push(t);
    else {
      out.set(t.id, r);
      occ.fill(r);
    }
  }
  // Bigger tiles first: they have the fewest places to go.
  displaced.sort((a, b) => rectOf(b).w * rectOf(b).h - rectOf(a).w * rectOf(a).h);
  for (const t of displaced) {
    const r = rectOf(t);
    const spot = occ.nearest(r.w, r.h, r.x, r.y);
    if (!spot) return null;
    out.set(t.id, spot);
    occ.fill(spot);
  }
  return out;
}

/** Empty cells on a page, for the "+" slots in edit mode. */
export function emptyCells(tiles: TileConfig[], columns: number, rows: number): Rect[] {
  const occ = new Occupancy(columns, rows);
  for (const t of tiles) occ.fill(rectOf(t));
  const out: Rect[] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) if (occ.free({ x, y, w: 1, h: 1 })) out.push({ x, y, w: 1, h: 1 });
  return out;
}

/** Where a new w x h tile goes: at (x, y) if free, else the nearest free spot, else below the grid. */
export function spotForNew(tiles: TileConfig[], w: number, h: number, columns: number, rows: number, near = { x: 0, y: 0 }): Rect {
  const occ = new Occupancy(columns, rows);
  let below = rows;
  for (const t of tiles) {
    const r = rectOf(t);
    occ.fill(r);
    below = Math.max(below, r.y + r.h);
  }
  w = Math.min(w, columns);
  h = Math.min(h, rows);
  const x = Math.min(near.x, columns - w);
  const y = Math.min(near.y, rows - h);
  if (occ.free({ x, y, w, h })) return { x, y, w, h };
  // A smaller tile still fits where the user tapped.
  return occ.nearest(w, h, x, y) ?? (occ.free({ ...near, w: 1, h: 1 }) ? { ...near, w: 1, h: 1 } : { x: 0, y: below, w, h });
}
