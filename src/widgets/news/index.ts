import { h } from '../../core/dom';
import { openSheet } from '../../core/sheet';
import { defineWidget, type Placement } from '../../core/types';
import './news.css';

type SectionId = 'world' | 'us' | 'state' | 'local';

interface NewsConfig {
  /** 'all' or a single section id. */
  section: 'all' | SectionId;
  /** "City, ST" for the state and city sections; blank = DEFAULT_LOCATION. */
  location: string;
  /** Seconds between switching sections (lists) or headlines (small tile, top bar); 0 = off. */
  rotateSeconds: number;
  [key: string]: unknown;
}

/** Mirrors GET /api/news (server/news.js). */
interface Story {
  id: string;
  title: string;
  source: string;
  url: string;
  time: number | null;
  related: { title: string; source: string }[];
}

interface Section {
  id: SectionId;
  label: string;
  items: Story[];
  updated?: number;
  stale?: boolean;
  error?: string;
}

interface Cached {
  query: string;
  sections: Section[];
}

/** Dan wants California news; the city part only matters for the "City only" option. */
const DEFAULT_LOCATION = 'Sacramento, CA';
const REFRESH_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;
/** After a tap, hold the chosen section this long before rotating again. */
const HOLD_MS = 2 * 60 * 1000;
const ICONS: Record<SectionId, string> = { world: '🌍', us: '🇺🇸', state: '🗺️', local: '📍' };

