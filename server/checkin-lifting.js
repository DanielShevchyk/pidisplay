// Lifting days for the morning check-in: which days each person lifted (sets, weight
// moved, main muscle groups), read from the lifting service (lifting/, GET /api/days)
// so the check-in trends can show workouts next to sleep and mood. The lifting service
// owns that data; this only reads it. When it's down, slow or has nobody matching, the
// answer is just "nothing" and the check-in works as before.

import { dateKey } from './checkin.js';

const TTL_MS = 60000;
const TIMEOUT_MS = 2000;
/** About 13 months: the year chart plus the range before it for the stats. */
const DAYS = 400;

/**
 * The lifting person for a check-in profile. profile.lifting: undefined is automatic
 * (the same name, any case; or the only lifting person when there is only one check-in
 * person), '' is none, anything else names a lifting person.
 */
export function matchPerson(profile, profiles, people) {
  const named = (name) => people.find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? null;
  if (profile.lifting === '') return null;
  if (typeof profile.lifting === 'string') return named(profile.lifting);
  return named(profile.name) ?? (profiles.length === 1 && people.length === 1 ? people[0] : null);
}

export function createCheckinLifting({ liftingUrl, fetchJson, now = Date.now, ttlMs = TTL_MS, timeoutMs = TIMEOUT_MS } = {}) {
  fetchJson ??= async (url) => {
    // A short timeout: a hung lifting service must never hold up the check-in.
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${res.status} from the lifting service`);
    return res.json();
  };
  /** url -> { at, value } where value is a promise; failures are kept as long, so a dead service isn't asked on every load. */
  const cache = new Map();

  function get(path) {
    const url = new URL(path, liftingUrl).href;
    const hit = cache.get(url);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = Promise.resolve()
      .then(() => fetchJson(url))
      .then(
        (data) => ({ ok: true, data }),
        () => ({ ok: false }),
      );
    cache.set(url, { at: now(), value });
    return value;
  }

  /**
   * { available, people: [names], byProfile: { [profile id]: { person, firstDate, from, days } } }
   * where days maps YYYY-MM-DD to { sets, volume, groups, labels, prs }. allTime reads
   * every day (the CSV export) instead of about the last 400.
   */
  async function forProfiles(profiles, { allTime = false } = {}) {
    const people = await get('/api/people');
    if (!people.ok || !Array.isArray(people.data)) return { available: false, people: [], byProfile: {} };
    const list = people.data.filter((x) => x && typeof x.name === 'string');
    const from = dateKey(new Date(now() - DAYS * 86400000));
    const byProfile = {};
    await Promise.all(
      profiles.map(async (p) => {
        const person = matchPerson(p, profiles, list);
        if (!person) return;
        const query = new URLSearchParams({ person: String(person.id ?? person.name) });
        if (!allTime) query.set('from', from);
        const r = await get(`/api/days?${query}`);
        if (!r.ok || !Array.isArray(r.data?.days)) return;
        const days = {};
        for (const d of r.data.days) {
          if (typeof d?.date !== 'string') continue;
          days[d.date] = {
            sets: Number(d.working_sets) || 0,
            volume: Number(d.volume_lb) || 0,
            groups: Array.isArray(d.groups) ? d.groups.filter((g) => typeof g === 'string') : [],
            labels: Array.isArray(d.labels) ? d.labels.filter((l) => typeof l === 'string') : [],
            prs: Number(d.prs) || 0,
          };
        }
        // from: where the days start, so the client knows a day before it is unknown rather than a rest day.
        byProfile[p.id] = { person: person.name, firstDate: typeof r.data.first_date === 'string' ? r.data.first_date : null, from: allTime ? null : from, days };
      }),
    );
    return { available: true, people: list.map((x) => x.name), byProfile };
  }

  return { forProfiles };
}
