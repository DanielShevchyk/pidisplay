// Sheets for the Spotify widget: speakers (Spotify devices plus where the Pi's own
// sound goes), the library (playlists and search) and account setup.
import { call } from '../../core/api';
import { showBluetooth } from '../../core/connections';
import { h } from '../../core/dom';
import { openSheet, type SheetHandle } from '../../core/sheet';
import { spotifyLogo } from './logo';
import { spotify, type Device, type SpotifyStatus } from './store';

interface Output {
  name: string;
  label: string;
  kind: 'hdmi' | 'analog' | 'bluetooth' | 'other';
  volume: number | null;
  muted: boolean;
  active: boolean;
}

interface AudioStatus {
  available: boolean;
  outputs: Output[];
}

interface TvStatus {
  linked: boolean;
  name: string | null;
  ip: string | null;
  canWake: boolean;
}

interface BtDevice {
  mac: string;
  name: string | null;
  icon: string | null;
  paired: boolean;
  connected: boolean;
}

const DEVICE_ICONS: Record<string, string> = {
  computer: '💻',
  smartphone: '📱',
  tablet: '📱',
  speaker: '🔊',
  tv: '📺',
  avr: '📻',
  stb: '📺',
  audiodongle: '🔊',
  gameconsole: '🎮',
  castvideo: '📺',
  castaudio: '🔊',
  automobile: '🚗',
};
const OUTPUT_ICONS: Record<Output['kind'], string> = { hdmi: '🖥️', analog: '🎧', bluetooth: '🔵', other: '🔈' };

const DEV_DASHBOARD = 'https://developer.spotify.com/dashboard';

