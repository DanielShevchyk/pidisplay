import { h } from '../../core/dom';
import { openSheet, type SheetHandle } from '../../core/sheet';
import { defineWidget } from '../../core/types';
import './photos.css';

interface PhotosConfig {
  /** 'all', 'local' (uploaded to the Pi) or 'google' (shared albums). */
  source: 'all' | 'local' | 'google';
  /** One album by name; blank = every album in the source. */
  album: string;
  seconds: number;
  shuffle: boolean;
  /** 'auto' fills the tile when the photo's shape is close to it, else shows it whole. */
  fit: 'auto' | 'cover' | 'contain';
  caption: boolean;
  [key: string]: unknown;
}

/** Mirrors GET /api/photos (server/photos.js). */
interface Photo {
  id: string;
  source: 'local' | 'google';
  album: string;
  name: string;
  src: string;
  thumb: string;
}

interface Album {
  name: string;
  source: 'local' | 'google';
  count: number;
  error?: string;
  stale?: boolean;
}

interface Listing {
  photos: Photo[];
  albums: Album[];
}

const REFRESH_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const CONTROLS_MS = 6000;
const FADE_MS = 1200;
/** The browse sheet shows this many thumbnails per album filter, to spare the Pi. */
const GRID_LIMIT = 240;

export default defineWidget<PhotosConfig>({
  type: 'photos',
  name: 'Photos',
  description: 'Slideshow of your photos or Google Photos shared albums',
  icon: '🖼️',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'large',
  defaultConfig: { source: 'all', album: '', seconds: 15, shuffle: true, fit: 'auto', caption: false },
  settings: [
    {
      key: 'source',
      label: 'Photos from',
      type: 'select',
      options: [
        { value: 'all', label: 'Everywhere' },
        { value: 'local', label: 'Photos uploaded to the Pi' },
        { value: 'google', label: 'Google Photos shared albums' },
      ],
    },
    { key: 'album', label: 'Only this album (blank = all)', type: 'text', placeholder: 'Album name' },
    { key: 'seconds', label: 'Seconds per photo', type: 'number', min: 3, max: 3600, step: 1 },
    { key: 'shuffle', label: 'Shuffle', type: 'boolean' },
    {
      key: 'fit',
      label: 'Fit',
      type: 'select',
      options: [
        { value: 'auto', label: 'Fill when the shape is close, else whole photo' },
        { value: 'cover', label: 'Always fill the tile (crops edges)' },
        { value: 'contain', label: 'Always show the whole photo' },
      ],
    },
    { key: 'caption', label: 'Show album name', type: 'boolean' },
  ],

  mount(el, ctx) {
    const { config, placement } = ctx;
    const root = h('div', { class: `photos size-${placement}` });
    const stage = h('div', { class: 'photos-stage' });
    const caption = h('div', { class: 'photos-caption' });
    const controls = h('div', { class: 'photos-controls' });
    root.append(stage, caption, controls);
    el.append(root);

    let photos: Photo[] = [];
    let albums: Album[] = [];
    let order: number[] = [];
    let pos = -1;
    let paused = false;
    let failed = '';
    let alive = true;
    let busy = false;
    let refreshTimer = 0;
    let advanceTimer = 0;
    let controlsTimer = 0;
    let sheet: SheetHandle | null = null;
    const seconds = Math.max(3, Number(config.seconds) || 15);
    const albumFilter = String(config.album ?? '').trim();

    const current = (): Photo | undefined => photos[order[pos]];
    const visible = () => el.getClientRects().length > 0;

    const message = (icon: string, text: string, detail?: string) => {
      stage.replaceChildren(
        h(
          'div',
          { class: 'photos-message' },
          h('div', { class: 'photos-message-icon' }, icon),
          h('div', {}, text),
          detail && h('div', { class: 'photos-message-detail' }, detail),
        ),
      );
      caption.textContent = '';
    };

    const emptyState = () => {
      if (failed) return message('⚠️', 'Photos unavailable', failed);
      const problems = albums.filter((a) => a.error).map((a) => `${a.name}: ${a.error}`);
      if (problems.length) return message('⚠️', 'No photos to show', problems.join('\n'));
      if (albumFilter) return message('🖼️', `No album named “${albumFilter}”`, 'Check the name in this tile’s settings.');
      message(
        '🖼️',
        'No photos yet',
        placement === 'small' ? undefined : 'Upload a folder from the laptop with deploy\\photos.ps1, or link a Google Photos shared album.',
      );
    };

    const makeOrder = (keepId?: string) => {
      order = photos.map((_, i) => i);
      if (config.shuffle) {
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
      }
      pos = keepId ? order.findIndex((i) => photos[i].id === keepId) : -1;
    };

    const schedule = () => {
      clearTimeout(advanceTimer);
      if (!paused) advanceTimer = window.setTimeout(() => void step(1), seconds * 1000);
    };

    /** Loads and fades to the photo `delta` places away; skips photos that fail to load. */
    const step = async (delta: number, attempts = 0): Promise<void> => {
      if (!alive) return;
      if (!photos.length) return emptyState();
      // Don't spend the Pi's time on a hidden page, an open sheet, or edit mode.
      if (busy || (delta > 0 && attempts === 0 && pos >= 0 && (!visible() || sheet || ctx.editing))) return schedule();
      busy = true;
      const wrapped = pos >= 0 && pos + delta >= order.length;
      pos = (((pos + delta) % order.length) + order.length) % order.length;
      if (wrapped && config.shuffle && order.length > 2) {
        const last = order[order.length - 1];
        makeOrder();
        // Don't repeat the last photo of the old round first.
        if (order[0] === last) [order[0], order[1]] = [order[1], order[0]];
        pos = 0;
      }
      const photo = current()!;
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.decoding = 'async';
      img.src = photo.src;
      try {
        await img.decode();
      } catch {
        busy = false;
        if (!alive) return;
        if (attempts + 1 >= Math.min(order.length, 5)) {
          message('⚠️', 'Photos aren’t loading', 'Check the Pi’s internet connection.');
          return schedule();
        }
        return step(delta < 0 ? -1 : 1, attempts + 1);
      }
      busy = false;
      if (!alive) return;
      show(photo, img);
      schedule();
    };

    const show = (photo: Photo, img: HTMLImageElement) => {
      const tileRatio = stage.clientWidth / Math.max(1, stage.clientHeight);
      const ratio = img.naturalWidth / Math.max(1, img.naturalHeight);
      const close = Math.max(ratio, tileRatio) / Math.min(ratio, tileRatio) < 1.3;
      const cover = config.fit === 'cover' || (config.fit === 'auto' && close);
      img.className = 'photos-img';
      img.style.objectFit = cover ? 'cover' : 'contain';
      img.alt = photo.name || photo.album;
      const slide = h(
        'div',
        { class: 'photos-slide' },
        // A blurred copy of the thumbnail fills the bars around a whole photo.
        !cover && h('img', { class: 'photos-fill', src: photo.thumb, alt: '', referrerpolicy: 'no-referrer' }),
        img,
      );
      const old = [...stage.children];
      stage.append(slide);
      requestAnimationFrame(() => slide.classList.add('in'));
      window.setTimeout(() => old.forEach((s) => s.remove()), FADE_MS + 100);
      caption.textContent = config.caption ? photo.album : '';
      if (sheet || controls.classList.contains('open')) paintControls();
    };

    const paintControls = () => {
      const photo = current();
      const btn = (label: string, title: string, fn: () => void) =>
        h(
          'button',
          {
            class: 'photos-btn',
            'aria-label': title,
            onclick: (e: Event) => {
              e.stopPropagation();
              fn();
              showControls();
            },
          },
          label,
        );
      controls.replaceChildren(
        h(
          'div',
          { class: 'photos-btns' },
          btn('◀', 'Previous photo', () => void step(-1)),
          btn(paused ? '▶' : '⏸', paused ? 'Play' : 'Pause', () => {
            paused = !paused;
            schedule();
            paintControls();
          }),
          btn('▶▶', 'Next photo', () => void step(1)),
          placement !== 'small' && btn('▦', 'Browse photos', () => browse()),
        ),
        placement !== 'small' && photo
          ? h('div', { class: 'photos-info' }, `${photo.album} · ${pos + 1} of ${order.length}${paused ? ' · paused' : ''}`)
          : '',
      );
    };

    const showControls = () => {
      clearTimeout(controlsTimer);
      paintControls();
      controls.classList.add('open');
      controlsTimer = window.setTimeout(() => controls.classList.remove('open'), CONTROLS_MS);
    };

    root.addEventListener('click', () => {
      if (!photos.length) return;
      if (controls.classList.contains('open')) {
        clearTimeout(controlsTimer);
        controls.classList.remove('open');
      } else showControls();
    });

    const browse = () => {
      let filter = '';
      const grid = h('div', { class: 'photos-grid' });
      const chips = h('div', { class: 'photos-chips' });
      const paint = () => {
        const names = [...new Set(photos.map((p) => p.album))];
        chips.replaceChildren(
          ...(names.length > 1 ? ['', ...names] : []).map((name) =>
            h(
              'button',
              {
                class: `photos-chip${name === filter ? ' active' : ''}`,
                onclick: () => {
                  filter = name;
                  paint();
                },
              },
              name || 'All',
            ),
          ),
        );
        const shown = photos.map((p, i) => [p, i] as const).filter(([p]) => !filter || p.album === filter);
        grid.replaceChildren(
          ...shown.slice(0, GRID_LIMIT).map(([p, i]) =>
            h(
              'button',
              {
                class: `photos-thumb${i === order[pos] ? ' current' : ''}`,
                onclick: () => {
                  pos = order.indexOf(i) - 1;
                  sheet?.close();
                  void step(1);
                },
              },
              h('img', { src: p.thumb, alt: p.name || p.album, loading: 'lazy', referrerpolicy: 'no-referrer' }),
            ),
          ),
          shown.length > GRID_LIMIT
            ? h('div', { class: 'photos-more' }, `Showing ${GRID_LIMIT} of ${shown.length}. Pick an album above to see others.`)
            : '',
        );
      };
      paint();
      const notes = albums
        .filter((a) => a.error)
        .map((a) => h('div', { class: 'photos-note' }, `⚠ ${a.name}: ${a.error}${a.stale ? ' (showing earlier photos)' : ''}`));
      sheet = openSheet(`🖼️ Photos (${photos.length})`, [...notes, chips, grid], {
        onClose: () => {
          sheet = null;
          schedule();
        },
      });
    };

    const refresh = async () => {
      clearTimeout(refreshTimer);
      let next = REFRESH_MS;
      try {
        const params = new URLSearchParams({ source: albumFilter || config.source });
        const res = await fetch(`/api/photos?${params}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `Photos failed (${res.status})`);
        if (!alive) return;
        const listing = body as Listing;
        // An album name filter should still respect the chosen source.
        const fresh =
          albumFilter && config.source !== 'all' ? listing.photos.filter((p) => p.source === config.source) : listing.photos;
        albums = listing.albums;
        failed = '';
        if (albums.some((a) => a.error)) next = RETRY_MS * 5;
        const keep = current()?.id;
        const changed = fresh.length !== photos.length || fresh.some((p, i) => p.id !== photos[i]?.id);
        if (changed) {
          photos = fresh;
          makeOrder(keep);
          if (pos < 0 || !photos.length) {
            clearTimeout(advanceTimer);
            await step(1);
          }
        } else if (!photos.length) emptyState();
      } catch (err) {
        if (!alive) return;
        failed = err instanceof Error ? err.message : String(err);
        next = RETRY_MS;
        if (!photos.length) emptyState();
      }
      refreshTimer = window.setTimeout(refresh, next);
    };

    message('🖼️', 'Loading photos…');
    void refresh();

    return {
      destroy() {
        alive = false;
        clearTimeout(refreshTimer);
        clearTimeout(advanceTimer);
        clearTimeout(controlsTimer);
        sheet?.close();
      },
    };
  },
});
