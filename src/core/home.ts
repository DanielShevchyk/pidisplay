// Optional fallback locations saved only on this display (store key "home"), used by
// tiles whose own location is blank. Nothing is set out of the box; a weather tile's
// location becomes the default for other weather tiles once one is entered.
import { createStorage } from './api';

export interface HomeSettings {
  /** "City, ST", "City, Country" or "lat,lon" for weather and voice answers. */
  location?: string;
  /** "City, ST" for the News widget's state and city sections; falls back to `location`. */
  newsLocation?: string;
}

const store = createStorage('home');

export async function homeSettings(): Promise<HomeSettings> {
  const saved = await store.load<HomeSettings | null>(null).catch(() => null);
  return saved && typeof saved === 'object' ? saved : {};
}
