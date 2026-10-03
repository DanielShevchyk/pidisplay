// The contract between the dashboard shell and widgets. A widget is a folder in
// src/widgets/ whose index.ts default-exports a WidgetDefinition. See docs/WIDGETS.md.

export type TileSize = 'small' | 'medium' | 'tall' | 'large' | 'xlarge' | 'full';

/**
 * Full-width sizes the shell offers for every widget. Widgets don't handle them
 * directly: they render as the size in WIDE_RENDER_AS, stretched across the page.
 */
export type WideSize = 'strip' | 'banner' | 'column';

/** Any size a tile can have in the layout. */
export type LayoutSize = TileSize | WideSize;

export const WIDE_RENDER_AS: Record<WideSize, TileSize> = {
  strip: 'medium',
  banner: 'xlarge',
  column: 'large',
};

/** Grid cells each size spans, as [columns, rows]. Values past the grid are clamped. */
export const SIZE_SPANS: Record<LayoutSize, [number, number]> = {
  small: [1, 1],
  medium: [2, 1],
  tall: [1, 2],
  large: [2, 2],
  xlarge: [3, 2],
  full: [99, 99],
  strip: [99, 1],
  // 0 means half the grid; resolved in tileSpan().
  banner: [99, 0],
  column: [0, 99],
};

export const SIZE_LABELS: Record<LayoutSize, string> = {
  small: 'Small',
  medium: 'Wide',
  tall: 'Tall',
  large: 'Large',
  xlarge: 'Extra large',
  full: 'Full page',
  strip: 'Full-width row',
  banner: 'Top/bottom half',
  column: 'Left/right half',
};

/**
 * The CSS grid uses two tracks per layout cell, so halves are exact even when the
 * grid has an odd number of columns or rows. Cell sizes are unchanged by this.
 */
export const TRACKS_PER_CELL = 2;

/** The [column, row] grid tracks a tile of this size spans on a grid of the given cells. */
export function tileSpan(size: LayoutSize, columns: number, rows: number): [number, number] {
  const [c, r] = SIZE_SPANS[size] ?? SIZE_SPANS.small;
  const fit = (n: number, max: number) => (n === 0 ? max : Math.min(n, max) * TRACKS_PER_CELL);
  return [fit(c, columns), fit(r, rows)];
}

/** The size a widget is asked to render at for a tile of this layout size. */
export function renderSize(size: LayoutSize): TileSize {
  return size in WIDE_RENDER_AS ? WIDE_RENDER_AS[size as WideSize] : (size as TileSize);
}

/** Where a widget is rendered: a grid tile of some size, or the persistent top bar. */
export type Placement = TileSize | 'bar';

export type WidgetConfig = Record<string, unknown>;

/** Describes one user-editable option; the shell renders a form from these. */
export type SettingField =
  | { key: string; label: string; type: 'boolean' }
  | { key: string; label: string; type: 'text'; placeholder?: string }
  | { key: string; label: string; type: 'number'; min?: number; max?: number; step?: number }
  | { key: string; label: string; type: 'select'; options: { value: string; label: string }[] };

export type NotificationLevel = 'info' | 'success' | 'warning' | 'alert';

export interface AppNotification {
  id: string;
  title: string;
  body: string;
  source: string;
  level: NotificationLevel;
  time: string;
}

export interface NotificationInput {
  title: string;
  body?: string;
  level?: NotificationLevel;
}

/** Persistent JSON storage on the Pi, synced live between every open screen. */
export interface WidgetStorage {
  load<T>(fallback: T): Promise<T>;
  save(value: unknown): Promise<void>;
  /** Called when another screen (or another tile) saves this key. Returns an unsubscribe. */
  onChange(handler: () => void): () => void;
}

export interface WidgetContext<C extends WidgetConfig = WidgetConfig> {
  /** Unique id of this tile or bar item. */
  instanceId: string;
  placement: Placement;
  /** The widget's defaultConfig merged with this instance's saved settings. */
  config: C;
  /** Data private to this tile, e.g. a specific list. */
  storage: WidgetStorage;
  /** Data shared by every instance of this widget type, e.g. API caches. */
  sharedStorage: WidgetStorage;
  /** Shows a toast and adds an entry to the notification center. */
  notify(n: NotificationInput): void;
  /** Subscribe to server-sent events (e.g. 'notification'). Returns an unsubscribe. */
  on<T = unknown>(event: string, handler: (data: T) => void): () => void;
  /** True while the user is rearranging the dashboard. */
  readonly editing: boolean;
}

export interface WidgetInstance {
  /** Release timers, listeners and fetches. Called before unmount or remount. */
  destroy?(): void;
}

export interface WidgetDefinition<C extends WidgetConfig = WidgetConfig> {
  /** Stable id stored in the layout file. Never rename once in use. */
  type: string;
  name: string;
  description: string;
  /** An emoji or short glyph shown in the widget picker. */
  icon: string;
  /** Tile sizes this widget looks good at. */
  sizes: TileSize[];
  defaultSize: TileSize;
  /** Set when mount() handles placement 'bar' (a compact top-bar view). */
  supportsBar?: boolean;
  defaultConfig: C;
  settings?: SettingField[];
  /**
   * Render into el. The shell remounts (destroy, then mount) whenever size or
   * config changes, so mount can treat ctx as fixed.
   */
  mount(el: HTMLElement, ctx: WidgetContext<C>): WidgetInstance | void;
}

export interface TileConfig {
  id: string;
  widget: string;
  size: LayoutSize;
  config?: WidgetConfig;
}

export interface BarItemConfig {
  id: string;
  widget: string;
  config?: WidgetConfig;
}

export interface PageConfig {
  id: string;
  name: string;
  tiles: TileConfig[];
}

export interface LayoutSettings {
  columns: number;
  rows: number;
  /** Seconds per page when rotating; 0 turns rotation off. */
  rotateSeconds: number;
  /** After a touch, how long to wait before rotating again. */
  resumeAfterSeconds: number;
}

export interface Layout {
  version: 1;
  settings: LayoutSettings;
  topBar: { left: BarItemConfig[]; right: BarItemConfig[] };
  pages: PageConfig[];
}

/** Helper so widget files get type checking on their config without casts. */
export function defineWidget<C extends WidgetConfig>(def: WidgetDefinition<C>): WidgetDefinition<C> {
  return def;
}
