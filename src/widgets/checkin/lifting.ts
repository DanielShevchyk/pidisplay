// Lifting days next to the check-in (read from the lifting tracker through
// /api/checkin/lifting): the "Lifting" stat, the "after lifting" factor and the
// workout pill in the history. All of it is left out when there's no lifting data.
import { h } from '../../core/dom';
import { icon } from '../../core/icons';
import { daysBack, type Book, type LiftingDay, type LiftingPerson, type Question } from '../../core/checkin';
import { bestFactor, rangeDays, type Factor, type Range } from './trends';

/** Whether the lifting data can say anything about a date: a day without a session there was a rest day. */
export const known = (l: LiftingPerson, date: string) => l.firstDate !== null && date >= l.firstDate && (!l.from || date >= l.from);

/** "Lifted · 18 sets · Legs, Back" */
export function liftingPill(day: LiftingDay): HTMLElement {
  const sets = day.sets ? `${day.sets} ${day.sets === 1 ? 'set' : 'sets'}` : '';
  return h(
    'span',
    { class: 'ci-pill ci-pill-lift' },
    icon('dumbbell'),
    h('span', {}, ['Lifted', sets, day.groups.slice(0, 2).join(', ')].filter(Boolean).join(' · ')),
  );
}

export interface LiftingStat {
  sessions: number;
  perWeek: number;
  /** Sessions against the range before; null when the lifting data doesn't cover it. */
  change: number | null;
}

export function liftingStat(book: Book, l: LiftingPerson, range: Range): LiftingStat {
  const n = rangeDays(range);
  const all = daysBack(book.today, n * 2);
  const count = (ds: string[]) => ds.filter((d) => l.days[d]).length;
  const cur = all.slice(n);
  const sessions = count(cur);
  // A week's worth over the days the lifting data covers, so a year view of someone
  // who started lifting last month doesn't read as once a fortnight.
  const covered = Math.max(7, cur.filter((d) => known(l, d)).length);
  return { sessions, perWeek: (sessions / covered) * 7, change: known(l, all[0]) ? sessions - count(all.slice(0, n)) : null };
}

export function liftingStatCard(st: LiftingStat, range: Range): HTMLElement {
  const delta =
    st.change !== null && st.change !== 0 &&
    h('span', { class: 'ci-delta' }, st.change > 0 ? `▲ ${st.change} more` : `▼ ${-st.change} fewer`);
  return h(
    'div',
    { class: 'ci-stat ci-stat-lift' },
    h('div', { class: 'ci-stat-name' }, icon('dumbbell'), 'Lifting'),
    h('div', { class: 'ci-stat-val' }, String(st.sessions), h('small', {}, st.sessions === 1 ? ' session' : ' sessions')),
    h(
      'div',
      { class: 'ci-stat-sub' },
      range !== '7d' && h('span', {}, `${st.perWeek.toFixed(1).replace(/\.0$/, '')} a week`),
      delta,
    ),
  );
}

const LIFTED: Question = { id: 'lifting', label: 'Lifted the day before', short: 'Lifted the day before', type: 'yesno', enabled: true };

/**
 * "After lifting": mornings after a session against mornings after a rest day, by the
 * same rule as the yes/no questions. A check-in on day D is about the night after D-1,
 * so D counts as "yes" when there was a session on D-1. Days before the first session
 * (or before the lifting data starts) are unknown, not rest days.
 */
export function liftingFactor(book: Book, l: LiftingPerson, questions: Question[], range: Range): Factor | null {
  const yes: string[] = [];
  const no: string[] = [];
  for (const d of daysBack(book.today, rangeDays(range))) {
    const before = daysBack(d, 2)[0];
    if (!book.entries[d] || !known(l, before)) continue;
    (l.days[before] ? yes : no).push(d);
  }
  const f = bestFactor(book, LIFTED, questions, yes, no);
  return f && { ...f, lifting: true };
}
