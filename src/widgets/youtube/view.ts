// The two building blocks of the YouTube widget: a video browser (search, recent,
// saved) whose cards start videos on the TV, and the "on the TV" remote showing what
// plays there with playback and volume buttons. Tiles and sheets combine them.
import { h } from '../../core/dom';
import type { Placement } from '../../core/types';
import { openBrowseSheet, openSetupSheet } from './sheets';
import { formatTime, runSearch, searchState, youtube, type Video } from './store';

const ICONS = {
  play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  next: '<path d="M5 6.2v11.6a.8.8 0 0 0 1.2.7l9-5.8a.8.8 0 0 0 0-1.4l-9-5.8A.8.8 0 0 0 5 6.2z"/><rect x="16.5" y="5" width="2.5" height="14" rx="1"/>',
  previous: '<path d="M19 6.2v11.6a.8.8 0 0 1-1.2.7l-9-5.8a.8.8 0 0 1 0-1.4l9-5.8a.8.8 0 0 1 1.2.7z"/><rect x="5" y="5" width="2.5" height="14" rx="1"/>',
  volDown: '<path d="M4 9h3.5L12 5v14l-4.5-4H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zm11 2h6v2h-6z"/>',
  volUp: '<path d="M4 9h3.5L12 5v14l-4.5-4H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zm13 0h2v2h2v2h-2v2h-2v-2h-2v-2h2z"/>',
  tv: '<path d="M3 5h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v9h16V7zm4 13h8v1.5H8z"/>',
  add: '<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  starOn: '<path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
  logo: '<rect x="2" y="5" width="20" height="14" rx="4" fill="#ff0033"/><path d="M10 9v6l5.2-3z" fill="#fff"/>',
};

