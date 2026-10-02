// Light/dark appearance. Saved on the Pi (so every screen and reboots agree) and
// mirrored in localStorage so the first paint after a reload uses the right colors.
import { createStorage } from './api';

export type Theme = 'dark' | 'light';

const LOCAL_KEY = 'pidisplay.theme';
const store = createStorage('app.settings');

interface AppSettings {
  theme?: Theme;
}

function normalize(value: unknown): Theme {
  return value === 'light' ? 'light' : 'dark';
}

export function currentTheme(): Theme {
  return normalize(document.documentElement.dataset.theme);
}

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(LOCAL_KEY, theme);
  } catch {
    // Private mode or storage disabled; the server copy still applies.
  }
}

/** Apply the cached theme immediately, then the saved one, and follow changes from other screens. */
export function initTheme() {
  let cached: string | null = null;
  try {
    cached = localStorage.getItem(LOCAL_KEY);
  } catch {}
  apply(normalize(cached));
  const load = () =>
    store
      .load<AppSettings>({})
      .then((s) => apply(normalize(s.theme)))
      .catch(() => {});
  load();
  store.onChange(load);
}

export async function setTheme(theme: Theme) {
  apply(theme);
  const saved = await store.load<AppSettings>({}).catch(() => ({}) as AppSettings);
  await store.save({ ...saved, theme });
}
