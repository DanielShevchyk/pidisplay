// The now-playing view, from a thumbnail-and-button strip up to the full player.
// Built once per mount and updated in place, so album art doesn't reload on every tick.
import { h } from '../../core/dom';
import type { Placement } from '../../core/types';
import { openLibrarySheet, openSetupSheet, openSpeakersSheet } from './sheets';
import { formatTime, spotify } from './store';

const ICONS = {
  play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  next: '<path d="M5 6.2v11.6a.8.8 0 0 0 1.2.7l9-5.8a.8.8 0 0 0 0-1.4l-9-5.8A.8.8 0 0 0 5 6.2z"/><rect x="16.5" y="5" width="2.5" height="14" rx="1"/>',
  previous: '<path d="M19 6.2v11.6a.8.8 0 0 1-1.2.7l-9-5.8a.8.8 0 0 1 0-1.4l9-5.8a.8.8 0 0 1 1.2.7z"/><rect x="5" y="5" width="2.5" height="14" rx="1"/>',
  shuffle: '<path d="M16 4l4 3.5-4 3.5V8.5h-1.6a3 3 0 0 0-2.4 1.2l-4.6 6.1A5 5 0 0 1 3.4 17.8H2v-2.2h1.4a3 3 0 0 0 2.4-1.2l4.6-6.1a5 5 0 0 1 4-2H16z M2 6.2h1.4a5 5 0 0 1 4 2l.6.8-1.4 1.8-.8-1a3 3 0 0 0-2.4-1.2H2z M12.6 14.2l1.4-1.8.4.5a3 3 0 0 0 2.4 1.2H16V12.6l4 3.5-4 3.5v-2.2h-1.6a5 5 0 0 1-4-2z"/>',
  repeat: '<path d="M7 7h10V4.5l4 3.5-4 3.5V9H7a2 2 0 0 0-2 2v1.5H3V11a4 4 0 0 1 4-4zm10 10H7v2.5L3 16l4-3.5V15h10a2 2 0 0 0 2-2v-1.5h2V13a4 4 0 0 1-4 4z"/>',
  speaker: '<path d="M4 9h3.5L12 5v14l-4.5-4H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zm11.5-.5a5 5 0 0 1 0 7l-1.4-1.4a3 3 0 0 0 0-4.2zm2.8-2.8a9 9 0 0 1 0 12.6l-1.4-1.4a7 7 0 0 0 0-9.8z"/>',
  library: '<rect x="4" y="4" width="3" height="16" rx="1"/><rect x="9" y="4" width="3" height="16" rx="1"/><path d="M14.6 5.2l2.9-.8 3.4 14.9-2.9.7z"/>',
};