export default defineWidget<NewsConfig>({
  type: 'news',
  name: 'News',
  description: 'Top world, U.S. and state headlines',
  icon: '📰',
  sizes: ['small', 'medium', 'tall', 'large', 'xlarge', 'full'],
  defaultSize: 'large',
  supportsBar: true,
  defaultConfig: { section: 'all', location: '', rotateSeconds: 20 },
  settings: [
    {
      key: 'section',
      label: 'Show',
      type: 'select',
      options: [
        { value: 'all', label: 'World, U.S. and state' },
        { value: 'world', label: 'World only' },
        { value: 'us', label: 'U.S. only' },
        { value: 'state', label: 'State only' },
        { value: 'local', label: 'City only' },
      ],
    },
    { key: 'location', label: 'State (and city) for news (blank = Sacramento, CA)', type: 'text', placeholder: 'City, ST' },
    { key: 'rotateSeconds', label: 'Rotate every (seconds, 0 = off)', type: 'number', min: 0, max: 600, step: 5 },
  ],

  mount(el, { config, placement, storage }) {
    const location = config.location.trim() || DEFAULT_LOCATION;
    const ids: SectionId[] = config.section === 'all' ? ['world', 'us', 'state'] : [config.section];
    const root = h('div', { class: `news size-${placement}` });
    el.append(root);

    let sections: Section[] = [];
    let failed = '';
    let active = 0; // section index (lists) or headline index (small, bar)
    let heldUntil = 0;
    let refreshTimer = 0;
    let rotateTimer = 0;
    let alive = true;
    const query = () => `${ids.join(',')}|${location}`;

    const paint = () => {
      if (!sections.length) {
        root.replaceChildren(placement === 'bar' ? '' : message(failed ? '⚠️' : '', failed || 'Loading…'));
        return;
      }
      if (placement === 'bar' || placement === 'small') {
        const reel = headlineReel(sections, placement === 'bar' ? 3 : 5);
        if (!reel.length) return root.replaceChildren(message('📰', sections[0].error ?? 'No headlines'));
        const [section, story] = reel[active % reel.length];
        root.replaceChildren(placement === 'bar' ? renderBar(section, story) : renderSmall(section, story));
        return;
      }
      if (placement === 'xlarge' || placement === 'full') {
        root.replaceChildren(h('div', { class: 'news-cols' }, ...sections.map((s) => renderColumn(s, placement))));
        return;
      }
      active %= sections.length;
      const pick = (i: number) => {
        active = i;
        heldUntil = Date.now() + HOLD_MS;
        paint();
      };
      const current = sections[active];
      // The wide tile has no room for tabs: its label steps to the next section.
      const header =
        placement === 'medium'
          ? h(
              'button',
              { class: 'news-label news-label-btn', onclick: () => pick((active + 1) % sections.length) },
              `${ICONS[current.id]} ${current.label}`,
              sections.length > 1 && h('span', { class: 'news-dots' }, sections.map((_, i) => (i === active ? '●' : '○')).join(' ')),
            )
          : sections.length === 1
            ? h('div', { class: 'news-label' }, `${ICONS[current.id]} ${current.label}`)
            : h(
          'div',
          { class: 'news-tabs' },
          ...sections.map((s, i) =>
            h(
              'button',
              {
                class: `news-tab${i === active ? ' active' : ''}`,
                onclick: () => pick(i),
              },
              `${ICONS[s.id]} ${s.label}`,
            ),
          ),
        );
      root.replaceChildren(h('div', { class: 'news-body' }, header, renderList(current, placement)));
    };

    const rotate = () => {
      clearInterval(rotateTimer);
      const seconds = Number(config.rotateSeconds) || 0;
      if (seconds <= 0 || placement === 'xlarge' || placement === 'full') return;
      // Single headlines turn over faster than whole lists.
      const ms = Math.max(5, placement === 'bar' || placement === 'small' ? Math.min(seconds, 10) : seconds) * 1000;
      rotateTimer = window.setInterval(() => {
        if (Date.now() < heldUntil || document.querySelector('.sheet-backdrop')) return;
        active++;
        paint();
      }, ms);
    };

    const refresh = async () => {
      clearTimeout(refreshTimer);
      const q = query();
      let next = REFRESH_MS;
      try {
        const params = new URLSearchParams({ sections: ids.join(','), location });
        const res = await fetch(`/api/news?${params}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `News failed (${res.status})`);
        if (!alive || q !== query()) return;
        sections = body.sections as Section[];
        failed = '';
        if (sections.every((s) => s.error)) next = RETRY_MS;
        storage.save({ query: q, sections } satisfies Cached).catch(() => {});
      } catch (err) {
        if (!alive || q !== query()) return;
        failed = err instanceof Error ? err.message : String(err);
        next = RETRY_MS;
      }
      paint();
      refreshTimer = window.setTimeout(refresh, next);
    };

    // Show the last headlines right away (e.g. after a reboot), then refresh.
    storage
      .load<Cached | null>(null)
      .catch(() => null)
      .then((cached) => {
        if (!alive) return;
        if (cached?.query === query()) sections = cached.sections;
        paint();
        rotate();
        refresh();
      });

    return {
      destroy() {
        alive = false;
        clearTimeout(refreshTimer);
        clearInterval(rotateTimer);
      },
    };
  },
});

/** Top stories of each section, interleaved: world 1, U.S. 1, local 1, world 2… */
function headlineReel(sections: Section[], perSection: number): [Section, Story][] {
  const reel: [Section, Story][] = [];
  for (let i = 0; i < perSection; i++) {
    for (const s of sections) if (s.items[i]) reel.push([s, s.items[i]]);
  }
  return reel;
}

function message(icon: string, text: string) {
  return h('div', { class: 'news-message' }, icon && h('div', { class: 'news-message-icon' }, icon), text);
}

function renderBar(section: Section, story: Story) {
  return h(
    'button',
    { class: 'news-bar', onclick: () => openStory(section, story) },
    h('span', { class: 'news-bar-icon' }, ICONS[section.id]),
    h('span', { class: 'news-bar-title' }, story.title),
  );
}

function renderSmall(section: Section, story: Story) {
  return h(
    'button',
    { class: 'news-small', onclick: () => openStory(section, story) },
    h('div', { class: 'news-label' }, `${ICONS[section.id]} ${section.label}`),
    h('div', { class: 'news-small-title' }, story.title),
    h('div', { class: 'news-meta' }, meta(story)),
  );
}

const LIST_LIMIT: Record<Placement, number> = { bar: 0, small: 1, medium: 3, tall: 12, large: 12, xlarge: 30, full: 30 };

function renderList(section: Section, placement: Placement) {
  if (!section.items.length) return message('📰', section.error ?? 'No headlines right now');
  return h(
    'div',
    { class: 'news-list' },
    ...section.items.slice(0, LIST_LIMIT[placement]).map((story, i) =>
      h(
        'button',
        { class: `news-item${i === 0 ? ' lead' : ''}`, onclick: () => openStory(section, story) },
        h('div', { class: 'news-title' }, story.title),
        h('div', { class: 'news-meta' }, meta(story)),
      ),
    ),
    section.stale && h('div', { class: 'news-stale' }, '⚠ Offline, showing earlier headlines'),
  );
}

function renderColumn(section: Section, placement: Placement) {
  return h(
    'div',
    { class: 'news-col' },
    h('div', { class: 'news-label' }, `${ICONS[section.id]} ${section.label}`),
    renderList(section, placement),
  );
}

function meta(story: Story): string {
  return [story.source, ago(story.time)].filter(Boolean).join(' · ');
}

function ago(time: number | null): string {
  if (!time) return '';
  const mins = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The kiosk can't browse, so a tap shows the story and who else is covering it. */
function openStory(section: Section, story: Story) {
  openSheet(`${ICONS[section.id]} ${section.label}`, [
    h('div', { class: 'news-detail' },
      h('div', { class: 'news-detail-title' }, story.title),
      h('div', { class: 'news-meta' }, meta(story)),
      story.related.length > 0 &&
        h(
          'div',
          { class: 'news-related' },
          h('div', { class: 'news-label' }, 'Also covering this'),
          ...story.related.map((r) =>
            h('div', { class: 'news-related-item' }, h('div', {}, r.title), h('div', { class: 'news-meta' }, r.source)),
          ),
        ),
    ),
  ]);
}
