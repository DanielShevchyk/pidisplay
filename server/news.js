// News proxy for the news widget. Reads Google News RSS (free, no API key),
// which already ranks and de-duplicates stories across thousands of outlets:
// the World and U.S. topic feeds, and the local feed for a place name. Each
// feed is cached in memory so any number of tiles cost one upstream call per
// feed every few minutes, and the last good copy is kept through outages.

import { US_STATES } from './weather.js';

const BASE = 'https://news.google.com/rss';
const LOCALE = 'hl=en-US&gl=US&ceid=US:en';
const TTL = 10 * 60 * 1000;
const TIMEOUT = 10_000;
const MAX_ITEMS = 30;

export const SECTIONS = {
  world: { label: 'World', url: () => `${BASE}/headlines/section/topic/WORLD?${LOCALE}` },
  us: { label: 'U.S.', url: () => `${BASE}/headlines/section/topic/NATION?${LOCALE}` },
};

export class NewsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** "Citrus Heights, CA" -> { label: 'Citrus Heights', geo: 'Citrus Heights, California' }. */
export function localPlace(location) {
  const parts = String(location ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 2 && parts.every((p) => /^-?\d+(\.\d+)?$/.test(p))) {
    throw new NewsError(400, 'Local news needs a city name, not coordinates');
  }
  const [city, ...rest] = parts;
  const expanded = rest.map((p) => {
    const state = US_STATES[p.toLowerCase()];
    return state ? state.replace(/\b\w/g, (c) => c.toUpperCase()) : p;
  });
  return { label: city, geo: [city, ...expanded].join(', '), city };
}

export function createNews({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const cache = new Map(); // url -> { at, items }
  const inflight = new Map();

  async function fetchFeed(url) {
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { 'User-Agent': 'Mozilla/5.0 PiDisplay' } });
    } catch (err) {
      throw new NewsError(502, `News service unreachable (${err.message})`);
    }
    if (!res.ok) throw new NewsError(502, `News service returned ${res.status}`);
    return parseFeed(await res.text());
  }

  /** Cached feed items, with a stale flag when the refresh failed. */
  async function feed(url) {
    const cached = cache.get(url);
    if (cached && now() - cached.at < TTL) return { items: cached.items, updated: cached.at };
    if (!inflight.has(url)) {
      inflight.set(
        url,
        fetchFeed(url)
          .then((items) => {
            cache.set(url, { at: now(), items });
            return items;
          })
          .finally(() => inflight.delete(url)),
      );
    }
    try {
      await inflight.get(url);
      const fresh = cache.get(url);
      return { items: fresh.items, updated: fresh.at };
    } catch (err) {
      if (cached) return { items: cached.items, updated: cached.at, stale: true };
      throw err;
    }
  }

  async function local(location) {
    const place = localPlace(location);
    if (!place) throw new NewsError(400, 'Set a location for local news');
    const result = await feed(`${BASE}/headlines/section/geo/${encodeURIComponent(place.geo)}?${LOCALE}`);
    if (result.items.length) return { label: place.label, ...result };
    // Small towns can have an empty geo feed; fall back to a recent search.
    const q = encodeURIComponent(`"${place.city}" when:3d`);
    return { label: place.label, ...(await feed(`${BASE}/search?q=${q}&${LOCALE}`)) };
  }

  /**
   * Returns { sections: [{ id, label, items, updated, stale?, error? }] } for the
   * requested section ids. One failing feed doesn't hide the others.
   */
  async function get({ sections = 'world,us,local', location = '' } = {}) {
    const ids = String(sections)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length || ids.some((id) => id !== 'local' && !SECTIONS[id])) {
      throw new NewsError(400, 'sections must be a list of world, us, local');
    }
    if (String(location).length > 120) throw new NewsError(400, 'location is too long');
    const out = await Promise.all(
      [...new Set(ids)].map(async (id) => {
        const label = SECTIONS[id]?.label ?? 'Local';
        try {
          const result = id === 'local' ? await local(location) : { label, ...(await feed(SECTIONS[id].url())) };
          return { id, ...result };
        } catch (err) {
          return { id, label: id === 'local' ? localPlace(location)?.label ?? label : label, items: [], error: err.message };
        }
      }),
    );
    return { sections: out };
  }

  return { get };
}

// ---- RSS parsing (just enough for Google News; no XML dependency) ----

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decode(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

const stripTags = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

/** Parses an RSS document into [{ id, title, source, url, time, related }]. */
export function parseFeed(xml) {
  const items = [];
  for (const [, item] of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const source = stripTags(decode(tag(item, 'source')));
    let title = stripTags(decode(tag(item, 'title')));
    // Google appends " - Outlet" to every headline; the outlet is shown separately.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    if (!title) continue;
    const link = decode(tag(item, 'link')).trim();
    const time = Date.parse(decode(tag(item, 'pubDate')).trim());
    // The description is an HTML list of the same story from other outlets.
    const related = [];
    for (const [, li] of decode(tag(item, 'description')).matchAll(/<li>([\s\S]*?)<\/li>/gi)) {
      const t = stripTags(decode(tag(li, 'a')));
      const s = stripTags(decode(tag(li, 'font')));
      if (t && !(t === title && s === source)) related.push({ title: t, source: s });
    }
    items.push({
      id: stripTags(decode(tag(item, 'guid'))) || link || title,
      title,
      source,
      url: /^https?:\/\//.test(link) ? link : '',
      time: Number.isFinite(time) ? time : null,
      related: related.slice(0, 6),
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}
