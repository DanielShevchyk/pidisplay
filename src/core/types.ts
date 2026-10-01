// The contract between the dashboard shell and widgets. A widget is a folder in
// src/widgets/ whose index.ts default-exports a WidgetDefinition. See docs/WIDGETS.md.

export type TileSize = 'small' | 'medium' | 'tall' | 'large' | 'xlarge' | 'full';

/** Grid cells each size spans, as [columns, rows]. */
export const SIZE_SPANS: Record<TileSize, [number, number]> = {
  small: [1, 1],
  medium: [2, 1],
  tall: [1, 2],
  large: [2, 2],
  xlarge: [3, 2],
  // Clamped to the grid, so this always fills the page.
  full: [99, 99],
};

export const SIZE_LABELS: Record<TileSize, string> = {
  small: 'Small',
  medium: 'Wide',
  tall: 'Tall',
  large: 'Large',
  xlarge: 'Extra large',
  full: 'Full page',
};

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
  size: TileSize;
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