export function icon(name: keyof typeof ICONS, cls = ''): HTMLElement {
  const span = h('span', { class: `spt-icon ${cls}`, 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor">${ICONS[name]}</svg>`;
  return span;
}

/** Sizes that get the whole player; smaller ones get a compact view that opens it in a sheet. */
const FULL = new Set<Placement>(['large', 'xlarge', 'full']);

interface Options {
  placement: Placement | 'sheet';
  /** Called when a compact tile is tapped. */
  onExpand?: () => void;
}

export function mountPlayer(el: HTMLElement, { placement, onExpand }: Options): () => void {
  const full = placement === 'sheet' || FULL.has(placement as Placement);
  const root = h('div', { class: `spt size-${placement}` });
  el.append(root);

  // ---- Pieces, built once ------------------------------------------------
  const art = h('img', { class: 'spt-art-img', alt: '', draggable: false });
  const artBox = h('div', { class: 'spt-art' }, art, h('div', { class: 'spt-art-empty' }, '🎵'));
  const title = h('div', { class: 'spt-title' });
  const artist = h('div', { class: 'spt-artist' });
  const album = h('div', { class: 'spt-album' });
  const device = h('div', { class: 'spt-device' });

  const btn = (name: keyof typeof ICONS, label: string, onclick: () => void, cls = '') =>
    h('button', { class: `spt-btn ${cls}`, 'aria-label': label, onclick: (e: Event) => (e.stopPropagation(), onclick()) }, icon(name));
  const playBtn = btn('play', 'Play', () => {
    const p = spotify.player;
    void spotify.act(p?.isPlaying ? 'pause' : 'play');
  }, 'spt-play');
  const prevBtn = btn('previous', 'Previous', () => {
    // Like the Spotify app: past the first few seconds, "previous" restarts the song.
    if (spotify.progress() > 4000) void spotify.act('seek', { positionMs: 0 });
    else void spotify.act('previous');
  });
  const nextBtn = btn('next', 'Next', () => void spotify.act('next'));
  const shuffleBtn = btn('shuffle', 'Shuffle', () => void spotify.act('shuffle', { on: !spotify.player?.shuffle }), 'spt-toggle');
  const repeatBtn = btn('repeat', 'Repeat', () => {
    const order = ['off', 'context', 'track'] as const;
    const cur = spotify.player?.repeat ?? 'off';
    void spotify.act('repeat', { mode: order[(order.indexOf(cur) + 1) % 3] });
  }, 'spt-toggle');

  const elapsed = h('span', { class: 'spt-time' });
  const total = h('span', { class: 'spt-time' });
  const fill = h('div', { class: 'spt-bar-fill' });
  const bar = h('div', { class: 'spt-bar' }, fill);
  bar.addEventListener('pointerup', (e) => {
    const d = spotify.player?.item?.durationMs;
    if (!d) return;
    const r = bar.getBoundingClientRect();
    void spotify.act('seek', { positionMs: Math.round(((e.clientX - r.left) / r.width) * d) });
  });
  const progress = h('div', { class: 'spt-progress' }, elapsed, bar, total);

  let dragging = false;
  const volume = h('input', {
    type: 'range',
    class: 'spt-range',
    min: 0,
    max: 100,
    step: 2,
    'aria-label': 'Volume',
    oninput: () => (dragging = true),
    onchange: () => {
      dragging = false;
      void spotify.act('volume', { percent: Number(volume.value) });
    },
  });
  const volumeRow = h('div', { class: 'spt-volume' }, icon('speaker', 'spt-vol-icon'), volume);

  const speakersBtn = h('button', { class: 'btn spt-chip', onclick: (e: Event) => (e.stopPropagation(), openSpeakersSheet()) }, icon('speaker'), device);
  const libraryBtn = h('button', { class: 'btn spt-chip', onclick: (e: Event) => (e.stopPropagation(), openLibrarySheet()) }, icon('library'), 'Library');
  const errorLine = h('div', { class: 'spt-error' });

  const controls = h(
    'div',
    { class: 'spt-controls' },
    full ? shuffleBtn : null,
    placement === 'small' || placement === 'bar' ? null : prevBtn,
    playBtn,
    nextBtn,
    full ? repeatBtn : null,
  );
  const info = h('div', { class: 'spt-info' }, title, artist, full ? album : null);

  const playerView = h(
    'div',
    { class: 'spt-player' },
    artBox,
    h(
      'div',
      { class: 'spt-main' },
      info,
      full ? progress : null,
      controls,
      full ? volumeRow : null,
      full ? h('div', { class: 'spt-actions' }, speakersBtn, libraryBtn) : null,
    ),
  );

  // ---- Other states --------------------------------------------------------
  const message = (iconText: string, text: string, ...actions: HTMLElement[]) =>
    h('div', { class: 'spt-message' }, h('div', { class: 'spt-message-icon' }, iconText), text ? h('div', {}, text) : null, ...actions);

  const setupView = () =>
    placement === 'bar'
      ? h('button', { class: 'spt-bar-empty', onclick: (e: Event) => (e.stopPropagation(), openSetupSheet()) }, '🎵')
      : message(
          '🎵',
          placement === 'small' ? '' : 'Connect your Spotify account',
          h('button', { class: 'btn btn-primary', onclick: (e: Event) => (e.stopPropagation(), openSetupSheet()) }, 'Set up Spotify'),
        );

  const idleView = () => {
    if (placement === 'bar') return h('button', { class: 'spt-bar-empty', onclick: (e: Event) => (e.stopPropagation(), onExpand?.()) }, '🎵');
    if (placement === 'small') return message('🎵', '', h('button', { class: 'btn btn-primary', onclick: (e: Event) => (e.stopPropagation(), onExpand?.()) }, 'Play'));
    return message(
      '🎵',
      'Nothing playing',
      h(
        'div',
        { class: 'spt-actions' },
        h('button', { class: 'btn btn-primary', onclick: (e: Event) => (e.stopPropagation(), void spotify.act('play')) }, 'Resume'),
        h('button', { class: 'btn spt-chip', onclick: (e: Event) => (e.stopPropagation(), openLibrarySheet()) }, icon('library'), 'Library'),
        h('button', { class: 'btn spt-chip', onclick: (e: Event) => (e.stopPropagation(), openSpeakersSheet()) }, icon('speaker'), 'Speakers'),
      ),
    );
  };

  // ---- Updating ------------------------------------------------------------
  let shown: 'setup' | 'idle' | 'player' | 'loading' | 'error' | null = null;

  const update = () => {
    const s = spotify.status;
    const p = spotify.player;
    const mode = !s ? (spotify.loadError ? 'error' : 'loading') : !s.connected ? 'setup' : p ? 'player' : 'idle';
    if (mode !== shown || mode === 'idle' || mode === 'error') {
      shown = mode;
      if (mode === 'player') root.replaceChildren(playerView, errorLine);
      else if (mode === 'setup') root.replaceChildren(setupView());
      else if (mode === 'idle') root.replaceChildren(idleView(), errorLine);
      else if (mode === 'error') root.replaceChildren(placement === 'bar' ? h('span', {}, '🎵') : message('⚠️', spotify.loadError));
      else root.replaceChildren(placement === 'bar' ? h('span', {}, '🎵') : message('', 'Loading…'));
    }
    errorLine.textContent = spotify.error;
    errorLine.hidden = !spotify.error;
    if (mode !== 'player' || !p) return;

    const item = p.item;
    const src = (placement === 'bar' || placement === 'small' ? item?.thumb : item?.image) ?? '';
    if (art.getAttribute('src') !== src) {
      if (src) art.src = src;
      else art.removeAttribute('src');
    }
    artBox.classList.toggle('has-art', Boolean(src));
    title.textContent = item?.name ?? 'Unknown';
    artist.textContent = item?.artists.join(', ') ?? '';
    album.textContent = item?.album ?? '';
    device.textContent = p.device.name;
    playBtn.replaceChildren(icon(p.isPlaying ? 'pause' : 'play'));
    playBtn.setAttribute('aria-label', p.isPlaying ? 'Pause' : 'Play');
    prevBtn.disabled = p.disallows.includes('skipping_prev') && spotify.progress() <= 4000;
    nextBtn.disabled = p.disallows.includes('skipping_next');
    shuffleBtn.classList.toggle('on', p.shuffle);
    repeatBtn.classList.toggle('on', p.repeat !== 'off');
    repeatBtn.classList.toggle('one', p.repeat === 'track');
    const supportsVolume = p.device.supportsVolume && p.device.volume !== null;
    volumeRow.hidden = !supportsVolume;
    if (supportsVolume && !dragging) volume.value = String(p.device.volume);
    tick();
  };

  const tick = () => {
    const p = spotify.player;
    if (!full || !p?.item) return;
    const ms = spotify.progress();
    elapsed.textContent = formatTime(ms);
    total.textContent = formatTime(p.item.durationMs);
    fill.style.width = `${p.item.durationMs ? (ms / p.item.durationMs) * 100 : 0}%`;
  };

  if (onExpand) root.addEventListener('click', () => shown === 'player' || shown === 'idle' ? onExpand() : undefined);
  const off = spotify.subscribe(update);
  const timer = window.setInterval(tick, 1000);
  return () => {
    off();
    clearInterval(timer);
  };
}
