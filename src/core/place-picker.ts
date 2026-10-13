// A text field for a place code (airport, city) with a suggestions dropdown while typing:
// matches by name or code, tap a suggestion or press Enter to take the top one.
// Every place-like field in PiDisplay uses this (project UI rule).
import { h } from './dom';

export type Places = Record<string, { name: string }>;

export interface PlacePickerOptions {
  placeholder: string;
  value?: string;
  /** The places to suggest; a function is called on every keystroke (or once, if it returns a promise). */
  places: Places | (() => Places | Promise<Places>);
  exclude?: (code: string) => boolean;
  onPick: (code: string) => void;
  /** Offer a typed 3-letter code that isn't in `places`; the label says what that means. */
  rawCode?: string | false;
  /** Called when the field is emptied and left, for optional fields. */
  onClear?: () => void;
  class?: string;
}

export function placePicker(opts: PlacePickerOptions): HTMLElement {
  const input = h('input', {
    type: 'text',
    class: 'picker-input',
    placeholder: opts.placeholder,
    value: opts.value ?? '',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: false,
    'aria-label': opts.placeholder,
  }) as HTMLInputElement;
  const list = h('div', { class: 'picker-list', role: 'listbox', hidden: true });
  let current = opts.value ?? '';
  let options: string[] = [];
  let loaded: Places | null = typeof opts.places === 'function' ? null : opts.places;
  const getPlaces = async (): Promise<Places> => {
    if (typeof opts.places !== 'function') return opts.places;
    const got = opts.places();
    if (got instanceof Promise) return (loaded ??= await got.catch(() => ({})));
    return got;
  };

  const pick = (code: string) => {
    list.hidden = true;
    input.value = code;
    current = code;
    opts.onPick(code);
  };

  const option = (code: string, name: string) =>
    h(
      'button',
      {
        type: 'button',
        class: 'picker-option',
        role: 'option',
        // pointerdown, so the pick lands before the field loses focus and the keyboard drops.
        onpointerdown: (e: Event) => {
          e.preventDefault();
          pick(code);
        },
      },
      h('strong', {}, code),
      h('span', {}, name),
    );

  const suggest = async () => {
    const q = input.value.trim().toLowerCase();
    if (!q || q === current.toLowerCase()) {
      list.hidden = true;
      options = [];
      return;
    }
    const places = await getPlaces();
    if (input.value.trim().toLowerCase() !== q) return; // typed on while loading
    const rank = (code: string, name: string) => {
      const c = code.toLowerCase();
      const n = name.toLowerCase();
      if (c === q) return 0;
      if (n.startsWith(q)) return 1;
      if (c.startsWith(q)) return 2;
      if (n.split(/[\s,]+/).some((w) => w.startsWith(q))) return 3;
      return n.includes(q) ? 4 : 9;
    };
    const matches = Object.entries(places)
      .filter(([code]) => !opts.exclude?.(code))
      .map(([code, p]) => ({ code, name: p.name, r: rank(code, p.name) }))
      .filter((m) => m.r < 9)
      .sort((a, b) => a.r - b.r || a.name.localeCompare(b.name))
      .slice(0, 8);
    const raw = q.toUpperCase();
    options = matches.map((m) => m.code);
    const rows: Node[] = matches.map((m) => option(m.code, m.name));
    if (opts.rawCode !== false && /^[A-Z]{3}$/.test(raw) && !places[raw] && !opts.exclude?.(raw)) {
      options.push(raw);
      rows.push(option(raw, opts.rawCode || 'Use this code'));
    }
    if (!rows.length) rows.push(h('div', { class: 'picker-empty' }, 'No match. Try a city name or a 3-letter code.'));
    list.replaceChildren(...rows);
    list.hidden = false;
  };

  input.addEventListener('input', () => void suggest());
  input.addEventListener('focus', () => {
    input.select();
    if (!loaded) void getPlaces(); // warm up a fetched list
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && options[0]) {
      e.preventDefault();
      pick(options[0]);
    }
  });
  input.addEventListener('blur', () =>
    setTimeout(() => {
      list.hidden = true;
      const typed = input.value.trim();
      if (!typed && current && opts.onClear) {
        current = '';
        opts.onClear();
      } else if (typed.toUpperCase() !== current.toUpperCase()) {
        input.value = current; // nothing picked: put the last value back
      }
    }, 150),
  );
  return h('div', { class: `picker ${opts.class ?? ''}` }, input, list);
}