function row(iconText: string, label: string, tag: string | null, onclick: (() => void) | null, active = false) {
  return h(
    'li',
    { class: active ? 'active' : '' },
    h(
      'button',
      { class: 'conn-row', disabled: !onclick, onclick: onclick ?? undefined },
      h('span', { class: 'conn-icon' }, iconText),
      h('span', { class: 'conn-name' }, label),
      tag ? h('span', { class: `conn-tag${active ? ' on' : ''}` }, tag) : null,
    ),
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Speakers --------------------------------------------------------------

export function openSpeakersSheet() {
  const sheet = openSheet('Speakers', [], { onClose: () => off() });
  let audio: AudioStatus | null = null;
  let tv: TvStatus | null = null;
  let bt: BtDevice[] = [];
  let busy = '';
  let error = '';
  let outputDrag = false;

  const loadLocal = async () => {
    void call<TvStatus>('GET', '/api/tv')
      .then((s) => ((tv = s), render()))
      .catch(() => {});
    [audio, bt] = await Promise.all([
      call<AudioStatus>('GET', '/api/audio').catch((err) => {
        error = (err as Error).message;
        return null;
      }),
      call<{ available: boolean; powered?: boolean; devices?: BtDevice[] }>('GET', '/api/bluetooth')
        .then((s) => (s.available && s.powered ? s.devices ?? [] : []))
        .catch(() => []),
    ]);
    render();
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    busy = label;
    error = '';
    render();
    try {
      await fn();
    } catch (err) {
      error = (err as Error).message;
    }
    busy = '';
    await loadLocal();
  };

  const selectOutput = (o: Output) =>
    run(`Switching to ${o.label}…`, async () => {
      audio = await call<AudioStatus>('POST', '/api/audio/select', { name: o.name });
    });

  /** Connects a paired Bluetooth speaker, waits for its sound output to appear, then uses it. */
  const connectSpeaker = (d: BtDevice) =>
    run(`Connecting to ${d.name ?? d.mac}…`, async () => {
      await call('POST', '/api/bluetooth/connect', { mac: d.mac });
      for (let i = 0; i < 10; i++) {
        const s = await call<AudioStatus>('GET', '/api/audio');
        const out = s.outputs.find((o) => o.kind === 'bluetooth' && !o.active);
        if (out) {
          audio = await call<AudioStatus>('POST', '/api/audio/select', { name: out.name });
          return;
        }
        await wait(1000);
      }
      throw new Error('Connected, but it is not offering sound yet. Pick it under "PiDisplay plays through" in a moment.');
    });

  /** Switches the linked TV on, opens its Spotify app and waits for it to appear above. */
  const openOnTv = () =>
    run(`Opening Spotify on ${tv?.name ?? 'the TV'}… This can take up to a minute if it was off.`, async () => {
      await call('POST', '/api/tv/spotify');
      for (let i = 0; i < 15; i++) {
        await wait(2000);
        await spotify.refresh();
        const found = spotify.devices.find((d) => d.type === 'tv' && !d.restricted);
        if (found) {
          // First time: make it where new music starts, which is why it was linked.
          if (!spotify.status?.preferred) await spotify.setPreferred(found);
          return;
        }
      }
      throw new Error('Spotify opened on the TV, but it has not shown up as a speaker. Check that the TV app is signed in to your Spotify account.');
    });

  const transfer = (d: Device) => {
    busy = `Moving music to ${d.name}…`;
    render();
    void spotify.act('transfer', { deviceId: d.id }).then(() => {
      busy = '';
      render();
    });
  };

  const render = () => {
    if (!sheet.body.isConnected) return;
    const parts: (HTMLElement | null)[] = [];
    if (busy) parts.push(h('p', { class: 'conn-status' }, busy));
    if (error) parts.push(h('p', { class: 'conn-error' }, error));
    if (spotify.error) parts.push(h('p', { class: 'conn-error' }, spotify.error));

    // Spotify Connect devices: this display, phones, smart speakers, TVs...
    const status = spotify.status;
    if (status?.connected) {
      const receiver = status.receiver.name;
      const devices = [...spotify.devices].sort((a, b) => Number(b.name === receiver) - Number(a.name === receiver));
      const items = devices.map((d) =>
        row(
          d.name === receiver ? '🖥️' : DEVICE_ICONS[d.type] ?? '🔊',
          d.name === receiver ? `${d.name} (this display)` : d.name,
          d.active ? 'Playing' : d.restricted ? "Can't control" : null,
          busy || d.active || d.restricted ? null : () => transfer(d),
          d.active,
        ),
      );
      parts.push(h('h3', {}, 'Play Spotify on'));
      if (!devices.some((d) => d.name === receiver)) {
        items.unshift(row('🖥️', `${receiver} (this display)`, status.receiver.signedIn ? 'Starting…' : 'Not linked yet', null));
      }
      parts.push(h('ul', { class: 'conn-list' }, ...items));
      if (!status.receiver.signedIn) {
        parts.push(
          h(
            'p',
            { class: 'conn-hint' },
            `To link ${receiver} the first time: open Spotify on your phone or computer on the same Wi-Fi, tap the speaker icon and pick ${receiver}. After that it shows up here on its own.`,
          ),
        );
      }
      parts.push(h('p', { class: 'conn-hint' }, 'Phones, smart speakers and TVs show up here while their Spotify app is open.'));

      // Where a song picked on this screen starts when nothing is playing yet.
      const preferred = status.preferred;
      const others = devices.filter((d) => d.name !== receiver && !d.restricted);
      const offline = preferred && !others.some((d) => d.id === preferred.id || d.name === preferred.name);
      const chip = (label: string, on: boolean, pick: () => void) =>
        h('button', { class: `chip${on ? ' active' : ''}`, disabled: Boolean(busy), onclick: () => void pick() }, label);
      parts.push(
        h('h3', {}, 'Start new music on'),
        h(
          'div',
          { class: 'chips' },
          chip('This display', !preferred, () => spotify.setPreferred(null)),
          ...others.map((d) => chip(d.name, preferred?.id === d.id || preferred?.name === d.name, () => spotify.setPreferred(d))),
          offline ? chip(`${preferred.name} (not available)`, true, () => {}) : null,
        ),
        h(
          'p',
          { class: 'conn-hint' },
          preferred && preferred.type === 'tv' && tv?.linked
            ? `Songs you pick here start on ${preferred.name}. If it is off, PiDisplay switches it on and opens Spotify first. If music is already playing, it stays where it is.`
            : preferred
            ? `Songs you pick here start on ${preferred.name} when Spotify can see it, and on this display otherwise. If music is already playing, it stays where it is.`
            : 'Pick a TV or speaker to have songs chosen here start there instead of on this display.',
        ),
      );
    }

    // The LG TV: lets PiDisplay switch it on and open its Spotify app.
    if (status?.connected && tv) {
      parts.push(h('h3', {}, 'TV'));
      if (tv.linked) {
        parts.push(
          h(
            'div',
            { class: 'spt-sheet-actions spt-tv-actions' },
            h('button', { class: 'btn btn-primary', disabled: Boolean(busy), onclick: () => void openOnTv() }, `Open Spotify on ${tv.name}`),
            h('button', { class: 'btn btn-ghost', disabled: Boolean(busy), onclick: () => void run('Forgetting the TV…', async () => void (tv = await call<TvStatus>('POST', '/api/tv/unlink'))) }, 'Forget this TV'),
          ),
        );
        if (!tv.canWake) parts.push(h('p', { class: 'conn-hint' }, "PiDisplay can't switch this TV on yet. Open Spotify on it once while it is on and it will learn how."));
      } else {
        parts.push(
          h('p', { class: 'conn-hint' }, 'Link an LG TV so PiDisplay can switch it on and open Spotify on it. The TV must be on; it will ask you to accept.'),
          h('button', { class: 'btn', disabled: Boolean(busy), onclick: () => showTvLink(sheet.body, (s) => ((tv = s ?? tv), render())) }, 'Link my LG TV'),
        );
      }
    }

    // Where this display's own sound goes.
    parts.push(h('h3', {}, `${status?.receiver.name ?? 'PiDisplay'} plays through`));
    if (!audio) {
      parts.push(h('p', { class: 'conn-hint' }, busy ? '' : 'Loading…'));
    } else if (!audio.available) {
      parts.push(h('p', { class: 'conn-hint' }, 'Speaker choice works on the Pi itself.'));
    } else {
      parts.push(
        h(
          'ul',
          { class: 'conn-list' },
          ...audio.outputs.map((o) => row(OUTPUT_ICONS[o.kind], o.label, o.active ? 'In use' : null, busy || o.active ? null : () => selectOutput(o), o.active)),
        ),
      );
      const active = audio.outputs.find((o) => o.active);
      if (active && active.volume !== null) {
        const value = h('span', { class: 'spt-out-value' }, `${active.muted ? 0 : active.volume}%`);
        const slider = h('input', {
          type: 'range',
          class: 'spt-range',
          min: 0,
          max: 100,
          step: 5,
          value: String(active.muted ? 0 : Math.min(100, active.volume)),
          oninput: () => {
            outputDrag = true;
            value.textContent = `${slider.value}%`;
          },
          onchange: () => {
            outputDrag = false;
            void call<AudioStatus>('POST', '/api/audio/volume', { name: active.name, volume: Number(slider.value) })
              .then((s) => ((audio = s), render()))
              .catch((err) => ((error = (err as Error).message), render()));
          },
        });
        parts.push(h('div', { class: 'spt-out-volume' }, h('span', {}, `${active.label} volume`), slider, value));
      }
    }

    // Paired Bluetooth speakers that aren't connected right now.
    const speakers = bt.filter((d) => d.paired && !d.connected && /^audio/.test(d.icon ?? ''));
    if (speakers.length) {
      parts.push(h('h3', {}, 'Bluetooth speakers'));
      parts.push(h('ul', { class: 'conn-list' }, ...speakers.map((d) => row('🔵', d.name ?? d.mac, 'Tap to connect', busy ? null : () => connectSpeaker(d)))));
    }
    parts.push(
      h(
        'div',
        { class: 'spt-sheet-actions' },
        h('button', { class: 'btn', disabled: Boolean(busy), onclick: () => showBluetooth(sheet.body, () => void loadLocal()) }, 'Pair a Bluetooth speaker'),
        h('button', { class: 'btn btn-ghost', onclick: () => openSetupSheet() }, 'Spotify account'),
      ),
    );
    sheet.body.replaceChildren(h('div', { class: 'spt-sheet' }, ...parts.filter((p): p is HTMLElement => Boolean(p))));
  };

  // Keep the Spotify part live (it polls anyway); don't redraw under a finger on the slider.
  const off = spotify.subscribe(() => {
    if (!outputDrag && sheet.body.querySelector('.spt-sheet')) render();
  });
  render();
  void loadLocal();
}

// ---- Linking the TV --------------------------------------------------------

/** Finds LG TVs on the network (or takes an address) and pairs; back(status) returns to Speakers. */
function showTvLink(body: HTMLElement, back: (status: TvStatus | null) => void) {
  let found: { ip: string; name: string; model: string }[] | null = null;
  let busy = 'Looking for LG TVs…';
  let error = '';

  const link = async (ip: string, name?: string) => {
    busy = 'Look at the TV and choose Accept (or Yes) with its remote…';
    error = '';
    render();
    try {
      back(await call<TvStatus>('POST', '/api/tv/link', { ip, name }));
    } catch (err) {
      busy = '';
      error = (err as Error).message;
      render();
    }
  };

  const input = h('input', { type: 'text', class: 'spt-search-input', placeholder: 'TV address, e.g. 192.168.1.50', inputmode: 'decimal', autocomplete: 'off' });
  const render = () => {
    if (!body.isConnected) return;
    body.replaceChildren(
      h(
        'div',
        // Not .spt-sheet: the Speakers sheet redraws itself whenever it finds that class.
        { class: 'spt-tv-link' },
        h('div', { class: 'conn-head' }, h('button', { class: 'btn btn-ghost', onclick: () => back(null), 'aria-label': 'Back' }, '‹ Back'), h('h3', {}, 'Link my LG TV'), h('span')),
        busy ? h('p', { class: 'conn-status' }, busy) : null,
        error ? h('p', { class: 'conn-error' }, error) : null,
        found?.length
          ? h('ul', { class: 'conn-list' }, ...found.map((t) => row('📺', t.model && t.model !== t.name ? `${t.name} (${t.model})` : t.name, t.ip, busy ? null : () => void link(t.ip, t.name))))
          : null,
        found && !found.length && !busy ? h('p', { class: 'conn-hint' }, 'No LG TV answered. Make sure it is switched on and on the same network, then search again or type its address (TV Settings > General > Network).') : null,
        found && !busy ? h('button', { class: 'btn', onclick: () => void search() }, 'Search again') : null,
        found && !busy ? h('div', { class: 'spt-search' }, input, h('button', { class: 'btn btn-primary', onclick: () => void link(input.value.trim()) }, 'Link')) : null,
      ),
    );
  };

  const search = async () => {
    busy = 'Looking for LG TVs…';
    error = '';
    render();
    try {
      found = (await call<{ tvs: { ip: string; name: string; model: string }[] }>('POST', '/api/tv/find')).tvs;
    } catch (err) {
      found = [];
      error = (err as Error).message;
    }
    busy = '';
    render();
  };
  void search();
}

// ---- Library ---------------------------------------------------------------

interface Playlist {
  uri: string;
  name: string;
  owner: string;
  count: number | null;
  image: string | null;
}

interface Track {
  uri: string;
  name: string;
  artists: string[];
  thumb: string | null;
  albumUri: string | null;
}

interface SearchResults {
  tracks: Track[];
  playlists: Playlist[];
  albums: { uri: string; name: string; artists: string[]; image: string | null }[];
  artists: { uri: string; name: string; image: string | null }[];
}

let playlistCache: Playlist[] | null = null;
let likedCache: { total: number; tracks: Track[] } | null = null;
let lastQuery = '';

export function openLibrarySheet() {
  const sheet = openSheet('Library', []);
  let tab: 'playlists' | 'liked' | 'recent' | 'search' = 'playlists';
  let status = '';

  const play = async (body: Record<string, unknown>) => {
    // A preferred TV that Spotify can't see yet gets switched on first, which is slow.
    const want = spotify.status?.preferred;
    const waking = want?.type === 'tv' && !spotify.player?.isPlaying && !spotify.devices.some((d) => d.id === want.id || d.name === want.name);
    status = waking ? `Starting… Opening Spotify on ${want.name} can take up to a minute.` : 'Starting…';
    paint();
    if (await spotify.act('play', body)) sheet.close();
    else {
      status = spotify.error;
      paint();
    }
  };

  const card = (image: string | null, name: string, sub: string, onclick: () => void) =>
    h(
      'button',
      { class: 'spt-card', onclick },
      image ? h('img', { src: image, alt: '', loading: 'lazy', draggable: false }) : h('div', { class: 'spt-card-empty' }, spotifyLogo()),
      h('div', { class: 'spt-card-name' }, name),
      sub ? h('div', { class: 'spt-card-sub' }, sub) : null,
    );

  const trackRow = (t: Track, onclick: () => void) =>
    h(
      'button',
      { class: 'spt-track', onclick },
      t.thumb ? h('img', { src: t.thumb, alt: '', loading: 'lazy' }) : h('span', { class: 'spt-card-empty' }, spotifyLogo()),
      h('span', { class: 'spt-track-text' }, h('span', { class: 'spt-track-name' }, t.name), h('span', { class: 'spt-track-artist' }, t.artists.join(', '))),
    );

  const content = h('div', { class: 'spt-lib-content' });
  const tabs = h('div', { class: 'chips' });
  const statusLine = h('p', { class: 'conn-status' });

  const searchInput = h('input', {
    type: 'search',
    class: 'spt-search-input',
    placeholder: 'Songs, artists, albums, playlists',
    value: lastQuery,
    enterkeyhint: 'search',
    onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && void runSearch(),
  });
  const searchBox = h('div', { class: 'spt-search' }, searchInput, h('button', { class: 'btn btn-primary', onclick: () => void runSearch() }, 'Search'));
  const results = h('div', {});

  const runSearch = async () => {
    lastQuery = searchInput.value.trim();
    searchInput.blur();
    if (!lastQuery) return;
    results.replaceChildren(h('p', { class: 'conn-status' }, 'Searching…'));
    try {
      const r = await call<SearchResults>('GET', `/api/spotify/search?q=${encodeURIComponent(lastQuery)}`);
      const section = (title: string, nodes: HTMLElement[], cls = 'spt-grid') => (nodes.length ? [h('h3', {}, title), h('div', { class: cls }, ...nodes)] : []);
      const parts = [
        ...section(
          'Songs',
          // Play inside its album so music keeps going after the song.
          r.tracks.map((t) => trackRow(t, () => void play(inAlbum(t)))),
          'spt-tracks',
        ),
        ...section('Artists', r.artists.map((a) => card(a.image, a.name, 'Artist', () => void play({ contextUri: a.uri })))),
        ...section('Albums', r.albums.map((a) => card(a.image, a.name, a.artists.join(', '), () => void play({ contextUri: a.uri })))),
        ...section('Playlists', r.playlists.map((p) => card(p.image, p.name, p.owner, () => void play({ contextUri: p.uri })))),
      ];
      results.replaceChildren(...(parts.length ? parts : [h('p', { class: 'empty' }, 'Nothing found.')]));
    } catch (err) {
      results.replaceChildren(h('p', { class: 'conn-error' }, (err as Error).message));
    }
  };

  const inAlbum = (t: Track) => (t.albumUri ? { contextUri: t.albumUri, offsetUri: t.uri } : { uris: [t.uri] });

  /** Liked Songs: tapping one plays the list from there; Shuffle mixes the whole list. */
  const showLiked = async () => {
    if (!likedCache) content.replaceChildren(h('p', { class: 'conn-status' }, 'Loading Liked Songs…'));
    try {
      likedCache = await call<{ total: number; tracks: Track[] }>('GET', '/api/spotify/liked');
    } catch (err) {
      if (!likedCache) return content.replaceChildren(h('p', { class: 'conn-error' }, (err as Error).message));
    }
    if (tab !== 'liked') return;
    const { tracks, total } = likedCache!;
    if (!tracks.length) return content.replaceChildren(h('p', { class: 'empty' }, 'No Liked Songs yet. Tap the heart on a song in the Spotify app.'));
    const uris = tracks.map((t) => t.uri);
    const shuffled = () => {
      const list = [...uris];
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    };
    content.replaceChildren(
      h(
        'div',
        { class: 'spt-lib-actions' },
        h('button', { class: 'btn btn-primary', onclick: () => void play({ uris }) }, 'Play all'),
        h('button', { class: 'btn', onclick: () => void play({ uris: shuffled() }) }, 'Shuffle'),
        h('span', { class: 'conn-hint' }, total > tracks.length ? `Newest ${tracks.length} of ${total}` : `${tracks.length} songs`),
      ),
      h('div', { class: 'spt-tracks' }, ...tracks.map((t) => trackRow(t, () => void play({ uris, offsetUri: t.uri })))),
    );
  };

  const showRecent = async () => {
    content.replaceChildren(h('p', { class: 'conn-status' }, 'Loading…'));
    try {
      const { tracks } = await call<{ tracks: Track[] }>('GET', '/api/spotify/recent');
      if (tab !== 'recent') return;
      content.replaceChildren(
        tracks.length
          ? h('div', { class: 'spt-tracks' }, ...tracks.map((t) => trackRow(t, () => void play(inAlbum(t)))))
          : h('p', { class: 'empty' }, 'Nothing played recently.'),
      );
    } catch (err) {
      if (tab === 'recent') content.replaceChildren(h('p', { class: 'conn-error' }, (err as Error).message));
    }
  };

  const showPlaylists = async () => {
    if (!playlistCache) content.replaceChildren(h('p', { class: 'conn-status' }, 'Loading playlists…'));
    try {
      playlistCache = await call<Playlist[]>('GET', '/api/spotify/playlists');
    } catch (err) {
      if (!playlistCache) return content.replaceChildren(h('p', { class: 'conn-error' }, (err as Error).message));
    }
    if (tab !== 'playlists') return;
    content.replaceChildren(
      playlistCache!.length
        ? h(
            'div',
            { class: 'spt-grid' },
            ...playlistCache!.map((p) => card(p.image, p.name, p.count !== null ? `${p.count} songs` : p.owner, () => void play({ contextUri: p.uri }))),
          )
        : h('p', { class: 'empty' }, 'No playlists yet. Search instead.'),
    );
  };

  const paint = () => {
    tabs.replaceChildren(
      h('button', { class: `chip${tab === 'playlists' ? ' active' : ''}`, onclick: () => ((tab = 'playlists'), paint(), void showPlaylists()) }, 'Playlists'),
      h('button', { class: `chip${tab === 'liked' ? ' active' : ''}`, onclick: () => ((tab = 'liked'), paint(), void showLiked()) }, 'Liked Songs'),
      h('button', { class: `chip${tab === 'recent' ? ' active' : ''}`, onclick: () => ((tab = 'recent'), paint(), void showRecent()) }, 'Recent'),
      h('button', { class: `chip${tab === 'search' ? ' active' : ''}`, onclick: () => ((tab = 'search'), paint(), content.replaceChildren(searchBox, results), searchInput.focus()) }, 'Search'),
    );
    statusLine.textContent = status;
    statusLine.hidden = !status;
  };

  sheet.body.replaceChildren(h('div', { class: 'spt-lib' }, tabs, statusLine, content));
  paint();
  void showPlaylists();
}

// ---- Account setup ---------------------------------------------------------

export function openSetupSheet() {
  const sheet: SheetHandle = openSheet('Spotify', []);
  let error = '';

  const render = async () => {
    let status: SpotifyStatus;
    try {
      status = await call<SpotifyStatus>('GET', '/api/spotify');
    } catch (err) {
      sheet.body.replaceChildren(h('p', { class: 'conn-error' }, (err as Error).message));
      return;
    }
    const parts: (HTMLElement | null)[] = [];
    if (error) parts.push(h('p', { class: 'conn-error' }, error));

    const login = () => {
      // Spotify sends the browser back to /api/spotify/callback, which returns here.
      location.href = `/api/spotify/login?return=${encodeURIComponent(location.pathname + location.search)}`;
    };

    if (!status.configured) {
      const input = h('input', { type: 'text', class: 'spt-search-input', placeholder: 'Client ID', autocomplete: 'off', spellcheck: false });
      parts.push(
        h('p', {}, 'PiDisplay talks to Spotify through a small app of your own (free, takes two minutes). On a computer:'),
        h(
          'ol',
          { class: 'spt-steps' },
          h('li', {}, 'Open ', h('b', {}, DEV_DASHBOARD), ' and log in with your Spotify account.'),
          h('li', {}, 'Create app. Any name and description. Redirect URI: ', h('code', {}, status.redirectUri), '. Under "Which API/SDKs", tick Web API. Save.'),
          h('li', {}, 'Copy the app\'s Client ID.'),
          h('li', {}, 'On the laptop run ', h('code', {}, '.\\deploy\\spotify.ps1 -ClientId <id>'), ', which also signs you in. Or paste the ID below and log in on this screen.'),
        ),
        h(
          'div',
          { class: 'spt-search' },
          input,
          h(
            'button',
            {
              class: 'btn btn-primary',
              onclick: async () => {
                try {
                  await call('PUT', '/api/spotify/client', { clientId: input.value });
                  error = '';
                } catch (err) {
                  error = (err as Error).message;
                }
                void render();
              },
            },
            'Save',
          ),
        ),
      );
    } else if (!status.connected) {
      parts.push(
        h('p', {}, 'Sign in to Spotify to finish. Either:'),
        h('button', { class: 'btn btn-primary btn-wide', onclick: login }, 'Log in on this screen'),
        h('p', { class: 'conn-hint' }, 'or on the laptop run ', h('code', {}, '.\\deploy\\spotify.ps1'), ' and sign in there.'),
        h(
          'button',
          {
            class: 'btn btn-ghost',
            onclick: async () => {
              await call('PUT', '/api/spotify/client', { clientId: '' }).catch(() => {});
              void render();
            },
          },
          'Use a different Client ID',
        ),
      );
    } else {
      const r = status.receiver;
      parts.push(
        h('p', {}, '✅ Spotify is connected.'),
        h(
          'p',
          { class: 'conn-hint' },
          r.signedIn
            ? `The ${r.name} speaker is linked, so music can start from this screen.`
            : `One more step: open Spotify on your phone or computer on the same Wi-Fi, tap the speaker icon and pick ${r.name}. After that, music can start from this screen.`,
        ),
        h(
          'button',
          {
            class: 'btn btn-danger',
            onclick: async () => {
              await call('POST', '/api/spotify/logout').catch((err) => (error = (err as Error).message));
              playlistCache = null;
              likedCache = null;
              void spotify.refresh(true);
              void render();
            },
          },
          'Log out of Spotify',
        ),
      );
    }
    if (sheet.body.isConnected) sheet.body.replaceChildren(h('div', { class: 'spt-sheet' }, ...parts.filter((p): p is HTMLElement => Boolean(p))));
    void spotify.refresh(true);
  };

  void render();
}