export function icon(name: keyof typeof ICONS, cls = ''): HTMLElement {
  const span = h('span', { class: `yt-icon ${cls}`, 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor">${ICONS[name]}</svg>`;
  return span;
}

const stop = (fn: () => void) => (e: Event) => {
  e.stopPropagation();
  fn();
};

/** Starts a video, or asks to link a TV first. */
function playOrSetup(video: Video, onPlayed?: () => void) {
  if (!youtube.status?.current) return openSetupSheet();
  void youtube.play(video).then((ok) => ok && onPlayed?.());
}

// ---- Browser -------------------------------------------------------------------

type Tab = 'results' | 'recent' | 'saved';

export function mountBrowser(el: HTMLElement, { onPlayed }: { onPlayed?: () => void } = {}): () => void {
  let tab: Tab = searchState.results.length || searchState.error ? 'results' : 'recent';
  let searching = false;

  const input = h('input', {
    type: 'search',
    class: 'yt-search-input',
    placeholder: 'Search YouTube',
    value: searchState.query,
    enterkeyhint: 'search',
    autocomplete: 'off',
    spellcheck: false,
    onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && void search(),
  });
  const searchBtn = h('button', { class: 'btn btn-primary', onclick: () => void search() }, 'Search');
  const tabs = h('div', { class: 'chips yt-tabs' });
  const list = h('div', { class: 'yt-list' });
  const root = h('div', { class: 'yt-browse' }, h('div', { class: 'yt-search' }, input, searchBtn), tabs, list);
  el.append(root);

  async function search() {
    const q = input.value.trim();
    input.blur();
    if (!q) return;
    searching = true;
    tab = 'results';
    paint();
    await runSearch(q);
    searching = false;
    paint();
    list.scrollTop = 0;
  }

  const card = (video: Video) => {
    const saved = youtube.isSaved(video.id);
    const sub = [video.channel, video.views, video.published].filter(Boolean).join(' · ');
    const playing = youtube.status?.tv.videoId === video.id;
    return h(
      'div',
      { class: `yt-card${playing ? ' playing' : ''}` },
      h(
        'button',
        { class: 'yt-card-main', onclick: () => playOrSetup(video, onPlayed), 'aria-label': `Play ${video.title} on the TV` },
        h(
          'div',
          { class: 'yt-thumb' },
          h('img', { src: video.thumb, alt: '', loading: 'lazy', draggable: false }),
          video.live ? h('span', { class: 'yt-badge live' }, 'LIVE') : video.duration ? h('span', { class: 'yt-badge' }, video.duration) : null,
          playing ? h('span', { class: 'yt-badge now' }, 'On TV') : null,
        ),
        h('div', { class: 'yt-card-title' }, video.title),
        sub ? h('div', { class: 'yt-card-sub' }, sub) : null,
      ),
      h(
        'div',
        { class: 'yt-card-actions' },
        h('button', { class: 'yt-mini', 'aria-label': 'Add to the TV queue', onclick: stop(() => (youtube.status?.current ? void youtube.queue(video) : openSetupSheet())) }, icon('add')),
        h('button', { class: `yt-mini${saved ? ' on' : ''}`, 'aria-label': saved ? 'Remove from saved' : 'Save', onclick: stop(() => void youtube.toggleSaved(video)) }, icon(saved ? 'starOn' : 'star')),
      ),
    );
  };

  const grid = (videos: Video[], empty: string) =>
    videos.length ? h('div', { class: 'yt-grid' }, ...videos.map(card)) : h('p', { class: 'empty' }, empty);

  function paint() {
    const chip = (id: Tab, label: string) =>
      h('button', { class: `chip${tab === id ? ' active' : ''}`, onclick: () => ((tab = id), paint()) }, label);
    tabs.replaceChildren(
      ...(searchState.query || searchState.results.length ? [chip('results', 'Results')] : []),
      chip('recent', 'Recently played'),
      chip('saved', `Saved${youtube.saved.length ? ` (${youtube.saved.length})` : ''}`),
    );
    if (tab === 'results') {
      if (searching) list.replaceChildren(h('p', { class: 'conn-status' }, 'Searching…'));
      else if (searchState.error) list.replaceChildren(h('p', { class: 'conn-error' }, searchState.error));
      else list.replaceChildren(grid(searchState.results, 'Nothing found.'));
    } else if (tab === 'recent') {
      list.replaceChildren(grid(youtube.status?.history ?? [], 'Videos you send to the TV show up here.'));
    } else {
      list.replaceChildren(grid(youtube.saved, 'Tap ☆ on a video to keep it here.'));
    }
  }

  // Repaint on store changes (saved stars, the "On TV" badge), keeping the scroll position.
  let lastKey = '';
  const off = youtube.subscribe(() => {
    const s = youtube.status;
    const key = `${s?.tv.videoId}|${s?.history.map((v) => v.id).join()}|${youtube.saved.map((v) => v.id).join()}|${s?.current}`;
    if (key === lastKey || searching) return;
    lastKey = key;
    const top = list.scrollTop;
    paint();
    list.scrollTop = top;
  });
  return off;
}

// ---- On the TV -------------------------------------------------------------------

const COMPACT = new Set<Placement | 'strip' | 'sheet'>(['small', 'medium', 'tall', 'bar']);

interface RemoteOptions {
  /** 'strip' is the bar under a browser; tile sizes get their own layouts. */
  placement: Placement | 'strip';
  onExpand?: () => void;
}

export function mountRemote(el: HTMLElement, { placement, onExpand }: RemoteOptions): () => void {
  const compact = COMPACT.has(placement);
  const root = h('div', { class: `yt-remote size-${placement}` });
  el.append(root);

  const thumb = h('img', { class: 'yt-np-img', alt: '', draggable: false });
  const thumbBox = h('div', { class: 'yt-np-thumb' }, thumb);
  const title = h('div', { class: 'yt-np-title' });
  const channel = h('div', { class: 'yt-np-channel' });
  const tvName = h('span', { class: 'yt-tv-name' });
  const tvChip = h('button', { class: 'btn yt-tv-chip', onclick: stop(() => openSetupSheet()) }, icon('tv'), tvName);

  const btn = (name: keyof typeof ICONS, label: string, fn: () => void, cls = '') =>
    h('button', { class: `yt-btn ${cls}`, 'aria-label': label, onclick: stop(fn) }, icon(name));
  const playBtn = btn('play', 'Play', () => {
    const st = youtube.status?.tv.state;
    void youtube.control(st === 'playing' || st === 'buffering' || st === 'ad' ? 'pause' : 'play');
  }, 'yt-play');
  const prevBtn = btn('previous', 'Previous', () => {
    // Like the app: past the first few seconds, "previous" restarts the video.
    if (youtube.position() > 5) void youtube.control('seek', 0);
    else void youtube.control('previous');
  });
  const nextBtn = btn('next', 'Next', () => void youtube.control('next'));
  const volValue = h('span', { class: 'yt-vol-value' });
  const stepVolume = (delta: number) => {
    const v = youtube.status?.tv.volume;
    void youtube.control('volume', Math.max(0, Math.min(100, (v ?? 50) + delta)));
  };
  const volDown = btn('volDown', 'Volume down', () => stepVolume(-5), 'yt-vol');
  const volUp = btn('volUp', 'Volume up', () => stepVolume(5), 'yt-vol');

  const elapsed = h('span', { class: 'yt-time' });
  const total = h('span', { class: 'yt-time' });
  const fill = h('div', { class: 'yt-bar-fill' });
  const bar = h('div', { class: 'yt-bar' }, fill);
  bar.addEventListener('pointerup', (e) => {
    e.stopPropagation();
    const d = youtube.status?.tv.duration;
    if (!d) return;
    const r = bar.getBoundingClientRect();
    void youtube.control('seek', Math.round(((e.clientX - r.left) / r.width) * d));
  });
  bar.addEventListener('click', (e) => e.stopPropagation());
  const progress = h('div', { class: 'yt-progress' }, elapsed, bar, total);

  const controls = h(
    'div',
    { class: 'yt-controls' },
    placement === 'small' ? null : prevBtn,
    playBtn,
    nextBtn,
    compact ? null : h('span', { class: 'yt-spacer' }),
    compact ? null : volDown,
    compact ? null : volValue,
    compact ? null : volUp,
  );
  const note = h('div', { class: 'yt-note' });
  const player = h(
    'div',
    { class: 'yt-np' },
    thumbBox,
    h('div', { class: 'yt-np-main' }, h('div', { class: 'yt-np-info' }, title, channel), placement === 'small' ? null : progress, controls),
  );

  const message = (text: string, ...actions: (HTMLElement | null)[]) =>
    h('div', { class: 'yt-message' }, placement === 'strip' ? null : icon('logo', 'yt-logo'), text ? h('div', {}, text) : null, ...actions);

  let shown = '';
  const update = () => {
    const s = youtube.status;
    const tv = s?.tv;
    const linked = Boolean(s?.current);
    const hasVideo = Boolean(tv?.videoId) && tv?.state !== 'stopped';
    const mode = !s ? (youtube.loadError ? 'error' : 'loading') : !linked ? 'setup' : hasVideo ? 'player' : 'idle';
    const key = `${mode}|${youtube.screenName()}|${youtube.loadError}`;
    if (key !== shown) {
      shown = key;
      if (mode === 'player') root.replaceChildren(...(placement === 'strip' ? [player, tvChip, note] : [player, note]));
      else if (mode === 'setup') {
        root.replaceChildren(
          message(placement === 'small' ? '' : 'Play YouTube videos on your TV', h('button', { class: 'btn btn-primary', onclick: stop(() => openSetupSheet()) }, 'Link TV')),
        );
      } else if (mode === 'idle') {
        root.replaceChildren(
          placement === 'strip'
            ? h('div', { class: 'yt-idle-strip' }, h('span', {}, 'Nothing playing on '), tvChip)
            : message(
                placement === 'small' ? '' : `Nothing playing on ${youtube.screenName()}`,
                h('button', { class: 'btn btn-primary', onclick: stop(() => (onExpand ?? openBrowseSheet)()) }, 'Find a video'),
                placement === 'small' ? null : tvChip,
              ),
          note,
        );
      } else if (mode === 'error') root.replaceChildren(message(youtube.loadError));
      else root.replaceChildren(message('Loading…'));
    }
    tvName.textContent = youtube.screenName();
    note.textContent = youtube.error || youtube.note;
    note.className = `yt-note${youtube.error ? ' error' : ''}`;
    note.hidden = !note.textContent;
    if (mode !== 'player' || !tv) return;

    const src = tv.thumb ?? '';
    if (thumb.getAttribute('src') !== src) thumb.src = src;
    title.textContent = tv.title || 'YouTube video';
    channel.textContent = tv.channel;
    const playing = tv.state === 'playing' || tv.state === 'buffering' || tv.state === 'ad';
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    volValue.textContent = tv.volume === null ? '' : tv.muted ? 'Muted' : String(tv.volume);
    tick();
  };

  const tick = () => {
    const tv = youtube.status?.tv;
    if (!tv?.videoId) return;
    const t = youtube.position();
    elapsed.textContent = formatTime(t);
    total.textContent = tv.duration ? formatTime(tv.duration) : '';
    fill.style.width = `${tv.duration ? (t / tv.duration) * 100 : 0}%`;
  };

  if (onExpand) root.addEventListener('click', () => onExpand());
  const off = youtube.subscribe(update);
  const timer = window.setInterval(tick, 1000);
  return () => {
    off();
    clearInterval(timer);
  };
}
